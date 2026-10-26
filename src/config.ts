import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeMode } from "./t3.ts";

/** Everything t3c knows, in ~/.t3c/config.json (mode 0600: it holds tokens). Edited by `t3c add`/`remove`. */
export interface Config {
  /** Local port t3c listens on (127.0.0.1 only). */
  port: number;
  /** What T3 threads started by t3c may do without approval in T3 Code. */
  runtimeMode: RuntimeMode;
  slack?: {
    signingSecret: string;
    botToken: string;
    /** Slack channel id → the T3 project(s) it may use; "*" means any. */
    channels: Record<string, string | string[]>;
    /** Slack user ids allowed to use the bot. */
    allowedUsers: string[];
  };
  github?: {
    webhookSecret: string;
    /** owner/repo → T3 project. */
    repos: Record<string, string>;
    /** GitHub logins allowed to use /t3c. */
    allowedUsers: string[];
  };
  /** AI layer that decides what to do with messages. Without it, fixed rules apply. */
  agent?: {
    provider: "codex";
    /** Codex model; Codex's default when unset. */
    model?: string;
  };
  http?: {
    /** Bearer secret for POST /hooks/http and GET /messages/:id. */
    secret: string;
  };
}

export const DEFAULT_CONFIG: Config = { port: 8787, runtimeMode: "auto-accept-edits" };

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
};

export function loadConfig(): Config {
  if (!existsSync(paths.config)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(paths.config, "utf8")) };
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

/** Gateways that need Slack or GitHub to reach this machine through Funnel. */
export function needsFunnel(config: Config) {
  return Boolean(config.slack || config.github);
}
