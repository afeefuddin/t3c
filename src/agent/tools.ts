import type { Dispatcher } from "../dispatch.ts";
import type { Gateway, InboundMessage, Preparation } from "../gateway.ts";
import { log } from "../log.ts";
import type { AgentRun, Conversation, Store, ThreadRecord } from "../store.ts";
import type { T3 } from "../t3.ts";
import { threadPrompt } from "./prompts.ts";

/** Per-run caps, so a confused or manipulated run can't spam or fan out. */
export const LIMITS = { replies: 3, launches: 3, replyChars: 400 };

const ACTING_TOOLS = new Set(["start_thread", "send_to_thread", "interrupt_thread", "reply"]);

export interface ToolContext {
  store: Store;
  dispatcher: Dispatcher;
  t3: T3;
  gateway: Gateway;
  conversation: Conversation;
}

/**
 * Everything an agent run may do, bound to ONE conversation: it can only read that
 * conversation, reply into it, and start or message the T3 threads attached to it, in the
 * projects its gateway allows. Every call is recorded in `actions` for the agent_runs log.
 */
export class ConversationTools {
  readonly actions: AgentRun["actions"] = [];
  private readonly ctx: ToolContext;
  private replies = 0;
  private launches = 0;
  private preparation: Promise<Preparation> | undefined;
  /** Threads list_threads showed this run, by T3 id: the only ones inspect_thread may read. */
  private readonly listed = new Set<string>();

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  get conversation() {
    return this.ctx.conversation;
  }

  /** Whether this conversation can be replied to (an http caller reads results instead). */
  get canReply() {
    return Boolean(this.ctx.gateway.reply);
  }

  get repliesSent() {
    return this.replies;
  }

  /** Whether the run changed anything (started/messaged a thread, posted, asked). */
  get acted() {
    return this.actions.some((a) => ACTING_TOOLS.has(a.tool) && !a.error);
  }

  /** Summary, state, attached threads and recent messages. */
  getConversation() {
    return this.record("get_conversation", {}, () => {
      const { store, conversation } = this.ctx;
      const current = store.getConversation(conversation.id)!;
      return {
        source: current.source,
        state: current.state,
        summary: current.summary,
        threads: store.threads(current.id).map(describeThread),
        messages: store.messages(current.id).map((m) => ({ direction: m.direction, author: m.author, text: m.text, at: m.createdAt })),
      };
    });
  }

  /** The source conversation as the platform has it now (Slack thread, GitHub issue and comments). */
  fetchSource() {
    return this.record("fetch_source", {}, async () => (await this.prepare()).context ?? "(no earlier messages)");
  }

  /** T3 projects this conversation may work in. */
  listProjects() {
    return this.record("list_projects", {}, async () => (await this.allowedProjects()).map((p) => ({ name: p.title, path: p.workspaceRoot })));
  }

  /** Status and latest answer of an attached thread. */
  readThread(input: { label: string }) {
    return this.record("read_thread", input, async () => {
      const thread = this.thread(input.label);
      return { ...describeThread(thread), ...(thread.t3ThreadId ? await this.ctx.t3.latestReply(thread.t3ThreadId) : {}) };
    });
  }

  /**
   * Active T3 threads in the projects this conversation may work in, started anywhere (by people
   * in T3 Code, or from other conversations), newest first. Read-only.
   */
  listThreads() {
    return this.record("list_threads", {}, async () => {
      const own = new Map(this.ctx.store.threads(this.ctx.conversation.id).map((t) => [t.t3ThreadId, t.label]));
      const lists = await Promise.all(
        (await this.allowedProjects()).map(async (p) =>
          (await this.ctx.t3.listThreads(p.id, { settled: false })).map((t) => ({ ...t, project: p.title })),
        ),
      );
      return lists.flat().map(({ threadId, title, status, createdAt, project }) => {
        this.listed.add(threadId);
        return { threadId, title, project, status, startedAt: createdAt, ...(own.has(threadId) ? { label: own.get(threadId) } : {}) };
      });
    });
  }

  /** Status and latest messages of a thread from list_threads, without disturbing it. */
  inspectThread(input: { threadId: string }) {
    return this.record("inspect_thread", input, async () => {
      if (!this.listed.has(input.threadId)) throw new Error("Unknown thread. Use a threadId from list_threads.");
      return this.ctx.t3.recentMessages(input.threadId);
    });
  }

  /**
   * Starts a T3 thread for this conversation with the agent's `prompt`, written from the
   * conversation. Without one (fixed rules), the request goes in word for word with the
   * conversation fenced off as untrusted. Its answer will come back as an event.
   */
  startThread(input: { project: string; title: string; prompt?: string; label?: string }) {
    return this.record("start_thread", input, async () => {
      if (this.launches >= LIMITS.launches) throw new Error(`At most ${LIMITS.launches} threads per run.`);
      const projects = await this.allowedProjects();
      const project = projects.find((p) => p.title.toLowerCase() === input.project.toLowerCase());
      if (!project) throw new Error(`"${input.project}" isn't allowed here. Allowed: ${projects.map((p) => p.title).join(", ") || "none"}.`);

      const { store, conversation, dispatcher } = this.ctx;
      const label = input.label ?? (store.threads(conversation.id).length === 0 ? "main" : slug(project.title));
      const preparation = await this.prepare();
      const worktree =
        preparation.worktree?.branch && label !== "main"
          ? { ...preparation.worktree, branch: `${preparation.worktree.branch}-${slug(label)}` }
          : preparation.worktree;

      const sentAt = new Date().toISOString();
      const result = await dispatcher.launch(conversation, {
        label,
        project: project.title,
        title: input.title,
        prompt: input.prompt
          ? threadPrompt(input.prompt, { instructions: preparation.instructions })
          : threadPrompt(this.latestInbound().text, preparation),
        worktree,
      });
      if (result.status === "in_progress") throw new Error(`Thread "${label}" is still starting.`);
      if (result.status === "launched") {
        this.launches++;
        store.setAwaiting(result.thread.id, sentAt);
        log(conversation.source, `→ started T3 thread ${result.thread.t3ThreadId} in ${project.title} (${conversation.externalId})`, "ok");
      }
      return { ...describeThread(store.getThread(result.thread.id)!), alreadyExisted: result.status === "existing" };
    });
  }

  /** Sends a message to an attached thread; its answer will come back as an event. */
  sendToThread(input: { label: string; text: string }) {
    return this.record("send_to_thread", input, async () => {
      const thread = this.thread(input.label);
      const sentAt = new Date().toISOString();
      await this.ctx.dispatcher.send(thread, input.text);
      this.ctx.store.setAwaiting(thread.id, sentAt);
      log(this.ctx.conversation.source, `→ sent follow-up to T3 thread ${thread.t3ThreadId} (${thread.label})`, "ok");
      return { sent: true, thread: thread.label };
    });
  }

  /** Stops a thread's running turn, e.g. when it's stuck. Send it a message afterwards to restart it. */
  interruptThread(input: { label: string; reason: string }) {
    return this.record("interrupt_thread", input, async () => {
      const thread = this.thread(input.label);
      await this.ctx.t3.interruptThread(thread.t3ThreadId!, input.reason);
      log(this.ctx.conversation.source, `⏹ interrupted T3 thread ${thread.t3ThreadId} (${thread.label}): ${input.reason}`, "warn");
      return { interrupted: true, thread: thread.label };
    });
  }

  /** Posts into this conversation (Markdown). */
  reply(input: { text: string }) {
    return this.record("reply", input, () => {
      // Chat replies are read on a phone between other things: anything longer gets rewritten.
      if (input.text.length > LIMITS.replyChars) {
        throw new Error(
          `Too long for chat (${input.text.length} characters, max ${LIMITS.replyChars}). Rewrite it as one or two short sentences with just the answer.`,
        );
      }
      return this.post(input.text);
    });
  }

  /** Replaces the agent's running notes about this conversation. */
  updateSummary(input: { summary: string }) {
    return this.record("update_summary", input, () => {
      this.ctx.store.updateConversation(this.ctx.conversation.id, { summary: input.summary.slice(0, 4_000) });
      return { saved: true };
    });
  }

  launchedThreads(): ThreadRecord[] {
    return this.ctx.store.threads(this.ctx.conversation.id).filter((t) => t.status === "launched");
  }

  private async allowedProjects() {
    const allowed = this.latestInbound().projects;
    const projects = await this.ctx.t3.listProjects();
    return allowed.includes("*")
      ? projects
      : projects.filter((p) => allowed.some((a) => a === p.id || a.toLowerCase() === p.title.toLowerCase()));
  }

  private async post(text: string) {
    const { gateway, store, conversation } = this.ctx;
    if (!gateway.reply) throw new Error(`${gateway.name} conversations can't be replied to.`);
    if (this.replies >= LIMITS.replies) throw new Error(`At most ${LIMITS.replies} replies per run.`);
    this.replies++;
    await gateway.reply(conversation.externalId, text);
    store.addOutbound(conversation.id, "t3bot", text);
    return { posted: true };
  }

  private thread(label: string): ThreadRecord {
    const thread = this.ctx.store.findThread(this.ctx.conversation.id, label);
    if (!thread || thread.status !== "launched") {
      const labels = this.launchedThreads().map((t) => t.label);
      throw new Error(`No running thread "${label}" in this conversation. Threads: ${labels.join(", ") || "none"}.`);
    }
    return thread;
  }

  /** The newest incoming message: the request being worked on, and the gateway details for it. */
  private latestInbound(): InboundMessage {
    const latest = this.ctx.store
      .messages(this.ctx.conversation.id, 100)
      .findLast((m) => m.direction === "in" && m.inbound);
    if (!latest?.inbound) throw new Error("This conversation has no incoming message.");
    return latest.inbound;
  }

  private prepare(): Promise<Preparation> {
    this.preparation ??= this.ctx.gateway.prepare?.(this.latestInbound()) ?? Promise.resolve({});
    return this.preparation;
  }

  private async record<T>(tool: string, input: unknown, fn: () => T | Promise<T>): Promise<Awaited<T>> {
    try {
      const result = await fn();
      this.actions.push({ tool, input, result: summarize(result) });
      return result;
    } catch (error) {
      this.actions.push({ tool, input, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

function describeThread(t: ThreadRecord) {
  return { label: t.label, title: t.title, status: t.status, waitingForAnswer: t.awaitingSince !== null, error: t.error };
}

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "thread";
}

/** Keeps the run log small: long strings are cut. */
function summarize(value: unknown): unknown {
  const json = JSON.stringify(value) ?? "null";
  return json.length > 2_000 ? `${json.slice(0, 2_000)}…` : value;
}
