import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { ChatClient, ChatSession, type ChatSnapshot } from "../src/terminal.ts";
import { ChatView } from "../src/terminal-view.ts";

class TestTerminal implements Terminal {
  columns = 90;
  rows = 24;
  kittyProtocolActive = false;
  output = "";
  input!: (data: string) => void;
  resize!: () => void;
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {}
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

const empty = (): ChatSnapshot => ({ messages: [], pending: false, activity: null });
function screen(view: ChatView) {
  view.tui.renderNow();
  return view.tui.getScreenLines().map(stripTerminalSequences).join("\n");
}

test("waiting is visible, and an arriving reply preserves the multiline draft and composer", (t) => {
  const terminal = new TestTerminal();
  const submitted: string[] = [];
  const view = new ChatView(terminal, (text) => submitted.push(text), () => {}, "codex");
  t.after(() => view.stop());
  view.update({ ...empty(), messages: [{ id: "q", direction: "in", text: "Timer status?", status: "processing" }], pending: true,
    activity: { phase: "thinking", since: new Date(Date.now() - 24_000).toISOString() } });
  view.start();
  let rendered = screen(view);
  assert.match(rendered, /Thinking.*24s/);
  assert.match(rendered, /Timer status\?/);
  terminal.input("Please include");
  terminal.input("\x1b\r"); // Alt+Enter, a newline rather than submit.
  terminal.input("the file paths");
  assert.deepEqual(submitted, []);
  assert.equal(view.editor.getText(), "Please include\nthe file paths");
  view.update({ ...empty(), messages: [
    { id: "q", direction: "in", text: "Timer status?", status: "done" },
    { id: "a", direction: "out", text: "**Complete.** No PR opened.\n\n- 80 tests passed", status: "sent" },
  ] });
  rendered = screen(view);
  assert.equal(view.editor.getText(), "Please include\nthe file paths");
  assert.match(rendered, /Complete\. No PR opened/);
  assert.match(rendered, /80 tests passed/);
  assert.match(rendered, /Ready/);
  assert.match(rendered, /Please include/);
  assert.doesNotMatch(rendered, /\*\*Complete/);
  terminal.input("\r");
  assert.deepEqual(submitted, ["Please include\nthe file paths"]);
});

test("paste, reconnects, and resizing keep the editor usable; control sequences cannot erase it", (t) => {
  const terminal = new TestTerminal();
  const submitted: string[] = [];
  const view = new ChatView(terminal, (text) => submitted.push(text), () => {}, "codex");
  t.after(() => view.stop());
  view.update(empty()); view.start();
  terminal.input("\x1b[200~first line\nsecond line\x1b[201~");
  assert.deepEqual(submitted, []);
  assert.equal(view.editor.getText(), "first line\nsecond line");
  view.disconnected("daemon unavailable");
  assert.match(screen(view), /Connection lost/);
  view.update({ ...empty(), messages: [{ id: "a", direction: "out", text: "\x1b[2JResult ✅ " + "long text ".repeat(60), status: "sent" }] });
  terminal.columns = 36; terminal.rows = 14; terminal.resize();
  let rendered = screen(view);
  assert.equal(view.tui.getScreenLines().length, 14);
  assert.doesNotMatch(rendered, /Connection lost/);
  assert.match(rendered, /first line/);
  assert.equal(view.editor.getText(), "first line\nsecond line");
  terminal.columns = 110; terminal.rows = 32; terminal.resize();
  rendered = screen(view);
  assert.match(rendered, /Result ✅/);
  assert.match(rendered, /second line/);
});

test("reopening a chat restores input history and leaving preserves replies in terminal scrollback", () => {
  const terminal = new TestTerminal();
  const view = new ChatView(terminal, () => {}, () => {}, "codex");
  view.update({ ...empty(), messages: [
    { id: "q", direction: "in", text: "Timer status?", status: "done" },
    { id: "a", direction: "out", text: "80 tests passed. No PR opened.", status: "sent" },
  ] });
  view.start(); screen(view);
  terminal.input("\x1b[A");
  assert.equal(view.editor.getText(), "Timer status?");
  terminal.output = "";
  view.stop();
  assert.match(stripTerminalSequences(terminal.output), /80 tests passed/);
  assert.match(stripTerminalSequences(terminal.output), /Timer status\?/);
});

test("a late response from an old session never appears after /new", async (t) => {
  const terminal = new TestTerminal();
  const view = new ChatView(terminal, () => {}, () => {}, "codex");
  t.after(() => view.stop());
  view.update(empty()); view.start();
  let resolve!: (snapshot: ChatSnapshot) => void;
  const old = new ChatClient("http://unused", "token", "old");
  old.snapshot = () => new Promise((done) => { resolve = done; });
  const fresh = new ChatClient("http://unused", "token", "fresh");
  fresh.snapshot = async () => empty();
  const session = new ChatSession(old, view, () => fresh, () => {});
  const refresh = session.refresh();
  await session.submit("/new");
  resolve({ ...empty(), messages: [{ id: "old", direction: "out", text: "OLD SECRET RESPONSE", status: "sent" }] });
  await refresh;
  assert.doesNotMatch(screen(view), /OLD SECRET/);
  await session.refresh();
  assert.match(screen(view), /Ready/);
  session.stop();
});

test("/retry reuses its delivery key without disturbing the draft", async (t) => {
  const terminal = new TestTerminal();
  const view = new ChatView(terminal, () => {}, () => {}, "codex");
  t.after(() => view.stop());
  const initial = empty();
  view.update(initial); view.start();
  const client = new ChatClient("http://unused", "token", "session");
  client.snapshot = async () => initial;
  const sends: { text: string; key: string | undefined }[] = [];
  client.send = async (text, key) => {
    sends.push({ text, key });
    if (sends.length === 1) throw new Error("network timeout");
    return { accepted: true, messageId: "q" };
  };
  const session = new ChatSession(client, view, () => client, () => {}, initial);
  view.editor.setText("draft stays here");
  await session.submit("timer status");
  assert.match(screen(view), /Send not confirmed/);
  assert.equal(view.editor.getText(), "draft stays here");
  await session.submit("/retry");
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0], sends[1]);
  session.stop();
});
