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
  CLAUDE: 0x3498db,     // blue — claude text
  TOOL: 0x2c2f33,       // dark gray — tool calls
  TOOL_OK: 0x2ecc71,    // green — success
  TOOL_ERR: 0xe74c3c,   // red — error
  PERMISSION: 0xf39c12, // orange — permission
  QUESTION: 0x9b59b6,   // purple — questions
  SYSTEM: 0x95a5a6,     // gray — system/meta
} as const;

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
      const chunks = splitContent(msg.content, MAX_EMBED_DESC);
      return chunks.map((chunk, i) => {
        const embed = new EmbedBuilder()
          .setDescription(chunk)
          .setColor(COLOR.CLAUDE);
        if (i === 0) embed.setAuthor({ name: "Claude" });
        return { embeds: [embed] };
      });
    }

    case "tool-use": {
      const embed = new EmbedBuilder()
        .setDescription(`🔧 **${msg.toolName}** ${msg.content}`)
        .setColor(COLOR.TOOL);
      return [{ embeds: [embed] }];
    }

    case "tool-result": {
      if (!msg.content.trim() || msg.content === "undefined") {
        return []; // will be merged with tool-use in batch mode
      }
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

    case "permission-prompt": {
      const embed = new EmbedBuilder()
        .setTitle("⚠️ Permission needed")
        .setDescription(`**${msg.toolName}** ${msg.content}`)
        .setColor(COLOR.PERMISSION);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${ID_PREFIX.ALLOW}${msg.toolUseId}`)
          .setLabel("Allow")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${ID_PREFIX.DENY}${msg.toolUseId}`)
          .setLabel("Deny")
          .setStyle(ButtonStyle.Danger),
      );

      return [{ embeds: [embed], components: [row] }];
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

    case "subagent-start":
    case "subagent-complete":
    case "mcp-progress":
    case "rewind":
    case "compact":
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

// ── Batch renderer: groups tool-use + tool-result into single messages ──

export function renderBatch(messages: ProcessedMessage[]): MessageCreateOptions[] {
  const payloads: MessageCreateOptions[] = [];
  let i = 0;

  while (i < messages.length) {
    const pm = messages[i];

    // Group consecutive tool-use + tool-result pairs into one embed
    if (pm.type === "tool-use") {
      const toolEmbeds: EmbedBuilder[] = [];

      while (i < messages.length && (messages[i].type === "tool-use" || messages[i].type === "tool-result" || messages[i].type === "tool-result-error")) {
        const cur = messages[i];

        if (cur.type === "tool-use") {
          // Check if next message is its result
          const next = messages[i + 1];
          if (next && (next.type === "tool-result" || next.type === "tool-result-error")) {
            // Merge tool-use + result into one embed
            const resultIcon = next.type === "tool-result-error" ? "❌" : "✅";
            const resultText = next.content.trim() && next.content !== "undefined"
              ? (next.content.length > 100 ? `\n\`\`\`\n${next.content.slice(0, 300)}\n\`\`\`` : ` → ${next.content}`)
              : "";
            toolEmbeds.push(
              new EmbedBuilder()
                .setDescription(`🔧 **${cur.toolName}** ${cur.content} ${resultIcon}${resultText}`)
                .setColor(next.type === "tool-result-error" ? COLOR.TOOL_ERR : COLOR.TOOL)
            );
            i += 2;
          } else {
            // Tool use with no result yet
            toolEmbeds.push(
              new EmbedBuilder()
                .setDescription(`🔧 **${cur.toolName}** ${cur.content}`)
                .setColor(COLOR.TOOL)
            );
            i++;
          }
        } else {
          // Orphan tool result (result without preceding tool-use in this batch)
          if (cur.type === "tool-result-error") {
            toolEmbeds.push(
              new EmbedBuilder()
                .setDescription(`❌ \`\`\`\n${cur.content.slice(0, 300)}\n\`\`\``)
                .setColor(COLOR.TOOL_ERR)
            );
          }
          // Skip standalone tool-result (success) — noise
          i++;
        }

        // Discord max 10 embeds per message
        if (toolEmbeds.length >= 10) break;
      }

      if (toolEmbeds.length > 0) {
        payloads.push({ embeds: toolEmbeds });
      }
      continue;
    }

    // Non-tool messages: render normally
    const rendered = renderMessage(pm);
    payloads.push(...rendered);
    i++;
  }

  return payloads;
}
