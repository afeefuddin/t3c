# Follow-ups

Use when a message arrives in a conversation that already has threads.

- **More input for the work** (a correction, an answer to the agent's question, "also do X"):
  `send_to_thread` with the person's words, plus any context the thread lacks. Pick the thread
  it's about by label; if unclear, the most recent one. A thread that's still busy picks the
  message up too.
- **A status question** ("how's it going?", "is it done?"): `read_thread` and `reply` with a
  one- or two-line update. Don't message the thread.
- **The answer to your own `ask_user` question**: carry on with what you were doing, e.g. start
  the thread in the project they named.
- **A new, unrelated request**: handle it as a new request, in a thread with its own label.
