import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  Events,
  type Client,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { DiscordProvider } from "./providers/discord.js";
import type { SessionContext } from "./handler.js";
import type { PtyWriteMessage } from "./types.js";
import { ActivityManager, STATUS_LABELS, type ActivityState } from "./activity.js";
import { modeShiftTabCount, getModeCycle, isModeReachable, MODE_LABELS, ID_PREFIX } from "./utils.js";
import { COLOR } from "./discord-renderer.js";

export interface SlashCommandDeps {
  getCtx: () => SessionContext | null;
  activity: ActivityManager;
  sendToClient: (msg: Omit<PtyWriteMessage, "sessionKey">) => void;
  restart: () => void;
  provider: DiscordProvider;
  projectDir: string;
  sessionId: string;
  channelId: string;
}

/** Returns a cleanup function that removes the InteractionCreate listener */
export async function setupSlashCommands(
  client: Client,
  guildId: string,
  deps: SlashCommandDeps,
  skipRegistration = false,
): Promise<() => void> {
  const commands = [
    new SlashCommandBuilder()
      .setName("mode")
      .setDescription("Switch Claude Code permission mode")
      .addStringOption((opt) =>
        opt.setName("mode")
          .setDescription("Target permission mode")
          .setRequired(true)
          .addChoices(
            { name: "Default", value: "default" },
            { name: "Accept Edits", value: "acceptEdits" },
            { name: "Plan Mode", value: "plan" },
            { name: "Bypass Permissions", value: "bypassPermissions" },
          )
      ),
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Clear Claude Code context (starts new conversation)"),
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show current session info"),
    new SlashCommandBuilder()
      .setName("compact")
      .setDescription("Trigger context compaction")
      .addStringOption((opt) =>
        opt.setName("instructions")
          .setDescription("Optional instructions for compaction")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Switch Claude model")
      .addStringOption((opt) =>
        opt.setName("model")
          .setDescription("Target model")
          .setRequired(true)
          .addChoices(
            { name: "Sonnet", value: "sonnet" },
            { name: "Sonnet 1M", value: "sonnet[1m]" },
            { name: "Opus", value: "opus" },
            { name: "Opus 1M", value: "opus[1m]" },
            { name: "Opus Plan (opus for plan, sonnet for execution)", value: "opusplan" },
            { name: "Haiku", value: "haiku" },
            { name: "Best (auto-select)", value: "best" },
          )
      ),
    new SlashCommandBuilder()
      .setName("stop")
      .setDescription("Interrupt Claude (like pressing Escape)"),
    new SlashCommandBuilder()
      .setName("restart")
      .setDescription("Restart the Claude CLI session (same args, fresh process)"),
    new SlashCommandBuilder()
      .setName("key")
      .setDescription("Send raw keypresses to Claude CLI")
      .addStringOption((opt) =>
        opt.setName("keys")
          .setDescription("Space-separated keys: enter, up, down, left, right, space, tab, escape, backspace, or literal text")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("queue")
      .setDescription("Manage message queue")
      .addSubcommand((sub) => sub.setName("view").setDescription("View queued messages"))
      .addSubcommand((sub) => sub.setName("clear").setDescription("Clear all queued messages"))
      .addSubcommand((sub) =>
        sub.setName("remove").setDescription("Remove a queued message")
          .addIntegerOption((opt) => opt.setName("id").setDescription("Queue ID to remove").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub.setName("edit").setDescription("Edit a queued message")
          .addIntegerOption((opt) => opt.setName("id").setDescription("Queue ID to edit").setRequired(true))
      ),
    new SlashCommandBuilder()
      .setName("cost")
      .setDescription("Show cost and duration for this session"),
    new SlashCommandBuilder()
      .setName("rewind")
      .setDescription("Rewind the conversation (like Ctrl+G in the TTY)"),
    new SlashCommandBuilder()
      .setName("resume")
      .setDescription("Resume a previous session by id (restarts Claude with --resume)")
      .addStringOption((opt) =>
        opt.setName("id")
          .setDescription("Session id or search term (blank = pick from list in TTY)")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("plan")
      .setDescription("Enter plan mode with an optional prompt")
      .addStringOption((opt) =>
        opt.setName("prompt")
          .setDescription("What to plan (optional)")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("memory")
      .setDescription("Append text to project CLAUDE.md")
      .addStringOption((opt) =>
        opt.setName("text")
          .setDescription("Text to append (as a memory note)")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("export")
      .setDescription("Export the current conversation")
      .addStringOption((opt) =>
        opt.setName("filename")
          .setDescription("Optional output filename")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("mcp")
      .setDescription("Toggle or list MCP servers")
      .addStringOption((opt) =>
        opt.setName("args")
          .setDescription("e.g. 'enable slack' or 'disable slack'. Empty = list.")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("doctor")
      .setDescription("Run Claude Code diagnostics"),
    new SlashCommandBuilder()
      .setName("hooks")
      .setDescription("Show installed hook configuration"),
    new SlashCommandBuilder()
      .setName("kill-agents")
      .setDescription("Kill all running background subagents"),
  ];

  if (!skipRegistration) {
    try {
      await client.application!.commands.set(commands, guildId);
      await client.application!.commands.set([]);
      console.log("[daemon] Slash commands registered");
    } catch (err) {
      console.error("[daemon] Failed to register slash commands:", err);
    }
  }

  const handler = async (interaction: import("discord.js").Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.channelId !== deps.channelId) return;
    const cmd = interaction as ChatInputCommandInteraction;
    const { activity, sendToClient, getCtx } = deps;

    switch (cmd.commandName) {
      case "mode": {
        const target = cmd.options.getString("mode", true);
        const ctx = getCtx();
        const current = ctx?.permissionMode || "default";
        // bypassPermissions is only reachable when the user launched Claude
        // with `--dangerously-skip-permissions` (upstream permissionSetup.ts).
        // We approximate via ctx.bypassAvailable, set at session-register.
        const bypassAvailable = ctx?.bypassAvailable ?? (current === "bypassPermissions");
        const cycle = getModeCycle(bypassAvailable);
        if (target === current) {
          await cmd.reply({ content: `Already in **${MODE_LABELS[target]}**`, ephemeral: true });
          return;
        }
        if (!isModeReachable(target, cycle)) {
          await cmd.reply({
            content: `⚠️ **${MODE_LABELS[target] || target}** isn't reachable in this session. Relaunch Claude with \`--dangerously-skip-permissions\` to enable bypass mode.`,
            ephemeral: true,
          });
          return;
        }
        const presses = modeShiftTabCount(current, target, cycle);
        const SHIFT_TAB = "\x1b[Z";
        for (let i = 0; i < presses; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 500));
          sendToClient({ type: "pty-write", text: SHIFT_TAB, raw: true });
        }
        // Optimistically update tracked mode — JSONL won't reflect the change
        // until the next user message attaches a permissionMode field.
        if (ctx) ctx.permissionMode = target;
        await cmd.reply({ content: `🔄 Switching to **${MODE_LABELS[target]}** (${presses} cycle${presses > 1 ? "s" : ""})`, ephemeral: true });
        break;
      }
      case "clear":
        sendToClient({ type: "pty-write", text: "/clear", raw: false });
        activity.busy = false;
        activity.update("idle", client);
        await cmd.reply({ content: "🧹 Clearing context...", ephemeral: true });
        break;
      case "status": {
        const currentMode = getCtx()?.permissionMode || "default";
        const info = STATUS_LABELS[activity.state];
        await cmd.reply({
          content: [
            `📁 **Project**: \`${deps.projectDir}\``,
            `🆔 **Session**: \`${deps.sessionId.slice(0, 8)}\``,
            `🔒 **Mode**: ${MODE_LABELS[currentMode] || currentMode}`,
            `${info.icon} **Activity**: ${info.label}`,
            activity.queue.length > 0 ? `📥 **Queue**: ${activity.queue.length} message${activity.queue.length !== 1 ? "s" : ""}` : "",
          ].filter(Boolean).join("\n"),
          ephemeral: true,
        });
        break;
      }
      case "compact": {
        const instructions = cmd.options.getString("instructions");
        const text = instructions ? `/compact ${instructions}` : "/compact";
        sendToClient({ type: "pty-write", text, raw: false });
        activity.busy = false;
        activity.update("idle", client);
        await cmd.reply({ content: "📦 Compacting context...", ephemeral: true });
        break;
      }
      case "model": {
        const model = cmd.options.getString("model", true);
        sendToClient({ type: "pty-write", text: `/model ${model}`, raw: false });
        await cmd.reply({ content: `🤖 Switching to \`${model}\`...`, ephemeral: true });
        break;
      }
      case "stop":
        // Escape alone is the upstream `chat:cancel` action — cancels tools,
        // thinking, and input. Sending Ctrl+C after it used to set the
        // "Press Ctrl-C again to exit" pending state on an idle prompt,
        // which could confusingly double-trigger exit on a follow-up Ctrl+C.
        sendToClient({ type: "pty-write", text: "\x1b", raw: true });
        activity.busy = false;
        activity.stopOverrideUntil = Date.now() + 3000;
        activity.update("idle", client);
        await cmd.reply({ content: "⏹️ Interrupted", ephemeral: true });
        setTimeout(() => activity.tryDequeue(), 3500);
        break;
      case "restart":
        deps.restart();
        activity.busy = false;
        activity.update("idle", client);
        await cmd.reply({ content: "🔄 Restarting Claude...", ephemeral: true });
        break;
      case "key": {
        const input = cmd.options.getString("keys", true);
        const { keys, display } = parseKeyInput(input);
        const KEY_SEND_DELAY = 100;
        keys.forEach((key, i) => {
          setTimeout(() => sendToClient({ type: "pty-write", text: key, raw: true }), i * KEY_SEND_DELAY);
        });
        await cmd.reply({ content: `⌨️ Sent: ${display}`, ephemeral: true });
        break;
      }
      case "queue":
        await handleQueueCommand(cmd, deps);
        break;
      case "cost":
        sendToClient({ type: "pty-write", text: "/cost", raw: false });
        await cmd.reply({ content: "💰 Requesting cost report...", ephemeral: true });
        break;
      case "rewind":
        // Upstream binding is Ctrl+G — send it directly so this works even
        // if the user has `/rewind` the slash-command disabled.
        sendToClient({ type: "pty-write", text: "\x07", raw: true });
        await cmd.reply({ content: "⏪ Rewinding...", ephemeral: true });
        break;
      case "resume": {
        const id = cmd.options.getString("id") || "";
        const payload = id.trim() ? `/resume ${id.trim()}` : "/resume";
        sendToClient({ type: "pty-write", text: payload, raw: false });
        await cmd.reply({ content: id ? `↩️ Resuming \`${id}\`...` : "↩️ Showing resume picker...", ephemeral: true });
        break;
      }
      case "plan": {
        const prompt = cmd.options.getString("prompt") || "";
        const payload = prompt.trim() ? `/plan ${prompt.trim()}` : "/plan";
        sendToClient({ type: "pty-write", text: payload, raw: false });
        activity.busy = true;
        activity.update("thinking", client);
        await cmd.reply({ content: "📐 Entering plan mode...", ephemeral: true });
        break;
      }
      case "memory": {
        const text = cmd.options.getString("text", true);
        // Use # prefix — the standard "quick memory" shortcut in Claude Code
        // that appends to CLAUDE.md without going through the memory editor UI.
        sendToClient({ type: "pty-write", text: `# ${text}`, raw: false });
        await cmd.reply({ content: "🧠 Saved to CLAUDE.md", ephemeral: true });
        break;
      }
      case "export": {
        const filename = cmd.options.getString("filename") || "";
        const payload = filename.trim() ? `/export ${filename.trim()}` : "/export";
        sendToClient({ type: "pty-write", text: payload, raw: false });
        await cmd.reply({ content: "📤 Exporting conversation...", ephemeral: true });
        break;
      }
      case "mcp": {
        const args = cmd.options.getString("args") || "";
        const payload = args.trim() ? `/mcp ${args.trim()}` : "/mcp";
        sendToClient({ type: "pty-write", text: payload, raw: false });
        await cmd.reply({ content: "🔌 MCP command sent", ephemeral: true });
        break;
      }
      case "doctor":
        sendToClient({ type: "pty-write", text: "/doctor", raw: false });
        await cmd.reply({ content: "🩺 Running diagnostics...", ephemeral: true });
        break;
      case "hooks":
        sendToClient({ type: "pty-write", text: "/hooks", raw: false });
        await cmd.reply({ content: "🪝 Showing hooks config...", ephemeral: true });
        break;
      case "kill-agents":
        // Upstream `chat:killAgents` is Ctrl+X Ctrl+K — spaced so Ink sees the chord.
        sendToClient({ type: "pty-write", text: "\x18", raw: true });
        setTimeout(() => sendToClient({ type: "pty-write", text: "\x0b", raw: true }), 100);
        await cmd.reply({ content: "🗡️ Kill-agents chord sent", ephemeral: true });
        break;
    }
  };

  client.on(Events.InteractionCreate, handler);
  return () => client.removeListener(Events.InteractionCreate, handler);
}

// ── Key parsing for /key command ──

const KEY_MAP: Record<string, string> = {
  // Navigation
  enter: "\r",
  return: "\r",
  space: " ",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  escape: "\x1b",
  esc: "\x1b",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",
  // Ctrl combinations
  "ctrl+a": "\x01",
  "ctrl+b": "\x02",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+e": "\x05",
  "ctrl+f": "\x06",
  "ctrl+g": "\x07",
  "ctrl+h": "\x7f",
  "ctrl+k": "\x0b",
  "ctrl+l": "\x0c",
  "ctrl+n": "\x0e",
  "ctrl+o": "\x0f",
  "ctrl+p": "\x10",
  "ctrl+r": "\x12",
  "ctrl+t": "\x14",
  "ctrl+u": "\x15",
  "ctrl+w": "\x17",
  // ctrl+z deliberately omitted — SIGTSTP suspends the Claude child on POSIX
  // terminals (WSL/macOS) and leaves the bridge appearing hung. Users who
  // really need it can still send the raw byte via literal text.
  // Function keys
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

const KEY_LABELS: Record<string, string> = {
  enter: "Enter", return: "Enter", space: "Space", tab: "Tab",
  "shift+tab": "Shift+Tab", escape: "Esc", esc: "Esc",
  backspace: "Backspace", delete: "Del", insert: "Ins",
  up: "↑", down: "↓", right: "→", left: "←",
  home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn",
  "ctrl+a": "Ctrl+A", "ctrl+b": "Ctrl+B", "ctrl+c": "Ctrl+C",
  "ctrl+d": "Ctrl+D", "ctrl+e": "Ctrl+E", "ctrl+f": "Ctrl+F",
  "ctrl+g": "Ctrl+G", "ctrl+h": "Ctrl+H", "ctrl+k": "Ctrl+K",
  "ctrl+l": "Ctrl+L", "ctrl+n": "Ctrl+N", "ctrl+o": "Ctrl+O",
  "ctrl+p": "Ctrl+P", "ctrl+r": "Ctrl+R", "ctrl+t": "Ctrl+T",
  "ctrl+u": "Ctrl+U", "ctrl+w": "Ctrl+W",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function parseKeyInput(input: string): { keys: string[]; display: string } {
  const tokens = input.trim().split(/\s+/);
  const keys: string[] = [];
  const labels: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    // Check for repeat syntax: "enter*3" → enter enter enter
    const repeatMatch = lower.match(/^(.+)\*(\d+)$/);
    if (repeatMatch) {
      const [, name, countStr] = repeatMatch;
      const count = Math.min(parseInt(countStr, 10), 20);
      const seq = KEY_MAP[name];
      if (seq) {
        for (let i = 0; i < count; i++) keys.push(seq);
        labels.push(`${KEY_LABELS[name] || name} x${count}`);
        continue;
      }
    }

    if (KEY_MAP[lower]) {
      keys.push(KEY_MAP[lower]);
      labels.push(KEY_LABELS[lower] || lower);
    } else {
      // Literal text — send each character
      for (const ch of token) keys.push(ch);
      labels.push(`"${token}"`);
    }
  }

  return { keys, display: labels.join(" ") };
}

async function handleQueueCommand(cmd: ChatInputCommandInteraction, deps: SlashCommandDeps) {
  const { activity } = deps;
  const sub = cmd.options.getSubcommand();

  switch (sub) {
    case "view":
      if (activity.queue.length === 0) {
        await cmd.reply({ content: "📭 Queue is empty", ephemeral: true });
      } else {
        const lines = activity.queue.map((m) =>
          `**#${m.id}** — ${m.text.slice(0, 100)}${m.text.length > 100 ? "…" : ""}`
        );
        await cmd.reply({
          embeds: [{
            title: `📥 Message Queue (${activity.queue.length})`,
            description: lines.join("\n").slice(0, 4000),
            color: COLOR.BLURPLE,
          }],
          ephemeral: true,
        });
      }
      break;
    case "clear": {
      const count = activity.clearQueue();
      activity.update(activity.state);
      await cmd.reply({ content: `🗑️ Cleared ${count} queued message${count !== 1 ? "s" : ""}`, ephemeral: true });
      break;
    }
    case "remove": {
      const id = cmd.options.getInteger("id", true);
      if (activity.removeFromQueue(id)) {
        activity.update(activity.state);
        await cmd.reply({ content: `🗑️ Removed #${id} (${activity.queue.length} remaining)`, ephemeral: true });
      } else {
        await cmd.reply({ content: `❌ Queue #${id} not found`, ephemeral: true });
      }
      break;
    }
    case "edit": {
      const id = cmd.options.getInteger("id", true);
      const item = activity.findInQueue(id);
      if (!item) {
        await cmd.reply({ content: `❌ Queue #${id} not found`, ephemeral: true });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(`${ID_PREFIX.QUEUE_EDIT}${id}`)
        .setTitle(`Edit queued message #${id}`);
      const textInput = new TextInputBuilder()
        .setCustomId("text")
        .setLabel("Message")
        .setStyle(TextInputStyle.Paragraph)
        .setValue(item.text)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
      await cmd.showModal(modal);
      break;
    }
  }
}
