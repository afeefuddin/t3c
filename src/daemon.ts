import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isLoggedIn, t3Auth } from "./auth.ts";
import { type Config, home, loadConfig, needsFunnel, paths, t3McpUrl } from "./config.ts";
import { githubApi } from "./gateways/github.ts";
import { slackApi } from "./gateways/slack.ts";
import { errorMessage } from "./log.ts";
import { githubToken } from "./setup.ts";
import { Store } from "./store.ts";
import { T3Client } from "./t3.ts";
import { disableFunnel, enableFunnel, funnelBaseUrl } from "./tailscale.ts";
import { say } from "./ui.ts";

/** The background service: `t3c start` runs `t3c serve` detached, logging to ~/.t3c/t3c.log. */

export function runningPid(): number | undefined {
  if (!existsSync(paths.pid)) return;
  const pid = Number(readFileSync(paths.pid, "utf8"));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    rmSync(paths.pid, { force: true });
  }
}

export async function start(entry: string) {
  const pid = runningPid();
  if (pid) {
    say.ok(`t3c is already running (pid ${pid}). Use \`t3c restart\` to apply changes.`);
    return;
  }
  const config = loadConfig();
  if (!isLoggedIn(paths.auth)) throw new Error("t3c isn't connected to T3 Code yet. Run `t3c login` first.");
  if (!config.slack && !config.github && !config.http) {
    throw new Error("Nothing to run yet. Add a gateway first: `t3c add slack`, `t3c add github <owner/repo>` or `t3c add http`.");
  }

  say.step("Starting t3c");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const logFd = openSync(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, entry, "serve"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  writeFileSync(paths.pid, String(child.pid));
  child.unref();

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (!(await waitForHealth(config.port, child.pid!, exited))) {
    rmSync(paths.pid, { force: true });
    say.warn("t3c stopped right after starting. Last log lines:");
    console.log(tail(15));
    process.exitCode = 1;
    return;
  }
  say.ok(`Running in the background (pid ${child.pid}), listening on 127.0.0.1:${config.port}.`);
  // Only once t3c itself answers on the port is it published, so Funnel never exposes something else.
  if (needsFunnel(config)) {
    const hooks = await enableFunnel(config.port);
    say.ok(`Tailscale Funnel: ${hooks} (only /hooks is public)`);
  }
  say.hint(`Logs: t3c logs -f   Stop: t3c stop`);
}

export async function stop({ keepFunnel = false } = {}) {
  const pid = runningPid();
  if (!pid) say.info("t3c isn't running.");
  else {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50 && runningPid(); i++) await sleep(100);
    if (runningPid()) process.kill(pid, "SIGKILL");
    rmSync(paths.pid, { force: true });
    say.ok(`Stopped t3c (pid ${pid}).`);
  }
  if (!keepFunnel && needsFunnel(loadConfig())) {
    await disableFunnel().catch(() => {});
    say.ok("Tailscale Funnel is off; nothing from t3c is reachable from the internet.");
  }
}

export async function status() {
  const config = loadConfig();
  const pid = runningPid();
  say.step("t3c");
  if (pid) say.ok(`running (pid ${pid}) on 127.0.0.1:${config.port}`);
  else say.warn("not running — `t3c start`");
  say.info(`threads run as ${config.runtimeMode} on ${config.model?.model ?? "each project's default model"}; brain: ${config.agent ? `${config.agent.provider} (skills in ${paths.skills})` : "fixed rules"}`);

  say.step("Connections");
  if (!isLoggedIn(paths.auth)) say.warn("T3 Code: not logged in — `t3c login`");
  else {
    await check(`T3 Code at ${t3McpUrl()}`, async () => {
      const t3 = await T3Client.connect(t3Auth());
      try {
        return `${(await t3.listProjects()).length} projects`;
      } finally {
        await t3.close();
      }
    });
  }
  if (config.slack) {
    const slack = config.slack;
    await check("Slack", async () => {
      const auth = await slackApi(slack.botToken)("auth.test");
      return `${auth.team} as @${auth.user}`;
    });
  }
  if (config.github) await check("GitHub", async () => `@${(await githubApi(githubToken())("GET", "/user")).login}`);
  if (needsFunnel(config)) {
    const base = await funnelBaseUrl().catch((e) => {
      say.warn(`Public URL: unavailable (${errorMessage(e)})`);
    });
    if (base && !pid) say.info(`Public URL: ${base}/hooks (published while t3c runs)`);
    if (base && pid) {
      // An unsigned request must reach t3c through Funnel and be refused by it.
      const hook = `${base}/hooks/${config.slack ? "slack" : "github"}`;
      await check(`Public URL ${base}/hooks`, async () => {
        const response = await fetch(hook, { method: "POST", signal: AbortSignal.timeout(10_000) });
        if (response.status !== 401) throw new Error(`expected t3c to refuse an unsigned request, got ${response.status}`);
        return "reachable from the internet";
      });
    }
  }

  say.step("Gateways");
  for (const line of describeGateways(config)) say.info(line);
  const store = new Store(paths.state);
  const last = store.recentMessages(50).findLast((m) => m.direction === "in");
  if (last) say.info(`last message received ${new Date(last.createdAt).toLocaleString()} — \`t3c messages\` for more`);
  say.hint(`config: ${paths.config}   logs: ${paths.log}`);
}

/** Runs one live check and prints ✓ with its detail, or ! with what went wrong. */
async function check(label: string, probe: () => Promise<string>) {
  try {
    say.ok(`${label}: ${await probe()}`);
  } catch (error) {
    say.warn(`${label}: ${errorMessage(error)}`);
  }
}

export function logs(follow: boolean) {
  if (!existsSync(paths.log)) return say.info("No logs yet.");
  if (!follow) return console.log(tail(50));
  spawn("tail", ["-n", "50", "-f", paths.log], { stdio: "inherit" });
}

export function describeGateways(config: Config): string[] {
  const lines: string[] = [];
  if (config.slack) {
    const channels = Object.entries(config.slack.channels).map(([c, p]) => `${c}→${[p].flat().join("|")}`);
    lines.push(`slack   ${channels.join(", ") || "no channels"}; ${config.slack.allowedUsers.length} allowed user(s)`);
  }
  if (config.github) {
    const repos = Object.entries(config.github.repos).map(([r, p]) => `${r}→${p}`);
    lines.push(`github  ${repos.join(", ")}; allowed: ${config.github.allowedUsers.join(", ")}`);
  }
  if (config.http) lines.push("http    POST /hooks/http (bearer secret)");
  return lines.length > 0 ? lines : ["none yet — `t3c add slack`, `t3c add github <owner/repo>`, `t3c add http`"];
}

/** True once the process we started (not something else on the port) answers its health check. */
async function waitForHealth(port: number, pid: number, exited: Promise<void>) {
  let dead = false;
  void exited.then(() => (dead = true));
  for (let i = 0; i < 100 && !dead; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok && ((await response.json()) as { pid?: number }).pid === pid) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

function tail(lines: number) {
  return readFileSync(paths.log, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
