import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.T3C_HOME = join(mkdtempSync(join(tmpdir(), "t3c-")), "home");
const { loadConfig, needsFunnel, paths, saveConfig } = await import("../src/config.ts");
const { describeGateways } = await import("../src/daemon.ts");

test("config starts with safe defaults and is saved readable only by the owner", () => {
  assert.deepEqual(loadConfig(), { port: 8787, runtimeMode: "auto-accept-edits" });
  saveConfig({ ...loadConfig(), http: { secret: "s" } });
  assert.equal(statSync(paths.config).mode & 0o777, 0o600);
  assert.equal(statSync(join(paths.config, "..")).mode & 0o777, 0o700);
  assert.deepEqual(loadConfig().http, { secret: "s" });
});

test("only Slack and GitHub need Funnel", () => {
  assert.equal(needsFunnel({ port: 1, runtimeMode: "auto", http: { secret: "s" } }), false);
  assert.equal(needsFunnel({ port: 1, runtimeMode: "auto", github: { webhookSecret: "s", repos: {}, allowedUsers: [] } }), true);
});

test("status describes each gateway in one line", () => {
  const lines = describeGateways({
    port: 1,
    runtimeMode: "auto",
    slack: { signingSecret: "s", botToken: "b", channels: { C1: "demo" }, allowedUsers: ["U1"] },
    github: { webhookSecret: "s", repos: { "a/b": "demo" }, allowedUsers: ["a"] },
  });
  assert.deepEqual(lines, ["slack   C1→demo; 1 allowed user(s)", "github  a/b→demo; allowed: a"]);
});
