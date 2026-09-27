/* 모션 엔진 — 연출 스크립트(window.MK_SCRIPT)를 결정적으로 렌더한다. MK 키트 위에서 동작한다.
 *
 * 설계 원칙
 * - 모델은 "무엇을"(장면 종류·카피·색·박자·전환)만 정하고, "어떻게"(타이포·레이아웃·모션·전환·루프)는 엔진이 책임진다.
 * - 모든 글자는 측정해서 안전 영역 안에 맞춘다(잘림·넘침 없음). 색은 대비를 계산해 고른다.
 * - 한 개의 히어로 도형이 장면 사이를 이어받아 모핑한다(컷이 아니라 하나의 흐름).
 * - 장면 전환(컷·와이프·아이리스·푸시·줌·모프)은 박에 맞춰 스프링으로 움직인다. 루프 경계도 같은 규칙.
 */
(function () {
  'use strict';
  const S = window.MK_SCRIPT;
  if (!S || !Array.isArray(S.shots) || !S.shots.length) { MK.fail('MK_SCRIPT(연출 스크립트)가 없습니다.'); return; }

  const { W, H, T, BEAT, clamp, lerp, mod, ease, step, SP } = MK;
  const U = Math.min(W, H) / 100;
  const M = 7 * U;
  const PORTRAIT = H / W > 1.2;
  const LANDSCAPE = W / H > 1.2;
  const LEAD = 0.12;
  const ENERGY = S.mood === 'energetic' ? 1 : (S.mood === 'calm' || S.mood === 'elegant') ? 0.35 : 0.7;
  const P = S.palette;

  /* ---------- 색 ---------- */
  const hexRgb = (h) => { const m = String(h).replace('#', ''); return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16)); };
  const lum = (h) => {
    const c = hexRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const colorOf = (key, fallback) => (key && P[key]) || (typeof key === 'string' && /^#[0-9a-f]{6}$/i.test(key) ? key : fallback);
  const CANDIDATES = [P.ink, P.bg, P.surface, P.accent, P.accent2, '#ffffff', '#101010'];
  function bestOn(bg, prefer, min = 3) {
    if (prefer && contrast(prefer, bg) >= min) return prefer;
    let best = CANDIDATES[0], score = 0;
    for (const c of CANDIDATES) { const s = contrast(c, bg); if (s > score) { score = s; best = c; } }
    return best;
  }
  function accentOn(bg) {
    for (const c of [P.accent, P.accent2, P.ink, P.surface]) if (c && contrast(c, bg) >= 2.2) return c;
    return bestOn(bg);
  }

  /* ---------- 글꼴·측정 ---------- */
  const F = S.fonts;
  const FAM = {
    display: `"${F.display}", "${F.text}", sans-serif`,
    latin: `"${F.latin}", "${F.display}", sans-serif`,
    text: `"${F.text}", sans-serif`
  };
  const WT = F.weights;
  const hasKo = (s) => /[ᄀ-ᇿ㄰-㆏가-힯]/.test(String(s));
  const famOf = (s) => (hasKo(s) ? FAM.display : FAM.latin);
  const wOf = (s) => (hasKo(s) ? WT.display : WT.latin);
  const cv = document.createElement('canvas').getContext('2d');
  function emWidth(s, family, weight) { cv.font = `${weight} 100px ${family}`; return cv.measureText(String(s)).width / 100; }
  // 여러 줄을 같은 크기로, 가로 maxW·세로 maxH 안에 맞추는 글자 크기(px)
  function fitSize(lines, { maxW, maxH = Infinity, lineH = 1, maxSize, minSize = 2.6 * U, family = famOf, weight = wOf, tracking = -0.02 }) {
    let size = maxSize;
    for (const l of lines) {
      const w = emWidth(l, family(l), weight(l)) + tracking * Math.max(0, [...String(l)].length - 1);
      size = Math.min(size, maxW / Math.max(0.3, w));
    }
    size = Math.min(size, maxH / Math.max(1, lines.length * lineH));
    return Math.max(minSize, Math.floor(size));
  }

  /* ---------- DOM ---------- */
  function el(tag, css, parent, text) {
    const e = document.createElement(tag);
    if (css) Object.assign(e.style, css);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  const abs = (x, y, w, h, extra) => Object.assign({ position: 'absolute', left: `${x}px`, top: `${y}px`, width: w == null ? 'auto' : `${w}px`, height: h == null ? 'auto' : `${h}px` }, extra || {});

  // 줄 마스크: 넘치면 잘리는 창(wrap) 안에서 글줄(inner)이 아래→위로 올라온다.
  function maskLine(parent, text, { x, y, size, color, family, weight, align = 'left', lineH = 1.02, tracking = -0.02, width, stroke }) {
    const h = size * lineH;
    const pad = size * 0.14;
    const w = width || W;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const wrap = el('div', abs(left, y - pad, w, h + pad * 2, { overflow: 'hidden' }), parent);
    const inner = el('div', {
      position: 'absolute', left: '0', top: `${pad}px`, width: '100%', height: `${h}px`,
      font: `${weight || wOf(text)} ${size}px/${h}px ${family || famOf(text)}`, letterSpacing: `${tracking}em`,
      color: stroke ? 'transparent' : color, textAlign: align, whiteSpace: 'nowrap',
      webkitTextStroke: stroke ? `${Math.max(1.5, size * 0.03)}px ${color}` : ''
    }, wrap, text);
    // 창 밖으로 완전히 나가야 글자 끝이 비치지 않는다: 창 높이 + 여유만큼 이동
    return { wrap, inner, h, size, travel: h + pad * 2 + 2 };
  }
  function setY(inner, px) { inner.style.transform = Math.abs(px) < 0.05 ? 'none' : `translateY(${px.toFixed(2)}px)`; }
  // 등장·퇴장 스프링. exitAt 이 null 이면 퇴장하지 않는다(다음 장면이 덮는다).
  const inS = (lt, t0, w = 24, z = 0.92) => step(lt - t0, w, z);
  const outS = (lt, t1) => (t1 == null ? 0 : step(lt - t1, 30, 1));
  function revealLine(line, lt, t0, t1) { setY(line.inner, (1 - inS(lt, t0)) * line.travel - outS(lt, t1) * line.travel); }
  function fade(node, lt, t0, t1, { y = 0.8 * U } = {}) {
    const a = inS(lt, t0, 18, 1), b = outS(lt, t1);
    node.style.opacity = (a * (1 - b)).toFixed(3);
    const dy = (1 - a) * y - b * y;
    node.style.transform = Math.abs(dy) < 0.05 ? 'none' : `translateY(${dy}px)`;
  }
  const pulse = (t) => Math.exp(-mod(t, BEAT) / 0.09);

  /* ---------- 장면 공통 ---------- */
  const shots = S.shots;
  const N = shots.length;
  const COVER = { cut: 0, wipe: 0.5, iris: 0.55, push: 0.5, zoom: 0.35, morph: 0.42 };
  shots.forEach((sh, i) => {
    sh.index = i;
    sh.next = shots[(i + 1) % N];
    sh.prev = shots[(i - 1 + N) % N];
    sh.bgColor = colorOf(sh.bg, P.bg);
    sh.fgColor = bestOn(sh.bgColor, colorOf(sh.fg, null));
    sh.acColor = accentOn(sh.bgColor);
    sh.tail = COVER[sh.next.transition] ?? 0.4;
    // 다음 장면이 부드럽게 겹치는 전환이면 내용이 먼저 퇴장한다(글자 겹침 방지).
    sh.exitAt = ['morph', 'zoom'].includes(sh.next.transition) ? Math.max(0.25, sh.dur - 0.22) : null;
  });
  const localT = (t, sh) => mod(t - sh.start + LEAD, T) - LEAD;

  function trIn(sh, lt) {
    switch (sh.transition) {
      case 'cut': return lt >= 0 ? 1 : 0;
      case 'wipe': case 'iris': case 'push': return step(lt + LEAD, 13, 1);
      case 'zoom': return step(lt + 0.04, 16, 1);
      default: return step(lt + 0.06, 12, 1);
    }
  }

  /* ---------- 히어로 도형 ---------- */
  function shapeBox(shape, size) {
    switch (shape) {
      case 'pill': return { w: size * 1.9, h: size * 0.82, r: size * 0.41, rot: 0 };
      case 'square': return { w: size, h: size, r: size * 0.16, rot: 0 };
      case 'diamond': return { w: size * 0.8, h: size * 0.8, r: size * 0.1, rot: 45 };
      case 'bar': return { w: size * 2.6, h: size * 0.34, r: size * 0.17, rot: 0 };
      default: return { w: size, h: size, r: size / 2, rot: 0 };
    }
  }
  const heroAt = (x, y, size, color, shape = S.motif, extra = {}) => ({ x, y, color, alpha: 1, ...shapeBox(shape, size), ...extra });
  const heroOff = (x, y, color) => ({ x, y, w: 0, h: 0, r: 0, rot: 0, color, alpha: 0 });
  const heroModes = []; // [time, state, spring]

  /* ---------- 장면 빌더 ---------- */
  const lay = { x0: M, x1: W - M, y0: M, y1: H - M, cw: W - 2 * M, ch: H - 2 * M, cx: W / 2, cy: H / 2 };
  const sfx = (t, kind, gain) => MK.sfx(mod(t, T), kind, gain);
  const soft = (kind) => (ENERGY < 0.5 && kind === 'impact' ? 'thunk' : kind);
  const beatsIn = (sh) => Math.max(1, Math.round(sh.dur / BEAT));

  // 짧은 영문 키커(대문자·자간) — 글자 크기는 화면 비례
  function kicker(fg, text, x, y, color, align = 'left') {
    const size = Math.max(2.4 * U, 18);
    const node = el('div', abs(align === 'center' ? x - W / 2 : x, y, align === 'center' ? W : lay.cw, size * 1.4, {
      font: `${WT.textBold} ${size}px/${size * 1.4}px ${FAM.text}`, letterSpacing: '0.22em', color, textAlign: align,
      textTransform: 'uppercase', whiteSpace: 'nowrap'
    }), fg, text);
    return { node, h: size * 1.4 };
  }
  function bodyText(fg, text, x, y, width, size, color, align = 'left') {
    return el('div', abs(align === 'center' ? x - width / 2 : x, y, width, null, {
      font: `${WT.text} ${size}px/${size * 1.4}px ${FAM.text}`, color, textAlign: align, letterSpacing: '-0.01em'
    }), fg, text);
  }

  const BUILDERS = {
    title(sh, fg) {
      const lines = sh.lines;
      const maxW = LANDSCAPE ? lay.cw * 0.6 : lay.cw * 0.9;
      const size = fitSize(lines, { maxW, maxH: lay.ch * (PORTRAIT ? 0.42 : 0.56), maxSize: 21 * U, lineH: 1.02 });
      const lh = size * 1.02;
      const kh = sh.kicker ? 5 * U : 0;
      const blockH = kh + lines.length * lh + (sh.sub ? 9 * U : 3 * U);
      const top = PORTRAIT ? lay.y0 + 8 * U : lay.cy - blockH / 2 - (LANDSCAPE ? 0 : 3 * U);
      const k = sh.kicker ? kicker(fg, sh.kicker, lay.x0, top, sh.acColor) : null;
      const ls = lines.map((t, i) => maskLine(fg, t, { x: lay.x0, y: top + kh + i * lh, size, color: sh.fgColor, width: lay.cw }));
      const barY = top + kh + lines.length * lh + 1.8 * U;
      const bar = el('div', abs(lay.x0, barY, 16 * U, 1.3 * U, { background: sh.acColor, transformOrigin: '0 50%', borderRadius: `${0.65 * U}px` }), fg);
      const sub = sh.sub ? bodyText(fg, sh.sub, lay.x0, barY + 3.2 * U, maxW, 3.3 * U, sh.fgColor) : null;
      const size0 = PORTRAIT ? 52 * U : LANDSCAPE ? 46 * U : 44 * U;
      const hx = PORTRAIT ? lay.cx + 12 * U : LANDSCAPE ? lay.x1 - 14 * U : lay.x1 - 4 * U;
      const hy = PORTRAIT ? lay.y1 - 16 * U : LANDSCAPE ? lay.cy : lay.y1 - 2 * U;
      heroModes.push([sh.start, heroAt(hx, hy, size0, sh.acColor)]);
      sfx(sh.start + 0.02, soft('swoosh'), 0.5 * (0.6 + ENERGY * 0.4));
      return (lt) => {
        if (k) fade(k.node, lt, 0.0, sh.exitAt);
        ls.forEach((l, i) => revealLine(l, lt, 0.06 + i * 0.07, sh.exitAt == null ? null : sh.exitAt + i * 0.03));
        const b = inS(lt, 0.2 + lines.length * 0.07, 20, 1) * (1 - outS(lt, sh.exitAt));
        bar.style.transform = `scaleX(${b.toFixed(4)})`;
        if (sub) fade(sub, lt, 0.32 + lines.length * 0.07, sh.exitAt);
      };
    },

    slam(sh, fg, bgInner) {
      const words = sh.words;
      const per = Math.max(1, Math.floor(beatsIn(sh) / words.length));
      // 단어마다 따로 화면을 채운다(짧은 "짝!"은 크게, 긴 단어는 폭에 맞춰)
      const nodes = words.map((w) => {
        const size = fitSize([w], { maxW: lay.cw * 0.92, maxH: lay.ch * 0.56, maxSize: (PORTRAIT ? 32 : 38) * U, lineH: 1 });
        return el('div', abs(0, lay.cy - size * 0.56, W, size * 1.12, {
          font: `${wOf(w)} ${size}px/${size * 1.12}px ${famOf(w)}`, letterSpacing: '-0.03em', textAlign: 'center', whiteSpace: 'nowrap',
          transformOrigin: '50% 55%', display: 'none'
        }), fg, w);
      });
      // 짝수 단어는 장면 배경, 홀수 단어는 강조색 배경(에너지가 높을 때만)
      const flip = ENERGY >= 0.7;
      const altBg = flip ? (contrast(P.accent, sh.bgColor) > 1.6 ? P.accent : P.ink) : sh.bgColor;
      const bgFor = (i) => (i % 2 && flip ? altBg : sh.bgColor);
      words.forEach((_, i) => { if (i) sfx(sh.start + i * per * BEAT, soft('impact'), 0.45 + 0.1 * ENERGY); });
      sfx(sh.start, soft('impact'), 0.55);
      heroModes.push([sh.start, heroOff(lay.cx, lay.cy, sh.acColor), SP.SNAPPY]);
      return (lt) => {
        const i = clamp(Math.floor(Math.max(0, lt) / (per * BEAT)), 0, words.length - 1);
        const since = Math.max(0, lt) - i * per * BEAT;
        const bg = bgFor(i);
        bgInner.style.background = bg;
        nodes.forEach((n, j) => {
          if (j !== i || lt < -0.001) { n.style.display = 'none'; return; }
          n.style.display = 'block';
          n.style.color = bestOn(bg, i % 2 ? P.surface : sh.fgColor);
          const s = step(since, 26, 0.72);
          const sc = 1.32 - 0.32 * s;
          const rot = (1 - s) * (i % 2 ? 4 : -4);
          const out = outS(lt, sh.exitAt);
          n.style.opacity = (1 - out).toFixed(3);
          n.style.transform = `scale(${sc.toFixed(4)}) rotate(${rot.toFixed(3)}deg)`;
        });
      };
    },

    stack(sh, fg) {
      const items = sh.items;
      const idxSize = 3.2 * U;
      const top = (sh.kicker ? 13 * U : 6 * U) + lay.y0;
      const rowGap = 2.4 * U;
      const availH = lay.y1 - top - 2 * U;
      const size = fitSize(items, { maxW: lay.cw - 11 * U, maxH: (availH - rowGap * (items.length - 1)) / 1.02, maxSize: 13 * U, lineH: 1.02 });
      const rowH = size * 1.02 + rowGap;
      const blockTop = top + Math.max(0, (availH - rowH * items.length) / 2);
      const k = sh.kicker ? kicker(fg, sh.kicker, lay.x0, lay.y0 + 2 * U, sh.acColor) : null;
      const stepB = Math.max(1, Math.floor((beatsIn(sh) - (sh.exitAt ? 1 : 0)) / items.length));
      const rows = items.map((t, i) => {
        const y = blockTop + i * rowH;
        const idx = el('div', abs(lay.x0, y + size * 0.5 - idxSize * 0.62, 9 * U, idxSize * 1.3, {
          font: `${WT.latin} ${idxSize}px/${idxSize * 1.3}px ${FAM.latin}`, color: sh.acColor, letterSpacing: '0.04em'
        }), fg, String(i + 1).padStart(2, '0'));
        const line = maskLine(fg, t, { x: lay.x0 + 11 * U, y, size, color: sh.fgColor, width: lay.cw - 11 * U });
        const rule = el('div', abs(lay.x0, y + size * 1.02 + rowGap / 2, lay.cw, Math.max(1, 0.18 * U), { background: sh.fgColor, opacity: '0.18', transformOrigin: '0 50%' }), fg);
        sfx(sh.start + i * stepB * BEAT + 0.02, 'tick', 0.9 + i * 0.05);
        return { idx, line, rule, t0: i * stepB * BEAT };
      });
      heroModes.push([sh.start, heroAt(lay.x1 - 5 * U, lay.y0 + 4 * U, 9 * U, sh.acColor)]);
      return (lt) => {
        if (k) fade(k.node, lt, 0, sh.exitAt);
        for (const r of rows) {
          revealLine(r.line, lt, r.t0 + 0.04, sh.exitAt);
          fade(r.idx, lt, r.t0, sh.exitAt, { y: 0 });
          r.rule.style.transform = `scaleX(${(inS(lt, r.t0 + 0.08, 16, 1) * (1 - outS(lt, sh.exitAt))).toFixed(4)})`;
        }
      };
    },

    number(sh, fg) {
      const raw = String(sh.value);
      const m = raw.match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/) || ['', '', raw, ''];
      const prefix = m[1], numStr = m[2], suffix = m[3];
      const target = Number(numStr.replace(/,/g, '')) || 0;
      const decimals = (numStr.split('.')[1] || '').length;
      const commas = numStr.includes(',');
      const from = Number(sh.from) || 0;
      const format = (v) => {
        let s = v.toFixed(decimals);
        if (commas) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return prefix + s + suffix;
      };
      const widest = format(target).replace(/\d/g, '8');
      const size = fitSize([widest], { maxW: lay.cw * 0.9, maxH: lay.ch * 0.42, maxSize: 34 * U, family: () => FAM.latin, weight: () => WT.latin, tracking: -0.01 });
      const y = lay.cy - size * 0.62;
      const num = el('div', abs(0, y, W, size * 1.1, {
        font: `${WT.latin} ${size}px/${size * 1.1}px ${FAM.latin}`, color: sh.fgColor, textAlign: 'center',
        fontFeatureSettings: '"tnum" 1', letterSpacing: '-0.01em', whiteSpace: 'nowrap'
      }), fg);
      const k = sh.kicker ? kicker(fg, sh.kicker, lay.cx, y - 5.5 * U, sh.acColor, 'center') : null;
      const cap = sh.caption ? maskLine(fg, sh.caption, {
        x: lay.cx, y: y + size * 1.1 + 2 * U, size: fitSize([sh.caption], { maxW: lay.cw * 0.8, maxSize: 6 * U }), color: sh.fgColor, align: 'center', width: lay.cw
      }) : null;
      const countDur = Math.max(BEAT, (sh.exitAt ?? sh.dur) * 0.62);
      sfx(sh.start + countDur, 'pop', 0.8);
      heroModes.push([sh.start, heroAt(lay.cx, y + size * 1.1 + (cap ? cap.h + 5.5 * U : 3 * U), 3.2 * U, sh.acColor, 'circle')]);
      return (lt) => {
        const u = ease.outExpo(clamp(lt / countDur));
        num.textContent = format(lerp(from, target, u));
        fade(num, lt, 0, sh.exitAt, { y: 1.5 * U });
        if (k) fade(k.node, lt, 0.05, sh.exitAt);
        if (cap) revealLine(cap, lt, 0.2, sh.exitAt);
      };
    },

    marquee(sh, fg) {
      const rows = PORTRAIT ? 4 : LANDSCAPE ? 2 : 3;
      const rowH = (H * 0.86) / rows;
      const size = rowH * 0.8;
      const unit = `${sh.text.trim()} · `;
      const unitW = emWidth(unit, famOf(unit), wOf(unit)) * size;
      const reps = Math.ceil((W * 2) / Math.max(1, unitW)) + 2;
      const speed = unitW / (4 * BEAT);
      const lines = Array.from({ length: rows }, (_, r) => {
        const node = el('div', abs(0, H * 0.07 + r * rowH + (rowH - size) / 2, unitW * reps, size, {
          font: `${wOf(unit)} ${size}px/${size}px ${famOf(unit)}`, whiteSpace: 'nowrap', letterSpacing: '-0.01em',
          color: r % 2 ? 'transparent' : sh.fgColor,
          webkitTextStroke: r % 2 ? `${Math.max(2, size * 0.022)}px ${sh.fgColor}` : '',
          opacity: r % 2 ? '0.9' : '1'
        }), fg, unit.repeat(reps));
        return { node, dir: r % 2 ? 1 : -1, off: (r * 0.37) % 1 };
      });
      let plate = null, capW = 0, capH = 0;
      if (sh.caption) {
        const cs = fitSize([sh.caption], { maxW: lay.cw * 0.6, maxSize: 9.5 * U });
        capW = emWidth(sh.caption, famOf(sh.caption), wOf(sh.caption)) * cs + 12 * U;
        capH = cs * 1.02 + 6 * U;
        plate = maskLine(fg, sh.caption, { x: lay.cx, y: lay.cy - cs * 0.51, size: cs, color: bestOn(sh.acColor), align: 'center', width: lay.cw });
        heroModes.push([sh.start, heroAt(lay.cx, lay.cy, 1, sh.acColor, 'pill', { w: capW, h: capH, r: capH / 2, rot: 0 })]);
      } else {
        heroModes.push([sh.start, heroOff(lay.cx, lay.cy, sh.acColor)]);
      }
      return (lt, t) => {
        // 밀려 들어오거나(푸시)·덮이며(와이프·아이리스·컷) 등장할 때는 처음부터 불투명해야 선명하다
        const fadeIn = ['morph', 'zoom'].includes(sh.transition) ? inS(lt, 0, 14, 1) : 1;
        const a = fadeIn * (1 - outS(lt, sh.exitAt));
        lines.forEach((l) => {
          const x = -mod(t * speed * (l.dir < 0 ? 1 : -1) + l.off * unitW, unitW) - unitW * 0.5;
          l.node.style.transform = `translateX(${x.toFixed(2)}px)`;
          l.node.style.opacity = String(a * (l.dir > 0 ? 0.9 : 1));
        });
        if (plate) revealLine(plate, lt, 0.14, sh.exitAt);
      };
    },

    split(sh, fg, bgInner) {
      const vertical = !PORTRAIT; // 좌우 분할(세로 화면은 위아래)
      const bColor = colorOf(sh.bg2, contrast(P.accent, sh.bgColor) > 1.5 ? P.accent : P.surface);
      const panel = el('div', vertical ? abs(W / 2, 0, W / 2, H) : abs(0, H / 2, W, H / 2), bgInner);
      panel.style.background = bColor;
      const aFg = sh.fgColor, bFg = bestOn(bColor);
      const half = vertical ? W / 2 - 2 * M : H / 2 - 2 * M;
      const words = [sh.a, sh.b];
      const size = fitSize(words, { maxW: vertical ? half - 8 * U : lay.cw * 0.86, maxH: vertical ? lay.ch * 0.4 : half * 0.8, maxSize: 20 * U });
      const pos = vertical
        ? [[W / 4, lay.cy - size * 0.51], [W * 0.75, lay.cy - size * 0.51]]
        : [[lay.cx, H / 4 - size * 0.51], [lay.cx, H * 0.75 - size * 0.51]];
      const la = maskLine(fg, sh.a, { x: pos[0][0], y: pos[0][1], size, color: aFg, align: 'center', width: vertical ? W / 2 : W });
      const lb = maskLine(fg, sh.b, { x: pos[1][0], y: pos[1][1], size, color: bFg, align: 'center', width: vertical ? W / 2 : W });
      heroModes.push([sh.start, heroAt(lay.cx, lay.cy, 8 * U, bestOn(sh.bgColor, P.ink), 'circle'), SP.SNAPPY]);
      sfx(sh.start + 0.18, 'swoosh', 0.55);
      return (lt) => {
        const p = inS(lt, 0.02, 15, 1);
        panel.style.transform = vertical ? `translateX(${((1 - p) * 100).toFixed(3)}%)` : `translateY(${((1 - p) * 100).toFixed(3)}%)`;
        revealLine(la, lt, 0.12, sh.exitAt);
        revealLine(lb, lt, 0.24, sh.exitAt);
      };
    },

    motif(sh, fg) {
      const labels = sh.labels.length ? sh.labels : [''];
      const shapes = sh.shapes.length ? sh.shapes : [S.motif, 'pill', 'square'];
      const per = Math.max(1, Math.floor(beatsIn(sh) / labels.length));
      const heroColor = sh.acColor;
      const onHero = bestOn(heroColor);
      const k = sh.kicker ? kicker(fg, sh.kicker, lay.cx, lay.y0 + 2 * U, sh.fgColor, 'center') : null;
      const nodes = labels.map((text, i) => {
        const shape = shapes[i % shapes.length];
        // 모양마다 안전 영역 안에 들어오는 크기(알약·막대는 가로로 길다)
        const unitBox = shapeBox(shape, 1);
        const base = Math.min((PORTRAIT ? 58 : 46) * U, (lay.cw * 0.96) / unitBox.w, (lay.ch * 0.7) / unitBox.h);
        const box = shapeBox(shape, base);
        const room = shape === 'diamond' ? box.w * 0.72 : box.w * 0.78;
        const size = text ? fitSize([text], { maxW: room, maxH: box.h * 0.46, maxSize: 14 * U }) : 0;
        heroModes.push([sh.start + i * per * BEAT, heroAt(lay.cx, lay.cy, base, heroColor, shape), i ? SP.SHAPE : undefined]);
        if (i) sfx(sh.start + i * per * BEAT, 'pop', 0.55);
        const node = text ? el('div', abs(0, lay.cy - size * 0.55, W, size * 1.1, {
          font: `${wOf(text)} ${size}px/${size * 1.1}px ${famOf(text)}`, color: onHero, textAlign: 'center', whiteSpace: 'nowrap', letterSpacing: '-0.02em'
        }), fg, text) : null;
        return { node, t0: i * per * BEAT, t1: (i + 1) * per * BEAT };
      });
      sfx(sh.start, 'swell', 0.6);
      return (lt) => {
        if (k) fade(k.node, lt, 0, sh.exitAt);
        nodes.forEach((n, i) => {
          if (!n.node) return;
          // 장면 로컬 시간으로만 판단한다(루프로 감지 않는다): 등장 전·장면 밖에서는 숨김
          const last = i === nodes.length - 1;
          const tIn = n.t0 + 0.08;
          const tOut = last ? (sh.exitAt ?? sh.dur + sh.tail) : n.t1 - 0.08;
          if (lt < tIn - 0.001) { n.node.style.opacity = '0'; return; }
          const p = clamp((lt - tIn) / 0.16), q = clamp((lt - tOut) / 0.08);
          n.node.style.opacity = (ease.outQuad(p) * (1 - ease.inQuad(q))).toFixed(3);
          const b = ((1 - ease.outCubic(p)) * 12 + ease.inQuad(q) * 8);
          n.node.style.filter = b > 0.05 ? `blur(${b.toFixed(2)}px)` : 'none';
          n.node.style.transform = `scale(${(0.94 + 0.06 * step(lt - tIn, 22, 0.9)).toFixed(4)})`;
        });
      };
    },

    pattern(sh, fg, bgInner) {
      const kind = sh.pattern;
      const col = colorOf(sh.patternColor, sh.acColor);
      const layer = el('div', abs(-W * 0.25, -H * 0.25, W * 1.5, H * 1.5), bgInner);
      const cell = 9 * U;
      const alpha = 0.95;
      if (kind === 'dots') layer.style.backgroundImage = `radial-gradient(${col} ${cell * 0.16}px, transparent ${cell * 0.17}px)`;
      else if (kind === 'checker') layer.style.backgroundImage = `conic-gradient(${col} 25%, transparent 0 50%, ${col} 0 75%, transparent 0)`;
      else if (kind === 'chevrons') layer.style.backgroundImage = `linear-gradient(135deg, ${col} 25%, transparent 25%), linear-gradient(225deg, ${col} 25%, transparent 25%)`;
      else layer.style.backgroundImage = `repeating-linear-gradient(-45deg, ${col} 0 ${cell * 0.5}px, transparent ${cell * 0.5}px ${cell}px)`;
      layer.style.backgroundSize = kind === 'stripes' || !kind ? 'auto' : `${cell}px ${cell}px`;
      layer.style.opacity = String(alpha);
      const text = sh.text;
      const size = fitSize([text], { maxW: lay.cw * 0.7, maxH: lay.ch * 0.32, maxSize: 22 * U });
      const tw = emWidth(text, famOf(text), wOf(text)) * size;
      const plateW = Math.min(lay.cw, tw + 12 * U), plateH = size * 1.02 + 9 * U;
      const line = maskLine(fg, text, { x: lay.cx, y: lay.cy - size * 0.51, size, color: sh.fgColor, align: 'center', width: lay.cw });
      heroModes.push([sh.start, heroAt(lay.cx, lay.cy, 1, sh.bgColor, 'square', { w: plateW, h: plateH, r: Math.min(plateH / 2, 3 * U), rot: 0 }), SP.SNAPPY]);
      return (lt, t) => {
        const drift = (t / (4 * BEAT)) * cell;
        layer.style.transform = `translate(${mod(drift, cell).toFixed(2)}px, ${mod(drift * 0.5, cell).toFixed(2)}px)`;
        layer.style.opacity = String(alpha * (0.75 + 0.25 * pulse(t) * ENERGY));
        revealLine(line, lt, 0.1, sh.exitAt);
      };
    },

    bars(sh, fg) {
      const vals = sh.values.map(Number);
      const n = vals.length;
      const maxV = Math.max(...vals, 1e-9);
      const top = lay.y0 + (sh.kicker ? 14 * U : 8 * U);
      const base = lay.y1 - 8 * U;
      const slot = lay.cw / n;
      const bw = slot * 0.56;
      const k = sh.kicker ? kicker(fg, sh.kicker, lay.x0, lay.y0 + 2 * U, sh.acColor) : null;
      const tag = sh.sample ? kicker(fg, 'SAMPLE DATA', lay.x1 - lay.cw, lay.y0 + 2 * U, sh.fgColor, 'left') : null;
      if (tag) { tag.node.style.textAlign = 'right'; tag.node.style.opacity = '0.6'; }
      const labelSize = fitSize(sh.labels.length ? sh.labels : ['0'], { maxW: slot * 0.92, maxSize: 3.2 * U, minSize: 2.2 * U, family: () => FAM.text, weight: () => WT.textBold, tracking: 0 });
      const baseline = el('div', abs(lay.x0, base, lay.cw, Math.max(2, 0.25 * U), { background: sh.fgColor, opacity: '0.35', transformOrigin: '0 50%' }), fg);
      const stepB = Math.max(1, Math.floor((beatsIn(sh) - 1) / n)) * BEAT / Math.max(1, Math.ceil(n / Math.max(1, beatsIn(sh) - 1)));
      let maxI = 0;
      vals.forEach((v, i) => { if (v > vals[maxI]) maxI = i; });
      const bars = vals.map((v, i) => {
        const x = lay.x0 + slot * i + (slot - bw) / 2;
        const hMax = (base - top - 7 * U) * (v / maxV);
        const bar = el('div', abs(x, base - hMax, bw, hMax, {
          background: i === maxI ? sh.acColor : sh.fgColor, opacity: i === maxI ? '1' : '0.85',
          transformOrigin: '50% 100%', borderRadius: `${Math.min(bw * 0.12, U)}px ${Math.min(bw * 0.12, U)}px 0 0`
        }), fg);
        const val = el('div', abs(x - slot * 0.2, base - hMax - 5.2 * U, bw + slot * 0.4, 4.4 * U, {
          font: `${WT.latin} ${3.6 * U}px/${4.4 * U}px ${FAM.latin}`, color: sh.fgColor, textAlign: 'center', fontFeatureSettings: '"tnum" 1'
        }), fg, sh.format ? String(sh.format).replace('{v}', v) : String(v));
        const lab = sh.labels[i] ? el('div', abs(lay.x0 + slot * i, base + 1.6 * U, slot, labelSize * 1.4, {
          font: `${WT.textBold} ${labelSize}px/${labelSize * 1.4}px ${FAM.text}`, color: sh.fgColor, textAlign: 'center', whiteSpace: 'nowrap', opacity: '0.8'
        }), fg, sh.labels[i]) : null;
        const t0 = 0.1 + i * stepB;
        sfx(sh.start + t0, 'tick', 0.85 + (v / maxV) * 0.4);
        return { bar, val, lab, t0, hMax, x };
      });
      heroModes.push([sh.start, heroAt(bars[maxI].x + bw / 2, base - bars[maxI].hMax - 9 * U, 3.4 * U, sh.acColor, 'circle')]);
      return (lt) => {
        if (k) fade(k.node, lt, 0, sh.exitAt);
        if (tag) fade(tag.node, lt, 0.1, sh.exitAt);
        baseline.style.transform = `scaleX(${(inS(lt, 0, 14, 1) * (1 - outS(lt, sh.exitAt))).toFixed(4)})`;
        for (const b of bars) {
          const g = inS(lt, b.t0, 16, 0.86) * (1 - outS(lt, sh.exitAt));
          b.bar.style.transform = `scaleY(${Math.max(0, g).toFixed(4)})`;
          fade(b.val, lt, b.t0 + 0.12, sh.exitAt, { y: 0.8 * U });
          if (b.lab) fade(b.lab, lt, b.t0, sh.exitAt, { y: 0 });
        }
      };
    },

    quote(sh, fg) {
      const lines = sh.lines;
      const size = fitSize(lines, { maxW: lay.cw * 0.9, maxH: lay.ch * 0.5, maxSize: 10 * U, lineH: 1.2, family: () => FAM.display, weight: () => WT.display });
      const lh = size * 1.2;
      const top = lay.cy - (lines.length * lh) / 2 - (sh.by ? 3 * U : 0);
      const hl = new Set(sh.highlight || []);
      const marks = [];
      const ls = lines.map((t, i) => {
        const line = maskLine(fg, t, { x: lay.x0, y: top + i * lh, size, color: sh.fgColor, lineH: 1.2, width: lay.cw, family: FAM.display, weight: WT.display });
        // 강조 단어 뒤에 형광펜 막대(글줄 안, 글자 아래)
        for (const word of hl) {
          const at = t.indexOf(word);
          if (at < 0) continue;
          const x = emWidth(t.slice(0, at), FAM.display, WT.display) * size;
          const w = emWidth(word, FAM.display, WT.display) * size;
          const mark = el('div', abs(x - 0.3 * U, lh * 0.52, w + 0.6 * U, lh * 0.36, { background: sh.acColor, opacity: '0.55', transformOrigin: '0 50%', zIndex: '-1' }), line.inner);
          line.inner.style.zIndex = '0';
          marks.push({ mark, t0: 0.5 + marks.length * BEAT });
        }
        return line;
      });
      const by = sh.by ? kicker(fg, sh.by, lay.x0, top + lines.length * lh + 3 * U, sh.acColor) : null;
      heroModes.push([sh.start, heroAt(lay.x0 - 2 * U, top - 9 * U, 7 * U, sh.acColor, 'circle')]);
      return (lt) => {
        ls.forEach((l, i) => revealLine(l, lt, 0.05 + i * 0.09, sh.exitAt));
        for (const m of marks) m.mark.style.transform = `scaleX(${(inS(lt, m.t0, 14, 1) * (1 - outS(lt, sh.exitAt))).toFixed(4)})`;
        if (by) fade(by.node, lt, 0.4, sh.exitAt);
      };
    },

    end(sh, fg) {
      const lines = sh.lines;
      const size = fitSize(lines, { maxW: lay.cw * 0.88, maxH: lay.ch * 0.4, maxSize: 17 * U, lineH: 1.04 });
      const lh = size * 1.04;
      const top = lay.cy - (lines.length * lh) / 2 + (sh.sub ? -3 * U : 0);
      const ls = lines.map((t, i) => maskLine(fg, t, { x: lay.cx, y: top + i * lh, size, color: sh.fgColor, align: 'center', width: lay.cw }));
      const sub = sh.sub ? bodyText(fg, sh.sub, lay.cx, top + lines.length * lh + 3 * U, lay.cw * 0.8, 3.4 * U, sh.fgColor, 'center') : null;
      const k = sh.kicker ? kicker(fg, sh.kicker, lay.cx, top - 6 * U, sh.acColor, 'center') : null;
      heroModes.push([sh.start, heroAt(lay.cx, top - (sh.kicker ? 12 * U : 8 * U), 5 * U, sh.acColor, 'circle')]);
      sfx(sh.start + 0.3, 'shimmer', 0.7);
      return (lt) => {
        if (k) fade(k.node, lt, 0.1, sh.exitAt);
        ls.forEach((l, i) => revealLine(l, lt, 0.08 + i * 0.08, sh.exitAt));
        if (sub) fade(sub, lt, 0.4, sh.exitAt);
      };
    }
  };

  /* ---------- 조립 ---------- */
  // 장면 하나 = [배경 → 히어로 도형 → 글자·그래픽]을 묶은 한 덩어리. 들어오는 장면이 나가는 장면을 통째로 덮으므로
  // 전환 중에도 나가는 글자가 들어오는 배경 위로 비치지 않는다. 히어로는 장면마다 사본이 같은 상태로 그려져 이어 보인다.
  let world, band, heroChains;
  const units = [];

  MK.define({
    build(stage) {
      stage.style.background = shots[0].bgColor;
      world = el('div', abs(0, 0, W, H, { overflow: 'hidden' }), stage);
      for (const sh of shots) {
        const outer = el('div', abs(0, 0, W, H, { display: 'none', overflow: 'hidden' }), world);
        const bgWrap = el('div', abs(0, 0, W, H), outer);
        const bgLayer = el('div', abs(0, 0, W, H, { background: sh.bgColor, overflow: 'hidden' }), bgWrap);
        const hero = el('div', { position: 'absolute', left: '0', top: '0' }, outer);
        const fgWrap = el('div', abs(0, 0, W, H), outer);
        const fgLayer = el('div', abs(0, 0, W, H), fgWrap);
        const build = BUILDERS[sh.type] || BUILDERS.title;
        const render = build(sh, fgLayer, bgLayer);
        const inKind = sh.transition;
        if (inKind === 'wipe' || inKind === 'push') sfx(sh.start - 0.02, 'swoosh', 0.55 + 0.2 * ENERGY);
        else if (inKind === 'iris') sfx(sh.start, 'swell', 0.6);
        else if (inKind === 'zoom') sfx(sh.start, 'swoosh', 0.45);
        units.push({ sh, outer, bgWrap, fgWrap, hero, render });
      }
      band = el('div', abs(0, 0, W, H, { pointerEvents: 'none', display: 'none', zIndex: '100000' }), world);
      // 히어로 체인(주기 T): 장면이 바뀔 때마다 모양·위치·색이 이어서 모핑한다.
      // 컷·아이리스로 바뀌는 순간에는 새 배경 위에 옛 모양이 오래 남지 않도록 빠른 스프링을 쓴다.
      for (const m of heroModes) {
        if (m[2]) continue;
        const at = shots.find((s) => Math.abs(s.start - m[0]) < 1e-6);
        if (at && (at.transition === 'iris' || at.transition === 'cut')) m[2] = SP.SNAPPY;
      }
      heroModes.sort((a, b) => mod(a[0], T) - mod(b[0], T));
      const pick = (f) => heroModes.map(([t, s, sp]) => [t, f(s), sp]);
      heroChains = {
        x: MK.chain(pick((s) => s.x), SP.SHAPE), y: MK.chain(pick((s) => s.y), SP.SHAPE),
        w: MK.chain(pick((s) => s.w), SP.SHAPE), h: MK.chain(pick((s) => s.h), SP.SHAPE),
        r: MK.chain(pick((s) => s.r), SP.SHAPE), rot: MK.chain(pick((s) => s.rot), SP.SHAPE),
        a: MK.chain(pick((s) => s.alpha), { w: 22, z: 1 }),
        c: MK.chainColor(heroModes.map(([t, s]) => [t, s.color]))
      };
      Object.assign(band.style, { background: P.accent });
    },

    render(t) {
      // 히어로 상태(한 번 계산해 활성 장면의 사본에 똑같이 적용)
      const hw = Math.max(0, heroChains.w.at(t)), hh = Math.max(0, heroChains.h.at(t));
      const ha = clamp(heroChains.a.at(t));
      const hs = 1 + 0.035 * ENERGY * pulse(t);
      const heroStyle = {
        width: `${hw}px`, height: `${hh}px`,
        borderRadius: `${Math.max(0, Math.min(heroChains.r.at(t), hw / 2, hh / 2))}px`,
        background: heroChains.c.at(t),
        opacity: ha.toFixed(3),
        display: ha < 0.01 || hw < 0.5 || hh < 0.5 ? 'none' : 'block',
        transform: `translate(${(heroChains.x.at(t) - hw / 2).toFixed(2)}px, ${(heroChains.y.at(t) - hh / 2).toFixed(2)}px) rotate(${heroChains.rot.at(t).toFixed(3)}deg) scale(${hs.toFixed(4)})`
      };

      let bandOn = false;
      for (const u of units) {
        const sh = u.sh;
        const lt = localT(t, sh);
        const active = lt >= -LEAD && lt <= sh.dur + sh.tail;
        // 비활성 장면은 display:none — 자식이 visibility:visible 이어도 새어 나오지 않는다.
        if (!active) { u.outer.style.display = 'none'; continue; }
        const z = String(Math.round(1000 - (lt + LEAD) * 10));
        const p = trIn(sh, lt);
        const clip = { clipPath: 'none', opacity: '1', transform: 'none', filter: 'none' };
        const inner = { scale: 1 + 0.018 * clamp(lt / sh.dur), dx: 0, blur: 0 };
        switch (sh.transition) {
          case 'cut':
            if (lt < 0) { clip.opacity = '0'; }
            inner.scale *= 1 + 0.05 * ENERGY * (1 - step(lt, 22, 0.85));
            break;
          case 'wipe': {
            const d = sh.wipeDir;
            const r = ((1 - p) * 100).toFixed(3);
            clip.clipPath = d === 'right' ? `inset(0 0 0 ${r}%)` : d === 'up' ? `inset(${r}% 0 0 0)` : d === 'down' ? `inset(0 0 ${r}% 0)` : `inset(0 ${r}% 0 0)`;
            if (p > 0.005 && p < 0.995) {
              bandOn = true;
              const edge = d === 'right' ? W * (1 - p) : d === 'up' ? H * (1 - p) : d === 'down' ? H * p : W * p;
              const bw = 2.2 * U;
              band.style.background = contrast(P.accent, sh.bgColor) > 1.4 ? P.accent : P.ink;
              band.style.clipPath = (d === 'left' || d === 'right')
                ? `inset(0 ${W - edge - (d === 'right' ? 0 : 0) - bw / 2}px 0 ${edge - bw / 2}px)`
                : `inset(${edge - bw / 2}px 0 ${H - edge - bw / 2}px 0)`;
            }
            break;
          }
          case 'iris': {
            const cx = heroChains.x.at(t), cy = heroChains.y.at(t);
            const rad = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * p;
            clip.clipPath = `circle(${rad.toFixed(2)}px at ${cx.toFixed(1)}px ${cy.toFixed(1)}px)`;
            break;
          }
          case 'push': inner.dx = (1 - p) * W; break;
          case 'zoom':
            clip.opacity = p.toFixed(3);
            inner.scale *= 1.12 - 0.12 * p;
            inner.blur = (1 - p) * 10;
            break;
          default: clip.opacity = p.toFixed(3);
        }
        // 다음 장면이 들어오는 동안의 나가는 효과
        const ltOut = lt - sh.dur;
        if (ltOut > -LEAD) {
          const q = trIn(sh.next, ltOut);
          if (sh.next.transition === 'push') inner.dx -= q * W * 0.35;
          if (sh.next.transition === 'zoom') { inner.scale *= 1 - 0.06 * q; clip.opacity = String(Number(clip.opacity) * (1 - q)); }
          if (sh.next.transition === 'cut' && ltOut >= 0) clip.opacity = '0';
        }
        const o = u.outer.style;
        o.display = clip.opacity === '0' ? 'none' : 'block';
        o.zIndex = z;
        o.clipPath = clip.clipPath;
        o.opacity = clip.opacity;
        const tf = `translateX(${inner.dx.toFixed(2)}px) scale(${inner.scale.toFixed(5)})`;
        for (const wrap of [u.bgWrap, u.fgWrap]) {
          wrap.style.transformOrigin = '50% 50%';
          wrap.style.transform = tf;
        }
        u.fgWrap.style.filter = inner.blur > 0.05 ? `blur(${inner.blur.toFixed(2)}px)` : 'none';
        Object.assign(u.hero.style, heroStyle);
        u.render(lt, t);
      }
      band.style.display = bandOn ? 'block' : 'none';
    }
  });
})();
