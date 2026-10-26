import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { SimpleBrain } from "../src/brain.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { type Gateway, GatewayError } from "../src/gateway.ts";
import { httpGateway } from "../src/gateways/http.ts";
import { createApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Worker } from "../src/worker.ts";
import { FakeT3 } from "./fake-t3.ts";

const SECRET = "s".repeat(32);
const exploding: Gateway = {
  name: "boom",
  receive() {
    throw new Error("internal detail: /Users/afeef/.t3c/auth.json");
  },
};
const strict: Gateway = {
  name: "strict",
  receive() {
    throw new GatewayError(401, "Invalid signature.");
  },
};

const t3 = new FakeT3();
const store = new Store(":memory:");
const gateways = [httpGateway(SECRET), exploding, strict];
const worker = new Worker({ gateways, dispatcher: new Dispatcher(t3, store), store, t3, brain: new SimpleBrain() });
const server = createApp({ gateways, worker, store, secret: SECRET }).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const post = (path: string, body: unknown, auth = `Bearer ${SECRET}`) =>
  fetch(base + path, { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) });
const task = { conversationId: "job-1", project: "demo", title: "Fix", prompt: "Fix it" };

test("the http gateway enqueues work and its status is readable with the secret", async () => {
  const res = await post("/hooks/http", { ...task, idempotencyKey: "k1" });
  assert.equal(res.status, 202);
  const { messageId } = await res.json();
  await worker.idle();
  assert.equal(t3.launches.length, 1);

  assert.deepEqual(await (await post("/hooks/http", { ...task, idempotencyKey: "k1" })).json(), { duplicate: true });

  assert.equal((await fetch(`${base}/messages/${messageId}`)).status, 401);
  const status = await fetch(`${base}/messages/${messageId}`, { headers: { authorization: `Bearer ${SECRET}` } });
  const body = await status.json();
  assert.equal(body.message.status, "done");
  assert.equal(body.threads[0].t3ThreadId, "t1");
  assert.equal(body.conversation.externalId, "job-1");
  assert.equal(body.runs[0].trigger, "message");
});

test("bad secrets and bad signatures are rejected", async () => {
  assert.equal((await post("/hooks/http", task, "Bearer wrong")).status, 401);
  assert.equal((await post("/hooks/strict", {})).status, 401);
});

test("unexpected errors don't leak internals to the caller", async () => {
  const res = await post("/hooks/boom", {});
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "Internal error." });
});

test("agent tools aren't served without an agent tool server, and never under /hooks", async () => {
  assert.equal((await post("/agent/mcp", {})).status, 404);
});

test("unknown routes and oversized bodies are refused", async () => {
  assert.equal((await post("/hooks/nope", {})).status, 404);
  assert.equal((await post("/hooks/http/extra", {})).status, 404);
  const big = await fetch(`${base}/hooks/http`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
  assert.equal(big.status, 413);
});

test("http gateway refuses weak secrets", () => {
  assert.throws(() => httpGateway("short"), /32/);
});
