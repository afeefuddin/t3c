import type { AgentEvent, Brain } from "./brain.ts";
import type { Dispatcher } from "./dispatch.ts";
import type { Gateway, InboundMessage } from "./gateway.ts";
import { errorMessage, log, preview } from "./log.ts";
import type { Conversation, Store, StoredMessage, ThreadRecord } from "./store.ts";
import type { T3 } from "./t3.ts";
import { ConversationTools } from "./agent/tools.ts";

/**
 * Wakes the brain on events and keeps everything durable:
 * - a new message (saved by the webhook) → brain run
 * - a T3 thread finished answering → brain run
 * Runs for the same conversation never overlap; after a restart, unprocessed messages and
 * owed answers resume.
 */
export class Worker {
  private readonly gateways: Map<string, Gateway>;
  private readonly dispatcher: Dispatcher;
  private readonly store: Store;
  private readonly t3: T3;
  private readonly brain: Brain;
  private draining: Promise<void> | undefined;
  /** Per-conversation queues, so runs in one conversation happen one at a time. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Threads with a watcher waiting for their answer. */
  private readonly watching = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(deps: { gateways: Gateway[]; dispatcher: Dispatcher; store: Store; t3: T3; brain: Brain }) {
    this.gateways = new Map(deps.gateways.map((g) => [g.name, g]));
    this.dispatcher = deps.dispatcher;
    this.store = deps.store;
    this.t3 = deps.t3;
    this.brain = deps.brain;
  }

  /** Resumes work interrupted by a restart. */
  start() {
    this.store.requeueInterrupted();
    const owed = this.store.awaitingThreads();
    if (owed.length > 0) log("t3c", `resuming ${owed.length} answer(s) still owed from before the restart`);
    for (const thread of owed) this.watch(thread);
    this.kick();
  }

  /** Saves a message and schedules it. Returns undefined for a delivery seen before. */
  enqueue(message: InboundMessage): StoredMessage | undefined {
    const stored = this.store.enqueue(message);
    if (!stored) {
      log(message.source, `↺ duplicate delivery ${message.eventKey}, ignored`);
      return;
    }
    log(message.source, `← ${message.user} in ${message.conversationId}: ${preview(message.text)}`);
    this.kick();
    return stored;
  }

  /** Resolves once nothing is queued, running or being watched (for tests and shutdown). */
  async idle() {
    while (this.draining || this.pending.size > 0) {
      await this.draining;
      await Promise.all(this.pending);
    }
  }

  private kick() {
    this.draining ??= this.drain().finally(() => (this.draining = undefined));
  }

  private async drain() {
    for (let message = this.store.nextPending(); message; message = this.store.nextPending()) {
      const conversation = this.store.getConversation(message.conversationId)!;
      if (!this.gateways.has(conversation.source)) {
        // e.g. a gateway removed from the config while messages from it were queued.
        log("t3c", `skipping a message from "${conversation.source}": that gateway isn't configured`, "warn");
        this.store.finishMessage(message.id, `No gateway "${conversation.source}" is configured.`);
        continue;
      }
      const error = await this.locked(conversation.id, async () => {
        this.store.updateConversation(conversation.id, { state: "active" });
        const gateway = this.gateway(conversation.source);
        await gateway.acknowledge?.(message.inbound!).catch((e) => log(gateway.name, `couldn't react: ${errorMessage(e)}`, "warn"));
        return this.run(conversation, { type: "message", message });
      });
      this.store.finishMessage(message.id, error);
    }
  }

  /** One brain run with conversation-scoped tools, recorded in agent_runs. Returns an error message, if any. */
  private async run(conversation: Conversation, event: AgentEvent): Promise<string | undefined> {
    const gateway = this.gateway(conversation.source);
    const tools = new ConversationTools({ store: this.store, dispatcher: this.dispatcher, t3: this.t3, gateway, conversation });
    const run = this.store.startRun(conversation.id, event.type);
    try {
      const outcome = await this.brain.handle(event, tools);
      this.store.finishRun(run.id, { actions: tools.actions, outcome });
      log(conversation.source, `✓ ${this.brain.name}: ${outcome} (${conversation.externalId})`);
      return;
    } catch (error) {
      const message = errorMessage(error);
      this.store.finishRun(run.id, { actions: tools.actions, error: message });
      log(conversation.source, `✗ ${conversation.externalId}: ${message}`, "error");
      if (tools.repliesSent === 0 && gateway.reply) {
        await gateway
          .reply(conversation.externalId, `Something went wrong: ${message}`)
          .catch((e) => log(gateway.name, `✗ couldn't post the error: ${errorMessage(e)}`, "error"));
      }
      return message;
    } finally {
      for (const thread of this.store.threads(conversation.id)) if (thread.awaitingSince) this.watch(thread);
    }
  }

  /** Waits for a thread's owed answer, then wakes the brain with it. Newer follow-ups extend the wait. */
  private watch(thread: ThreadRecord) {
    if (this.watching.has(thread.id) || !thread.t3ThreadId) return;
    // Gateways without replies (http) have nowhere to post an answer; callers read it via /messages.
    const source = this.store.getConversation(thread.conversationId)?.source;
    if (!source || !this.gateways.get(source)?.reply) return;
    this.watching.add(thread.id);
    this.track(
      (async () => {
        try {
          for (;;) {
            const since = this.store.getThread(thread.id)?.awaitingSince;
            if (!since) return;
            const reply = await this.t3.waitForReply(thread.t3ThreadId!, since);
            // Only the answer to the newest message counts; otherwise keep waiting.
            if (!this.store.clearAwaiting(thread.id, since)) continue;
            const conversation = this.store.getConversation(thread.conversationId)!;
            const current = this.store.getThread(thread.id)!;
            await this.locked(conversation.id, () => this.run(conversation, { type: "thread_finished", thread: current, reply }));
            return;
          }
        } catch (error) {
          log("t3c", `✗ lost track of T3 thread ${thread.t3ThreadId}: ${errorMessage(error)}`, "error");
        } finally {
          this.watching.delete(thread.id);
        }
      })(),
    );
  }

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }

  private track(promise: Promise<unknown>) {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  private gateway(name: string): Gateway {
    const gateway = this.gateways.get(name);
    if (!gateway) throw new Error(`No gateway "${name}" is configured.`);
    return gateway;
  }
}
