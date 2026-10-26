import type { Worktree } from "./gateway.ts";
import type { Store, TaskRecord } from "./store.ts";
import type { RuntimeMode, T3 } from "./t3.ts";

/** Unit of work handed to T3: one external conversation maps to one thread. */
export interface Task {
  /** Gateway name, e.g. "slack". */
  source: string;
  /** Stable id of the external conversation. Repeats become follow-ups. */
  externalId: string;
  /** T3 project id or title. */
  project: string;
  title: string;
  prompt: string;
  /** Run in a new worktree instead of the project checkout. */
  worktree?: Worktree;
}

export type DispatchResult =
  | { action: "launched"; task: TaskRecord }
  | { action: "followed_up"; task: TaskRecord }
  | { action: "in_progress"; task: TaskRecord };

/** A launch still marked "launching" after this long is treated as interrupted. */
const STALE_LAUNCH_MS = 2 * 60_000;

export class Dispatcher {
  private readonly t3: T3;
  private readonly store: Store;
  private readonly runtimeMode: RuntimeMode;

  /** `runtimeMode` caps what launched threads may do without approval in T3. */
  constructor(t3: T3, store: Store, runtimeMode: RuntimeMode = "auto-accept-edits") {
    this.t3 = t3;
    this.store = store;
    this.runtimeMode = runtimeMode;
  }

  async dispatch(task: Task): Promise<DispatchResult> {
    let existing = this.store.find(task.source, task.externalId);

    if (existing?.status === "launching" && age(existing) > STALE_LAUNCH_MS) {
      if (!(await this.adoptLaunchedThread(existing))) this.store.markFailed(existing.id, "Launch interrupted.");
      existing = this.store.find(task.source, task.externalId);
    }
    if (existing?.status === "launched" && existing.threadId) {
      await this.t3.sendToThread(existing.threadId, task.prompt);
      return { action: "followed_up", task: existing };
    }

    const projectId = await this.resolveProject(task.project);
    const title = `[${task.source}] ${task.title}`;
    const claimed = this.store.claim({ source: task.source, externalId: task.externalId, projectId, title });
    if (!claimed) return { action: "in_progress", task: this.store.find(task.source, task.externalId)! };

    try {
      const { threadId } = await this.t3.launchThread({
        projectId,
        title,
        message: task.prompt,
        workspaceStrategy: task.worktree ? { type: "worktree", ...task.worktree } : { type: "root" },
        runtimeMode: this.runtimeMode,
      });
      this.store.markLaunched(claimed.id, threadId);
    } catch (error) {
      // t3_thread_launch has no idempotency key: the thread may exist even though the call failed.
      if (!(await this.adoptLaunchedThread(claimed))) {
        this.store.markFailed(claimed.id, String(error));
        throw error;
      }
    }
    return { action: "launched", task: this.store.get(claimed.id)! };
  }

  private async resolveProject(project: string): Promise<string> {
    const projects = await this.t3.listProjects();
    const wanted = project.toLowerCase();
    const match = projects.find((p) => p.id === project) ?? projects.find((p) => p.title.toLowerCase() === wanted);
    if (!match) throw new Error(`Unknown T3 project "${project}".`);
    return match.id;
  }

  /** Finds a thread created for this claim by a launch whose response was lost. */
  private async adoptLaunchedThread(record: TaskRecord): Promise<boolean> {
    try {
      const threads = await this.t3.listThreads(record.projectId, record.title);
      const thread = threads.find((t) => t.title === record.title && t.createdAt >= record.updatedAt);
      if (!thread) return false;
      this.store.markLaunched(record.id, thread.threadId);
      return true;
    } catch {
      return false;
    }
  }
}

function age(record: TaskRecord) {
  return Date.now() - Date.parse(record.updatedAt);
}
