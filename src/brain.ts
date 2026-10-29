import type { StoredMessage, ThreadRecord } from "./store.ts";
import type { ThreadReply } from "./t3.ts";
import { describeReply } from "./agent/prompts.ts";
import type { ConversationTools } from "./agent/tools.ts";

/** Why the agent woke up. */
export type AgentEvent =
  /** Everything the person sent since the last run, oldest first: often one request in pieces. */
  | { type: "message"; messages: StoredMessage[] }
  /**
   * `attempt` counts this thread's waiting/failed/stuck episodes in a row without progress.
   * `newerWork`: more was sent to the thread after it gave this answer, and it's working on that.
   */
  | { type: "thread_finished"; thread: ThreadRecord; reply: ThreadReply; attempt: number; newerWork?: boolean }
  | { type: "thread_stalled"; thread: ThreadRecord; reply: ThreadReply; idleMinutes: number; attempt: number };

/** What to tell a thread that's waiting, failed or stuck, so it carries on without a person. */
export function unblockMessage(event: Extract<AgentEvent, { type: "thread_finished" | "thread_stalled" }>): string {
  if (event.type === "thread_stalled") {
    return `No progress for ${event.idleMinutes} minutes. If a command is hanging, stop it and try another way. If you're unsure how to proceed, pick the most reasonable option and continue. Nobody is available to answer questions.`;
  }
  if (event.reply.status === "waiting") {
    return "Nobody is available to answer. Choose the most reasonable option yourself, continue, and list your assumptions in your final answer.";
  }
  return `The last run ended with status "${event.reply.status}". Find out what went wrong, fix it, and finish the task.`;
}

/**
 * Decides what to do about an event, acting only through the conversation's tools.
 * Returns a one-line outcome for the log.
 */
export interface Brain {
  readonly name: string;
  handle(event: AgentEvent, tools: ConversationTools): Promise<string>;
}

/**
 * Fixed rules, no AI: a new conversation starts a thread in its project (a message can pick one
 * with `in:<project>` when several are allowed); later messages go to the latest thread; answers
 * are posted back as they are. Also the fallback when the AI brain is unavailable.
 */
export class SimpleBrain implements Brain {
  readonly name = "simple";

  async handle(event: AgentEvent, tools: ConversationTools): Promise<string> {
    if (event.type === "thread_stalled") {
      // A nudge first; a second time, stop the stuck turn and restart it with the same direction.
      if (event.attempt > 1) await tools.interruptThread({ label: event.thread.label, reason: "No progress" });
      await tools.sendToThread({ label: event.thread.label, text: unblockMessage(event) });
      return `${event.attempt > 1 ? "restarted" : "nudged"} stuck thread "${event.thread.label}"`;
    }
    if (event.type === "thread_finished") {
      // Its answer to the newer work will cover this one.
      if (event.newerWork) return `skipped the out-of-date answer of "${event.thread.label}"`;
      if (event.reply.status === "completed" || event.reply.status === "idle") {
        if (await replyOrForward(tools, describeReply(event.reply), event.thread.label)) return `posted the answer of "${event.thread.label}"`;
        return `passed newer messages to "${event.thread.label}" instead of posting its answer`;
      }
      await tools.sendToThread({ label: event.thread.label, text: unblockMessage(event) });
      return `told "${event.thread.label}" (${event.reply.status}) to carry on`;
    }

    const threads = tools.launchedThreads();
    if (threads.length > 0) {
      const latest = threads.at(-1)!;
      await tools.sendToThread({ label: latest.label, text: event.messages.map((m) => m.text).join("\n\n") });
      if (tools.canReply) await replyOrForward(tools, "Got it, on it 👍", latest.label);
      return `sent the follow-up to "${latest.label}"`;
    }

    // Never asks: `in:<project>`, else a project the message names, else the first allowed one.
    const projects = await tools.listProjects();
    if (projects.length === 0) throw new Error("No T3 project is allowed for this conversation.");
    const text = event.messages.map((m) => m.text).join("\n").toLowerCase();
    const named = /^in:(\S+)/i.exec(text)?.[1];
    const project =
      projects.find((p) => p.name.toLowerCase() === named) ?? projects.find((p) => text.includes(p.name.toLowerCase())) ?? projects[0];
    const inbound = event.messages[0].inbound!;
    const { label } = await tools.startThread({ project: project.name, title: inbound.title });
    if (tools.canReply) await replyOrForward(tools, "On it! I'll post here when it's done 👀", label);
    return `started a thread in ${project.name}`;
  }
}

/**
 * Posts `text`, unless the person wrote more while the run was busy: then that goes to the thread
 * instead, and its next answer covers everything. Returns whether `text` was posted.
 */
async function replyOrForward(tools: ConversationTools, text: string, label: string): Promise<boolean> {
  const result = await tools.reply({ text });
  if (result.posted) return true;
  await tools.sendToThread({ label, text: result.newMessages.map((m) => m.text).join("\n\n") });
  return false;
}
