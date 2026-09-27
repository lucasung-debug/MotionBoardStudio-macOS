"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cliEnvironment, runCLI } = require("../Runtime/video-cli.cjs");

test("video CLI environment never inherits API keys or agent overrides", () => {
  const fields = { XAI_API_KEY: "synthetic-secret", GROK_CONFIG: "unsafe-config", GROK_LOG_FILE: "private-log", NODE_OPTIONS: "--inspect", KLING_TOKEN: "synthetic-token" };
  const previous = Object.fromEntries(Object.keys(fields).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, fields);
    const environment = cliEnvironment(process.execPath, { GROK_HOME: "/tmp/app-owned-profile", GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER: "1" });
    for (const key of Object.keys(fields)) assert.equal(environment[key], undefined);
    assert.equal(environment.GROK_DISABLE_API_KEY_AUTH, "1");
    assert.equal(environment.GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER, "0");
    assert.equal(environment.GROK_HOME, "/tmp/app-owned-profile");
    assert.equal(environment.HOME, process.env.HOME);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("video CLI arguments remain literal and preserve spaces without a shell", async () => {
  const input = 'scene $(printf unsafe) `printf unsafe` "quoted" 한 장';
  const result = await runCLI(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", input]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), [input]);
});

test("cancellation before spawn and missing executables prove no submission began", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runCLI(process.execPath, [], { signal: controller.signal }), error => error.code === "CANCELLED" && error.started === false);
  await assert.rejects(runCLI("/does-not-exist/motionboard-synthetic-cli", []), error => error.code === "CLI_START_FAILED" && error.started === false);
});

test("timeout after a CLI starts retains the uncertain-submission boundary", async () => {
  await assert.rejects(runCLI(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 80 }),
    error => error.code === "CLI_TIMEOUT" && error.started === true);
});

test("cancellation immediately after spawn is treated as a started process", async () => {
  const controller = new AbortController();
  const result = runCLI(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, error => error.code === "CANCELLED" && error.started === true);
});

test("oversized CLI output is bounded and reported without returning raw output", async () => {
  await assert.rejects(runCLI(process.execPath, ["-e", "process.stdout.write('s'.repeat(4096))"], { maxOutputBytes: 1024 }),
    error => error.code === "CLI_OUTPUT_LIMIT" && error.started === true && !error.message.includes("sss"));
});
