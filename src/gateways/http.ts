import { randomUUID } from "node:crypto";
import { type Gateway, GatewayError, header, safeEqual, type Worktree } from "../gateway.ts";

export const MIN_SECRET_LENGTH = 32;

/**
 * Generic gateway for scripts and cron: callers POST JSON with `Authorization: Bearer <secret>`.
 * Body: { conversationId, prompt, project?, title?, worktree?, idempotencyKey? }.
 * Replies are saved by ConversationTools and retrieved by the client.
 */
export function httpGateway(
  secret: string,
  { projects, requireIdempotencyKey = false, source = "http" }: { projects?: Allowed; requireIdempotencyKey?: boolean; source?: string } = {},
): Gateway {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`T3C_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  const allowed = typeof projects === "function" ? projects : () => projects;
  return {
    name: source,
    receive({ headers, body }) {
      if (!safeEqual(header(headers, "authorization"), `Bearer ${secret}`)) {
        throw new GatewayError(401, "Invalid or missing bearer secret.");
      }
      const input = parseObject(body);
      const project = optionalString(input, "project");
      if (project && !httpProjectAllowed(project, allowed())) throw new GatewayError(403, "Project is not allowed.");
      const prompt = requireString(input, "prompt");
      const worktree = input.worktree === undefined ? undefined : parseWorktree(input.worktree);
      return {
        message: {
          source,
          eventKey: (requireIdempotencyKey ? requireString(input, "idempotencyKey") : optionalString(input, "idempotencyKey")) ?? randomUUID(),
          conversationId: requireString(input, "conversationId"),
          user: source,
          text: prompt,
          title: optionalString(input, "title") ?? prompt.slice(0, 80),
          projects: project ? [project] : allowed() ?? ["*"],
          meta: worktree ? { worktree: JSON.stringify(worktree) } : undefined,
        },
      };
    },
    async prepare(message) {
      if (!message.projects.every((p) => httpProjectAllowed(p, allowed()))) throw new GatewayError(403, "Project is not allowed.");
      return message.meta?.worktree ? { worktree: JSON.parse(message.meta.worktree) as Worktree } : {};
    },
    // The common agent records replies in SQLite; clients read them over HTTP.
    async reply() {},
  };
}

/** Allowed project ids; a function is asked on every request, so edits apply without a restart. */
export type Allowed = string[] | (() => string[]);

/** Project ids are matched exactly; a wildcard must be granted in the local config. */
export function httpProjectAllowed(project: string, projects?: string[]): boolean {
  return projects === undefined || projects.includes("*") || projects.includes(project);
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
