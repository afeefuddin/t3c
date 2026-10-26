import { randomUUID } from "node:crypto";
import { type Gateway, GatewayError, header, safeEqual, type Worktree } from "../gateway.ts";

export const MIN_SECRET_LENGTH = 32;

/**
 * Generic gateway for scripts and cron: callers POST JSON with `Authorization: Bearer <secret>`.
 * Body: { conversationId, project, title, prompt, worktree?: { baseRef, branch? }, idempotencyKey? }.
 * Results are read with GET /messages/<id>; there is no conversation to reply into.
 */
export function httpGateway(secret: string): Gateway {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`T3C_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  return {
    name: "http",
    receive({ headers, body }) {
      if (!safeEqual(header(headers, "authorization"), `Bearer ${secret}`)) {
        throw new GatewayError(401, "Invalid or missing bearer secret.");
      }
      const input = parseObject(body);
      const worktree = input.worktree === undefined ? undefined : parseWorktree(input.worktree);
      return {
        message: {
          source: "http",
          eventKey: optionalString(input, "idempotencyKey") ?? randomUUID(),
          conversationId: requireString(input, "conversationId"),
          user: "http",
          text: requireString(input, "prompt"),
          title: requireString(input, "title"),
          projects: [requireString(input, "project")],
          meta: worktree ? { worktree: JSON.stringify(worktree) } : undefined,
        },
      };
    },
    async prepare(message) {
      return message.meta?.worktree ? { worktree: JSON.parse(message.meta.worktree) as Worktree } : {};
    },
  };
}

function parseObject(body: Buffer): Record<string, unknown> {
  let input: unknown;
  try {
    input = JSON.parse(body.toString("utf8"));
  } catch {
    throw new GatewayError(400, "Body must be JSON.");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GatewayError(400, "Body must be a JSON object.");
  }
  return input as Record<string, unknown>;
}

function parseWorktree(value: unknown): Worktree {
  if (typeof value !== "object" || value === null) throw new GatewayError(400, "worktree must be an object.");
  const input = value as Record<string, unknown>;
  const worktree: Worktree = { baseRef: requireString(input, "baseRef") };
  const branch = optionalString(input, "branch");
  if (branch) worktree.branch = branch;
  return worktree;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input, key);
  if (value === undefined) throw new GatewayError(400, `"${key}" must be a non-empty string.`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > 100_000) {
    throw new GatewayError(400, `"${key}" must be a non-empty string.`);
  }
  return value;
}
