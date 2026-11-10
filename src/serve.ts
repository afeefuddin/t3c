import { CodexBrain } from "./agent/codex.ts";
import { ClaudeBrain } from "./agent/claude.ts";
import { AgentToolServer } from "./agent/mcp.ts";
import { overriddenSkills } from "./agent/skills.ts";
import { isLoggedIn, t3Auth } from "./auth.ts";
import { type Brain, SimpleBrain } from "./brain.ts";
import { allowedProjects, loadConfig, paths } from "./config.ts";
import { describeGateways, runningPid, SHUTDOWN_GRACE_MS } from "./daemon.ts";
import { Dispatcher } from "./dispatch.ts";
import type { Gateway } from "./gateway.ts";
import { httpGateway } from "./gateways/http.ts";
import { SlackGateway } from "./gateways/slack.ts";
import { HttpApi } from "./http-api.ts";
import { errorMessage, log } from "./log.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";
import { T3Client } from "./t3.ts";
import { funnelBaseUrl } from "./tailscale.ts";
import { chatToken } from "./terminal.ts";
import { Worker } from "./worker.ts";

/** How often followed conversations are checked for messages that never arrived as webhooks. */
const CATCH_UP_INTERVAL_MS = 20_000;
/** How often running T3 threads are checked for being stuck. */
const SUPERVISE_INTERVAL_MS = 2 * 60_000;

/** The service itself; `t3c start` runs this in the background. */
export async function serve() {
  const config = loadConfig();
  if (!isLoggedIn(paths.auth)) throw new Error("Not connected to T3 Code. Run `t3c login` first.");
  const store = new Store(paths.state);

  const localChatToken = chatToken();
  const gateways: Gateway[] = [httpGateway(localChatToken, { source: "cli", projects: ["*"], requireIdempotencyKey: true })];
  const httpProjects = savedProjects("http");
  if (config.http) gateways.push(httpGateway(config.http.secret, { projects: httpProjects, requireIdempotencyKey: config.http.public }));
  if (config.slack) {
    const slack = new SlackGateway(config.slack, { store, projects: savedProjects("slack") });
    // Slack being unreachable or slow (offline, an outage) mustn't hold up or take down terminal chat
    // and Instinct: webhooks get a 503 until it connects, and catch-up recovers what was sent meanwhile.
    void slack.init().catch((e) => log("slack", `can't reach Slack yet (${errorMessage(e)}); retrying in the background`, "warn"));
    gateways.push(slack);
  }

  if (config.runtimeMode === "full-access") {
    log("t3c", "runtimeMode is full-access: chat messages can run any command on this machine", "warn");
  }
  // T3 Code may start after t3c or restart while it runs; the client connects whenever it's back.
  const t3 = T3Client.lazy(t3Auth());
  const projects = await t3.listProjects().catch((e) => {
    log("t3c", `T3 Code isn't reachable yet (${errorMessage(e)}); t3c connects once it is`, "warn");
    return [];
  });
  const agentTools = new AgentToolServer();
  const simple = new SimpleBrain();
  let brain: Brain = simple;
  if (config.agent) {
    const replaced = overriddenSkills(paths.skills);
    if (replaced.length > 0) log("agent", `your ${replaced.join(", ")} in ${paths.skills} replace the built-in skills of that name`, "warn");
    const options = {
      toolServer: agentTools,
      toolsUrl: `http://127.0.0.1:${config.port}/agent/mcp`,
      skillsDir: paths.skills,
      workDir: paths.agentWork,
      model: config.agent.model,
      fallback: simple,
    };
    brain = config.agent.provider === "claude" ? new ClaudeBrain(options) : new CodexBrain(options);
  }
  const worker = new Worker({ gateways, dispatcher: new Dispatcher(t3, store, config), store, t3, brain });
  worker.start();
  // Webhooks get lost sometimes, and none arrive while this machine sleeps.
  void worker.catchUp();
  const catchUp = setInterval(() => void worker.catchUp(), CATCH_UP_INTERVAL_MS);
  // Checks running threads for ones that are stuck.
  const supervise = setInterval(() => void worker.supervise(), SUPERVISE_INTERVAL_MS);

  // Never bind publicly: the internet reaches t3c only through Tailscale Funnel, and only /hooks.
  const httpApi = config.http?.public
    ? new HttpApi({
        secret: config.http.secret, projects: httpProjects, store, t3,
        // Configs from before setup saved it. Without Tailscale, discovery uses relative URLs.
        publicUrl: config.http.publicUrl ?? await funnelBaseUrl().catch((e) => {
          log("http", `no public URL for the Instinct API (${errorMessage(e)}); run \`t3c add instinct\` again once Tailscale works`, "warn");
          return undefined;
        }),
      })
    : undefined;
  const server = createApp({ gateways, worker, store, secret: config.http?.secret, agentTools, httpApi, chatSecret: localChatToken });
  server.listen(config.port, "127.0.0.1", () => {
    log("t3c", `listening on 127.0.0.1:${config.port}; threads run as ${config.runtimeMode}; brain: ${brain.name}`, "ok");
    for (const line of describeGateways(config, projects)) log("t3c", line);
  });
  server.on("error", (error) => {
    log("t3c", `can't listen on port ${config.port}: ${errorMessage(error)}`, "error");
    process.exit(1);
  });

  // Agent runs in progress get to finish (they still need the server for their tools); whatever
  // doesn't finish in time is stopped, and handled again after the restart. A second signal quits.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    log("t3c", `${signal}: stopping`);
    clearInterval(catchUp);
    clearInterval(supervise);
    await worker.stop(SHUTDOWN_GRACE_MS);
    server.close();
    await t3.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  if (runningPid() !== process.pid) log("t3c", "running in the foreground; Ctrl-C to stop");
}


/**
 * A connection's projects, read from the saved config for each message so `t3c projects` applies
 * at once. A config that can't be read allows nothing rather than everything.
 */
function savedProjects(kind: "slack" | "http"): () => string[] {
  return () => {
    try {
      return allowedProjects(loadConfig(), kind);
    } catch (error) {
      log("t3c", `can't read ${paths.config} (${errorMessage(error)}); ${kind} may use no projects until it's fixed`, "error");
      return [];
    }
  };
}
