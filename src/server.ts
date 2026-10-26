import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type Gateway, GatewayError, header, safeEqual } from "./gateway.ts";
import { errorMessage, log } from "./log.ts";
import type { Store } from "./store.ts";
import type { T3 } from "./t3.ts";
import type { Worker } from "./worker.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerDeps {
  gateways: Gateway[];
  worker: Worker;
  store: Store;
  t3: T3;
  /** Bearer secret for GET /messages/<id>; the endpoint is disabled without one. */
  secret?: string;
}

/**
 * POST /hooks/<gateway>  → verify, save to the inbox, answer immediately
 * GET  /messages/<id>    → inbox record, its task and the thread's latest messages
 * GET  /health
 *
 * Only /hooks/* is meant to be exposed publicly (see `t3c funnel`).
 */
export function createApp({ gateways, worker, store, t3, secret }: ServerDeps) {
  const byName = new Map(gateways.map((g) => [g.name, g]));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const [, root, name, extra] = url.pathname.split("/");

      if (req.method === "POST" && root === "hooks" && name && extra === undefined) {
        const gateway = byName.get(name);
        if (!gateway) return send(res, 404, { error: "Not found." });
        const { response, message } = await gateway.receive({ headers: req.headers, body: await readBody(req) });
        if (!message) return send(res, 200, response ?? { ok: true });
        const record = worker.enqueue(message);
        return send(res, 202, response ?? (record ? { accepted: true, messageId: record.id } : { duplicate: true }));
      }

      if (req.method === "GET" && root === "messages" && name && extra === undefined) {
        if (!secret || !safeEqual(header(req.headers, "authorization"), `Bearer ${secret}`)) {
          return send(res, 401, { error: "Unauthorized." });
        }
        const message = store.getInbox(name);
        if (!message) return send(res, 404, { error: "Not found." });
        const task = message.taskId ? store.get(message.taskId) : undefined;
        const thread = task?.threadId ? await t3.readThread(task.threadId) : null;
        return send(res, 200, { message, task, thread });
      }

      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      send(res, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof GatewayError) {
        log("http", `✗ ${req.method} ${req.url} rejected: ${error.message}`, "warn");
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
