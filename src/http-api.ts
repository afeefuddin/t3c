import type { IncomingHttpHeaders } from "node:http";
import { VERSION } from "./config.ts";
import { GatewayError, header, safeEqual, type InboundMessage } from "./gateway.ts";
import { httpProjectAllowed } from "./gateways/http.ts";
import type { Store, StoredMessage } from "./store.ts";
import type { T3 } from "./t3.ts";

/** Remote clients get HTTP conversations and T3 answers, never internal agent runs or other gateways. */
export class HttpApi {
  private readonly deps: { secret: string; projects: string[]; store: Store; t3: T3; publicUrl?: string };

  constructor(deps: { secret: string; projects: string[]; store: Store; t3: T3; publicUrl?: string }) {
    this.deps = deps;
  }

  get publicUrl(): string | undefined {
    return this.deps.publicUrl;
  }

  authorize(headers: IncomingHttpHeaders) {
    if (!safeEqual(header(headers, "authorization"), `Bearer ${this.deps.secret}`)) {
      throw new GatewayError(401, "Invalid or missing bearer secret.");
    }
  }

  async projects() {
    return (await this.deps.t3.listProjects())
      .filter((p) => httpProjectAllowed(p.id, this.deps.projects))
      .map(({ id, title }) => ({ id, title }));
  }

  /** Validate before enqueueing: retries must be identical and the conversation must remain accessible. */
  existingDelivery(message: InboundMessage): StoredMessage | undefined {
    const { store, projects } = this.deps;
    if (!message.projects.every((p) => httpProjectAllowed(p, projects))) throw new GatewayError(403, "Project is not allowed.");
    const conversation = store.findConversation("http", message.conversationId);
    if (conversation && !store.conversationProjects(conversation.id).every((p) => httpProjectAllowed(p, projects))) {
      throw new GatewayError(403, "Conversation is not allowed.");
    }
    const previous = store.findDelivery("http", message.eventKey);
    if (!previous) return;
    const inbound = previous.inbound;
    if (
      !inbound ||
      inbound.conversationId !== message.conversationId ||
      inbound.text !== message.text ||
      inbound.title !== message.title ||
      JSON.stringify(inbound.projects) !== JSON.stringify(message.projects) ||
      inbound.meta?.worktree !== message.meta?.worktree
    ) {
      throw new GatewayError(409, "Idempotency key was already used for a different request.");
    }
    return previous;
  }

  async result(messageId: string) {
    const { store, projects, t3 } = this.deps;
    const message = store.getMessage(messageId);
    const conversation = message && store.getConversation(message.conversationId);
    if (
      !message?.inbound || message.direction !== "in" || conversation?.source !== "http" ||
      !store.conversationProjects(conversation.id).every((p) => httpProjectAllowed(p, projects))
    ) {
      throw new GatewayError(404, "Not found.");
    }
    const threads = await Promise.all(store.threads(conversation.id).map(async (thread) => {
      const reply = thread.t3ThreadId ? await t3.latestReply(thread.t3ThreadId, thread.awaitingSince ?? undefined) : undefined;
      return {
        threadId: thread.t3ThreadId,
        status: reply?.status ?? thread.status,
        answer: reply?.text ?? null,
      };
    }));
    return {
      messageId: message.id,
      conversationId: conversation.externalId,
      deliveryStatus: message.status,
      ...(message.status === "failed" && { error: "Could not deliver the task. Check t3c logs on the host." }),
      threads,
      replies: store.messages(conversation.id, 100).filter((m) => m.direction === "out").map((m) => ({ id: m.id, text: m.text, at: m.createdAt })),
      pending: store.conversationBusy(conversation.id),
    };
  }
}

/** Public discovery document. Credentials and project names are supplied separately, never embedded here. */
export function httpOpenApi(baseUrl = "/") {
  const string = { type: "string", minLength: 1, maxLength: 100_000 };
  const response = (description: string, schema: unknown) => ({ description, content: { "application/json": { schema } } });
  const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 500].map((code) => [code, response("Request failed; inspect the error message.", {
    type: "object", required: ["error"], properties: { error: { type: "string" } },
  })]));
  return {
    openapi: "3.0.3",
    info: { title: "t3c agent API", version: VERSION, description: "Chat with the shared T3C agent: ask about previous work, give follow-ups, or start coding tasks." },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths: {
      "/hooks/http/projects": {
        get: {
          operationId: "listProjects", summary: "List the projects this connection may use",
          responses: { "200": response("Allowed projects (no local paths).", {
            type: "array", items: { type: "object", required: ["id", "title"], properties: { id: string, title: string } },
          }), ...errors },
        },
      },
      "/hooks/http": {
        post: {
          operationId: "sendTask", summary: "Start a task or send a follow-up",
          description: "Keep conversationId for chat continuity. Project and title are optional; omit project to let the shared agent choose among allowed projects. A conversation may cover several tasks. Use a new idempotencyKey per message and retain the exact body for network retries. A 202 means accepted, not finished.",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["conversationId", "prompt", "idempotencyKey"],
            properties: {
              conversationId: { ...string, description: "Stable id for this chat. The agent can find and continue work from other conversations." },
              project: { ...string, description: "Optional project hint/restriction: an exact id from listProjects." },
              title: { ...string, description: "Short task title." },
              prompt: { ...string, description: "Your message to the shared agent: a question, task or follow-up." },
              idempotencyKey: { ...string, description: "Unique per message; retain it when retrying." },
              worktree: { type: "object", required: ["baseRef"], properties: { baseRef: string, branch: string }, description: "Only for a new conversation when the user requested a separate worktree." },
            },
          } } } },
          responses: { "202": response("Saved. Retain messageId to read the task result, including after a retry.", {
            type: "object", required: ["accepted", "messageId"], properties: {
              accepted: { type: "boolean" }, messageId: string, duplicate: { type: "boolean" },
            },
          }), ...errors },
        },
      },
      "/hooks/http/messages/{messageId}": {
        get: {
          operationId: "getTaskResult", summary: "Read delivery state and the latest T3 answer",
          description: "Read the agent's replies, deduplicating by reply id. pending indicates that chat or coding work is still in progress. deliveryStatus=done means the agent handled the message, not necessarily that coding finished. Thread states and answers show their latest run, not a historical snapshot. Do not submit a new message just to check status.",
          parameters: [{ name: "messageId", in: "path", required: true, schema: string }],
          responses: { "200": response("Latest task state and answers, without internal logs.", {
            type: "object", required: ["messageId", "conversationId", "deliveryStatus", "threads"], properties: {
              messageId: string, conversationId: string,
              deliveryStatus: { type: "string", enum: ["pending", "processing", "done", "failed"] }, error: { type: "string" },
              pending: { type: "boolean" },
              replies: { type: "array", items: { type: "object", properties: { id: string, text: string, at: string } } },
              threads: { type: "array", items: { type: "object", required: ["threadId", "status", "answer"], properties: {
                threadId: { type: "string", nullable: true }, status: { type: "string" }, answer: { type: "string", nullable: true },
              } } },
            },
          }), ...errors },
        },
      },
    },
  };
}

/** Complete private handoff: deliberately contains the connection credential, never served publicly. */
export function instinctInstructions(baseUrl: string, secret: string): string {
  return `Connect to my shared T3C agent. It orchestrates T3 Code and remembers conversations across Slack, terminal and this connection. Pass my requests to this same agent, including questions about past work; it decides which coding threads to use.

Connection name: t3c
API origin: ${baseUrl}
Discovery: ${baseUrl}/hooks/http
OpenAPI: ${baseUrl}/hooks/http/openapi.json
Authentication: HTTP Bearer
Authorization: Bearer ${secret}

Keep the token private. Send it only as the Authorization header to ${baseUrl}. Do not include it in coding prompts, URLs, logs, GitHub, or replies to me. If you have a credential store, save it there.

Set up these three actions using the OpenAPI document, or make the HTTP requests directly:

1. listProjects: GET ${baseUrl}/hooks/http/projects
Returns the projects I allowed you to use: [{"id":"...","title":"..."}]. Use the returned exact ids; do not guess them.

2. sendTask: POST ${baseUrl}/hooks/http
Headers: Authorization as above and Content-Type: application/json.
Body fields: conversationId (a stable id you generate for our chat), prompt (my message), idempotencyKey (a unique id you generate for this message). project (an id from listProjects) and title are optional; omit project when the agent should choose or summarize work across allowed projects.
The response is HTTP 202 with {"accepted":true,"messageId":"..."}. Save messageId, conversationId and the exact request body.
For follow-ups, keep conversationId and generate a new idempotencyKey. You can ask about Slack or terminal work in this chat; the shared agent finds its history and replies here. Use a new conversationId only to start a fresh chat. For a network retry, reuse the exact JSON body and idempotencyKey; the server returns the original messageId without repeating work. Do not automatically retry a 400, 401, 403 or 409 error.

3. getTaskResult: GET ${baseUrl}/hooks/http/messages/{messageId}
Replace {messageId} with the saved id. Returns {"messageId":"...","conversationId":"...","deliveryStatus":"pending|processing|done|failed","threads":[{"threadId":"...","status":"...","answer":"..."}]}.
Results also include replies [{id,text,at}] from the shared agent and pending (whether work is still in progress). Show new replies once, tracking their ids. deliveryStatus=done means the agent handled the message, not necessarily that coding finished. pending=false means no work is currently owed here. Report waiting, failed, cancelled or interrupted thread states accurately; results show the latest run, including follow-ups. A question can have replies without creating any coding thread.
Check no more often than every 10 seconds while I am waiting. If the host is offline, treat silence as pending; never invent completion or submit a new task just to check status.

Only request a worktree when I ask for one: add "worktree":{"baseRef":"main"} to the first message, using the correct base branch for that project.

Do this now: fetch the OpenAPI document, configure the three actions, then call listProjects with the bearer header. Reply with the projects you can access and confirm the connection. Do not start any coding work as a setup test. If you cannot make authenticated HTTP requests or configure these actions, tell me that exact limitation; do not claim the connection is working.
`;
}

export function httpDiscovery(baseUrl = "/") {
  const prefix = baseUrl === "/" ? "" : baseUrl;
  return {
    name: "t3c", version: VERSION, openapi: `${prefix}/hooks/http/openapi.json`,
    authentication: { type: "http", scheme: "bearer", header: "Authorization" },
    actions: {
      listProjects: { method: "GET", url: `${prefix}/hooks/http/projects` },
      sendTask: { method: "POST", url: `${prefix}/hooks/http` },
      getTaskResult: { method: "GET", url: `${prefix}/hooks/http/messages/{messageId}` },
    },
  };
}

/** Setup must prove the public routes and auth before offering a connection prompt. No work is submitted. */
export async function verifyHttpApi(baseUrl: string, secret: string): Promise<{ id: string; title: string }[]> {
  const get = (path: string, authenticated = false) => fetch(`${baseUrl}${path}`, {
    headers: authenticated ? { authorization: `Bearer ${secret}` } : {}, signal: AbortSignal.timeout(10_000),
  });
  const [discovery, schema, projects, anonymous, internal] = await Promise.all([
    get("/hooks/http"), get("/hooks/http/openapi.json"), get("/hooks/http/projects", true),
    get("/hooks/http/projects"), get("/agent/mcp"),
  ]);
  if (discovery.status !== 200 || schema.status !== 200 || projects.status !== 200 || anonymous.status !== 401 || internal.status !== 404) {
    throw new Error(`Instinct API isn't ready at ${baseUrl}: discovery ${discovery.status}, OpenAPI ${schema.status}, projects ${projects.status}, unauthenticated ${anonymous.status}, internal tools ${internal.status}. Run \`t3c status\` and check Tailscale Funnel.`);
  }
  const document = await schema.json();
  if (document.servers?.[0]?.url !== baseUrl) throw new Error("Instinct's OpenAPI document has the wrong public server URL. Restart t3c and run setup again.");
  return projects.json();
}
