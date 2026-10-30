---
name: stuck-threads
description: Gets a stuck T3 thread moving again: answers it, or interrupts and redirects it. Use when the event says a thread made no progress for a while, or a thread timed out.
---

# Stuck threads

1. `read_thread` to see what it's doing and its latest message.
2. Waiting on a question or a choice: answer it yourself with `send_to_thread`, picking the most
   reasonable option.
3. Looping, hung on a command, or going the wrong way: `interrupt_thread`, then `send_to_thread`
   with clear directions: what to stop doing, what to try instead, what "done" looks like.
4. Slow but clearly progressing (a long build or test run): leave it.

Act on it yourself; don't ask the person. `reply` (one line, saying what you did) only from
attempt 2 on. After 3 attempts t3c stops trying and tells the person itself.
