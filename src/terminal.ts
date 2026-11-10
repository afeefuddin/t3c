import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { loadConfig, paths } from "./config.ts";
import type { ChatView } from "./terminal-view.ts";

/** Local clients authenticate to the same daemon; this token is never exposed through Funnel. */
export function chatToken(path = paths.chatToken): string {
  try { return readFileSync(path, "utf8").trim(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { writeFileSync(path, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readFileSync(path, "utf8").trim();
}

export interface ChatMessage { id: string; direction: "in" | "out"; text: string; status: string }
export interface ChatSnapshot {
  messages: ChatMessage[];
  pending: boolean;
  activity: { phase: "queued" | "thinking" | "working"; since: string; title?: string } | null;
}

const EMPTY: ChatSnapshot = { messages: [], pending: false, activity: null };
const HELP = "Enter sends · Alt+Enter adds a line · ↑ recalls messages · scroll for history\n/new starts a fresh chat · /retry retries an unconfirmed send · /exit leaves\nWork continues in the background when you leave. Closing chat does not cancel coding work.";

/** Transport client only: all decisions and memory stay in the daemon's existing agent. */
export class ChatClient {
  private readonly base: string;
  private readonly token: string;
  private readonly abort = new AbortController();
  readonly sessionId: string;
  constructor(base: string, token: string, sessionId: string) {
    this.base = base;
    this.token = token;
    this.sessionId = sessionId;
  }

  private async request(path: string, body?: unknown) {
    const response = await fetch(this.base + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([AbortSignal.timeout(10_000), this.abort.signal]),
    });
    const result = await response.json();
    if (response.status === 404) throw new Error("Terminal chat is unavailable. Run `t3c restart` to load the current version.");
    if (!response.ok) throw new Error(result.error ?? `Chat request failed (${response.status}).`);
    return result;
  }

  send(prompt: string, idempotencyKey: string = randomUUID()) {
    return this.request("/chat", { conversationId: this.sessionId, prompt, idempotencyKey });
  }

  async snapshot(): Promise<ChatSnapshot> {
    const result = await this.request(`/chat/${encodeURIComponent(this.sessionId)}`);
    if (typeof result.pending !== "boolean") throw new Error("Terminal chat needs the updated daemon. Run `t3c restart`.");
    return result;
  }

  async messages(): Promise<ChatMessage[]> { return (await this.snapshot()).messages; }
  close() { this.abort.abort(); }
}

type ChatDisplay = Pick<ChatView, "update" | "sending" | "disconnected" | "notice" | "reset">;

/** Client-side session/transport state. Decisions and memory stay in the daemon. */
export class ChatSession {
  private client: ChatClient;
  private readonly display: ChatDisplay;
  private readonly newClient: () => ChatClient;
  private readonly exit: () => void;
  private current: ChatSnapshot = EMPTY;
  private revision = 0;
  private refreshing: Promise<void> | undefined;
  private submitting = false;
  private failed: { text: string; key: string } | undefined;
  private stopped = false;

  constructor(client: ChatClient, display: ChatDisplay, newClient: () => ChatClient, exit: () => void, initial: ChatSnapshot = EMPTY) {
    this.client = client; this.display = display; this.newClient = newClient; this.exit = exit;
    this.current = initial;
  }

  stop() { this.stopped = true; this.client.close(); }

  async refresh() {
    if (this.stopped) return;
    if (this.refreshing) return this.refreshing;
    const client = this.client, revision = this.revision;
    this.refreshing = (async () => {
      try {
        const snapshot = await client.snapshot();
        if (this.stopped || client !== this.client || revision !== this.revision || this.submitting) return;
        this.current = snapshot;
        this.display.update(snapshot);
      } catch (error) {
        if (!this.stopped && client === this.client) this.display.disconnected(error instanceof Error ? error.message : String(error));
      }
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async submit(input: string) {
    const text = input.trim();
    if (!text || this.submitting || this.stopped) return;
    if (text === "/exit" || text === "/quit") return this.exit();
    if (text === "/help") return this.display.notice("Help", HELP);
    if (text === "/new") {
      this.client.close();
      this.client = this.newClient(); this.current = EMPTY; this.revision++; this.failed = undefined;
      this.display.reset();
      return;
    }
    if (text.startsWith("/") && text !== "/retry") return this.display.notice("Unknown command", "Use /help to see available commands.");
    if (text === "/retry" && !this.failed) return this.display.notice("Nothing to retry", "All sends have been confirmed by the daemon.");
    const request = text === "/retry" ? this.failed! : { text, key: randomUUID() };
    this.submitting = true; this.revision++;
    this.display.update({ ...this.current, messages: [...this.current.messages, { id: request.key, direction: "in", text: request.text, status: "pending" }] });
    this.display.sending(true);
    try {
      const delivery = await this.client.send(request.text, request.key);
      if (this.stopped) return;
      this.current = { ...this.current,
        messages: [...this.current.messages, { id: delivery.messageId, direction: "in", text: request.text, status: "pending" }],
        pending: true, activity: { phase: "queued", since: new Date().toISOString() },
      };
      this.display.update(this.current);
      if (this.failed?.key === request.key) this.failed = undefined;
      if (text === "/retry") this.display.notice("Send confirmed", "The daemon received your message. Retrying did not create another request.");
    } catch (error) {
      if (this.stopped) return;
      this.failed = request;
      this.display.notice("Send not confirmed", `${error instanceof Error ? error.message : String(error)}\n\nUse /retry to resend safely without duplicating work. Your draft is preserved.`);
    } finally { this.submitting = false; this.display.sending(false); }
    await this.refresh();
  }
}

/** Every launch, and every /new, is a fresh conversation; earlier ones stay searchable by the agent. */
export async function terminalChat() {
  const token = chatToken();
  const config = loadConfig();
  const newClient = () => new ChatClient(`http://127.0.0.1:${config.port}`, token, randomUUID());
  const client = newClient();
  // Fail before switching terminal modes when the daemon is unavailable/outdated.
  const initial = await client.snapshot();
  if (!process.stdin.isTTY || !process.stdout.isTTY) return plainChat(client, initial, newClient);

  const { ChatView } = await import("./terminal-view.ts");
  const { ProcessTerminal } = await import("@earendil-works/pi-tui");
  let close!: () => void;
  const done = new Promise<void>((resolve) => { close = resolve; });
  const view = new ChatView(new ProcessTerminal(), (text) => { void session.submit(text); }, close, config.agent?.provider ?? "Agent");
  const session = new ChatSession(client, view, newClient, close, initial);
  view.update(initial);
  view.start();
  let lastPoll = 0;
  const timer = setInterval(() => {
    view.tick();
    if (Date.now() - lastPoll >= 1000) { lastPoll = Date.now(); void session.refresh(); }
  }, 250);
  process.once("SIGTERM", close);
  process.stdin.once("end", close);
  try {
    await done;
  } finally {
    clearInterval(timer); process.removeListener("SIGTERM", close); process.stdin.removeListener("end", close);
    session.stop();
    view.stop();
  }
  console.log("Chat closed. Work continues in the background; ask about it from a new `t3c` chat.");
}

/** Readable line mode for pipes and terminals without a TTY. No cursor-control sequences. */
async function plainChat(client: ChatClient, initial: ChatSnapshot, newClient: () => ChatClient) {
  const seen = new Set<string>();
  let phase: string | undefined;
  const print = (text: string) => console.log(stripVTControlCharacters(text));
  const display: ChatDisplay = {
    update(snapshot) {
      for (const message of snapshot.messages) {
        const key = `${message.id}:${message.status}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (message.direction === "out") print(`\nT3C\n${message.text}\n`);
        else if (message.status === "failed") print("Message could not be processed. Send a follow-up to try again.");
      }
      const next = snapshot.activity?.phase;
      if (next && next !== phase) print(`${next === "thinking" ? "Thinking" : next === "working" ? "Working" : "Queued"}…`);
      phase = next;
    },
    sending(active) { if (active) print("Sending…"); },
    disconnected(message) { if (phase !== "offline") print(`Connection lost · retrying: ${message}`); phase = "offline"; },
    notice(title, text) { print(`\n${title}\n${text}\n`); },
    reset() { seen.clear(); phase = undefined; print("Started a fresh chat."); },
  };
  print("T3C · /help for commands · /exit to leave. Work continues in the background.");
  for (const message of initial.messages) { seen.add(`${message.id}:${message.status}`); print(`${message.direction === "in" ? "You" : "T3C"}\n${message.text}\n`); }
  display.update(initial);
  const rl = createInterface({ input: process.stdin, terminal: false });
  const session = new ChatSession(client, display, newClient, () => rl.close(), initial);
  const timer = setInterval(() => void session.refresh(), 1000);
  process.stdout.write("you> ");
  try { for await (const line of rl) await session.submit(line); }
  finally { clearInterval(timer); session.stop(); rl.close(); }
}
