import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { SimpleBrain, type Brain } from "../src/brain.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { httpGateway } from "../src/gateways/http.ts";
import { HttpApi, instinctInstructions, verifyHttpApi } from "../src/http-api.ts";
import { createApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { ThreadReply } from "../src/t3.ts";
import { Worker } from "../src/worker.ts";
import { FakeT3 } from "./fake-t3.ts";
import { message } from "./helpers.ts";

const secret = "s".repeat(32);
const task = { conversationId: "instinct-job", project: "p1", title: "Fix login", prompt: "Fix the login bug", idempotencyKey: "request-1" };

async function setup(t: TestContext, projects = ["p1"], brain: Brain = new SimpleBrain()) {
  const store = new Store(":memory:");
  const t3 = new FakeT3();
  let latest: ThreadReply = { status: "running", text: "Working on the login bug" };
  t3.latestReply = async () => latest;
  const gateways = [httpGateway(secret, { projects, requireIdempotencyKey: true })];
  const worker = new Worker({ store, t3, gateways, dispatcher: new Dispatcher(t3, store), brain, quietMs: 0 });
  const deps = { secret, projects, store, t3, publicUrl: "" };
  const server = createApp({ store, worker, gateways, secret, httpApi: new HttpApi(deps) }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  deps.publicUrl = base;
  const get = (path: string, token = secret) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  const post = (body: unknown, token = secret) => fetch(`${base}/hooks/http`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { store, t3, worker, base, get, post, deps, answer: (reply: ThreadReply) => { latest = reply; } };
}

test("remote API publishes discovery and lists only authorized projects without local paths", async (t) => {
  const { base, get } = await setup(t);
  const response = await fetch(`${base}/hooks/http/openapi.json`);
  assert.equal(response.status, 200);
  const schema = await response.json();
  assert.equal(schema.openapi, "3.0.3");
  assert.deepEqual(schema.servers, [{ url: base }]);
  assert.deepEqual(schema.security, [{ bearerAuth: [] }]);
  assert.deepEqual(Object.keys(schema.paths).sort(), ["/hooks/http", "/hooks/http/messages/{messageId}", "/hooks/http/projects"]);
  assert.equal(JSON.stringify(schema).includes(secret), false);
  const discovery = await (await fetch(`${base}/hooks/http`)).json();
  assert.deepEqual(discovery, {
    name: "t3c", version: schema.info.version, openapi: `${base}/hooks/http/openapi.json`,
    authentication: { type: "http", scheme: "bearer", header: "Authorization" },
    actions: {
      listProjects: { method: "GET", url: `${base}/hooks/http/projects` },
      sendTask: { method: "POST", url: `${base}/hooks/http` },
      getTaskResult: { method: "GET", url: `${base}/hooks/http/messages/{messageId}` },
    },
  });
  assert.equal(JSON.stringify(discovery).includes(secret), false);
  assert.equal(JSON.stringify(discovery).includes("Demo"), false);
  assert.equal((await fetch(`${base}/hooks/http/projects`)).status, 401);
  assert.equal((await get("/hooks/http/projects", "wrong")).status, 401);
  const projects = await get("/hooks/http/projects");
  assert.deepEqual(await projects.json(), [{ id: "p1", title: "Demo" }]);
  assert.equal(projects.headers.get("cache-control"), "no-store");
  assert.equal((await get("/hooks/http/agent/mcp")).status, 404);
});

test("Instinct can start a task, read the actual T3 answer, and follow up in the same thread", async (t) => {
  const { t3, worker, post, get, answer } = await setup(t);
  const accepted = await post(task);
  assert.equal(accepted.status, 202);
  const { messageId } = await accepted.json();
  await worker.idle();
  assert.equal(t3.launches.length, 1);
  assert.equal(t3.launches[0].projectId, "p1");
  const resultPath = `/hooks/http/messages/${messageId}`;
  assert.deepEqual(await (await get(resultPath)).json(), {
    messageId, conversationId: task.conversationId, deliveryStatus: "done",
    threads: [{ threadId: "t1", status: "running", answer: "Working on the login bug" }],
  });
  answer({ status: "completed", text: "Fixed the redirect and checked the regression." });
  const completed = await (await get(resultPath)).json();
  assert.equal(completed.threads[0].status, "completed");
  assert.equal(completed.threads[0].answer, "Fixed the redirect and checked the regression.");
  const followUp = await post({ ...task, prompt: "Also handle logout", idempotencyKey: "request-2" });
  assert.equal(followUp.status, 202);
  await worker.idle();
  assert.equal(t3.launches.length, 1);
  assert.deepEqual(t3.sends, [{ threadId: "t1", message: "Also handle logout" }]);
  answer({ status: "waiting", text: "Need the logout URL" });
  const { messageId: followUpId } = await followUp.json();
  assert.equal((await (await get(`/hooks/http/messages/${followUpId}`)).json()).threads[0].status, "waiting");
});

test("structured HTTP tasks dispatch directly even when a chat AI brain is configured", async (t) => {
  const { post, worker, t3 } = await setup(t, ["p1"], { name: "chat-ai", async handle() { throw new Error("HTTP must not call the chat AI"); } });
  assert.equal((await post(task)).status, 202);
  await worker.idle();
  assert.equal(t3.launches.length, 1);
});

test("network retries recover the original message id without repeating work; conflicting keys are refused", async (t) => {
  const { post, worker, t3 } = await setup(t, ["p1", "p2"]);
  const first = await (await post(task)).json();
  await worker.idle();
  const retry = await post(task);
  assert.equal(retry.status, 202);
  assert.deepEqual(await retry.json(), { accepted: true, duplicate: true, messageId: first.messageId });
  assert.equal((await post({ ...task, prompt: "Different work" })).status, 409);
  assert.equal((await post({ ...task, conversationId: "different" })).status, 409);
  assert.equal((await post({ ...task, worktree: { baseRef: "main" } })).status, 409);
  assert.equal((await post({ ...task, project: "p2", idempotencyKey: "request-2" })).status, 409);
  await worker.idle();
  assert.equal(t3.launches.length, 1);
  assert.equal(t3.sends.length, 0);
});

test("remote submissions require authentication, a permitted project and an idempotency key", async (t) => {
  const { post, t3, worker } = await setup(t);
  assert.equal((await post(task, "wrong")).status, 401);
  assert.equal((await post({ ...task, project: "p2" })).status, 403);
  assert.equal((await post({ ...task, project: "*" })).status, 403);
  const { idempotencyKey: _, ...noKey } = task;
  assert.equal((await post(noKey)).status, 400);
  await worker.idle();
  assert.equal(t3.launches.length, 0);
});

test("results cannot reveal another gateway, an outbound message, revoked projects or internal runs", async (t) => {
  const { store, get } = await setup(t);
  const other = store.enqueue(message({ source: "slack", projects: ["p1"] }))!;
  const denied = store.enqueue(message({ source: "http", projects: ["p2"] }))!;
  const allowed = store.enqueue(message({ source: "http", conversationId: "allowed", eventKey: "allowed", projects: ["p1"] }))!;
  store.updateConversation(allowed.conversationId, { summary: "private agent summary" });
  store.startRun(allowed.conversationId, "private internal run");
  const outbound = store.addOutbound(allowed.conversationId, "agent", "private internal message");
  assert.equal((await get(`/hooks/http/messages/${allowed.id}`, "wrong")).status, 401);
  for (const id of [other.id, denied.id, outbound.id, "unknown"]) {
    assert.equal((await get(`/hooks/http/messages/${id}`)).status, 404);
  }
  const response = await get(`/hooks/http/messages/${allowed.id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { messageId: allowed.id, conversationId: "allowed", deliveryStatus: "pending", threads: [] });
});

test("all historical project permissions are checked, beyond the recent message window", async (t) => {
  const { store, get, post } = await setup(t);
  store.enqueue(message({ source: "http", conversationId: "mixed", projects: ["p2"] }));
  let latest;
  for (let n = 0; n < 110; n++) {
    latest = store.enqueue(message({ source: "http", eventKey: `history-${n}`, conversationId: "mixed", projects: ["p1"] }))!;
  }
  assert.equal((await get(`/hooks/http/messages/${latest!.id}`)).status, 404);
  assert.equal((await post({ ...task, conversationId: "mixed" })).status, 409);
});

test("delivery failures are distinct from completion and don't expose internal exceptions", async (t) => {
  const { t3, worker, post, get } = await setup(t);
  t3.launchThread = async () => { throw new Error("secret path: /Users/test/.t3c/auth.json"); };
  const { messageId } = await (await post(task)).json();
  await worker.idle();
  const response = await get(`/hooks/http/messages/${messageId}`);
  const body = await response.json();
  assert.equal(body.deliveryStatus, "failed");
  assert.deepEqual(body.threads, [{ threadId: null, status: "failed", answer: null }]);
  assert.equal(JSON.stringify(body).includes("secret path"), false);
});

test("worktree requests use the existing dispatch path; T3 outages don't leak details", async (t) => {
  const { t3, worker, post, get } = await setup(t);
  const { messageId } = await (await post({ ...task, worktree: { baseRef: "main", branch: "fix-login" } })).json();
  await worker.idle();
  assert.deepEqual(t3.launches[0].workspaceStrategy, { type: "worktree", baseRef: "main", branch: "fix-login" });
  t3.latestReply = async () => { throw new Error("MCP token: internal-secret"); };
  const response = await get(`/hooks/http/messages/${messageId}`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal error." });
});

test("setup verifies the exposed API and authentication without submitting work", async (t) => {
  const { base, t3, store, deps } = await setup(t);
  assert.deepEqual(await verifyHttpApi(base, secret), [{ id: "p1", title: "Demo" }]);
  await assert.rejects(verifyHttpApi(base, "wrong"), /projects 401/);
  deps.publicUrl = "https://old-host.example:10000";
  await assert.rejects(verifyHttpApi(base, secret), /wrong public server URL/);
  assert.deepEqual(t3.launches, []);
  assert.deepEqual(store.recentMessages(10), []);
});

test("the private handoff is a complete prompt with credentials, actions, retry and completion rules", () => {
  const handoff = instinctInstructions("https://host.example:10000", secret);
  assert.match(handoff, /https:\/\/host.example:10000\/hooks\/http\/openapi.json/);
  assert.match(handoff, /GET https:\/\/host.example:10000\/hooks\/http\/projects/);
  assert.match(handoff, /POST https:\/\/host.example:10000\/hooks\/http/);
  assert.match(handoff, /GET https:\/\/host.example:10000\/hooks\/http\/messages\/\{messageId\}/);
  assert.ok(handoff.includes(`Authorization: Bearer ${secret}`));
  assert.match(handoff, /Do not start any coding work as a setup test/);
  assert.match(handoff, /If you cannot make authenticated HTTP requests/);
  assert.match(handoff, /reuse the exact JSON body and idempotencyKey/);
  assert.match(handoff, /deliveryStatus=done means the message reached T3, not that coding finished/);
});
