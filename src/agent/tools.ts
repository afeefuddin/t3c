import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Dispatcher } from "../dispatch.ts";
import type { FileRef, Gateway, InboundMessage, Preparation, Worktree } from "../gateway.ts";
import { errorMessage, log } from "../log.ts";
import type { AgentRun, Conversation, Store, StoredMessage, ThreadRecord } from "../store.ts";
import { ATTACHMENT_LIMITS, type Attachment, attachmentType, type T3 } from "../t3.ts";
import { threadPrompt } from "./prompts.ts";
import type { Skill } from "./skills.ts";

/** Per-run caps, so a confused or manipulated run can't spam or fan out. */
export const LIMITS = { replies: 3, launches: 3, replyChars: 400 };

const ACTING_TOOLS = new Set(["start_thread", "send_to_thread", "interrupt_thread", "reply"]);

export interface ToolContext {
  store: Store;
  dispatcher: Dispatcher;
  t3: T3;
  gateway: Gateway;
  conversation: Conversation;
  /** Files sent with the messages this run handles; they go to whichever thread gets the work. */
  requestFiles?: FileRef[];
}

/**
 * Everything an agent run may do, bound to ONE conversation: it can only read that
 * conversation, reply into it, and start or message the T3 threads attached to it, in the
 * projects its gateway allows. Every call is recorded in `actions` for the agent_runs log.
 */
export class ConversationTools {
  readonly actions: AgentRun["actions"] = [];
  /** Messages that arrived while the run was busy and that it took in (see reply). */
  readonly lateMessages: StoredMessage[] = [];
  private readonly ctx: ToolContext;
  /** Files sent with the messages this run handles; they go to whichever thread gets the work. */
  private readonly requestFiles: FileRef[];
  private replies = 0;
  private launches = 0;
  private preparation: Promise<Preparation> | undefined;
  /** Threads list_threads showed this run, by T3 id: the only others the run may read or message. */
  private readonly listed = new Map<string, { projectId: string; title: string }>();
  /** Per thread, how many of the request's files this run already handed it. */
  private readonly filesSent = new Map<string, number>();
  /** Downloads by url, so the agent's images and a thread's attachments are fetched once. */
  private readonly downloads = new Map<string, Promise<Attachment | undefined>>();

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
    this.requestFiles = [...(ctx.requestFiles ?? [])];
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

  /** A skill's instructions, from the skills listed in this run's prompt. */
  loadSkill(input: { name: string }, skills: Skill[]) {
    return this.record("load_skill", input, () => {
      const skill = skills.find((s) => s.name === input.name);
      if (!skill) throw new Error(`No skill "${input.name}". Skills: ${skills.map((s) => s.name).join(", ") || "none"}.`);
      return skill.body;
    });
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

  /** The earlier platform conversation, if any, without recording a tool call: for the agent's prompt. */
  async source(): Promise<string | undefined> {
    return (await this.prepare()).context;
  }

  /**
   * The images in the conversation (the request's and the earlier ones), newest kept, so the
   * agent can look at the screenshots people share. Without recording a tool call.
   */
  async images(): Promise<Attachment[]> {
    const files = [...((await this.prepare()).files ?? []), ...this.requestFiles];
    const images = files.filter((f) => attachmentType(f.mimeType) === "image");
    return this.download(images.slice(-ATTACHMENT_LIMITS.perMessage));
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
   * T3 threads in the projects this conversation may work in, started anywhere (by people in T3
   * Code, or from other conversations), newest first. Read-only. Without `search`, the active ones;
   * with it, every thread whose title contains it, finished ones included.
   */
  listThreads(input: { search?: string } = {}) {
    return this.record("list_threads", input, async () => {
      const own = new Map(this.ctx.store.threads(this.ctx.conversation.id).map((t) => [t.t3ThreadId, t.label]));
      const filter = input.search?.trim() ? { titleContains: input.search.trim() } : { settled: false };
      const lists = await Promise.all(
        (await this.allowedProjects()).map(async (p) =>
          (await this.ctx.t3.listThreads(p.id, filter)).map((t) => ({ ...t, project: p.title, projectId: p.id })),
        ),
      );
      return lists.flat().map(({ threadId, title, status, settled, createdAt, updatedAt, project, projectId }) => {
        this.listed.set(threadId, { projectId, title });
        return {
          threadId,
          title,
          project,
          status,
          ...(settled ? { finished: true } : {}),
          lastActive: updatedAt ?? createdAt,
          ...(own.has(threadId) ? { label: own.get(threadId) } : {}),
        };
      });
    });
  }

  /** Status and latest messages of a thread from list_threads, without disturbing it. */
  inspectThread(input: { threadId: string }) {
    return this.record("inspect_thread", input, async () => {
      const own = this.ctx.store.findThreadByT3Id(this.ctx.conversation.id, input.threadId);
      if (!own && !this.listed.has(input.threadId)) throw new Error("Unknown thread. Use a threadId from list_threads.");
      return this.ctx.t3.recentMessages(input.threadId);
    });
  }

  /**
   * Starts a T3 thread for this conversation with the agent's `prompt`, written from the
   * conversation. Without one (fixed rules), the request goes in word for word with the
   * conversation fenced off as untrusted. Its answer will come back as an event.
   */
  startThread(input: { project: string; title: string; prompt?: string; label?: string; worktree?: boolean }) {
    return this.record("start_thread", input, async () => {
      if (this.launches >= LIMITS.launches) throw new Error(`At most ${LIMITS.launches} threads per run.`);
      const projects = await this.allowedProjects();
      const project = projects.find((p) => p.title.toLowerCase() === input.project.toLowerCase());
      if (!project) throw new Error(`"${input.project}" isn't allowed here. Allowed: ${projects.map((p) => p.title).join(", ") || "none"}.`);

      const { store, conversation, dispatcher } = this.ctx;
      const label = input.label ?? (store.threads(conversation.id).length === 0 ? "main" : slug(project.title));
      const preparation = await this.prepare();
      // The gateway's worktree (GitHub issues and PRs) wins; otherwise one on request, else the checkout.
      const worktree = preparation.worktree
        ? preparation.worktree.branch && label !== "main"
          ? { ...preparation.worktree, branch: `${preparation.worktree.branch}-${slug(label)}` }
          : preparation.worktree
        : input.worktree
          ? await newWorktree(project.workspaceRoot, `t3c/${slug(input.title).slice(0, 40)}-${conversation.id.slice(0, 6)}`)
          : undefined;

      const sentAt = new Date().toISOString();
      // Everything shared in the conversation so far, newest kept when there are too many.
      const files = [...(preparation.files ?? []), ...this.requestFiles];
      const result = await dispatcher.launch(conversation, {
        label,
        project: project.title,
        title: input.title,
        prompt: input.prompt
          ? threadPrompt(input.prompt, { instructions: preparation.instructions })
          : threadPrompt(this.latestInbound().text, preparation),
        worktree,
        attachments: await this.download(files.slice(-ATTACHMENT_LIMITS.perMessage)),
      });
      if (result.status === "in_progress") throw new Error(`Thread "${label}" is still starting.`);
      if (result.status === "launched") {
        this.launches++;
        this.filesSent.set(result.thread.id, this.requestFiles.length);
        store.setAwaiting(result.thread.id, sentAt);
        log(conversation.source, `→ started T3 thread ${result.thread.t3ThreadId} in ${project.title} (${conversation.externalId})`, "ok");
      }
      return { ...describeThread(store.getThread(result.thread.id)!), alreadyExisted: result.status === "existing" };
    });
  }

  /**
   * Sends a message to a thread of this conversation (by label), or to any thread list_threads
   * showed this run (by threadId), which is then attached to this conversation under a label.
   * Either way its answer will come back as an event.
   */
  sendToThread(input: { label?: string; threadId?: string; text: string }) {
    return this.record("send_to_thread", input, async () => {
      if (!input.threadId && !input.label) throw new Error("Give the thread's label, or a threadId from list_threads.");
      const thread = input.threadId ? this.attach(input.threadId) : this.thread(input.label!);
      const sentAt = new Date().toISOString();
      const files = this.requestFiles.slice(this.filesSent.get(thread.id) ?? 0);
      await this.ctx.dispatcher.send(thread, input.text, await this.download(files.slice(-ATTACHMENT_LIMITS.perMessage)));
      this.filesSent.set(thread.id, this.requestFiles.length);
      this.ctx.store.setAwaiting(thread.id, sentAt);
      log(this.ctx.conversation.source, `→ sent follow-up to T3 thread ${thread.t3ThreadId} (${thread.label})`, "ok");
      return { sent: true, thread: thread.label };
    });
  }

  /**
   * Stops a thread's running turn, and with it the wait for its answer: a thread that was called off
   * doesn't come back as finished. Send it a message afterwards to restart it.
   */
  interruptThread(input: { label: string; reason: string }) {
    return this.record("interrupt_thread", input, async () => {
      const thread = this.thread(input.label);
      await this.ctx.t3.interruptThread(thread.t3ThreadId!, input.reason);
      const since = this.ctx.store.getThread(thread.id)?.awaitingSince;
      if (since) this.ctx.store.clearAwaiting(thread.id, since);
      log(this.ctx.conversation.source, `⏹ interrupted T3 thread ${thread.t3ThreadId} (${thread.label}): ${input.reason}`, "warn");
      return { interrupted: true, thread: thread.label };
    });
  }

  /**
   * Posts into this conversation (Markdown). If the person wrote more since this run began, that
   * comes back instead and nothing is posted: chat is read top to bottom, so the run decides, with
   * the new messages in view, whether to post as is (calling reply again), rewrite, or pass them to
   * a thread first. They're this run's to handle from then on.
   */
  reply(input: { text: string }) {
    return this.record("reply", input, async (): Promise<{ posted: true } | { posted: false; newMessages: { author: string; text: string }[]; note: string }> => {
      // Chat replies are read on a phone between other things: anything longer gets rewritten.
      if (input.text.length > LIMITS.replyChars) {
        throw new Error(
          `Too long for chat (${input.text.length} characters, max ${LIMITS.replyChars}). Rewrite it as one or two short sentences with just the answer.`,
        );
      }
      const late = this.ctx.store.takePending(this.ctx.conversation.id);
      if (late.length === 0) return this.post(input.text);
      this.lateMessages.push(...late);
      this.requestFiles.push(...late.flatMap((m) => m.inbound?.files ?? []));
      return {
        posted: false,
        newMessages: late.map((m) => ({ author: m.author, text: m.text })),
        note:
          "Not posted: they wrote this after you started, below where your reply would go. Handle it in this run, " +
          "it won't come back as its own event. Post as is (call reply again), rewrite the reply to cover it, " +
          "or send_to_thread first and let that answer cover everything.",
      };
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

  private async post(text: string): Promise<{ posted: true }> {
    const { gateway, store, conversation } = this.ctx;
    if (!gateway.reply) throw new Error(`${gateway.name} conversations can't be replied to.`);
    if (this.replies >= LIMITS.replies) throw new Error(`At most ${LIMITS.replies} replies per run.`);
    this.replies++;
    await gateway.reply(conversation.externalId, text);
    store.addOutbound(conversation.id, "t3bot", text);
    return { posted: true };
  }

  /** A thread from list_threads as one of this conversation's, attaching it if it isn't yet. */
  private attach(threadId: string): ThreadRecord {
    const { store, conversation } = this.ctx;
    const own = store.findThreadByT3Id(conversation.id, threadId);
    if (own) return own;
    const listed = this.listed.get(threadId);
    if (!listed) throw new Error("Unknown thread. Use a threadId from list_threads.");
    const thread = store.attachThread({ conversationId: conversation.id, label: slug(listed.title).slice(0, 40), t3ThreadId: threadId, ...listed });
    log(conversation.source, `↔ attached T3 thread ${threadId} as "${thread.label}" (${conversation.externalId})`);
    return thread;
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

  /** Fetches files through the gateway, skipping (and logging) any that are too big or fail. */
  private async download(files: FileRef[]): Promise<Attachment[]> {
    const { gateway, conversation } = this.ctx;
    if (!gateway.download || files.length === 0) return [];
    const unique = [...new Map(files.map((f) => [f.url, f])).values()];
    const fetch = async (file: FileRef): Promise<Attachment | undefined> => {
      if (file.size > ATTACHMENT_LIMITS[attachmentType(file.mimeType)]) {
        log(conversation.source, `skipped ${file.name}: too big to attach (${file.size} bytes)`, "warn");
        return;
      }
      try {
        return { name: file.name, mimeType: file.mimeType, data: await gateway.download!(file) };
      } catch (error) {
        log(conversation.source, `couldn't fetch ${file.name}: ${errorMessage(error)}`, "warn");
      }
    };
    const fetched = await Promise.all(
      unique.map((file) => {
        let pending = this.downloads.get(file.url);
        if (!pending) this.downloads.set(file.url, (pending = fetch(file)));
        return pending;
      }),
    );
    return fetched.filter((f) => f !== undefined);
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
  return {
    label: t.label,
    title: t.title,
    status: t.status,
    ...(t.origin === "attached" ? { attached: true } : {}),
    waitingForAnswer: t.awaitingSince !== null,
    error: t.error,
  };
}

/** A fresh worktree on `branch`, from the latest default branch on origin (or the current one). */
async function newWorktree(root: string, branch: string): Promise<Worktree> {
  const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", root, ...args])).stdout.trim();
  try {
    return { baseRef: (await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, ""), branch, startFromOrigin: true };
  } catch {
    // No origin/HEAD (no remote, or never fetched): branch off what's checked out.
  }
  try {
    return { baseRef: await git("rev-parse", "--abbrev-ref", "HEAD"), branch };
  } catch {
    throw new Error(`${root} isn't a git repository, so its threads can't get a worktree. Start it without one.`);
  }
}

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "thread";
}

/** Keeps the run log small: long strings are cut. */
function summarize(value: unknown): unknown {
  const json = JSON.stringify(value) ?? "null";
  return json.length > 2_000 ? `${json.slice(0, 2_000)}…` : value;
}
