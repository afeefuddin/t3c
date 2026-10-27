import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** A request that reached POST /hooks/<gateway>. */
export interface GatewayRequest {
  headers: IncomingHttpHeaders;
  /** Raw bytes, so gateways can verify signatures. */
  body: Buffer;
}

/** A verified request from an allowed user, ready to become T3 work. */
export interface InboundMessage {
  /** Gateway name. */
  source: string;
  /** Unique per delivery, so redelivered webhooks are handled once. */
  eventKey: string;
  /** The external conversation (Slack thread, GitHub issue). One conversation maps to one T3 thread. */
  conversationId: string;
  /** Who asked, in the gateway's terms. */
  user: string;
  /** The request itself, with any bot mention or command stripped. */
  text: string;
  /** Title for a new T3 thread. */
  title: string;
  /** T3 projects (ids or titles) this conversation may work in; ["*"] means any. */
  projects: string[];
  /** Link back to the conversation, for the agent and for humans. */
  url?: string;
  /** Gateway-specific details needed later, e.g. the Slack message ts to react to. */
  meta?: Record<string, string>;
}

export interface Worktree {
  baseRef: string;
  branch?: string;
  startFromOrigin?: boolean;
}

/** What a new conversation needs beyond the request: earlier messages and where to work. */
export interface Preparation {
  /** Earlier conversation, written by other people: passed to the agent as untrusted data. */
  context?: string;
  /** Instructions from the gateway itself (trusted), e.g. which branch to push to. */
  instructions?: string;
  worktree?: Worktree;
}

export interface Received {
  /** Body for the immediate HTTP response, e.g. Slack's URL-verification challenge. */
  response?: unknown;
  /** Present when the request should become T3 work. */
  message?: InboundMessage;
}

/**
 * A messaging platform. `receive` runs inside the webhook request: it must verify the request
 * (throw GatewayError 401), filter to allowed users, and stay fast. Everything slow happens
 * later in the worker through `prepare`, `acknowledge` and `reply`.
 */
export interface Gateway {
  name: string;
  receive(req: GatewayRequest): Promise<Received> | Received;
  /** Gathers context for the first message of a conversation. */
  prepare?(message: InboundMessage): Promise<Preparation>;
  /** Signals that work started, e.g. a 👀 reaction. Best effort. */
  acknowledge?(message: InboundMessage): Promise<void>;
  /** Posts text (Markdown) back into the conversation. */
  reply?(conversationId: string, text: string): Promise<void>;
  /**
   * Messages in followed conversations that never arrived as webhooks (a dropped delivery, or the
   * machine was asleep). Must return each message under the same eventKey a webhook would use.
   */
  catchUp?(): Promise<InboundMessage[]>;
}

export class GatewayError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * User agent of `t3c status`'s reachability check: an unsigned request it expects to be refused.
 * The refusal is the expected answer, so it isn't logged (the agent string is only a log hint).
 */
export const PROBE_USER_AGENT = "t3c-status-probe";

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string) {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

export function hmacSha256Hex(secret: string, data: string | Buffer) {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

