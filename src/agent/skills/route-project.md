# New requests

Use when a request needs code work and no thread in this conversation covers it.

1. Not every message is work. A question you can answer from the conversation, or plain chat, gets
   a short `reply` and no thread.
2. Check `list_projects` and use only those. If there's exactly one, use it.
3. Match the request to a project by what it's about: product or repository names, file paths,
   services, error messages, links. If the latest message alone is unclear, read the whole
   conversation with `fetch_source`.
4. If two projects fit about equally, or none clearly fits, don't guess. `ask_user` with a short
   question naming the candidates ("Is this for web-app or api?") and stop. The answer arrives as a
   new message.
5. `start_thread` with a short title (what will change, under 60 characters) and a brief (see
   "Write the brief").
6. A request that spans projects ("update the API and the web client") gets one thread per
   project, each with its own label (e.g. `api`, `web`), and each brief says which part is that
   thread's job.
