# claude-remote

Control Claude Code from your phone. It mirrors your terminal session to a Discord channel — you can read what Claude's doing, send messages, approve tool calls, attach images, all from Discord.

I built this because I kept kicking off long Claude tasks and then leaving my desk. Couldn't check progress or approve permissions without walking back to the terminal. Now I just check Discord.

## What it looks like

![Preview](assets/preview.png)

When enabled, each Claude session gets its own Discord channel. Messages, tool calls, diffs, and errors stream in as rich embeds. You interact through buttons and typing:

- Tool calls show up with Allow / Deny buttons
- File edits render as syntax-highlighted diffs
- Long outputs go into threads so the channel stays readable
- Read/Grep/Glob calls get batched into a single grouped thread
- MCP tool calls are grouped by server with a live "Querying..." indicator
- Tasks get a pinned board with a progress bar
- If Claude is busy, your messages queue up and execute in order
- Send raw keypresses with `/key` when prompts get stuck

## Setup

You need Windows (macOS/Linux not supported yet), Node 18+, and a Discord bot.

### Creating the bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot tab → copy token
2. Enable **Message Content Intent** under Privileged Gateway Intents
3. OAuth2 → URL Generator → select `bot` scope → permissions: Send Messages, Manage Channels, Read Message History, Manage Threads
4. Open the URL to invite it to your server

### Install and configure

```bash
npm install -g @hoangvu12/claude-remote
claude-remote setup
```

Setup walks you through entering your bot token, picking your server, and installing the hooks/statusline into Claude Code. It can also set up a `claude` shell alias so you don't have to type `claude-remote` every time.

## Usage

```bash
claude-remote            # starts Claude Code with the remote wrapper
claude-remote --remote   # start with Discord sync auto-enabled
claude-remote --resume   # all args pass through to claude
claude-remote -p "fix the login bug"
```

### Auto-remote

Skip `/remote on` every time — auto-enable Discord sync on start:

```bash
claude-remote auto       # toggle auto-remote on/off
```

Or use `--remote` flag for a one-off: `claude-remote --remote`

### Toggle sync inside a session

```
/remote               # toggle on/off
/remote on            # enable
/remote off           # disable
/remote on my-session # enable with a custom channel name
/remote status        # print current state
```

### Discord commands

Once connected, you get slash commands in the channel:

| Command | What it does |
|---------|-------------|
| `/mode <mode>` | Switch permission mode |
| `/status` | Session info and current state |
| `/stop` | Interrupt Claude |
| `/restart` | Restart Claude CLI (same args, fresh process) |
| `/clear` | Clear context, start fresh |
| `/compact [instructions]` | Trigger context compaction |
| `/model <model>` | Switch Claude model (sonnet/opus/haiku) |
| `/key <keys>` | Send raw keypresses (e.g. `enter`, `up down enter`, `ctrl+c`) |
| `/queue view\|clear\|remove\|edit` | Manage queued messages |

You can also just type in the channel to send messages to Claude, or attach images.

## How it works

`claude-remote` spawns `claude.exe` in a PTY and runs a named pipe server alongside it. When you enable sync, a daemon process connects to Discord and starts tailing the JSONL session file that Claude writes to.

New lines get parsed and routed through a handler pipeline — different handlers deal with tool calls, file edits, tasks, plan mode, etc. Each handler decides whether to render inline or in a thread.

User input from Discord flows back through IPC to the PTY as simulated keystrokes.

```
Terminal                Named Pipe              Discord
+-----------+          +----------+            +----------+
| claude.exe| <-PTY-> | rc.ts    | <--fork--> | daemon.ts|
+-----------+          +----------+    IPC     +----------+
                            ^                       |
                            |                       v
                       JSONL watcher          Discord channel
                       (transcript)           (embeds, buttons)
```

## Provider abstraction

Discord is the only provider right now, but the codebase has a provider interface (`src/provider.ts`) so adding Telegram, Slack, etc. shouldn't require touching the core logic. PRs welcome if you want to take a crack at it.

## Uninstall

```bash
claude-remote uninstall
npm uninstall -g @hoangvu12/claude-remote
```

## License

MIT
