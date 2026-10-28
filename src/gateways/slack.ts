import type { Config } from "../config.ts";
import { errorMessage, log } from "../log.ts";
import {
  type FileRef,
  type Gateway,
  GatewayError,
  type GatewayRequest,
  header,
  hmacSha256Hex,
  type InboundMessage,
  type Preparation,
  PROBE_USER_AGENT,
  type Received,
  safeEqual,
} from "../gateway.ts";
import type { Store } from "../store.ts";

export type SlackConfig = NonNullable<Config["slack"]>;

/** The fields t3c uses from Slack `app_mention` and `message` events. */
export interface SlackEvent {
  type: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  /** On a thread's first message: how many replies, and the newest one's ts. */
  reply_count?: number;
  latest_reply?: string;
  /** Uploaded files: screenshots, logs, PDFs, snippets. */
  files?: SlackFile[];
  /** Link previews, forwarded messages and bot cards (CI, Sentry, …). */
  attachments?: SlackAttachment[];
  /** Block Kit layout; bots often put everything here and leave `text` short. */
  blocks?: SlackBlock[];
}

export interface SlackFile {
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  /** "tombstone" for deleted files, "hidden_by_limit" past a free plan's history. */
  mode?: string;
}

interface SlackAttachment {
  pretext?: string;
  author_name?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: { title?: string; value?: string }[];
  footer?: string;
  fallback?: string;
  /** A forwarded message's own files. */
  files?: SlackFile[];
}

interface SlackBlock {
  type: string;
  text?: { text?: string };
  fields?: { text?: string }[];
  elements?: { type: string; text?: string | { text?: string } }[];
}

/** Message subtypes that are still a person talking; other subtypes (edits, joins…) aren't requests. */
const PERSON_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

/** Catch-up reads threads with activity in this window, at most this many. */
const CATCH_UP_WINDOW_MS = 24 * 60 * 60_000;
const CATCH_UP_THREADS = 10;
/** How far back catch-up looks for threads with new replies. */
const THREAD_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/** How long the list of channels the bot is in is reused by catch-up. */
const CHANNELS_TTL_MS = 5 * 60_000;

/** Earlier thread messages passed along as context, at most. */
const MAX_CONTEXT_MESSAGES = 300;

export type SlackCall = (method: string, args?: Record<string, string>) => Promise<any>;

/** Slack rejects replays older than this; so do we. */
const MAX_REQUEST_AGE_S = 5 * 60;
const MAX_REPLY_CHARS = 3_800;

/** Calls a Slack Web API method. Form encoding works for every method; JSON bodies don't. */
export function slackApi(token: string): SlackCall {
  return async (method, args = {}) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: new URLSearchParams(args),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`);
    return data;
  };
}

/**
 * Slack ⇄ T3 over the Events API. Mentioning the bot in any channel it's in, or any message in a
 * DM with it, starts a T3 thread; replies in that Slack thread become follow-ups; answers are
 * posted back into the Slack thread.
 */
export class SlackGateway implements Gateway {
  readonly name = "slack";
  private readonly config: SlackConfig;
  private readonly store: Store;
  private readonly slack: SlackCall;
  private botUserId = "";
  /** Messages after this were sent while t3c was running, so any it doesn't have were lost. */
  private readonly startedAt = Date.now() / 1000;
  private readonly names = new Map<string, Promise<string>>();
  private channels?: { ids: string[]; at: number };

  constructor(config: SlackConfig, deps: { store: Store; slack?: SlackCall }) {
    this.config = config;
    this.store = deps.store;
    this.slack = deps.slack ?? slackApi(config.botToken);
  }

  /** Looks up the bot's own user id, which mention handling needs. */
  async init() {
    const { user_id } = await this.slack("auth.test");
    this.botUserId = user_id;
  }

  receive({ headers, body }: GatewayRequest): Received {
    this.verify(headers, body);
    const payload = JSON.parse(body.toString("utf8"));
    if (payload.type !== "event_callback") return {};
    if (process.env.T3C_DEBUG) {
      const e = payload.event as SlackEvent;
      log(this.name, `debug: ${payload.event_id} ${e.type}${e.subtype ? `/${e.subtype}` : ""} in ${e.channel} from ${e.user ?? e.bot_id} thread=${e.thread_ts ?? "-"}`);
    }
    const message = this.toMessage(payload.event);
    return message ? { message } : {};
  }

  /**
   * Messages Slack never delivered, or delivered in a way t3c had to reject: Slack drops a webhook
   * now and then, and none arrive while this machine is asleep or t3c is down. Covers new requests
   * in the channels and DMs the bot is in, and replies in followed threads.
   */
  async catchUp(): Promise<InboundMessage[]> {
    return [...(await this.missedMentions()), ...(await this.missedReplies())];
  }

  /**
   * New requests (mentions, or any message in a DM) in each channel the bot is in since t3c was
   * first seen working there (or started), at most a day back, so requests from before t3c was
   * there aren't replayed. Covers top-level messages and replies in threads t3c isn't following
   * yet (someone mentions the bot under another person's message); followed threads are
   * missedReplies' job.
   */
  private async missedMentions(): Promise<InboundMessage[]> {
    const mention = `<@${this.botUserId}>`;
    const missed: InboundMessage[] = [];
    const isRequest = (channel: string, m: SlackEvent) => isDm(channel) || Boolean(m.text?.includes(mention));
    const replay = (channel: string, m: SlackEvent) => {
      const message = this.toMessage({ ...m, type: isDm(channel) ? "message" : "app_mention", channel }, { quiet: true });
      if (message) missed.push(message);
    };
    for (const channel of await this.memberChannels()) {
      const firstSeen = this.store.firstInboundAt(this.name, `${channel}:`);
      const live = Math.min(this.startedAt, firstSeen ? Date.parse(firstSeen) / 1000 : Infinity);
      const oldest = Math.max(live, Date.now() / 1000 - CATCH_UP_WINDOW_MS / 1000);
      // A thread can get a new reply long after its first message, so look further back for those.
      const { messages } = await this.slack("conversations.history", {
        channel,
        oldest: (Date.now() / 1000 - THREAD_LOOKBACK_MS / 1000).toFixed(6),
        limit: "200",
      });
      // Newest first from Slack; handled oldest first.
      for (const m of (messages as SlackEvent[]).toReversed()) {
        if (m.thread_ts && m.thread_ts !== m.ts) continue;
        if (Number(m.ts) > oldest && isRequest(channel, m)) replay(channel, m);
        const followed = this.store.findConversation(this.name, `${channel}:${m.ts}`);
        if (!m.reply_count || Number(m.latest_reply) <= oldest || followed) continue;
        const { messages: replies } = await this.slack("conversations.replies", { channel, ts: m.ts, oldest: oldest.toFixed(6), limit: "200" });
        for (const r of replies as SlackEvent[]) {
          if (r.ts !== m.ts && Number(r.ts) > oldest && isRequest(channel, r)) replay(channel, { ...r, thread_ts: m.ts });
        }
      }
    }
    return missed;
  }

  /**
   * Channels, private channels and DMs the bot is in, refreshed every few minutes. An app installed
   * before DMs were supported lacks the im:read scope until it's reinstalled: channels only, then.
   */
  private async memberChannels(): Promise<string[]> {
    if (this.channels && Date.now() - this.channels.at < CHANNELS_TTL_MS) return this.channels.ids;
    const ids = await this.listChannels("public_channel,private_channel,im").catch((error) => {
      if (!/missing_scope/.test(errorMessage(error))) throw error;
      return this.listChannels("public_channel,private_channel");
    });
    this.channels = { ids, at: Date.now() };
    return ids;
  }

  private async listChannels(types: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor = "";
    do {
      const page = await this.slack("users.conversations", { types, limit: "200", ...(cursor ? { cursor } : {}) });
      ids.push(...(page.channels as { id: string }[]).map((c) => c.id));
      cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor);
    return ids;
  }

  /** Replies in followed threads, from the threads active in the last day. */
  private async missedReplies(): Promise<InboundMessage[]> {
    const since = new Date(Date.now() - CATCH_UP_WINDOW_MS).toISOString();
    const missed: InboundMessage[] = [];
    for (const conversation of this.store.recentConversations(this.name, since, CATCH_UP_THREADS)) {
      const [channel, root] = conversation.externalId.split(":");
      // From the message that started the conversation: earlier chat in the thread isn't a request.
      const first = this.store.firstInbound(conversation.id)?.inbound?.meta?.ts ?? root;
      const { messages } = await this.slack("conversations.replies", { channel, ts: root, oldest: first, limit: "200" });
      for (const m of messages as SlackEvent[]) {
        if (Number(m.ts) <= Number(first)) continue;
        // Replayed as the event Slack would have sent: a mention as app_mention, anything else as a reply.
        const type = m.text?.includes(`<@${this.botUserId}>`) ? "app_mention" : "message";
        const message = this.toMessage({ ...m, type, channel, thread_ts: m.thread_ts ?? root }, { quiet: true });
        if (message) missed.push(message);
      }
    }
    return missed;
  }

  /** https://api.slack.com/authentication/verifying-requests-from-slack */
  private verify(headers: GatewayRequest["headers"], body: Buffer) {
    const timestamp = header(headers, "x-slack-request-timestamp");
    const signature = header(headers, "x-slack-signature");
    const age = Math.round(Date.now() / 1000 - Number(timestamp));
    if (!timestamp || !(Math.abs(age) <= MAX_REQUEST_AGE_S)) {
      // What Slack sent, so a rejection can be explained (catch-up recovers the message itself).
      const retry = header(headers, "x-slack-retry-num");
      if (header(headers, "user-agent") !== PROBE_USER_AGENT) log(
        this.name,
        `rejected a webhook: timestamp ${timestamp ? `"${timestamp}" (${age}s old)` : "missing"}${retry ? `, retry ${retry} (${header(headers, "x-slack-retry-reason") || "no reason"})` : ""}, from ${header(headers, "user-agent") || "no user agent"}`,
        "warn",
      );
      throw new GatewayError(401, "Stale or missing Slack timestamp.");
    }
    const expected = `v0=${hmacSha256Hex(this.config.signingSecret, Buffer.concat([Buffer.from(`v0:${timestamp}:`), body]))}`;
    if (!safeEqual(signature, expected)) throw new GatewayError(401, "Invalid Slack signature.");
  }

  /** `quiet` (for catch-up) posts no notices and logs nothing, since it sees the same messages again. */
  private toMessage(event: SlackEvent, { quiet = false } = {}): InboundMessage | undefined {
    if (event.type !== "app_mention" && event.type !== "message") return;
    if (event.bot_id || (event.subtype && !PERSON_SUBTYPES.has(event.subtype)) || !event.user) return;
    const files = filesOf(event);
    const typed = event.text ?? "";
    if (!typed && files.length === 0) return;

    const mention = `<@${this.botUserId}>`;
    const rootTs = event.thread_ts ?? event.ts;
    const conversationId = `${event.channel}:${rootTs}`;
    const conversation = this.store.findConversation(this.name, conversationId);
    // In a DM every message is for the bot, and Slack sends no app_mention there.
    const dm = isDm(event.channel);
    if (event.type === "message" && !dm) {
      // A mention arrives as both app_mention and message; app_mention handles it.
      // Plain messages only matter as replies in a Slack thread that already has a T3 thread.
      if (typed.includes(mention) || !event.thread_ts || !conversation) return;
    }
    // Slack's retries and catch-up can bring a message that was already handled.
    if (conversation && this.store.hasInbound(conversation.id, event.ts)) return;

    const notice = (text: string): undefined => {
      if (quiet) return;
      if (event.type === "app_mention" || dm) void this.post(event.channel, rootTs, text).catch((e) => log(this.name, `couldn't post a notice: ${errorMessage(e)}`, "warn"));
    };
    if (!this.config.allowedUsers.includes(event.user)) {
      if (!quiet) log(this.name, `ignored ${event.user} in ${event.channel}: not on the allowlist`, "warn");
      return notice(`<@${event.user}> isn't allowed to use t3c.`);
    }
    const text = render({ ...event, text: typed.replaceAll(mention, "") });
    if (!text) return notice("What should I work on?");

    return {
      source: this.name,
      // The message's own id, so a webhook and catch-up recognise the same message.
      eventKey: `${event.channel}:${event.ts}`,
      conversationId,
      user: `<@${event.user}>`,
      text,
      title: firstLine(text),
      projects: this.config.projects,
      meta: { channel: event.channel, ts: event.ts, ...(event.thread_ts ? { threadTs: event.thread_ts } : {}) },
      ...(files.length > 0 && { files }),
    };
  }

  /**
   * The whole Slack thread before this message as context: every message with people's names,
   * including bot cards, link previews and forwarded messages, and the files shared in it.
   */
  async prepare(message: InboundMessage): Promise<Preparation> {
    const { channel, ts, threadTs } = message.meta!;
    if (!threadTs) return {};
    const earlier: SlackEvent[] = [];
    let cursor = "";
    do {
      const page = await this.slack("conversations.replies", { channel, ts: threadTs, limit: "200", ...(cursor ? { cursor } : {}) });
      earlier.push(...(page.messages as SlackEvent[]).filter((m) => m.ts !== ts && render(m)));
      cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor && earlier.length < MAX_CONTEXT_MESSAGES * 2);
    if (earlier.length === 0) return {};

    // Very long threads keep their opening message and the most recent ones.
    const kept =
      earlier.length <= MAX_CONTEXT_MESSAGES
        ? earlier
        : [earlier[0], { ts: "", text: `(${earlier.length - MAX_CONTEXT_MESSAGES} messages omitted)` } as SlackEvent, ...earlier.slice(-(MAX_CONTEXT_MESSAGES - 1))];
    const lines = await Promise.all(kept.map(async (m) => (m.ts ? `${await this.author(m)}: ${await this.withNames(render(m))}` : m.text!)));
    const files = kept.flatMap(filesOf);
    return { context: lines.join("\n"), ...(files.length > 0 && { files }) };
  }

  /** Slack serves private files to the bot token; without files:read it answers with a sign-in page. */
  async download(file: FileRef): Promise<Buffer> {
    const res = await fetch(file.url, { headers: { authorization: `Bearer ${this.config.botToken}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Slack answered ${res.status}`);
    if (res.headers.get("content-type")?.startsWith("text/html") && !file.mimeType.startsWith("text/html")) {
      throw new Error("Slack sent a sign-in page instead: the app needs the files:read scope (run `t3c add slack` to update it)");
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private author(m: SlackEvent) {
    if (m.user) return this.userName(m.user);
    return Promise.resolve(m.bot_id ? "a bot" : "someone");
  }

  /** <@U123> → @name, so the agent reads who is being addressed. */
  private async withNames(text: string) {
    const ids = [...new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]))];
    const names = new Map(await Promise.all(ids.map(async (id) => [id, await this.userName(id)] as const)));
    return text.replace(/<@([A-Z0-9]+)>/g, (_, id) => names.get(id) ?? `<@${id}>`);
  }

  /** "@Display Name", looked up once per user; the raw id if Slack won't say. */
  private userName(id: string): Promise<string> {
    let name = this.names.get(id);
    if (!name) {
      name = this.slack("users.info", { user: id })
        .then(({ user }) => `@${user?.profile?.display_name || user?.real_name || user?.name || id}`)
        .catch(() => `<@${id}>`);
      this.names.set(id, name);
    }
    return name;
  }

  async acknowledge(message: InboundMessage) {
    await this.slack("reactions.add", { channel: message.meta!.channel, timestamp: message.meta!.ts, name: "eyes" });
  }

  async reply(conversationId: string, text: string) {
    const [channel, threadTs] = conversationId.split(":");
    await this.post(channel, threadTs, toSlackMarkdown(truncate(text)));
  }

  private async post(channel: string, threadTs: string, text: string) {
    await this.slack("chat.postMessage", { channel, thread_ts: threadTs, text });
  }
}

/** A Slack app manifest for "Create an app → From a manifest", pointed at this machine's Funnel URL. */
/**
 * Slack checks an Events URL by posting a random challenge and expecting it back, both when the
 * app's manifest is saved and before t3c has the app's signing secret. Echoing it reveals nothing
 * and starts nothing, so it's answered without a signature.
 */
export function slackChallenge(body: Buffer): string | undefined {
  try {
    const payload = JSON.parse(body.toString("utf8"));
    if (payload?.type === "url_verification" && typeof payload.challenge === "string" && payload.challenge.length <= 200) {
      return payload.challenge;
    }
  } catch {}
}

/**
 * Everything a person would see in a message, as text: what was typed, then bot cards, link
 * previews and forwarded messages, then block content the text leaves out, then the files.
 */
export function render(m: SlackEvent): string {
  const parts = [m.text?.trim() ?? ""];
  for (const a of m.attachments ?? []) {
    const title = a.title && a.title_link ? `${a.title} (${a.title_link})` : a.title;
    const fields = (a.fields ?? []).map((f) => [f.title, f.value].filter(Boolean).join(": "));
    const card = [a.pretext, a.author_name, title, a.text, ...fields, a.footer].filter(Boolean).join("\n");
    parts.push(quote(card || a.fallback || ""));
  }
  const blocks = (m.blocks ?? []).flatMap(blockText).join("\n");
  // Rich text blocks repeat the typed text; other blocks (bot layouts) usually add to it.
  if (blocks && !parts[0].includes(blocks.trim())) parts.push(blocks);
  for (const f of filesOf(m)) parts.push(`[file: ${f.name} (${f.mimeType})]`);
  return parts.filter(Boolean).join("\n").trim();
}

function blockText(block: SlackBlock): string[] {
  if (block.type === "rich_text") return [];
  const texts = [block.text?.text, ...(block.fields ?? []).map((f) => f.text)];
  if (block.type === "context") texts.push(...(block.elements ?? []).map((e) => (typeof e.text === "string" ? e.text : e.text?.text)));
  return texts.filter((t): t is string => Boolean(t));
}

function quote(text: string) {
  return text.trim() ? text.trim().replace(/^/gm, "> ") : "";
}

/** Files in a message and in messages forwarded into it, minus deleted or hidden ones. */
function filesOf(m: SlackEvent): FileRef[] {
  const files = [...(m.files ?? []), ...(m.attachments ?? []).flatMap((a) => a.files ?? [])];
  return files
    .filter((f) => (f.url_private_download || f.url_private) && f.mode !== "tombstone" && f.mode !== "hidden_by_limit")
    .map((f) => ({
      name: f.name || f.title || "file",
      mimeType: f.mimetype || "application/octet-stream",
      size: f.size ?? 0,
      url: (f.url_private_download || f.url_private)!,
    }));
}

/** DM channel ids start with D. */
function isDm(channel: string) {
  return channel.startsWith("D");
}

export function slackManifest(publicUrl: string, name = "t3bot") {
  return {
    display_information: { name, description: "Starts T3 Code threads from Slack.", background_color: "#1f2328" },
    features: {
      bot_user: { display_name: name, always_online: true },
      // Lets people DM the bot from its Messages tab.
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:history",
          "channels:read",
          "groups:history",
          "groups:read",
          "im:history",
          "im:read",
          "chat:write",
          "files:read",
          "reactions:write",
          "users:read",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: new URL("/hooks/slack", publicUrl).toString(),
        bot_events: ["app_mention", "message.channels", "message.groups", "message.im"],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

function truncate(text: string) {
  return text.length <= MAX_REPLY_CHARS ? text : `${text.slice(0, MAX_REPLY_CHARS)}…\n\n(truncated, full reply in T3 Code)`;
}

/** Slack's mrkdwn uses *bold*, <url|label> links and has no headings. */
export function toSlackMarkdown(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

export function firstLine(text: string) {
  const line = text.split("\n")[0];
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
