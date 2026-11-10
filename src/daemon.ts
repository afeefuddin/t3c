import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isLoggedIn, t3Auth } from "./auth.ts";
import { allowedProjects, type Config, home, loadConfig, needsFunnel, paths, t3McpUrl } from "./config.ts";
import { PROBE_USER_AGENT } from "./gateway.ts";
import { slackApi } from "./gateways/slack.ts";
import { errorMessage } from "./log.ts";
import { describeAllowed, normalize } from "./projects.ts";
import { Store } from "./store.ts";
import type { Project } from "./t3.ts";
import { disableFunnel, enableFunnel, funnelBaseUrl } from "./tailscale.ts";
import { say } from "./ui.ts";

/** The background service: `t3c start` runs `t3c serve` detached, logging to ~/.t3c/t3c.log. */

/** How long a stopping service lets agent runs in progress finish before it stops them. */
export const SHUTDOWN_GRACE_MS = 15_000;
/** How long `t3c stop` waits for the service to exit before killing it. */
const STOP_TIMEOUT_MS = SHUTDOWN_GRACE_MS + 10_000;

/**
 * The service's pid, if it's running. The pid file also records when that process started, so a
 * pid reused by another process (after a reboot, say) is never mistaken for t3c, or signalled.
 */
export function runningPid(): number | undefined {
  if (!existsSync(paths.pid)) return;
  const [recordedPid, recordedStart] = readFileSync(paths.pid, "utf8").split("\n");
  const pid = Number(recordedPid);
  const started = Number.isInteger(pid) && pid > 0 ? processInfo(pid, "lstart") : undefined;
  // Pid files from before the start time was recorded: any `t3c serve` process counts.
  const same = recordedStart ? started === recordedStart : started !== undefined && / serve$/.test(processInfo(pid, "command") ?? "");
  if (same) return pid;
  rmSync(paths.pid, { force: true });
}

/** A `ps` field of a running process (`lstart`: when it started; `command`: its command line). */
function processInfo(pid: number, field: "lstart" | "command"): string | undefined {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim() || undefined;
  } catch {
    return undefined; // no such process
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

  say.step("Starting t3c");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const logFd = openSync(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, entry, "serve"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  writeFileSync(paths.pid, `${child.pid}\n${processInfo(child.pid!, "lstart") ?? ""}`);
  child.unref();

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (!(await waitForHealth(config.port, child.pid!, exited))) {
    // Still starting but not answering: stop it, or it lives on where `status` and `stop` can't see it.
    if (runningPid()) await stop({ keepFunnel: true });
    rmSync(paths.pid, { force: true });
    say.warn("t3c didn't start. Last log lines:");
    console.log(tail(15));
    process.exitCode = 1;
    return;
  }
  say.ok(`Running in the background (pid ${child.pid}), listening on 127.0.0.1:${config.port}.`);
  // Only once t3c itself answers on the port is it published, so Funnel never exposes something else.
  if (needsFunnel(config)) {
    try {
      say.ok(`Tailscale Funnel: ${await enableFunnel(config.port)} (only /hooks is public)`);
    } catch (error) {
      // t3c still runs: terminal chat works, and Slack messages sent meanwhile are caught up on later.
      say.warn(`t3c is running, but Slack and Instinct can't reach it: Tailscale Funnel didn't turn on (${errorMessage(error)}).`);
      say.hint("Once Tailscale is connected, run `t3c restart`. Slack messages sent meanwhile are picked up then.");
      process.exitCode = 1;
    }
  }
  say.hint(`Logs: t3c logs -f   Stop: t3c stop`);
}

export async function stop({ keepFunnel = false } = {}) {
  const pid = runningPid();
  if (!pid) say.info("t3c isn't running.");
  else {
    process.kill(pid, "SIGTERM");
    // It lets agent runs in progress finish first (see SHUTDOWN_GRACE_MS).
    const signalled = Date.now();
    let told = false;
    while (runningPid() && Date.now() - signalled < STOP_TIMEOUT_MS) {
      if (!told && Date.now() - signalled > 1_000) {
        say.info("Letting work in progress finish…");
        told = true;
      }
      await sleep(100);
    }
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
  let projects: Project[] = [];
  if (!isLoggedIn(paths.auth)) say.warn("T3 Code: not logged in — `t3c login`");
  else {
    await check(`T3 Code at ${t3McpUrl()}`, async () => {
      const { T3Client } = await import("./t3.ts");
      const t3 = await T3Client.connect(t3Auth());
      try {
        projects = await t3.listProjects();
        return `${projects.length} projects`;
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
  if (needsFunnel(config)) {
    const base = await funnelBaseUrl().catch((e) => {
      say.warn(`Public URL: unavailable (${errorMessage(e)})`);
    });
    if (base && !pid) say.info(`Public URL: ${base}/hooks (published while t3c runs)`);
    if (base && pid) {
      // An unsigned request must reach t3c through Funnel and be refused by it.
      let gateway = "http";
      if (config.slack) gateway = "slack";
      const hook = `${base}/hooks/${gateway}`;
      await check(`Public URL ${base}/hooks`, async () => {
        const response = await fetch(hook, { method: "POST", headers: { "user-agent": PROBE_USER_AGENT }, signal: AbortSignal.timeout(10_000) });
        if (response.status !== 401) throw new Error(`expected t3c to refuse an unsigned request, got ${response.status}`);
        return "reachable from the internet";
      });
    }
  }

  say.step("Gateways");
  for (const line of describeGateways(config, projects)) say.info(line);
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

/** One line per gateway; with T3's projects, their names instead of ids. */
export function describeGateways(config: Config, projects: Project[] = []): string[] {
  const lines: string[] = [];
  const allowed = (kind: "slack" | "http") => describeAllowed(normalize(allowedProjects(config, kind), projects), projects);
  if (config.slack) {
    lines.push(`slack   any channel or DM; projects: ${allowed("slack")}; ${config.slack.allowedUsers.length} allowed user(s)`);
  }
  if (config.http) lines.push(config.http.public
    ? `http    public agent API (Instinct); projects: ${allowed("http")}`
    : `http    POST /hooks/http (bearer secret); projects: ${allowed("http")}`);
  return lines.length > 0 ? lines : ["none yet — `t3c add slack`, `t3c add http`, `t3c add instinct`"];
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
