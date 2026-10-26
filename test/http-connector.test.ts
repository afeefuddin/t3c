import assert from "node:assert/strict";
import { test } from "node:test";
import { httpConnector } from "../src/connectors/http.ts";

const connector = httpConnector("s3cret-s3cret-s3cret");
const request = (body: unknown, authorization = "Bearer s3cret-s3cret-s3cret") => ({
  headers: { authorization },
  body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});
const valid = { externalId: "x1", project: "demo", title: "Do it", prompt: "Please do it" };

test("parses a valid task", () => {
  assert.deepEqual(connector.handle(request({ ...valid, worktree: { baseRef: "main", branch: "b" } })), {
    source: "http",
    ...valid,
    worktree: { baseRef: "main", branch: "b" },
  });
});

test("rejects a wrong secret", () => {
  assert.throws(() => connector.handle(request(valid, "Bearer nope")), { status: 401 });
});

test("rejects malformed bodies", () => {
  assert.throws(() => connector.handle(request("not json")), { status: 400 });
  assert.throws(() => connector.handle(request({ ...valid, prompt: "" })), { status: 400 });
  assert.throws(() => connector.handle(request({ ...valid, worktree: { branch: "b" } })), { status: 400 });
});
