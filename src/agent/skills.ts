import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";

/**
 * Agent Skills: each skill is a folder `<name>/SKILL.md` with `name` and `description` frontmatter
 * and Markdown instructions. The agent's prompt lists only names and descriptions; it loads the
 * instructions it needs with the load_skill tool.
 *
 * The built-in skills ship in ./skills and are always used, so updates reach every install. A
 * folder in the user's skills dir (~/.t3c/skills) named like a built-in skill replaces it; any
 * other adds one. Read on every run, so edits apply from the next one.
 */
const BUILT_IN_DIR = join(import.meta.dirname, "skills");

export interface Skill {
  name: string;
  /** What it does and when to use it: all the agent sees until it loads the skill. */
  description: string;
  /** The instructions, without the frontmatter. */
  body: string;
}

/** Built-in skills the user's dir replaces, by name. */
export function overriddenSkills(dir: string): string[] {
  const own = new Set(skillDirs(dir));
  return skillDirs(BUILT_IN_DIR).filter((name) => own.has(name));
}

/** Every valid skill in name order, the user's version where they have one. */
export function loadSkills(dir: string): Skill[] {
  const paths = new Map(skillDirs(BUILT_IN_DIR).map((name) => [name, join(BUILT_IN_DIR, name, "SKILL.md")]));
  for (const name of skillDirs(dir)) paths.set(name, join(dir, name, "SKILL.md"));
  return [...paths]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, path]) => {
      try {
        return [parseSkill(name, readFileSync(path, "utf8"))];
      } catch (error) {
        log("agent", `skipping skill ${path}: ${error instanceof Error ? error.message : error}`, "warn");
        return [];
      }
    });
}

/** SKILL.md: `---` frontmatter of `key: value` lines (name, description), then the instructions. */
export function parseSkill(folder: string, text: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("no frontmatter (--- name: … description: … ---)");
  const fields = new Map(
    match[1].split(/\r?\n/).flatMap((line) => {
      const field = /^([a-z-]+):\s*(.*)$/.exec(line);
      return field ? [[field[1], field[2].trim().replace(/^(["'])(.*)\1$/, "$2")] as const] : [];
    }),
  );
  const name = fields.get("name");
  const description = fields.get("description");
  if (name !== folder) throw new Error(`name "${name ?? ""}" must match its folder "${folder}"`);
  if (!description) throw new Error("no description");
  return { name, description, body: match[2].trim() };
}

/** Folders holding a SKILL.md, skipping hidden ones (e.g. macOS `._` metadata). */
function skillDirs(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name);
}
