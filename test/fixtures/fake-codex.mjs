#!/usr/bin/env node
// Stands in for `codex exec`: reads the t3c tool URL from -c flags and the token from the env var
// Codex would use, then calls tools as a scripted agent. FAKE_CODEX_MODE picks the script.
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const config = args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
const url = JSON.parse(config.find((c) => c.startsWith("mcp_servers.t3c.url=")).split("=").slice(1).join("="));
const tokenVar = JSON.parse(config.find((c) => c.startsWith("mcp_servers.t3c.bearer_token_env_var=")).split("=")[1]);
const outFile = args[args.indexOf("-o") + 1];
const prompt = args.at(-1);
const mode = process.env.FAKE_CODEX_MODE ?? "route";

if (mode === "crash") {
  console.error("model overloaded");
  process.exit(1);
}

const client = new Client({ name: "fake-codex", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${process.env[tokenVar]}` } } }),
);
const call = async (name, input = {}) => {
  const result = await client.callTool({ name, arguments: input });
  return { error: result.isError ? result.content[0].text : undefined, value: result.isError ? undefined : JSON.parse(result.content[0].text) };
};

let summary;
if (prompt.includes("finished with status")) {
  await call("reply", { text: "Fixed: the header no longer overlaps. PR is up." });
  summary = "summarized the answer";
} else {
  const projects = (await call("list_projects")).value.map((p) => p.name);
  // Routes to the project the request mentions, the way a model would.
  const project = projects.find((p) => prompt.toLowerCase().includes(p.toLowerCase())) ?? projects[0];
  const forbidden = await call("start_thread", { project: "Secret", title: "x" });
  await call("start_thread", { project, title: "Fix header overlap", brief: "Goal: fix the header on mobile Safari." });
  await call("update_summary", { summary: `Header bug, working in ${project}. Forbidden attempt: ${forbidden.error}` });
  summary = `started a thread in ${project}`;
  if (mode === "act-then-crash") process.exit(2);
}
await client.close();
writeFileSync(outFile, `thinking…\n${summary}\n`);
