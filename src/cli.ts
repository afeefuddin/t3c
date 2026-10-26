#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { login } from "./auth.ts";
import { httpConnector } from "./connectors/http.ts";
import { Dispatcher } from "./dispatch.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";
import { T3Client } from "./t3.ts";

const USAGE = `t3c — turn incoming events into T3 Code threads

  t3c login                         approve this service in T3 Code (once)
  t3c projects                      list T3 projects
  t3c run <prompt> --project <p>    launch a thread now
        [--title <t>] [--id <externalId>] [--base-ref <ref> [--branch <b>]]
  t3c serve                         start the HTTP server (needs T3C_SECRET)

Environment (.env is loaded if present):
  T3_MCP_URL   T3 MCP endpoint (default: running T3 server + /mcp)
  T3C_HOME     state directory (default: ./.t3c)
  T3C_SECRET   bearer secret for POST /hooks/http and GET /tasks/:id
  HOST, PORT   server bind (default 127.0.0.1:8787)`;

class UsageError extends Error {}

if (existsSync(".env")) process.loadEnvFile(".env");

const home = process.env.T3C_HOME ?? ".t3c";
const authFile = join(home, "auth.json");
const serverUrl = process.env.T3_MCP_URL ?? defaultMcpUrl();

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    title: { type: "string" },
    id: { type: "string" },
    "base-ref": { type: "string" },
    branch: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, ...rest] = positionals;

try {
  switch (values.help ? undefined : command) {
    case "login":
      await login(serverUrl, authFile, (url) => {
        console.log(`Approve t3c in T3 Code:\n  ${url}`);
        if (process.platform === "darwin") execFile("open", [url.toString()]);
      });
      console.log(`Logged in. Credentials saved to ${authFile}.`);
      break;

    case "projects": {
      const t3 = await T3Client.connect(serverUrl, authFile);
      for (const p of await t3.listProjects()) console.log(`${p.id}  ${p.title}  ${p.workspaceRoot}`);
      await t3.close();
      break;
    }

    case "run": {
      const prompt = rest.join(" ");
      if (!prompt || !values.project) throw new UsageError("run needs a prompt and --project.");
      if (values.branch && !values["base-ref"]) throw new UsageError("--branch needs --base-ref.");
      const t3 = await T3Client.connect(serverUrl, authFile);
      const result = await new Dispatcher(t3, new Store(join(home, "state.sqlite"))).dispatch({
        source: "cli",
        externalId: values.id ?? randomUUID(),
        project: values.project,
        title: values.title ?? prompt.slice(0, 60),
        prompt,
        worktree: values["base-ref"] ? { baseRef: values["base-ref"], branch: values.branch } : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      await t3.close();
      break;
    }

    case "serve": {
      const secret = process.env.T3C_SECRET;
      if (!secret || secret.length < 16) throw new UsageError("Set T3C_SECRET (16+ characters) to serve.");
      const t3 = await T3Client.connect(serverUrl, authFile);
      const store = new Store(join(home, "state.sqlite"));
      const app = createApp({
        connectors: [httpConnector(secret)],
        dispatcher: new Dispatcher(t3, store),
        store,
        t3,
        secret,
      });
      const host = process.env.HOST ?? "127.0.0.1";
      const port = Number(process.env.PORT ?? 8787);
      app.listen(port, host, () => console.log(`t3c listening on http://${host}:${port}`));
      break;
    }

    default:
      console.log(USAGE);
      if (!values.help) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : error);
  process.exitCode = 1;
}


/** The desktop app records where its server listens. */
function defaultMcpUrl() {
  try {
    const runtime = JSON.parse(readFileSync(join(homedir(), ".t3/userdata/server-runtime.json"), "utf8"));
    return new URL("/mcp", runtime.origin).toString();
  } catch {
    return "http://127.0.0.1:3773/mcp";
  }
}
