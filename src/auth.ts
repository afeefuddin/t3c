import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { loadConfig, paths, t3McpUrl } from "./config.ts";
import type { RuntimeMode } from "./t3.ts";

// T3's MCP endpoint only accepts its own OAuth tokens. Its browser approval page can't be relied on
// (the desktop build serves it as a 500), so t3c approves itself with a short-lived pairing code
// from the `t3` CLI: the same decision the page would post. T3 issues no refresh tokens, so when a
// token nears its 30-day expiry t3c simply logs in again the same way.

const REDIRECT_URI = "http://127.0.0.1:8976/callback";
/** Log in again when the token has less than this left. */
const RENEW_BEFORE_MS = 24 * 60 * 60_000;

interface AuthState {
  clientId?: string;
  accessToken?: string;
  expiresAt?: number;
  /** The highest runtime mode T3 lets threads launched with this token use. */
  access?: RuntimeMode;
}

/** Mints a one-time T3 pairing code carrying the given scopes. */
export type Pair = (scopes: string[]) => Promise<string>;

const run = promisify(execFile);

export const pairWithCli: Pair = async (scopes) => {
  const args = ["auth", "pairing", "create", "--ttl", "5m", "--label", "t3c", "--json"];
  for (const scope of scopes) args.push("--scope", scope);
  try {
    const { stdout } = await run("t3", args);
    return (JSON.parse(stdout) as { credential: string }).credential;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The `t3` command wasn't found. Install the T3 Code CLI and try again.");
    }
    throw new Error(`\`t3 auth pairing create\` failed: ${(error as { stderr?: string }).stderr?.trim() || error}`);
  }
};

/** The scopes T3 requires for a client allowed to launch threads up to `access`. */
function scopesFor(access: RuntimeMode) {
  const scopes = ["orchestration:read", "orchestration:operate"];
  if (access === "full-access") scopes.push("settings:write", "source-control:write");
  return scopes;
}

export class T3Auth {
  readonly serverUrl: string;
  private readonly authFile: string;
  private readonly access: RuntimeMode;
  private readonly pair: Pair;
  private pending?: Promise<string>;

  constructor(opts: { serverUrl: string; authFile: string; access: RuntimeMode; pair?: Pair }) {
    this.serverUrl = opts.serverUrl;
    this.authFile = opts.authFile;
    this.access = opts.access;
    this.pair = opts.pair ?? pairWithCli;
  }

  /** A valid access token, logging in again first if it's missing, expiring or too narrow. */
  token(): Promise<string> {
    const state = this.read();
    const fresh = state.accessToken && state.access === this.access && (state.expiresAt ?? 0) - Date.now() > RENEW_BEFORE_MS;
    if (fresh) return Promise.resolve(state.accessToken!);
    return this.login();
  }

  /** Logs in once, however many callers ask at the same time. */
  login(): Promise<string> {
    this.pending ??= this.authorize().finally(() => (this.pending = undefined));
    return this.pending;
  }

  /** A fetch for the MCP transport: adds the token, and logs in again once if T3 rejects it. */
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const send = (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    };
    const response = await send(await this.token());
    if (response.status !== 401) return response;
    return send(await this.login());
  };

  private async authorize(): Promise<string> {
    const meta = (await this.json(new URL("/.well-known/oauth-authorization-server", this.serverUrl))) as {
      registration_endpoint: string;
      token_endpoint: string;
    };
    let { clientId } = this.read();
    if (!clientId) {
      const client = (await this.json(meta.registration_endpoint, {
        client_name: "t3c",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      })) as { client_id: string };
      clientId = client.client_id;
      this.write({ clientId });
    }

    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("hex");
    const authorization = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
    };
    const code = await this.pair(scopesFor(this.access));
    const { redirectTo } = (await this.json(new URL("/oauth/mcp/decision", this.serverUrl), {
      authorization,
      decision: { _tag: "pairing-code", access: this.access, code },
    })) as { redirectTo: string };
    const redirect = new URL(redirectTo).searchParams;
    if (redirect.get("error")) throw new Error(`T3 refused the login: ${redirect.get("error_description") ?? redirect.get("error")}`);
    if (redirect.get("state") !== state || !redirect.get("code")) throw new Error("T3 returned an invalid approval.");

    const tokens = (await this.json(
      meta.token_endpoint,
      new URLSearchParams({
        grant_type: "authorization_code",
        code: redirect.get("code")!,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      }),
    )) as { access_token: string; expires_in: number };
    this.write({ clientId, accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000, access: this.access });
    return tokens.access_token;
  }

  private async json(url: string | URL, body?: object | URLSearchParams) {
    const init: RequestInit =
      body === undefined
        ? {}
        : body instanceof URLSearchParams
          ? { method: "POST", body }
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const response = await fetch(url, init).catch(() => {
      throw new Error(`T3 Code isn't reachable at ${new URL(url).origin}. Is it running?`);
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`T3 login failed (${response.status} ${new URL(url).pathname}): ${text.slice(0, 200)}`);
    return JSON.parse(text) as unknown;
  }

  private read(): AuthState {
    return readAuth(this.authFile);
  }

  private write(state: AuthState) {
    mkdirSync(dirname(this.authFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.authFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}

function readAuth(authFile: string): AuthState {
  try {
    return JSON.parse(readFileSync(authFile, "utf8")) as AuthState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** t3c's own T3 login, allowed to launch threads up to the configured runtime mode. */
export function t3Auth() {
  return new T3Auth({ serverUrl: t3McpUrl(), authFile: paths.auth, access: loadConfig().runtimeMode });
}

/** True once `t3c login` has stored a token. */
export function isLoggedIn(authFile: string) {
  return Boolean(readAuth(authFile).accessToken);
}
