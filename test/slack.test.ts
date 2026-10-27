import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { render, type SlackEvent, SlackGateway, slackChallenge, slackManifest, toSlackMarkdown } from "../src/gateways/slack.ts";
import { Store } from "../src/store.ts";

const BOT = "UBOT";
const SECRET = "slack-signing-secret";

async function setup({ projects = ["demo"], member = ["C1", "C2", "D1"] } = {}) {
  const store = new Store(":memory:");
  const calls: { method: string; args: Record<string, string> }[] = [];
  const history: SlackEvent[] = [];
  const slack = async (method: string, args: Record<string, string> = {}) => {
    calls.push({ method, args });
    if (method === "auth.test") return { user_id: BOT };
    if (method === "users.conversations") return { channels: member.map((id) => ({ id })) };
    if (method === "conversations.replies") return { messages: history.filter((m) => (m.thread_ts ?? m.ts) === args.ts) };
    if (method === "conversations.history") {
      // Top-level messages (and thread broadcasts) in the channel after `oldest`, newest first.
      const after = history.filter((m) => m.channel === args.channel && Number(m.ts) > Number(args.oldest));
      return { messages: after.toReversed() };
    }
    return {};
  };
  const gateway = new SlackGateway(
    { signingSecret: SECRET, botToken: "xoxb", projects, allowedUsers: ["UALICE"] },
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

test("any channel the bot is in works, with the configured projects", async () => {
  const { gateway } = await setup({ projects: ["demo", "web"] });
  assert.deepEqual(gateway.receive(eventCallback({ channel: "CNEW" })).message?.projects, ["demo", "web"]);
});

test("in a DM every message is a request, mention or not, and replies in its Slack thread follow up", async () => {
  const { gateway, store } = await setup();
  const dm = (event: Partial<SlackEvent>, id: string) => gateway.receive(eventCallback({ type: "message", channel: "D1", ...event }, id)).message;
  const first = dm({ text: "merge #4351" }, "Ev1")!;
  assert.deepEqual([first.conversationId, first.text], ["D1:100.1", "merge #4351"]);
  store.enqueue(first);
  assert.equal(dm({ ts: "100.2", thread_ts: "100.1", text: "and deploy it" }, "Ev2")?.conversationId, "D1:100.1");
  assert.equal(dm({ ts: "100.3", text: `<@${BOT}> check the build` }, "Ev3")?.text, "check the build");
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

test("users off the allowlist get a notice, not work, in channels and DMs", async () => {
  const { gateway, posts } = await setup();
  assert.equal(gateway.receive(eventCallback({ user: "UMALLORY" })).message, undefined);
  assert.equal(gateway.receive(eventCallback({ type: "message", channel: "D9", user: "UMALLORY", text: "hi" }, "Ev2")).message, undefined);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posts().map((p) => [p.channel, /isn't allowed/.test(p.text)]), [["C1", true], ["D9", true]]);
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
    { signingSecret: SECRET, botToken: "xoxb", projects: ["demo"], allowedUsers: ["UALICE"] },
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

test("the manifest points Slack at this machine's hook and lets people DM the bot", () => {
  const manifest = slackManifest("https://laptop.tail1.ts.net:10000", "mybot");
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes("message.im"));
  assert.ok(manifest.oauth_config.scopes.bot.includes("im:history"));
  assert.equal(manifest.features.app_home.messages_tab_enabled, true);
  assert.equal(manifest.settings.event_subscriptions.request_url, "https://laptop.tail1.ts.net:10000/hooks/slack");
  assert.equal(manifest.features.bot_user.display_name, "mybot");
  assert.equal(manifest.settings.socket_mode_enabled, false);
});

test("converts common Markdown to Slack mrkdwn", () => {
  assert.equal(toSlackMarkdown("## Fixed\n**bold** and [PR](https://x.y/1)"), "*Fixed*\n*bold* and <https://x.y/1|PR>");
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

test("catch-up recovers a new mention whose webhook was lost or rejected, once, without replaying older ones", async () => {
  const { gateway, store, history, posts } = await setup();
  const now = Date.now() / 1000;
  const ts = (secondsAgo: number) => (now - secondsAgo).toFixed(6);
  history.push(
    // Sent before t3c started, and t3c has never worked in C1: not replayed.
    { type: "message", channel: "C1", ts: ts(3600), user: "UALICE", text: `<@${BOT}> old request` },
    { type: "message", channel: "C1", ts: ts(-1), user: "UALICE", text: `<@${BOT}> we have to improve the fold tickets` },
    { type: "message", channel: "C1", ts: ts(-2), user: "UALICE", text: "chatter without a mention" },
    { type: "message", channel: "C1", ts: ts(-3), thread_ts: ts(-1), user: "UALICE", text: `<@${BOT}> a reply` },
    { type: "message", channel: "C2", ts: ts(-4), user: "UMALLORY", text: `<@${BOT}> push to main` },
    // In a DM, no mention is needed.
    { type: "message", channel: "D1", ts: ts(-5), user: "UALICE", text: "merge #4351" },
  );

  // Slack's delivery is rejected (here: a stale timestamp)...
  const webhook = signed(
    { type: "event_callback", event_id: "Ev9", event: { ...history[1], type: "app_mention" } },
    { timestamp: Math.floor(now) - 10 * 60 },
  );
  assert.throws(() => gateway.receive(webhook), /Stale or missing Slack timestamp/);

  // ...and catch-up picks the message up anyway, as the same message a webhook would bring.
  const missed = await gateway.catchUp();
  assert.deepEqual(missed.map((m) => [m.eventKey, m.conversationId, m.text]), [
    [`C1:${ts(-1)}`, `C1:${ts(-1)}`, "we have to improve the fold tickets"],
    [`D1:${ts(-5)}`, `D1:${ts(-5)}`, "merge #4351"],
  ]);
  assert.deepEqual(posts(), []);
  for (const m of missed) store.enqueue(m);
  // Now that its conversation exists, the reply in its thread is caught up too; then nothing.
  const replies = await gateway.catchUp();
  assert.deepEqual(replies.map((m) => m.text), ["a reply"]);
  for (const m of replies) store.enqueue(m);
  assert.deepEqual(await gateway.catchUp(), []);
});

test("catch-up reaches back to t3c's first message in a channel, so mentions sent while it was down are recovered", async () => {
  const { gateway, store, history } = await setup();
  const now = Date.now() / 1000;
  // t3c handled a message in C1 an hour ago, so it was connected then.
  const earlier = (now - 3600).toFixed(6);
  store.enqueue({ ...gateway.receive(eventCallback({ ts: earlier }, "Ev1")).message! });
  (store as any).db.prepare("UPDATE messages SET created_at = ?").run(new Date((now - 3600) * 1000).toISOString());
  const whileDown = (now - 600).toFixed(6);
  history.push({ type: "message", channel: "C1", ts: whileDown, user: "UALICE", text: `<@${BOT}> sent while t3c was down` });
  assert.deepEqual((await gateway.catchUp()).map((m) => m.text), ["sent while t3c was down"]);
});

const shot = { name: "shot.png", mimetype: "image/png", size: 3, url_private_download: "https://files.slack.com/shot.png" };

test("a message is read whole: bot cards, link previews, forwarded messages, blocks and files", () => {
  const text = render({
    type: "message",
    channel: "C1",
    ts: "1.0",
    text: "CI is red",
    attachments: [
      { title: "Build #88 failed", title_link: "https://ci/88", text: "rails tests", fields: [{ title: "Branch", value: "main" }] },
      { fallback: "forwarded: login 404s", files: [{ ...shot, name: "fwd.png" }] },
    ],
    blocks: [
      { type: "rich_text" },
      { type: "section", text: { text: "Failed step: rspec" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "by GitHub Actions" }] },
    ],
    files: [shot, { name: "gone.png", mode: "tombstone" }],
  });
  assert.equal(
    text,
    [
      "CI is red",
      "> Build #88 failed (https://ci/88)\n> rails tests\n> Branch: main",
      "> forwarded: login 404s",
      "Failed step: rspec\nby GitHub Actions",
      "[file: shot.png (image/png)]",
      "[file: fwd.png (image/png)]",
    ].join("\n"),
  );
});

test("messages with files are requests too, even with no text, and carry the files along", async () => {
  const { gateway, store } = await setup();
  const first = gateway.receive(eventCallback({ text: `<@${BOT}> why is this broken?`, files: [shot] })).message!;
  assert.deepEqual(first.files, [{ name: "shot.png", mimeType: "image/png", size: 3, url: "https://files.slack.com/shot.png" }]);
  assert.equal(first.text, "why is this broken?\n[file: shot.png (image/png)]");
  store.enqueue(first);
  // A screenshot dropped into the thread (Slack marks it file_share) is a follow-up, not ignored.
  const reply = gateway.receive(eventCallback({ type: "message", subtype: "file_share", ts: "100.2", thread_ts: "100.1", text: "", files: [shot] }, "Ev2")).message;
  assert.equal(reply?.text, "[file: shot.png (image/png)]");
  assert.equal(reply?.files?.length, 1);
});

test("prepare includes everything in the earlier thread, files too", async () => {
  const { gateway, history } = await setup();
  history.push(
    { type: "message", channel: "C1", ts: "90.0", bot_id: "B1", text: "", attachments: [{ title: "Deploy failed" }] },
    { type: "message", channel: "C1", ts: "91.0", thread_ts: "90.0", user: "UBOB", text: "here", files: [shot] },
  );
  const { message } = gateway.receive(eventCallback({ thread_ts: "90.0", text: `<@${BOT}> fix this` }));
  const prepared = await gateway.prepare(message!);
  assert.equal(prepared.context, "a bot: > Deploy failed\n@UBOB: here\n[file: shot.png (image/png)]");
  assert.deepEqual(prepared.files?.map((f) => f.name), ["shot.png"]);
});
