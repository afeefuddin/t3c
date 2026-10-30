import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { T3Auth } from "./auth.ts";
import { VERSION } from "./config.ts";

export interface Project {
  id: string;
  title: string;
  workspaceRoot: string;
}

export interface ThreadSummary {
  threadId: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  settled?: boolean;
}

export type WorkspaceStrategy =
  | { type: "root" }
  | { type: "worktree"; baseRef: string; branch?: string; startFromOrigin?: boolean };

export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

/** A T3 provider instance (e.g. "codex", "claudeAgent") and one of its models. */
export interface ThreadModel {
  provider: string;
  model: string;
}

/** A file to hand a thread along with a message. */
export interface Attachment {
  name: string;
  mimeType: string;
  data: Buffer;
}

/** T3 takes images up to 10 MB and other files up to 50 MB, at most 8 per message. */
export const ATTACHMENT_LIMITS = { image: 10 * 1024 * 1024, file: 50 * 1024 * 1024, perMessage: 8 };
const IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export function attachmentType(mimeType: string): "image" | "file" {
  return IMAGE_TYPES.has(mimeType) ? "image" : "file";
}

export interface LaunchInput {
  projectId: string;
  title: string;
  message: string;
  workspaceStrategy: WorkspaceStrategy;
  runtimeMode: RuntimeMode;
  /** Needed when the project has no default model in T3. */
  modelSelection?: { instanceId: string; model: string };
  attachments?: Attachment[];
}

/** The slice of T3's orchestration tools the dispatcher needs. */
export interface T3 {
  listProjects(): Promise<Project[]>;
  /** Newest first. `settled: false` is T3's active list. */
  listThreads(projectId: string, filter: { titleContains?: string; settled?: boolean }): Promise<ThreadSummary[]>;
  launchThread(input: LaunchInput): Promise<{ threadId: string }>;
  sendToThread(threadId: string, message: string, attachments?: Attachment[]): Promise<void>;
  /** Status and the latest messages (the task, its answers and updates), oldest first. */
  recentMessages(threadId: string): Promise<{ status: string; messages: { type: string; text: string | null }[] }>;
  /** Waits for a run that finished after `since` (ISO time) and returns its final answer. */
  waitForReply(threadId: string, since: string): Promise<ThreadReply>;
  /** Current status and latest answer. With `since`, an older completed run still counts as queued. */
  latestReply(threadId: string, since?: string): Promise<ThreadReply>;
  /** Status and how many items (messages, tool calls) it has; a changing count means progress. */
  progress(threadId: string): Promise<{ status: string; items: number }>;
  /** Moves a finished thread out of T3's active list. */
  settleThread(threadId: string): Promise<void>;
  /** Stops the thread's running turn. */
  interruptThread(threadId: string, reason: string): Promise<void>;
}

export interface ThreadReply {
  /** Thread status once it stopped working, e.g. "completed", "waiting", "failed"; "timed_out" if it never did. */
  status: string;
  /** Last assistant message of the latest run, if any. */
  text: string | null;
}

interface ThreadState {
  /** `pendingRequestCount`: questions or approvals the thread is blocked on. */
  thread: { status: string; latestRunId: string | null; itemCount: number; pendingRequestCount?: number };
  recentRuns: { runId: string; completedAt: string | null }[];
  items: { type: string; runId: string | null; text: string | null }[];
}

type ToolCaller = Pick<Client, "callTool">;

/** One connection to T3's MCP server. */
export interface T3Session {
  client: ToolCaller;
  close(): Promise<void>;
}

/** Thread statuses that mean a run is still in progress. */
export const WORKING = new Set(["preparing", "queued", "starting", "running"]);
/** Stays under the MCP SDK's 60s default request timeout. */
const WAIT_SLICE_MS = 45_000;
const MAX_WAIT_MS = 2 * 60 * 60_000;

/**
 * T3's tools over MCP. The connection is opened on first use, and again after one fails: T3 Code
 * may start after t3c, or restart (forgetting the session) while t3c runs.
 */
export class T3Client implements T3 {
  private readonly open: () => Promise<T3Session>;
  private session: Promise<T3Session> | undefined;
  /** T3's HTTP origin, where attachments are uploaded. */
  private readonly origin: string;

  constructor(open: () => Promise<T3Session>, origin = "http://127.0.0.1:3773") {
    this.open = open;
    this.origin = origin;
  }

  /** A client that connects when first used. */
  static lazy(auth: T3Auth): T3Client {
    return new T3Client(async () => {
      const transport = new StreamableHTTPClientTransport(new URL(auth.serverUrl), { fetch: auth.fetch });
      const client = new Client({ name: "t3c", version: VERSION });
      await client.connect(transport);
      return { client, close: () => transport.close() };
    }, new URL(auth.serverUrl).origin);
  }

  /** A client that's connected already, so a CLI command fails right away when T3 isn't there. */
  static async connect(auth: T3Auth): Promise<T3Client> {
    const t3 = T3Client.lazy(auth);
    await t3.connection();
    return t3;
  }

  async close() {
    const session = this.session;
    this.session = undefined;
    await (await session?.catch(() => undefined))?.close();
  }

  private connection(): Promise<T3Session> {
    this.session ??= this.open().catch((error) => {
      this.session = undefined;
      throw error;
    });
    return this.session;
  }

  async listProjects() {
    const { projects } = await this.call<{ projects: Project[] }>("t3_project_list", { limit: 100 });
    return projects;
  }

  /** Models of the providers that are enabled in T3. */
  async listModels(): Promise<(ThreadModel & { label: string })[]> {
    const { providers } = await this.call<{
      providers: { providerInstanceId: string; displayName: string; models: { id: string; label?: string }[]; constraints: string[] }[];
    }>("orchestrator_capabilities", {});
    return providers
      .filter((p) => p.constraints.length === 0)
      .flatMap((p) => p.models.map((m) => ({ provider: p.providerInstanceId, model: m.id, label: `${p.displayName}: ${m.label ?? m.id}` })));
  }

  async listThreads(projectId: string, filter: { titleContains?: string; settled?: boolean }) {
    const { threads } = await this.call<{ threads: ThreadSummary[] }>("t3_thread_list", { projectId, ...filter, limit: 20 });
    return threads;
  }

  async launchThread({ attachments, ...input }: LaunchInput) {
    const result = await this.call<{ threadId?: string; thread?: { threadId?: string; id?: string } }>(
      "t3_thread_launch",
      { ...input, ...(attachments?.length && { attachments: await this.upload(attachments) }) },
    );
    const threadId = result.threadId ?? result.thread?.threadId ?? result.thread?.id;
    if (!threadId) throw new Error(`t3_thread_launch returned no threadId: ${JSON.stringify(result)}`);
    return { threadId };
  }

  async sendToThread(threadId: string, message: string, attachments: Attachment[] = []) {
    // A settled thread is back in the active list once it has work again.
    await this.call("t3_thread_organize", { threadId, action: "unsettle" }).catch(() => {});
    if (attachments.length === 0) await this.call("t3_thread_send", { threadId, message, mode: "auto" });
    else await this.call("t3_thread_send_attachments", { threadId, message, attachments: await this.upload(attachments) });
  }

  /** Uploads each file to a signed URL T3 hands out, for a launch or message to reference. */
  private async upload(attachments: Attachment[]) {
    return Promise.all(
      attachments.slice(0, ATTACHMENT_LIMITS.perMessage).map(async ({ name, mimeType, data }) => {
        const upload = { type: attachmentType(mimeType), name, mimeType, sizeBytes: data.length };
        const { attachmentId, relativeUrl } = await this.call<{ attachmentId: string; relativeUrl: string }>("t3_attachment_prepare_upload", { upload });
        const res = await fetch(new URL(relativeUrl, this.origin), {
          method: "POST",
          headers: { "content-type": mimeType },
          body: new Uint8Array(data),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`Uploading ${name} to T3 failed: ${res.status} ${await res.text()}`);
        return { id: attachmentId, type: upload.type, name, mimeType, sizeBytes: data.length };
      }),
    );
  }

  async progress(threadId: string) {
    const { thread } = await this.call<ThreadState>("t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 });
    return { status: thread.status, items: thread.itemCount };
  }

  async settleThread(threadId: string) {
    await this.call("t3_thread_organize", { threadId, action: "settle" });
  }

  async interruptThread(threadId: string, reason: string) {
    await this.call("t3_thread_interrupt", { threadId, reason: reason.slice(0, 2000) });
  }

  async recentMessages(threadId: string) {
    const { thread } = await this.call<ThreadState>("t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 });
    // Positions are thread-wide; tool calls between messages make up most of the tail.
    const { items } = await this.call<ThreadState>("t3_thread_read", {
      threadId,
      view: "messages",
      afterPosition: Math.max(0, thread.itemCount - 200),
      limit: 100,
      maxCharsPerItem: 1500,
    });
    return { status: thread.status, messages: items.slice(-6).map(({ type, text }) => ({ type, text })) };
  }

  async waitForReply(threadId: string, since: string, maxWaitMs = MAX_WAIT_MS): Promise<ThreadReply> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const { thread, recentRuns } = await this.call<ThreadState>("t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 });
      // Blocked on a question or approval: that's what it's waiting for.
      if ((thread.pendingRequestCount ?? 0) > 0) return { status: "waiting", text: await this.lastAnswer(threadId, thread) };
      // A message sent with mode "auto" may start a new run or steer the active one; either way
      // its answer is a run that finished after it was sent. An earlier finish is a stale answer.
      const latest = recentRuns.find((r) => r.runId === thread.latestRunId);
      const answered = !WORKING.has(thread.status) && latest?.completedAt != null && latest.completedAt >= since;
      // "waiting" with nothing pending is T3 waiting for the next message: the run is done.
      if (answered) return { status: thread.status === "waiting" ? "completed" : thread.status, text: await this.lastAnswer(threadId, thread) };
      if (Date.now() > deadline) return { status: "timed_out", text: null };
      if (WORKING.has(thread.status)) {
        await this.call("t3_thread_wait", { threadId, timeoutMs: WAIT_SLICE_MS });
      } else {
        // The message's run hasn't started yet.
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async latestReply(threadId: string, since?: string): Promise<ThreadReply> {
    const { thread, recentRuns } = await this.call<ThreadState>("t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 });
    const latest = recentRuns.find((r) => r.runId === thread.latestRunId);
    if ((thread.pendingRequestCount ?? 0) > 0) return { status: "waiting", text: await this.lastAnswer(threadId, thread) };
    if (since && ["completed", "idle", "waiting"].includes(thread.status) && (!latest?.completedAt || latest.completedAt < since)) {
      return { status: "queued", text: null };
    }
    const status = thread.status === "waiting" && latest?.completedAt ? "completed" : thread.status;
    return { status, text: await this.lastAnswer(threadId, thread) };
  }

  private async lastAnswer(threadId: string, thread: ThreadState["thread"]): Promise<string | null> {
    // Item positions are thread-wide, so the tail holds the latest run's messages.
    const { items } = await this.call<ThreadState>("t3_thread_read", {
      threadId,
      afterPosition: Math.max(0, thread.itemCount - 50),
      limit: 100,
      maxCharsPerItem: 20_000,
    });
    return items.findLast((i) => i.type === "assistant_message" && i.runId === thread.latestRunId)?.text ?? null;
  }

  private async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const connection = this.connection();
    const session = await connection;
    let result: Awaited<ReturnType<ToolCaller["callTool"]>>;
    try {
      result = await session.client.callTool({ name, arguments: args });
    } catch (error) {
      // The connection failed, not the tool: the next call opens a new one.
      if (this.session === connection) {
        this.session = undefined;
        void session.close().catch(() => {});
      }
      throw error;
    }
    const text = Array.isArray(result.content)
      ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
      : "";
    if (result.isError) throw new Error(`${name} failed: ${text || "unknown error"}`);
    if (result.structuredContent) return result.structuredContent as T;
    return JSON.parse(text) as T;
  }
}
