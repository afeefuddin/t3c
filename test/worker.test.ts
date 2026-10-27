import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentEvent, type Brain, SimpleBrain } from "../src/brain.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { Store } from "../src/store.ts";
import type { ConversationTools } from "../src/agent/tools.ts";
import { Worker } from "../src/worker.ts";
import { FakeT3 } from "./fake-t3.ts";
import { FakeGateway, message } from "./helpers.ts";

function setup({ store = new Store(":memory:"), brain = new SimpleBrain() as Brain } = {}) {
  const t3 = new FakeT3();
  const gateway = new FakeGateway();
  const worker = new Worker({ gateways: [gateway], dispatcher: new Dispatcher(t3, store), store, t3, brain });
  return { t3, store, gateway, worker };
}

test("a message launches a thread with its context, acknowledges, and relays the answer", async () => {
  const { t3, store, gateway, worker } = setup();
  const stored = worker.enqueue(message())!;
  await worker.idle();

  assert.equal(t3.launches.length, 1);
  assert.match(t3.launches[0].message, /^fix the login bug\n\n---\nRequested via chat by alice\./);
  assert.match(t3.launches[0].message, /<conversation>\nbob: it 404s\n<\/conversation>$/);
  assert.deepEqual(t3.launches[0].workspaceStrategy, { type: "worktree", baseRef: "main", branch: "b" });
  assert.deepEqual(gateway.acks, ["e1"]);
  assert.deepEqual(gateway.replies, [{ conversationId: "conv-1", text: "**Done** in t1" }]);

  // Everything is on record: both directions of the conversation and each run.
  const conversation = store.getConversation(stored.conversationId)!;
  assert.deepEqual(
    store.messages(conversation.id).map((m) => [m.direction, m.text]),
    [
      ["in", "fix the login bug"],
      ["out", "**Done** in t1"],
    ],
  );
  assert.deepEqual(
    store.runs(conversation.id).map((r) => [r.trigger, r.status]),
    [
      ["message", "done"],
      ["thread_finished", "done"],
    ],
  );
});

test("redelivered events are handled once", async () => {
  const { t3, worker } = setup();
  assert.ok(worker.enqueue(message()));
  assert.equal(worker.enqueue(message()), undefined);
  await worker.idle();
  assert.equal(t3.launches.length, 1);
});

test("follow-ups go to the latest thread without re-sending context", async () => {
  const { t3, gateway, worker } = setup();
  worker.enqueue(message());
  await worker.idle();
  worker.enqueue(message({ eventKey: "e2", text: "also add a test" }));
  await worker.idle();
  assert.deepEqual(t3.sends, [{ threadId: "t1", message: "also add a test" }]);
  assert.equal(gateway.replies.length, 2);
});

test("a follow-up during a pending answer is answered once, after the newer message", async () => {
  const { t3, gateway, worker } = setup();
  let release!: () => void;
  t3.gate = new Promise((r) => (release = r));
  worker.enqueue(message());
  await new Promise((r) => setTimeout(r, 20));
  worker.enqueue(message({ eventKey: "e2", text: "also add a test" }));
  await new Promise((r) => setTimeout(r, 20));
  release();
  await worker.idle();
  assert.equal(gateway.replies.length, 1);
  assert.equal(t3.waits.length, 2);
  assert.ok(t3.waits[1].since > t3.waits[0].since);
});

test("with several allowed projects, the simple brain never asks: in:<project>, a named project, else the first", async () => {
  const { t3, gateway, worker } = setup();
  worker.enqueue(message({ conversationId: "a", projects: ["demo", "web"], text: "in:web fix the header" }));
  worker.enqueue(message({ conversationId: "b", eventKey: "e2", projects: ["demo", "web"], text: "the web header overlaps" }));
  worker.enqueue(message({ conversationId: "c", eventKey: "e3", projects: ["demo", "web"], text: "fix the login bug" }));
  await worker.idle();
  assert.deepEqual(t3.launches.map((l) => l.projectId), ["p2", "p2", "p1"]);
  assert.ok(gateway.replies.every((r) => !r.text.includes("?")));
});

test("failures are reported back to the conversation and recorded", async () => {
  const { t3, store, gateway, worker } = setup();
  gateway.failPrepare = true;
  const stored = worker.enqueue(message())!;
  await worker.idle();
  assert.equal(t3.launches.length, 0);
  assert.equal(store.getMessage(stored.id)?.status, "failed");
  assert.match(gateway.replies[0].text, /Something went wrong: issue not found/);
  assert.equal(store.runs(stored.conversationId)[0].status, "failed");
});

test("after a restart, interrupted messages and owed answers resume", async () => {
  const store = new Store(":memory:");
  // A previous process launched a thread in conv-9 and was still waiting for its answer…
  const earlier = store.enqueue(message({ eventKey: "old", conversationId: "conv-9" }))!;
  store.finishMessage(earlier.id);
  const thread = store.claimThread({ conversationId: earlier.conversationId, label: "main", projectId: "p1", title: "x" })!;
  store.markThreadLaunched(thread.id, "t-old");
  store.setAwaiting(thread.id, new Date().toISOString());
  // …and crashed while handling a new message in conv-1.
  store.enqueue(message());
  store.nextPending();

  const { t3, gateway, worker } = setup({ store });
  worker.start();
  await worker.idle();
  assert.equal(t3.launches.length, 1);
  assert.deepEqual(gateway.replies.map((r) => r.conversationId).sort(), ["conv-1", "conv-9"]);
  assert.deepEqual(store.awaitingThreads(), []);
});

test("runs in one conversation never overlap", async () => {
  let active = 0;
  let maxActive = 0;
  const slow: Brain = {
    name: "slow",
    async handle(_event: AgentEvent, _tools: ConversationTools) {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return "ok";
    },
  };
  const { worker } = setup({ brain: slow });
  worker.enqueue(message());
  worker.enqueue(message({ eventKey: "e2" }));
  worker.enqueue(message({ eventKey: "e3" }));
  await worker.idle();
  assert.equal(maxActive, 1);
});

test("a queued message from a gateway that isn't configured is marked failed, not fatal", async () => {
  const store = new Store(":memory:");
  const orphan = store.enqueue(message({ source: "cli", eventKey: "old" }))!;
  const { t3, worker } = setup({ store });
  worker.start();
  await worker.idle();
  assert.equal(store.getMessage(orphan.id)?.status, "failed");
  assert.equal(t3.launches.length, 0);
});

test("recent and active messages span conversations, newest last", async () => {
  const store = new Store(":memory:");
  const a = store.enqueue(message({ eventKey: "a", conversationId: "c-a", text: "first" }))!;
  store.finishMessage(a.id);
  store.enqueue(message({ eventKey: "b", conversationId: "c-b", text: "second" }));
  assert.deepEqual(store.recentMessages(5).map((m) => m.text), ["first", "second"]);
  assert.deepEqual(store.recentMessages(1).map((m) => m.text), ["second"]);
  assert.deepEqual(store.activeMessages().map((m) => m.text), ["second"]);
});
