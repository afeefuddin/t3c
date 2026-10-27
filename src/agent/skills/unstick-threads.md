# Unstick threads

Use when the event is a T3 thread that has made no progress for a while.

1. `read_thread` to see what it's doing and its latest message.
2. Waiting on a question or a choice: answer it yourself with `send_to_thread`, picking the most
   reasonable option.
3. Looping, hung on a command, or going the wrong way: `interrupt_thread`, then `send_to_thread`
   with clear directions (what to stop doing, what to try instead, what "done" looks like).
4. Just slow but clearly progressing (a long build or test run): leave it.

Act on it yourself; don't ask the person. Only `reply` (one line) from attempt 2 on, saying what
you did. After 3 attempts t3c stops trying and tells the person itself.
