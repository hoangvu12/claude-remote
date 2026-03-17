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
import type { DaemonToParent } from "./types.js";
import { ActivityManager, STATUS_LABELS, type ActivityState } from "./activity.js";
import { modeShiftTabCount, MODE_LABELS, ID_PREFIX } from "./utils.js";
import { COLOR } from "./discord-renderer.js";

export interface SlashCommandDeps {
  getCtx: () => SessionContext | null;
  activity: ActivityManager;
  sendToParent: (msg: DaemonToParent) => void;
  provider: DiscordProvider;
  projectDir: string;
  sessionId: string;
}

export async function setupSlashCommands(
  client: Client,
  guildId: string,
  deps: SlashCommandDeps,
): Promise<void> {
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
      .setName("stop")
      .setDescription("Interrupt Claude (like pressing Escape)"),
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

  try {
    await client.application!.commands.set(commands, guildId);
    await client.application!.commands.set([]);
    console.log("[daemon] Slash commands registered");
  } catch (err) {
    console.error("[daemon] Failed to register slash commands:", err);
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction as ChatInputCommandInteraction;
    const { activity, sendToParent, getCtx } = deps;

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
          sendToParent({ type: "pty-write", text: SHIFT_TAB, raw: true });
        }
        // Optimistically update tracked mode — JSONL won't reflect the change until next user message
        const ctx = getCtx();
        if (ctx) ctx.permissionMode = target;
        await cmd.reply({ content: `🔄 Switching to **${MODE_LABELS[target]}** (${presses} cycle${presses > 1 ? "s" : ""})`, ephemeral: true });
        break;
      }
      case "clear":
        sendToParent({ type: "pty-write", text: "/clear", raw: false });
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
        sendToParent({ type: "pty-write", text, raw: false });
        activity.busy = false;
        activity.update("idle", client);
        await cmd.reply({ content: "📦 Compacting context...", ephemeral: true });
        break;
      }
      case "stop":
        sendToParent({ type: "pty-write", text: "\x1b", raw: true });
        setTimeout(() => sendToParent({ type: "pty-write", text: "\x03", raw: true }), 200);
        activity.busy = false;
        activity.stopOverrideUntil = Date.now() + 3000;
        activity.update("idle", client);
        await cmd.reply({ content: "⏹️ Interrupted", ephemeral: true });
        setTimeout(() => activity.tryDequeue(), 3500);
        break;
      case "queue":
        await handleQueueCommand(cmd, deps);
        break;
    }
  });
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
