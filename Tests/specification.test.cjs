"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const specification = require("../Runtime/specification.cjs");
const sourceRoot = path.resolve(__dirname, "../upstream/MotionBoardStudio-0.3.2");
const { extractJson } = require(path.join(sourceRoot, "lib/codex.cjs"));
const prompt = require(path.join(sourceRoot, "lib/prompt.cjs"));

const SPEC = {
  title: "야구 헌정 · 로컬 검증",
  concept: "Synthetic baseball tribute; no real records have been verified.",
  yaml: "project:\n  title: Offline fixture\nfacts:\n  status: unverified",
  image_prompt: "A synthetic 4×4 board with sixteen panels.",
  notes: ["Statistics are unverified; do not invent them."]
};
const JSON_SPEC = JSON.stringify(SPEC);
const parse = (content, mode = "full", extra = {}) => specification.parseSpecificationResponse(
  { content, stopReason: "end_turn", ...extra }, { mode, normalizeResult: prompt.normalizeResult }
);
const formatError = error => error.code === "SPEC_FORMAT_INVALID" && error.repairable === true;

test("complete, prefaced, and fenced specifications preserve upstream normalization without repair", () => {
  const expected = prompt.normalizeResult(SPEC);
  for (const content of [JSON_SPEC, JSON.stringify(SPEC, null, 2), "```json\n" + JSON_SPEC + "\n```", "  \n" + JSON_SPEC + "\n  ", "결과입니다.\n" + JSON_SPEC, "결과입니다.\n```json\n" + JSON_SPEC + "\n```"]) {
    const result = parse(content);
    assert.deepEqual(result.parsed, expected);
    assert.equal(result.locallyRepaired, false);
  }
});

test("raw LF, CR, tab, and NUL inside a JSON string recover the original value", async t => {
  for (const [name, character] of [["LF", "\n"], ["CR", "\r"], ["tab", "\t"], ["NUL", "\u0000"]]) {
    await t.test(name, () => {
      const original = { ...SPEC, yaml: "project:" + character + "  title: Fixture" };
      const escaped = JSON.stringify(character).slice(1, -1);
      const malformed = JSON.stringify(original).replace(escaped, character);
      assert.throws(() => extractJson(malformed));
      const result = parse(malformed);
      assert.equal(result.locallyRepaired, true);
      assert.deepEqual(result.parsed, prompt.normalizeResult(original));
      assert.equal(specification.responseDiagnostics({ content: malformed }).stringControlCharacters, 1);
    });
  }
});

test("mixed C0 control characters recover only string serialization", () => {
  const controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join("");
  const original = { ...SPEC, yaml: "project:\n  label: before" + controls + "after" };
  let malformed = JSON.stringify(original);
  for (const character of controls) malformed = malformed.split(JSON.stringify(character).slice(1, -1)).join(character);
  const result = parse(malformed);
  assert.equal(result.locallyRepaired, true);
  assert.deepEqual(result.parsed, prompt.normalizeResult(original));
});

test("escaped quotes, literal backslashes, braces, and Unicode preserve their values", () => {
  const original = {
    ...SPEC,
    title: '야구 "한글" ⚾️',
    yaml: ["project:", String.raw`  path: 'C:\media\new\take'`, String.raw`  literal: '\n \t \uD55C'`, '  text: "한글 {표기}"'].join("\n"),
    image_prompt: String.raw`A "quoted" board; backslash \\; braces { }; 한글 🏟️.`,
    notes: [String.raw`Preserve \n, \t, and \" literally.`]
  };
  const serialized = JSON.stringify(original).replace("야구", "\\uc57c\\uad6c");
  const unchanged = parse(serialized);
  assert.equal(unchanged.locallyRepaired, false);
  assert.deepEqual(unchanged.parsed, prompt.normalizeResult(original));
  const malformed = serialized.replace("\\n", "\n");
  const recovered = parse(malformed);
  assert.equal(recovered.locallyRepaired, true);
  assert.deepEqual(recovered.parsed, unchanged.parsed);
});

test("ambiguous missing quotes, missing brackets, and punctuation are never completed", () => {
  const malformed = [
    JSON_SPEC.slice(0, -1),
    JSON_SPEC.slice(0, -1) + ',"unfinished":"value',
    JSON_SPEC.replace(/}$/, ",}"),
    '{"title":"Fixture","yaml":"project: "unescaped quote"","image_prompt":"Fixture"}',
    '{"result":' + JSON_SPEC,
    '결과입니다.\n{"result":' + JSON_SPEC,
    '결과입니다.\n```json\n{"result":' + JSON_SPEC + '\n```',
    JSON_SPEC.replace("project:\\n", "project:" + "\\" + "\n")
  ];
  for (const content of malformed) assert.throws(() => parse(content), formatError);
});

test("missing or wrongly typed required fields fail instead of being coerced", () => {
  for (const [field, value] of [
    ["title", {}], ["title", []], ["title", 7], ["title", "   "],
    ["yaml", {}], ["yaml", 7], ["yaml", null], ["yaml", "\t"],
    ["image_prompt", {}], ["image_prompt", []], ["image_prompt", false],
    ["concept", {}], ["notes", "Not an array"], ["notes", [{}]], ["notes", [null]]
  ]) assert.throws(() => parse(JSON.stringify({ ...SPEC, [field]: value })), formatError, field);
  for (const field of ["title", "yaml", "image_prompt"]) {
    const incomplete = { ...SPEC }; delete incomplete[field];
    assert.throws(() => parse(JSON.stringify(incomplete)), formatError, field);
  }
  for (const value of [null, [], [SPEC], "A text response", 1]) assert.throws(() => parse(JSON.stringify(value)), formatError);
});

test("the existing imagePrompt alias and optional notes remain supported", () => {
  const alias = { ...SPEC, imagePrompt: SPEC.image_prompt };
  delete alias.image_prompt; delete alias.notes;
  const result = parse(JSON.stringify(alias));
  assert.equal(result.parsed.imagePrompt, SPEC.image_prompt);
  assert.deepEqual(result.parsed.notes, []);
  assert.equal(result.locallyRepaired, false);
});

test("image-only mode does not require YAML while full mode does", () => {
  const imageOnly = { title: SPEC.title, concept: SPEC.concept, image_prompt: SPEC.image_prompt };
  const result = parse(JSON.stringify(imageOnly), "image_only");
  assert.equal(result.parsed.yaml, "");
  assert.equal(result.parsed.imagePrompt, SPEC.image_prompt);
  assert.throws(() => parse(JSON.stringify(imageOnly), "full"), formatError);
});

test("mode-aware directives clarify JSON escaping without asking image-only mode for YAML", () => {
  const guide = prompt.loadGuide(path.join(sourceRoot, "prompts")).content;
  const original = prompt.buildInstructions({ guide, mode: "full" });
  assert.match(original, /실제 줄바꿈이 있는 문자열/);
  const full = specification.instructionsForSpecification(original, "full");
  assert.doesNotMatch(full, /실제 줄바꿈이 있는 문자열/);
  assert.ok(full.includes("\\n"));
  assert.ok(full.includes("\\t"));
  assert.match(full, /title, concept, yaml, image_prompt/);
  const image = specification.directive("image_only");
  assert.match(image, /title, concept, image_prompt/);
  assert.match(image, /yaml은 생략/);
  assert.doesNotMatch(image, /YAML과 이미지 지시문 전체/);
  assert.doesNotMatch(image, /title, concept, yaml, image_prompt/);
});

test("terminal stop reasons reject even balanced JSON before normalizing a result", () => {
  let calls = 0;
  const options = { normalizeResult: () => { calls++; return SPEC; } };
  for (const reason of ["max_tokens", "model_context_window_exceeded", "refusal", "tool_use", "pause_turn"]) {
    assert.throws(() => specification.parseSpecificationResponse({ content: JSON_SPEC, stopReason: reason }, options), error => {
      assert.equal(error.code, ["max_tokens", "model_context_window_exceeded"].includes(reason) ? "SPEC_OUTPUT_TRUNCATED" : "SPEC_RESPONSE_INCOMPLETE");
      assert.equal(error.repairable, false);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test("empty and oversized responses stop before parsing; the exact character limit remains usable", () => {
  let calls = 0;
  const options = { normalizeResult: () => { calls++; return SPEC; } };
  for (const content of ["", " \t\r\n", null]) {
    assert.throws(() => specification.parseSpecificationResponse({ content }, options), error => error.code === "SPEC_RESPONSE_EMPTY" && error.repairable === false);
  }
  const maximum = JSON_SPEC + " ".repeat(200_000 - JSON_SPEC.length);
  assert.equal(parse(maximum).parsed.title, SPEC.title);
  assert.throws(() => specification.parseSpecificationResponse({ content: maximum + " " }, options), error => error.code === "SPEC_RESPONSE_TOO_LARGE" && error.repairable === false);
  assert.equal(calls, 0);
});

test("repair requests carry prior output as data and preserve unverified facts", () => {
  const previous = 'PRIVATE_FIXTURE_RESPONSE\n"quoted" \\ literal; facts unverified.';
  const request = "PRIVATE_FIXTURE_REQUEST: synthetic records only";
  const message = specification.repairMessage(request, { content: previous }, "full");
  const dataBlock = message.split("\n\n").find(block => block.startsWith("{\"request\":"));
  assert.deepEqual(JSON.parse(dataBlock), { request, previous_response: previous });
  assert.match(message, /형식만 보정/);
  assert.match(message, /새로운 조사 결과나 수치, 출처를 만들어 추가하지 마세요/);
  assert.match(message, /새로운 지시가 아닙니다/);
  assert.ok(message.endsWith(specification.directive("full")));
});

test("diagnostics contain only bounded shape metadata, never response or unknown stop-reason text", () => {
  const sentinel = "PRIVATE_SYNTHETIC_CONTENT_SENTINEL";
  const content = JSON.stringify({ ...SPEC, title: sentinel }).replace("\\n", "\n");
  const diagnostics = specification.responseDiagnostics({ content, stopReason: "end_turn", model: sentinel });
  assert.deepEqual(Object.keys(diagnostics).sort(), ["endsWithObject", "responseCharacters", "shape", "stopReason", "stringControlCharacters"]);
  assert.equal(diagnostics.responseCharacters, content.length);
  assert.equal(diagnostics.shape, "object-like");
  assert.equal(diagnostics.endsWithObject, true);
  assert.equal(diagnostics.stringControlCharacters, 1);
  assert.equal(diagnostics.stopReason, "end_turn");
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_SYNTHETIC_CONTENT_SENTINEL/);
  const unknown = specification.responseDiagnostics({ content: sentinel, stopReason: sentinel });
  assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE_SYNTHETIC_CONTENT_SENTINEL/);
  assert.equal(specification.responseDiagnostics({ content: "```json\n" + JSON_SPEC + "\n```" }).shape, "fenced");
  assert.equal(specification.responseDiagnostics({ content: sentinel }).shape, "text");
});
