import type { StoredMessage, ThreadRecord } from "./store.ts";
import type { ThreadReply } from "./t3.ts";
import { describeReply } from "./agent/prompts.ts";
import type { ConversationTools } from "./agent/tools.ts";

/** Why the agent woke up. */
export type AgentEvent =
  | { type: "message"; message: StoredMessage }
  | { type: "thread_finished"; thread: ThreadRecord; reply: ThreadReply };

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
    if (event.type === "thread_finished") {
      await tools.reply({ text: describeReply(event.reply) });
      return `posted the answer of "${event.thread.label}"`;
    }

    const threads = tools.launchedThreads();
    if (threads.length > 0) {
      const latest = threads.at(-1)!;
      await tools.sendToThread({ label: latest.label, text: event.message.text });
      return `sent the follow-up to "${latest.label}"`;
    }

    const projects = await tools.listProjects();
    const named = /^in:(\S+)/i.exec(event.message.text)?.[1];
    const project = named ? projects.find((p) => p.name.toLowerCase() === named.toLowerCase()) : projects.length === 1 ? projects[0] : undefined;
    if (!project) {
      const names = projects.map((p) => `\`${p.name}\``).join(", ");
      await tools.askUser({ question: `Which project? Start your message with \`in:<project>\`, one of: ${names || "(none available)"}.` });
      return "asked which project";
    }
    const inbound = event.message.inbound!;
    await tools.startThread({ project: project.name, title: inbound.title });
    return `started a thread in ${project.name}`;
  }
}
