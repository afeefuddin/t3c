import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FileOAuthProvider } from "./auth.ts";

export interface Project {
  id: string;
  title: string;
  workspaceRoot: string;
}

export interface ThreadSummary {
  threadId: string;
  title: string;
  status: string;
  createdAt: string;
}

export type WorkspaceStrategy =
  | { type: "root" }
  | { type: "worktree"; baseRef: string; branch?: string; startFromOrigin?: boolean };

export interface LaunchInput {
  projectId: string;
  title: string;
  message: string;
  workspaceStrategy: WorkspaceStrategy;
}

/** The slice of T3's orchestration tools the dispatcher needs. */
export interface T3 {
  listProjects(): Promise<Project[]>;
  listThreads(projectId: string, titleContains: string): Promise<ThreadSummary[]>;
  launchThread(input: LaunchInput): Promise<{ threadId: string }>;
  sendToThread(threadId: string, message: string): Promise<void>;
  readThread(threadId: string): Promise<unknown>;
}

export class T3Client implements T3 {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;

  private constructor(client: Client, transport: StreamableHTTPClientTransport) {
    this.client = client;
    this.transport = transport;
  }

  static async connect(serverUrl: string, authFile: string): Promise<T3Client> {
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      authProvider: new FileOAuthProvider(authFile),
    });
    const client = new Client({ name: "t3-connectors", version: "0.1.0" });
    await client.connect(transport);
    return new T3Client(client, transport);
  }

  async close() {
    await this.transport.close();
  }

  async listProjects() {
    const { projects } = await this.call<{ projects: Project[] }>("t3_project_list", { limit: 100 });
    return projects;
  }

  async listThreads(projectId: string, titleContains: string) {
    const { threads } = await this.call<{ threads: ThreadSummary[] }>("t3_thread_list", {
      projectId,
      titleContains,
      limit: 20,
    });
    return threads;
  }

  async launchThread(input: LaunchInput) {
    const result = await this.call<{ threadId?: string; thread?: { threadId?: string; id?: string } }>(
      "t3_thread_launch",
      { ...input },
    );
    const threadId = result.threadId ?? result.thread?.threadId ?? result.thread?.id;
    if (!threadId) throw new Error(`t3_thread_launch returned no threadId: ${JSON.stringify(result)}`);
    return { threadId };
  }

  async sendToThread(threadId: string, message: string) {
    await this.call("t3_thread_send", { threadId, message, mode: "auto" });
  }

  async readThread(threadId: string) {
    return this.call("t3_thread_read", { threadId, limit: 10, maxCharsPerItem: 4000 });
  }

  private async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });
    const text = Array.isArray(result.content)
      ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
      : "";
    if (result.isError) throw new Error(`${name} failed: ${text || "unknown error"}`);
    if (result.structuredContent) return result.structuredContent as T;
    return JSON.parse(text) as T;
  }
}
