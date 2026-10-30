import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.T3C_HOME = join(mkdtempSync(join(tmpdir(), "t3c-")), "home");
const { loadConfig, needsFunnel, paths, saveConfig } = await import("../src/config.ts");
const { describeGateways } = await import("../src/daemon.ts");

test("config starts with safe defaults and is saved readable only by the owner", () => {
  assert.deepEqual(loadConfig(), { port: 4773, runtimeMode: "auto-accept-edits" });
  saveConfig({ ...loadConfig(), http: { secret: "s" } });
  assert.equal(statSync(paths.config).mode & 0o777, 0o600);
  assert.equal(statSync(join(paths.config, "..")).mode & 0o777, 0o700);
  assert.deepEqual(loadConfig().http, { secret: "s" });
});

test("Slack and opt-in remote HTTP need Funnel; local HTTP stays local", () => {
  assert.equal(needsFunnel({ port: 1, runtimeMode: "auto", http: { secret: "s" } }), false);
  assert.equal(needsFunnel({ port: 1, runtimeMode: "auto", slack: { signingSecret: "s", botToken: "b", projects: [], allowedUsers: [] } }), true);
  assert.equal(needsFunnel({ port: 1, runtimeMode: "auto", http: { secret: "s", public: true, projects: ["p1"] } }), true);
});

test("status describes the Instinct API and its project restrictions", () => {
  assert.deepEqual(describeGateways({ port: 1, runtimeMode: "auto", http: { secret: "s", public: true, projects: ["p1"] } }),
    ["http    public agent API (Instinct); projects: p1"]);
});

test("status describes each gateway in one line", () => {
  const lines = describeGateways({
    port: 1,
    runtimeMode: "auto",
    slack: { signingSecret: "s", botToken: "b", projects: ["demo"], allowedUsers: ["U1"] },
  });
  assert.deepEqual(lines, ["slack   any channel or DM→demo; 1 allowed user(s)"]);
});

test("a Slack config from per-channel days keeps its projects, now for every channel", () => {
  const legacy = (channels: Record<string, string | string[]>) => {
    saveConfig({ ...loadConfig(), slack: { signingSecret: "s", botToken: "b", channels, allowedUsers: ["U1"] } as any });
    return loadConfig().slack;
  };
  assert.deepEqual(legacy({ C1: "demo", C2: ["demo", "web"] }), { signingSecret: "s", botToken: "b", projects: ["demo", "web"], allowedUsers: ["U1"] });
  assert.deepEqual(legacy({ C1: "demo", "*": "*" })?.projects, ["*"]);
});
