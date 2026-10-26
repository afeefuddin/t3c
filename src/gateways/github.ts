import type { Config } from "../config.ts";
import { errorMessage, log } from "../log.ts";
import { type Gateway, GatewayError, type GatewayRequest, header, hmacSha256Hex, type InboundMessage, type Preparation, type Received, safeEqual } from "../gateway.ts";

export type GithubConfig = NonNullable<Config["github"]> & {
  /** Token used to read issues and post replies (replies appear as its owner). */
  token: string;
};

export type GithubCall = (method: string, path: string, body?: unknown) => Promise<any>;

/** Roles GitHub reports for people with write access; anyone else can't trigger work even if allowlisted. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const COMMAND = /^\/t3c(?:\s+([\s\S]*))?$/;
const MAX_REPLY_CHARS = 60_000;
const MAX_CONTEXT_ITEM_CHARS = 4_000;

export function githubApi(token: string): GithubCall {
  return async (method, path, body) => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "t3c",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = res.status === 204 ? null : await res.json();
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed (${res.status}): ${data?.message ?? "unknown error"}`);
    return data;
  };
}

/**
 * GitHub ⇄ T3. A comment starting with `/t3c <request>` on an issue or pull request starts a T3
 * thread in its own worktree; later /t3c comments are follow-ups; answers come back as comments.
 */
export class GithubGateway implements Gateway {
  readonly name = "github";
  private readonly config: GithubConfig;
  private readonly github: GithubCall;

  constructor(config: GithubConfig, deps: { github?: GithubCall } = {}) {
    this.config = config;
    this.github = deps.github ?? githubApi(config.token);
  }

  receive({ headers, body }: GatewayRequest): Received {
    const expected = `sha256=${hmacSha256Hex(this.config.webhookSecret, body)}`;
    if (!safeEqual(header(headers, "x-hub-signature-256"), expected)) throw new GatewayError(401, "Invalid GitHub signature.");

    const event = header(headers, "x-github-event");
    if (event === "ping") return { response: { ok: true } };
    if (event !== "issue_comment") return {};
    const payload = JSON.parse(body.toString("utf8"));
    const message = payload.action === "created" ? this.toMessage(payload) : undefined;
    return message ? { message } : {};
  }

  private toMessage({ comment, issue, repository }: any): InboundMessage | undefined {
    const match = COMMAND.exec(String(comment.body ?? "").trim());
    if (!match) return;
    const repo = String(repository.full_name);
    const project = Object.entries(this.config.repos).find(([r]) => r.toLowerCase() === repo.toLowerCase())?.[1];
    const login = String(comment.user?.login ?? "");
    // Public repos let anyone comment: require both the allowlist and write access, and stay silent otherwise.
    if (!project || comment.user?.type === "Bot") return;
    const allowed = this.config.allowedUsers.some((u) => u.toLowerCase() === login.toLowerCase());
    if (!allowed || !TRUSTED_ASSOCIATIONS.has(comment.author_association)) {
      log(this.name, `ignored /t3c from ${login} (${comment.author_association}) on ${repo}#${issue.number}: not allowed`, "warn");
      return;
    }
    const text = (match[1] ?? "").trim();
    if (!text) {
      void this.reply(`${repo}#${issue.number}`, "Usage: `/t3c <what to do>`").catch((e) => log(this.name, `couldn't post a notice: ${errorMessage(e)}`, "warn"));
      return;
    }
    return {
      source: this.name,
      eventKey: `comment-${comment.id}`,
      conversationId: `${repo}#${issue.number}`,
      user: `@${login}`,
      text,
      title: `${repo}#${issue.number} ${issue.title}`,
      projects: [project],
      url: comment.html_url,
      meta: {
        repo,
        number: String(issue.number),
        commentId: String(comment.id),
        defaultBranch: String(repository.default_branch),
        ...(issue.pull_request ? { pullRequest: "true" } : {}),
      },
    };
  }

  async prepare(message: InboundMessage): Promise<Preparation> {
    const { repo, number, commentId, defaultBranch, pullRequest } = message.meta!;
    const [issue, comments] = await Promise.all([
      this.github("GET", `/repos/${repo}/issues/${number}`),
      this.github("GET", `/repos/${repo}/issues/${number}/comments?per_page=100`),
    ]);
    const context = [
      `${pullRequest ? "Pull request" : "Issue"} #${number}: ${issue.title} (by @${issue.user.login})`,
      clip(issue.body ?? ""),
      ...comments
        .filter((c: any) => String(c.id) !== commentId)
        .map((c: any) => `\n@${c.user.login} commented:\n${clip(c.body ?? "")}`),
    ].join("\n");

    if (!pullRequest) {
      const branch = `t3c/issue-${number}`;
      return {
        context,
        worktree: { baseRef: defaultBranch, branch, startFromOrigin: true },
        instructions: `You are on branch ${branch}. When the change is ready, push it and open a pull request that references #${number}.`,
      };
    }
    const pull = await this.github("GET", `/repos/${repo}/pulls/${number}`);
    // A fork's branch holds code from someone without write access; don't check it out on this machine.
    if (pull.head.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) {
      throw new Error("t3c doesn't work on pull requests from forks.");
    }
    return {
      context,
      worktree: { baseRef: pull.head.ref, branch: `t3c/pr-${number}`, startFromOrigin: true },
      instructions: `This is pull request #${number}. Push your commits to its branch with \`git push origin HEAD:${pull.head.ref}\`.`,
    };
  }

  async acknowledge(message: InboundMessage) {
    const { repo, commentId } = message.meta!;
    await this.github("POST", `/repos/${repo}/issues/comments/${commentId}/reactions`, { content: "eyes" });
  }

  async reply(conversationId: string, text: string) {
    const [repo, number] = conversationId.split("#");
    const body = text.length <= MAX_REPLY_CHARS ? text : `${text.slice(0, MAX_REPLY_CHARS)}…\n\n(truncated, full reply in T3 Code)`;
    // The prefix also guarantees a reply never starts with /t3c and re-triggers us.
    await this.github("POST", `/repos/${repo}/issues/${number}/comments`, { body: `🤖 **t3bot**\n\n${body}` });
  }
}

/** Creates the repository webhook that sends issue comments to this machine. */
export async function connectRepo(github: GithubCall, repo: string, hookUrl: string, secret: string) {
  const hooks: any[] = await github("GET", `/repos/${repo}/hooks`);
  const existing = hooks.find((h) => h.config?.url === hookUrl);
  const config = { url: hookUrl, content_type: "json", secret, insecure_ssl: "0" };
  if (existing) {
    await github("PATCH", `/repos/${repo}/hooks/${existing.id}`, { active: true, events: ["issue_comment"], config });
    return { id: existing.id as number, created: false };
  }
  const hook = await github("POST", `/repos/${repo}/hooks`, { name: "web", active: true, events: ["issue_comment"], config });
  return { id: hook.id as number, created: true };
}

function clip(text: string) {
  return text.length <= MAX_CONTEXT_ITEM_CHARS ? text : `${text.slice(0, MAX_CONTEXT_ITEM_CHARS)}… (truncated)`;
}
