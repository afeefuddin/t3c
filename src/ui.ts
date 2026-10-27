import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { color } from "./log.ts";

/** Plain terminal output for the interactive commands. */
export const say = {
  step: (text: string) => console.log(`\n${color("bold", text)}`),
  info: (text: string) => console.log(`  ${text}`),
  ok: (text: string) => console.log(`  ${color("green", "✓")} ${text}`),
  warn: (text: string) => console.log(`  ${color("yellow", "!")} ${text}`),
  hint: (text: string) => console.log(`  ${color("dim", text)}`),
};

/** While a secret is typed, the prompt it belongs to; readline redraws both on every keystroke. */
let maskedPrompt: string | undefined;
/** Terminal escape sequences pass through; every visible character of a secret shows as •. */
const VISIBLE = /\x1b\[[0-9;?]*[A-Za-z]|[^\x00-\x1f\x7f]/g;
const mask = (text: string) => text.replace(VISIBLE, (m) => (m.startsWith("\x1b") ? m : "•"));
const output = new Writable({
  write(chunk, _encoding, done) {
    const text = chunk.toString();
    process.stdout.write(maskedPrompt === undefined ? text : text.split(maskedPrompt).map(mask).join(maskedPrompt));
    done();
  },
});

async function question(prompt: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("This command is interactive; run it in a terminal.");
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    if (hidden) maskedPrompt = prompt;
    const answer = await rl.question(prompt);
    return answer.trim();
  } finally {
    maskedPrompt = undefined;
    rl.close();
  }
}

/** Asks until `validate` accepts the answer (it returns an error message, or nothing when fine). */
export async function ask(
  label: string,
  options: { default?: string; hidden?: boolean; validate?: (value: string) => string | undefined | Promise<string | undefined> } = {},
): Promise<string> {
  // Pasting into a hidden prompt doesn't work in every terminal, so an empty answer there reads the clipboard.
  const fromClipboard = options.hidden && !options.default && process.platform === "darwin";
  const hint = options.default ? (options.hidden ? "keep current" : options.default) : fromClipboard ? "paste, or copy it and press Enter" : "";
  const suffix = hint ? color("dim", ` (${hint})`) : "";
  for (;;) {
    let answer = (await question(`  ${label}${suffix}: `, options.hidden)) || options.default || "";
    if (!answer && fromClipboard) {
      answer = clipboard();
      if (answer) say.hint("Using what's on your clipboard.");
    }
    const problem = answer ? await options.validate?.(answer) : "Required.";
    if (!problem) return answer;
    say.warn(problem);
  }
}

function clipboard() {
  try {
    return execFileSync("pbpaste", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export async function confirm(label: string, defaultYes = true): Promise<boolean> {
  const answer = (await question(`  ${label} ${color("dim", defaultYes ? "[Y/n]" : "[y/N]")} `)).toLowerCase();
  return answer ? answer.startsWith("y") : defaultYes;
}

/** Numbered menu; returns the chosen value. */
export async function choose<T>(label: string, choices: { label: string; value: T }[]): Promise<T> {
  console.log(`  ${label}`);
  choices.forEach((c, i) => console.log(`    ${color("cyan", String(i + 1))}. ${c.label}`));
  const pick = await ask("Number", {
    validate: (v) => (Number(v) >= 1 && Number(v) <= choices.length ? undefined : `Pick 1–${choices.length}.`),
  });
  return choices[Number(pick) - 1].value;
}
