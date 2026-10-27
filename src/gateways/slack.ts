import type { Config } from "../config.ts";
import { errorMessage, log } from "../log.ts";
import { type Gateway, GatewayError, type GatewayRequest, header, hmacSha256Hex, type InboundMessage, PROBE_USER_AGENT, type Received, safeEqual } from "../gateway.ts";
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
}

/** Catch-up reads threads with activity in this window, at most this many. */
const CATCH_UP_WINDOW_MS = 24 * 60 * 60_000;
const CATCH_UP_THREADS = 10;

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
 * Slack ⇄ T3 over the Events API. Mentioning the bot in a mapped channel starts a T3 thread;
 * replies in that Slack thread become follow-ups; answers are posted back into the Slack thread.
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
   * now and then, and none arrive while this machine is asleep or t3c is down. Covers new mentions
   * in the connected channels and replies in followed threads.
   */
  async catchUp(): Promise<InboundMessage[]> {
    return [...(await this.missedMentions()), ...(await this.missedReplies())];
  }

  /**
   * New top-level mentions in each connected channel since t3c was first seen working there (or
   * started), at most a day back, so mentions from before t3c was connected aren't replayed.
   * Channels connected through "*" aren't listed in the config, so they aren't covered.
   */
  private async missedMentions(): Promise<InboundMessage[]> {
    const mention = `<@${this.botUserId}>`;
    const missed: InboundMessage[] = [];
    for (const channel of Object.keys(this.config.channels)) {
      if (channel === ANY_CHANNEL) continue;
      const firstSeen = this.store.firstInboundAt(this.name, `${channel}:`);
      const live = Math.min(this.startedAt, firstSeen ? Date.parse(firstSeen) / 1000 : Infinity);
      const oldest = Math.max(live, Date.now() / 1000 - CATCH_UP_WINDOW_MS / 1000);
      const { messages } = await this.slack("conversations.history", { channel, oldest: oldest.toFixed(6), limit: "100" });
      // Newest first from Slack; handled oldest first.
      for (const m of (messages as SlackEvent[]).toReversed()) {
        if ((m.thread_ts && m.thread_ts !== m.ts) || !m.text?.includes(mention)) continue;
        const message = this.toMessage({ ...m, type: "app_mention", channel }, { quiet: true });
        if (message) missed.push(message);
      }
    }
    return missed;
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
    if (event.bot_id || event.subtype || !event.user || !event.text) return;

    const mention = `<@${this.botUserId}>`;
    const rootTs = event.thread_ts ?? event.ts;
    const conversationId = `${event.channel}:${rootTs}`;
    const conversation = this.store.findConversation(this.name, conversationId);
    if (event.type === "message") {
      // A mention arrives as both app_mention and message; app_mention handles it.
      // Plain messages only matter as replies in a Slack thread that already has a T3 thread.
      if (event.text.includes(mention) || !event.thread_ts || !conversation) return;
    }
    // Slack's retries and catch-up can bring a message that was already handled.
    if (conversation && this.store.hasInbound(conversation.id, event.ts)) return;

    const notice = (text: string): undefined => {
      if (quiet) return;
      if (event.type === "app_mention") void this.post(event.channel, rootTs, text).catch((e) => log(this.name, `couldn't post a notice: ${errorMessage(e)}`, "warn"));
    };
    if (!this.config.allowedUsers.includes(event.user)) {
      if (!quiet) log(this.name, `ignored ${event.user} in ${event.channel}: not on the allowlist`, "warn");
      return notice(`<@${event.user}> isn't allowed to use t3c.`);
    }
    const projects = this.config.channels[event.channel] ?? this.config.channels[ANY_CHANNEL];
    if (!projects) return notice("This channel isn't connected to a T3 project. Run `t3c add slack` to connect it.");
    const text = event.text.replaceAll(mention, "").trim();
    if (!text) return notice("What should I work on?");

    return {
      source: this.name,
      // The message's own id, so a webhook and catch-up recognise the same message.
      eventKey: `${event.channel}:${event.ts}`,
      conversationId,
      user: `<@${event.user}>`,
      text,
      title: firstLine(text),
      projects: [projects].flat(),
      meta: { channel: event.channel, ts: event.ts, ...(event.thread_ts ? { threadTs: event.thread_ts } : {}) },
    };
  }

  /** The whole Slack thread before this message, with people's names, as context. */
  async prepare(message: InboundMessage) {
    const { channel, ts, threadTs } = message.meta!;
    if (!threadTs) return {};
    const earlier: SlackEvent[] = [];
    let cursor = "";
    do {
      const page = await this.slack("conversations.replies", { channel, ts: threadTs, limit: "200", ...(cursor ? { cursor } : {}) });
      earlier.push(...(page.messages as SlackEvent[]).filter((m) => m.ts !== ts && m.text));
      cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor && earlier.length < MAX_CONTEXT_MESSAGES * 2);
    if (earlier.length === 0) return {};

    // Very long threads keep their opening message and the most recent ones.
    const kept =
      earlier.length <= MAX_CONTEXT_MESSAGES
        ? earlier
        : [earlier[0], { ts: "", text: `(${earlier.length - MAX_CONTEXT_MESSAGES} messages omitted)` } as SlackEvent, ...earlier.slice(-(MAX_CONTEXT_MESSAGES - 1))];
    const lines = await Promise.all(kept.map(async (m) => (m.ts ? `${await this.author(m)}: ${await this.withNames(m.text!)}` : m.text!)));
    return { context: lines.join("\n") };
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

/** Channels key for every channel the bot is in that has no entry of its own. */
export const ANY_CHANNEL = "*";

export function slackManifest(publicUrl: string, name = "t3bot") {
  return {
    display_information: { name, description: "Starts T3 Code threads from Slack.", background_color: "#1f2328" },
    features: { bot_user: { display_name: name, always_online: true } },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:history",
          "channels:read",
          "groups:history",
          "groups:read",
          "chat:write",
          "reactions:write",
          "users:read",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: new URL("/hooks/slack", publicUrl).toString(),
        bot_events: ["app_mention", "message.channels", "message.groups"],
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
