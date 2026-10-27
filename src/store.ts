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
  /** "started" by t3c for this conversation, or an existing T3 thread "attached" to it to message it. */
  origin: "started" | "attached";
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
        origin TEXT NOT NULL DEFAULT 'started',
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
    // Databases from before threads had an origin.
    const threadColumns = this.db.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
    if (!threadColumns.some((c) => c.name === "origin")) this.db.exec("ALTER TABLE threads ADD COLUMN origin TEXT NOT NULL DEFAULT 'started'");
  }

  // ── conversations ──────────────────────────────────────────────────────────

  getConversation(id: string): Conversation | undefined {
    return toConversation(this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row);
  }

  /** A source's conversations with activity since `since` (ISO time), most recent first. */
  recentConversations(source: string, since: string, limit: number): Conversation[] {
    const rows = this.db
      .prepare("SELECT * FROM conversations WHERE source = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?")
      .all(source, since, limit);
    return (rows as Row[]).map((r) => toConversation(r)!);
  }

  /** When the first incoming message arrived in conversations whose external id starts with `prefix`. */
  firstInboundAt(source: string, prefix: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT MIN(m.created_at) AS at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.source = ? AND m.direction = 'in' AND substr(c.external_id, 1, ?) = ?",
      )
      .get(source, prefix.length, prefix) as { at: string | null } | undefined;
    return row?.at ?? undefined;
  }

  /** The first incoming message of a conversation. */
  firstInbound(conversationId: string): StoredMessage | undefined {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY created_at, rowid LIMIT 1")
      .get(conversationId);
    return toMessage(row as Row);
  }

  /** Whether an incoming message with this timestamp (its `meta.ts`, e.g. a Slack message's ts) is stored. */
  hasInbound(conversationId: string, ts: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND direction = 'in' AND json_extract(inbound, '$.meta.ts') = ? LIMIT 1")
      .get(conversationId, ts);
    return Boolean(row);
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

  /**
   * Takes every pending incoming message of one conversation (the given one, or the one with the
   * oldest pending message), marking them processing. Oldest first; empty when nothing is pending.
   */
  takePending(conversationId?: string): StoredMessage[] {
    const rows = this.db
      .prepare(
        `UPDATE messages SET status = 'processing', updated_at = ?
         WHERE status = 'pending' AND conversation_id = coalesce(?,
           (SELECT conversation_id FROM messages WHERE status = 'pending' ORDER BY created_at, rowid LIMIT 1))
         RETURNING *, rowid AS position`,
      )
      .all(now(), conversationId ?? null) as (Row & { position: number })[];
    return rows
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.position - b.position)
      .map((r) => toMessage(r)!);
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

  /** The record of a T3 thread within a conversation, if it's started or attached there. */
  findThreadByT3Id(conversationId: string, t3ThreadId: string): ThreadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE conversation_id = ? AND t3_thread_id = ?").get(conversationId, t3ThreadId);
    return toThread(row as Row);
  }

  /**
   * Attaches an existing T3 thread (started in T3 Code or elsewhere) to a conversation, so it can
   * be messaged and its answers come back there. The label is `label`, or `label-2`… if taken.
   */
  attachThread(input: { conversationId: string; label: string; projectId: string; title: string; t3ThreadId: string }): ThreadRecord {
    const existing = this.findThreadByT3Id(input.conversationId, input.t3ThreadId);
    if (existing) return existing;
    const taken = new Set(this.threads(input.conversationId).map((t) => t.label));
    let label = input.label;
    for (let n = 2; taken.has(label); n++) label = `${input.label}-${n}`;
    const time = now();
    const row = this.db
      .prepare(
        `INSERT INTO threads (id, conversation_id, label, project_id, title, t3_thread_id, status, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'launched', 'attached', ?, ?) RETURNING *`,
      )
      .get(randomUUID(), input.conversationId, label, input.projectId, input.title, input.t3ThreadId, time, time);
    return toThread(row as Row)!;
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
    origin: row.origin ?? "started",
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
