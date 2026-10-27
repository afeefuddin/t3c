import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentToolServer } from "./agent/mcp.ts";
import { type Gateway, GatewayError, header, PROBE_USER_AGENT, safeEqual } from "./gateway.ts";
import { slackChallenge } from "./gateways/slack.ts";
import { errorMessage, log } from "./log.ts";
import type { Store } from "./store.ts";
import type { Worker } from "./worker.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerDeps {
  gateways: Gateway[];
  worker: Worker;
  store: Store;
  /** Bearer secret for GET /messages/<id>; the endpoint is disabled without one. */
  secret?: string;
  /** Tools for running agents, at /agent/mcp (per-run bearer tokens). */
  agentTools?: AgentToolServer;
}

/**
 * POST /hooks/<gateway>  → verify, save to the inbox, answer immediately
 * GET  /messages/<id>    → a message, its conversation, attached threads and agent runs
 *      /agent/mcp         → tools for the agent run holding the bearer token
 * GET  /health
 *
 * Only /hooks/* is exposed publicly (Tailscale Funnel); the rest is reachable from this machine only.
 */
/** Answers only Slack's URL check: what `t3c add slack` runs while the app is created, before t3c can start. */
export function slackChallengeServer() {
  return createServer(async (req, res) => {
    const body = await readBody(req).catch(() => Buffer.alloc(0));
    const challenge = req.method === "POST" && req.url === "/hooks/slack" ? slackChallenge(body) : undefined;
    if (challenge) send(res, 200, { challenge });
    else send(res, 404, { error: "Not found." });
  });
}

export function createApp({ gateways, worker, store, secret, agentTools }: ServerDeps) {
  const byName = new Map(gateways.map((g) => [g.name, g]));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const [, root, name, extra] = url.pathname.split("/");

      if (req.method === "POST" && root === "hooks" && name && extra === undefined) {
        const body = await readBody(req);
        const challenge = name === "slack" ? slackChallenge(body) : undefined;
        if (challenge) {
          log("slack", "✓ answered Slack's URL check");
          return send(res, 200, { challenge });
        }
        const gateway = byName.get(name);
        if (!gateway) return send(res, 404, { error: "Not found." });
        const { response, message } = await gateway.receive({ headers: req.headers, body });
        if (!message) return send(res, 200, response ?? { ok: true });
        const record = worker.enqueue(message);
        return send(res, 202, response ?? (record ? { accepted: true, messageId: record.id } : { duplicate: true }));
      }

      if (req.method === "GET" && root === "messages" && name && extra === undefined) {
        if (!secret || !safeEqual(header(req.headers, "authorization"), `Bearer ${secret}`)) {
          return send(res, 401, { error: "Unauthorized." });
        }
        const message = store.getMessage(name);
        if (!message) return send(res, 404, { error: "Not found." });
        const conversation = store.getConversation(message.conversationId);
        return send(res, 200, { message, conversation, threads: store.threads(message.conversationId), runs: store.runs(message.conversationId) });
      }

      if (url.pathname === "/agent/mcp" && agentTools) return await agentTools.handle(req, res);

      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, pid: process.pid });
      send(res, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof GatewayError) {
        if (header(req.headers, "user-agent") !== PROBE_USER_AGENT) log("http", `✗ ${req.method} ${req.url} rejected: ${error.message}`, "warn");
        return send(res, error.status, { error: error.message });
      }
      // Callers may be on the internet: log the details, return nothing internal.
      log("http", `✗ ${req.method} ${req.url} failed: ${errorMessage(error)}`, "error");
      send(res, 500, { error: "Internal error." });
    }
  });
  // Slow-loris protection; webhook senders finish well within these.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new GatewayError(413, "Body too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new GatewayError(413, "Body too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
