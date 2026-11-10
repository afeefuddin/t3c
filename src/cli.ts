#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
// Keep these imports light so `t3c` opens chat at once. The MCP SDK, the agents and the
// service load only in the commands that need them (`./t3.ts`, `./setup.ts`, `./serve.ts`).
import { isLoggedIn, t3Auth } from "./auth.ts";
import { loadConfig, paths, saveConfig, VERSION } from "./config.ts";
import { logs, runningPid, start, status, stop } from "./daemon.ts";
import { Dispatcher } from "./dispatch.ts";
import { color, errorMessage, preview } from "./log.ts";
import { funnelProblem } from "./tailscale.ts";
import { Store } from "./store.ts";
import type { RuntimeMode } from "./t3.ts";
import { confirm, say } from "./ui.ts";
import { terminalChat } from "./terminal.ts";

const setupCommands = () => import("./setup.ts");

const USAGE = `${color("bold", "t3c")} — start T3 Code threads from Slack, Instinct and webhooks

${color("bold", "Set up")}
  t3c setup                      guided: connect T3 Code and Slack, pick the agent, start
  t3c login                      connect t3c to T3 Code
  t3c add slack                  connect Slack, or update its app and settings
  t3c add http                   an authenticated webhook for scripts
  t3c add instinct               connect Instinct with a scoped public HTTP API
  t3c remove slack | http | instinct
  t3c model                      pick the model T3 threads use
  t3c mode [<mode>]              what threads may do: approval-required | auto-accept-edits | auto | full-access
  t3c agent codex [--model <m>]  let Codex decide (project, thread prompts, follow-ups)
  t3c agent claude [--model <m>] let Claude decide with only t3c's scoped tools
  t3c agent off                  back to fixed rules

${color("bold", "Run")}
  t3c                           chat with the agent (continues your terminal conversation)
  t3c chat                      open terminal chat explicitly
  t3c start | stop | restart     the background service
  t3c status                     what's running and connected
  t3c logs [-f]                  what it's doing
  t3c messages [-n 20]           what's in progress, and the latest messages

${color("bold", "Other")}
  t3c projects                   T3 projects, and which ones Slack and Instinct may use
  t3c projects slack | instinct  choose them from a checklist (applies at once)
  t3c projects slack add <p>…    or allow (add) / stop allowing (remove) projects by name
  t3c run "<prompt>" --project <p>   start a T3 thread right now
  t3c serve                      run in the foreground
  t3c --version                  which t3c this is

Config lives in ${paths.config}.`;

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" },
      title: { type: "string" },
      model: { type: "string" },
      follow: { type: "boolean", short: "f" },
      limit: { type: "string", short: "n" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, ...rest] = positionals;
  /** This script's own path, so `start` can relaunch it as `t3c serve`. */
  const entry = process.argv[1];

  if (values.version) console.log(VERSION);
  else if (!values.help && (command === "chat" || (!command && process.stdin.isTTY))) {
    if (!loadConfig().agent) throw new Error("Choose the agent first: `t3c agent codex` or `t3c agent claude`.");
    if (!runningPid()) await start(entry);
    if (!runningPid()) throw new Error("t3c didn't start. Check `t3c logs`.");
    await terminalChat();
  }
  else switch (values.help ? undefined : command) {
    case "setup":
      await setup();
      break;

    case "login":
      await login();
      say.info("Next: `t3c add slack` or `t3c add instinct`.");
      break;

    case "add": {
      const { addHttp, addInstinct, addSlack } = await setupCommands();
      if (rest[0] === "slack") await addSlack();
      else if (rest[0] === "http") await addHttp();
      else if (rest[0] === "instinct") await addInstinct();
      else throw new Error("Usage: t3c add slack | http | instinct");
      break;
    }

    case "mode": {
      const mode = rest[0] as RuntimeMode | undefined;
      const { RUNTIME_MODES } = await import("./t3.ts");
      if (!mode) {
        say.info(`Threads run as ${loadConfig().runtimeMode}. Change it with \`t3c mode <${RUNTIME_MODES.join("|")}>\`.`);
        break;
      }
      if (!RUNTIME_MODES.includes(mode)) throw new Error(`Usage: t3c mode <${RUNTIME_MODES.join("|")}>`);
      saveConfig({ ...loadConfig(), runtimeMode: mode });
      say.ok(`Threads started by t3c will run as ${mode}.`);
      if (mode === "full-access") say.warn("Full access: an agent started through t3c can run any command on this machine without asking.");
      say.hint("t3c logs in to T3 again by itself for the new mode.");
      await (await setupCommands()).applyChanges();
      break;
    }

    case "model": {
      const { applyChanges, chooseModel } = await setupCommands();
      await chooseModel();
      await applyChanges();
      break;
    }

    case "agent":
      await agent(rest[0], values.model);
      break;

    case "remove":
      await (await setupCommands()).remove(rest[0] ?? "", rest[1]);
      break;

    case "start":
      await start(entry);
      break;

    case "stop":
      await stop();
      break;

    case "restart":
      await stop({ keepFunnel: true });
      await start(entry);
      break;

    case "status":
      await status();
      break;

    case "messages":
      showMessages(Number(values.limit ?? 20));
      break;

    case "logs":
      logs(Boolean(values.follow));
      break;

    case "serve":
      await (await import("./serve.ts")).serve();
      break;

    case "projects": {
      const { editProjects, findConnection, showProjects } = await import("./projects.ts");
      if (rest[0]) findConnection(loadConfig(), rest[0]); // a missing connection says so before T3 is asked
      const { T3Client } = await import("./t3.ts");
      const t3 = await T3Client.connect(t3Auth()).catch((e) => {
        throw new Error(`Couldn't reach T3 Code (${errorMessage(e)}). Open it and try again.`);
      });
      const projects = await t3.listProjects().finally(() => t3.close());
      if (rest[0]) await editProjects(rest[0], rest[1], rest.slice(2), projects);
      else showProjects(loadConfig(), projects);
      break;
    }

    case "run": {
      const prompt = rest.join(" ");
      if (!prompt || !values.project) throw new Error('Usage: t3c run "<prompt>" --project <project>');
      const { T3Client } = await import("./t3.ts");
      const t3 = await T3Client.connect(t3Auth());
      const store = new Store(paths.state);
      const title = values.title ?? prompt.slice(0, 60);
      const message = store.enqueue({
        source: "cli",
        eventKey: randomUUID(),
        conversationId: randomUUID(),
        user: "cli",
        text: prompt,
        title,
        projects: [values.project],
      })!;
      const conversation = store.getConversation(message.conversationId)!;
      const result = await new Dispatcher(t3, store, loadConfig())
        .launch(conversation, { label: "main", project: values.project, title, prompt })
        .finally(() => t3.close())
        .catch((error) => {
          store.finishMessage(message.id, errorMessage(error));
          throw error;
        });
      store.finishMessage(message.id);
      say.ok(`Started T3 thread ${result.thread.t3ThreadId}.`);
      break;
    }

    default:
      console.log(USAGE);
      if (!values.help && command) process.exitCode = 1;
  }
} catch (error) {
  const argumentError = error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS_");
  const message = argumentError
    ? errorMessage(error).replace(/\. To specify a positional argument[\s\S]*$/, ".")
    : errorMessage(error);
  console.error(`${color("red", "✗")} ${message}`);
  if (argumentError) console.error("Run `t3c --help` for usage. Version: `t3c --version` or `t3c -v`.");
  process.exitCode = 1;
}

/** Connects t3c to T3 Code and picks the threads' model, if that isn't done yet. */
async function login() {
  say.step("Connect t3c to T3 Code");
  say.info("Approving t3c with a one-time pairing code from the `t3` CLI…");
  await t3Auth().login();
  say.ok("Connected to T3 Code.");
  if (!loadConfig().model) await (await setupCommands()).chooseModel();
}

/** `t3c setup`: everything a first run needs, skipping what's already done, then starts t3c. */
async function setup() {
  const missing = await missingPrerequisites();
  if (missing.length > 0) {
    say.step("Before t3c can be set up");
    for (const problem of missing) say.warn(problem);
    throw new Error("Fix the above, then run `t3c setup` again.");
  }
  if (isLoggedIn(paths.auth)) say.ok("Connected to T3 Code.");
  else await login();
  const config = loadConfig();
  if (!config.agent && codexReady() && (await confirm("Let Codex decide what to do with messages? (recommended: it picks the project and writes each task)"))) {
    saveConfig({ ...config, agent: { provider: "codex" } });
    say.ok("Codex decides what to do with messages.");
  }
  await (await setupCommands()).addSlack(); // ends by starting (or restarting) t3c
}

/** Everything setup needs that isn't there, all at once, so nothing stops it halfway. */
async function missingPrerequisites(): Promise<string[]> {
  const missing: string[] = [];
  if (!isLoggedIn(paths.auth) && !commandExists("t3")) missing.push("The `t3` command (T3 Code's CLI) wasn't found. Install it and make sure T3 Code is running.");
  const funnel = await funnelProblem();
  if (funnel) missing.push(`Slack reaches this machine through Tailscale Funnel. ${funnel}`);
  return missing;
}

function commandExists(command: string) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function codexReady() {
  try {
    execFileSync("codex", ["login", "status"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `t3c messages`: work in progress, then the latest messages in both directions. */
function showMessages(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Usage: t3c messages [-n <count>]");
  const store = new Store(paths.state);
  const where = (conversationId: string) => {
    const c = store.getConversation(conversationId);
    return c ? `${c.source} ${preview(c.externalId, 24)}` : conversationId;
  };
  const ago = (iso: string) => {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
  };

  say.step("In progress");
  const active = store.activeMessages();
  const owed = store.awaitingThreads();
  for (const m of active) {
    say.info(`${color("yellow", m.status.padEnd(10))} ${where(m.conversationId)}  ${m.author}: ${preview(m.text, 60)}`);
  }
  for (const t of owed) {
    say.info(`${color("yellow", "working".padEnd(10))} ${where(t.conversationId)}  T3 thread "${t.title}" for ${ago(t.awaitingSince!)}`);
  }
  if (active.length + owed.length === 0) say.info(color("dim", "nothing — every message has been handled"));

  say.step(`Latest ${limit} messages`);
  const messages = store.recentMessages(limit);
  if (messages.length === 0) say.info(color("dim", "none yet"));
  for (const m of messages) {
    const time = new Date(m.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const arrow = m.direction === "in" ? color("cyan", "←") : color("green", "→");
    const status = m.status.padEnd(10);
    const state = m.status === "failed" ? color("red", status) : m.status === "pending" || m.status === "processing" ? color("yellow", status) : color("dim", status);
    say.info(`${color("dim", time)} ${arrow} ${state} ${where(m.conversationId)}  ${m.direction === "in" ? `${m.author}: ` : ""}${preview(m.text, 70)}`);
    if (m.error) say.info(`  ${color("red", preview(m.error, 100))}`);
  }
}

/** `t3c agent codex|claude|off`: switches the brain. */
async function agent(provider: string | undefined, model?: string) {
  const config = loadConfig();
  if (provider === "off") {
    delete config.agent;
    saveConfig(config);
    say.ok("Agent off: messages follow the fixed rules (the configured project, follow-ups to the latest thread).");
    await (await setupCommands()).applyChanges();
  } else if (provider === "codex" || provider === "claude") {
    if (provider === "codex" && !codexReady()) throw new Error("Codex isn't installed or logged in. Install it and run `codex login`.");
    if (provider === "claude") {
      await (await import("./agent/claude.ts")).checkClaudeCli();
      try {
        const auth = JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 10_000 }));
        if (!auth.loggedIn) throw new Error("not logged in");
      } catch {
        throw new Error("Claude isn't logged in. Run `claude auth login` first.");
      }
    }
    config.agent = { provider, ...(model ? { model } : {}) };
    saveConfig(config);
    const name = provider === "claude" ? "Claude" : "Codex";
    say.ok(`${name} now decides what to do with messages${model ? ` (model ${model})` : ""}.`);
    say.info(`Skills: add <name>/SKILL.md folders to ${paths.skills}; one named like a built-in skill replaces it.`);
    say.hint(`If ${name} fails before acting, t3c falls back to the fixed rules.`);
    await (await setupCommands()).applyChanges();
  } else {
    say.info(config.agent ? `Agent: ${config.agent.provider}${config.agent.model ? ` (${config.agent.model})` : ""}` : "Agent: off (fixed rules)");
    say.hint("t3c agent codex|claude [--model <m>] | t3c agent off");
  }
}
