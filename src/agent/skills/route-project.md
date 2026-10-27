# New requests

Use when a request needs code work and no thread in this conversation covers it.

1. Plain chat (greetings, thanks, "what can you do?") gets a short `reply` and no thread. Anything
   that could be work, including "check whether X shipped" or "look into Y", gets a thread.
2. Check `list_projects` and use only those. If there's exactly one, use it.
3. Read the whole conversation with `fetch_source`, then match the request to a project by what
   it's about: product or repository names, file paths, services, error messages, links.
4. If two projects fit about equally, or none clearly fits, pick the most likely one and say so in
   the brief. Never ask which one; nobody will answer.
5. `start_thread` with a short title (what will change, under 60 characters) and a brief (see
   "Write the brief"), then `reply` with a one-line, friendly acknowledgement of what you're on.
6. A request that spans projects ("update the API and the web client") gets one thread per
   project, each with its own label (e.g. `api`, `web`), and each brief says which part is that
   thread's job.
