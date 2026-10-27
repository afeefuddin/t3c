import type { LaunchInput, Project, T3, ThreadReply, ThreadSummary } from "../src/t3.ts";

/** In-memory T3: records launches and sends; answers immediately unless `gate` holds them. */
export class FakeT3 implements T3 {
  projects: Project[] = [
    { id: "p1", title: "Demo", workspaceRoot: "/tmp/demo" },
    { id: "p2", title: "Web", workspaceRoot: "/tmp/web" },
  ];
  launches: LaunchInput[] = [];
  sends: { threadId: string; message: string }[] = [];
  threads: ThreadSummary[] = [];
  waits: { threadId: string; since: string }[] = [];
  /** When set, launch creates the thread but then throws (lost response). */
  loseLaunchResponse = false;
  failLaunch = false;
  /** Lets a test hold answers back until it resolves this. */
  gate: Promise<void> = Promise.resolve();
  /** Answers waitForReply hands out in order; then "completed". */
  answers: ThreadReply[] = [];
  /** What progress() reports, per thread id. */
  state = new Map<string, { status: string; items: number }>();
  settled: string[] = [];
  interrupts: { threadId: string; reason: string }[] = [];

  async listProjects() {
    return this.projects;
  }
  async listThreads(_projectId: string, titleContains: string) {
    return this.threads.filter((t) => t.title.includes(titleContains));
  }
  async launchThread(input: LaunchInput) {
    if (this.failLaunch) throw new Error("boom");
    this.launches.push(input);
    const thread = { threadId: `t${this.launches.length}`, title: input.title, status: "running", createdAt: new Date().toISOString() };
    this.threads.push(thread);
    if (this.loseLaunchResponse) throw new Error("socket hang up");
    return { threadId: thread.threadId };
  }
  async sendToThread(threadId: string, message: string) {
    this.sends.push({ threadId, message });
  }
  async readThread() {
    return {};
  }
  async waitForReply(threadId: string, since: string): Promise<ThreadReply> {
    this.waits.push({ threadId, since });
    await this.gate;
    return this.answers.shift() ?? { status: "completed", text: `**Done** in ${threadId}` };
  }
  async progress(threadId: string) {
    return this.state.get(threadId) ?? { status: "completed", items: 1 };
  }
  async settleThread(threadId: string) {
    this.settled.push(threadId);
  }
  async interruptThread(threadId: string, reason: string) {
    this.interrupts.push({ threadId, reason });
  }
  async latestReply(threadId: string): Promise<ThreadReply> {
    return { status: "running", text: `progress in ${threadId}` };
  }
}
