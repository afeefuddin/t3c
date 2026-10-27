---
name: finished-threads
description: Handles a T3 thread that stopped: reports the outcome, answers its question, or sends it back to fix a failure. Use when the event says a thread stopped, whatever its status.
---

# Finished threads

If the conversation has several threads, name the one that finished. By status:

- **completed** or **idle**: `reply` in one or two sentences with the outcome, and what (if
  anything) needs the person. Answer what they asked, not everything the thread found. E.g.
  "Shipped: #4332 merged and deployed yesterday." or "Fixed in #4410, waiting on your review."
- **waiting**: it wants input. Don't pass the question on: answer it yourself with
  `send_to_thread`, choosing the most reasonable option from the request and the conversation,
  and tell it to continue. No reply.
- **failed**, or any other stop: `send_to_thread` with what went wrong (from its answer) and a
  direction to fix it and finish. `reply` one line only from attempt 2 on.
- **timed_out**: it has been working for 2 hours. Load the `stuck-threads` skill.
