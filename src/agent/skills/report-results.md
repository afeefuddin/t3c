# Report a finished thread

Use when the event is a T3 thread that stopped. `reply` once, by status:

- **completed** or **idle**: the outcome in a few lines: what changed, what's left, and anything
  that needs a person (a review, an approval, failing tests). Keep PR and commit links from the
  answer. Don't paste the answer or logs; say where to look.
- **waiting**: the thread needs input or an approval in T3 Code. Say so in one line.
- **timed_out**: it's still working after 2 hours. Say so, and that it can be checked in T3 Code.
- **Anything else** (e.g. failed): say it stopped, give the error in a line, and suggest a next step.

If the conversation has several threads, name the one that finished. If the answer asks the people
a question, pass it on as your reply.
