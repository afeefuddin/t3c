import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type Connector, ConnectorError, safeEqual } from "./connector.ts";
import type { Dispatcher } from "./dispatch.ts";
import type { Store } from "./store.ts";
import type { T3 } from "./t3.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerDeps {
  connectors: Connector[];
  dispatcher: Dispatcher;
  store: Store;
  t3: T3;
  /** Bearer secret for the read endpoints. */
  secret: string;
}

/**
 * POST /hooks/<connector>  → dispatch the event to a T3 thread
 * GET  /tasks/<id>         → task record plus the thread's latest messages
 */
export function createApp({ connectors, dispatcher, store, t3, secret }: ServerDeps) {
  const byName = new Map(connectors.map((c) => [c.name, c]));

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const [, root, name] = url.pathname.split("/");

      if (req.method === "POST" && root === "hooks" && name) {
        const connector = byName.get(name);
        if (!connector) return send(res, 404, { error: `No connector "${name}".` });
        const task = await connector.handle({ headers: req.headers, body: await readBody(req) });
        if (!task) return send(res, 202, { action: "ignored" });
        const result = await dispatcher.dispatch(task);
        return send(res, result.action === "in_progress" ? 409 : 200, result);
      }

      if (req.method === "GET" && root === "tasks" && name) {
        if (!safeEqual(req.headers.authorization ?? "", `Bearer ${secret}`)) return send(res, 401, { error: "Unauthorized." });
        const task = store.get(name);
        if (!task) return send(res, 404, { error: "Task not found." });
        const thread = task.threadId ? await t3.readThread(task.threadId) : null;
        return send(res, 200, { task, thread });
      }

      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      send(res, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof ConnectorError) return send(res, error.status, { error: error.message });
      console.error(error);
      send(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ConnectorError(413, "Body too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
