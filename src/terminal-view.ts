import {
  Container, Editor, Markdown, ScrollView, Text, TruncatedText, TuiAltScreen, VStack,
  matchesKey, stripTerminalSequences, type MarkdownTheme, type Terminal,
} from "@earendil-works/pi-tui";
import type { ChatSnapshot } from "./terminal.ts";

const style = (code: number) => (text: string) => process.env.NO_COLOR !== undefined ? text : `\x1b[${code}m${text}\x1b[0m`;
const dim = style(90), accent = style(36), bold = style(1), warning = style(33);
const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const theme: MarkdownTheme = {
  heading: bold, link: accent, linkUrl: dim, code: accent, codeBlock: (s) => s,
  codeBlockBorder: dim, quote: dim, quoteBorder: dim, hr: dim, listBullet: accent,
  bold, italic: style(3), strikethrough: style(9), underline: style(4),
};

/** One renderer owns the transcript AND editor, so replies never overwrite a draft. */
export class ChatView {
  readonly tui: TuiAltScreen;
  readonly editor: Editor;
  private readonly transcript = new Container();
  private readonly scroll: ScrollView;
  private readonly status = new Container();
  private snapshot: ChatSnapshot = { messages: [], pending: false, activity: null };
  private fingerprint = "";
  private notices: { title: string; text: string }[] = [];
  private sendingSince: number | undefined;
  private connectionError: string | undefined;
  private stopped = false;
  private historyLoaded = false;

  constructor(terminal: Terminal, onSubmit: (text: string) => void, onExit: () => void, provider: string) {
    this.tui = new TuiAltScreen(terminal, true, undefined, { copyOnSelect: false });
    this.editor = new Editor(this.tui, {
      borderColor: dim,
      selectList: { selectedPrefix: accent, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim },
    }, { paddingX: 1 });
    this.editor.onSubmit = (text) => {
      if (!text.trim()) return;
      this.editor.addToHistory(text);
      onSubmit(text.trim());
    };
    this.scroll = new ScrollView(this.transcript, { follow: "end", primary: true, scrollbar: "auto" });
    this.tui.setLayoutRoot(new VStack([
      new TruncatedText(`${bold("T3C")}  ${dim("·")}  ${clean(provider)}  ${dim("· shared across Slack, Instinct & terminal")}`, 1),
      new TruncatedText(dim("Ask about earlier work, continue a task, or start something new."), 1),
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
      this.status,
      { component: this.editor, basis: "auto", shrink: 1, minSize: 3, maxSize: 10 },
      new TruncatedText(dim("Enter send  ·  Alt+Enter newline  ·  /help  ·  Ctrl+C exit"), 1),
    ]));
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c") || (matchesKey(data, "ctrl+d") && !this.editor.getText())) {
        onExit();
        return { consume: true };
      }
      return undefined;
    });
  }

  start() { this.tui.start(); }
  stop() {
    this.stopped = true;
    // Leave the complete conversation in normal terminal scrollback, without the empty editor.
    this.tui.setLayoutRoot(this.transcript);
    this.tui.stop();
  }

  update(snapshot: ChatSnapshot) {
    if (this.stopped) return;
    this.snapshot = snapshot;
    if (!this.historyLoaded) {
      for (const message of snapshot.messages) if (message.direction === "in") this.editor.addToHistory(message.text);
      this.historyLoaded = true;
    }
    this.connectionError = undefined;
    const fingerprint = JSON.stringify(snapshot.messages);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.rebuild();
    }
    this.tick();
  }

  sending(active: boolean) {
    this.sendingSince = active ? Date.now() : undefined;
    // Only the network submission is serialized. Drafting/follow-ups remain available while thinking.
    this.editor.disableSubmit = active;
    this.tick();
  }

  disconnected(message: string) { this.connectionError = clean(message); this.tick(); }

  notice(title: string, text: string) {
    if (this.stopped) return;
    this.notices.push({ title, text });
    this.rebuild();
    this.scroll.scrollToEnd();
    this.tui.requestRender();
  }

  reset() {
    this.notices = [];
    this.fingerprint = "";
    this.update({ messages: [], pending: false, activity: null });
    this.scroll.scrollToEnd();
  }

  tick() {
    if (this.stopped) return;
    let text = dim("● Ready");
    const activity = this.snapshot.activity;
    if (activity || this.sendingSince) {
      const since = this.sendingSince ?? Date.parse(activity!.since);
      const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
      const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      let label = "Sending";
      if (!this.sendingSince && activity) {
        switch (activity.phase) {
          case "queued": label = "Queued"; break;
          case "thinking": label = "Thinking"; break;
          case "working": label = "Working"; break;
        }
      }
      const detail = activity?.phase === "working" && activity.title ? ` · ${clean(activity.title)}` : "";
      const spinner = ["◐", "◓", "◑", "◒"][Math.floor(Date.now() / 250) % 4];
      text = `${accent(spinner)} ${label} ${dim(`· ${elapsed}${detail} · you can keep typing`)}`;
    }
    if (this.connectionError) text = warning(`! Connection lost · retrying · ${this.connectionError}`);
    this.status.clear();
    this.status.addChild(new TruncatedText(text, 1));
    this.tui.requestRender();
  }

  private rebuild() {
    this.transcript.clear();
    if (this.snapshot.messages.length === 0 && this.notices.length === 0) {
      this.transcript.addChild(new Text(dim('Try “What’s the status of the timer changes?”\nor “What work is still in progress?”'), 1, 1));
    }
    for (const message of this.snapshot.messages) {
      const incoming = message.direction === "in";
      this.transcript.addChild(new Text(incoming ? dim("You") : accent(bold("T3C")), 1, 0));
      this.transcript.addChild(incoming
        ? new Text(clean(message.text), 1, 1)
        : new Markdown(clean(message.text), 1, 1, theme));
      if (message.status === "failed") this.transcript.addChild(new Text(warning("This message could not be processed. Send a follow-up to try again."), 1, 0));
    }
    for (const notice of this.notices) {
      this.transcript.addChild(new Text(dim(clean(notice.title)), 1, 0));
      this.transcript.addChild(new Markdown(clean(notice.text), 1, 1, theme));
    }
  }
}
