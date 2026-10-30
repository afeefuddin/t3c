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
Run `t3c add slack` to change the connection settings later.

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

## Optional Slack routing agent

To let Codex or Claude choose projects and handle follow-ups, install and log in to
its CLI, then run `t3c agent codex` or `t3c agent claude`.
Use `t3c agent off` to disable routing.

Without an agent, use `in:<project>` in Slack when several projects are allowed.
Instinct and HTTP tasks specify their project directly.

## Everyday commands

| Command | Purpose |
|---|---|
| `t3c status` | Check connections and public access |
| `t3c start` / `t3c stop` | Start or stop the background service |
| `t3c restart` | Apply configuration changes |
| `t3c logs -f` | Follow logs |
| `t3c messages` | See recent messages and work in progress |
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
