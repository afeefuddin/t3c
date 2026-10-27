# Write the brief

The coding agent sees the person's request word for word, then your `brief`. It has the repository
but not the conversation, so the brief carries what it needs from there, and nothing else:

- **Goal**: one sentence.
- **Details**: repro steps, error messages, expected vs actual behaviour, constraints, decisions
  already made in the conversation.
- **Links**: URLs mentioned in the conversation (issues, PRs, logs, designs).
- **Open questions**, if any. The agent can't ask the people directly.

Leave out greetings, chatter and anything unrelated. Don't repeat the request. Never include
secrets (tokens, passwords, keys) even if someone pasted them.
