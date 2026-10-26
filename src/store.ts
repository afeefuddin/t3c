import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type TaskStatus = "launching" | "launched" | "failed";

export interface TaskRecord {
  id: string;
  source: string;
  externalId: string;
  projectId: string;
  title: string;
  threadId: string | null;
  status: TaskStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  source: string;
  external_id: string;
  project_id: string;
  title: string;
  thread_id: string | null;
  status: TaskStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Maps (source, externalId) to the T3 thread doing the work. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        thread_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (source, external_id)
      );
    `);
  }

  get(id: string): TaskRecord | undefined {
    return toRecord(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined);
  }

  find(source: string, externalId: string): TaskRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE source = ? AND external_id = ?")
      .get(source, externalId) as Row | undefined;
    return toRecord(row);
  }

  /**
   * Claims the (source, externalId) key for a launch. Returns undefined when another
   * launch already holds it, so two concurrent deliveries can't spawn two threads.
   * A failed task may be claimed again.
   */
  claim(input: { source: string; externalId: string; projectId: string; title: string }): TaskRecord | undefined {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `INSERT INTO tasks (id, source, external_id, project_id, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'launching', ?, ?)
         ON CONFLICT (source, external_id) DO UPDATE SET
           project_id = excluded.project_id, title = excluded.title,
           status = 'launching', error = NULL, updated_at = excluded.updated_at
         WHERE tasks.status = 'failed'
         RETURNING *`,
      )
      .get(randomUUID(), input.source, input.externalId, input.projectId, input.title, now, now) as Row | undefined;
    return toRecord(row);
  }

  markLaunched(id: string, threadId: string) {
    this.db
      .prepare("UPDATE tasks SET status = 'launched', thread_id = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(threadId, new Date().toISOString(), id);
  }

  markFailed(id: string, error: string) {
    this.db
      .prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error, new Date().toISOString(), id);
  }
}

function toRecord(row: Row | undefined): TaskRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    projectId: row.project_id,
    title: row.title,
    threadId: row.thread_id,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
