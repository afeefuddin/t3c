import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.T3C_HOME = join(mkdtempSync(join(tmpdir(), "t3c-")), "home");
const { allowedProjects, loadConfig, saveConfig } = await import("../src/config.ts");
const { describeAllowed, editProjects, normalize, parsePicks, setProject } = await import("../src/projects.ts");

const projects = [
  { id: "p1", title: "Demo", workspaceRoot: "/code/demo" },
  { id: "p2", title: "Web App", workspaceRoot: "/code/web" },
  { id: "p3", title: "infra", workspaceRoot: "/code/infra" },
];
const slack = (allowed: string[]) => ({ signingSecret: "s", botToken: "b", projects: allowed, allowedUsers: [] });

test("switching a project on or off keeps the others", () => {
  assert.deepEqual(setProject(["p1"], "p3", true, projects), ["p1", "p3"]);
  assert.deepEqual(setProject(["p1", "p3"], "p1", false, projects), ["p3"]);
  // Under "any project", switching one off keeps every other one rather than leaving nothing.
  assert.deepEqual(setProject(["*"], "p2", false, projects), ["p1", "p3"]);
  assert.deepEqual(setProject(["*"], "p2", true, projects), ["*"]);
  assert.deepEqual(setProject(["p1"], "*", true, projects), ["*"]);
  assert.deepEqual(setProject(["*"], "*", false, projects), ["p1", "p2", "p3"]);
});

test("the checklist takes numbers, names with spaces, and * in one answer", () => {
  const rows = projects.map((p) => ({ key: p.id, title: p.title }));
  assert.deepEqual(parsePicks("1 3", rows), { keys: ["p1", "p3"] });
  assert.deepEqual(parsePicks("web app, 1", rows), { keys: ["p2", "p1"] });
  assert.deepEqual(parsePicks("INFRA,*", rows), { keys: ["p3", "*"] });
  assert.match((parsePicks("1 9", rows) as { error: string }).error, /"9" isn't in the list/);
  assert.match((parsePicks("nope", rows) as { error: string }).error, /"nope" isn't in the list/);
});

test("titles from older Slack configs become ids; projects T3 no longer has are kept visible", () => {
  assert.deepEqual(normalize(["demo", "p3", "gone"], projects), ["p1", "p3", "gone"]);
  assert.equal(describeAllowed(["p1", "p2", "p3"], projects), "Demo, Web App and infra");
  assert.equal(describeAllowed(["*"], projects), "any project, including ones added later");
  assert.equal(describeAllowed([], projects), "no projects");
});

test("`t3c projects slack add|remove` changes only that list, saved by id", async () => {
  saveConfig({ ...loadConfig(), slack: slack(["Demo"]), http: { secret: "s", public: true, projects: ["p2"] } });
  await editProjects("slack", "add", ["web app", "infra"], projects);
  assert.deepEqual(loadConfig().slack!.projects, ["p1", "p2", "p3"]);
  await editProjects("slack", "remove", ["Demo"], projects);
  assert.deepEqual(loadConfig().slack!.projects, ["p2", "p3"]);
  assert.deepEqual(loadConfig().http!.projects, ["p2"]);
  await editProjects("instinct", "add", ["*"], projects);
  assert.deepEqual(loadConfig().http!.projects, ["*"]);
  await editProjects("instinct", "remove", ["infra"], projects);
  assert.deepEqual(loadConfig().http!.projects, ["p1", "p2"]);
  await assert.rejects(editProjects("slack", "add", ["nope"], projects), /No T3 project named "nope"/);
  await assert.rejects(editProjects("slack", "add", [], projects), /Usage: t3c projects slack/);
});

test("a removed connection allows nothing; a local webhook from before project lists allows any", () => {
  const base = { port: 1, runtimeMode: "auto" as const };
  assert.deepEqual(allowedProjects(base, "slack"), []);
  assert.deepEqual(allowedProjects(base, "http"), []);
  assert.deepEqual(allowedProjects({ ...base, http: { secret: "s" } }, "http"), ["*"]);
  assert.deepEqual(allowedProjects({ ...base, http: { secret: "s", public: true } }, "http"), []);
});
