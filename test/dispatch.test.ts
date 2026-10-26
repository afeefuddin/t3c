import assert from "node:assert/strict";
import { test } from "node:test";
import { Dispatcher, type LaunchRequest } from "../src/dispatch.ts";
import { Store } from "../src/store.ts";
import { FakeT3 } from "./fake-t3.ts";

function setup() {
  const t3 = new FakeT3();
  const store = new Store(":memory:");
  const message = store.enqueue({
    source: "chat",
    eventKey: "e1",
    conversationId: "c1",
    user: "alice",
    text: "fix it",
    title: "Fix it",
    projects: ["demo"],
  })!;
  const conversation = store.getConversation(message.conversationId)!;
  return { t3, store, conversation, dispatcher: new Dispatcher(t3, store) };
}

const request = (overrides: Partial<LaunchRequest> = {}): LaunchRequest => ({
  label: "main",
  project: "demo",
  title: "Fix login",
  prompt: "Fix the login bug",
  ...overrides,
});

test("launches in the resolved project with a capped runtime mode, then returns the existing thread", async () => {
  const { t3, dispatcher, conversation } = setup();
  const first = await dispatcher.launch(conversation, request({ worktree: { baseRef: "main", branch: "fix-login" } }));
  assert.equal(first.status, "launched");
  assert.equal(first.thread.t3ThreadId, "t1");
  assert.deepEqual(t3.launches[0], {
    projectId: "p1",
    title: "[chat] Fix login",
    message: "Fix the login bug",
    workspaceStrategy: { type: "worktree", baseRef: "main", branch: "fix-login" },
    runtimeMode: "auto-accept-edits",
  });
  assert.equal((await dispatcher.launch(conversation, request())).status, "existing");
  assert.equal(t3.launches.length, 1);
});

test("a conversation can hold several threads under different labels", async () => {
  const { t3, store, dispatcher, conversation } = setup();
  await dispatcher.launch(conversation, request());
  await dispatcher.launch(conversation, request({ label: "web", project: "Web" }));
  assert.equal(t3.launches.length, 2);
  assert.deepEqual(
    store.threads(conversation.id).map((t) => [t.label, t.projectId, t.t3ThreadId]),
    [
      ["main", "p1", "t1"],
      ["web", "p2", "t2"],
    ],
  );
});

test("defaults to the project checkout when no worktree is requested", async () => {
  const { t3, dispatcher, conversation } = setup();
  await dispatcher.launch(conversation, request());
  assert.deepEqual(t3.launches[0].workspaceStrategy, { type: "root" });
});

test("concurrent launches of one label spawn one thread", async () => {
  const { t3, dispatcher, conversation } = setup();
  const results = await Promise.all([dispatcher.launch(conversation, request()), dispatcher.launch(conversation, request())]);
  assert.equal(t3.launches.length, 1);
  assert.deepEqual(results.map((r) => r.status).sort(), ["in_progress", "launched"]);
});

test("adopts the thread when the launch response is lost", async () => {
  const { t3, dispatcher, conversation } = setup();
  t3.loseLaunchResponse = true;
  const result = await dispatcher.launch(conversation, request());
  assert.equal(result.status, "launched");
  assert.equal(result.thread.t3ThreadId, "t1");
});

test("a failed launch is recorded and can be retried", async () => {
  const { t3, store, dispatcher, conversation } = setup();
  t3.failLaunch = true;
  await assert.rejects(dispatcher.launch(conversation, request()), /boom/);
  assert.equal(store.findThread(conversation.id, "main")?.status, "failed");
  t3.failLaunch = false;
  assert.equal((await dispatcher.launch(conversation, request())).status, "launched");
});

test("rejects unknown projects without recording a thread", async () => {
  const { store, dispatcher, conversation } = setup();
  await assert.rejects(dispatcher.launch(conversation, request({ project: "nope" })), /Unknown T3 project/);
  assert.deepEqual(store.threads(conversation.id), []);
});
