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

Requires Node 24+, T3 Code running, and [Tailscale](https://tailscale.com) (for Slack and GitHub).

```sh
npm install -g github:afeefuddin/t3c   # private repo: needs your GitHub access
```

## Set up

```sh
t3c login                     # approve t3c in T3 Code
t3c add slack                 # guided: creates the Slack app, picks a channel and project
t3c add github owner/repo     # adds the webhook (uses your `gh` login)
t3c start                     # runs in the background
```

Each `add` step can be run again later to add another channel or repository.

| Command | |
|---|---|
| `t3c status` | what's running, connected and public |
| `t3c logs -f` | follow what t3c is doing |
| `t3c restart` | apply config changes |
| `t3c stop` | stop t3c and turn Funnel off |
| `t3c remove slack [channel-id]` / `github <owner/repo>` / `http` | disconnect |
| `t3c add http` | an authenticated webhook for scripts and cron |

Config is stored in `~/.t3c/config.json` (readable only by you).

## Using it

- **Slack:** `@t3bot fix the login redirect` in a connected channel starts a thread. Replies in the
  Slack thread are sent to the same T3 thread. If you mention the bot inside an existing Slack
  thread, the earlier messages are included as context.
- **GitHub:** `/t3c fix this` on an issue starts a thread on branch `t3c/issue-<n>`. On a pull
  request, the agent works on the PR's branch. Later `/t3c` comments are follow-ups.

## Safety

t3c receives messages from the internet and turns them into agent work on your machine, so:

- **Only `/hooks` is public.** It goes through Tailscale Funnel on port 8443. t3c itself listens
  only on 127.0.0.1.
- **Every request is verified.** Slack and GitHub requests must carry a valid signature (Slack's
  must also be under 5 minutes old). HTTP requests need a 32+ character bearer secret.
- **Only people you allow can start work.**
  - Slack: users on your allowlist.
  - GitHub: users on your allowlist who also have write access to the repo.
  - Everyone else is ignored. Pull requests from forks are refused.
- **Threads run as `auto-accept-edits`.** File edits go ahead, but commands need your approval in
  T3 Code. Change `runtimeMode` in the config if you want more autonomy.
- **Conversation text is marked as untrusted.** Earlier messages and issue text are passed to the
  agent inside a fence that says not to follow instructions found there.

## Develop

```sh
npm install
npm test
npm run typecheck
npm run t3c -- status   # run from source
```
