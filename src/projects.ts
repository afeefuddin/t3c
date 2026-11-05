import { homedir } from "node:os";
import { allowedProjects, type Config, loadConfig, saveConfig } from "./config.ts";
import { color } from "./log.ts";
import type { Project } from "./t3.ts";
import { confirm, question, say } from "./ui.ts";

/** A connection whose projects can be chosen, named the way people know it. */
export interface Connection {
  kind: "slack" | "http";
  label: string;
  /** Project ids, older titles or projects T3 no longer has, or ["*"] for any. */
  allowed: string[];
}

export function connections(config: Config): Connection[] {
  const list: Connection[] = [];
  if (config.slack) list.push({ kind: "slack", label: "Slack", allowed: allowedProjects(config, "slack") });
  if (config.http) list.push({ kind: "http", label: config.http.public ? "Instinct" : "HTTP", allowed: allowedProjects(config, "http") });
  return list;
}

/** `slack`, `instinct` or `http` as typed on the command line. */
export function findConnection(config: Config, name: string): Connection {
  const kind = name === "slack" ? "slack" : name === "instinct" || name === "http" ? "http" : undefined;
  if (!kind) throw new Error("Usage: t3c projects [slack | instinct] [add | remove <project>…]");
  const connection = connections(config).find((c) => c.kind === kind);
  if (!connection) throw new Error(kind === "slack" ? "Slack isn't connected. Run `t3c add slack` first." : "Instinct isn't connected. Run `t3c add instinct` first.");
  return connection;
}

/** Stores projects by id so renaming one in T3 keeps it allowed; older configs used titles. */
export function normalize(allowed: string[], projects: Project[]): string[] {
  if (allowed.includes("*")) return ["*"];
  const ids = allowed.map((a) => (projects.find((p) => p.id === a) ?? projects.find((p) => p.title.toLowerCase() === a.toLowerCase()))?.id ?? a);
  return [...new Set(ids)];
}

export function isOn(selected: string[], key: string) {
  return selected.includes("*") || selected.includes(key);
}

/**
 * Turns one project (or "*", any project) on or off. Turning a project off under "any project"
 * keeps every other one, so unticking one never takes the rest away.
 */
export function setProject(selected: string[], key: string, on: boolean, projects: Project[]): string[] {
  const any = selected.includes("*");
  if (key === "*") return on ? ["*"] : any ? projects.map((p) => p.id) : selected;
  if (on && any) return selected;
  const rest = (any ? projects.map((p) => p.id) : selected).filter((k) => k !== key);
  return on ? [...rest, key] : rest;
}

/** T3's order, then entries T3 no longer has. */
function ordered(selected: string[], projects: Project[]) {
  if (selected.includes("*")) return ["*"];
  const known = projects.filter((p) => selected.includes(p.id)).map((p) => p.id);
  return [...known, ...selected.filter((k) => !known.includes(k))];
}

/** Rows of the editor: T3's projects, then allowed ones T3 no longer has. */
function rows(selected: string[], projects: Project[]) {
  const missing = selected.filter((k) => k !== "*" && !projects.some((p) => p.id === k));
  return [...projects.map((p) => ({ key: p.id, title: p.title, missing: false })), ...missing.map((k) => ({ key: k, title: k, missing: true }))];
}

/**
 * Reads what was typed into the editor: numbers, names, or *, separated by commas or spaces
 * ("1 3", "2,4", "web app"). Returns the keys, or why something didn't match.
 */
export function parsePicks(input: string, list: { key: string; title: string }[]): { keys: string[] } | { error: string } {
  const byName = (name: string) => (name === "*" ? "*" : list.find((r) => r.title.toLowerCase() === name.toLowerCase() || r.key === name)?.key);
  const keys: string[] = [];
  for (const part of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    const whole = byName(part);
    if (whole) {
      keys.push(whole);
      continue;
    }
    for (const word of part.split(/\s+/)) {
      const key = /^\d+$/.test(word) ? list[Number(word) - 1]?.key : byName(word);
      if (!key) return { error: `"${/^\d+$/.test(word) ? word : part}" isn't in the list. Use its number or name.` };
      keys.push(key);
    }
  }
  return { keys };
}

/** "web-app and infra", "any project", or "no projects", for confirmations and status. */
export function describeAllowed(allowed: string[], projects: Project[]): string {
  if (allowed.includes("*")) return "any project, including ones added later";
  const names = allowed.map((k) => projects.find((p) => p.id === k)?.title ?? k);
  if (names.length === 0) return "no projects";
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Checklist of projects: typing numbers or names switches them on or off and shows the list
 * again; Enter keeps it. Returns the new selection, in T3's order.
 */
export async function pickProjects(label: string, current: string[], projects: Project[]): Promise<string[]> {
  let selected = normalize(current, projects);
  for (;;) {
    const list = rows(selected, projects);
    say.info(`Projects ${label} may work on:`);
    list.forEach((r, i) => {
      const box = isOn(selected, r.key) ? color("green", "[x]") : "[ ]";
      say.info(`  ${box} ${String(i + 1).padStart(2)}. ${r.title}${r.missing ? color("dim", "  (not in T3 Code any more)") : ""}`);
    });
    say.info(`  ${selected.includes("*") ? color("green", "[x]") : "[ ]"}  *. any project, including ones added later`);
    const answer = await question(`  Numbers or names to switch on or off ${color("dim", "(Enter to save)")}: `);
    if (!answer) {
      if (selected.length > 0 || (await confirm(`${label} won't be able to work on any project. Save anyway?`, false))) return ordered(selected, projects);
      continue;
    }
    const picks = parsePicks(answer, list);
    if ("error" in picks) {
      say.warn(picks.error);
      continue;
    }
    for (const key of picks.keys) selected = setProject(selected, key, !isOn(selected, key), projects);
  }
}

/** Saves a connection's projects; a removed connection is left alone. */
export function saveAllowed(kind: Connection["kind"], allowed: string[]) {
  const config = loadConfig();
  if (kind === "slack" && config.slack) config.slack.projects = allowed;
  if (kind === "http" && config.http) config.http.projects = allowed;
  saveConfig(config);
}

/**
 * `t3c projects slack|instinct`, interactive, or with `add`/`remove <project>…` for a one-liner.
 * The running service reads the list for each message, so nothing needs restarting.
 */
export async function editProjects(name: string, action: string | undefined, names: string[], projects: Project[]) {
  const connection = findConnection(loadConfig(), name);
  const before = normalize(connection.allowed, projects);
  let after: string[];
  if (!action) {
    after = await pickProjects(connection.label, before, projects);
  } else if ((action === "add" || action === "remove") && names.length > 0) {
    const list = rows(before, projects);
    after = before;
    for (const typed of names.flatMap((n) => n.split(",")).map((n) => n.trim()).filter(Boolean)) {
      const key = typed === "*" ? "*" : list.find((r) => r.title.toLowerCase() === typed.toLowerCase() || r.key === typed)?.key;
      if (!key) throw new Error(`No T3 project named "${typed}". \`t3c projects\` lists them.`);
      after = setProject(after, key, action === "add", projects);
    }
    after = ordered(after, projects);
  } else {
    throw new Error(`Usage: t3c projects ${name} [add | remove <project>…]`);
  }

  if (JSON.stringify(after) === JSON.stringify(connection.allowed)) {
    return say.ok(`No change: ${connection.label} can work on ${describeAllowed(after, projects)}.`);
  }
  saveAllowed(connection.kind, after);
  say.ok(`${connection.label} can now work on ${describeAllowed(after, projects)}.`);
  if (after.length === 0) say.warn(`Messages from ${connection.label} will be turned away until you allow a project.`);
  say.hint("Applies to the next message; no restart needed.");
}

/** `t3c projects`: every T3 project, and which connections may work on it. */
export function showProjects(config: Config, projects: Project[]) {
  const all = connections(config).map((c) => ({ ...c, allowed: normalize(c.allowed, projects) }));
  if (projects.length === 0) say.info(color("dim", "T3 Code has no projects yet."));
  const width = Math.max(12, ...projects.map((p) => p.title.length)) + 2;
  if (all.length > 0 && projects.length > 0) say.info(color("dim", `${"".padEnd(width)}${all.map((c) => c.label.padEnd(c.label.length + 3)).join("")}`));
  for (const p of projects) {
    const marks = all.map((c) => {
      const on = isOn(c.allowed, p.id);
      const cell = (on ? "✓" : "·").padStart(Math.ceil(c.label.length / 2)).padEnd(c.label.length + 3);
      return on ? color("green", cell) : color("dim", cell);
    }).join("");
    say.info(`${p.title.padEnd(width)}${marks}${color("dim", p.workspaceRoot.replace(homedir(), "~"))}`);
  }
  for (const c of all) {
    if (c.allowed.includes("*")) say.hint(`${c.label} may use any project, including ones added later.`);
    const missing = c.allowed.filter((k) => k !== "*" && !projects.some((p) => p.id === k));
    if (missing.length > 0) say.warn(`${c.label} still lists ${missing.map((m) => `"${m}"`).join(", ")}, which T3 Code doesn't have any more.`);
  }
  if (all.length === 0) say.hint("Connect Slack or Instinct (`t3c add slack`, `t3c add instinct`) to choose which projects they may use.");
  else say.hint(`Change with ${all.map((c) => `\`t3c projects ${c.label.toLowerCase()}\``).join(" or ")}.`);
}
