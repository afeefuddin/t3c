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
/** People send one request in several messages: a run starts once a conversation is quiet this long… */
const QUIET_MS = 4_000;
/** …or after this long, if they keep typing. */
const MAX_QUIET_WAIT_MS = 20_000;
/** After a stop's grace period, how long stopped runs get to wind down. */
const ABORT_WAIT_MS = 5_000;

/** A run stopped by shutdown. Its messages and owed answer are handled again after the restart. */
const INTERRUPTED = Symbol("interrupted");

/** What a chat sees when a run fails before replying. */
const FAILURE_REPLY = "Sorry, something went wrong on my side and I couldn't get to that. Try again in a bit.";

/**
 * Wakes the brain on events and keeps everything durable:
 * - a new message (saved by the webhook) → brain run
 * - a T3 thread finished answering → brain run, then the thread is settled if that's the end
 * - a T3 thread is waiting, failed or stuck (see `supervise`) → brain run to get it going again
 * Runs for the same conversation never overlap; after a restart (or a `stop` that cut a run
 * short), unprocessed messages and owed answers resume.
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
  /** Brain runs in progress. */
  private readonly runs = new Set<Promise<unknown>>();
  /** Per thread: an answer a watcher took (cleared as owed) that no run has handled yet, by when it was owed. */
  private readonly taken = new Map<string, string>();
  private stopping = false;
  /** Cancels runs still going when a stop's grace period ends. */
  private readonly abort = new AbortController();
  private readonly stallMs: number;
  private readonly quietMs: number;

  constructor(deps: { gateways: Gateway[]; dispatcher: Dispatcher; store: Store; t3: T3; brain: Brain; stallMs?: number; quietMs?: number }) {
    this.stallMs = deps.stallMs ?? STALL_MS;
    this.quietMs = deps.quietMs ?? QUIET_MS;
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
    // Seen straight away, even when a run in the conversation is busy.
    const gateway = this.gateways.get(message.source);
    if (gateway) this.track(this.acknowledge(gateway, message));
    this.kick();
    return stored;
  }

  /**
   * Starts no more runs and gives those in progress up to `graceMs` to finish, then cancels them.
   * Nothing is lost: a cancelled run's messages and owed answers are picked up after the restart.
   */
  async stop(graceMs: number) {
    this.stopping = true;
    if (this.runs.size > 0) {
      log("t3c", `letting ${this.runs.size} agent run(s) finish`);
      if (!(await within(Promise.allSettled([...this.runs]), graceMs))) {
        log("t3c", "stopping agent runs still going; they resume after the restart", "warn");
        this.abort.abort();
        await within(Promise.allSettled([...this.runs]), ABORT_WAIT_MS);
      }
    }
    // Answers whose run was cut short, or never got its turn behind a run that ignored the abort:
    // owe them again, so the watch after the restart picks them up.
    for (const [id, since] of this.taken) if (this.store.getThread(id)?.awaitingSince === null) this.store.setAwaiting(id, since);
  }

  /** Resolves once nothing is queued, running or being watched (for tests). */
  async idle() {
    while (this.draining || this.pending.size > 0) {
      await this.draining;
      await Promise.all(this.pending);
    }
  }

  private kick() {
    this.draining ??= this.drain().finally(() => (this.draining = undefined));
  }

  /**
   * Handles waiting messages a conversation at a time: everything it has pending goes to one run.
   * Messages are taken only once the conversation is free, so a run that's busy there when they
   * arrive can take them in itself (see ConversationTools.reply).
   */
  private async drain() {
    for (let id = this.store.nextPending(); id && !this.stopping; id = this.store.nextPending()) {
      const conversation = this.store.getConversation(id)!;
      if (!this.gateways.has(conversation.source)) {
        // e.g. a gateway removed from the config while messages from it were queued.
        const batch = this.store.takePending(id);
        log("t3c", `skipping ${batch.length} message(s) from "${conversation.source}": that gateway isn't configured`, "warn");
        for (const m of batch) this.store.finishMessage(m.id, `No gateway "${conversation.source}" is configured.`);
        continue;
      }
      await this.locked(conversation.id, async () => {
        if (this.stopping) return;
        const batch = this.store.takePending(conversation.id);
        if (batch.length === 0) return; // a run that held the lock took them
        this.store.updateConversation(conversation.id, { state: "active" });
        await this.untilQuiet(conversation.id, batch);
        const error = await this.run(conversation, { type: "message", messages: batch });
        // Taken but not handled: they go back to the queue when t3c starts again.
        if (error === INTERRUPTED) return;
        for (const m of batch) this.store.finishMessage(m.id, error);
      });
    }
  }

  /** Waits for a pause in the conversation, adding messages that arrive meanwhile to `batch`. */
  private async untilQuiet(conversationId: string, batch: StoredMessage[]) {
    const deadline = Date.now() + MAX_QUIET_WAIT_MS;
    for (;;) {
      const wait = Math.min(this.quietMs - (Date.now() - Date.parse(batch.at(-1)!.createdAt)), deadline - Date.now());
      if (wait <= 0) return;
      await new Promise((r) => setTimeout(r, wait));
      batch.push(...this.store.takePending(conversationId));
    }
  }

  /** Signals that a message was seen, e.g. a 👀 reaction. Best effort. */
  private async acknowledge(gateway: Gateway, message: InboundMessage) {
    await gateway.acknowledge?.(message).catch((e) => log(gateway.name, `couldn't react: ${errorMessage(e)}`, "warn"));
  }

  /**
   * One brain run with conversation-scoped tools, recorded in agent_runs. Returns an error message
   * if it failed, or INTERRUPTED when t3c is stopping and the run didn't get to finish.
   */
  private run(conversation: Conversation, event: AgentEvent): Promise<string | undefined | typeof INTERRUPTED> {
    if (this.stopping) return Promise.resolve(INTERRUPTED);
    const running = this.execute(conversation, event);
    this.runs.add(running);
    void running.finally(() => this.runs.delete(running));
    return running;
  }

  private async execute(conversation: Conversation, event: AgentEvent): Promise<string | undefined | typeof INTERRUPTED> {
    const gateway = this.gateway(conversation.source);
    const requestFiles = event.type === "message" ? event.messages.flatMap((m) => m.inbound?.files ?? []) : [];
    const signal = this.abort.signal;
    const tools = new ConversationTools({ store: this.store, dispatcher: this.dispatcher, t3: this.t3, gateway, conversation, requestFiles, signal });
    const run = this.store.startRun(conversation.id, event.type);
    const brain = this.brain;
    try {
      const outcome = await brain.handle(event, tools, signal);
      this.store.finishRun(run.id, { actions: tools.actions, outcome });
      for (const m of tools.lateMessages) this.store.finishMessage(m.id);
      log(conversation.source, `✓ ${brain.name}: ${outcome} (${conversation.externalId})`);
      return;
    } catch (error) {
      const message = errorMessage(error);
      if (signal.aborted) {
        // Its messages (late ones too) stay taken, and go back to the queue when t3c starts again.
        this.store.finishRun(run.id, { actions: tools.actions, error: "Stopped: t3c was shutting down." });
        log(conversation.source, `⏹ ${conversation.externalId}: stopped by shutdown; handled again after the restart`, "warn");
        return INTERRUPTED;
      }
      this.store.finishRun(run.id, { actions: tools.actions, error: message });
      for (const m of tools.lateMessages) this.store.finishMessage(m.id, message);
      log(conversation.source, `✗ ${conversation.externalId}: ${message}`, "error");
      // The details are in the log: errors can hold internal output (agent stderr, T3's errors),
      // and chats may be seen by people who shouldn't read that.
      if (tools.repliesSent === 0 && gateway.reply) {
        await gateway
          .reply(conversation.externalId, FAILURE_REPLY)
          .catch((e) => log(gateway.name, `✗ couldn't post the error: ${errorMessage(e)}`, "error"));
      }
      return message;
    } finally {
      for (const thread of this.store.threads(conversation.id)) if (thread.awaitingSince) this.watch(thread);
    }
  }

  /** Waits for a thread's owed answer, then wakes the brain with it. Newer follow-ups extend the wait. */
  private watch(thread: ThreadRecord) {
    if (this.stopping || this.watching.has(thread.id) || !thread.t3ThreadId) return;
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
            // Still owed: the watch resumes after the restart.
            if (this.stopping) return;
            // Only the answer to the newest message counts; otherwise keep waiting.
            if (!this.store.clearAwaiting(thread.id, since)) continue;
            const conversation = this.store.getConversation(thread.conversationId)!;
            let current = this.store.getThread(thread.id)!;
            const finished = reply.status === "completed" || reply.status === "idle";
            if (finished) this.attempts.delete(thread.id);
            const attempt = finished ? 0 : this.attempt(current);
            if (attempt > MAX_ATTEMPTS) {
              await this.giveUp(conversation, current, `it is ${reply.status}`);
              return;
            }
            this.taken.set(thread.id, since);
            const result = await this.locked(conversation.id, async () => {
              // A run that held the lock may have sent it newer work: this answer is then out of date.
              current = this.store.getThread(thread.id)!;
              const newerWork = current.awaitingSince !== null;
              const outcome = await this.run(conversation, { type: "thread_finished", thread: current, reply, attempt, ...(newerWork && { newerWork }) });
              if (outcome !== INTERRUPTED) this.taken.delete(thread.id);
              return outcome;
            });
            // Not handled: stop() owes it again.
            if (result === INTERRUPTED) return;
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
        if (this.stopping) return;
        // Resumes a wait that broke off, e.g. while T3 Code was restarting.
        this.watch(thread);
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

/** Whether `promise` settled within `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
