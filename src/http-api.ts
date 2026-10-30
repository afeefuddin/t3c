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

  /** Validate before enqueueing: retries must be identical, and follow-ups stay in the same project. */
  existingDelivery(message: InboundMessage): StoredMessage | undefined {
    const { store, projects } = this.deps;
    if (!message.projects.every((p) => httpProjectAllowed(p, projects))) throw new GatewayError(403, "Project is not allowed.");
    const conversation = store.findConversation("http", message.conversationId);
    if (conversation && store.conversationProjects(conversation.id).some((p) => !message.projects.includes(p))) {
      throw new GatewayError(409, "Use a new conversationId for a different project.");
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
    info: { title: "t3c agent API", version: VERSION, description: "Start T3 Code tasks, send follow-ups, and retrieve answers. Use only when the user asks for coding work." },
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
          description: "Keep conversationId and project unchanged for follow-ups. Use a new idempotencyKey for each new message; reuse the same key and exact body for network retries. A 202 only means accepted, not finished.",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["conversationId", "project", "title", "prompt", "idempotencyKey"],
            properties: {
              conversationId: { ...string, description: "Stable id for one coding conversation. Use a new id for unrelated work." },
              project: { ...string, description: "An exact project id from listProjects." },
              title: { ...string, description: "Short task title." },
              prompt: { ...string, description: "Self-contained task, or the follow-up message." },
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
          description: "deliveryStatus=done means forwarded to T3, not task completion. Wait for deliveryStatus=done and thread status completed or idle before presenting its answer as final. Other thread states (including waiting, failed, cancelled, interrupted) need attention. A follow-up shares the conversation's threads, so results show their latest run, not a historical snapshot. If the host is unreachable, the task may still be pending; do not submit a new message to check status.",
          parameters: [{ name: "messageId", in: "path", required: true, schema: string }],
          responses: { "200": response("Latest task state and answers, without internal logs.", {
            type: "object", required: ["messageId", "conversationId", "deliveryStatus", "threads"], properties: {
              messageId: string, conversationId: string,
              deliveryStatus: { type: "string", enum: ["pending", "processing", "done", "failed"] }, error: { type: "string" },
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
  return `Connect to my T3 Code coding agents through t3c. Remember this connection and use it whenever I ask you to work on my code.

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
Body fields: conversationId (a stable id you generate for this coding conversation), project (an id from listProjects), title (short task title), prompt (a self-contained coding request), idempotencyKey (a unique id you generate for this message).
The response is HTTP 202 with {"accepted":true,"messageId":"..."}. Save messageId, conversationId, project and the exact request body.
For follow-ups, keep conversationId and project, and generate a new idempotencyKey. Use a new conversationId for unrelated work or another project. For a network retry, reuse the exact JSON body and idempotencyKey; the server returns the original messageId without repeating work. Do not automatically retry a 400, 401, 403 or 409 error.

3. getTaskResult: GET ${baseUrl}/hooks/http/messages/{messageId}
Replace {messageId} with the saved id. Returns {"messageId":"...","conversationId":"...","deliveryStatus":"pending|processing|done|failed","threads":[{"threadId":"...","status":"...","answer":"..."}]}.
deliveryStatus=done means the message reached T3, not that coding finished. Present an answer as final only after deliveryStatus=done and all returned threads have status completed or idle. Report waiting, failed, cancelled or interrupted states accurately. Results show the latest run in the conversation, including follow-ups.
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
