import { styleText } from "node:util";

type Level = "info" | "ok" | "warn" | "error";
const STYLE = { info: "cyan", ok: "green", warn: "yellow", error: "red" } as const;

/**
 * One line per event, e.g. `12:04:01 slack   ← <@U1> in C1: fix the login bug`.
 * Colors only on a terminal; the background service writes plain lines to ~/.t3c/t3c.log.
 */
export function log(scope: string, message: string, level: Level = "info") {
  const time = new Date().toTimeString().slice(0, 8);
  const tag = scope.padEnd(7);
  const line = `${time} ${color(STYLE[level], tag)} ${message}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Shortens user text for log lines. */
export function preview(text: string, max = 80) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function color(style: Parameters<typeof styleText>[0], text: string) {
  return process.stdout.isTTY ? styleText(style, text) : text;
}
