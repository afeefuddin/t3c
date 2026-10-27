# Follow-ups

Use when a message arrives in a conversation that already has threads.

- **More input for the work** (a correction, "also do X"):
  `send_to_thread` with a message written for the coding agent, and `reply` with a quick "got it"
  line. Like the first prompt (see "Write the thread prompt"), say what changes and why, with any
  detail the thread lacks, in plain words: not the chat message verbatim, no mentions or user IDs.
  Pick the thread it's about by label; if unclear, the most recent one. A thread that's still busy
  picks the message up too.
- **A status question** ("how's it going?", "is it done?"): `read_thread` and `reply` with a
  one-sentence update. Don't message the thread.
- **A new, unrelated request**: handle it as a new request, in a thread with its own label.
