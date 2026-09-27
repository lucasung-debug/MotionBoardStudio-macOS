/* 모션 키트(MK) — 영상 코드가 쓰는 브라우저 런타임.
 * 앱이 이 파일을 합성 HTML 안에 그대로 넣는다. 모든 상태는 render(t)에서 시간만으로 계산한다.
 * - 스프링은 닫힌 형태(closed-form) 응답. 목표가 여러 번 바뀌는 값은 chain() 으로, 각 모드가 직전
 *   모드가 남긴 값·속도에서 이어서 출발한다. chain 은 주기 T 로 순환하므로 마지막 프레임 = 첫 프레임.
 * - CSS transition/animation, 타이머, 프레임 간 누적 상태는 쓰지 않는다(키트가 감지해 오류로 보고).
 */
(function () {
  'use strict';
  const TIMING = window.MK_TIMING || {};
  const T = Number(TIMING.T) || 30;
  const BEAT = Number(TIMING.BEAT) || 0.5;
  const errors = [];
  window.MK_ERRORS = errors;
  // 같은 오류가 매 프레임 반복되므로 첫 줄 기준으로 한 번만 기록하고, 스택은 앞 3줄만 남긴다.
  const seen = new Set();
  const report = (msg) => {
    const text = String(msg).split(/\r?\n/).slice(0, 3).join(' | ');
    const key = text.split(' | ')[0].replace(/^render\([\d.]+\): /, 'render: ');
    if (seen.has(key) || errors.length >= 30) return;
    seen.add(key);
    errors.push(text);
  };
  window.addEventListener('error', (e) => report(`${e.message || e.error} @${e.lineno || '?'}:${e.colno || '?'}`));
  window.addEventListener('unhandledrejection', (e) => report(`unhandled: ${e.reason && e.reason.stack || e.reason}`));

  // 시간 기반 API 차단 — 렌더는 seek(t)만으로 결정되어야 한다.
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeTimeout = window.setTimeout.bind(window);
  const banned = (name) => function () { report(`${name}() 사용 금지: 모든 상태는 render(t)에서 시간으로 계산하세요.`); return 0; };
  window.setTimeout = banned('setTimeout');
  window.setInterval = banned('setInterval');
  window.requestAnimationFrame = banned('requestAnimationFrame');
  // Math.random 은 프레임마다 같은 순서를 내는 시드 난수로 바꾼다(깜빡임 방지). 가능하면 MK.rand(seed)를 쓴다.
  let rngState = 0x9e3779b9;
  const nextRand = () => {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let x = rngState;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = nextRand;

  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, u) => a + (b - a) * u;
  const invLerp = (a, b, x) => (b === a ? 0 : clamp((x - a) / (b - a)));
  const smoothstep = (a, b, x) => { const u = invLerp(a, b, x); return u * u * (3 - 2 * u); };
  const ease = {
    linear: (u) => clamp(u),
    inQuad: (u) => clamp(u) ** 2,
    outQuad: (u) => 1 - (1 - clamp(u)) ** 2,
    inCubic: (u) => clamp(u) ** 3,
    outCubic: (u) => 1 - (1 - clamp(u)) ** 3,
    inOutCubic: (u) => { u = clamp(u); return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2; },
    inOutSine: (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(u)),
    outExpo: (u) => { u = clamp(u); return u >= 1 ? 1 : 1 - 2 ** (-10 * u); }
  };
  const softmin = (a, b, k = 0.06) => { const m = Math.min(a, b); return m - k * Math.log(Math.exp(-(a - m) / k) + Math.exp(-(b - m) / k)); };

  function free(t, e0, v0, w, z) {
    if (z >= 1) { const a = Math.exp(-w * t); return a * (e0 + (v0 + w * e0) * t); }
    const wd = w * Math.sqrt(1 - z * z), a = Math.exp(-z * w * t);
    return a * (e0 * Math.cos(wd * t) + ((v0 + z * w * e0) / wd) * Math.sin(wd * t));
  }
  const step = (t, w, z) => (t <= 0 ? 0 : 1 - free(t, 1, 0, w, z));
  const SP = Object.freeze({
    SHAPE: { w: 19, z: 0.86 }, SNAPPY: { w: 28, z: 0.85 }, SOFT: { w: 10, z: 0.95 },
    PRESS: { w: 45, z: 0.8 }, CAMERA: { w: 9, z: 1 }, COLOR: { w: 38, z: 1 }, FAST: { w: 200, z: 1 }
  });

  // modes: [[time, value | (t)=>value, preset?], ...] (한 주기 안의 시각). 주기적으로 순환한다.
  function chain(modes, preset = SP.SHAPE) {
    if (!Array.isArray(modes) || !modes.length) throw new Error('MK.chain: 모드가 비어 있습니다.');
    const ms = modes.map((m) => {
      const p = m[2] || preset;
      if (!(Number.isFinite(m[0]))) throw new Error(`MK.chain: 시각이 숫자가 아닙니다: ${m[0]}`);
      return { t: mod(m[0], T), v: m[1], w: p.w, z: p.z };
    });
    const ext = [];
    for (let k = -3; k <= 0; k += 1) for (const m of ms) ext.push({ ...m, T0: m.t + k * T, k });
    ext.sort((a, b) => a.T0 - b.T0);
    const fv = (m, t) => (typeof m.v === 'function' ? m.v(t - m.k * T) : m.v);
    const val = (m, t) => fv(m, t) + free(t - m.T0, m.e, m.dv, m.w, m.z);
    const h = 1e-4;
    ext[0].e = 0; ext[0].dv = 0;
    for (let i = 1; i < ext.length; i += 1) {
      const p = ext[i - 1], m = ext[i], t = m.T0;
      const A = val(p, t), Ad = (val(p, t + h) - val(p, t - h)) / (2 * h);
      const B = fv(m, t), Bd = (fv(m, t + h) - fv(m, t - h)) / (2 * h);
      m.e = A - B; m.dv = Ad - Bd;
    }
    const live = ext.filter((m) => m.k >= -1);
    return {
      at(t) {
        t = mod(t, T);
        let m = live[0];
        for (const c of live) { if (c.T0 <= t) m = c; else break; }
        return val(m, t);
      }
    };
  }
  function chainXY(modes, preset) {
    const pick = (i) => modes.map((m) => [m[0], typeof m[1] === 'function' ? ((t) => m[1](t)[i]) : m[1][i], m[2]]);
    const x = chain(pick(0), preset), y = chain(pick(1), preset);
    return { x, y, at: (t) => [x.at(t), y.at(t)] };
  }
  function parseColor(c) {
    if (Array.isArray(c)) return c.map(Number);
    const s = String(c).trim();
    const m = s.match(/^#?([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    const r = s.match(/rgba?\(([^)]+)\)/i);
    if (r) return r[1].split(',').slice(0, 3).map(Number);
    throw new Error(`MK.chainColor: 색을 해석할 수 없습니다: ${c}`);
  }
  function chainColor(modes, preset = SP.COLOR) {
    const chans = [0, 1, 2].map((i) => chain(modes.map((m) => [m[0], parseColor(m[1])[i], m[2]]), preset));
    const rgb = (t) => chans.map((ch) => Math.round(clamp(ch.at(t), 0, 255)));
    return { rgb, at: (t) => `rgb(${rgb(t).join(',')})` };
  }

  // 등장·퇴장 가시성: tIn 에 들어오고 tOut 에 나간다(tOut < tIn 이면 루프 경계를 넘는 구간).
  function vis(t, tIn, tOut, { dIn = 0.18, dOut = 0.1 } = {}) {
    if (tOut < tIn) tOut += T;
    let best = { o: 0, p: 0, q: 1, a: 0 };
    for (const tt of [t, t + T]) {
      if (tt < tIn - 0.001) continue;
      const p = clamp((tt - tIn) / dIn), q = clamp((tt - tOut) / dOut);
      const o = ease.outQuad(p) * (1 - ease.inQuad(q));
      if (o > best.o) best = { o, p, q, a: tt - tIn };
    }
    return best;
  }
  // 요소에 등장·퇴장(블러+스케일+불투명도)을 적용한다. camScale: 요소가 카메라 안에 있으면 그 배율(블러를 화면 px 로 맞춤).
  function show(el, t, tIn, tOut, { blur = 14, blurOut = 10, scale = true, dIn, dOut, camScale = 1, origin } = {}) {
    const v = vis(t, tIn, tOut, { dIn, dOut });
    const st = el.style;
    if (v.o <= 0.002) { st.visibility = 'hidden'; return v; }
    st.visibility = 'visible';
    st.opacity = v.o.toFixed(4);
    const b = ((1 - ease.outCubic(v.p)) * blur + ease.inQuad(v.q) * blurOut) / Math.max(0.01, camScale);
    st.filter = b > 0.02 ? `blur(${b.toFixed(3)}px)` : 'none';
    if (scale) {
      const sc = (0.955 + 0.045 * step(v.a, 22, 0.9)) * (1 - 0.03 * v.q);
      if (origin) st.transformOrigin = origin;
      st.transform = Math.abs(sc - 1) > 1e-4 ? `scale(${sc})` : 'none';
    }
    return v;
  }
  // 카메라: 월드 좌표 (x,y)를 화면 중앙에 두고 scale 배. will-change 는 쓰지 않는다(글자 흐려짐).
  function camera(el, { scale = 1, x = 0, y = 0 } = {}) {
    el.style.transformOrigin = '0 0';
    el.style.transform = `translate(${MK.W / 2}px,${MK.H / 2}px) scale(${scale}) translate(${-x}px,${-y}px)`;
  }
  function rand(seed = 1) {
    let a = (seed * 2654435761) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SFX_KINDS = ['click', 'clickUp', 'tick', 'grab', 'release', 'bump', 'thunk', 'toggle', 'tab', 'pop', 'hover', 'key', 'enter', 'chime', 'success', 'swoosh', 'swell', 'impact', 'shimmer', 'riser'];
  const sfxList = [];
  function sfx(time, kind, gain = 1) {
    if (!SFX_KINDS.includes(kind)) { report(`MK.sfx: 알 수 없는 효과음 "${kind}" (사용 가능: ${SFX_KINDS.join(', ')})`); return; }
    if (!Number.isFinite(time)) { report(`MK.sfx: 시각이 숫자가 아닙니다 (${kind})`); return; }
    sfxList.push([mod(time, T), kind, Number(gain) || 1]);
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs = {}, parent) {
    const svgTags = ['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g', 'text', 'defs', 'clipPath', 'mask', 'use', 'tspan'];
    const e = svgTags.includes(tag) ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v);
    }
    if (parent) parent.appendChild(e);
    return e;
  }

  let def = null;
  let built = false;
  const MK = {
    T, FPS: Number(TIMING.FPS) || 60, W: Number(TIMING.W) || 1440, H: Number(TIMING.H) || 1440,
    BPM: Number(TIMING.BPM) || 60 / BEAT, BEAT, BARS: Number(TIMING.BARS) || Math.round(T / (BEAT * 4)),
    SCENES: TIMING.SCENES || [],
    beat: (i) => i * BEAT,
    bar: (n, b = 0) => (n * 4 + b) * BEAT,
    mod, clamp, lerp, invLerp, smoothstep, ease, softmin,
    free, step, SP, chain, chainXY, chainColor, vis, show, camera, rand, sfx, el,
    SFX_KINDS,
    define(d) {
      if (!d || typeof d.render !== 'function') { report('MK.define: render(t) 함수가 필요합니다.'); return; }
      def = d;
    },
    seek(t) {
      if (!def || !built) return false;
      rngState = 0x9e3779b9;
      try { def.render(mod(Number(t) || 0, T)); } catch (e) { report(`render(${Number(t).toFixed(3)}): ${e && e.stack || e}`); return false; }
      return true;
    },
    sfxList: () => sfxList.slice().sort((a, b) => a[0] - b[0]),
    errors: () => errors.slice(),
    debugLabel(text) {
      let d = document.getElementById('mk-debug-label');
      if (!text) { if (d) d.remove(); return; }
      if (!d) {
        d = document.createElement('div');
        d.id = 'mk-debug-label';
        d.style.cssText = 'position:fixed;left:18px;top:14px;z-index:2147483647;font:700 72px/1.15 system-ui,sans-serif;color:#000;background:rgba(255,255,255,.88);padding:4px 12px;border-radius:8px;';
        document.body.appendChild(d);
      }
      d.textContent = text;
    },
    fail(e) { report(`코드 실행 오류: ${e && e.stack || e}`); },
    async boot() {
      const families = Array.isArray(window.MK_FONTS) ? window.MK_FONTS : [];
      // Google Fonts 한글 글꼴은 글자 묶음(unicode-range)별 파일로 나뉘고, 글자가 처음 쓰일 때 받는다.
      // 미리 받지 않으면 첫 프레임에 글자가 비고(font-display:block), 캔버스 측정도 틀린다.
      // 그래서 화면에 쓸 글자 전체로 각 글꼴을 불러온 뒤에 build·렌더한다.
      const BASE = '0123456789+-.,:;!?%$#&@\'"()[]/·… ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
      // 엔진이 장면끼리 next/prev 로 서로 참조하므로 방문 표시로 순환을 끊는다.
      const stringsOf = (v, out, seen = new WeakSet()) => {
        if (typeof v === 'string') out.push(v);
        else if (v && typeof v === 'object') {
          if (seen.has(v)) return out;
          seen.add(v);
          (Array.isArray(v) ? v : Object.values(v)).forEach((x) => stringsOf(x, out, seen));
        }
        return out;
      };
      const loadGlyphs = async (text) => {
        const chars = [...new Set([...String(text)])].join('');
        if (!chars.trim()) return;
        await Promise.all(families.map((f) => document.fonts.load(f, chars).catch(() => {})));
        try { await document.fonts.ready; } catch {}
      };
      const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => nativeTimeout(r, ms))]);
      await withTimeout((async () => {
        try { await document.fonts.ready; } catch {}
        await loadGlyphs(BASE + stringsOf(window.MK_SCRIPT || null, []).join('') + (document.getElementById('stage')?.textContent || ''));
      })(), 20000);
      if (!def) { report('MK.define({ build, render }) 가 호출되지 않았습니다.'); return false; }
      try {
        const stage = document.getElementById('stage');
        if (typeof def.build === 'function') def.build(stage);
        built = true;
      } catch (e) { report(`build(): ${e && e.stack || e}`); return false; }
      // build 가 만든 글자(모델이 코드로 쓴 문구)까지 받아 둔다.
      await withTimeout(loadGlyphs(document.getElementById('stage')?.textContent || ''), 15000);
      const ok = MK.seek(0);
      if (location.hash === '#play') {
        const fitView = () => { const k = Math.min(innerWidth / MK.W, innerHeight / MK.H); document.getElementById('stage').style.transform = `scale(${k})`; document.getElementById('stage').style.transformOrigin = '0 0'; };
        fitView(); window.addEventListener('resize', fitView);
        const t0 = performance.now();
        const loop = (now) => { MK.seek((now - t0) / 1000); nativeRaf(loop); };
        nativeRaf(loop);
      }
      return ok && errors.length === 0;
    }
  };
  window.MK = MK;
})();
