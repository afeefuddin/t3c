import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundMessage } from "./gateway.ts";

/** One Slack thread / GitHub issue / HTTP conversation: its messages, T3 threads and memory. */
export interface Conversation {
  id: string;
  source: string;
  externalId: string;
  state: ConversationState;
  /** The agent's running notes about this conversation. */
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}
export type ConversationState = "active" | "waiting_on_user" | "done";

export interface StoredMessage {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  author: string;
  text: string;
  /** For incoming messages: the full gateway message. */
  inbound: InboundMessage | null;
  /** Incoming: pending → processing → done | failed. Outgoing: sent. */
  status: "pending" | "processing" | "done" | "failed" | "sent";
  error: string | null;
  createdAt: string;
}

/** A T3 thread attached to a conversation. A conversation can have several (e.g. one per project). */
export interface ThreadRecord {
  id: string;
  conversationId: string;
  /** Unique within the conversation, e.g. "main" or "web-app". */
  label: string;
  projectId: string;
  title: string;
  t3ThreadId: string | null;
  status: "launching" | "launched" | "failed";
  error: string | null;
  /** Send time of the newest message to this thread still owed an answer; null when nothing is owed. */
  awaitingSince: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  conversationId: string;
  trigger: string;
  status: "running" | "done" | "failed";
  /** Tool calls made during the run, in order. */
  actions: { tool: string; input: unknown; result?: unknown; error?: string }[];
  outcome: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const now = () => new Date().toISOString();

/** Durable state in SQLite. Incoming messages are saved before webhooks are answered, so none are lost. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (source, external_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        source TEXT NOT NULL,
        event_key TEXT,
        direction TEXT NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        inbound TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (source, event_key)
      );
      CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        label TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        t3_thread_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        awaiting_since TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (conversation_id, label)
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        actions TEXT NOT NULL DEFAULT '[]',
        outcome TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);
  }

  // ── conversations ──────────────────────────────────────────────────────────

  getConversation(id: string): Conversation | undefined {
    return toConversation(this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row);
  }

  findConversation(source: string, externalId: string): Conversation | undefined {
    const row = this.db.prepare("SELECT * FROM conversations WHERE source = ? AND external_id = ?").get(source, externalId);
    return toConversation(row as Row);
  }

  updateConversation(id: string, changes: { state?: ConversationState; summary?: string }) {
    const current = this.getConversation(id);
    if (!current) return;
    this.db
      .prepare("UPDATE conversations SET state = ?, summary = ?, updated_at = ? WHERE id = ?")
      .run(changes.state ?? current.state, changes.summary ?? current.summary, now(), id);
  }

  // ── messages ───────────────────────────────────────────────────────────────

  /** Saves an incoming message in its conversation. Returns undefined when this delivery was already received. */
  enqueue(message: InboundMessage): StoredMessage | undefined {
    const time = now();
    const conversation = this.db
      .prepare(
        `INSERT INTO conversations (id, source, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source, external_id) DO UPDATE SET updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(randomUUID(), message.source, message.conversationId, time, time) as { id: string };
    const row = this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, source, event_key, direction, author, text, inbound, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'in', ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (source, event_key) DO NOTHING
         RETURNING *`,
      )
      .get(randomUUID(), conversation.id, message.source, message.eventKey, message.user, message.text, JSON.stringify(message), time, time);
    return toMessage(row as Row);
  }

  /** Records something t3c said in a conversation. */
  addOutbound(conversationId: string, author: string, text: string): StoredMessage {
    const conversation = this.getConversation(conversationId)!;
    const time = now();
    const row = this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, source, direction, author, text, status, created_at, updated_at)
         VALUES (?, ?, ?, 'out', ?, ?, 'sent', ?, ?) RETURNING *`,
      )
      .get(randomUUID(), conversationId, conversation.source, author, text, time, time);
    return toMessage(row as Row)!;
  }

  getMessage(id: string): StoredMessage | undefined {
    return toMessage(this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row);
  }

  /** The most recent messages of a conversation, oldest first. */
  messages(conversationId: string, limit = 30): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(conversationId, limit) as Row[];
    return rows.reverse().map((r) => toMessage(r)!);
  }

  /** The latest messages across all conversations, oldest first. */
  recentMessages(limit: number): StoredMessage[] {
    const rows = this.db.prepare("SELECT * FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Row[];
    return rows.reverse().map((r) => toMessage(r)!);
  }

  /** Incoming messages not handled yet: queued or being handled right now. */
  activeMessages(): StoredMessage[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE status IN ('pending', 'processing') ORDER BY created_at, rowid").all();
    return (rows as Row[]).map((r) => toMessage(r)!);
  }

  /** Takes the oldest pending incoming message, marking it processing. */
  nextPending(): StoredMessage | undefined {
    const row = this.db
      .prepare(
        `UPDATE messages SET status = 'processing', updated_at = ?
         WHERE id = (SELECT id FROM messages WHERE status = 'pending' ORDER BY created_at, rowid LIMIT 1)
         RETURNING *`,
      )
      .get(now());
    return toMessage(row as Row);
  }

  finishMessage(id: string, error?: string) {
    this.db
      .prepare("UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(error ? "failed" : "done", error ?? null, now(), id);
  }

  /** After a crash, messages left mid-processing go back to pending. */
  requeueInterrupted() {
    this.db.prepare("UPDATE messages SET status = 'pending' WHERE status = 'processing'").run();
  }

  // ── threads ────────────────────────────────────────────────────────────────

  threads(conversationId: string): ThreadRecord[] {
    const rows = this.db.prepare("SELECT * FROM threads WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversationId);
    return (rows as Row[]).map((r) => toThread(r)!);
  }

  getThread(id: string): ThreadRecord | undefined {
    return toThread(this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Row);
  }

  findThread(conversationId: string, label: string): ThreadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE conversation_id = ? AND label = ?").get(conversationId, label);
    return toThread(row as Row);
  }

  /**
   * Claims (conversation, label) for a launch. Returns undefined when another launch holds it,
   * so two concurrent deliveries can't spawn two threads. A failed thread may be claimed again.
   */
  claimThread(input: { conversationId: string; label: string; projectId: string; title: string }): ThreadRecord | undefined {
    const time = now();
    const row = this.db
      .prepare(
        `INSERT INTO threads (id, conversation_id, label, project_id, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'launching', ?, ?)
         ON CONFLICT (conversation_id, label) DO UPDATE SET
           project_id = excluded.project_id, title = excluded.title,
           status = 'launching', error = NULL, updated_at = excluded.updated_at
         WHERE threads.status = 'failed'
         RETURNING *`,
      )
      .get(randomUUID(), input.conversationId, input.label, input.projectId, input.title, time, time);
    return toThread(row as Row);
  }

  markThreadLaunched(id: string, t3ThreadId: string) {
    this.db
      .prepare("UPDATE threads SET status = 'launched', t3_thread_id = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(t3ThreadId, now(), id);
  }

  markThreadFailed(id: string, error: string) {
    this.db.prepare("UPDATE threads SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
  }

  /** Marks that a message was just sent to the thread and its answer is owed to the conversation. */
  setAwaiting(id: string, since: string) {
    this.db.prepare("UPDATE threads SET awaiting_since = ?, updated_at = ? WHERE id = ?").run(since, now(), id);
  }

  /** Clears the owed answer unless a newer message arrived meanwhile. Returns whether it cleared. */
  clearAwaiting(id: string, since: string): boolean {
    const result = this.db.prepare("UPDATE threads SET awaiting_since = NULL WHERE id = ? AND awaiting_since = ?").run(id, since);
    return result.changes > 0;
  }

  awaitingThreads(): ThreadRecord[] {
    const rows = this.db.prepare("SELECT * FROM threads WHERE awaiting_since IS NOT NULL AND t3_thread_id IS NOT NULL").all();
    return (rows as Row[]).map((r) => toThread(r)!);
  }

  // ── agent runs ─────────────────────────────────────────────────────────────

  startRun(conversationId: string, trigger: string): AgentRun {
    const row = this.db
      .prepare("INSERT INTO agent_runs (id, conversation_id, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?) RETURNING *")
      .get(randomUUID(), conversationId, trigger, now());
    return toRun(row as Row)!;
  }

  finishRun(id: string, result: { actions: AgentRun["actions"]; outcome?: string; error?: string }) {
    this.db
      .prepare("UPDATE agent_runs SET status = ?, actions = ?, outcome = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(result.error ? "failed" : "done", JSON.stringify(result.actions), result.outcome ?? null, result.error ?? null, now(), id);
  }

  runs(conversationId: string): AgentRun[] {
    const rows = this.db.prepare("SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY started_at, rowid").all(conversationId);
    return (rows as Row[]).map((r) => toRun(r)!);
  }
}

type Row = Record<string, any> | undefined;

function toConversation(row: Row): Conversation | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    state: row.state,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: Row): StoredMessage | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    author: row.author,
    text: row.text,
    inbound: row.inbound ? JSON.parse(row.inbound) : null,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

function toThread(row: Row): ThreadRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    label: row.label,
    projectId: row.project_id,
    title: row.title,
    t3ThreadId: row.t3_thread_id,
    status: row.status,
    error: row.error,
    awaitingSince: row.awaiting_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: Row): AgentRun | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    trigger: row.trigger,
    status: row.status,
    actions: JSON.parse(row.actions),
    outcome: row.outcome,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
