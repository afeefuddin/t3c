# t3c

Start coding tasks in [T3 Code](https://github.com/pingdotgg/t3code) from Slack,
Instinct, or HTTP webhooks. t3c runs on the same machine as T3 Code.

## Requirements

- macOS or Linux, Git, and Node.js 24+.
- T3 Code running with a coding provider configured and the `t3` CLI on your PATH.
- [Tailscale](https://tailscale.com/download), signed in, with
  [Funnel enabled](https://tailscale.com/kb/1223/funnel) for Slack or Instinct.

## Install

```sh
git clone https://github.com/afeefuddin/t3c.git
cd t3c
npm ci
npm install -g .
```

Keep this folder: the installed command runs from it.

## Connect Slack

```sh
t3c setup
```

Follow the prompts to create a Slack app, enter its bot token and signing secret,
choose allowed people and projects, and start t3c. You need permission to install
apps in your Slack workspace.

Invite your bot to a channel and mention it with a task, or send it a DM.
Replies in the same Slack thread continue the task; answers are posted back there.
Run `t3c add slack` to change the other connection settings later.

## Choose projects

`t3c projects` shows every T3 project and whether Slack and Instinct may use it.
`t3c projects slack` (or `instinct`) opens a checklist: type numbers or names to switch them on or
off, then press Enter to save. `*` allows any project, including ones you add to T3 Code later.
For a one-liner, use `t3c projects slack add web-app` or `t3c projects slack remove web-app`.
Changes apply to the next message; t3c doesn't need a restart.

## Connect Instinct

```sh
t3c login
t3c add instinct
```

Choose the allowed projects. Setup starts or restarts t3c and verifies the public API.

Paste the generated setup prompt into your private Instinct chat. On macOS it is
copied to your clipboard; it is also saved to `~/.t3c/instinct.md`.
The prompt contains your API token, so keep it private. Instinct must support
HTTP requests with a bearer token. Have it list the allowed projects to confirm
the connection before sending a coding task.

## One agent across Slack, terminal and Instinct

To let Codex or Claude choose projects and handle follow-ups, install and log in to
its CLI, then run `t3c agent codex` or `t3c agent claude`.
Use `t3c agent off` to disable routing.

Run `t3c` to open a persistent terminal chat with that same agent. Ask what happened to work
you started in Slack, continue it from your computer, or start something new. Replies return
to the interface you're currently using. `/new` starts a fresh terminal chat; `/exit` leaves
the chat while work continues in the background. The terminal reconnects to the same daemon.
The terminal shows a scrollable conversation and live activity with elapsed time. Enter sends;
Alt+Enter inserts a newline. `/help` lists the controls. If a send is unconfirmed, `/retry` reuses
its delivery key without duplicating work.

Each routing run sees active work across its allowed projects, including threads started from
other conversations or in T3 Code. It can check an existing thread's progress and continue related
work instead of starting a duplicate. It can search and read earlier conversations across interfaces,
within the projects the current connection is allowed to use.
One conversation can have several coding threads; the router uses the chat history and saved notes
to interpret follow-ups and continue the relevant work.
Messages, summaries and thread mappings are saved in `~/.t3c/state.sqlite` (or `$T3C_HOME`).
Each agent run receives the conversation's notes and latest 30 messages; older conversations are
found through text search. This is stored history and retrieval, not one permanently running model session.

Without an agent, use `in:<project>` in Slack when several projects are allowed.
Instinct and HTTP use the same agent; a project can be specified or left for the agent to choose.

## Everyday commands

| Command | Purpose |
|---|---|
| `t3c` / `t3c chat` | Talk to the shared agent |
| `t3c status` | Check connections and public access |
| `t3c start` / `t3c stop` | Start or stop the background service |
| `t3c restart` | Apply configuration changes |
| `t3c logs -f` | Follow logs |
| `t3c messages` | See recent messages and work in progress |
| `t3c projects` | See and change which projects Slack and Instinct may use |
| `t3c model` | Choose the coding model |
| `t3c remove slack` / `t3c remove instinct` | Disconnect Slack or the shared Instinct/HTTP gateway |
| `t3c --help` | Show all commands |

Run `t3c start` after rebooting. Keep T3 Code running and the machine awake to
receive tasks. Settings and credentials live in `~/.t3c/`.

Coding tasks default to `auto-accept-edits`: file edits are allowed, but commands
need approval in T3 Code. `t3c mode` shows the current mode.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

[MIT](LICENSE). Independent project; not affiliated with T3 Code.
