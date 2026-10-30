import assert from "node:assert/strict";
import { test } from "node:test";
import { T3Client } from "../src/t3.ts";

const SENT = "2026-01-01T00:00:05.000Z";

/** Opens a session that answers tool calls with `callTool`. */
function session(callTool: (call: { name: string; arguments?: any }) => Promise<unknown>) {
  return async () => ({ client: { callTool } as never, close: async () => {} });
}

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
  return { client: new T3Client(session(callTool)), calls };
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

test("latestReply distinguishes a finished idle thread from one awaiting approval", async () => {
  assert.deepEqual(await fakeClient(["waiting"]).client.latestReply("t1", SENT), { status: "completed", text: "final answer" });
  assert.deepEqual(await fakeClient(["waiting"], undefined, 1).client.latestReply("t1", SENT), { status: "waiting", text: "final answer" });
});

test("latestReply never presents an older completed run as the answer to a new follow-up", async () => {
  const { client, calls } = fakeClient(["completed"], "2026-01-01T00:00:00.000Z");
  assert.deepEqual(await client.latestReply("t1", SENT), { status: "queued", text: null });
  assert.deepEqual(calls, ["t3_thread_read"]);
  assert.equal((await fakeClient(["failed"], "2026-01-01T00:00:00.000Z").client.latestReply("t1", SENT)).status, "failed");
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
  const client = new T3Client(session(callTool));
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
  const result = await new T3Client(session(callTool)).recentMessages("t1");
  assert.equal(result.status, "running");
  assert.deepEqual(result.messages.map((m) => m.text), ["m2", "m3", "m4", "m5", "m6", "m7"]);
  assert.equal(calls[1].view, "messages");
  assert.equal(calls[1].afterPosition, 50);
});

test("attachments are uploaded to T3's signed URLs, then referenced by the launch", async () => {
  const { createServer } = await import("node:http");
  const uploads: { url: string; type: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      uploads.push({ url: req.url!, type: req.headers["content-type"]!, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const calls: { name: string; args: any }[] = [];
  const callTool = async ({ name, arguments: args }: { name: string; arguments?: any }) => {
    calls.push({ name, args });
    const body = name === "t3_attachment_prepare_upload" ? { attachmentId: `pending-${args.upload.name}`, relativeUrl: `/up/${args.upload.name}` } : { threadId: "t1" };
    return { content: [{ type: "text", text: JSON.stringify(body) }] };
  };
  try {
    const client = new T3Client(session(callTool), origin);
    const attachments = [
      { name: "shot.png", mimeType: "image/png", data: Buffer.from("png") },
      { name: "build.log", mimeType: "text/plain", data: Buffer.from("log!") },
    ];
    await client.launchThread({ projectId: "p1", title: "t", message: "m", workspaceStrategy: { type: "root" }, runtimeMode: "auto", attachments });
    assert.deepEqual(uploads, [
      { url: "/up/shot.png", type: "image/png", body: "png" },
      { url: "/up/build.log", type: "text/plain", body: "log!" },
    ]);
    assert.deepEqual(calls.at(-1)?.args.attachments, [
      { id: "pending-shot.png", type: "image", name: "shot.png", mimeType: "image/png", sizeBytes: 3 },
      { id: "pending-build.log", type: "file", name: "build.log", mimeType: "text/plain", sizeBytes: 4 },
    ]);
  } finally {
    server.close();
  }
});

test("a failed connection is replaced on the next call, e.g. after T3 Code restarts", async () => {
  let opened = 0;
  let closed = 0;
  const client = new T3Client(async () => {
    const id = ++opened;
    return {
      client: {
        callTool: async () => {
          if (id === 1) throw new Error("Session not found");
          return { content: [{ type: "text", text: JSON.stringify({ projects: [{ id: "p", title: "web", workspaceRoot: "/" }] }) }] };
        },
      } as never,
      close: async () => void closed++,
    };
  });
  await assert.rejects(client.listProjects(), /Session not found/);
  assert.equal((await client.listProjects())[0].title, "web");
  assert.deepEqual([opened, closed], [2, 1]);
});

test("a tool's own error keeps the connection", async () => {
  let opened = 0;
  const client = new T3Client(async () => {
    opened++;
    return { client: { callTool: async () => ({ isError: true, content: [{ type: "text", text: "no such project" }] }) } as never, close: async () => {} };
  });
  await assert.rejects(client.listProjects(), /no such project/);
  await assert.rejects(client.listProjects(), /no such project/);
  assert.equal(opened, 1);
});
