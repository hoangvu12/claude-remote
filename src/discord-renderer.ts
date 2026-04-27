import type { ProcessedMessage } from "./types.js";
import type { OutgoingMessage, OutputProvider } from "./provider.js";
import { truncate, ID_PREFIX, mimeToExt } from "./utils.js";

// ── Colors ──

const INVISIBLE = 0x2b2d31; // matches Discord dark theme background

export const COLOR = {
  USER: INVISIBLE,
  TOOL: INVISIBLE,
  TOOL_OK: INVISIBLE,
  TOOL_ERR: INVISIBLE,
  ERROR_RED: 0xed4245,
  PERMISSION: INVISIBLE,
  QUESTION: INVISIBLE,
  SYSTEM: INVISIBLE,
  BLURPLE: 0x5865f2,
} as const;

/** Return the appropriate embed color for a tool result */
export function resultColor(isError: boolean): number {
  return isError ? COLOR.ERROR_RED : COLOR.TOOL_OK;
}

export const MAX_EMBED_DESC = 4000;
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

export function renderMessage(msg: ProcessedMessage): OutgoingMessage[] {
  switch (msg.type) {
    case "user-prompt": {
      const out: OutgoingMessage = {
        embed: {
          author: "You",
          description: (msg.content || "(image)").slice(0, MAX_EMBED_DESC),
          color: COLOR.USER,
        },
      };
      // Attach first user-pasted image inside the embed, rest as separate files
      if (msg.images?.length) {
        const files = msg.images
          .map((img, i) => {
            const buf = Buffer.from(img.data, "base64");
            if (buf.length > 8 * 1024 * 1024) return null;
            return { name: `image-${i + 1}.${mimeToExt(img.mediaType)}`, data: buf };
          })
          .filter((f): f is NonNullable<typeof f> => f !== null);
        if (files.length > 0) {
          // First image goes inside the embed
          out.embedImage = `attachment://${files[0].name}`;
          out.files = files;
        }
      }
      return [out];
    }

    case "assistant-text":
      return splitContent(msg.content).map((chunk) => ({ text: chunk }));

    case "tool-use":
      return [{
        embed: {
          description: `🔧 **${msg.toolName}** ${msg.content}`,
          color: COLOR.TOOL,
        },
      }];

    case "tool-use-group": {
      const n = msg.toolUseIds?.length ?? 0;
      return [{
        embed: {
          description: `🔧 **${msg.toolName}** × ${n}`,
          color: COLOR.TOOL,
        },
      }];
    }

    case "tool-result": {
      if (!msg.content.trim() || msg.content === "undefined") return [];
      return [{
        embed: {
          description: `\`\`\`\n${msg.content.slice(0, MAX_EMBED_DESC - 10)}\n\`\`\``,
          color: COLOR.TOOL_OK,
        },
      }];
    }

    case "tool-result-error":
      return [{
        embed: {
          title: "❌ Error",
          description: `\`\`\`\n${msg.content.slice(0, MAX_EMBED_DESC - 10)}\n\`\`\``,
          color: COLOR.TOOL_ERR,
        },
      }];

    case "ask-user-question": {
      if (!msg.questions) return [];
      const isMulti = msg.questions.length > 1;

      return msg.questions.map((q, qIdx) => {
        const title = isMulti
          ? `❓ ${qIdx + 1}/${msg.questions!.length}: ${q.header}`
          : `❓ ${q.header}`;
        const base: OutgoingMessage = {
          embed: {
            title,
            description: q.question,
            color: COLOR.QUESTION,
          },
        };

        // ID format: ask:{toolUseId}:{questionIndex}:{optionIndex}:{label}
        if (q.multiSelect && q.options.length > 0) {
          base.selectMenu = {
            id: `${ID_PREFIX.ASK}${msg.toolUseId}:${qIdx}`,
            placeholder: "Select options...",
            options: q.options.map((o, idx) => ({
              label: o.label,
              value: `${idx}:${o.label}`,
              description: o.description || undefined,
            })),
            minValues: 1,
            maxValues: q.options.length,
          };
        } else {
          base.actions = [
            ...q.options.map((o, idx) => ({
              id: `${ID_PREFIX.ASK}${msg.toolUseId}:${qIdx}:${idx}:${o.label}`,
              label: o.label,
              style: "primary" as const,
            })),
            {
              id: `${ID_PREFIX.ASK_OTHER}${msg.toolUseId}:${qIdx}`,
              label: "Other",
              style: "secondary" as const,
            },
          ];
        }
        return base;
      });
    }

    case "rewind":
    case "turn-duration":
      return [{
        embed: {
          description: msg.content,
          color: COLOR.SYSTEM,
        },
      }];

    case "status":
      return [{ text: msg.content }];

    default:
      return [];
  }
}

/** Build thread messages for a tool result (splits long content) */
export function renderToolResultThreadMessages(content: string, isError: boolean): { content: string }[] {
  if (!content.trim() || content === "undefined") {
    return [{ content: isError ? "❌ *(empty error)*" : "✅ *(no output)*" }];
  }

  const prefix = isError ? "❌ **Error:**\n" : "";
  const chunks = splitContent(content);

  return chunks.map((chunk, i) => ({
    content: `${i === 0 ? prefix : ""}${chunk}`,
  }));
}

// ── Batch renderer: simplified — tool results go to threads now ──

export function renderBatch(messages: ProcessedMessage[]): OutgoingMessage[] {
  const payloads: OutgoingMessage[] = [];

  for (const pm of messages) {
    // Tool results are handled via threads in daemon.ts, skip them in batch
    if (pm.type === "tool-result" || pm.type === "tool-result-error") continue;
    payloads.push(...renderMessage(pm));
  }

  return payloads;
}

/** Render a ProcessedMessage and send all parts via the provider */
export async function sendRendered(provider: OutputProvider, pm: ProcessedMessage): Promise<void> {
  for (const msg of renderMessage(pm)) {
    await provider.send(msg);
  }
}
