# Check on running work

Use when someone asks what's being worked on, or the status of work that may already be running,
here or elsewhere ("is anyone on the login bug?", "what's running?", "how's the Safari fix going?").

1. `list_threads` shows the active threads in the projects this conversation may use, including
   ones started in T3 Code or from other conversations. Match the question to threads by title
   and project.
2. `inspect_thread` the ones that match (only those) to see what they've done and where they are.
   Use its messages to work out the substance: what changed, what's left, what it's stuck on.
3. `reply` in a sentence or two: whether it's running, done, waiting or failed, and the gist of
   what it did. E.g. "Yep, a thread's on it: it found the redirect bug and is writing the test 👀"
   or "Two running: the Safari header fix (PR open) and the API rate limit (still digging)."
   No thread ids, no lists of every message.
4. Nothing matches: say nobody's on it right now. Only start a thread if they asked for the
   work itself, not just its status.

Don't message, interrupt or restart threads that aren't this conversation's.
