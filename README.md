# t3c

Start T3 Code threads from Slack, GitHub and webhooks. t3c runs on the same
machine as T3 Code: mention the bot in Slack or comment `/t3c …` on a GitHub issue, and a T3 thread
starts on your laptop. The answer is posted back where you asked.

```
Slack / GitHub ──HTTPS──▶ Tailscale Funnel ──▶ t3c (127.0.0.1) ──▶ T3 Code ──▶ your agents
       ▲                    (only /hooks)                             │
       └──────────────────────── answer ◀─────────────────────────────┘
```

## Install

Requires Node 24+, T3 Code running with its `t3` CLI, and [Tailscale](https://tailscale.com) (for Slack and
GitHub).

```sh
npm install -g github:afeefuddin/t3c   # private repo: needs your GitHub access
```

## Set up

```sh
t3c login                     # connect to T3 Code and pick the model threads use
t3c add slack                 # guided: creates the Slack app, picks a channel and project
t3c add github owner/repo     # adds the webhook (uses your `gh` login)
t3c start                     # runs in the background
```

Each `add` step can be run again later to add another channel or repository.

| Command | |
|---|---|
| `t3c status` | what's running, connected and public |
| `t3c model` | change the model T3 threads use |
| `t3c logs -f` | follow what t3c is doing |
| `t3c messages [-n 20]` | what's in progress, and the latest messages in and out |
| `t3c restart` | apply config changes |
| `t3c stop` | stop t3c and turn Funnel off |
| `t3c remove slack [channel-id]` / `github <owner/repo>` / `http` | disconnect |
| `t3c add http` | an authenticated webhook for scripts and cron |

Config is stored in `~/.t3c/config.json` (readable only by you).

`t3c login` approves itself with a one-time pairing code from `t3 auth pairing create`, so no browser
is needed. T3's tokens last 30 days, and t3c logs in again the same way before its token expires.

## Using it

- **Slack:** `@t3bot fix the login redirect` in a connected channel starts a thread. Pick "every
  channel the bot is invited to" in `t3c add slack` and inviting the bot is all a new channel needs. Replies in the
  Slack thread are sent to the same T3 thread. If you mention the bot inside an existing Slack
  thread, the earlier messages are included as context.
- **GitHub:** `/t3c fix this` on an issue starts a thread on branch `t3c/issue-<n>`. On a pull
  request, the agent works on the PR's branch. Later `/t3c` comments are follow-ups.

## AI agent (optional)

```sh
t3c agent codex      # Codex decides what to do with each message
t3c agent off        # back to fixed rules
```

Without the agent, fixed rules apply:
- **New conversation:** a thread starts in the channel's project. If a channel allows several
  projects, start your message with `in:<project>`.
- **Follow-ups** go to the latest thread.
- **Answers** are posted back unchanged.

With `t3c agent codex`, each event wakes Codex once, with tools scoped to that conversation.
Events are a new message, or a T3 thread that finished.
- **Starting work:** it reads the Slack thread or issue, picks the project, and writes the
  thread a self-contained prompt: the task, what's known, links, and what done means. No chat
  transcript, user IDs or mentions.
- **Worktrees:** ask for one ("do it in a new worktree") and the thread gets its own checkout on a
  new `t3c/…` branch from the latest default branch; otherwise it runs in the project's folder.
  GitHub issues and PRs always get their own worktree.
- **Choosing threads:** it can start several threads (one per project). When it's unclear which
  project you mean, it picks the likeliest and says so.
- **Answering:** status questions get a short reply without disturbing the thread. It can also
  look at every active thread in the projects the channel allows (including ones you started in
  T3 Code), so "what's running?" or "is anyone on the login bug?" gets a one-line answer. When a thread
  finishes, it posts a short summary.
- **Looking after threads:** finished threads are settled in T3. A thread that waits for input, fails,
  or makes no progress for 15 minutes is unblocked by the agent (it answers, redirects or restarts
  it); after 3 tries without progress you're told once.

Its behaviour comes from **skills** in the [Agent Skills](https://agentskills.io) format: a folder
per skill with a `SKILL.md` that has `name` and `description` frontmatter and the instructions.
Built-in ones live in [`src/agent/skills`](src/agent/skills): new requests, follow-ups, checking on
work, finished and stuck threads, and writing the thread prompt. Each run's prompt lists only the
names and descriptions; the agent loads the instructions it needs with `load_skill`, and every load
shows in the run log.

Built-in skills are always the latest shipped version. To change one, add a folder with the same
name to `~/.t3c/skills`; any other folder there adds a skill. Edits apply from the next run.

Codex keeps your provider, model and login, but t3c's runs are locked down:
- read-only sandbox
- no shell or other built-in tools
- none of your own MCP servers, hooks or memories

Its only way to act is through t3c's tools, which allow only that conversation and its allowed
projects, at most 3 replies and 3 threads per run. If Codex fails before doing anything, the fixed
rules take over.

Everything is stored in `~/.t3c/state.sqlite`:
- every conversation, with its messages in both directions
- the T3 threads attached to it
- the agent's summary notes
- each agent run, with its tool calls

## Safety

t3c receives messages from the internet and turns them into agent work on your machine, so:

- **Only `/hooks` is public.** It goes through Tailscale Funnel on port 10000
  (Slack can't reach Funnel's other spare port, 8443). t3c itself listens
  only on 127.0.0.1.
- **Every request is verified.** Slack and GitHub requests must carry a valid signature (Slack's
  must also be under 5 minutes old). HTTP requests need a 32+ character bearer secret.
- **Only people you allow can start work.**
  - Slack: users on your allowlist.
  - GitHub: users on your allowlist who also have write access to the repo.
  - Everyone else is ignored. Pull requests from forks are refused.
- **Threads run as `auto-accept-edits`.** File edits go ahead, but commands need your approval in
  T3 Code. Run `t3c mode full-access` (then `t3c restart`) for more autonomy.
- **Conversation text is marked as untrusted.** Earlier messages and issue text are passed to the
  agent inside a fence that says not to follow instructions found there.

## Develop

```sh
npm install
npm test
npm run typecheck
npm run t3c -- status   # run from source
```
