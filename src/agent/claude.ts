import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";
import type { AgentEvent, Brain } from "../brain.ts";
import { errorMessage, log } from "../log.ts";
import type { Attachment } from "../t3.ts";
import type { AgentToolServer } from "./mcp.ts";
import { agentPrompt } from "./prompts.ts";
import { loadSkills } from "./skills.ts";
import type { ConversationTools } from "./tools.ts";

export interface ClaudeOptions {
  toolServer: AgentToolServer;
  toolsUrl: string;
  skillsDir: string;
  /** Empty directory, outside any project, for the CLI process. */
  workDir: string;
  fallback: Brain;
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
}

/** Require these controls; an older CLI must never silently run with weaker restrictions. */
const REQUIRED_FLAGS = [
  "--restricted", "--tools", "--strict-mcp-config", "--setting-sources", "--settings",
  "--permission-mode", "--permission-prompts", "--disable-slash-commands", "--no-chrome", "--no-session-persistence",
];

/**
 * Claude's print mode with no built-in tools, personal settings, hooks, skills or other MCP servers.
 * This is a tool restriction, not an OS sandbox. Coding still happens in T3 threads, through the
 * same conversation-scoped MCP tools as Codex; permission bypass is never enabled.
 */
export class ClaudeBrain implements Brain {
  readonly name = "claude";
  private readonly options: ClaudeOptions;
  private capabilities: Promise<void> | undefined;

  constructor(options: ClaudeOptions) {
    this.options = options;
  }

  async handle(event: AgentEvent, tools: ConversationTools): Promise<string> {
    const skills = loadSkills(this.options.skillsDir);
    const token = this.options.toolServer.open(tools, skills);
    try {
      this.capabilities ??= checkClaudeCli(this.options.claudeBin);
      await this.capabilities;
      const source = event.type === "message" ? await tools.source().catch((error) => void log("agent", `couldn't fetch the source: ${errorMessage(error)}`, "warn")) : undefined;
      const images = event.type === "message" ? await tools.images().catch((error) => (log("agent", `couldn't fetch images: ${errorMessage(error)}`, "warn"), [])) : [];
      const prompt = agentPrompt(event, await tools.getConversation(), skills, source, images.map((i) => i.name));
      return await this.exec(prompt, token, images);
    } catch (error) {
      if (tools.acted) throw error;
      log("agent", `claude failed before acting (${errorMessage(error)}); using the simple rules`, "warn");
      return `${await this.options.fallback.handle(event, tools)} (fallback)`;
    } finally {
      this.options.toolServer.close(token);
    }
  }

  private exec(prompt: string, token: string, images: Attachment[]): Promise<string> {
    const { workDir, toolsUrl, model, claudeBin = "claude", timeoutMs = 5 * 60_000 } = this.options;
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const args = [
      "--print", "--restricted", "--tools", "",
      "--setting-sources", "",
      "--settings", JSON.stringify({
        disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins: {},
        syncClaudeAiSkills: false, syncClaudeAiPlugins: false, disableRemoteControl: true,
        claudeMdExcludes: ["**"],
      }),
      "--strict-mcp-config",
      "--mcp-config", JSON.stringify({ mcpServers: { t3c: {
        type: "http", url: toolsUrl, headers: { Authorization: "Bearer ${T3C_AGENT_TOKEN}" },
      } } }),
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--allowedTools", "mcp__t3c__*",
      "--disable-slash-commands", "--no-chrome", "--no-session-persistence",
      "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      ...(model ? ["--model", model] : []),
    ];
    const content = [
      { type: "text", text: prompt },
      ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data.toString("base64") } })),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(claudeBin, args, {
        cwd: workDir,
        env: {
          ...process.env, T3C_AGENT_TOKEN: token, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", ENABLE_TOOL_SEARCH: "false",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "", buffer = "", result: { is_error?: boolean; result?: string; subtype?: string } | undefined;
      let initialized = false;
      let failure: Error | undefined;
      const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
      const timer = setTimeout(() => stop(new Error(`claude timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      const consume = (line: string) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { stop(new Error("Claude returned invalid JSON.")); return; }
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          stop(new Error("Claude returned an invalid stream event."));
          return;
        }
        if (event.type === "system" && event.subtype === "init") {
          if (!Array.isArray(event.tools) || event.tools.some((name: unknown) => typeof name !== "string" || !name.startsWith("mcp__t3c__"))) {
            stop(new Error("Claude exposed tools outside t3c; refusing the run."));
          } else if (!Array.isArray(event.mcp_servers) || !event.mcp_servers.some((server: { name?: string; status?: string } | null) => server?.name === "t3c" && server.status === "connected")) {
            stop(new Error("Claude did not connect to t3c's MCP server."));
          } else {
            initialized = true;
          }
        }
        if (event.type === "result") {
          if (event.result !== undefined && typeof event.result !== "string") stop(new Error("Claude returned an invalid result."));
          else result = event;
        }
      };
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          consume(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        if (buffer.length > 2_000_000) stop(new Error("Claude output exceeded the limit."));
      });
      child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4_000)));
      child.stdin.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error); });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`couldn't run ${claudeBin}: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        consume(buffer);
        if (failure) reject(failure);
        else if (code !== 0 || result?.is_error || result?.subtype !== "success") {
          reject(new Error(`claude failed: ${result?.result || stderr.trim().split("\n").at(-1) || `exit ${code}`}`));
        } else if (!initialized) reject(new Error("Claude did not confirm its restricted tool configuration."));
        else resolve(result.result?.trim().split("\n").at(-1) || "done");
      });
      child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
    });
  }
}

export async function checkClaudeCli(claudeBin = "claude"): Promise<void> {
  const { stdout } = await promisify(execFile)(claudeBin, ["--help"], { timeout: 10_000 });
  const missing = REQUIRED_FLAGS.filter((flag) => !stdout.includes(flag));
  if (missing.length) throw new Error(`Claude Code lacks required safety controls (${missing.join(", ")}). Update Claude Code first.`);
}
