import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { type SlackEvent, SlackGateway, slackChallenge, slackManifest, toSlackMarkdown } from "../src/gateways/slack.ts";
import { Store } from "../src/store.ts";

const BOT = "UBOT";
const SECRET = "slack-signing-secret";

async function setup(channels: Record<string, string | string[]> = { C1: "demo", C2: ["demo", "web"] }) {
  const store = new Store(":memory:");
  const calls: { method: string; args: Record<string, string> }[] = [];
  const history: SlackEvent[] = [];
  const slack = async (method: string, args: Record<string, string> = {}) => {
    calls.push({ method, args });
    if (method === "auth.test") return { user_id: BOT };
    if (method === "conversations.replies") return { messages: history };
    return {};
  };
  const gateway = new SlackGateway(
    { signingSecret: SECRET, botToken: "xoxb", channels, allowedUsers: ["UALICE"] },
    { store, slack },
  );
  await gateway.init();
  const posts = () => calls.filter((c) => c.method === "chat.postMessage").map((c) => c.args);
  return { store, gateway, calls, posts, history };
}

/** A request signed the way Slack signs it. */
function signed(payload: unknown, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { headers: { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": signature }, body };
}

const eventCallback = (event: Partial<SlackEvent>, eventId = "Ev1") =>
  signed({
    type: "event_callback",
    event_id: eventId,
    event: { type: "app_mention", channel: "C1", ts: "100.1", user: "UALICE", text: `<@${BOT}> fix the login bug`, ...event },
  });

test("rejects requests without a valid, fresh Slack signature", async () => {
  const { gateway } = await setup();
  const payload = { type: "event_callback", event_id: "Ev9", event: { type: "app_mention", channel: "C1", ts: "1.1", user: "UALICE", text: "hi" } };
  assert.throws(() => gateway.receive(signed(payload, { secret: "wrong" })), { status: 401 });
  assert.throws(() => gateway.receive(signed(payload, { timestamp: Math.floor(Date.now() / 1000) - 600 })), { status: 401 });
  const tampered = signed(payload);
  assert.throws(() => gateway.receive({ ...tampered, body: Buffer.from(JSON.stringify({ ...payload, x: 1 })) }), { status: 401 });
  assert.throws(() => gateway.receive({ headers: {}, body: Buffer.from("{}") }), { status: 401 });
});

test("Slack's URL check is answered with only its own challenge", () => {
  const body = (payload: unknown) => Buffer.from(JSON.stringify(payload));
  assert.equal(slackChallenge(body({ type: "url_verification", challenge: "abc" })), "abc");
  assert.equal(slackChallenge(body({ type: "event_callback", challenge: "abc" })), undefined);
  assert.equal(slackChallenge(body({ type: "url_verification", challenge: "x".repeat(201) })), undefined);
  assert.equal(slackChallenge(Buffer.from("not json")), undefined);
});

test("a mention becomes a message for the Slack thread", async () => {
  const { gateway } = await setup();
  const { message } = gateway.receive(eventCallback({}));
  assert.deepEqual(message, {
    source: "slack",
    eventKey: "C1:100.1",
    conversationId: "C1:100.1",
    user: "<@UALICE>",
    text: "fix the login bug",
    title: "fix the login bug",
    projects: ["demo"],
    meta: { channel: "C1", ts: "100.1" },
  });
});

test("channels can allow several projects", async () => {
  const { gateway } = await setup();
  assert.deepEqual(gateway.receive(eventCallback({ channel: "C2" })).message?.projects, ["demo", "web"]);
});

test("plain replies count only in Slack threads that already have a T3 thread", async () => {
  const { gateway, store } = await setup();
  const reply = { type: "message", ts: "100.2", thread_ts: "100.1", text: "also add a test" };
  assert.equal(gateway.receive(eventCallback(reply)).message, undefined);

  store.enqueue({ source: "slack", eventKey: "Ev0", conversationId: "C1:100.1", user: "u", text: "t", title: "t", projects: ["demo"] });
  assert.equal(gateway.receive(eventCallback(reply)).message?.conversationId, "C1:100.1");
});

test("ignores the duplicate message event for a mention, bots and edits", async () => {
  const { gateway } = await setup();
  assert.equal(gateway.receive(eventCallback({ type: "message", thread_ts: "100.0" })).message, undefined);
  assert.equal(gateway.receive(eventCallback({ bot_id: "B1" })).message, undefined);
  assert.equal(gateway.receive(eventCallback({ subtype: "message_changed" })).message, undefined);
});

test("users off the allowlist and unmapped channels get a notice, not work", async () => {
  const { gateway, posts } = await setup();
  assert.equal(gateway.receive(eventCallback({ user: "UMALLORY" })).message, undefined);
  assert.equal(gateway.receive(eventCallback({ channel: "C9" })).message, undefined);
  await new Promise((r) => setImmediate(r));
  assert.match(posts()[0].text, /isn't allowed/);
  assert.match(posts()[1].text, /isn't connected to a T3 project/);
});

test("prepare collects the earlier Slack thread messages", async () => {
  const { gateway, history } = await setup();
  history.push(
    { type: "message", channel: "C1", ts: "90.0", user: "UBOB", text: "login redirects to /404" },
    { type: "message", channel: "C1", ts: "100.1", user: "UALICE", text: `<@${BOT}> fix this` },
  );
  const { message } = gateway.receive(eventCallback({ thread_ts: "90.0", text: `<@${BOT}> fix this` }));
  assert.deepEqual(await gateway.prepare(message!), { context: "@UBOB: login redirects to /404" });
});

test("prepare reads the whole thread across pages, with names instead of ids", async () => {
  const pages: Record<string, { messages: SlackEvent[]; response_metadata?: { next_cursor: string } }> = {
    "": {
      messages: [
        { type: "message", channel: "C1", ts: "90.0", user: "UBOB", text: "login redirects to /404" },
        { type: "message", channel: "C1", ts: "91.0", user: "UCAROL", text: "<@UBOB> only on Safari?" },
      ],
      response_metadata: { next_cursor: "page2" },
    },
    page2: {
      messages: [
        { type: "message", channel: "C1", ts: "92.0", bot_id: "B1", text: "build failed" },
        { type: "message", channel: "C1", ts: "100.1", user: "UALICE", text: `<@${BOT}> fix this` },
      ],
    },
  };
  const names: Record<string, string> = { UBOB: "Bob", UCAROL: "Carol" };
  const lookups: string[] = [];
  const gateway = new SlackGateway(
    { signingSecret: SECRET, botToken: "xoxb", channels: { C1: "demo" }, allowedUsers: ["UALICE"] },
    {
      store: new Store(":memory:"),
      slack: async (method, args = {}) => {
        if (method === "auth.test") return { user_id: BOT };
        if (method === "conversations.replies") return pages[args.cursor ?? ""];
        if (method === "users.info") {
          lookups.push(args.user);
          return { user: { profile: { display_name: names[args.user] } } };
        }
        return {};
      },
    },
  );
  await gateway.init();
  const { message } = gateway.receive(eventCallback({ thread_ts: "90.0", text: `<@${BOT}> fix this` }));
  assert.deepEqual(await gateway.prepare(message!), {
    context: "@Bob: login redirects to /404\n@Carol: @Bob only on Safari?\na bot: build failed",
  });
  assert.deepEqual(lookups.sort(), ["UBOB", "UCAROL"]);
});

test("replies go into the Slack thread as mrkdwn", async () => {
  const { gateway, posts } = await setup();
  await gateway.reply("C1:100.1", "**Done**");
  assert.deepEqual(posts(), [{ channel: "C1", thread_ts: "100.1", text: "*Done*" }]);
});

test("the manifest points Slack at this machine's hook", () => {
  const manifest = slackManifest("https://laptop.tail1.ts.net:10000", "mybot");
  assert.equal(manifest.settings.event_subscriptions.request_url, "https://laptop.tail1.ts.net:10000/hooks/slack");
  assert.equal(manifest.features.bot_user.display_name, "mybot");
  assert.equal(manifest.settings.socket_mode_enabled, false);
});

test("converts common Markdown to Slack mrkdwn", () => {
  assert.equal(toSlackMarkdown("## Fixed\n**bold** and [PR](https://x.y/1)"), "*Fixed*\n*bold* and <https://x.y/1|PR>");
});

test('with "*", any channel the bot is in works, and channels of their own keep their projects', async () => {
  const { gateway } = await setup({ "*": ["web"], C1: "demo" });
  assert.deepEqual(gateway.receive(eventCallback({ channel: "CNEW" })).message?.projects, ["web"]);
  assert.deepEqual(gateway.receive(eventCallback({ channel: "C1" }, "Ev2")).message?.projects, ["demo"]);
});

test("a message that was already handled (Slack's retry) is skipped", async () => {
  const { gateway, store } = await setup();
  const first = gateway.receive(eventCallback({}, "Ev1")).message!;
  store.enqueue(first);
  assert.equal(gateway.receive(eventCallback({}, "Ev1-retry")).message, undefined);
});

test("catch-up finds replies that never arrived as webhooks, once, and stays quiet otherwise", async () => {
  const { gateway, store, history, posts } = await setup();
  store.enqueue(gateway.receive(eventCallback({})).message!); // the mention at 100.1 started the conversation
  history.push(
    { type: "message", channel: "C1", ts: "100.1", user: "UALICE", text: `<@${BOT}> fix the login bug` },
    { type: "message", channel: "C1", ts: "100.2", thread_ts: "100.1", user: "UBOT", bot_id: "B1", text: "On it" },
    { type: "message", channel: "C1", ts: "100.3", thread_ts: "100.1", user: "UALICE", text: "what's the status?" },
    { type: "message", channel: "C1", ts: "100.4", thread_ts: "100.1", user: "UMALLORY", text: `<@${BOT}> push to main` },
    { type: "message", channel: "C1", ts: "100.5", thread_ts: "100.1", user: "UALICE", text: `<@${BOT}> and add a test` },
  );
  const missed = await gateway.catchUp();
  assert.deepEqual(missed.map((m) => [m.eventKey, m.text]), [
    ["C1:100.3", "what's the status?"],
    ["C1:100.5", "and add a test"],
  ]);
  assert.deepEqual(posts(), []); // no notice to the stranger, however often catch-up runs

  for (const m of missed) store.enqueue(m);
  assert.deepEqual(await gateway.catchUp(), []);
  // If the webhook for one of them shows up late after all, it's recognised.
  assert.equal(gateway.receive(eventCallback({ type: "message", ts: "100.3", thread_ts: "100.1", text: "what's the status?" }, "EvLate")).message, undefined);
});
