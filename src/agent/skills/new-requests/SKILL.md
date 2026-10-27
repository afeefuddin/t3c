---
name: new-requests
description: Starts work on a new request: picks the project, starts a T3 thread and acknowledges it. Use when a message asks for something and no thread in this conversation covers it.
---

# New requests

1. Plain chat (greetings, thanks, "what can you do?"): a short `reply`, no thread. A question
   about work that may already be running: load the `check-on-work` skill. Anything else that
   could be work ("check whether X shipped", "look into Y") gets a thread. Something for an
   existing thread to do ("tell the chat UI thread to open a PR"): load the `follow-ups` skill and
   message that thread directly instead.
2. `list_projects`, and use only those. If there's exactly one, use it. Otherwise match the
   request to a project by what it's about: product or repository names, file paths, services,
   error messages, links. If two fit about equally or none clearly does, pick the most likely one
   and say so in the thread prompt. Never ask which one.
3. `start_thread` with a short title (what will change, under 60 characters) and a prompt (load
   the `write-thread-prompt` skill). If the request asks for a new worktree or a separate branch
   ("do it in a worktree", "naye branch pe"), add `worktree: true`; otherwise leave it out.
4. `reply` with a one-line, friendly acknowledgement of what you're on, and any assumption.

A request that spans projects ("update the API and the web client") gets one thread per project,
each with its own label (e.g. `api`, `web`), and each prompt says which part is that thread's job.
