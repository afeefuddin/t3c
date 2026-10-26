import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundMessage } from "./gateway.ts";

export type TaskStatus = "launching" | "launched" | "failed";

export type InboxStatus = "pending" | "processing" | "done" | "failed";

export interface InboxRecord {
  id: string;
  message: InboundMessage;
  status: InboxStatus;
  taskId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A T3 thread whose answer still has to be posted back to its conversation. */
export interface Relay {
  threadId: string;
  source: string;
  conversationId: string;
  /** Send time of the newest message awaiting an answer; earlier runs' answers are stale. */
  since: string;
}

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

/**
 * Durable state:
 * - inbox: verified incoming messages, saved before the webhook is answered so none are lost
 * - tasks: maps (source, externalId) to the T3 thread doing the work
 * - relays: answers still owed to a conversation, resumed after a restart
 */
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
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        event_key TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (source, event_key)
      );
      CREATE TABLE IF NOT EXISTS relays (
        thread_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        since TEXT NOT NULL
      );
    `);
  }

  /** Saves a message for processing. Returns undefined when this delivery was already received. */
  enqueue(message: InboundMessage): InboxRecord | undefined {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `INSERT INTO inbox (id, source, event_key, message, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (source, event_key) DO NOTHING
         RETURNING *`,
      )
      .get(randomUUID(), message.source, message.eventKey, JSON.stringify(message), now, now) as InboxRow | undefined;
    return row && toInboxRecord(row);
  }

  getInbox(id: string): InboxRecord | undefined {
    const row = this.db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxRow | undefined;
    return row && toInboxRecord(row);
  }

  /** Takes the oldest pending message, marking it processing. */
  nextInbox(): InboxRecord | undefined {
    const row = this.db
      .prepare(
        `UPDATE inbox SET status = 'processing', updated_at = ?
         WHERE id = (SELECT id FROM inbox WHERE status = 'pending' ORDER BY created_at, rowid LIMIT 1)
         RETURNING *`,
      )
      .get(new Date().toISOString()) as InboxRow | undefined;
    return row && toInboxRecord(row);
  }

  finishInbox(id: string, result: { taskId?: string; error?: string }) {
    this.db
      .prepare("UPDATE inbox SET status = ?, task_id = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(result.error ? "failed" : "done", result.taskId ?? null, result.error ?? null, new Date().toISOString(), id);
  }

  /** After a crash, messages left mid-processing go back to pending. */
  requeueInterrupted() {
    this.db.prepare("UPDATE inbox SET status = 'pending' WHERE status = 'processing'").run();
  }

  addRelay(relay: Relay) {
    this.db
      .prepare(
        `INSERT INTO relays (thread_id, source, conversation_id, since) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET since = excluded.since`,
      )
      .run(relay.threadId, relay.source, relay.conversationId, relay.since);
  }

  relays(): Relay[] {
    const rows = this.db.prepare("SELECT * FROM relays ORDER BY since").all() as {
      thread_id: string;
      source: string;
      conversation_id: string;
      since: string;
    }[];
    return rows.map((r) => ({ threadId: r.thread_id, source: r.source, conversationId: r.conversation_id, since: r.since }));
  }

  removeRelay(threadId: string) {
    this.db.prepare("DELETE FROM relays WHERE thread_id = ?").run(threadId);
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

interface InboxRow {
  id: string;
  message: string;
  status: InboxStatus;
  task_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function toInboxRecord(row: InboxRow): InboxRecord {
  return {
    id: row.id,
    message: JSON.parse(row.message),
    status: row.status,
    taskId: row.task_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
