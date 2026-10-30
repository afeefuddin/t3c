#!/usr/bin/env node
// A scripted Claude print-mode process. Real MCP calls exercise t3c's own authorization checks.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? "route";
if (args.includes("--help")) {
  console.log(mode === "old" ? "--print --tools" : "--restricted --tools --strict-mcp-config --setting-sources --settings --permission-mode --permission-prompts --disable-slash-commands --no-chrome --no-session-persistence");
  process.exit(0);
}
const value = (flag) => args[args.indexOf(flag) + 1];
assert.equal(value("--tools"), "");
assert.equal(value("--setting-sources"), "");
assert.equal(value("--permission-mode"), "dontAsk");
assert.equal(value("--permission-prompts"), "none");
assert.equal(value("--allowedTools"), "mcp__t3c__*");
assert.equal(args.some((a) => /bypass|dangerously/.test(a)), false);
assert.equal(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
assert.equal(process.env.ENABLE_TOOL_SEARCH, "false");
const settings = JSON.parse(value("--settings"));
assert.equal(settings.disableAllHooks, true);
assert.equal(settings.autoMemoryEnabled, false);
assert.deepEqual(settings.claudeMdExcludes, ["**"]);
assert.deepEqual(settings.enabledPlugins, {});
const config = JSON.parse(value("--mcp-config"));
assert.deepEqual(Object.keys(config.mcpServers), ["t3c"]);
const mcp = config.mcpServers.t3c;
assert.equal(mcp.headers.Authorization, "Bearer ${T3C_AGENT_TOKEN}");
assert.equal(args.join(" ").includes(process.env.T3C_AGENT_TOKEN), false);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const content = JSON.parse(input).message.content;
const prompt = content[0].text;
if (process.env.FAKE_CLAUDE_SEEN && !prompt.includes("<thread-answer>")) {
  writeFileSync(process.env.FAKE_CLAUDE_SEEN, JSON.stringify({
    args, cwd: process.cwd(), content, token: process.env.T3C_AGENT_TOKEN,
  }));
}
const emit = (event) => console.log(JSON.stringify(event));
if (mode === "no-init") {
  emit({ type: "result", subtype: "success", result: "done" });
  process.exit(0);
}
if (mode === "invalid-json") {
  console.log("null");
  await new Promise((r) => setTimeout(r, 5000));
  process.exit(1);
}
if (mode === "disconnected") {
  emit({ type: "system", subtype: "init", tools: [], mcp_servers: [{ name: "t3c", status: "failed" }] });
  await new Promise((r) => setTimeout(r, 5000));
  process.exit(1);
}
if (mode === "unsafe-tools") {
  emit({ type: "system", subtype: "init", tools: ["Bash"], mcp_servers: [{ name: "t3c", status: "connected" }] });
  await new Promise((r) => setTimeout(r, 5000));
  process.exit(1);
}
const client = new Client({ name: "fake-claude", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), {
  requestInit: { headers: { authorization: `Bearer ${process.env.T3C_AGENT_TOKEN}` } },
}));
const { tools } = await client.listTools();
emit({ type: "system", subtype: "init", tools: tools.map((t) => `mcp__t3c__${t.name}`), mcp_servers: [{ name: "t3c", status: "connected" }] });
if (mode === "credit-error") {
  emit({ type: "result", subtype: "success", is_error: true, result: "Credit balance is too low" });
  await client.close();
  process.exit(0);
}
if (mode === "timeout") {
  await new Promise((r) => setTimeout(r, 5000));
  process.exit(1);
}
const call = async (name, input = {}) => {
  const result = await client.callTool({ name, arguments: input });
  return result.isError ? { error: result.content[0].text } : { value: JSON.parse(result.content[0].text) };
};
let summary;
if (prompt.includes("<thread-answer>")) {
  await call("reply", { text: "Fixed the header. PR is ready." });
  summary = "posted the answer";
} else {
  await call("load_skill", { name: "new-requests" });
  const projects = (await call("list_projects")).value.map((p) => p.name);
  const project = projects.find((p) => prompt.toLowerCase().includes(p.toLowerCase())) ?? projects[0];
  const denied = await call("start_thread", { project: "Secret", title: "x", prompt: "x" });
  assert.match(denied.error, /isn't allowed here/);
  await call("start_thread", { project, title: "Fix header overlap", prompt: "Fix the header overlap on Safari." });
  if (mode === "act-then-crash") process.exit(2);
  await call("update_summary", { summary: `Working in ${project}. ${denied.error}` });
  summary = `started a thread in ${project}`;
}
await client.close();
// No trailing newline: the parent must consume the last partial output line on close.
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: summary }));
