import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skills are Markdown playbooks in ~/.t3c/skills that shape the agent's decisions. t3c writes these
 * defaults once; edit them or add your own `.md` files and they're used on the next run.
 */
export const DEFAULT_SKILLS: Record<string, string> = {
  "route-project.md": `# Route to a project

Decide which T3 project a new request belongs to.

- Use only projects from \`list_projects\`. If there is exactly one, use it.
- Match on what the request is about: product names, file paths, services, errors, links to
  repositories. Read the Slack thread with \`fetch_source\` when the latest message alone is unclear.
- If two projects fit about equally, or none clearly fits, don't guess: \`ask_user\` with a short
  question naming the candidates (e.g. "Is this for web-app or api?").
- A request can need more than one project (e.g. "update the API and the web client"). Then start one
  thread per project, each with its own label.
`,
  "summarize-thread.md": `# Write the brief

When starting a thread, pass a \`brief\` that gives the coding agent what it needs and nothing else:

- **Goal**: one sentence.
- **Details**: repro steps, error messages, expected vs actual, constraints, decisions already made.
- **Links**: URLs mentioned in the conversation.
- **Open questions**, if any.

Write it from the conversation, but leave out greetings, chatter and anything unrelated. Never include
secrets (tokens, passwords) even if someone pasted them. The user's own request is added verbatim
automatically, so don't repeat it.
`,
  "follow-ups.md": `# Follow-ups and answers

- A new message in a conversation that already has threads is usually more input for that work:
  \`send_to_thread\` with the person's words. Pick the thread it's about; if unclear, use the most
  recent one.
- If the message only asks for status ("how's it going?"), \`read_thread\` and \`reply\` with a short
  update instead of disturbing the thread.
- When a thread finishes, \`reply\` with the outcome in a few lines: what was done, what's left,
  anything that needs the person's attention (approvals, failing tests, a PR link). Don't paste long
  logs; say where to look.
- Keep \`update_summary\` current with what this conversation is about and where things stand.
`,
};

export function ensureSkills(dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(DEFAULT_SKILLS)) {
    const path = join(dir, name);
    if (!existsSync(path)) writeFileSync(path, content);
  }
}

/** All skills in the directory, in name order; the defaults when the directory doesn't exist. */
export function loadSkills(dir: string): string {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
  const skills = files.length > 0 ? files.map((f) => readFileSync(join(dir, f), "utf8")) : Object.values(DEFAULT_SKILLS);
  return skills.map((s) => s.trim()).join("\n\n");
}
