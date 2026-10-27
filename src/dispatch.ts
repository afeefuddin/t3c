import type { Worktree } from "./gateway.ts";
import type { Conversation, Store, ThreadRecord } from "./store.ts";
import type { Project, RuntimeMode, T3, ThreadModel } from "./t3.ts";

export interface LaunchRequest {
  /** Unique within the conversation; launching an existing label returns that thread instead. */
  label: string;
  /** T3 project id or title. */
  project: string;
  title: string;
  prompt: string;
  worktree?: Worktree;
}

export type LaunchResult = { status: "launched" | "existing"; thread: ThreadRecord } | { status: "in_progress"; thread: ThreadRecord };

/** A launch still marked "launching" after this long is treated as interrupted. */
const STALE_LAUNCH_MS = 2 * 60_000;

/** Starts and messages the T3 threads attached to conversations, safely under retries and crashes. */
export class Dispatcher {
  private readonly t3: T3;
  private readonly store: Store;
  private readonly runtimeMode: RuntimeMode;
  private readonly model?: ThreadModel;

  /**
   * `runtimeMode` caps what launched threads may do without approval in T3; `model` is used
   * instead of the project's default model.
   */
  constructor(t3: T3, store: Store, { runtimeMode = "auto-accept-edits", model }: { runtimeMode?: RuntimeMode; model?: ThreadModel } = {}) {
    this.t3 = t3;
    this.store = store;
    this.runtimeMode = runtimeMode;
    this.model = model;
  }

  async launch(conversation: Conversation, request: LaunchRequest): Promise<LaunchResult> {
    let existing = this.store.findThread(conversation.id, request.label);
    if (existing?.status === "launching" && Date.now() - Date.parse(existing.updatedAt) > STALE_LAUNCH_MS) {
      if (!(await this.adopt(existing))) this.store.markThreadFailed(existing.id, "Launch interrupted.");
      existing = this.store.findThread(conversation.id, request.label);
    }
    if (existing?.status === "launched") return { status: "existing", thread: existing };

    const project = await this.resolveProject(request.project);
    const title = `[${conversation.source}] ${request.title}`;
    const claimed = this.store.claimThread({ conversationId: conversation.id, label: request.label, projectId: project.id, title });
    if (!claimed) return { status: "in_progress", thread: this.store.findThread(conversation.id, request.label)! };

    try {
      const { threadId } = await this.t3.launchThread({
        projectId: project.id,
        title,
        message: request.prompt,
        workspaceStrategy: request.worktree ? { type: "worktree", ...request.worktree } : { type: "root" },
        runtimeMode: this.runtimeMode,
        ...(this.model && { modelSelection: { instanceId: this.model.provider, model: this.model.model } }),
      });
      this.store.markThreadLaunched(claimed.id, threadId);
    } catch (error) {
      // t3_thread_launch has no idempotency key: the thread may exist even though the call failed.
      if (!(await this.adopt(claimed))) {
        this.store.markThreadFailed(claimed.id, String(error));
        throw error;
      }
    }
    return { status: "launched", thread: this.store.getThread(claimed.id)! };
  }

  async send(thread: ThreadRecord, text: string) {
    if (!thread.t3ThreadId) throw new Error(`Thread "${thread.label}" hasn't started.`);
    await this.t3.sendToThread(thread.t3ThreadId, text);
  }

  async resolveProject(project: string): Promise<Project> {
    const projects = await this.t3.listProjects();
    const wanted = project.toLowerCase();
    const match = projects.find((p) => p.id === project) ?? projects.find((p) => p.title.toLowerCase() === wanted);
    if (!match) throw new Error(`Unknown T3 project "${project}".`);
    return match;
  }

  /** Finds a thread created for this claim by a launch whose response was lost. */
  private async adopt(record: ThreadRecord): Promise<boolean> {
    try {
      const threads = await this.t3.listThreads(record.projectId, { titleContains: record.title });
      const thread = threads.find((t) => t.title === record.title && t.createdAt >= record.updatedAt);
      if (!thread) return false;
      this.store.markThreadLaunched(record.id, thread.threadId);
      return true;
    } catch {
      return false;
    }
  }
}
