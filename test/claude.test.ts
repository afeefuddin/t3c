import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ClaudeBrain } from "../src/agent/claude.ts";
import { AgentToolServer } from "../src/agent/mcp.ts";
import { SimpleBrain } from "../src/brain.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { Store } from "../src/store.ts";
import { Worker } from "../src/worker.ts";
import { FakeT3 } from "./fake-t3.ts";
import { FakeGateway, message } from "./helpers.ts";

const claudeBin = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
chmodSync(claudeBin, 0o755);
const toolServer = new AgentToolServer();
const http = createServer((req, res) => void toolServer.handle(req, res)).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const toolsUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/agent/mcp`;
after(() => { http.closeAllConnections(); http.close(); });

function setup(binary = claudeBin, timeoutMs = 10_000) {
  const t3 = new FakeT3(), store = new Store(":memory:"), gateway = new FakeGateway();
  const dir = mkdtempSync(join(tmpdir(), "t3c-claude-"));
  const brain = new ClaudeBrain({
    toolServer, toolsUrl, skillsDir: join(dir, "skills"), workDir: join(dir, "work"),
    fallback: new SimpleBrain(), claudeBin: binary, timeoutMs, model: "sonnet",
  });
  const worker = new Worker({ gateways: [gateway], dispatcher: new Dispatcher(t3, store), store, t3, brain, quietMs: 0 });
  return { t3, store, gateway, worker, dir };
}

test("Claude routes through the shared scoped MCP tools and summarizes the thread's answer", async () => {
  const { t3, store, worker, gateway } = setup();
  const stored = worker.enqueue(message({ projects: ["demo", "web"], text: "the web header overlaps" }))!;
  await worker.idle();
  assert.equal(t3.launches.length, 1);
  assert.equal(t3.launches[0].projectId, "p2");
  assert.match(t3.launches[0].message, /^Fix the header overlap on Safari\./);
  assert.match(store.getConversation(stored.conversationId)!.summary!, /"Secret" isn't allowed here/);
  assert.deepEqual(gateway.replies.map((r) => r.text), ["Fixed the header. PR is ready."]);
});

test("Claude restrictions, images and run-token revocation apply to every run", async () => {
  const { gateway, worker, dir } = setup();
  const seenFile = join(dir, "seen.json");
  process.env.FAKE_CLAUDE_SEEN = seenFile;
  try {
    const file = { name: "screenshot.png", mimeType: "image/png", size: 3, url: "https://files/image" };
    gateway.files.set(file.url, "png");
    worker.enqueue(message({ files: [file] }));
    await worker.idle();
    const seen = JSON.parse(readFileSync(seenFile, "utf8"));
    assert.equal(seen.args[seen.args.indexOf("--model") + 1], "sonnet");
    assert.equal(seen.cwd, realpathSync(join(dir, "work")));
    assert.ok(seen.args.includes("--restricted"));
    assert.ok(seen.args.includes("--strict-mcp-config"));
    assert.ok(seen.args.includes("--disable-slash-commands"));
    assert.ok(seen.args.includes("--no-session-persistence"));
    assert.deepEqual(seen.content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png").toString("base64") } });
    const response = await fetch(toolsUrl, { method: "POST", headers: { authorization: `Bearer ${seen.token}` } });
    assert.equal(response.status, 401);
  } finally { delete process.env.FAKE_CLAUDE_SEEN; }
});

test("missing Claude uses the fixed rules without losing the task", async () => {
  const { t3, worker } = setup("/nonexistent/claude");
  worker.enqueue(message());
  await worker.idle();
  assert.equal(t3.launches.length, 1);
});

test("older CLIs, unexpected tools and incomplete initialization fail closed", async () => {
  for (const mode of ["old", "unsafe-tools", "disconnected", "invalid-json", "no-init", "credit-error", "timeout"]) {
    process.env.FAKE_CLAUDE_MODE = mode;
    try {
      const { t3, worker, store } = setup(claudeBin, mode === "timeout" ? 700 : 10_000);
      const stored = worker.enqueue(message())!;
      await worker.idle();
      assert.equal(t3.launches.length, 1, mode);
      assert.match(store.runs(stored.conversationId)[0].outcome!, /fallback/, mode);
    } finally { delete process.env.FAKE_CLAUDE_MODE; }
  }
});

test("a Claude failure after acting is recorded without starting duplicate work", async () => {
  process.env.FAKE_CLAUDE_MODE = "act-then-crash";
  try {
    const { t3, worker, store } = setup();
    const stored = worker.enqueue(message())!;
    await worker.idle();
    assert.equal(t3.launches.length, 1);
    assert.equal(store.runs(stored.conversationId)[0].status, "failed");
  } finally { delete process.env.FAKE_CLAUDE_MODE; }
});
