import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type MessageCreateOptions,
} from "discord.js";
import type { ProcessedMessage } from "./types.js";
import { truncate, ID_PREFIX } from "./utils.js";

// ── Colors ──

const COLOR = {
  USER: 0x5865f2,       // blurple — user prompts
  TOOL: 0x2c2f33,       // dark gray — tool calls
  TOOL_OK: 0x2ecc71,    // green — success
  TOOL_ERR: 0xe74c3c,   // red — error
  PERMISSION: 0xf39c12, // orange — permission
  QUESTION: 0x9b59b6,   // purple — questions
  SYSTEM: 0x95a5a6,     // gray — system/meta
} as const;

export { COLOR };

const MAX_EMBED_DESC = 4000;
const MAX_CONTENT = 1900;

function splitContent(text: string, max = MAX_CONTENT): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let splitAt = remaining.lastIndexOf("\n", max);
    if (splitAt <= 0) splitAt = max;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining.trim()) chunks.push(remaining);
  return chunks;
}


// ── Single message renderer ──

export function renderMessage(msg: ProcessedMessage): MessageCreateOptions[] {
  switch (msg.type) {
    case "user-prompt": {
      const embed = new EmbedBuilder()
        .setAuthor({ name: "You" })
        .setDescription(msg.content.slice(0, MAX_EMBED_DESC))
        .setColor(COLOR.USER);
      return [{ embeds: [embed] }];
    }

    case "assistant-text": {
      const chunks = splitContent(msg.content);
      return chunks.map((chunk) => ({ content: chunk }));
    }

    case "tool-use": {
      const embed = new EmbedBuilder()
        .setDescription(`🔧 **${msg.toolName}** ${msg.content}`)
        .setColor(COLOR.TOOL);
      return [{ embeds: [embed] }];
    }

    case "tool-result": {
      if (!msg.content.trim() || msg.content === "undefined") return [];
      const embed = new EmbedBuilder()
        .setDescription(`\`\`\`\n${msg.content.slice(0, MAX_EMBED_DESC - 10)}\n\`\`\``)
        .setColor(COLOR.TOOL_OK);
      return [{ embeds: [embed] }];
    }

    case "tool-result-error": {
      const embed = new EmbedBuilder()
        .setTitle("❌ Error")
        .setDescription(`\`\`\`\n${msg.content.slice(0, MAX_EMBED_DESC - 10)}\n\`\`\``)
        .setColor(COLOR.TOOL_ERR);
      return [{ embeds: [embed] }];
    }

    case "ask-user-question": {
      if (!msg.questions) return [];

      return msg.questions.map((q) => {
        const embed = new EmbedBuilder()
          .setTitle(`❓ ${q.header}`)
          .setDescription(q.question)
          .setColor(COLOR.QUESTION);

        if (q.multiSelect && q.options.length > 0) {
          const select = new StringSelectMenuBuilder()
            .setCustomId(`${ID_PREFIX.ASK}${msg.toolUseId}:${q.header}`)
            .setPlaceholder("Select options...")
            .setMinValues(1)
            .setMaxValues(q.options.length)
            .addOptions(q.options.map((o) => ({
              label: o.label,
              description: o.description || undefined,
              value: o.label,
            })));
          return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] };
        }

        const buttons = q.options.map((o) =>
          new ButtonBuilder()
            .setCustomId(`${ID_PREFIX.ASK}${msg.toolUseId}:${q.header}:${o.label}`)
            .setLabel(o.label)
            .setStyle(ButtonStyle.Primary)
        );
        buttons.push(
          new ButtonBuilder()
            .setCustomId(`${ID_PREFIX.ASK_OTHER}${msg.toolUseId}:${q.header}`)
            .setLabel("Other")
            .setStyle(ButtonStyle.Secondary)
        );
        return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] };
      });
    }

    case "rewind":
    case "turn-duration": {
      const embed = new EmbedBuilder()
        .setDescription(msg.content)
        .setColor(COLOR.SYSTEM);
      return [{ embeds: [embed] }];
    }

    case "status":
      return [{ content: msg.content }];

    default:
      return [];
  }
}

/** Build thread messages for a tool result (splits long content) */
export function renderToolResultThreadMessages(content: string, isError: boolean): MessageCreateOptions[] {
  if (!content.trim() || content === "undefined") {
    return [{ content: isError ? "❌ *(empty error)*" : "✅ *(no output)*" }];
  }

  const prefix = isError ? "❌ **Error:**\n" : "";
  const chunks = splitContent(content, MAX_CONTENT - 20); // leave room for code fences

  return chunks.map((chunk, i) => ({
    content: `${i === 0 ? prefix : ""}\`\`\`\n${chunk}\n\`\`\``,
  }));
}

/** Build permission prompt for a thread */
export function renderPermissionPrompt(toolUseId: string, toolName: string, content: string): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("⚠️ Permission needed")
    .setDescription(`**${toolName}** ${content}`)
    .setColor(COLOR.PERMISSION);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID_PREFIX.ALLOW}${toolUseId}`)
      .setLabel("Allow")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${ID_PREFIX.DENY}${toolUseId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}

// ── Batch renderer: simplified — tool results go to threads now ──

export function renderBatch(messages: ProcessedMessage[]): MessageCreateOptions[] {
  const payloads: MessageCreateOptions[] = [];

  for (const pm of messages) {
    // Tool results are handled via threads in daemon.ts, skip them in batch
    if (pm.type === "tool-result" || pm.type === "tool-result-error") continue;

    const rendered = renderMessage(pm);
    payloads.push(...rendered);
  }

  return payloads;
}
