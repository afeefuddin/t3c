import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadConfig, paths, saveConfig } from "./config.ts";
import { connectRepo, githubApi } from "./gateways/github.ts";
import { findSlackUsers, SLACK_BOT_SCOPES, slackApi, slackAppInfo, slackManifest, slackNewAppUrl } from "./gateways/slack.ts";
import { errorMessage } from "./log.ts";
import { isLoggedIn, t3Auth } from "./auth.ts";
import { T3Client } from "./t3.ts";
import { runningPid, start, stop } from "./daemon.ts";
import { slackChallengeServer } from "./server.ts";
import { disableFunnel, enableFunnel, funnelBaseUrl } from "./tailscale.ts";
import { ask, choose, confirm, say } from "./ui.ts";

/**
 * `t3c add slack`: first run creates and connects the app; later runs bring the app up to date and
 * change who may use it. The bot works in every channel it's invited to and in DMs.
 */
export async function addSlack() {
  const config = loadConfig();
  const previous = config.slack;
  let slack = previous;

  if (slack && !(await confirm("Slack is already connected. Connect a different Slack app instead?", false))) {
    await updateSlackApp(slack.botToken);
  } else {
    const manifest = slackManifest(await publicUrl());
    say.step("1. Create the Slack app");
    say.info("Opening Slack with the app's settings filled in. Pick your workspace → Next → Create,");
    say.info("then Install to Workspace → Allow.");
    const stopAnswering = await answerSlackUrlCheck(config.port);
    openUrl(slackNewAppUrl(manifest));
    try {
      await ask("Press Enter once it's installed", { default: "done" });
    } finally {
      await stopAnswering();
    }

    say.step("2. Connect it");
    say.hint("On the app's page: OAuth & Permissions → Bot User OAuth Token → Copy");
    let team = "";
    const botToken = await ask("Bot token (xoxb-…)", {
      hidden: true,
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
    const { appId } = await slackAppInfo(botToken).catch(() => ({ appId: undefined }));
    if (appId) openUrl(`https://api.slack.com/apps/${appId}`);
    say.hint(`${appId ? "Opened the app's settings: " : "On the app's page: "}Basic Information → App Credentials → Signing Secret → Show → copy`);
    const signingSecret = await ask("Signing secret", {
      hidden: true,
      validate: (s) => (/^[0-9a-f]{32}$/.test(s) ? undefined : "That doesn't look like a signing secret (32 hex characters)."),
    });
    slack = { botToken, signingSecret, projects: previous?.projects ?? ["*"], allowedUsers: previous?.allowedUsers ?? [] };
    saveConfig({ ...config, slack });
  }

  const api = slackApi(slack.botToken);
  say.step("Who may use the bot?");
  say.hint("Only they can start work on this machine. Their Slack @handles or names, e.g. @afeef, Priya.");
  let allowed: { id: string; name: string }[] = [];
  await ask("People, comma-separated", {
    default: slack.allowedUsers.join(", ") || undefined,
    validate: async (value) => {
      const found = await findSlackUsers(api, split(value));
      if ("error" in found) return found.error;
      allowed = found.users;
    },
  });
  slack.allowedUsers = allowed.map((u) => u.id);
  say.ok(`Allowed: ${allowed.map((u) => `@${u.name}`).join(", ")}`);

  slack.projects = await chooseProjects("Which T3 projects may the bot work on?", slack.projects);
  saveConfig({ ...loadConfig(), slack });
  say.ok(`Projects: ${slack.projects.join(", ")}`);
  if (!loadConfig().agent && (slack.projects.length > 1 || slack.projects[0] === "*")) {
    say.hint("Messages pick one with `in:<project>`, or turn on `t3c agent codex` to let Codex pick.");
  }
  await finish("Invite the bot to a channel (/invite @<your bot>) and mention it there, or DM it.");
}

/** Checks a connected app has every scope t3c needs, and walks through updating it if not. */
async function updateSlackApp(botToken: string) {
  const { appId, scopes } = await slackAppInfo(botToken);
  const missing = () => SLACK_BOT_SCOPES.filter((s) => !scopes.includes(s));
  if (missing().length === 0) return say.ok("The Slack app is up to date.");
  say.step("Update the Slack app");
  say.warn(`It's missing ${missing().join(", ")}, which DMs and files need.`);
  const manifest = JSON.stringify(slackManifest(await publicUrl()), null, 2);
  if (copy(manifest)) say.ok("Copied the current app manifest to your clipboard.");
  else console.log(manifest);
  say.info(`${appId ? "Opening the app's settings" : "Open your app at api.slack.com/apps"}: App Manifest → replace it with this one (JSON tab) → Save → Reinstall to Workspace → Allow.`);
  openUrl(appId ? `https://api.slack.com/apps/${appId}` : "https://api.slack.com/apps");
  await ask("Press Enter once it's reinstalled", { default: "done" });
  scopes.splice(0, scopes.length, ...(await slackAppInfo(botToken)).scopes);
  if (missing().length === 0) say.ok("The Slack app is up to date.");
  else say.warn(`Still missing ${missing().join(", ")}. Run \`t3c add slack\` again after reinstalling the app.`);
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
  await finish(`Comment \`/t3c <what to do>\` on any issue or pull request in ${info.full_name}.`);
}

/** `t3c add http`: a bearer-protected endpoint for scripts and cron. */
export async function addHttp() {
  const config = loadConfig();
  const secret = config.http?.secret ?? randomBytes(32).toString("base64url");
  saveConfig({ ...config, http: { secret } });
  say.ok("HTTP gateway enabled.");
  say.info("Example:");
  say.info(`curl -X POST http://127.0.0.1:${config.port}/hooks/http \\`);
  say.info(`  -H "Authorization: Bearer ${secret}" -H 'content-type: application/json' \\`);
  say.info(`  -d '{"conversationId":"job-1","project":"<project>","title":"Fix login","prompt":"Fix the login bug"}'`);
  await finish("Calls with the same conversationId continue the same T3 thread.");
}

export async function remove(kind: string, target?: string) {
  const config = loadConfig();
  if (kind === "slack" && target) {
    // Channels used to be connected one by one; now the bot works wherever it's invited.
    throw new Error("Channels aren't connected one by one any more: remove the bot from the channel in Slack instead.");
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
    throw new Error("Usage: t3c remove slack | github <owner/repo> | http");
  }
  saveConfig(config);
  await finish(`Removed ${[kind, target].filter(Boolean).join(" ")}.`);
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

/** One or more projects (numbers or names, comma-separated), or * for any. Keeps `current` on Enter. */
async function chooseProjects(label: string, current: string[] = []): Promise<string[]> {
  const projects = await listProjectsQuietly();
  if (projects.length > 0) {
    say.info(label);
    projects.forEach((p, i) => say.info(`  ${i + 1}. ${p.title}`));
    say.info("  *. any project");
  }
  const pick = (x: string) => projects[Number(x) - 1] ?? projects.find((p) => p.title.toLowerCase() === x.toLowerCase());
  const answer = await ask(projects.length > 0 ? "Numbers or names, comma-separated (or *)" : `${label} Project names, comma-separated (or *)`, {
    default: current.join(", ") || undefined,
    validate: (v) =>
      split(v).every((x) => x === "*" || !projects.length || pick(x)) ? undefined : `Pick from 1–${projects.length}, a project's name, or *.`,
  });
  const picks = split(answer);
  if (picks.includes("*")) return ["*"];
  return picks.map((x) => (projects.length ? pick(x)!.title : x));
}

/** Lists T3 projects when t3c is logged in; otherwise asks for a name. */
async function chooseProject(label: string): Promise<string> {
  const projects = await listProjectsQuietly();
  if (projects.length === 0) return ask(`${label} Project name`);
  return choose(
    label,
    projects.map((p) => ({ label: p.title, value: p.title })),
  );
}

/** Picks the model for the threads t3c starts, from the providers enabled in T3. */
export async function chooseModel() {
  const t3 = await T3Client.connect(t3Auth());
  const models = await t3.listModels().finally(() => t3.close());
  if (models.length === 0) throw new Error("No providers are enabled in T3 Code. Enable one in T3's settings first.");
  const config = loadConfig();
  const model = await choose(
    "Which model should threads started by t3c use? (`t3c model` changes it later)",
    models.map(({ label, ...value }) => ({ label: config.model?.model === value.model ? `${label} (current)` : label, value })),
  );
  saveConfig({ ...config, model });
  say.ok(`Threads will use ${model.model}.`);
}

/**
 * Slack verifies the manifest's Events URL as the app is created, before t3c has the app's
 * tokens and can run. Until the app is installed, this answers that check (and nothing else).
 */
async function answerSlackUrlCheck(port: number): Promise<() => Promise<void>> {
  // A running t3c answers the check itself.
  if (runningPid()) return async () => {};
  const server = slackChallengeServer();
  try {
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
    await enableFunnel(port);
  } catch (error) {
    server.close();
    say.warn(`Couldn't answer Slack's URL check (${errorMessage(error)}). If Slack says the URL isn't verified, save anyway and click Retry under Event Subscriptions after \`t3c start\`.`);
    return async () => {};
  }
  say.hint("Answering Slack's URL check while you create the app.");
  return async () => {
    server.close();
    await disableFunnel().catch(() => {});
  };
}

async function listProjectsQuietly(): Promise<{ id: string; title: string }[]> {
  let projects: { id: string; title: string }[] = [];
  try {
    const t3 = await T3Client.connect(t3Auth());
    projects = await t3.listProjects();
    await t3.close();
  } catch (error) {
    say.hint(`Couldn't list T3 projects (${errorMessage(error)}).`);
  }
  return projects;
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

async function finish(text: string) {
  say.step("Done.");
  say.info(text);
  await applyChanges();
}

/** Restarts t3c (or starts it, once it has something to run) so new settings take effect. */
export async function applyChanges() {
  const entry = process.argv[1];
  const config = loadConfig();
  if (runningPid()) {
    if (!(await confirm("Restart t3c now so this takes effect?"))) return say.hint("It applies after `t3c restart`.");
    await stop({ keepFunnel: true });
    await start(entry);
  } else if (isLoggedIn(paths.auth) && (config.slack || config.github || config.http)) {
    if (!(await confirm("Start t3c now?"))) return say.hint("Start it with `t3c start`.");
    await start(entry);
  }
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
