import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { type SlackEvent, SlackGateway, slackManifest, toSlackMarkdown } from "../src/gateways/slack.ts";
import { Store } from "../src/store.ts";

const BOT = "UBOT";
const SECRET = "slack-signing-secret";

async function setup() {
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
    { signingSecret: SECRET, botToken: "xoxb", channels: { C1: "demo" }, allowedUsers: ["UALICE"] },
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
  const payload = { type: "url_verification", challenge: "c" };
  assert.throws(() => gateway.receive(signed(payload, { secret: "wrong" })), { status: 401 });
  assert.throws(() => gateway.receive(signed(payload, { timestamp: Math.floor(Date.now() / 1000) - 600 })), { status: 401 });
  const tampered = signed(payload);
  assert.throws(() => gateway.receive({ ...tampered, body: Buffer.from(JSON.stringify({ ...payload, x: 1 })) }), { status: 401 });
  assert.throws(() => gateway.receive({ headers: {}, body: Buffer.from("{}") }), { status: 401 });
});

test("answers Slack's URL verification challenge", async () => {
  const { gateway } = await setup();
  assert.deepEqual(gateway.receive(signed({ type: "url_verification", challenge: "abc" })), { response: { challenge: "abc" } });
});

test("a mention becomes a message for the Slack thread", async () => {
  const { gateway } = await setup();
  const { message } = gateway.receive(eventCallback({}));
  assert.deepEqual(message, {
    source: "slack",
    eventKey: "Ev1",
    conversationId: "C1:100.1",
    user: "<@UALICE>",
    text: "fix the login bug",
    title: "fix the login bug",
    project: "demo",
    meta: { channel: "C1", ts: "100.1" },
  });
});

test("plain replies count only in Slack threads that already have a T3 thread", async () => {
  const { gateway, store } = await setup();
  const reply = { type: "message", ts: "100.2", thread_ts: "100.1", text: "also add a test" };
  assert.equal(gateway.receive(eventCallback(reply)).message, undefined);

  store.claim({ source: "slack", externalId: "C1:100.1", projectId: "p1", title: "t" });
  store.markLaunched(store.find("slack", "C1:100.1")!.id, "t1");
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
  assert.deepEqual(await gateway.prepare(message!), { context: "<@UBOB>: login redirects to /404" });
});

test("replies go into the Slack thread as mrkdwn", async () => {
  const { gateway, posts } = await setup();
  await gateway.reply("C1:100.1", "**Done**");
  assert.deepEqual(posts(), [{ channel: "C1", thread_ts: "100.1", text: "*Done*" }]);
});

test("the manifest points Slack at this machine's hook", () => {
  const manifest = slackManifest("https://laptop.tail1.ts.net:8443", "mybot");
  assert.equal(manifest.settings.event_subscriptions.request_url, "https://laptop.tail1.ts.net:8443/hooks/slack");
  assert.equal(manifest.features.bot_user.display_name, "mybot");
  assert.equal(manifest.settings.socket_mode_enabled, false);
});

test("converts common Markdown to Slack mrkdwn", () => {
  assert.equal(toSlackMarkdown("## Fixed\n**bold** and [PR](https://x.y/1)"), "*Fixed*\n*bold* and <https://x.y/1|PR>");
});
