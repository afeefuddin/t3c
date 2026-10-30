import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const run = (...args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], {
  encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
});

test("version flags print the installed version and exit successfully", () => {
  for (const flag of ["--version", "-v"]) {
    const result = run(flag);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, "");
  }
});

test("unknown flags produce a concise usage error instead of a Node stack trace", () => {
  for (const flag of ["--v", "--not-an-option"]) {
    const result = run(flag);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`Unknown option '${flag}'`));
    assert.match(result.stderr, /t3c --help/);
    assert.doesNotMatch(result.stderr, /node:internal|ERR_PARSE_ARGS|\n\s+at |file:\/\//);
    assert.ok(result.stderr.trim().split("\n").length <= 3);
  }
});

test("missing or wrongly typed option values also use the CLI error handler", () => {
  for (const args of [["--project"], ["--help=yes"]]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /t3c --help/);
    assert.doesNotMatch(result.stderr, /node:internal|ERR_PARSE_ARGS|\n\s+at |file:\/\//);
  }
});

test("help and command errors retain their existing behavior", () => {
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /t3c add instinct/);
  assert.match(help.stdout, /t3c agent claude/);
  assert.doesNotMatch(help.stdout, /github/i);
  assert.equal(help.stderr, "");
  const invalidRun = run("run");
  assert.equal(invalidRun.status, 1);
  assert.match(invalidRun.stderr, /Usage: t3c run/);
  assert.doesNotMatch(invalidRun.stderr, /node:internal|\n\s+at /);
});

test("GitHub connector commands are no longer available", () => {
  for (const command of ["add", "remove"]) {
    const result = run(command, "github", "owner/repo");
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Usage: t3c ${command} slack \\| http \\| instinct`));
    assert.doesNotMatch(result.stderr, /gh auth|not connected|node:internal/);
  }
});
