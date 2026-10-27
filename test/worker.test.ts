import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentEvent, type Brain, SimpleBrain } from "../src/brain.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { Store } from "../src/store.ts";
import type { ConversationTools } from "../src/agent/tools.ts";
import { Worker } from "../src/worker.ts";
import { FakeT3 } from "./fake-t3.ts";
import { answers, FakeGateway, message } from "./helpers.ts";

function setup({ store = new Store(":memory:"), brain = new SimpleBrain() as Brain, stallMs = 15 * 60_000 } = {}) {
  const t3 = new FakeT3();
  const gateway = new FakeGateway();
  const worker = new Worker({ gateways: [gateway], dispatcher: new Dispatcher(t3, store), store, t3, brain, stallMs });
  return { t3, store, gateway, worker };
}

test("a message launches a thread with its context, acknowledges, and relays the answer", async () => {
  const { t3, store, gateway, worker } = setup();
  const stored = worker.enqueue(message())!;
  await worker.idle();

  assert.equal(t3.launches.length, 1);
  assert.match(t3.launches[0].message, /^fix the login bug\n\nWork autonomously\./);
  assert.match(t3.launches[0].message, /<conversation>\nbob: it 404s\n<\/conversation>$/);
  assert.deepEqual(t3.launches[0].workspaceStrategy, { type: "worktree", baseRef: "main", branch: "b" });
  assert.deepEqual(gateway.acks, ["e1"]);
  // A friendly acknowledgement straight away, then the answer.
  assert.deepEqual(gateway.replies, [
    { conversationId: "conv-1", text: "On it! I'll post here when it's done 👀" },
    { conversationId: "conv-1", text: "**Done** in t1" },
  ]);

  // Everything is on record: both directions of the conversation and each run.
  const conversation = store.getConversation(stored.conversationId)!;
  assert.deepEqual(
    store.messages(conversation.id).map((m) => [m.direction, m.text]),
    [
      ["in", "fix the login bug"],
      ["out", "On it! I'll post here when it's done 👀"],
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
  assert.deepEqual(gateway.replies.map((r) => r.text), ["On it! I'll post here when it's done 👀", "**Done** in t1", "Got it, on it 👍", "**Done** in t1"]);
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
  assert.equal(answers(gateway).length, 1);
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
  assert.deepEqual(answers(gateway).map((r) => r.conversationId).sort(), ["conv-1", "conv-9"]);
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

test("a finished thread is settled, unless more work was sent to it", async () => {
  const { t3, worker } = setup();
  worker.enqueue(message());
  await worker.idle();
  assert.deepEqual(t3.settled, ["t1"]);
});

test("a waiting or failed thread is told to carry on, not reported to the person", async () => {
  const { t3, gateway, worker } = setup();
  t3.answers.push({ status: "waiting", text: "Should I use Postgres or SQLite?" }, { status: "failed", text: "tests failed" });
  worker.enqueue(message());
  await worker.idle();
  assert.match(t3.sends[0].message, /Nobody is available to answer\. Choose the most reasonable option/);
  assert.match(t3.sends[1].message, /ended with status "failed"\. Find out what went wrong/);
  // Then it completed: one reply with the answer, no questions passed on, and it's settled.
  assert.deepEqual(answers(gateway).map((r) => r.text), ["**Done** in t1"]);
  assert.deepEqual(t3.settled, ["t1"]);
});

test("a thread that keeps waiting is given up on after 3 attempts, with one message to the person", async () => {
  const { t3, gateway, store, worker } = setup();
  for (let i = 0; i < 4; i++) t3.answers.push({ status: "waiting", text: "?" });
  worker.enqueue(message());
  await worker.idle();
  assert.equal(t3.sends.length, 3);
  assert.equal(answers(gateway).length, 1);
  assert.match(answers(gateway)[0].text, /still isn't moving after 3 attempts/);
  assert.deepEqual(store.awaitingThreads(), []);
  assert.deepEqual(t3.settled, []);
});

test("the supervisor nudges a stuck thread, then restarts it, then gives up", async () => {
  const { t3, gateway, store, worker } = setup({ stallMs: 0 });
  let release!: () => void;
  t3.gate = new Promise((r) => (release = r));
  worker.enqueue(message());
  await new Promise((r) => setTimeout(r, 20));
  t3.state.set("t1", { status: "running", items: 7 });

  await worker.supervise(); // first look: remembers the item count
  await worker.supervise(); // no progress → attempt 1: nudge
  assert.match(t3.sends.at(-1)!.message, /No progress for 0 minutes/);
  assert.equal(t3.interrupts.length, 0);

  await worker.supervise(); // still none → attempt 2: stop the turn and restart it
  assert.equal(t3.interrupts.length, 1);
  assert.equal(t3.sends.length, 2);

  // Progress resets the count: the next stall is attempt 1 again.
  t3.state.set("t1", { status: "running", items: 8 });
  await worker.supervise();
  await worker.supervise();
  assert.equal(t3.interrupts.length, 1);
  assert.equal(t3.sends.length, 3);

  await worker.supervise(); // attempt 2
  await worker.supervise(); // attempt 3
  assert.equal(answers(gateway).length, 0);
  await worker.supervise(); // attempt 4: give up, stop it, tell the person once
  assert.equal(t3.interrupts.length, 4);
  assert.match(answers(gateway)[0].text, /still isn't moving after 3 attempts/);
  assert.deepEqual(store.awaitingThreads(), []);
  await worker.supervise();
  assert.equal(answers(gateway).length, 1);

  release();
  await worker.idle();
  assert.equal(answers(gateway).length, 1); // the late answer isn't posted over the give-up
});

test("an attached thread's answer comes back, and t3c leaves the thread unsettled", async () => {
  const { t3, store, gateway, worker } = setup();
  const stored = worker.enqueue(message())!;
  await worker.idle();
  t3.settled.length = 0;
  const conversation = store.getConversation(stored.conversationId)!;
  const attached = store.attachThread({ conversationId: conversation.id, label: "chat-ui", projectId: "p1", title: "Chat UI", t3ThreadId: "ext1" });
  store.setAwaiting(attached.id, new Date().toISOString());
  worker.start();
  await worker.idle();
  assert.ok(gateway.replies.some((r) => r.text === "**Done** in ext1"));
  assert.deepEqual(t3.settled, []);
});
