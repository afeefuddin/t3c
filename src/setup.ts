import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadConfig, paths, saveConfig, t3McpUrl } from "./config.ts";
import { connectRepo, githubApi } from "./gateways/github.ts";
import { slackApi, slackManifest } from "./gateways/slack.ts";
import { errorMessage } from "./log.ts";
import { T3Client } from "./t3.ts";
import { funnelBaseUrl } from "./tailscale.ts";
import { ask, choose, confirm, say } from "./ui.ts";

/** `t3c add slack`: first run connects the workspace; later runs add channels. */
export async function addSlack() {
  const config = loadConfig();
  let slack = config.slack;

  if (!slack || (await confirm("Slack is already connected. Reconnect the app (new tokens)?", false))) {
    const base = await publicUrl();
    say.step("1. Create the Slack app");
    const manifest = JSON.stringify(slackManifest(base), null, 2);
    if (copy(manifest)) say.ok("Copied the app manifest to your clipboard.");
    else console.log(manifest);
    say.info("In the browser: Create New App → From a manifest → pick your workspace → paste the");
    say.info("manifest (JSON tab) → Create → Install to Workspace.");
    openUrl("https://api.slack.com/apps?new_app=1");
    await ask("Press Enter when the app is installed", { default: "done" });

    say.step("2. Paste its credentials");
    say.hint("OAuth & Permissions → Bot User OAuth Token");
    let team = "";
    const botToken = await ask("Bot token (xoxb-…)", {
      hidden: true,
      default: slack?.botToken,
      validate: async (token) => {
        if (!token.startsWith("xoxb-")) return "Bot tokens start with xoxb-.";
        try {
          const auth = await slackApi(token)("auth.test");
          team = `${auth.team} as @${auth.user}`;
        } catch (error) {
          return `Slack rejected it: ${errorMessage(error)}`;
        }
      },
    });
    say.ok(`Connected to ${team}.`);
    say.hint("Basic Information → App Credentials → Signing Secret");
    const signingSecret = await ask("Signing secret", {
      hidden: true,
      default: slack?.signingSecret,
      validate: (s) => (/^[0-9a-f]{32}$/.test(s) ? undefined : "That doesn't look like a signing secret (32 hex characters)."),
    });
    slack = { botToken, signingSecret, channels: slack?.channels ?? {}, allowedUsers: slack?.allowedUsers ?? [] };
    saveConfig({ ...config, slack });
  }

  const api = slackApi(slack.botToken);
  say.step("Who may use the bot?");
  say.hint("Only these people can start work on this machine. Find your id: Slack → your profile → ⋮ → Copy member ID.");
  const users = await ask("Slack member ids, comma-separated", {
    default: slack.allowedUsers.join(",") || undefined,
    validate: async (value) => {
      for (const id of split(value)) {
        try {
          await api("users.info", { user: id });
        } catch {
          return `${id} isn't a member of this workspace.`;
        }
      }
    },
  });
  slack.allowedUsers = split(users);

  say.step("Connect a channel");
  let channels: { id: string; name: string }[] = [];
  for (;;) {
    const result = await api("users.conversations", { types: "public_channel,private_channel", limit: "200" });
    channels = result.channels.filter((c: { id: string }) => !slack.channels[c.id]);
    if (channels.length > 0) break;
    say.info("The bot isn't in any new channel yet. In Slack, open the channel and type: /invite @t3bot");
    await ask("Press Enter once it's invited", { default: "done" });
  }
  const channel = await choose(
    "Which channel?",
    channels.map((c) => ({ label: `#${c.name}`, value: c })),
  );
  const project = await chooseProject(`Which T3 project should #${channel.name} work on?`);
  slack.channels[channel.id] = project;
  saveConfig({ ...loadConfig(), slack });

  say.ok(`#${channel.name} → ${project}`);
  finish(`Mention @t3bot in #${channel.name} to start a T3 thread. Run \`t3c add slack\` again to add more channels.`);
  say.hint("First time? After `t3c start`, open the app's Event Subscriptions page and click Retry so Slack verifies the URL.");
}

/** `t3c add github owner/repo`: creates the webhook and maps the repo to a project. */
export async function addGithub(repo: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Usage: t3c add github <owner/repo>");
  const config = loadConfig();
  const token = githubToken();
  const github = githubApi(token);

  say.step(`Connect ${repo}`);
  const [info, me] = await Promise.all([github("GET", `/repos/${repo}`), github("GET", "/user")]);
  if (!info.permissions?.admin) throw new Error(`You need admin access to ${repo} to add a webhook.`);
  say.ok(`Found ${info.full_name} (you are @${me.login}).`);

  const current = config.github;
  const users = await ask("GitHub users allowed to use /t3c, comma-separated", {
    default: current?.allowedUsers.join(",") || me.login,
  });
  const project = await chooseProject(`Which T3 project is ${repo}?`);
  const githubConfig = {
    webhookSecret: current?.webhookSecret ?? randomBytes(32).toString("base64url"),
    repos: { ...current?.repos, [info.full_name]: project },
    allowedUsers: split(users),
  };

  const hookUrl = `${await publicUrl()}/hooks/github`;
  const { created } = await connectRepo(github, info.full_name, hookUrl, githubConfig.webhookSecret);
  saveConfig({ ...loadConfig(), github: githubConfig });
  say.ok(`${created ? "Added" : "Updated"} the webhook → ${hookUrl}`);
  finish(`Comment \`/t3c <what to do>\` on any issue or pull request in ${info.full_name}.`);
}

/** `t3c add http`: a bearer-protected endpoint for scripts and cron. */
export function addHttp() {
  const config = loadConfig();
  const secret = config.http?.secret ?? randomBytes(32).toString("base64url");
  saveConfig({ ...config, http: { secret } });
  say.ok("HTTP gateway enabled.");
  say.info("Example:");
  say.info(`curl -X POST http://127.0.0.1:${config.port}/hooks/http \\`);
  say.info(`  -H "Authorization: Bearer ${secret}" -H 'content-type: application/json' \\`);
  say.info(`  -d '{"conversationId":"job-1","project":"<project>","title":"Fix login","prompt":"Fix the login bug"}'`);
  finish("Calls with the same conversationId continue the same T3 thread.");
}

export async function remove(kind: string, target?: string) {
  const config = loadConfig();
  if (kind === "slack" && target) {
    if (!config.slack?.channels[target]) throw new Error(`Channel ${target} isn't connected.`);
    delete config.slack.channels[target];
  } else if (kind === "slack") {
    delete config.slack;
    say.info("You can delete the app itself at https://api.slack.com/apps.");
  } else if (kind === "github" && target) {
    const repo = Object.keys(config.github?.repos ?? {}).find((r) => r.toLowerCase() === target.toLowerCase());
    if (!config.github || !repo) throw new Error(`${target} isn't connected.`);
    delete config.github.repos[repo];
    if (Object.keys(config.github.repos).length === 0) delete config.github;
    await removeWebhook(repo).catch((e) => say.warn(`Couldn't delete the webhook: ${errorMessage(e)}`));
  } else if (kind === "http") {
    delete config.http;
  } else {
    throw new Error("Usage: t3c remove slack [channel-id] | github <owner/repo> | http");
  }
  saveConfig(config);
  finish(`Removed ${[kind, target].filter(Boolean).join(" ")}.`);
}

async function removeWebhook(repo: string) {
  const github = githubApi(githubToken());
  const base = await publicUrl();
  const hooks: { id: number; config: { url?: string } }[] = await github("GET", `/repos/${repo}/hooks`);
  for (const hook of hooks.filter((h) => h.config.url === `${base}/hooks/github`)) {
    await github("DELETE", `/repos/${repo}/hooks/${hook.id}`);
    say.ok(`Deleted the webhook on ${repo}.`);
  }
}

/** Lists T3 projects when t3c is logged in; otherwise asks for a name. */
async function chooseProject(label: string): Promise<string> {
  let projects: { id: string; title: string }[] = [];
  try {
    const t3 = await T3Client.connect(t3McpUrl(), paths.auth);
    projects = await t3.listProjects();
    await t3.close();
  } catch (error) {
    say.hint(`Couldn't list T3 projects (${errorMessage(error)}).`);
  }
  if (projects.length === 0) return ask(`${label} Project name`);
  return choose(
    label,
    projects.map((p) => ({ label: p.title, value: p.title })),
  );
}

async function publicUrl() {
  try {
    return await funnelBaseUrl();
  } catch (error) {
    throw new Error(`Tailscale is needed so Slack and GitHub can reach this machine: ${errorMessage(error)}`);
  }
}

export function githubToken() {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("t3c uses the GitHub CLI's login. Install gh and run `gh auth login` first.");
  }
}

function finish(text: string) {
  say.step("Done.");
  say.info(text);
  say.hint("Changes apply after `t3c restart` (or `t3c start` if it isn't running).");
}

function split(value: string) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function copy(text: string) {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("pbcopy", { input: text });
    return true;
  } catch {
    return false;
  }
}

export function openUrl(url: string) {
  if (process.platform === "darwin") execFile("open", [url]);
  else say.info(url);
}
