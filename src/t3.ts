import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FileOAuthProvider } from "./auth.ts";

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
}

export type WorkspaceStrategy =
  | { type: "root" }
  | { type: "worktree"; baseRef: string; branch?: string; startFromOrigin?: boolean };

export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export interface LaunchInput {
  projectId: string;
  title: string;
  message: string;
  workspaceStrategy: WorkspaceStrategy;
  runtimeMode: RuntimeMode;
}

/** The slice of T3's orchestration tools the dispatcher needs. */
export interface T3 {
  listProjects(): Promise<Project[]>;
  listThreads(projectId: string, titleContains: string): Promise<ThreadSummary[]>;
  launchThread(input: LaunchInput): Promise<{ threadId: string }>;
  sendToThread(threadId: string, message: string): Promise<void>;
  readThread(threadId: string): Promise<unknown>;
  /** Waits for a run that finished after `since` (ISO time) and returns its final answer. */
  waitForReply(threadId: string, since: string): Promise<ThreadReply>;
  /** The thread's current status and its latest run's last answer, without waiting. */
  latestReply(threadId: string): Promise<ThreadReply>;
}

export interface ThreadReply {
  /** Thread status once it stopped working, e.g. "completed", "waiting", "failed"; "timed_out" if it never did. */
  status: string;
  /** Last assistant message of the latest run, if any. */
  text: string | null;
}

interface ThreadState {
  thread: { status: string; latestRunId: string | null; itemCount: number };
  recentRuns: { runId: string; completedAt: string | null }[];
  items: { type: string; runId: string | null; text: string | null }[];
}

type ToolCaller = Pick<Client, "callTool">;

/** Thread statuses that mean a run is still in progress. */
const WORKING = new Set(["preparing", "queued", "starting", "running"]);
/** Stays under the MCP SDK's 60s default request timeout. */
const WAIT_SLICE_MS = 45_000;
const MAX_WAIT_MS = 2 * 60 * 60_000;

export class T3Client implements T3 {
  private readonly client: ToolCaller;
  private readonly onClose: () => Promise<void>;

  constructor(client: ToolCaller, onClose: () => Promise<void> = async () => {}) {
    this.client = client;
    this.onClose = onClose;
  }

  static async connect(serverUrl: string, authFile: string): Promise<T3Client> {
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      authProvider: new FileOAuthProvider(authFile),
    });
    const client = new Client({ name: "t3c", version: "0.1.0" });
    await client.connect(transport);
    return new T3Client(client, () => transport.close());
  }

  async close() {
    await this.onClose();
  }

  async listProjects() {
    const { projects } = await this.call<{ projects: Project[] }>("t3_project_list", { limit: 100 });
    return projects;
  }

  async listThreads(projectId: string, titleContains: string) {
    const { threads } = await this.call<{ threads: ThreadSummary[] }>("t3_thread_list", {
      projectId,
      titleContains,
      limit: 20,
    });
    return threads;
  }

  async launchThread(input: LaunchInput) {
    const result = await this.call<{ threadId?: string; thread?: { threadId?: string; id?: string } }>(
      "t3_thread_launch",
      { ...input },
    );
    const threadId = result.threadId ?? result.thread?.threadId ?? result.thread?.id;
    if (!threadId) throw new Error(`t3_thread_launch returned no threadId: ${JSON.stringify(result)}`);
    return { threadId };
  }

  async sendToThread(threadId: string, message: string) {
    await this.call("t3_thread_send", { threadId, message, mode: "auto" });
  }

  async readThread(threadId: string) {
    return this.call("t3_thread_read", { threadId, limit: 10, maxCharsPerItem: 4000 });
  }

  async waitForReply(threadId: string, since: string, maxWaitMs = MAX_WAIT_MS): Promise<ThreadReply> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const { thread, recentRuns } = await this.call<ThreadState>("t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 });
      if (thread.status === "waiting") return { status: "waiting", text: null };
      // A message sent with mode "auto" may start a new run or steer the active one; either way
      // its answer is a run that finished after it was sent. An earlier finish is a stale answer.
      const latest = recentRuns.find((r) => r.runId === thread.latestRunId);
      const answered = !WORKING.has(thread.status) && latest?.completedAt != null && latest.completedAt >= since;
      if (answered) return { status: thread.status, text: await this.lastAnswer(threadId, thread) };
      if (Date.now() > deadline) return { status: "timed_out", text: null };
      if (WORKING.has(thread.status)) {
        await this.call("t3_thread_wait", { threadId, timeoutMs: WAIT_SLICE_MS });
      } else {
        // The message's run hasn't started yet.
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async latestReply(threadId: string): Promise<ThreadReply> {
    const { thread } = await this.call<ThreadState>("t3_thread_read", { threadId, limit: 1, maxCharsPerItem: 1 });
    return { status: thread.status, text: await this.lastAnswer(threadId, thread) };
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
    const result = await this.client.callTool({ name, arguments: args });
    const text = Array.isArray(result.content)
      ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
      : "";
    if (result.isError) throw new Error(`${name} failed: ${text || "unknown error"}`);
    if (result.structuredContent) return result.structuredContent as T;
    return JSON.parse(text) as T;
  }
}
