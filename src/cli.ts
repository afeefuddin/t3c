#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { isLoggedIn, login } from "./auth.ts";
import { loadConfig, paths, t3McpUrl } from "./config.ts";
import { describeGateways, logs, runningPid, start, status, stop } from "./daemon.ts";
import { Dispatcher } from "./dispatch.ts";
import type { Gateway } from "./gateway.ts";
import { GithubGateway } from "./gateways/github.ts";
import { httpGateway } from "./gateways/http.ts";
import { SlackGateway } from "./gateways/slack.ts";
import { color, errorMessage, log } from "./log.ts";
import { createApp } from "./server.ts";
import { addGithub, addHttp, addSlack, githubToken, remove } from "./setup.ts";
import { Store } from "./store.ts";
import { T3Client } from "./t3.ts";
import { say } from "./ui.ts";
import { Worker } from "./worker.ts";

const USAGE = `${color("bold", "t3c")} — start T3 Code threads from Slack, GitHub and webhooks

${color("bold", "Set up")} (once, in this order)
  t3c login                      connect t3c to T3 Code
  t3c add slack                  connect Slack, or add another channel
  t3c add github <owner/repo>    let /t3c comments in a repo start work
  t3c add http                   an authenticated webhook for scripts
  t3c remove slack [channel-id] | github <owner/repo> | http

${color("bold", "Run")}
  t3c start | stop | restart     the background service
  t3c status                     what's running and connected
  t3c logs [-f]                  what it's doing

${color("bold", "Other")}
  t3c projects                   list T3 projects
  t3c run "<prompt>" --project <p>   start a T3 thread right now
  t3c serve                      run in the foreground

Config lives in ${paths.config}.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    title: { type: "string" },
    follow: { type: "boolean", short: "f" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, ...rest] = positionals;
/** This script's own path, so `start` can relaunch it as `t3c serve`. */
const entry = process.argv[1];

try {
  switch (values.help ? undefined : command) {
    case "login":
      say.step("Connect t3c to T3 Code");
      await login(t3McpUrl(), paths.auth, (url) => {
        say.info("Approve t3c in the browser window that opens. If none opens, visit:");
        say.info(url.toString());
        if (process.platform === "darwin") execFile("open", [url.toString()]);
      });
      say.ok("Connected. Next: `t3c add slack` or `t3c add github <owner/repo>`.");
      break;

    case "add":
      if (rest[0] === "slack") await addSlack();
      else if (rest[0] === "github") await addGithub(rest[1] ?? "");
      else if (rest[0] === "http") addHttp();
      else throw new Error("Usage: t3c add slack | github <owner/repo> | http");
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

    case "logs":
      logs(Boolean(values.follow));
      break;

    case "serve":
      await serve();
      break;

    case "projects": {
      const t3 = await T3Client.connect(t3McpUrl(), paths.auth);
      for (const p of await t3.listProjects()) console.log(`${p.title.padEnd(24)} ${color("dim", p.workspaceRoot)}`);
      await t3.close();
      break;
    }

    case "run": {
      const prompt = rest.join(" ");
      if (!prompt || !values.project) throw new Error('Usage: t3c run "<prompt>" --project <project>');
      const t3 = await T3Client.connect(t3McpUrl(), paths.auth);
      const result = await new Dispatcher(t3, new Store(paths.state), loadConfig().runtimeMode).dispatch({
        source: "cli",
        externalId: randomUUID(),
        project: values.project,
        title: values.title ?? prompt.slice(0, 60),
        prompt,
      });
      say.ok(`Started T3 thread ${result.task.threadId}.`);
      await t3.close();
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
  const t3 = await T3Client.connect(t3McpUrl(), paths.auth);
  const worker = new Worker({ gateways, dispatcher: new Dispatcher(t3, store, config.runtimeMode), store, t3 });
  worker.start();

  // Never bind publicly: the internet reaches t3c only through Tailscale Funnel, and only /hooks.
  const server = createApp({ gateways, worker, store, t3, secret: config.http?.secret });
  server.listen(config.port, "127.0.0.1", () => {
    log("t3c", `listening on 127.0.0.1:${config.port}; threads run as ${config.runtimeMode}`, "ok");
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

