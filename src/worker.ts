import type { AgentEvent, Brain } from "./brain.ts";
import type { Dispatcher } from "./dispatch.ts";
import type { Gateway, InboundMessage } from "./gateway.ts";
import { errorMessage, log, preview } from "./log.ts";
import type { Conversation, Store, StoredMessage, ThreadRecord } from "./store.ts";
import { type T3, WORKING } from "./t3.ts";
import { ConversationTools } from "./agent/tools.ts";

/** A working thread with no new activity for this long counts as stuck. */
const STALL_MS = 15 * 60_000;
/** Waiting/failed/stuck episodes in a row (without progress) the brain gets before a person is told. */
const MAX_ATTEMPTS = 3;

/**
 * Wakes the brain on events and keeps everything durable:
 * - a new message (saved by the webhook) → brain run
 * - a T3 thread finished answering → brain run, then the thread is settled if that's the end
 * - a T3 thread is waiting, failed or stuck (see `supervise`) → brain run to get it going again
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
  private catchingUp = false;
  private supervising = false;
  /** Per thread: its item count when last seen to change, and since when. */
  private readonly lastProgress = new Map<string, { items: number; since: number }>();
  /** Per thread: waiting/failed/stuck episodes in a row without progress. */
  private readonly attempts = new Map<string, number>();
  private readonly stallMs: number;

  constructor(deps: { gateways: Gateway[]; dispatcher: Dispatcher; store: Store; t3: T3; brain: Brain; stallMs?: number }) {
    this.stallMs = deps.stallMs ?? STALL_MS;
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

  /** Asks each gateway for messages it missed, and handles them. Safe to call repeatedly. */
  async catchUp() {
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      for (const gateway of this.gateways.values()) {
        try {
          const missed = (await gateway.catchUp?.()) ?? [];
          if (missed.length > 0) log(gateway.name, `caught up on ${missed.length} message(s) that never arrived as webhooks`);
          for (const message of missed) this.enqueue(message);
        } catch (error) {
          log(gateway.name, `couldn't check for missed messages: ${errorMessage(error)}`, "warn");
        }
      }
    } finally {
      this.catchingUp = false;
    }
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
            const finished = reply.status === "completed" || reply.status === "idle";
            if (finished) this.attempts.delete(thread.id);
            const attempt = finished ? 0 : this.attempt(current);
            if (attempt > MAX_ATTEMPTS) {
              await this.giveUp(conversation, current, `it is ${reply.status}`);
              return;
            }
            await this.locked(conversation.id, () => this.run(conversation, { type: "thread_finished", thread: current, reply, attempt }));
            // Done unless the brain sent it more work: settle it, so T3's active list holds what's live.
            // Threads t3c only attached to belong to whoever started them; they stay as they are.
            if (finished && current.origin === "started" && !this.store.getThread(thread.id)?.awaitingSince) await this.settle(current);
            // The brain may have sent it more work (a follow-up or a nudge): keep watching.
            continue;
          }
        } catch (error) {
          log("t3c", `✗ lost track of T3 thread ${thread.t3ThreadId}: ${errorMessage(error)}`, "error");
        } finally {
          this.watching.delete(thread.id);
        }
      })(),
    );
  }

  /**
   * Looks at every thread t3c is waiting on. One whose item count hasn't moved for `stallMs` while
   * it's working is stuck, and the brain is woken to get it going. If that doesn't help, the next
   * `stallMs` without progress is the next attempt, until MAX_ATTEMPTS.
   */
  async supervise() {
    if (this.supervising) return;
    this.supervising = true;
    try {
      for (const thread of this.store.awaitingThreads()) {
        try {
          const { status, items } = await this.t3.progress(thread.t3ThreadId!);
          const seen = this.lastProgress.get(thread.id);
          if (!seen || seen.items !== items || !WORKING.has(status)) {
            this.lastProgress.set(thread.id, { items, since: Date.now() });
            if (seen && seen.items !== items) this.attempts.delete(thread.id); // it moved: start over
            continue;
          }
          if (Date.now() - seen.since < this.stallMs) continue;
          const conversation = this.store.getConversation(thread.conversationId)!;
          const attempt = this.attempt(thread);
          const idleMinutes = Math.round((Date.now() - seen.since) / 60_000);
          log(conversation.source, `⚠ T3 thread ${thread.t3ThreadId} (${thread.label}) has made no progress for ${idleMinutes} min`, "warn");
          if (attempt > MAX_ATTEMPTS) {
            await this.t3.interruptThread(thread.t3ThreadId!, "Stuck; stopped by t3c").catch(() => {});
            await this.giveUp(conversation, thread, `it made no progress for ${idleMinutes} minutes`);
            continue;
          }
          const reply = await this.t3.latestReply(thread.t3ThreadId!);
          await this.locked(conversation.id, () =>
            this.run(conversation, { type: "thread_stalled", thread: this.store.getThread(thread.id)!, reply, idleMinutes, attempt }),
          );
          // The nudge itself adds to the thread; only activity after it counts as progress.
          const after = await this.t3.progress(thread.t3ThreadId!).catch(() => ({ items }));
          this.lastProgress.set(thread.id, { items: after.items, since: Date.now() });
        } catch (error) {
          log("t3c", `couldn't check on T3 thread ${thread.t3ThreadId}: ${errorMessage(error)}`, "warn");
        }
      }
    } finally {
      this.supervising = false;
    }
  }

  private attempt(thread: ThreadRecord) {
    const n = (this.attempts.get(thread.id) ?? 0) + 1;
    this.attempts.set(thread.id, n);
    return n;
  }

  /** After MAX_ATTEMPTS: stop waiting on the thread and tell the conversation, once. */
  private async giveUp(conversation: Conversation, thread: ThreadRecord, why: string) {
    this.store.clearAwaiting(thread.id, thread.awaitingSince ?? "");
    this.attempts.delete(thread.id);
    log(conversation.source, `✗ gave up on T3 thread ${thread.t3ThreadId} (${thread.label}): ${why}`, "error");
    await this.gateways
      .get(conversation.source)
      ?.reply?.(conversation.externalId, `The T3 thread "${thread.title}" still isn't moving after ${MAX_ATTEMPTS} attempts to unblock it (${why}). It needs a look in T3 Code.`)
      .catch((e) => log(conversation.source, `couldn't post: ${errorMessage(e)}`, "warn"));
  }

  private async settle(thread: ThreadRecord) {
    try {
      await this.t3.settleThread(thread.t3ThreadId!);
      this.lastProgress.delete(thread.id);
      log("t3c", `✓ settled T3 thread ${thread.t3ThreadId} (${thread.label})`);
    } catch (error) {
      log("t3c", `couldn't settle T3 thread ${thread.t3ThreadId}: ${errorMessage(error)}`, "warn");
    }
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
