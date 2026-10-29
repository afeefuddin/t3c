import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentEvent, type Brain, SimpleBrain } from "../src/brain.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { Store } from "../src/store.ts";
import type { ConversationTools } from "../src/agent/tools.ts";
import { Worker } from "../src/worker.ts";
import { FakeT3 } from "./fake-t3.ts";
import { answers, FakeGateway, message } from "./helpers.ts";

function setup({ store = new Store(":memory:"), brain = new SimpleBrain() as Brain, stallMs = 15 * 60_000, quietMs = 0 } = {}) {
  const t3 = new FakeT3();
  const gateway = new FakeGateway();
  const worker = new Worker({ gateways: [gateway], dispatcher: new Dispatcher(t3, store), store, t3, brain, stallMs, quietMs });
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
  store.takePending();

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

test("messages sent in a burst, or while a run is busy, get one run and one reply", async () => {
  const runs: string[][] = [];
  const brain: Brain = {
    name: "test",
    async handle(event, tools) {
      if (event.type !== "message") return "ignored";
      runs.push(event.messages.map((m) => m.text));
      await tools.reply({ text: `reply ${runs.length}` });
      await new Promise((r) => setTimeout(r, 60)); // a slow run
      return "replied";
    },
  };
  const { gateway, worker } = setup({ brain, quietMs: 40 });
  worker.enqueue(message({ eventKey: "a", text: "but CSS build bana kyun rahe ho?" }));
  await new Promise((r) => setTimeout(r, 15));
  worker.enqueue(message({ eventKey: "b", text: "hlw?" })); // within the pause: same run
  await new Promise((r) => setTimeout(r, 70)); // the run has started
  worker.enqueue(message({ eventKey: "c", text: "PR banao bas" }));
  worker.enqueue(message({ eventKey: "d", text: "??" })); // both arrive while it's busy: one more run
  await worker.idle();

  assert.deepEqual(runs, [["but CSS build bana kyun rahe ho?", "hlw?"], ["PR banao bas", "??"]]);
  assert.deepEqual(gateway.replies.map((r) => r.text), ["reply 1", "reply 2"]);
  assert.deepEqual(gateway.acks, ["a", "b", "c", "d"]); // each message still gets its 👀
});

test("files shared in the conversation go to the thread, and later ones with the follow-up that brought them", async () => {
  const { t3, gateway, worker } = setup();
  const file = (name: string, mimeType = "image/png") => ({ name, mimeType, size: 3, url: `https://files/${name}` });
  gateway.preparation = { context: "bob: see the log [file: build.log (text/plain)]", files: [file("build.log", "text/plain")] };
  gateway.files.set("https://files/build.log", "log").set("https://files/shot.png", "png").set("https://files/after.png", "png");
  worker.enqueue(message({ files: [file("shot.png"), file("missing.png")] }));
  await worker.idle();

  // What couldn't be fetched is left out; the rest goes along, oldest first.
  assert.deepEqual(
    t3.launches[0].attachments?.map((a) => [a.name, a.mimeType, a.data.toString()]),
    [
      ["build.log", "text/plain", "log"],
      ["shot.png", "image/png", "png"],
    ],
  );

  worker.enqueue(message({ eventKey: "e2", text: "this one too", files: [file("after.png")] }));
  await worker.idle();
  assert.deepEqual(t3.sends.at(-1)?.attachments?.map((a) => a.name), ["after.png"]);
});

test("work that's called off stays stopped: its stop doesn't wake the brain to carry on", async () => {
  const events: string[] = [];
  const brain: Brain = {
    name: "test",
    async handle(event, tools) {
      events.push(event.type);
      if (event.type !== "message") return "ignored";
      if (event.messages[0].text === "nvm") {
        await tools.interruptThread({ label: "main", reason: "Called off" });
        await tools.reply({ text: "Stopped 👍" });
        return "stopped";
      }
      await tools.startThread({ project: "Demo", title: "Fix login", prompt: "fix it" });
      return "started";
    },
  };
  const { t3, store, gateway, worker } = setup({ brain });
  let release!: () => void;
  t3.gate = new Promise((r) => (release = r));
  worker.enqueue(message());
  await new Promise((r) => setTimeout(r, 20));
  worker.enqueue(message({ eventKey: "e2", text: "nvm" }));
  await new Promise((r) => setTimeout(r, 20));
  release(); // the interrupted turn ends
  await worker.idle();

  assert.deepEqual(t3.interrupts, [{ threadId: "t1", reason: "Called off" }]);
  assert.deepEqual(events, ["message", "message"]);
  assert.deepEqual(gateway.replies.map((r) => r.text), ["Stopped 👍"]);
  assert.deepEqual(store.awaitingThreads(), []);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a message sent while the agent is answering is shown to it before anything is posted, and it decides", async () => {
  const seen: { event: string; newMessages?: string[] }[] = [];
  const brain: Brain = {
    name: "test",
    async handle(event, tools) {
      if (event.type === "message") {
        seen.push({ event: event.messages.map((m) => m.text).join(" + ") });
        if (tools.launchedThreads().length === 0) await tools.startThread({ project: "Demo", title: "t" });
        return "ok";
      }
      seen.push({ event: event.type });
      await sleep(60); // writing the answer
      const first = await tools.reply({ text: "Done: the button is blue now." });
      if (first.posted) return "posted";
      seen.at(-1)!.newMessages = first.newMessages.map((m) => m.text);
      // Its own call: the news still reads right with the question folded in.
      await tools.reply({ text: "Done: the button is blue now, and yes, dark mode too." });
      return "posted, covering the newer message";
    },
  };
  const { store, gateway, worker } = setup({ brain });
  worker.enqueue(message({ eventKey: "a", text: "make the button blue" }));
  await sleep(30); // the thread has answered; the agent is writing it up
  const late = worker.enqueue(message({ eventKey: "b", text: "dark mode too?" }))!;
  await worker.idle();

  assert.deepEqual(seen, [{ event: "make the button blue" }, { event: "thread_finished", newMessages: ["dark mode too?"] }]);
  assert.deepEqual(gateway.replies.map((r) => r.text), ["Done: the button is blue now, and yes, dark mode too."]);
  assert.equal(store.getMessage(late.id)?.status, "done"); // handled by that run, not a run of its own
  assert.deepEqual(gateway.acks, ["a", "b"]);
});

test("the agent can also post as planned after seeing the newer message", async () => {
  const brain: Brain = {
    name: "test",
    async handle(event, tools) {
      if (event.type === "message") {
        if (tools.launchedThreads().length === 0) await tools.startThread({ project: "Demo", title: "t" });
        return "ok";
      }
      await sleep(60);
      const first = await tools.reply({ text: "Fixed in #12." });
      if (!first.posted) await tools.reply({ text: "Fixed in #12." }); // "thanks!" changes nothing
      return "posted";
    },
  };
  const { gateway, worker } = setup({ brain });
  worker.enqueue(message({ eventKey: "a" }));
  await sleep(30);
  worker.enqueue(message({ eventKey: "b", text: "thanks!" }));
  await worker.idle();
  assert.deepEqual(gateway.replies.map((r) => r.text), ["Fixed in #12."]);
});

test("the fixed rules pass a message sent during the answer to the thread, and post only the answer covering it", async () => {
  const simple = new SimpleBrain();
  const brain: Brain = {
    name: "test",
    async handle(event, tools) {
      if (event.type === "thread_finished" && event.reply.text === "blue done") await sleep(60); // writing it up
      return simple.handle(event, tools);
    },
  };
  const { t3, store, gateway, worker } = setup({ brain });
  t3.answers = [{ status: "completed", text: "blue done" }, { status: "completed", text: "blue and dark mode done" }];
  worker.enqueue(message({ eventKey: "a", text: "make the button blue" }));
  await sleep(30);
  const late = worker.enqueue(message({ eventKey: "b", text: "dark mode too" }))!;
  await worker.idle();

  assert.deepEqual(t3.sends.map((s) => s.message), ["dark mode too"]);
  assert.deepEqual(answers(gateway).map((r) => r.text), ["blue and dark mode done"]);
  assert.equal(store.getMessage(late.id)?.status, "done");
});

test("an answer that newer work already overtook says so, and the fixed rules don't post it", async () => {
  const events: AgentEvent[] = [];
  const simple = new SimpleBrain();
  const brain: Brain = {
    name: "test",
    async handle(event, tools) {
      events.push(event);
      if (event.type === "message" && event.messages[0].text === "dark mode too") await sleep(60); // still sending it on
      return simple.handle(event, tools);
    },
  };
  const { t3, gateway, worker } = setup({ brain });
  let release!: () => void;
  t3.gate = new Promise((r) => (release = r));
  t3.answers = [{ status: "completed", text: "blue done" }, { status: "completed", text: "blue and dark mode done" }];
  worker.enqueue(message({ eventKey: "a", text: "make the button blue" }));
  await sleep(30);
  worker.enqueue(message({ eventKey: "b", text: "dark mode too" }));
  await sleep(20); // its run is going
  release(); // the thread answers the first request meanwhile
  await worker.idle();

  const finished = events.filter((e) => e.type === "thread_finished");
  assert.deepEqual(finished.map((e) => [e.reply.text, e.newerWork ?? false]), [["blue done", true], ["blue and dark mode done", false]]);
  assert.deepEqual(answers(gateway).map((r) => r.text), ["blue and dark mode done"]);
});
