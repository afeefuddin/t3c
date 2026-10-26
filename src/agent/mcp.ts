import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { header, safeEqual } from "../gateway.ts";
import type { ConversationTools } from "../tools.ts";

/**
 * The agent's tools, served over MCP at 127.0.0.1/agent/mcp for the duration of one run.
 * Each run gets a random bearer token that maps to that run's conversation-scoped tools, so a run
 * can never act on another conversation, and nothing works once the run ends.
 */
export class AgentToolServer {
  private readonly runs = new Map<string, ConversationTools>();

  /** Registers a run's tools; returns its token. */
  open(tools: ConversationTools): string {
    const token = randomBytes(32).toString("base64url");
    this.runs.set(token, tools);
    return token;
  }

  close(token: string) {
    this.runs.delete(token);
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    const presented = header(req.headers, "authorization").replace(/^Bearer /, "");
    const tools = [...this.runs].find(([token]) => safeEqual(token, presented))?.[1];
    if (!tools) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unknown or finished run." }));
      return;
    }
    const server = buildServer(tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}

function buildServer(tools: ConversationTools) {
  const server = new McpServer({ name: "t3c", version: "0.1.0" });
  // Tool errors go back to the agent as isError results, so it can correct itself.
  const add = (name: string, description: string, shape: z.ZodRawShape, run: (input: any) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape }, async (input: unknown) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await run(input), null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
      }
    });

  add("get_conversation", "This conversation: state, your summary notes, attached T3 threads and recent messages.", {}, () =>
    tools.getConversation(),
  );
  add("fetch_source", "The full source conversation as it is now (Slack thread, or GitHub issue and comments).", {}, () =>
    tools.fetchSource(),
  );
  add("list_projects", "The T3 projects this conversation may work in.", {}, () => tools.listProjects());
  add("read_thread", "Status and latest answer of an attached T3 thread.", { label: z.string() }, (i) => tools.readThread(i));
  add(
    "start_thread",
    "Start a T3 coding thread for this conversation. The person's request is included verbatim; add a brief with the context.",
    {
      project: z.string().describe("Project name from list_projects"),
      title: z.string().max(80).describe("Short title for the thread"),
      brief: z.string().max(20_000).optional().describe("Context for the coding agent, written from the conversation"),
      label: z.string().max(40).optional().describe('Name for this thread within the conversation; defaults to "main"'),
    },
    (i) => tools.startThread(i),
  );
  add(
    "send_to_thread",
    "Send a follow-up message to an attached T3 thread.",
    { label: z.string(), text: z.string().max(20_000) },
    (i) => tools.sendToThread(i),
  );
  add("reply", "Post a message into this conversation (Markdown).", { text: z.string().max(20_000) }, (i) => tools.reply(i));
  add("ask_user", "Ask the people in this conversation a question; their answer arrives as a new message.", { question: z.string().max(2_000) }, (i) =>
    tools.askUser(i),
  );
  add("update_summary", "Replace your running notes about this conversation.", { summary: z.string().max(4_000) }, (i) =>
    tools.updateSummary(i),
  );
  return server;
}
