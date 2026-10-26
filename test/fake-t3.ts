import type { LaunchInput, T3, ThreadReply, ThreadSummary } from "../src/t3.ts";

export class FakeT3 implements T3 {
  launches: LaunchInput[] = [];
  sends: { threadId: string; message: string }[] = [];
  threads: ThreadSummary[] = [];
  /** When set, launch creates the thread but then throws (lost response). */
  loseLaunchResponse = false;
  failLaunch = false;

  async listProjects() {
    return [{ id: "p1", title: "Demo", workspaceRoot: "/tmp/demo" }];
  }
  async listThreads(_projectId: string, titleContains: string) {
    return this.threads.filter((t) => t.title.includes(titleContains));
  }
  async launchThread(input: LaunchInput) {
    if (this.failLaunch) throw new Error("boom");
    this.launches.push(input);
    const thread = {
      threadId: `t${this.launches.length}`,
      title: input.title,
      status: "running",
      createdAt: new Date().toISOString(),
    };
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
  waits: { threadId: string; since: string }[] = [];
  /** Lets a test hold replies back until it calls `release`. */
  gate: Promise<void> = Promise.resolve();
  async waitForReply(threadId: string, since: string): Promise<ThreadReply> {
    this.waits.push({ threadId, since });
    await this.gate;
    return { status: "completed", text: `**Done** in ${threadId}` };
  }
}
