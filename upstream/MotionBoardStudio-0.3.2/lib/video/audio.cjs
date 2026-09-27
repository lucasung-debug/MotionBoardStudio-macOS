'use strict';

// 음악 분석·루프 절단·UI 효과음 합성·믹스·WAV 저장. 디코딩만 ffmpeg 를 쓴다.
// - 템포는 늘리지 않는다: 곡의 실측 BPM 을 그대로 비트 그리드로 쓰고, 영상 코드가 그 그리드를 따른다.
// - 효과음은 각 소리의 "측정된 피크"가 이벤트 시각에 오도록 놓는다.
// - 믹스는 원형(circular): 루프 끝을 넘는 꼬리는 처음으로 감겨 오디오도 끊김 없이 반복된다.

const dsp = require('./dsp.cjs');
const ffmpeg = require('./ffmpeg.cjs');

const SR = 48000;
const ANALYSIS_SR = 22050;

async function decode(file, { sr = SR, channels = 2, signal } = {}) {
  const raw = await ffmpeg.run(['-i', file, '-ac', String(channels), '-ar', String(sr), '-f', 'f32le', '-'], { signal });
  const data = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  return { data: Float32Array.from(data), sr, channels, frames: Math.floor(data.length / channels) };
}

// 곡 분석: 템포·첫 박·지터·명료도·다운비트 위상.
async function analyzeFile(file, { signal } = {}) {
  const mono = (await decode(file, { sr: ANALYSIS_SR, channels: 1, signal })).data;
  const { env, fps, latency } = dsp.onsetEnvelope(mono, ANALYSIS_SR);
  const grid = dsp.fitBeatGrid(env, fps, latency);
  const phase = dsp.downbeatPhase(mono, ANALYSIS_SR, grid);
  return { ...grid, phase, durationSec: mono.length / ANALYSIS_SR, mono };
}

// 영상 길이 목표(초)에 가장 가까운 정수 마디 수. 너무 짧거나 길지 않게 제한한다.
function barsFor(targetSec, bpm, { min = 4, max = 64 } = {}) {
  const barSec = (60 / bpm) * 4;
  return Math.max(min, Math.min(max, Math.round(targetSec / barSec)));
}

// 곡에서 루프 구간을 골라 잘라낸다. 끝 40ms 는 시작 직전 오디오로 크로스페이드해 이음새를 없앤다.
async function cutLoop(file, analysis, { loopSec, bars, signal }) {
  const pick = dsp.chooseLoopStart(analysis.mono, ANALYSIS_SR, analysis, { bars, phase: analysis.phase, preRollSec: 0.05 });
  if (!pick) throw new Error(`음악이 너무 짧아 ${bars}마디 루프를 만들 수 없습니다.`);
  const { data, channels } = await decode(file, { sr: SR, channels: 2, signal });
  const s0 = Math.round(pick.start * SR);
  const n = Math.round(loopSec * SR);
  const total = Math.floor(data.length / channels);
  if (s0 + n > total) throw new Error('음악 길이가 부족해 루프 구간을 자를 수 없습니다.');
  const out = new Float32Array(n * 2);
  out.set(data.subarray(s0 * 2, (s0 + n) * 2));
  const xf = Math.min(Math.round(0.04 * SR), s0, n >> 2);
  for (let i = 0; i < xf; i += 1) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / Math.max(1, xf - 1));
    const dst = (n - xf + i) * 2, src = (s0 - xf + i) * 2;
    out[dst] = out[dst] * (1 - w) + data[src] * w;
    out[dst + 1] = out[dst + 1] * (1 - w) + data[src + 1] * w;
  }
  return { samples: out, startSec: pick.start, startBar: pick.bar, jumpDb: pick.jump };
}

/* ---------------- UI 효과음 합성 ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSynth(seed = 7) {
  const rand = mulberry32(seed);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const len = (dur) => Math.max(1, Math.floor(dur * SR));

  function band(x, lo, hi) {
    const n = dsp.nextPow2(x.length);
    const re = new Float64Array(n), im = new Float64Array(n);
    re.set(x);
    dsp.fft(re, im);
    for (let k = 0; k < n; k += 1) {
      const f = (Math.min(k, n - k) * SR) / n;
      const m = 1 / (1 + (lo / Math.max(f, 1)) ** 4) / (1 + (f / hi) ** 4);
      re[k] *= m; im[k] *= m;
    }
    dsp.fft(re, im, true);
    return Float64Array.from(re.subarray(0, x.length));
  }
  function decay(dur, tau, attack = 0.0008) {
    const n = len(dur), out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const t = i / SR;
      out[i] = (attack ? Math.min(1, t / attack) : 1) * Math.exp(-t / tau);
    }
    return out;
  }
  function sine(f, dur, tau, attack = 0.0008) {
    const e = decay(dur, tau, attack);
    for (let i = 0; i < e.length; i += 1) e[i] *= Math.sin((2 * Math.PI * f * i) / SR);
    return e;
  }
  function sweep(f0, f1, dur, tau) {
    const e = decay(dur, tau, 0.002);
    let ph = 0;
    for (let i = 0; i < e.length; i += 1) {
      const t = i / SR;
      const f = f1 + (f0 - f1) * Math.exp(-t / (dur / 3));
      ph += (2 * Math.PI * f) / SR;
      e[i] *= Math.sin(ph);
    }
    return e;
  }
  function noise(dur, lo, hi, tau, attack = 0.0005) {
    const n = len(dur);
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i += 1) raw[i] = gauss();
    const b = band(raw, lo, hi);
    let peak = 1e-9;
    for (const v of b) peak = Math.max(peak, Math.abs(v));
    const e = decay(dur, tau, attack);
    for (let i = 0; i < n; i += 1) e[i] *= b[i] / peak;
    return e;
  }
  function mix(...parts) {
    const n = Math.max(...parts.map((p) => p.length));
    const out = new Float64Array(n);
    for (const p of parts) for (let i = 0; i < p.length; i += 1) out[i] += p[i];
    return out;
  }
  const gain = (g, x) => { for (let i = 0; i < x.length; i += 1) x[i] *= g; return x; };
  function delay(x, sec) {
    const d = Math.floor(sec * SR);
    const out = new Float64Array(x.length + d);
    out.set(x, d);
    return out;
  }
  function whoosh(rise, fall, lo, hi, brightTo) {
    const n = len(rise + fall);
    const a = new Float64Array(n), b = new Float64Array(n);
    for (let i = 0; i < n; i += 1) { a[i] = gauss(); b[i] = gauss(); }
    const dark = band(a, lo, hi * 0.45), bright = band(b, lo * 2, brightTo);
    const out = new Float64Array(n);
    let peak = 1e-9;
    for (let i = 0; i < n; i += 1) {
      const t = i / SR;
      const m = Math.min(1, t / rise) * Math.exp(-Math.max(0, t - rise) / fall);
      out[i] = dark[i] * (1 - m) + bright[i] * m;
      peak = Math.max(peak, Math.abs(out[i]));
    }
    for (let i = 0; i < n; i += 1) {
      const t = i / SR;
      const env = t < rise ? Math.sin((0.5 * Math.PI * t) / rise) ** 2 : Math.exp(-(t - rise) / (fall / 3));
      out[i] = (out[i] / peak) * env;
    }
    return out;
  }

  const KINDS = {
    click: () => gain(0.55, mix(gain(0.6, noise(0.03, 2000, 7000, 0.004)), gain(0.35, sine(1800, 0.05, 0.012)), gain(0.3, sine(170, 0.06, 0.015)))),
    clickUp: () => gain(0.28, mix(gain(0.5, noise(0.02, 3000, 8000, 0.003)), gain(0.4, sine(2400, 0.03, 0.008)))),
    tick: (p) => gain(0.26, mix(gain(0.7, sine(2600 * p, 0.04, 0.01)), gain(0.3, noise(0.01, 4000, 9000, 0.002)))),
    grab: () => gain(0.3, mix(gain(0.6, sine(900, 0.06, 0.02)), gain(0.4, noise(0.02, 1500, 4000, 0.005)))),
    release: () => gain(0.24, sine(1400, 0.05, 0.015)),
    bump: () => gain(0.42, mix(sweep(240, 150, 0.12, 0.04), gain(0.35, sine(2600, 0.03, 0.008)))),
    thunk: () => gain(0.42, mix(sweep(170, 110, 0.18, 0.06), gain(0.3, noise(0.04, 200, 800, 0.01)))),
    toggle: () => {
      const a = mix(gain(0.55, noise(0.03, 2000, 6000, 0.003)), gain(0.45, sine(1300, 0.04, 0.01)));
      const b = mix(gain(0.55, noise(0.03, 2000, 6000, 0.003)), gain(0.45, sine(1750, 0.05, 0.012)));
      return gain(0.5, mix(gain(0.7, a), delay(b, 0.014)));
    },
    tab: (p) => gain(0.28, mix(gain(0.7, sine(2000 * p, 0.05, 0.014)), gain(0.3, sine(3000 * p, 0.03, 0.006)))),
    pop: () => gain(0.38, sweep(900, 420, 0.1, 0.045)),
    hover: (p) => gain(0.12, sine(3200 * p, 0.03, 0.008)),
    key: (p) => gain(0.3, mix(gain(0.5, noise(0.03, 1500, 6000, 0.005)), gain(0.3, sine(300, 0.03, 0.008)), gain(0.25, sine(2200 * p, 0.02, 0.006)))),
    enter: () => gain(0.45, mix(gain(0.5, noise(0.04, 1000, 4000, 0.008)), gain(0.5, sine(180, 0.08, 0.02)))),
    chime: () => gain(0.17, mix(sine(1318.5, 0.6, 0.25, 0.003), delay(gain(0.8, sine(1975.5, 0.6, 0.25, 0.003)), 0.06))),
    success: () => gain(0.2, mix(sine(1046.5, 0.6, 0.22, 0.003), delay(gain(0.9, sine(1568, 0.6, 0.22, 0.003)), 0.07), gain(0.6, sweep(700, 380, 0.08, 0.04)))),
    swoosh: (p) => gain(0.11 * p, whoosh(0.09, 0.16, 500, 5000, 9000)),
    swell: (p) => gain(0.12 * p, whoosh(0.16, 0.18, 300, 4000, 8000)),
    impact: (p) => gain(0.5 * p, mix(sweep(90, 45, 0.5, 0.18), gain(0.25, noise(0.08, 100, 1200, 0.03)))),
    shimmer: (p) => gain(0.1 * p, mix(sine(2093, 0.9, 0.35, 0.01), delay(gain(0.7, sine(2637, 0.9, 0.35, 0.01)), 0.05), delay(gain(0.5, sine(3136, 0.9, 0.35, 0.01)), 0.1))),
    riser: (p) => gain(0.1 * p, whoosh(0.7, 0.12, 200, 3000, 10000))
  };
  return {
    kinds: Object.keys(KINDS),
    make(kind, param = 1) {
      const fn = KINDS[kind];
      if (!fn) return null;
      return fn(Number(param) > 0 ? Number(param) : 1);
    }
  };
}

function peakIndex(x) {
  // 1ms 이동평균 엔벨로프의 최댓값 위치 = 이 소리의 타격 지점
  const w = 48;
  let acc = 0, best = 0, bestI = 0;
  const abs = (i) => Math.abs(x[i] || 0);
  for (let i = 0; i < x.length; i += 1) {
    acc += abs(i) - (i >= w ? abs(i - w) : 0);
    const c = i - (w >> 1);
    if (acc > best && c >= 0) { best = acc; bestI = c; }
  }
  return bestI;
}

// 음악 루프(스테레오 인터리브) + 효과음 → 최종 믹스. 효과음은 원형으로 배치한다.
function mixLoop({ music, loopSec, sfx = [], musicGain = 0.68, seed = 7 }) {
  const n = Math.round(loopSec * SR);
  const out = new Float32Array(n * 2);
  if (music) {
    const m = Math.min(n, music.length >> 1);
    for (let i = 0; i < m * 2; i += 1) out[i] = music[i] * musicGain;
  }
  const synth = makeSynth(seed);
  const placed = [];
  for (const event of sfx) {
    const [t, kind, param] = event;
    if (!Number.isFinite(Number(t))) continue;
    const x = synth.make(String(kind), param);
    if (!x) continue;
    const pk = peakIndex(x);
    const start = Math.round(Number(t) * SR) - pk;
    for (let i = 0; i < x.length; i += 1) {
      const j = (((start + i) % n) + n) % n;
      out[j * 2] += x[i];
      out[j * 2 + 1] += x[i];
    }
    placed.push({ t: Number(t), kind: String(kind), peakMs: (pk / SR) * 1000 });
  }
  // 부드러운 소프트니 리미터(0.9 이상만 눌러 준다)
  let peak = 0;
  for (let i = 0; i < out.length; i += 1) {
    const a = Math.abs(out[i]);
    peak = Math.max(peak, a);
    if (a > 0.9) out[i] = Math.sign(out[i]) * (0.9 + 0.07 * Math.tanh((a - 0.9) / 0.07));
  }
  return { samples: out, peakBeforeLimit: peak, placed };
}

function wavBuffer(samples, { sr = SR, channels = 2 } = {}) {
  const frames = Math.floor(samples.length / channels);
  const dataBytes = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames * channels; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

module.exports = {
  SR,
  ANALYSIS_SR,
  decode,
  analyzeFile,
  barsFor,
  cutLoop,
  makeSynth,
  peakIndex,
  mixLoop,
  wavBuffer,
  mulberry32
};
