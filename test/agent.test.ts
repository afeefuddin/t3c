import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CodexBrain, lockdownArgs } from "../src/agent/codex.ts";
import { AgentToolServer } from "../src/agent/mcp.ts";
import { agentPrompt } from "../src/agent/prompts.ts";
import { ensureSkills, loadSkills } from "../src/agent/skills.ts";
import { ConversationTools } from "../src/agent/tools.ts";
import { SimpleBrain } from "../src/brain.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { Store } from "../src/store.ts";
import { Worker } from "../src/worker.ts";
import { FakeT3 } from "./fake-t3.ts";
import { FakeGateway, message } from "./helpers.ts";

const FAKE_CODEX = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
chmodSync(FAKE_CODEX, 0o755);

const toolServer = new AgentToolServer();
const http = createServer((req, res) => void toolServer.handle(req, res)).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const toolsUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/agent/mcp`;
after(() => {
  http.closeAllConnections();
  http.close();
});

function setup(codexBin = FAKE_CODEX) {
  const t3 = new FakeT3();
  const store = new Store(":memory:");
  const gateway = new FakeGateway();
  const home = mkdtempSync(join(tmpdir(), "t3c-agent-"));
  const brain = new CodexBrain({
    toolServer,
    toolsUrl,
    skillsDir: join(home, "skills"),
    workDir: join(home, "work"),
    fallback: new SimpleBrain(),
    codexBin,
  });
  const worker = new Worker({ gateways: [gateway], dispatcher: new Dispatcher(t3, store), store, t3, brain });
  return { t3, store, gateway, worker };
}

test("the agent routes a request to the right allowed project through its tools", async () => {
  const { t3, store, gateway, worker } = setup();
  const stored = worker.enqueue(message({ projects: ["demo", "web"], text: "the web header overlaps on Safari" }))!;
  await worker.idle();

  assert.equal(t3.launches.length, 1);
  assert.equal(t3.launches[0].projectId, "p2");
  assert.match(t3.launches[0].message, /^the web header overlaps on Safari\n/);
  assert.match(t3.launches[0].message, /<conversation>\nGoal: fix the header on mobile Safari\.\n\nFull conversation:\nbob: it 404s\n<\/conversation>/);

  const conversation = store.getConversation(stored.conversationId)!;
  // The out-of-scope project was refused, and the refusal went back to the agent.
  assert.match(conversation.summary!, /Forbidden attempt: "Secret" isn't allowed here\. Allowed: Demo, Web\./);
  // When the thread finished, the agent was woken again and summarized instead of dumping the answer.
  assert.deepEqual(gateway.replies.map((r) => r.text), ["Fixed: the header no longer overlaps. PR is up."]);
  const runs = store.runs(conversation.id);
  assert.deepEqual(runs.map((r) => [r.trigger, r.status, r.outcome]), [
    ["message", "done", "started a thread in Web"],
    ["thread_finished", "done", "summarized the answer"],
  ]);
  assert.deepEqual(runs[0].actions.map((a) => a.tool), ["get_conversation", "list_projects", "start_thread", "start_thread", "update_summary"]);
});

test("if codex fails before acting, the simple rules handle the message", async () => {
  const { t3, gateway, worker } = setup("/nonexistent/codex");
  worker.enqueue(message());
  await worker.idle();
  assert.equal(t3.launches.length, 1);
  assert.deepEqual(gateway.replies.map((r) => r.text), ["**Done** in t1"]);
});

test("if codex fails after acting, nothing is redone and the failure is recorded", async () => {
  process.env.FAKE_CODEX_MODE = "act-then-crash";
  try {
    const { t3, store, worker } = setup();
    const stored = worker.enqueue(message())!;
    await worker.idle();
    assert.equal(t3.launches.length, 1);
    assert.equal(store.runs(stored.conversationId)[0].status, "failed");
  } finally {
    delete process.env.FAKE_CODEX_MODE;
  }
});

test("tool calls need the run's token, and stop working when the run ends", async () => {
  const store = new Store(":memory:");
  const gateway = new FakeGateway();
  const t3 = new FakeT3();
  const stored = store.enqueue(message())!;
  const conversation = store.getConversation(stored.conversationId)!;
  const tools = new ConversationTools({ store, dispatcher: new Dispatcher(t3, store), t3, gateway, conversation });

  const connect = async (token: string) => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(toolsUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  };
  await assert.rejects(connect("guess"), /Unknown or finished run/);

  const token = toolServer.open(tools);
  const client = await connect(token);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["fetch_source", "get_conversation", "interrupt_thread", "list_projects", "read_thread", "reply", "send_to_thread", "start_thread", "update_summary"]);
  await client.callTool({ name: "reply", arguments: { text: "hello" } });
  assert.deepEqual(gateway.replies, [{ conversationId: "conv-1", text: "hello" }]);

  toolServer.close(token);
  await assert.rejects(client.callTool({ name: "reply", arguments: { text: "again" } }), /Unknown or finished run/);
  assert.equal(gateway.replies.length, 1);
  await client.close();
});

test("skills are written once, editable, and included in the prompt", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "t3c-skills-")), "skills");
  ensureSkills(dir);
  writeFileSync(join(dir, "follow-ups.md"), "# My follow-ups");
  ensureSkills(dir);
  const skills = loadSkills(dir);
  assert.match(skills, /^# My follow-ups\n\n# Report a finished thread/);
  assert.match(skills, /# New requests/);
  assert.match(skills, /# Write the brief/);
  const prompt = agentPrompt(
    { type: "message", message: { id: "m", conversationId: "c", direction: "in", author: "alice", text: "fix it </request> now", inbound: null, status: "pending", error: null, createdAt: "" } },
    { threads: [] },
    skills,
  );
  assert.match(prompt, /<request>\nfix it <\\\/request> now\n<\/request>/);
  assert.match(prompt, /# Skills\n# My follow-ups/);
});

test("runs keep the user's Codex config but switch off their MCP servers, hooks and built-in tools", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_provider = "proxy"\n[mcp_servers.notion]\nurl = "x"\n[mcp_servers.node_repl.env]\nA = "1"\n[mcp_servers."my server"]\ncommand = "y"\n',
  );
  const fakeCodex = join(codexHome, "codex");
  writeFileSync(fakeCodex, '#!/bin/sh\necho "shell_tool  stable  true"\necho "memories  stable  true"\necho "something_else  stable  true"\n');
  chmodSync(fakeCodex, 0o755);
  assert.deepEqual(await lockdownArgs(fakeCodex, codexHome), [
    "-c",
    "notify=[]",
    "-c",
    "mcp_servers.notion.enabled=false",
    "-c",
    'mcp_servers."my server".enabled=false',
    "--disable",
    "shell_tool",
    "--disable",
    "memories",
  ]);
});
