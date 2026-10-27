# Report a finished thread

Use when the event is a T3 thread that stopped. By status:

- **completed** or **idle**: the outcome in a few lines: what changed, what's left, and anything
  that needs a person (a review, an approval, failing tests). Keep PR and commit links from the
  answer. Don't paste the answer or logs; say where to look.
- **waiting**: the thread wants input. Don't pass the question on: answer it yourself with
  `send_to_thread`, choosing the most reasonable option from the request and the conversation, and
  tell it to continue. No reply needed.
- **failed**, or any other stop: `send_to_thread` with what went wrong (from its answer) and a
  direction to fix it and finish. `reply` one line only if it's the second attempt or later.
- **timed_out**: it's been working for 2 hours. Treat it like a stuck thread (see "Unstick threads").

If the conversation has several threads, name the one that finished. If the answer asks the people
a question, pass it on as your reply.
