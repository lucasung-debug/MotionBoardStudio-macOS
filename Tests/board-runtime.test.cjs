"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const board = require("../Sources/MotionBoardStudio/Resources/board.js");
const { normalizeTime, normalizeProject, gridLayout, wrapText, effects } = board.helpers;

function project(count = 16) {
  return {
    schemaVersion: 1,
    title: "움직임 연습",
    duration: 8,
    fps: 30,
    aspectRatio: "landscape",
    tiles: Array.from({ length: count }, (_, i) => ({
      id: "00000000-0000-0000-0000-" + String(i + 1).padStart(12, "0"),
      title: "한글 모션 " + (i + 1),
      detail: "시간을 기준으로 그리는 움직임",
      effect: effects[i % effects.length],
      accent: "#557A60"
    }))
  };
}

test("the renderer exports the agreed 16 effects and loads without a DOM", () => {
  assert.deepEqual(effects, ["reveal", "morph", "orbit", "bars", "wave", "rings", "stagger", "counter", "spotlight", "marquee", "draw", "stack", "split", "bounce", "grid", "pulse"]);
  assert.equal(board.ready, true);
  assert.throws(() => board.seek(0), /Open or create a board/);
});

test("cycle normalization agrees at the seam and for positive and negative seeks", () => {
  for (const duration of [1, 8, 9.5, 120]) {
    for (const time of [-18.13, -0.1, 0, 0.1, 1.13, 5.75, 119.99999]) {
      assert.equal(normalizeTime(time, duration), normalizeTime(time + duration, duration));
      assert.equal(normalizeTime(time, duration), normalizeTime(time - duration, duration));
    }
    assert.equal(normalizeTime(0, duration), normalizeTime(duration, duration));
  }
  assert.throws(() => normalizeTime(NaN, 8), /finite number/);
  assert.throws(() => normalizeTime(0, 0), /greater than zero/);
});

test("project input is copied, normalized, frozen, and never interpreted as markup", () => {
  const input = project(1);
  input.title = "  <script>literal text</script>  ";
  const result = normalizeProject(input);
  assert.equal(result.title, "<script>literal text</script>");
  assert.equal(result.tiles[0].accent, "#557a60");
  input.tiles[0].title = "changed later";
  assert.equal(result.tiles[0].title, "한글 모션 1");
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.tiles) && Object.isFrozen(result.tiles[0]));
});

test("invalid documents report useful errors before renderer use", () => {
  assert.throws(() => normalizeProject(null), /valid motion board/);
  assert.throws(() => normalizeProject({ ...project(), schemaVersion: 2 }), /version/);
  assert.throws(() => normalizeProject({ ...project(), tiles: [] }), /between 1 and 16/);
  assert.throws(() => normalizeProject({ ...project(), duration: Infinity }), /finite/);
  const duplicate = project(2);
  duplicate.tiles[1].id = duplicate.tiles[0].id;
  assert.throws(() => normalizeProject(duplicate), /unique identifier/);
  const unknown = project(1);
  unknown.tiles[0].effect = "missing";
  assert.throws(() => normalizeProject(unknown), /unknown motion effect/);
  const badColor = project(1);
  badColor.tiles[0].accent = "url(https://example.invalid)";
  assert.throws(() => normalizeProject(badColor), /six-digit hex color/);
});

test("runtime documents follow the Swift project limits, including Unicode titles", () => {
  for (const duration of [2, 30]) {
    for (const fps of [24, 30, 60]) {
      assert.equal(normalizeProject({ ...project(1), duration, fps }).fps, fps);
    }
  }
  assert.throws(() => normalizeProject({ ...project(1), duration: 1 }), /2 to 30/);
  assert.throws(() => normalizeProject({ ...project(1), duration: 31 }), /2 to 30/);
  assert.throws(() => normalizeProject({ ...project(1), fps: 25 }), /24, 30, or 60/);
  assert.throws(() => normalizeProject({ ...project(1), title: "  " }), /1 to 120/);
  assert.throws(() => normalizeProject({ ...project(1), title: "가".repeat(121) }), /1 to 120/);
  const input = project(1);
  input.title = "👨‍👩‍👧‍👦".repeat(120);
  input.tiles[0].title = "가".repeat(60);
  input.tiles[0].detail = "나".repeat(500);
  assert.equal(normalizeProject(input).title, input.title);
  input.tiles[0].detail += "다";
  assert.throws(() => normalizeProject(input), /at most 500/);
  input.tiles[0].detail = "";
  input.tiles[0].title += "다";
  assert.throws(() => normalizeProject(input), /1 to 60/);
  input.tiles[0].title = "제목";
  input.tiles[0].id = "not-a-uuid";
  assert.throws(() => normalizeProject(input), /valid UUID/);
});

test("all supported board sizes and tile counts fit within the canvas with separate cells", () => {
  for (const [width, height] of [[1280, 720], [720, 1280], [1080, 1080]]) {
    for (let count = 1; count <= 16; count += 1) {
      const layout = gridLayout(count, width, height);
      assert.equal(layout.cells.length, count);
      layout.cells.forEach((cell, index) => {
        assert.ok(cell.width > 100 && cell.height > 90);
        assert.ok(cell.x >= layout.margin && cell.y >= layout.margin + layout.header);
        assert.ok(cell.x + cell.width <= width - layout.margin + 1e-8);
        assert.ok(cell.y + cell.height <= height - layout.margin + 1e-8);
        for (const other of layout.cells.slice(index + 1)) {
          assert.ok(cell.x + cell.width < other.x || other.x + other.width < cell.x || cell.y + cell.height < other.y || other.y + other.height < cell.y);
        }
      });
    }
  }
});

test("English captions wrap at words and keep ending punctuation with its word", () => {
  const ctx = { measureText: value => ({ width: Array.from(value).length }) };
  assert.deepEqual(wrapText(ctx, "Concentric outlines expand from the center.", 24, 2), ["Concentric outlines", "expand from the center."]);
  assert.deepEqual(wrapText(ctx, "Offset cards settle into a layered arrangement.", 26, 2), ["Offset cards settle into a", "layered arrangement."]);
  assert.deepEqual(wrapText(ctx, "Offset cards settle into a layered arrangement.", 18, 2), ["Offset cards", "settle into a…"]);
  const lines = wrapText(ctx, "  rings   expand  .  ", 6, 3);
  assert.ok(lines.every(value => value === value.trim() && value.length <= 6 && !/^[.,!?]+$/.test(value)));
});

test("unspaced captions fall back to whole graphemes without a punctuation-only line", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const ctx = { measureText: value => ({ width: Array.from(segmenter.segment(value)).length }) };
  assert.deepEqual(wrapText(ctx, "가나다라.", 4, 2), ["가나다", "라."]);
  assert.deepEqual(wrapText(ctx, "👨‍👩‍👧‍👦🇰🇷", 1, 2), ["👨‍👩‍👧‍👦", "🇰🇷"]);
  assert.deepEqual(wrapText(ctx, "가나다라마바사", 4, 2), ["가나다라", "마바사"]);
  assert.deepEqual(wrapText(ctx, "가나다라마바사아자", 4, 2), ["가나다라", "마바사…"]);
});
