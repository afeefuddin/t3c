import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// T3's MCP endpoint only accepts its own OAuth credentials (CLI-issued session
// tokens are rejected), so the service logs in once through the standard MCP
// OAuth flow and keeps the result on disk.

const SCOPES = "orchestration:read orchestration:operate";
const CALLBACK_PORT = 8976;
const REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

interface AuthState {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export class FileOAuthProvider implements OAuthClientProvider {
  private readonly path: string;
  private readonly onRedirect: (url: URL) => void;
  private readonly expectedState = randomBytes(16).toString("hex");

  constructor(path: string, onRedirect: (url: URL) => void = notLoggedIn) {
    this.path = path;
    this.onRedirect = onRedirect;
  }

  get redirectUrl() {
    return REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "t3c",
      redirect_uris: [REDIRECT_URL],
      // refresh_token lets the background service renew its access without a new login.
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES,
    };
  }

  state() {
    return this.expectedState;
  }

  clientInformation() {
    return this.read().client;
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    this.write({ ...this.read(), client });
  }

  tokens() {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    this.write({ ...this.read(), tokens, codeVerifier: undefined });
  }

  saveCodeVerifier(codeVerifier: string) {
    this.write({ ...this.read(), codeVerifier });
  }

  codeVerifier() {
    const verifier = this.read().codeVerifier;
    if (!verifier) throw new Error("No PKCE code verifier saved; restart `t3c login`.");
    return verifier;
  }

  redirectToAuthorization(url: URL) {
    this.onRedirect(url);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const state = this.read();
    if (scope === "all" || scope === "client") delete state.client;
    if (scope === "all" || scope === "tokens") delete state.tokens;
    if (scope === "all" || scope === "verifier") delete state.codeVerifier;
    this.write(state);
  }

  private read(): AuthState {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as AuthState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private write(state: AuthState) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}

function notLoggedIn(): never {
  throw new Error("Not logged in to T3 Code. Run `t3c login` first.");
}

/** Interactive login: the user approves the connection in T3's /connect-agent page. */
/** True once `t3c login` has stored tokens. */
export function isLoggedIn(authFile: string) {
  return Boolean(new FileOAuthProvider(authFile).tokens());
}

export async function login(serverUrl: string, authFile: string, open: (url: URL) => void) {
  let authorizationUrl: URL | undefined;
  const provider = new FileOAuthProvider(authFile, (url) => (authorizationUrl = url));
  provider.invalidateCredentials("tokens");

  const first = await auth(provider, { serverUrl, scope: SCOPES });
  if (first === "AUTHORIZED") return;
  if (!authorizationUrl) throw new Error("T3 did not return an authorization URL.");
  const code = waitForCallback(provider.state());
  open(authorizationUrl);

  const result = await auth(provider, { serverUrl, scope: SCOPES, authorizationCode: await code });
  if (result !== "AUTHORIZED") throw new Error("T3 did not issue a token.");
}

function waitForCallback(expectedState: string, timeoutMs = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URL);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const ok = !error && code && url.searchParams.get("state") === expectedState;
      res
        .writeHead(ok ? 200 : 400, { "content-type": "text/plain" })
        .end(ok ? "t3c is connected. You can close this tab." : "Login failed.");
      finish(ok ? undefined : new Error(error ?? "Invalid OAuth callback (missing code or state mismatch)."), code);
    });
    const timer = setTimeout(() => finish(new Error("Timed out waiting for approval in T3.")), timeoutMs);
    const finish = (error?: Error, code?: string | null) => {
      clearTimeout(timer);
      server.close();
      if (error || !code) reject(error);
      else resolve(code);
    };
    server.on("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
}
