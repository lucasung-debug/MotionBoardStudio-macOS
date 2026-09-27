/* Original MotionBoard Studio renderer. Offline, time-driven, and dependency-free. */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MotionBoard = api;
})(typeof window === "undefined" ? null : window, function (host) {
  "use strict";

  const TAU = Math.PI * 2;
  const INK = "#262925";
  const PAPER = "#f3f0e9";
  const TILE = "#fcfaf5";
  const MUTED = "#696d64";
  const RULE = "#dcded4";
  const FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif';
  const EFFECTS = Object.freeze([
    "reveal", "morph", "orbit", "bars", "wave", "rings", "stagger", "counter",
    "spotlight", "marquee", "draw", "stack", "split", "bounce", "grid", "pulse"
  ]);
  let state = null;

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const mix = (a, b, t) => a + (b - a) * t;
  const cycle = (p) => ((p % 1) + 1) % 1;
  const breathe = (p) => (1 - Math.cos(TAU * p)) / 2;
  const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const characters = (value) => segmenter
    ? Array.from(segmenter.segment(value), (part) => part.segment) : Array.from(value);

  function fail(message) { throw new Error("MotionBoard: " + message); }
  function finite(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(label + " must be a finite number.");
    return value;
  }
  function text(value, fallback) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : fallback;
  }
  function boundedText(value, label, limit, required) {
    if (typeof value !== "string" || (required && !value.trim()) || characters(value).length > limit) {
      fail(label + (required ? " must contain 1 to " : " must contain at most ") + limit + " characters.");
    }
    return text(value, "");
  }
  function hashString(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
  function normalizeTime(seconds, duration) {
    finite(seconds, "Time");
    finite(duration, "Duration");
    if (duration <= 0) fail("Duration must be greater than zero.");
    const wrapped = ((seconds % duration) + duration) % duration;
    // Quantization avoids floating-point differences at t and t + duration.
    const rounded = Math.round(wrapped * 1e9) / 1e9;
    return rounded >= duration ? 0 : rounded;
  }

  function normalizeProject(project) {
    if (!project || typeof project !== "object" || Array.isArray(project)) fail("Open a valid motion board project.");
    if (project.schemaVersion !== 1) fail("This project version is not supported.");
    const title = boundedText(project.title, "The project title", 120, true);
    const duration = finite(project.duration, "Duration");
    if (duration < 2 || duration > 30) fail("Choose a duration from 2 to 30 seconds.");
    const fps = finite(project.fps, "Frame rate");
    if (![24, 30, 60].includes(fps)) fail("Choose a frame rate of 24, 30, or 60.");
    if (!["landscape", "portrait", "square"].includes(project.aspectRatio)) fail("Choose landscape, portrait, or square format.");
    if (!Array.isArray(project.tiles) || project.tiles.length < 1 || project.tiles.length > 16) fail("Add between 1 and 16 motion studies.");
    const ids = new Set();
    const tiles = project.tiles.map(function (tile, index) {
      if (!tile || typeof tile !== "object" || Array.isArray(tile)) fail("Study " + (index + 1) + " is invalid.");
      const id = typeof tile.id === "string" ? tile.id.toLowerCase() : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) fail("Each study needs a valid UUID identifier.");
      if (ids.has(id)) fail("Each study needs a unique identifier.");
      ids.add(id);
      if (!EFFECTS.includes(tile.effect)) fail("Study " + (index + 1) + " uses an unknown motion effect.");
      if (typeof tile.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(tile.accent)) fail("Study " + (index + 1) + " needs a six-digit hex color.");
      return Object.freeze({
        id: id,
        title: boundedText(tile.title, "Study " + (index + 1) + " title", 60, true),
        detail: boundedText(tile.detail, "Study " + (index + 1) + " detail", 500, false),
        effect: tile.effect,
        accent: tile.accent.toLowerCase(),
        seed: hashString(id)
      });
    });
    return Object.freeze({
      schemaVersion: 1,
      title: title,
      duration: duration, fps: fps, aspectRatio: project.aspectRatio,
      tiles: Object.freeze(tiles)
    });
  }

  function dimensions(width, height) {
    for (const value of [width, height]) {
      if (!Number.isInteger(value) || value < 64 || value > 8192) fail("Canvas dimensions must be whole numbers from 64 to 8192 pixels.");
    }
  }
  function gridLayout(count, width, height) {
    dimensions(width, height);
    if (!Number.isInteger(count) || count < 1 || count > 16) fail("Add between 1 and 16 motion studies.");
    const unit = Math.min(width, height);
    const margin = Math.max(2, unit * 0.045);
    const gap = Math.max(1, unit * 0.018);
    const header = Math.max(10, unit * 0.12);
    const usableW = width - margin * 2;
    const usableH = height - margin * 2 - header;
    let best = null;
    for (let cols = 1; cols <= Math.min(4, count); cols += 1) {
      const rows = Math.ceil(count / cols);
      const cellW = (usableW - gap * (cols - 1)) / cols;
      const cellH = (usableH - gap * (rows - 1)) / rows;
      const score = Math.abs(Math.log(Math.max(0.01, cellW / cellH) / 1.35)) + ((cols * rows - count) / count) * 0.9;
      if (!best || score < best.score) best = { cols: cols, rows: rows, cellW: cellW, cellH: cellH, score: score };
    }
    const cells = [];
    for (let i = 0; i < count; i += 1) {
      cells.push({
        x: margin + (i % best.cols) * (best.cellW + gap),
        y: margin + header + Math.floor(i / best.cols) * (best.cellH + gap),
        width: best.cellW, height: best.cellH
      });
    }
    return { margin: margin, gap: gap, header: header, columns: best.cols, rows: best.rows, cells: cells };
  }

  function font(ctx, size, weight) { ctx.font = (weight || 400) + " " + size + "px " + FONT; }
  function roundedPath(ctx, x, y, w, h, radius) {
    const r = clamp(radius, 0, Math.min(w, h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function box(ctx, x, y, w, h, radius, color) {
    roundedPath(ctx, x, y, w, h, radius);
    ctx.fillStyle = color;
    ctx.fill();
  }
  function circle(ctx, x, y, radius, color) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, radius), 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
  }
  function line(ctx, points, color, width) {
    ctx.beginPath();
    points.forEach(function (point, index) {
      if (index === 0) ctx.moveTo(point[0], point[1]);
      else ctx.lineTo(point[0], point[1]);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  function outlineCircle(ctx, x, y, radius, color, width) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, radius), 0, TAU);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  function fitSingleLine(ctx, value, maxWidth, baseSize, minSize, weight) {
    let size = baseSize;
    font(ctx, size, weight);
    const measured = ctx.measureText(value).width;
    if (measured > maxWidth) size = Math.max(minSize, size * maxWidth / measured);
    font(ctx, size, weight);
    const chars = characters(value), length = chars.length;
    while (chars.length && ctx.measureText(chars.join("") + (chars.length < length ? "…" : "")).width > maxWidth) chars.pop();
    return { text: chars.join("") + (chars.length < length ? "…" : ""), size: size };
  }
  function wrapText(ctx, value, maxWidth, maxLines) {
    if (!value || maxWidth <= 0 || maxLines < 1) return [];
    const closingPunctuation = /^[\p{Pe}\p{Pf}.,!?;:%…，。！？；：、]+$/u;
    let remaining = value.trim().replace(/\s+/g, " ")
      .replace(/\s+([\p{Pe}\p{Pf}.,!?;:%…，。！？；：、]+)/gu, "$1");
    const result = [];
    while (remaining && result.length < maxLines) {
      if (ctx.measureText(remaining).width <= maxWidth) {
        result.push(remaining);
        break;
      }
      const chars = characters(remaining);
      const lastLine = result.length === maxLines - 1;
      const suffix = lastLine ? "…" : "";
      let fit = 0;
      while (fit < chars.length && ctx.measureText(chars.slice(0, fit + 1).join("") + suffix).width <= maxWidth) fit += 1;
      if (!fit) {
        if (ctx.measureText("…").width <= maxWidth) result.push("…");
        break;
      }

      // Keep a word together when it fits a line; unspaced CJK and oversized
      // words can still break at complete graphemes. Closing marks stay with
      // the preceding grapheme instead of becoming their own line.
      const boundary = chars.slice(0, fit + 1).lastIndexOf(" ");
      let end = boundary > 0 ? boundary : fit;
      if (boundary <= 0) {
        while (end > 1 && closingPunctuation.test(chars[end] || "")) end -= 1;
      }
      const content = chars.slice(0, end).join("").trim();
      result.push(content + suffix);
      if (lastLine) break;
      remaining = chars.slice(end).join("").trim();
    }
    return result;
  }

  /* deslop-ignore: these geometric motion studies intentionally demonstrate each named effect. */
  const painters = {
    reveal: function (ctx, w, h, p, color) {
      const bw = Math.min(w * 0.56, h * 1.45), bh = h * 0.62;
      const x = (w - bw) / 2, y = (h - bh) / 2;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, bw, bh); ctx.clip();
      const shift = (1 - Math.sin(Math.PI * p)) * (bh + 2);
      box(ctx, x, y + shift, bw, bh, 3, color);
      line(ctx, [[x + bw * 0.18, y + shift + bh * 0.4], [x + bw * 0.78, y + shift + bh * 0.4]], TILE, Math.max(2, bh * 0.08));
      line(ctx, [[x + bw * 0.18, y + shift + bh * 0.62], [x + bw * 0.52, y + shift + bh * 0.62]], TILE, Math.max(2, bh * 0.08));
      ctx.restore();
      line(ctx, [[x, y + bh + 3], [x + bw, y + bh + 3]], RULE, 1);
    },
    morph: function (ctx, w, h, p, color) {
      const r = Math.min(w, h) * 0.34, t = breathe(p);
      ctx.translate(w / 2, h / 2); ctx.rotate(p * TAU);
      const sizeW = r * (1.4 + 0.5 * t), sizeH = r * (1.9 - 0.5 * t);
      box(ctx, -sizeW / 2, -sizeH / 2, sizeW, sizeH, r * (0.12 + t), color);
    },
    orbit: function (ctx, w, h, p, color) {
      const r = Math.min(w, h) * 0.33, cx = w / 2, cy = h / 2;
      outlineCircle(ctx, cx, cy, r, RULE, 1.2);
      circle(ctx, cx, cy, r * 0.12, INK);
      circle(ctx, cx + Math.cos(p * TAU) * r, cy + Math.sin(p * TAU) * r, r * 0.23, color);
      circle(ctx, cx + Math.cos(p * TAU + Math.PI) * r, cy + Math.sin(p * TAU + Math.PI) * r, r * 0.1, INK);
    },
    bars: function (ctx, w, h, p, color) {
      const groupW = Math.min(w * 0.74, h * 2.7), count = 7;
      const x0 = (w - groupW) / 2, step = groupW / count, floor = h * 0.84;
      for (let i = 0; i < count; i += 1) {
        const bh = h * (0.18 + 0.56 * breathe(p - i * 0.09));
        box(ctx, x0 + i * step + step * 0.13, floor - bh, step * 0.74, bh, 2, i === 3 ? INK : color);
      }
      line(ctx, [[x0, floor + 3], [x0 + groupW, floor + 3]], RULE, 1);
    },
    wave: function (ctx, w, h, p, color) {
      const left = w * 0.12, span = w * 0.76;
      for (let row = 0; row < 3; row += 1) {
        const points = [];
        for (let i = 0; i <= 64; i += 1) {
          const u = i / 64;
          points.push([left + u * span, h * (0.3 + row * 0.2) + Math.sin(u * TAU - p * TAU + row * 0.65) * h * 0.1]);
        }
        ctx.globalAlpha = row === 1 ? 1 : 0.4;
        line(ctx, points, row === 1 ? color : INK, Math.max(1.5, h * 0.025));
      }
      ctx.globalAlpha = 1;
    },
    rings: function (ctx, w, h, p, color) {
      const maxR = Math.min(w, h) * 0.43;
      for (let i = 0; i < 3; i += 1) {
        const t = cycle(p + i / 3);
        ctx.globalAlpha = Math.sin(Math.PI * t) * 0.85;
        outlineCircle(ctx, w / 2, h / 2, t * maxR, color, Math.max(1.4, h * 0.025));
      }
      ctx.globalAlpha = 1;
      circle(ctx, w / 2, h / 2, Math.max(2, maxR * 0.07), INK);
    },
    stagger: function (ctx, w, h, p, color) {
      const span = Math.min(w * 0.74, h * 2.9), step = span / 6, size = Math.min(step * 0.62, h * 0.26);
      for (let i = 0; i < 6; i += 1) {
        const t = breathe(p - i * 0.08);
        box(ctx, (w - span) / 2 + step * (i + 0.5) - size / 2, h * 0.65 - t * h * 0.35, size, size, 3, i === 0 ? INK : color);
      }
    },
    counter: function (ctx, w, h, p, color) {
      const number = String(Math.round(breathe(p) * 100)).padStart(2, "0");
      font(ctx, Math.min(h * 0.63, w * 0.28), 650);
      ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(number, w / 2, h * 0.45);
      const span = Math.min(w * 0.5, h * 1.2);
      box(ctx, (w - span) / 2, h * 0.83, span, Math.max(2, h * 0.025), 1, RULE);
      box(ctx, (w - span) / 2, h * 0.83, span * breathe(p), Math.max(2, h * 0.025), 1, color);
    },
    spotlight: function (ctx, w, h, p, color) {
      font(ctx, Math.min(h * 0.58, w * 0.2), 750);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.strokeStyle = RULE; ctx.lineWidth = 1.2;
      ctx.strokeText("MOVE", w / 2, h / 2);
      const cx = w / 2 + Math.sin(p * TAU) * w * 0.25, radius = Math.min(w * 0.19, h * 0.4);
      ctx.save(); ctx.beginPath(); ctx.arc(cx, h / 2, radius, 0, TAU); ctx.clip();
      ctx.fillStyle = color; ctx.fillText("MOVE", w / 2, h / 2); ctx.restore();
      outlineCircle(ctx, cx, h / 2, radius, color, 1);
    },
    marquee: function (ctx, w, h, p, color) {
      const size = Math.min(h * 0.49, w * 0.21);
      font(ctx, size, 700); ctx.textAlign = "left"; ctx.textBaseline = "middle";
      const label = "MOTION / ", period = ctx.measureText(label).width;
      ctx.fillStyle = INK;
      for (let x = -period * p - period; x < w + period; x += period) ctx.fillText(label, x, h * 0.49);
      line(ctx, [[w * 0.12, h * 0.83], [w * 0.88, h * 0.83]], color, Math.max(2, h * 0.04));
    },
    draw: function (ctx, w, h, p, color) {
      const points = [];
      for (let i = 0; i <= 80; i += 1) {
        const u = i / 80;
        points.push([w * (0.15 + 0.7 * u), h * (0.5 + Math.sin(u * TAU) * 0.29)]);
      }
      line(ctx, points, RULE, Math.max(1, h * 0.016));
      const end = breathe(p) * 80, whole = Math.floor(end), partial = points.slice(0, whole + 1);
      if (whole < 80) partial.push([mix(points[whole][0], points[whole + 1][0], end - whole), mix(points[whole][1], points[whole + 1][1], end - whole)]);
      line(ctx, partial, color, Math.max(2, h * 0.045));
      const head = partial[partial.length - 1];
      circle(ctx, head[0], head[1], Math.max(3, h * 0.047), INK);
    },
    stack: function (ctx, w, h, p, color) {
      const cardW = Math.min(w * 0.36, h * 0.86), cardH = h * 0.65, spread = breathe(p);
      for (let i = -1; i <= 1; i += 1) {
        ctx.save();
        ctx.translate(w / 2 + i * cardW * (0.08 + spread * 0.4), h / 2 + Math.abs(i) * h * 0.04);
        ctx.rotate(i * (0.06 + 0.18 * spread));
        box(ctx, -cardW / 2, -cardH / 2, cardW, cardH, 4, TILE);
        roundedPath(ctx, -cardW / 2, -cardH / 2, cardW, cardH, 4);
        ctx.strokeStyle = i === 0 ? INK : RULE; ctx.lineWidth = 1.5; ctx.stroke();
        box(ctx, -cardW * 0.3, -cardH * 0.3, cardW * 0.6, cardH * 0.36, 2, color);
        line(ctx, [[-cardW * 0.3, cardH * 0.22], [cardW * 0.14, cardH * 0.22]], INK, 1.5);
        ctx.restore();
      }
    },
    split: function (ctx, w, h, p, color) {
      const radius = Math.min(w * 0.23, h * 0.34), separation = breathe(p) * radius * 0.6;
      for (let side = -1; side <= 1; side += 2) {
        ctx.save(); ctx.translate(w / 2 + side * separation, h / 2);
        ctx.beginPath(); ctx.rect(side < 0 ? -radius : 0, -radius - 1, radius, radius * 2 + 2); ctx.clip();
        circle(ctx, 0, 0, radius, side < 0 ? INK : color); ctx.restore();
      }
    },
    bounce: function (ctx, w, h, p, color) {
      const radius = Math.min(w * 0.12, h * 0.15), floor = h * 0.87;
      const lift = Math.sin(Math.PI * p), squash = Math.pow(Math.abs(Math.cos(Math.PI * p)), 18);
      line(ctx, [[w * 0.25, floor], [w * 0.75, floor]], RULE, 1.2);
      ctx.translate(w / 2, floor - radius - lift * h * 0.49 + squash * radius * 0.24);
      ctx.scale(1 + squash * 0.24, 1 - squash * 0.24);
      circle(ctx, 0, 0, radius, color);
    },
    grid: function (ctx, w, h, p, color) {
      const spacing = Math.min(w * 0.135, h * 0.25), size = spacing * 0.54;
      for (let row = -1; row <= 1; row += 1) {
        for (let col = -2; col <= 2; col += 1) {
          const t = breathe(p - (Math.abs(col) + Math.abs(row)) * 0.08), scale = 0.35 + t * 0.65;
          ctx.save(); ctx.translate(w / 2 + col * spacing, h / 2 + row * spacing); ctx.rotate(t * Math.PI / 2);
          box(ctx, -size * scale / 2, -size * scale / 2, size * scale, size * scale, 1, row === 0 && col === 0 ? INK : color);
          ctx.restore();
        }
      }
    },
    pulse: function (ctx, w, h, p, color) {
      const radius = Math.min(w, h) * 0.35, scale = 0.58 + 0.42 * breathe(p), thickness = radius * 0.39;
      ctx.translate(w / 2, h / 2); ctx.scale(scale, scale);
      box(ctx, -radius, -thickness / 2, radius * 2, thickness, 2, color);
      box(ctx, -thickness / 2, -radius, thickness, radius * 2, 2, color);
    }
  };

  function drawTile(ctx, tile, cell, phase) {
    const x = cell.x, y = cell.y, w = cell.width, h = cell.height;
    const padding = clamp(Math.min(w, h) * 0.1, 10, 24);
    const titleSize = clamp(Math.min(w * 0.075, h * 0.13), 11, 23);
    const detailSize = clamp(titleSize * 0.77, 9, 15);
    const textW = Math.max(1, w - padding * 2);
    font(ctx, titleSize, 650);
    const title = fitSingleLine(ctx, tile.title, textW, titleSize, Math.min(11, titleSize), 650);
    font(ctx, detailSize, 400);
    const details = wrapText(ctx, tile.detail, textW, 2);
    const labelH = title.size * 1.2 + (details.length ? 5 + details.length * detailSize * 1.35 : 0);
    const visualTop = padding * 0.7;
    const visualH = Math.max(4, h - padding * 2 - labelH - 9);
    box(ctx, x, y, w, h, 4, TILE);
    ctx.save();
    ctx.translate(x + padding, y + visualTop);
    ctx.beginPath(); ctx.rect(0, 0, textW, visualH); ctx.clip();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // Stable per-study offsets give a board rhythm without render-time randomness.
    const localPhase = cycle(phase + (tile.seed % 1000) / 1000);
    painters[tile.effect](ctx, textW, visualH, localPhase, tile.accent);
    ctx.restore();
    ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = INK;
    font(ctx, title.size, 650);
    const labelY = y + h - padding - labelH;
    ctx.fillText(title.text, x + padding, labelY);
    font(ctx, detailSize, 400); ctx.fillStyle = MUTED;
    details.forEach(function (value, index) {
      ctx.fillText(value, x + padding, labelY + title.size * 1.2 + 5 + index * detailSize * 1.35);
    });
  }

  function drawBoard(ctx, project, width, height, seconds) {
    const time = normalizeTime(seconds, project.duration);
    // Small exports use the same readable composition before scaling to exact pixels.
    const scale = Math.min(1, Math.max(Math.min(width, height) / 480, Math.max(width, height) / 8192));
    const contentWidth = Math.round(width / scale), contentHeight = Math.round(height / scale);
    const layout = gridLayout(project.tiles.length, contentWidth, contentHeight);
    ctx.save();
    ctx.setTransform(width / contentWidth, 0, 0, height / contentHeight, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, contentWidth, contentHeight);
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, contentWidth, contentHeight);
    const titleSize = clamp(Math.min(contentWidth, contentHeight) * 0.043, 20, 46);
    const title = fitSingleLine(ctx, project.title, contentWidth - layout.margin * 2, titleSize, 14, 650);
    ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = INK;
    ctx.fillText(title.text, layout.margin, layout.margin);
    font(ctx, clamp(titleSize * 0.34, 10, 15), 400); ctx.fillStyle = MUTED;
    ctx.fillText(project.tiles.length + " motion studies · " + project.duration + "s loop", layout.margin, layout.margin + title.size * 1.35);
    project.tiles.forEach(function (tile, index) { drawTile(ctx, tile, layout.cells[index], time / project.duration); });
    ctx.restore();
    return { width: width, height: height, time: time };
  }

  function configure(project, width, height) {
    const normalized = normalizeProject(project);
    dimensions(width, height);
    if (!host || !host.document) fail("A browser canvas is required to render this board.");
    let canvas = host.document.getElementById("board");
    if (!canvas) {
      canvas = host.document.createElement("canvas");
      canvas.id = "board";
      (host.document.querySelector("[data-board-host]") || host.document.body).appendChild(canvas);
    }
    if (typeof canvas.getContext !== "function") fail("The board element must be a canvas.");
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) fail("Canvas rendering is unavailable on this device.");
    canvas.width = width; canvas.height = height;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", normalized.title + ". " + normalized.tiles.map(function (tile) { return tile.title + (tile.detail ? ": " + tile.detail : ""); }).join(". "));
    state = { project: normalized, canvas: canvas, ctx: ctx, width: width, height: height };
    return seek(0);
  }
  function seek(seconds) {
    if (!state) fail("Open or create a board before previewing it.");
    return drawBoard(state.ctx, state.project, state.width, state.height, seconds);
  }
  function png(seconds) {
    seek(seconds);
    return state.canvas.toDataURL("image/png");
  }
  return Object.freeze({
    ready: true, configure: configure, seek: seek, png: png,
    helpers: Object.freeze({ normalizeProject: normalizeProject, normalizeTime: normalizeTime, gridLayout: gridLayout, hashString: hashString, wrapText: wrapText, effects: EFFECTS })
  });
});
