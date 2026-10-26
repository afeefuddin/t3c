import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** Unit of work handed to T3: one external conversation maps to one thread. */
export interface Task {
  /** Connector name, e.g. "http" or "github". */
  source: string;
  /** Stable id of the external conversation (issue, Slack thread, ...). Repeats become follow-ups. */
  externalId: string;
  /** T3 project id or title. */
  project: string;
  title: string;
  prompt: string;
  /** Run in a new worktree instead of the project checkout. */
  worktree?: { baseRef: string; branch?: string };
}

export interface ConnectorRequest {
  headers: IncomingHttpHeaders;
  /** Raw bytes, so connectors can verify HMAC signatures. */
  body: Buffer;
}

export class ConnectorError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * A source of work. `handle` must authenticate the request (throw ConnectorError 401)
 * and return the Task, or null when the event should be ignored.
 * Mounted at POST /hooks/<name>.
 */
export interface Connector {
  name: string;
  handle(req: ConnectorRequest): Task | null | Promise<Task | null>;
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string) {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}
