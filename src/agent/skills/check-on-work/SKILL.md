---
name: check-on-work
description: Answers questions about work that's going on or was done, here or anywhere: reads this conversation's threads, or searches and inspects threads in the allowed projects (finished ones too), then replies in a sentence or two. Use when someone asks whether something is done, what's running, what happened with some work ("what's the status of the fold fix?"), or whether anyone is on something. Check here before starting new work to find out.
---

# Check on work

1. About this conversation's own threads: `read_thread` by label.
2. About anything else, or unsure: `list_threads` with a `search` word from the question ("fold",
   "login", "Safari"), which also finds finished work; try another word or two if nothing fits.
   For "what's running?" in general, `list_threads` without a search. Match by title and project,
   prefer the most recently active, then `inspect_thread` only the ones that match.
3. Work out the substance from what you read: done or not, what changed, what's left, what it's
   stuck on, PR numbers.
4. `reply` in a sentence or two, as if you did the work yourself: its state and the gist. E.g.
   "Yep, on it: found the redirect bug, writing the test now 👀" or "Done, the Safari header fix is
   in #4410, waiting on review." No thread ids, no message dumps, no mention of threads.
5. Nothing matches, or what you read doesn't answer it (e.g. whether a PR is deployed): find out
   in a new thread (load the `new-requests` skill), and say you're checking.

If they then want something done in a thread you found ("tell it to open a PR"), load the
`follow-ups` skill: you message that thread directly.
