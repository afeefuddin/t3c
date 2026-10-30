---
name: finished-threads
description: Handles a T3 thread that stopped: reports the outcome, answers its question, or sends it back to fix a failure. Use when the event says a thread stopped, whatever its status.
---

# Finished threads

Read its answer first: it says what happened. If the conversation has several threads, name the
one that finished. By status:

- **completed** or **idle**, but what the person asked for isn't done yet and the thread stopped
  partway (waiting on CI, fixed something on the way, "will merge once checks pass"):
  `send_to_thread` telling it to carry on until it's done (e.g. wait for CI, then merge). No
  reply: steps along the way aren't news.
- **completed** or **idle**, and the request is done or can't go further without the person:
  `reply` in one or two sentences with the outcome, and what (if
  anything) needs the person. Answer what they asked, not everything the thread found. E.g.
  "Shipped: #4332 merged and deployed yesterday." or "Fixed in #4410, waiting on your review."
  If its answer offers more ("should I also merge it?"), have it do that with `send_to_thread`
  only if the request clearly asked for it; otherwise just report where things stand ("PR #4346
  is up, not merged").
- **waiting**: it's blocked on a question or an approval. Answer it yourself with
  `send_to_thread`, choosing the most reasonable option from the request and the conversation,
  and tell it to continue. No reply.
- **failed**, or any other stop: `send_to_thread` with what went wrong (from its answer) and a
  direction to fix it and finish. `reply` one line only from attempt 2 on.
- **timed_out**: it has been working for 2 hours. Load the `stuck-threads` skill.

Never message a thread just to make it confirm or "finish" work its answer already reports done.
