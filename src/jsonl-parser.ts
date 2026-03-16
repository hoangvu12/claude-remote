import { readFile } from "node:fs/promises";
import type { JSONLMessage, ContentBlock, ContentBlockToolUse, ProcessedMessage } from "./types.js";
import { truncate, extractToolResultText } from "./utils.js";

/**
 * Parse a JSONL file into an array of messages.
 */
export async function parseJSONLFile(filePath: string): Promise<JSONLMessage[]> {
  const raw = await readFile(filePath, "utf-8");
  return parseJSONLString(raw);
}

export function parseJSONLString(raw: string): JSONLMessage[] {
  const messages: JSONLMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as JSONLMessage);
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}

/**
 * Walk the message tree and return the current branch in oldest-first order.
 */
export function walkCurrentBranch(messages: JSONLMessage[]): JSONLMessage[] {
  if (messages.length === 0) return [];

  const byUuid = new Map<string, JSONLMessage>();
  const hasChildren = new Set<string>();

  for (const msg of messages) {
    byUuid.set(msg.uuid, msg);
    if (msg.parentUuid) {
      hasChildren.add(msg.parentUuid);
    }
  }

  // Find latest non-sidechain leaf (O(n) instead of sort)
  let leaf: JSONLMessage | null = null;
  let leafTime = -Infinity;

  for (const msg of messages) {
    if (hasChildren.has(msg.uuid) || msg.isSidechain) continue;
    const t = new Date(msg.timestamp).getTime();
    if (t > leafTime) {
      leafTime = t;
      leaf = msg;
    }
  }

  if (!leaf) return [];

  // Walk parentUuid chain backwards to root
  const chain: JSONLMessage[] = [];
  let current: JSONLMessage | undefined = leaf;
  while (current) {
    chain.push(current);
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
  }

  chain.reverse();

  // Only return messages after the last compact boundary
  let startIndex = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].type === "system" && chain[i].subtype === "compact_boundary") {
      startIndex = i;
      break;
    }
  }

  return chain.slice(startIndex);
}

/**
 * Process system/progress/internal message types.
 */
export function processNonConversation(msg: JSONLMessage): ProcessedMessage | null {
  if (msg.type !== "system") return null;

  if (msg.subtype === "turn_duration") {
    const data = msg.data || {};
    const cost = {
      duration: data.duration as string | undefined,
      inputTokens: data.inputTokens as number | undefined,
      outputTokens: data.outputTokens as number | undefined,
      cost: data.cost as string | undefined,
    };
    const parts: string[] = [];
    if (cost.duration) parts.push(`⏱ ${cost.duration}`);
    if (cost.cost) parts.push(`💰 ${cost.cost}`);
    if (cost.inputTokens) parts.push(`📥 ${cost.inputTokens} in`);
    if (cost.outputTokens) parts.push(`📤 ${cost.outputTokens} out`);
    return { type: "turn-duration", content: parts.join(" · ") || "Turn completed", uuid: msg.uuid, cost };
  }

  return null;
}

/**
 * Process all content blocks from an assistant message.
 */
export function processAssistantBlocks(msg: JSONLMessage): ProcessedMessage[] {
  if (msg.type !== "assistant" || !msg.message || !Array.isArray(msg.message.content)) return [];

  const results: ProcessedMessage[] = [];
  for (const block of msg.message.content as ContentBlock[]) {
    if (block.type === "thinking") continue;

    if (block.type === "text" && block.text.trim()) {
      // Skip assistant text that's just echoing discord-cmd output
      const trimmed = block.text.trim();
      if (trimmed === "Discord sync enabled." || trimmed === "Discord sync disabled." || trimmed === "Discord sync enabled" || trimmed === "Discord sync disabled") continue;
      results.push({ type: "assistant-text", content: block.text, uuid: msg.uuid });
    }

    if (block.type === "tool_use") {
      const tb = block as ContentBlockToolUse;

      // Skip discord-cmd calls — internal to the /discord skill
      if (tb.name === "Bash") {
        const cmd = String((tb.input as Record<string, unknown>).command || "");
        if (cmd.includes("discord-cmd")) continue;
      }

      if (tb.name === "AskUserQuestion") {
        const input = tb.input as Record<string, unknown>;
        results.push({
          type: "ask-user-question",
          content: "Claude has a question for you",
          uuid: msg.uuid,
          toolUseId: tb.id,
          toolName: tb.name,
          questions: input.questions as ProcessedMessage["questions"],
        });
      } else {
        results.push({
          type: "tool-use",
          content: getToolInputPreview(tb.name, tb.input),
          uuid: msg.uuid,
          toolName: tb.name,
          toolUseId: tb.id,
        });
      }
    }
  }

  return results;
}

/**
 * Process user message blocks (may contain multiple tool results).
 */
// Internal/system content that should not be forwarded to Discord
const INTERNAL_PATTERNS = [
  /<task-notification>/,
  /<command-message>/,
  /<command-name>/,
  /<system-reminder>/,
  /<local-command/,
  /Command running in background with ID:/,
  /Read the output file to retrieve/,
];

function isInternalContent(text: string): boolean {
  return INTERNAL_PATTERNS.some((p) => p.test(text));
}

export function processUserBlocks(msg: JSONLMessage): ProcessedMessage[] {
  if (msg.type !== "user" || !msg.message) return [];

  const content = msg.message.content;

  if (typeof content === "string") {
    if (isInternalContent(content)) return [];
    return [{ type: "user-prompt", content, uuid: msg.uuid }];
  }

  if (!Array.isArray(content)) return [];

  const results: ProcessedMessage[] = [];
  for (const block of content) {
    if (block.type === "tool_result") {
      const raw = extractToolResultText(block.content);

      // Skip internal/discord-cmd results
      if (isInternalContent(raw) || /Discord sync (enabled|disabled)/.test(raw)) continue;

      results.push({
        type: block.is_error ? "tool-result-error" : "tool-result",
        content: raw,
        uuid: msg.uuid,
        toolUseId: block.tool_use_id,
      });
    }
  }

  return results;
}

function getToolInputPreview(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return `\`${truncate(String(input.command || ""), 100)}\``;
    case "Read":
    case "Write":
    case "Edit":
      return `\`${input.file_path || ""}\``;
    case "Glob":
    case "Grep":
      return `\`${input.pattern || ""}\``;
    case "Agent":
      return `${input.description || "subagent"}`;
    default:
      return `\`${truncate(JSON.stringify(input), 100)}\``;
  }
}

/**
 * Detect if a new message is a rewind.
 */
export function isRewind(newMsg: JSONLMessage, previousLatestUuid: string | null): boolean {
  if (!previousLatestUuid || !newMsg.parentUuid) return false;
  return newMsg.parentUuid !== previousLatestUuid;
}
