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
import { modeShiftTabCount, MODE_LABELS, ID_PREFIX } from "./utils.js";
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
            { name: "Opus", value: "opus" },
            { name: "Haiku", value: "haiku" },
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
        const current = getCtx()?.permissionMode || "default";
        if (target === current) {
          await cmd.reply({ content: `Already in **${MODE_LABELS[target]}**`, ephemeral: true });
          return;
        }
        const presses = modeShiftTabCount(current, target);
        const SHIFT_TAB = "\x1b[Z";
        // Send each Shift+Tab with a delay so Claude Code has time to process each one
        for (let i = 0; i < presses; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 500));
          sendToClient({ type: "pty-write", text: SHIFT_TAB, raw: true });
        }
        // Optimistically update tracked mode — JSONL won't reflect the change until next user message
        const ctx = getCtx();
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
        sendToClient({ type: "pty-write", text: "\x1b", raw: true });
        setTimeout(() => sendToClient({ type: "pty-write", text: "\x03", raw: true }), 200);
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
  "ctrl+h": "\x08",
  "ctrl+k": "\x0b",
  "ctrl+l": "\x0c",
  "ctrl+n": "\x0e",
  "ctrl+o": "\x0f",
  "ctrl+p": "\x10",
  "ctrl+r": "\x12",
  "ctrl+t": "\x14",
  "ctrl+u": "\x15",
  "ctrl+w": "\x17",
  "ctrl+z": "\x1a",
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
  "ctrl+u": "Ctrl+U", "ctrl+w": "Ctrl+W", "ctrl+z": "Ctrl+Z",
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
