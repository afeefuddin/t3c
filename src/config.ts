import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeMode, ThreadModel } from "./t3.ts";

/** t3c's version, from package.json (one level up from both src/ and dist/). */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Everything t3c knows, in ~/.t3c/config.json (mode 0600: it holds tokens). Edited by `t3c add`/`remove`. */
export interface Config {
  /** Local port t3c listens on (127.0.0.1 only). */
  port: number;
  /** What T3 threads started by t3c may do without approval in T3 Code. */
  runtimeMode: RuntimeMode;
  /** Model for the threads t3c starts; the project's default in T3 when unset. */
  model?: ThreadModel;
  slack?: {
    signingSecret: string;
    botToken: string;
    /** T3 projects (titles or ids) the bot may work in, from any channel it's in or a DM; "*" means any. */
    projects: string[];
    /** Slack user ids allowed to use the bot. */
    allowedUsers: string[];
  };
  /** AI layer that decides what to do with messages. Without it, fixed rules apply. */
  agent?: {
    provider: "codex" | "claude";
    /** Codex model; Codex's default when unset. */
    model?: string;
  };
  http?: {
    /** Bearer secret for POST /hooks/http and GET /messages/:id. */
    secret: string;
    /** Publish the agent API (including result retrieval) through Funnel. */
    public?: boolean;
    /** Public origin used in API discovery and the Instinct handoff. */
    publicUrl?: string;
    /** Allowed project ids; legacy local HTTP configs allow any project when unset. */
    projects?: string[];
  };
}

export const DEFAULT_CONFIG: Config = { port: 4773, runtimeMode: "auto-accept-edits" };

/** State directory: ~/.t3c, or $T3C_HOME. */
export const home = process.env.T3C_HOME ?? join(homedir(), ".t3c");

export const paths = {
  config: join(home, "config.json"),
  auth: join(home, "auth.json"),
  state: join(home, "state.sqlite"),
  pid: join(home, "t3c.pid"),
  log: join(home, "t3c.log"),
  skills: join(home, "skills"),
  agentWork: join(home, "agent"),
  instinct: join(home, "instinct.md"),
};

export function loadConfig(): Config {
  if (!existsSync(paths.config)) return { ...DEFAULT_CONFIG };
  const config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(paths.config, "utf8")) };
  // Slack used to map each channel to its projects; now every channel shares them.
  if (config.slack?.channels) {
    const { channels, ...slack } = config.slack as Config["slack"] & { channels: Record<string, string | string[]> };
    const projects = [...new Set(Object.values(channels).flat())];
    config.slack = { ...slack, projects: projects.includes("*") || projects.length === 0 ? ["*"] : projects };
  }
  return config;
}

export function saveConfig(config: Config) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(paths.config, 0o600);
}

/** T3's MCP endpoint: $T3_MCP_URL, else where the T3 desktop app says its server listens. */
export function t3McpUrl() {
  if (process.env.T3_MCP_URL) return process.env.T3_MCP_URL;
  try {
    const runtime = JSON.parse(readFileSync(join(homedir(), ".t3/userdata/server-runtime.json"), "utf8"));
    return new URL("/mcp", runtime.origin).toString();
  } catch {
    return "http://127.0.0.1:3773/mcp";
  }
}

/** Gateways that need remote callers to reach this machine through Funnel. */
export function needsFunnel(config: Config) {
  return Boolean(config.slack || config.http?.public);
}
