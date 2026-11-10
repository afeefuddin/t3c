import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationTools } from "../src/agent/tools.ts";
import type { Brain } from "../src/brain.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { httpGateway } from "../src/gateways/http.ts";
import { createApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { chatToken, ChatClient } from "../src/terminal.ts";
import { Worker } from "../src/worker.ts";
import { FakeT3 } from "./fake-t3.ts";
import { FakeGateway, message } from "./helpers.ts";

test("conversation discovery enforces historical project access and exposes reusable thread mappings", async () => {
  const store = new Store(":memory:");
  const t3 = new FakeT3();
  const dispatcher = new Dispatcher(t3, store);
  const allowed = store.enqueue(message({ source: "slack", conversationId: "slack-old", eventKey: "a", text: "Checkout fix", projects: ["p1"] }))!;
  const old = store.getConversation(allowed.conversationId)!;
  store.updateConversation(old.id, { summary: "Checkout fix. Open a PR only; do not merge." });
  await dispatcher.launch(old, { label: "checkout", project: "Demo", title: "Checkout fix", prompt: "Fix checkout" });
  const denied = store.enqueue(message({ source: "slack", conversationId: "private", eventKey: "b", text: "Checkout SECRET", projects: ["p2"] }))!;
  for (let i = 0; i < 40; i++) store.enqueue(message({ source: "slack", conversationId: "private", eventKey: `old-${i}`, text: "Checkout", projects: ["p1"] }));
  const current = store.enqueue(message({ source: "http", eventKey: "c", conversationId: "remote-chat", text: "Continue checkout", projects: ["p1"] }))!;
  store.takePending(current.conversationId);
  const conversation = store.getConversation(current.conversationId)!;
  const tools = new ConversationTools({ store, t3, dispatcher, conversation, gateway: httpGateway("s".repeat(32), { projects: ["p1"] }) });
  const found = await tools.listConversations({ search: "checkout" });
  assert.ok(found.some((c) => c.conversationId === old.id));
  assert.ok(found.every((c) => c.conversationId !== denied.conversationId));
  await assert.rejects(tools.readConversation({ conversationId: denied.conversationId }), /not found or not allowed/);
  const context = await tools.readConversation({ conversationId: old.id });
  assert.match(context.summary!, /do not merge/);
  assert.equal(context.threads[0].threadId, "t1");
  await tools.sendToThread({ threadId: context.threads[0].threadId!, text: "Add retry coverage; do not merge." });
  assert.equal(t3.launches.length, 1);
  assert.equal(t3.sends[0].threadId, "t1");
});

test("terminal continues earlier chat work through the same agent and receives the answer only here", async (t) => {
  const store = new Store(":memory:");
  const t3 = new FakeT3();
  const originalGateway = new FakeGateway();
  const dispatcher = new Dispatcher(t3, store);
  const originalMessage = store.enqueue(message({ text: "Checkout fix", projects: ["p1"] }))!;
  store.takePending(originalMessage.conversationId);
  store.finishMessage(originalMessage.id);
  const original = store.getConversation(originalMessage.conversationId)!;
  const launched = await dispatcher.launch(original, { label: "main", project: "Demo", title: "Checkout fix", prompt: "Fix checkout" });
  store.setAwaiting(launched.thread.id, new Date().toISOString());
  let finish!: () => void;
  t3.gate = new Promise<void>((resolve) => { finish = resolve; });
  let continued!: () => void;
  const sent = new Promise<void>((resolve) => { continued = resolve; });
  const brain: Brain = { name: "one-agent", async handle(event, tools) {
    if (event.type === "message") {
      const found = await tools.listConversations({ search: "Checkout" });
      const context = await tools.readConversation({ conversationId: found.find((c) => c.conversationId === original.id)!.conversationId });
      await tools.sendToThread({ threadId: context.threads[0].threadId!, text: "Add retry coverage." });
      continued();
    } else await tools.reply({ text: "Checkout retry coverage added." });
    return "handled by one agent";
  } };
  const token = "t".repeat(32);
  const local = httpGateway(token, { source: "cli", projects: ["*"], requireIdempotencyKey: true });
  const gateways = [originalGateway, local];
  const worker = new Worker({ store, t3, dispatcher, gateways, brain, quietMs: 0 });
  const server = createApp({ store, worker, gateways, chatSecret: token }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => { finish(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new ChatClient(base, token, "terminal-session");
  worker.start();
  assert.deepEqual(await client.messages(), []);
  assert.equal((await fetch(`${base}/chat/terminal-session`)).status, 401);
  assert.equal((await fetch(`${base}/hooks/cli`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status, 404);
  const first = await client.send("Continue the Checkout fix", "first");
  await sent;
  const retry = await client.send("Continue the Checkout fix", "first");
  assert.equal(retry.messageId, first.messageId);
  await assert.rejects(client.send("Different work", "first"), /Idempotency/);
  finish();
  await worker.idle();
  assert.equal(t3.launches.length, 1);
  assert.equal(t3.sends.length, 1);
  assert.deepEqual(originalGateway.replies, []);
  assert.deepEqual((await client.messages()).filter((m) => m.direction === "out").map((m) => m.text), ["Checkout retry coverage added."]);

  // Exercise the actual terminal entrypoint against this same daemon, without a model subprocess.
  const home = mkdtempSync(join(tmpdir(), "t3c-terminal-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ port: (server.address() as AddressInfo).port, agent: { provider: "codex" } }));
  // This process stands in for the running service: the pid file names it, with when it started.
  const started = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
  writeFileSync(join(home, "t3c.pid"), `${process.pid}\n${started}`);
  writeFileSync(join(home, "chat-token"), token, { mode: 0o600 });
  writeFileSync(join(home, "chat-session"), "terminal-session");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", new URL("../src/cli.ts", import.meta.url).pathname, "chat"], {
    env: { ...process.env, T3C_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("you> ")) child.stdin.end("/exit\n"); });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0, errors);
  assert.match(output, /Checkout retry coverage added/);
  assert.equal(readFileSync(join(home, "chat-session"), "utf8"), "terminal-session");
});

test("local chat authentication is persistent and stored privately", () => {
  const path = join(mkdtempSync(join(tmpdir(), "t3c-chat-token-")), "chat-token");
  const token = chatToken(path);
  assert.ok(token.length >= 32);
  assert.equal(chatToken(path), token);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("chat pending state recovers after an interrupted agent run", () => {
  const store = new Store(":memory:");
  const incoming = store.enqueue(message())!;
  store.takePending(incoming.conversationId);
  store.startRun(incoming.conversationId, "message");
  assert.equal(store.conversationBusy(incoming.conversationId), true);
  store.requeueInterrupted();
  assert.equal(store.runs(incoming.conversationId)[0].status, "failed");
  assert.equal(store.getMessage(incoming.id)?.status, "pending");
  store.finishMessage(incoming.id);
  assert.equal(store.conversationBusy(incoming.conversationId), false);
});

test("local chat exposes queued, thinking and working states", async (t) => {
  const store = new Store(":memory:");
  const t3 = new FakeT3();
  const dispatcher = new Dispatcher(t3, store);
  const token = "t".repeat(32);
  const gateway = httpGateway(token, { source: "cli", projects: ["*"], requireIdempotencyKey: true });
  const worker = new Worker({ store, t3, dispatcher, gateways: [gateway], brain: { name: "unused", async handle() { return ""; } } });
  const server = createApp({ store, worker, gateways: [gateway], chatSecret: token }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new ChatClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, "chat");
  const incoming = store.enqueue(message({ source: "cli", conversationId: "chat" }))!;
  assert.equal((await client.snapshot()).activity?.phase, "queued");
  store.takePending(incoming.conversationId);
  const run = store.startRun(incoming.conversationId, "message");
  assert.equal((await client.snapshot()).activity?.phase, "thinking");
  store.updateConversation(incoming.conversationId, { summary: "No PR until requested." });
  const launched = await dispatcher.launch(store.getConversation(incoming.conversationId)!, { project: "Demo", title: "Timer fix", label: "main", prompt: "Fix timer" });
  const since = new Date().toISOString();
  store.setAwaiting(launched.thread.id, since);
  store.finishRun(run.id, { actions: [], outcome: "sent" });
  store.finishMessage(incoming.id);
  let snapshot = await client.snapshot();
  assert.equal(snapshot.activity?.phase, "working");
  assert.equal(snapshot.pending, true);
  assert.ok(!("actions" in snapshot));
  store.clearAwaiting(launched.thread.id, since);
  store.addOutbound(incoming.conversationId, "t3c", "Done.");
  snapshot = await client.snapshot();
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.activity, null);
  assert.equal(snapshot.messages.at(-1)?.text, "Done.");
});
