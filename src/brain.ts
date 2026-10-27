import type { StoredMessage, ThreadRecord } from "./store.ts";
import type { ThreadReply } from "./t3.ts";
import { describeReply } from "./agent/prompts.ts";
import type { ConversationTools } from "./agent/tools.ts";

/** Why the agent woke up. */
export type AgentEvent =
  | { type: "message"; message: StoredMessage }
  /** `attempt` counts this thread's waiting/failed/stuck episodes in a row without progress. */
  | { type: "thread_finished"; thread: ThreadRecord; reply: ThreadReply; attempt: number }
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
      if (event.reply.status === "completed" || event.reply.status === "idle") {
        await tools.reply({ text: describeReply(event.reply) });
        return `posted the answer of "${event.thread.label}"`;
      }
      await tools.sendToThread({ label: event.thread.label, text: unblockMessage(event) });
      return `told "${event.thread.label}" (${event.reply.status}) to carry on`;
    }

    const threads = tools.launchedThreads();
    if (threads.length > 0) {
      const latest = threads.at(-1)!;
      await tools.sendToThread({ label: latest.label, text: event.message.text });
      return `sent the follow-up to "${latest.label}"`;
    }

    // Never asks: `in:<project>`, else a project the message names, else the first allowed one.
    const projects = await tools.listProjects();
    if (projects.length === 0) throw new Error("No T3 project is allowed for this conversation.");
    const text = event.message.text.toLowerCase();
    const named = /^in:(\S+)/i.exec(text)?.[1];
    const project =
      projects.find((p) => p.name.toLowerCase() === named) ?? projects.find((p) => text.includes(p.name.toLowerCase())) ?? projects[0];
    const inbound = event.message.inbound!;
    await tools.startThread({ project: project.name, title: inbound.title });
    return `started a thread in ${project.name}`;
  }
}
