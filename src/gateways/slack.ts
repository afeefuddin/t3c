import type { Config } from "../config.ts";
import { errorMessage, log } from "../log.ts";
import { type Gateway, GatewayError, type GatewayRequest, header, hmacSha256Hex, type InboundMessage, type Received, safeEqual } from "../gateway.ts";
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
    this.verify(header(headers, "x-slack-request-timestamp"), header(headers, "x-slack-signature"), body);
    const payload = JSON.parse(body.toString("utf8"));
    if (payload.type === "url_verification") return { response: { challenge: payload.challenge } };
    if (payload.type !== "event_callback") return {};
    const message = this.toMessage(payload.event_id, payload.event);
    return message ? { message } : {};
  }

  /** https://api.slack.com/authentication/verifying-requests-from-slack */
  private verify(timestamp: string, signature: string, body: Buffer) {
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!timestamp || !(age <= MAX_REQUEST_AGE_S)) throw new GatewayError(401, "Stale or missing Slack timestamp.");
    const expected = `v0=${hmacSha256Hex(this.config.signingSecret, Buffer.concat([Buffer.from(`v0:${timestamp}:`), body]))}`;
    if (!safeEqual(signature, expected)) throw new GatewayError(401, "Invalid Slack signature.");
  }

  private toMessage(eventId: string, event: SlackEvent): InboundMessage | undefined {
    if (event.type !== "app_mention" && event.type !== "message") return;
    if (event.bot_id || event.subtype || !event.user || !event.text) return;

    const mention = `<@${this.botUserId}>`;
    const rootTs = event.thread_ts ?? event.ts;
    const conversationId = `${event.channel}:${rootTs}`;
    if (event.type === "message") {
      // A mention arrives as both app_mention and message; app_mention handles it.
      // Plain messages only matter as replies in a Slack thread that already has a T3 thread.
      if (event.text.includes(mention) || !event.thread_ts || !this.store.findConversation(this.name, conversationId)) return;
    }

    const notice = (text: string): undefined => {
      if (event.type === "app_mention") void this.post(event.channel, rootTs, text).catch((e) => log(this.name, `couldn't post a notice: ${errorMessage(e)}`, "warn"));
    };
    if (!this.config.allowedUsers.includes(event.user)) {
      log(this.name, `ignored ${event.user} in ${event.channel}: not on the allowlist`, "warn");
      return notice(`<@${event.user}> isn't allowed to use t3c.`);
    }
    const projects = this.config.channels[event.channel];
    if (!projects) return notice("This channel isn't connected to a T3 project. Run `t3c add slack` to connect it.");
    const text = event.text.replaceAll(mention, "").trim();
    if (!text) return notice("What should I work on?");

    return {
      source: this.name,
      eventKey: eventId,
      conversationId,
      user: `<@${event.user}>`,
      text,
      title: firstLine(text),
      projects: [projects].flat(),
      meta: { channel: event.channel, ts: event.ts, ...(event.thread_ts ? { threadTs: event.thread_ts } : {}) },
    };
  }

  async prepare(message: InboundMessage) {
    const { channel, ts, threadTs } = message.meta!;
    if (!threadTs) return {};
    const { messages } = await this.slack("conversations.replies", { channel, ts: threadTs, limit: "100" });
    const earlier = (messages as SlackEvent[]).filter((m) => m.ts !== ts && m.text);
    return earlier.length > 0 ? { context: earlier.map((m) => `<@${m.user ?? m.bot_id}>: ${m.text}`).join("\n") } : {};
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
