import type { Gateway, InboundMessage, Preparation } from "../src/gateway.ts";

/** Records replies and acknowledgements; prepare returns fixed context and worktree. */
export class FakeGateway implements Gateway {
  readonly name = "chat";
  replies: { conversationId: string; text: string }[] = [];
  acks: string[] = [];
  preparation: Preparation = { context: "bob: it 404s", worktree: { baseRef: "main", branch: "b" } };
  failPrepare = false;
  receive() {
    return {};
  }
  async prepare() {
    if (this.failPrepare) throw new Error("issue not found");
    return this.preparation;
  }
  async acknowledge(message: InboundMessage) {
    this.acks.push(message.eventKey);
  }
  async reply(conversationId: string, text: string) {
    this.replies.push({ conversationId, text });
  }
}

export const message = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  source: "chat",
  eventKey: "e1",
  conversationId: "conv-1",
  user: "alice",
  text: "fix the login bug",
  title: "fix the login bug",
  projects: ["demo"],
  ...overrides,
});
