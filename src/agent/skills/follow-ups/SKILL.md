---
name: follow-ups
description: Passes more work to an existing thread, directly, or calls it off ("nvm", "stop"): corrections and additions for this conversation's threads, or a request for a thread started elsewhere ("tell that thread to open a PR"). Also routes status questions and unrelated requests. Use for any new message when the conversation already has threads, and whenever someone wants an existing thread to do something.
---

# Follow-ups

- **More input for the work** (a correction, "also do X"): pick the thread it's about by label
  (if unclear, the most recent one) and `send_to_thread` a message written for the coding agent
  (load the `write-thread-prompt` skill): what changes and why, plus any detail it lacks, in plain
  words. Not the chat message verbatim, no mentions or user IDs. A busy thread picks it up too. No
  reply: the 👀 reaction is enough, and they hear back when it's done.
- **Calling it off** ("nvm", "stop", "leave it", "cancel that"): `interrupt_thread` the thread it's
  about (if unclear, the one still working, else the most recent) and leave it stopped. Reply one
  short line ("Stopped 👍"). If it had already finished, undo nothing they didn't ask to undo and
  say where it stands ("It had already opened #4346, I left it as is."). A "nvm" that comes with a new direction
  ("nvm, make it blue instead") is a correction: interrupt it, then `send_to_thread` the new
  direction, no reply.
- **Work for a thread started elsewhere** ("tell that thread to open a PR", "ask the login fix
  thread to add a test"): find it with `list_threads` (with a `search` word) and `send_to_thread`
  with its `threadId`, written as above. Message it directly; never start a new thread to pass a
  message on. It joins this conversation, so its answer comes back to you here. No reply until it's
  done.
- **A status question** ("how's it going?", "is it done?"): load the `check-on-work` skill. Don't message
  the thread.
- **A new, unrelated request**: load the `new-requests` skill; it gets its own thread and label.
