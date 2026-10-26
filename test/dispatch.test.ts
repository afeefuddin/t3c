import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/connector.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { Store } from "../src/store.ts";
import type { LaunchInput, T3, ThreadSummary } from "../src/t3.ts";

class FakeT3 implements T3 {
  launches: LaunchInput[] = [];
  sends: { threadId: string; message: string }[] = [];
  threads: ThreadSummary[] = [];
  /** When set, launch creates the thread but then throws (lost response). */
  loseLaunchResponse = false;
  failLaunch = false;

  async listProjects() {
    return [{ id: "p1", title: "Demo", workspaceRoot: "/tmp/demo" }];
  }
  async listThreads(_projectId: string, titleContains: string) {
    return this.threads.filter((t) => t.title.includes(titleContains));
  }
  async launchThread(input: LaunchInput) {
    if (this.failLaunch) throw new Error("boom");
    this.launches.push(input);
    const thread = {
      threadId: `t${this.launches.length}`,
      title: input.title,
      status: "running",
      createdAt: new Date().toISOString(),
    };
    this.threads.push(thread);
    if (this.loseLaunchResponse) throw new Error("socket hang up");
    return { threadId: thread.threadId };
  }
  async sendToThread(threadId: string, message: string) {
    this.sends.push({ threadId, message });
  }
  async readThread() {
    return {};
  }
}

const task = (overrides: Partial<Task> = {}): Task => ({
  source: "http",
  externalId: "issue-1",
  project: "demo",
  title: "Fix login",
  prompt: "Fix the login bug",
  ...overrides,
});

function setup() {
  const t3 = new FakeT3();
  const store = new Store(":memory:");
  return { t3, store, dispatcher: new Dispatcher(t3, store) };
}

test("launches a thread in the resolved project, then follows up on repeats", async () => {
  const { t3, dispatcher } = setup();

  const first = await dispatcher.dispatch(task({ worktree: { baseRef: "main", branch: "fix-login" } }));
  assert.equal(first.action, "launched");
  assert.equal(first.task.threadId, "t1");
  assert.deepEqual(t3.launches[0], {
    projectId: "p1",
    title: "[http] Fix login",
    message: "Fix the login bug",
    workspaceStrategy: { type: "worktree", baseRef: "main", branch: "fix-login" },
  });

  const second = await dispatcher.dispatch(task({ prompt: "Also add a test" }));
  assert.equal(second.action, "followed_up");
  assert.equal(t3.launches.length, 1);
  assert.deepEqual(t3.sends, [{ threadId: "t1", message: "Also add a test" }]);
});

test("defaults to the project checkout when no worktree is requested", async () => {
  const { t3, dispatcher } = setup();
  await dispatcher.dispatch(task());
  assert.deepEqual(t3.launches[0].workspaceStrategy, { type: "root" });
});

test("concurrent deliveries spawn one thread", async () => {
  const { t3, dispatcher } = setup();
  const results = await Promise.all([dispatcher.dispatch(task()), dispatcher.dispatch(task())]);
  assert.equal(t3.launches.length, 1);
  assert.deepEqual(results.map((r) => r.action).sort(), ["in_progress", "launched"]);
});

test("adopts the thread when the launch response is lost", async () => {
  const { t3, dispatcher } = setup();
  t3.loseLaunchResponse = true;
  const result = await dispatcher.dispatch(task());
  assert.equal(result.action, "launched");
  assert.equal(result.task.threadId, "t1");
});

test("a failed launch is recorded and can be retried", async () => {
  const { t3, store, dispatcher } = setup();
  t3.failLaunch = true;
  await assert.rejects(dispatcher.dispatch(task()), /boom/);
  assert.equal(store.find("http", "issue-1")?.status, "failed");

  t3.failLaunch = false;
  const retry = await dispatcher.dispatch(task());
  assert.equal(retry.action, "launched");
  assert.equal(t3.launches.length, 1);
});

test("rejects unknown projects without recording a task", async () => {
  const { store, dispatcher } = setup();
  await assert.rejects(dispatcher.dispatch(task({ project: "nope" })), /Unknown T3 project/);
  assert.equal(store.find("http", "issue-1"), undefined);
});
