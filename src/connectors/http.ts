import { type Connector, ConnectorError, safeEqual, type Task } from "../connector.ts";

/**
 * Generic connector: callers POST a Task-shaped JSON body with
 * `Authorization: Bearer <secret>`. Useful for scripts, cron and as a template.
 */
export function httpConnector(secret: string): Connector {
  return {
    name: "http",
    handle({ headers, body }) {
      if (!safeEqual(headers.authorization ?? "", `Bearer ${secret}`)) {
        throw new ConnectorError(401, "Invalid or missing bearer secret.");
      }
      return parseTask(body);
    },
  };
}

function parseTask(body: Buffer): Task {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ConnectorError(400, "Body must be JSON.");
  }
  if (typeof input !== "object" || input === null) throw new ConnectorError(400, "Body must be a JSON object.");

  const task: Task = {
    source: "http",
    externalId: requireString(input, "externalId"),
    project: requireString(input, "project"),
    title: requireString(input, "title"),
    prompt: requireString(input, "prompt"),
  };
  if (input.worktree !== undefined) {
    const worktree = input.worktree as Record<string, unknown>;
    if (typeof worktree !== "object" || worktree === null) throw new ConnectorError(400, "worktree must be an object.");
    task.worktree = { baseRef: requireString(worktree, "baseRef") };
    if (worktree.branch !== undefined) task.worktree.branch = requireString(worktree, "branch");
  }
  return task;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConnectorError(400, `"${key}" must be a non-empty string.`);
  }
  return value;
}

