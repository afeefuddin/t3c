import assert from "node:assert/strict";
import { test } from "node:test";
import { T3Client } from "../src/t3.ts";

const SENT = "2026-01-01T00:00:05.000Z";

/** Answers MCP tool calls from a script of thread states, the way T3's server shapes them. */
function fakeClient(statuses: string[], runCompletedAt = "2026-01-01T00:00:10.000Z", pendingRequestCount = 0) {
  const calls: string[] = [];
  const callTool = async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
    calls.push(name);
    let body: unknown = { timedOut: true };
    if (name === "t3_thread_read") {
      const status = args?.limit === 1 ? statuses.shift()! : "completed";
      body = {
        thread: { status, latestRunId: "run2", itemCount: 12, pendingRequestCount },
        recentRuns: [{ runId: "run2", completedAt: status === "running" ? null : runCompletedAt }],
        items: [
          { type: "assistant_message", runId: "run1", text: "old answer" },
          { type: "assistant_message", runId: "run2", text: "checking…" },
          { type: "tool_call", runId: "run2", text: null },
          { type: "assistant_message", runId: "run2", text: "final answer" },
        ],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(body) }] };
  };
  return { client: new T3Client({ callTool } as never), calls };
}

test("waitForReply waits while the thread works, then returns the latest run's last answer", async () => {
  const { client, calls } = fakeClient(["running", "completed"]);
  assert.deepEqual(await client.waitForReply("t1", SENT), { status: "completed", text: "final answer" });
  assert.deepEqual(calls, ["t3_thread_read", "t3_thread_wait", "t3_thread_read", "t3_thread_read"]);
});

test("waitForReply reports a thread blocked on a question, with what it asked", async () => {
  const { client } = fakeClient(["waiting"], undefined, 1);
  assert.deepEqual(await client.waitForReply("t1", SENT), { status: "waiting", text: "final answer" });
});

test("waitForReply treats a thread idle-waiting for its next message after answering as completed", async () => {
  // T3 shows "waiting" with nothing pending once a run is done and the thread awaits input.
  const { client } = fakeClient(["waiting"]);
  assert.deepEqual(await client.waitForReply("t1", SENT), { status: "completed", text: "final answer" });
});

test("waitForReply gives up after its deadline", async () => {
  const { client } = fakeClient(["running", "running"]);
  assert.deepEqual(await client.waitForReply("t1", SENT, -1), { status: "timed_out", text: null });
});

test("waitForReply ignores a run that finished before the message was sent", async () => {
  // First read: the previous run's stale "completed"; then the new run works and finishes.
  const statuses = ["completed", "running", "completed"];
  const times = ["2026-01-01T00:00:00.000Z", null, "2026-01-01T00:00:10.000Z"];
  const calls: string[] = [];
  const callTool = async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
    calls.push(name);
    let body: unknown = { timedOut: false };
    if (name === "t3_thread_read" && args?.limit === 1) {
      body = { thread: { status: statuses.shift(), latestRunId: "r", itemCount: 1 }, recentRuns: [{ runId: "r", completedAt: times.shift() }] };
    } else if (name === "t3_thread_read") {
      body = { thread: { status: "completed", latestRunId: "r", itemCount: 1 }, recentRuns: [], items: [{ type: "assistant_message", runId: "r", text: "new" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(body) }] };
  };
  const client = new T3Client({ callTool } as never);
  assert.deepEqual(await client.waitForReply("t1", SENT), { status: "completed", text: "new" });
  assert.deepEqual(calls, ["t3_thread_read", "t3_thread_read", "t3_thread_wait", "t3_thread_read", "t3_thread_read"]);
});

test("recentMessages reads the tail of the thread's messages", async () => {
  const calls: Record<string, unknown>[] = [];
  const callTool = async ({ arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
    calls.push(args!);
    const items = Array.from({ length: 8 }, (_, i) => ({ type: i === 0 ? "user_message" : "assistant_message", runId: "r", text: `m${i}` }));
    return { content: [{ type: "text", text: JSON.stringify({ thread: { status: "running", latestRunId: "r", itemCount: 250 }, recentRuns: [], items }) }] };
  };
  const result = await new T3Client({ callTool } as never).recentMessages("t1");
  assert.equal(result.status, "running");
  assert.deepEqual(result.messages.map((m) => m.text), ["m2", "m3", "m4", "m5", "m6", "m7"]);
  assert.equal(calls[1].view, "messages");
  assert.equal(calls[1].afterPosition, 50);
});
