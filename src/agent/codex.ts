import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent, Brain } from "../brain.ts";
import { errorMessage, log } from "../log.ts";
import type { Attachment } from "../t3.ts";
import type { ConversationTools } from "./tools.ts";
import type { AgentToolServer } from "./mcp.ts";
import { prepareAgentPrompt } from "./prompts.ts";
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
  /** Lockdown flags for the Codex config as of `stamp`; finding the servers takes Codex seconds. */
  private lockdown: { stamp: string; args: Promise<string[]> } | undefined;

  constructor(options: CodexOptions) {
    this.options = options;
  }

  async handle(event: AgentEvent, tools: ConversationTools, signal?: AbortSignal): Promise<string> {
    const skills = loadSkills(this.options.skillsDir);
    const token = this.options.toolServer.open(tools, skills);
    try {
      const { prompt, images } = await prepareAgentPrompt(event, tools, skills);
      return await this.exec(prompt, token, await this.lockdownArgs(signal), images, signal);
    } catch (error) {
      if (tools.acted || signal?.aborted) throw error;
      log("agent", `codex failed before acting (${errorMessage(error)}); using the simple rules`, "warn");
      return `${await this.options.fallback.handle(event, tools)} (fallback)`;
    } finally {
      this.options.toolServer.close(token);
    }
  }

  /** Shared by concurrent runs; `signal` (the service's, aborted when it stops) ends the probes. */
  private lockdownArgs(signal?: AbortSignal): Promise<string[]> {
    const stamp = codexConfigStamp();
    if (this.lockdown?.stamp !== stamp) {
      const args = lockdownArgs(this.options.codexBin ?? "codex", signal).catch((error) => {
        if (this.lockdown?.args === args) this.lockdown = undefined; // tried again next run
        throw new Error(`Codex can't be locked down for t3c: ${errorMessage(error)}`);
      });
      this.lockdown = { stamp, args };
    }
    return this.lockdown.args;
  }

  private exec(prompt: string, token: string, lockdown: string[], images: Attachment[], signal?: AbortSignal): Promise<string> {
    const { workDir, toolsUrl, model, codexBin = "codex", timeoutMs = 5 * 60_000 } = this.options;
    mkdirSync(workDir, { recursive: true });
    const outFile = join(workDir, `last-${token.slice(0, 8)}.txt`);
    const imageFiles = images.map((image, i) => {
      const file = join(workDir, `image-${token.slice(0, 8)}-${i}${extension(image.mimeType)}`);
      writeFileSync(file, image.data, { mode: 0o600 });
      return file;
    });
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
      ...(imageFiles.length > 0 ? ["--image", ...imageFiles] : []),
      // --image takes several files: the prompt goes after "--" so it isn't read as one.
      "--",
      prompt,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(codexBin, args, {
        env: { ...process.env, T3C_AGENT_TOKEN: token },
        stdio: ["ignore", "ignore", "pipe"],
        signal,
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
        for (const file of [outFile, ...imageFiles]) rmSync(file, { force: true });
        if (code === 0) resolve(last.split("\n").at(-1) || "done");
        else reject(new Error(signal ? `codex timed out after ${timeoutMs / 1000}s` : `codex exited ${code}: ${lastLine(stderr)}`));
      });
    });
  }
}

/**
 * Flags that switch off Codex's built-in tools and every MCP server it would start (the user's
 * own, and plugins') for t3c's runs, while keeping the rest of their config (model provider,
 * model, login). Throws when that can't be guaranteed, so no run starts without it.
 */
export async function lockdownArgs(codexBin: string, signal?: AbortSignal): Promise<string[]> {
  const codex = async (...args: string[]) => (await promisify(execFile)(codexBin, args, { timeout: 60_000, signal })).stdout;
  const args = ["-c", "notify=[]"];
  try {
    const known = new Set((await codex("features", "list")).split("\n").map((line) => line.split(/\s+/)[0]));
    for (const feature of FEATURES_OFF) if (known.has(feature)) args.push("--disable", feature);
  } catch {
    // Older Codex without `features list`: the sandbox and MCP lockdown still apply.
  }
  // Codex says which servers it would start, however they're configured (tables, inline tables,
  // plugins), rather than t3c guessing from config.toml.
  const servers = async () => {
    try {
      return JSON.parse(await codex("mcp", "list", "--json", ...args)) as { name: string; enabled: boolean }[];
    } catch (error) {
      throw new Error(`\`codex mcp list --json\` failed (update Codex if it's old): ${lastLine((error as { stderr?: string }).stderr ?? "") || errorMessage(error)}`);
    }
  };
  for (const { name, enabled } of await servers()) {
    if (!enabled || name === "t3c") continue;
    // Codex keeps a quoted key's quotes as part of the name, so only bare keys can turn a server off.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`can't turn off the Codex MCP server "${name}" for t3c's runs; give it a name of letters, digits, - and _`);
    args.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  // Checked, not assumed: a run never starts with any server but t3c's.
  const left = (await servers()).filter((s) => s.enabled && s.name !== "t3c").map((s) => s.name);
  if (left.length > 0) throw new Error(`the Codex MCP servers ${left.join(", ")} stay on despite t3c's lockdown`);
  return args;
}

/** When Codex's config last changed: the lockdown is worked out again after it does. */
function codexConfigStamp() {
  try {
    return String(statSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml")).mtimeMs);
  } catch {
    return "none";
  }
}

function extension(mimeType: string) {
  return { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[mimeType] ?? "";
}

function lastLine(text: string) {
  return text.trim().split("\n").at(-1) ?? "";
}
