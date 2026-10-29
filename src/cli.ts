#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { CodexBrain } from "./agent/codex.ts";
import { AgentToolServer } from "./agent/mcp.ts";
import { overriddenSkills } from "./agent/skills.ts";
import { isLoggedIn, t3Auth } from "./auth.ts";
import { loadConfig, paths, saveConfig, VERSION } from "./config.ts";
import { type Brain, SimpleBrain } from "./brain.ts";
import { describeGateways, logs, runningPid, start, status, stop } from "./daemon.ts";
import { Dispatcher } from "./dispatch.ts";
import type { Gateway } from "./gateway.ts";
import { GithubGateway } from "./gateways/github.ts";
import { httpGateway } from "./gateways/http.ts";
import { SlackGateway } from "./gateways/slack.ts";
import { color, errorMessage, log, preview } from "./log.ts";
import { createApp } from "./server.ts";
import { funnelProblem } from "./tailscale.ts";
import { addGithub, addHttp, addSlack, applyChanges, chooseModel, githubToken, remove } from "./setup.ts";
import { Store } from "./store.ts";
import { RUNTIME_MODES, type RuntimeMode, T3Client } from "./t3.ts";
import { confirm, say } from "./ui.ts";
import { Worker } from "./worker.ts";

/** How often followed conversations are checked for messages that never arrived as webhooks. */
const CATCH_UP_INTERVAL_MS = 20_000;
/** How often running T3 threads are checked for being stuck. */
const SUPERVISE_INTERVAL_MS = 2 * 60_000;

const USAGE = `${color("bold", "t3c")} — start T3 Code threads from Slack, GitHub and webhooks

${color("bold", "Set up")}
  t3c setup                      guided: connect T3 Code and Slack, pick the agent, start
  t3c login                      connect t3c to T3 Code
  t3c add slack                  connect Slack, or update its app and settings
  t3c add github <owner/repo>    let /t3c comments in a repo start work
  t3c add http                   an authenticated webhook for scripts
  t3c remove slack | github <owner/repo> | http
  t3c model                      pick the model T3 threads use
  t3c mode [<mode>]              what threads may do: approval-required | auto-accept-edits | auto | full-access
  t3c agent codex [--model <m>]  let Codex decide (project, thread prompts, follow-ups)
  t3c agent off                  back to fixed rules

${color("bold", "Run")}
  t3c start | stop | restart     the background service
  t3c status                     what's running and connected
  t3c logs [-f]                  what it's doing
  t3c messages [-n 20]           what's in progress, and the latest messages

${color("bold", "Other")}
  t3c projects                   list T3 projects
  t3c run "<prompt>" --project <p>   start a T3 thread right now
  t3c serve                      run in the foreground
  t3c --version                  which t3c this is

Config lives in ${paths.config}.`;

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

try {
  if (values.version) console.log(VERSION);
  else switch (values.help ? undefined : command) {
    case "setup":
      await setup();
      break;

    case "login":
      await login();
      say.info("Next: `t3c add slack` or `t3c add github <owner/repo>`.");
      break;

    case "add":
      if (rest[0] === "slack") await addSlack();
      else if (rest[0] === "github") await addGithub(rest[1] ?? "");
      else if (rest[0] === "http") await addHttp();
      else throw new Error("Usage: t3c add slack | github <owner/repo> | http");
      break;

    case "mode": {
      const mode = rest[0] as RuntimeMode | undefined;
      if (!mode) {
        say.info(`Threads run as ${loadConfig().runtimeMode}. Change it with \`t3c mode <${RUNTIME_MODES.join("|")}>\`.`);
        break;
      }
      if (!RUNTIME_MODES.includes(mode)) throw new Error(`Usage: t3c mode <${RUNTIME_MODES.join("|")}>`);
      saveConfig({ ...loadConfig(), runtimeMode: mode });
      say.ok(`Threads started by t3c will run as ${mode}.`);
      if (mode === "full-access") say.warn("Full access: an agent started from Slack or GitHub can run any command on this machine without asking.");
      say.hint("t3c logs in to T3 again by itself for the new mode.");
      await applyChanges();
      break;
    }

    case "model":
      await chooseModel();
      await applyChanges();
      break;

    case "agent":
      await agent(rest[0]);
      break;

    case "remove":
      await remove(rest[0] ?? "", rest[1]);
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
      await serve();
      break;

    case "projects": {
      const t3 = await T3Client.connect(t3Auth());
      for (const p of await t3.listProjects()) console.log(`${p.title.padEnd(24)} ${color("dim", p.workspaceRoot)}`);
      await t3.close();
      break;
    }

    case "run": {
      const prompt = rest.join(" ");
      if (!prompt || !values.project) throw new Error('Usage: t3c run "<prompt>" --project <project>');
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
  console.error(`${color("red", "✗")} ${errorMessage(error)}`);
  process.exitCode = 1;
}

/** Connects t3c to T3 Code and picks the threads' model, if that isn't done yet. */
async function login() {
  say.step("Connect t3c to T3 Code");
  say.info("Approving t3c with a one-time pairing code from the `t3` CLI…");
  await t3Auth().login();
  say.ok("Connected to T3 Code.");
  if (!loadConfig().model) await chooseModel();
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
  await addSlack(); // ends by starting (or restarting) t3c
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

/** The service itself; `t3c start` runs this in the background. */
async function serve() {
  const config = loadConfig();
  if (!isLoggedIn(paths.auth)) throw new Error("Not connected to T3 Code. Run `t3c login` first.");
  const store = new Store(paths.state);

  const gateways: Gateway[] = [];
  if (config.http) gateways.push(httpGateway(config.http.secret));
  if (config.slack) {
    const slack = new SlackGateway(config.slack, { store });
    await slack.init();
    gateways.push(slack);
  }
  if (config.github) gateways.push(new GithubGateway({ ...config.github, token: githubToken() }));
  if (gateways.length === 0) throw new Error("No gateways configured. Run `t3c add slack` (or github/http) first.");

  if (config.runtimeMode === "full-access") {
    log("t3c", "runtimeMode is full-access: chat messages can run any command on this machine", "warn");
  }
  // T3 Code may start after t3c or restart while it runs; the client connects whenever it's back.
  const t3 = T3Client.lazy(t3Auth());
  await t3.listProjects().catch((e) => log("t3c", `T3 Code isn't reachable yet (${errorMessage(e)}); t3c connects once it is`, "warn"));
  const agentTools = new AgentToolServer();
  const simple = new SimpleBrain();
  const brain: Brain = config.agent
    ? new CodexBrain({
        toolServer: agentTools,
        toolsUrl: `http://127.0.0.1:${config.port}/agent/mcp`,
        skillsDir: paths.skills,
        workDir: paths.agentWork,
        model: config.agent.model,
        fallback: simple,
      })
    : simple;
  if (config.agent) {
    const replaced = overriddenSkills(paths.skills);
    if (replaced.length > 0) log("agent", `your ${replaced.join(", ")} in ${paths.skills} replace the built-in skills of that name`, "warn");
  }
  const worker = new Worker({ gateways, dispatcher: new Dispatcher(t3, store, config), store, t3, brain });
  worker.start();
  // Webhooks get lost sometimes, and none arrive while this machine sleeps.
  void worker.catchUp();
  setInterval(() => void worker.catchUp(), CATCH_UP_INTERVAL_MS);
  // Checks running threads for ones that are stuck.
  setInterval(() => void worker.supervise(), SUPERVISE_INTERVAL_MS);

  // Never bind publicly: the internet reaches t3c only through Tailscale Funnel, and only /hooks.
  const server = createApp({ gateways, worker, store, secret: config.http?.secret, agentTools });
  server.listen(config.port, "127.0.0.1", () => {
    log("t3c", `listening on 127.0.0.1:${config.port}; threads run as ${config.runtimeMode}; brain: ${brain.name}`, "ok");
    for (const line of describeGateways(config)) log("t3c", line);
  });
  server.on("error", (error) => {
    log("t3c", `can't listen on port ${config.port}: ${errorMessage(error)}`, "error");
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    log("t3c", `${signal}: stopping`);
    server.close();
    void t3.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  if (runningPid() !== process.pid) log("t3c", "running in the foreground; Ctrl-C to stop");
}


/** `t3c agent codex|off`: switches the brain. */
async function agent(provider: string | undefined) {
  const config = loadConfig();
  if (provider === "off") {
    delete config.agent;
    saveConfig(config);
    say.ok("Agent off: messages follow the fixed rules (the configured project, follow-ups to the latest thread).");
    await applyChanges();
  } else if (provider === "codex") {
    if (!codexReady()) throw new Error("Codex isn't installed or logged in. Install it and run `codex login`.");
    config.agent = { provider: "codex", ...(values.model ? { model: values.model } : {}) };
    saveConfig(config);
    say.ok(`Codex now decides what to do with messages${values.model ? ` (model ${values.model})` : ""}.`);
    say.info(`Skills: add <name>/SKILL.md folders to ${paths.skills}; one named like a built-in skill replaces it.`);
    say.hint("If Codex fails, t3c falls back to the fixed rules.");
    await applyChanges();
  } else {
    say.info(config.agent ? `Agent: ${config.agent.provider}${config.agent.model ? ` (${config.agent.model})` : ""}` : "Agent: off (fixed rules)");
    say.hint("t3c agent codex [--model <m>] | t3c agent off");
  }
}
