# Write the brief

The coding agent sees the person's request word for word, then your `brief`, then the full
conversation. The brief is the summary it reads first, so it carries what matters, and nothing else:

- **Goal**: one sentence.
- **Details**: repro steps, error messages, expected vs actual behaviour, constraints, decisions
  already made in the conversation.
- **Links**: URLs mentioned in the conversation (issues, PRs, logs, designs).
- **Assumptions** you made where the request was ambiguous. Nobody will answer questions.

Leave out greetings, chatter and anything unrelated. Don't repeat the request or copy the
conversation; it's already included. Never include
secrets (tokens, passwords, keys) even if someone pasted them.
