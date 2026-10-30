import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isLoggedIn, T3Auth } from "../src/auth.ts";

// A stand-in for T3's OAuth endpoints: one pairing code buys one token.
const issued: string[] = [];
const decisions: { access: string; code: string }[] = [];
let expiresIn = 30 * 24 * 3600;
let rejectToken: string | undefined;

const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  switch (req.url) {
    case "/.well-known/oauth-authorization-server":
      return json(200, { registration_endpoint: `${base}/oauth/mcp/register`, token_endpoint: `${base}/oauth/mcp/token` });
    case "/oauth/mcp/register":
      return json(201, { client_id: "client-1" });
    case "/oauth/mcp/decision": {
      const { authorization, decision } = JSON.parse(body);
      decisions.push({ access: decision.access, code: decision.code });
      if (decision.code !== "good-code") return json(200, { redirectTo: `${authorization.redirect_uri}?error=access_denied&state=${authorization.state}` });
      return json(200, { redirectTo: `${authorization.redirect_uri}?code=auth-code&state=${authorization.state}` });
    }
    case "/oauth/mcp/token": {
      const form = new URLSearchParams(body);
      assert.equal(form.get("code"), "auth-code");
      assert.ok(form.get("code_verifier"));
      const token = `token-${issued.length + 1}`;
      issued.push(token);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: expiresIn });
    }
    case "/mcp":
      return req.headers.authorization === `Bearer ${rejectToken}` ? json(401, {}) : json(200, { auth: req.headers.authorization });
  }
  json(404, {});
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
after(() => server.close());

function setup(code = "good-code") {
  const authFile = join(mkdtempSync(join(tmpdir(), "t3c-auth-")), "auth.json");
  const pairs: string[][] = [];
  const auth = (access: "auto-accept-edits" | "full-access" = "auto-accept-edits") =>
    new T3Auth({ serverUrl: mcpUrl, authFile, access, pair: async (scopes) => (pairs.push(scopes), code) });
  return { authFile, pairs, auth };
}

test("login approves with a pairing code and stores the token privately", async () => {
  const { authFile, pairs, auth } = setup();
  assert.equal(isLoggedIn(authFile), false);
  const token = await auth().login();
  assert.equal(token, issued.at(-1));
  assert.deepEqual(pairs, [["orchestration:read", "orchestration:operate"]]);
  assert.deepEqual(decisions.at(-1), { access: "auto-accept-edits", code: "good-code" });
  assert.equal(isLoggedIn(authFile), true);
  assert.equal(statSync(authFile).mode & 0o777, 0o600);
  // A stored, fresh token is reused without another pairing code.
  assert.equal(await auth().token(), token);
  assert.equal(pairs.length, 1);
});

test("a token close to expiry, or for a narrower runtime mode, is replaced by logging in again", async () => {
  const { pairs, auth } = setup();
  expiresIn = 3600;
  try {
    const first = await auth().login();
    assert.notEqual(await auth().token(), first);
    assert.equal(pairs.length, 2);
  } finally {
    expiresIn = 30 * 24 * 3600;
  }
  await auth("full-access").token();
  assert.deepEqual(pairs.at(-1), ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"]);
  assert.equal(decisions.at(-1)?.access, "full-access");
});

test("requests carry the token, and a rejected token triggers one new login", async () => {
  const { auth } = setup();
  const session = auth();
  const first = await session.login();
  rejectToken = first;
  const response = await session.fetch(mcpUrl, { method: "POST" });
  rejectToken = undefined;
  assert.deepEqual(await response.json(), { auth: `Bearer ${issued.at(-1)}` });
  assert.notEqual(issued.at(-1), first);
});

test("concurrent callers share one login", async () => {
  const { pairs, auth } = setup();
  const session = auth();
  const tokens = await Promise.all([session.token(), session.token(), session.token()]);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(pairs.length, 1);
});

test("a refused approval is reported, and nothing is stored", async () => {
  const { authFile, auth } = setup("bad-code");
  await assert.rejects(auth().login(), /T3 refused the login: access_denied/);
  assert.equal(isLoggedIn(authFile), false);
  assert.equal(JSON.parse(readFileSync(authFile, "utf8")).accessToken, undefined);
});
