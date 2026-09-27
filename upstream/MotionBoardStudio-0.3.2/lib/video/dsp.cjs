'use strict';

// 순수 신호처리(electron·ffmpeg 비의존): FFT, 온셋 엔벨로프, 템포/비트 그리드 추정,
// 다운비트 위상, 마디 에너지, 루프 시작 마디 선택. 테스트는 node 로 바로 돌린다.

function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr0 = Math.cos(ang), wi0 = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let k = 0; k < half; k += 1) {
        const a = i + k, b = a + half;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const nwr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i += 1) { re[i] /= n; im[i] /= n; }
}

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// 스펙트럴 플럭스(로그 압축) 온셋 엔벨로프. 프레임 i 는 [i*hop, i*hop+nfft) 창의 변화량이다.
function onsetEnvelope(mono, sr, { hop = 256, nfft = 1024, loHz = 0, hiHz = Infinity } = {}) {
  const frames = Math.max(0, 1 + Math.floor((mono.length - nfft) / hop));
  const win = hann(nfft);
  const bins = nfft / 2 + 1;
  const binHz = sr / nfft;
  const k0 = Math.max(0, Math.ceil(loHz / binHz));
  const k1 = Math.min(bins - 1, Math.floor(Math.min(hiHz, sr / 2) / binHz));
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  let prev = null;
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    const off = f * hop;
    for (let i = 0; i < nfft; i += 1) { re[i] = mono[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const cur = new Float64Array(k1 - k0 + 1);
    for (let k = k0; k <= k1; k += 1) cur[k - k0] = Math.log1p(100 * Math.hypot(re[k], im[k]));
    if (prev) {
      let s = 0;
      for (let k = 0; k < cur.length; k += 1) { const d = cur[k] - prev[k]; if (d > 0) s += d; }
      env[f] = s;
    }
    prev = cur;
  }
  // 느린 추세 제거(16프레임 이동평균) 후 음수 절단
  const w = 16, half = w >> 1;
  const out = new Float64Array(frames);
  let acc = 0;
  const pre = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i += 1) { acc += env[i]; pre[i + 1] = acc; }
  for (let i = 0; i < frames; i += 1) {
    const a = Math.max(0, i - half), b = Math.min(frames, i - half + w);
    const mean = (pre[b] - pre[a]) / w;
    out[i] = Math.max(0, env[i] - mean);
  }
  return { env: out, fps: sr / hop, latency: nfft / 2 / sr };
}

function combScore(env, bpm, fps, phases = 96) {
  const period = (60 / bpm) * fps;
  const nb = Math.floor((env.length - 1) / period);
  let best = -1, bestPh = 0;
  for (let p = 0; p < phases; p += 1) {
    const ph = (p / phases) * period;
    let s = 0;
    for (let k = 0; k < nb; k += 1) {
      const i = Math.round(ph + period * k);
      if (i < env.length) s += env[i];
    }
    s /= Math.max(1, nb);
    if (s > best) { best = s; bestPh = ph; }
  }
  return { score: best, phase: bestPh };
}

function percentile(values, q) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// 빗살 필터로 템포를 찾고, 예측 비트 근처의 온셋 피크에 스냅한 뒤 최소제곱으로 박 간격·첫 박을 맞춘다.
function fitBeatGrid(env, fps, latency, { bpmLo = 80, bpmHi = 165 } = {}) {
  let coarse = { bpm: 0, score: -1 };
  for (let bpm = bpmLo; bpm < bpmHi; bpm += 0.25) {
    const { score } = combScore(env, bpm, fps, 48);
    if (score > coarse.score) coarse = { bpm, score };
  }
  let fine = { bpm: coarse.bpm, score: -1, phase: 0 };
  for (let bpm = coarse.bpm - 0.5; bpm <= coarse.bpm + 0.5; bpm += 0.01) {
    const r = combScore(env, bpm, fps, 96);
    if (r.score > fine.score) fine = { bpm, score: r.score, phase: r.phase };
  }
  const period = (60 / fine.bpm) * fps;
  const w = Math.max(2, Math.round(0.03 * fps));
  const thr = percentile(env, 0.75);
  const ks = [], ts = [];
  for (let k = 0; ; k += 1) {
    const c = Math.round(fine.phase + k * period);
    if (c >= env.length - 1) break;
    let j = Math.max(1, c - w);
    for (let i = Math.max(1, c - w); i <= Math.min(env.length - 2, c + w); i += 1) if (env[i] > env[j]) j = i;
    if (env[j] < thr) continue;
    const y0 = env[j - 1], y1 = env[j], y2 = env[j + 1];
    const den = y0 - 2 * y1 + y2;
    const off = den ? (0.5 * (y0 - y2)) / den : 0;
    ks.push(k);
    ts.push((j + off) / fps + latency);
  }
  if (ks.length < 8) {
    return { bpm: fine.bpm, t0: fine.phase / fps + latency, jitterMs: NaN, beats: ks.length, clarity: 0 };
  }
  const n = ks.length;
  const mk = ks.reduce((a, b) => a + b, 0) / n, mt = ts.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (ks[i] - mk) * (ts[i] - mt); sxx += (ks[i] - mk) ** 2; }
  const per = sxy / sxx;
  let t0 = mt - per * mk;
  let ss = 0;
  for (let i = 0; i < n; i += 1) ss += (ts[i] - (ks[i] * per + t0)) ** 2;
  // 첫 박이 음수 시간이면 한 박씩 당긴다
  while (t0 < 0) t0 += per;
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  return {
    bpm: 60 / per,
    t0,
    jitterMs: Math.sqrt(ss / n) * 1000,
    beats: n,
    clarity: fine.score / (mean + 1e-9)
  };
}

function rmsDb(mono, a, b) {
  a = Math.max(0, Math.floor(a)); b = Math.min(mono.length, Math.floor(b));
  if (b <= a) return -120;
  let s = 0;
  for (let i = a; i < b; i += 1) s += mono[i] * mono[i];
  return 10 * Math.log10(s / (b - a) + 1e-12);
}

// 박별 에너지 상승이 가장 자주 몰리는 위상을 다운비트로 본다(4박 기준).
function downbeatPhase(mono, sr, grid) {
  const beat = 60 / grid.bpm;
  const e = [];
  for (let k = 0; ; k += 1) {
    const a = (grid.t0 + k * beat) * sr, b = (grid.t0 + (k + 1) * beat) * sr;
    if (b > mono.length) break;
    e.push(rmsDb(mono, a, b));
  }
  const score = [0, 0, 0, 0], count = [0, 0, 0, 0];
  for (let k = 1; k < e.length; k += 1) {
    score[k % 4] += Math.max(0, e[k] - e[k - 1]);
    count[k % 4] += 1;
  }
  let best = 0;
  for (let p = 1; p < 4; p += 1) if (score[p] / Math.max(1, count[p]) > score[best] / Math.max(1, count[best])) best = p;
  return best;
}

// 루프로 쓸 시작 마디: 이후 bars 마디의 평균 에너지가 크고, 그 마디에서 에너지가 뛰어오르는(프레이즈 시작) 곳.
function chooseLoopStart(mono, sr, grid, { bars, phase = 0, preRollSec = 0.05 }) {
  const beat = 60 / grid.bpm;
  const barSec = beat * 4;
  const first = grid.t0 + phase * beat;
  const barDb = [];
  for (let b = 0; ; b += 1) {
    const a = (first + b * barSec) * sr, e = (first + (b + 1) * barSec) * sr;
    if (e > mono.length) break;
    barDb.push(rmsDb(mono, a, e));
  }
  const candidates = [];
  // 루프 뒤에 한 마디 여유를 남긴다(프레임 반올림으로 루프가 마디 끝을 몇 샘플 넘을 수 있다).
  for (let b = 0; b + bars < barDb.length; b += 1) {
    const start = first + b * barSec;
    if (start < preRollSec) continue;
    let sum = 0;
    for (let i = b; i < b + bars; i += 1) sum += barDb[i];
    const jump = b > 0 ? barDb[b] - barDb[b - 1] : 0;
    const score = sum / bars + 0.6 * Math.max(0, jump) - (b % 4 === 0 ? 0 : 0.35);
    candidates.push({ bar: b, start, score, jump });
  }
  if (!candidates.length) return null;
  candidates.sort((x, y) => y.score - x.score);
  return { ...candidates[0], barDb, first };
}

module.exports = {
  fft,
  nextPow2,
  hann,
  onsetEnvelope,
  combScore,
  fitBeatGrid,
  downbeatPhase,
  chooseLoopStart,
  rmsDb,
  percentile
};
