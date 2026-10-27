import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Skills are Markdown playbooks that shape the agent's decisions, included in every run's prompt.
 * The defaults ship in ./skills; t3c copies them to ~/.t3c/skills once, where people edit them or
 * add their own `.md` files, used from the next run.
 */
const DEFAULTS_DIR = join(import.meta.dirname, "skills");

/** Copies the default skills into `dir`, leaving existing files alone. */
export function ensureSkills(dir: string) {
  cpSync(DEFAULTS_DIR, dir, { recursive: true, force: false, filter: (src) => src === DEFAULTS_DIR || isSkill(basename(src)) });
}

/** All skills in the directory, in name order; the defaults when it has none. */
export function loadSkills(dir: string): string {
  const files = (root: string) => (existsSync(root) ? readdirSync(root).filter(isSkill).sort() : []);
  const root = files(dir).length > 0 ? dir : DEFAULTS_DIR;
  return files(root)
    .map((f) => readFileSync(join(root, f), "utf8").trim())
    .join("\n\n");
}

/** Markdown files, skipping hidden ones (e.g. macOS `._` metadata files). */
function isSkill(name: string) {
  return name.endsWith(".md") && !name.startsWith(".");
}
