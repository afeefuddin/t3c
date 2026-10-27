import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent, Brain } from "../brain.ts";
import { errorMessage, log } from "../log.ts";
import type { ConversationTools } from "./tools.ts";
import type { AgentToolServer } from "./mcp.ts";
import { agentPrompt } from "./prompts.ts";
import { loadSkills } from "./skills.ts";

export interface CodexOptions {
  toolServer: AgentToolServer;
  /** Where Codex reaches the tool server, e.g. http://127.0.0.1:4773/agent/mcp. */
  toolsUrl: string;
  skillsDir: string;
  /** Empty working directory for runs; Codex can't change anything there anyway (read-only). */
  workDir: string;
  /** Used when Codex fails before doing anything, so messages are never dropped. */
  fallback: Brain;
  model?: string;
  codexBin?: string;
  timeoutMs?: number;
}

/**
 * Codex features that let a run act outside t3c's tools, or remember/notify across runs.
 * Disabled for every run (only those this Codex version has: unknown names are an error).
 */
const FEATURES_OFF = [
  "shell_tool",
  "apps",
  "browser_use",
  "computer_use",
  "plugins",
  "hooks",
  "memories",
  "goals",
  "multi_agent",
  "multi_agent_v2",
  "skill_search",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "image_generation",
];

/**
 * The AI brain: each event runs `codex exec` once with t3c's conversation tools attached over MCP.
 * The user's Codex config is kept (their provider, model and login), but every run is locked down:
 * read-only sandbox, no approvals, no shell or other built-in tools, none of the user's MCP servers,
 * no hooks or notifications. Its only way to affect anything is through t3c's tools, which t3c checks.
 */
export class CodexBrain implements Brain {
  readonly name = "codex";
  private readonly options: CodexOptions;
  private lockdown: Promise<string[]> | undefined;

  constructor(options: CodexOptions) {
    this.options = options;
  }

  async handle(event: AgentEvent, tools: ConversationTools): Promise<string> {
    const skills = loadSkills(this.options.skillsDir);
    const token = this.options.toolServer.open(tools, skills);
    try {
      const prompt = agentPrompt(event, await tools.getConversation(), skills);
      this.lockdown ??= lockdownArgs(this.options.codexBin ?? "codex");
      return await this.exec(prompt, token, await this.lockdown);
    } catch (error) {
      if (tools.acted) throw error;
      log("agent", `codex failed before acting (${errorMessage(error)}); using the simple rules`, "warn");
      return `${await this.options.fallback.handle(event, tools)} (fallback)`;
    } finally {
      this.options.toolServer.close(token);
    }
  }

  private exec(prompt: string, token: string, lockdown: string[]): Promise<string> {
    const { workDir, toolsUrl, model, codexBin = "codex", timeoutMs = 5 * 60_000 } = this.options;
    mkdirSync(workDir, { recursive: true });
    const outFile = join(workDir, `last-${token.slice(0, 8)}.txt`);
    const args = [
      "exec",
      ...lockdown,
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      workDir,
      "-c",
      'approval_policy="never"',
      "-c",
      `mcp_servers.t3c.url=${JSON.stringify(toolsUrl)}`,
      "-c",
      'mcp_servers.t3c.bearer_token_env_var="T3C_AGENT_TOKEN"',
      // Approvals are off, so tools must be pre-approved; only t3c's own, which enforce their own checks.
      "-c",
      'mcp_servers.t3c.default_tools_approval_mode="approve"',
      ...(model ? ["-m", model] : []),
      "-o",
      outFile,
      prompt,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(codexBin, args, {
        env: { ...process.env, T3C_AGENT_TOKEN: token },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4_000)));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`couldn't run ${codexBin}: ${error.message}`));
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        let last = "";
        try {
          last = readFileSync(outFile, "utf8").trim();
        } catch {}
        rmSync(outFile, { force: true });
        if (code === 0) resolve(last.split("\n").at(-1) || "done");
        else reject(new Error(signal ? `codex timed out after ${timeoutMs / 1000}s` : `codex exited ${code}: ${lastLine(stderr)}`));
      });
    });
  }
}

/**
 * Flags that switch off the user's MCP servers and Codex's built-in tools for t3c's runs, while
 * keeping the rest of their config (model provider, model, login).
 */
export async function lockdownArgs(codexBin: string, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  const args = ["-c", "notify=[]"];
  const configFile = join(codexHome, "config.toml");
  if (existsSync(configFile)) {
    const names = new Set([...readFileSync(configFile, "utf8").matchAll(/^\[mcp_servers\.("[^"]+"|[^\].]+)\]/gm)].map((m) => m[1]));
    names.delete("t3c");
    for (const name of names) args.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  try {
    const { stdout } = await promisify(execFile)(codexBin, ["features", "list"]);
    const known = new Set(stdout.split("\n").map((line) => line.split(/\s+/)[0]));
    for (const feature of FEATURES_OFF) if (known.has(feature)) args.push("--disable", feature);
  } catch {
    // Older Codex without `features list`: the sandbox and MCP lockdown still apply.
  }
  return args;
}

function lastLine(text: string) {
  return text.trim().split("\n").at(-1) ?? "";
}
