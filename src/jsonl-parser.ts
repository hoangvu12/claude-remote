import type { JSONLMessage, ContentBlock, ContentBlockToolUse, ContentBlockThinking, ContentBlockServerToolUse, ContentBlockWebSearchToolResult, ProcessedMessage } from "./types.js";
import { truncate, extractToolResultText, extractToolResultImages } from "./utils.js";
import { HIDDEN_TOOLS, INTERACTIVE_TOOLS, isGroupableTool } from "./tools.js";

function isHiddenToolUse(tb: ContentBlockToolUse): boolean {
  if (HIDDEN_TOOLS.has(tb.name)) return true;
  if (tb.name === "Bash") {
    const cmd = String((tb.input as Record<string, unknown>).command || "");
    if (cmd.includes("discord-cmd")) return true;
  }
  return false;
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
  // Diagnostics attachments — LSP error/warning counts grouped by file. Mirrors
  // upstream's DiagnosticsDisplay summary line. Severity 1=Error, 2=Warning,
  // 3=Info, 4=Hint per LSP spec.
  if (msg.type === "attachment" && msg.attachment?.type === "diagnostics") {
    const files = msg.attachment.files || [];
    if (files.length === 0) return null;
    let errors = 0;
    let warnings = 0;
    for (const f of files) {
      for (const d of f.diagnostics) {
        if (d.severity === 1) errors++;
        else if (d.severity === 2) warnings++;
      }
    }
    if (errors === 0 && warnings === 0) return null;
    const fileLabels = files.slice(0, 3).map((f) => {
      const name = f.uri.replace(/^file:\/\//, "").replace(/^_claude_fs_right:/, "").split(/[/\\]/).pop() ?? f.uri;
      return name;
    }).join(", ");
    const more = files.length > 3 ? ` +${files.length - 3} more` : "";
    const parts: string[] = [];
    if (errors > 0) parts.push(`🔴 ${errors} error${errors === 1 ? "" : "s"}`);
    if (warnings > 0) parts.push(`🟡 ${warnings} warning${warnings === 1 ? "" : "s"}`);
    return {
      type: "diagnostics",
      content: `${parts.join("  ")}  *in ${fileLabels}${more}*`,
      uuid: msg.uuid,
    };
  }
  // System messages (turn_duration, etc.) are not forwarded to Discord — they're noise
  return null;
}

/**
 * Process all content blocks from an assistant message.
 */
export function processAssistantBlocks(msg: JSONLMessage): ProcessedMessage[] {
  if (msg.type !== "assistant" || !msg.message || !Array.isArray(msg.message.content)) return [];

  const blocks = msg.message.content as ContentBlock[];

  // Same-turn grouping pre-pass: count tool_use blocks by name (after filtering
  // out hidden/discord-cmd ones). When a groupable tool appears 2+ times in a
  // single assistant message we fold all those calls into one tool-use-group
  // PM emitted in place of the first occurrence; later occurrences are skipped.
  const toolNameCounts = new Map<string, number>();
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const tb = block as ContentBlockToolUse;
    if (isHiddenToolUse(tb)) continue;
    toolNameCounts.set(tb.name, (toolNameCounts.get(tb.name) || 0) + 1);
  }
  const emittedGroups = new Set<string>();

  const results: ProcessedMessage[] = [];
  for (const block of blocks) {
    if (block.type === "thinking") {
      const tb = block as ContentBlockThinking;
      const text = tb.thinking?.trim();
      if (text) results.push({ type: "thinking", content: text, uuid: msg.uuid });
      continue;
    }

    if ((block as { type: string }).type === "redacted_thinking") {
      results.push({ type: "thinking", content: "", uuid: msg.uuid, toolName: "redacted" });
      continue;
    }

    if ((block as { type: string }).type === "server_tool_use") {
      const sb = block as ContentBlockServerToolUse;
      results.push({
        type: "web-search",
        content: String((sb.input as Record<string, unknown>).query ?? sb.name),
        uuid: msg.uuid,
        toolName: sb.name,
        toolUseId: sb.id,
        toolInput: sb.input,
      });
      continue;
    }

    if ((block as { type: string }).type === "web_search_tool_result") {
      const wb = block as ContentBlockWebSearchToolResult;
      const hits = Array.isArray(wb.content) ? wb.content : [];
      const lines = hits.slice(0, 5).map((h) => {
        const t = (h.title || "").trim() || h.url || "(untitled)";
        return h.url ? `• [${t.slice(0, 80)}](${h.url})` : `• ${t.slice(0, 80)}`;
      });
      results.push({
        type: "web-search",
        content: lines.length > 0 ? lines.join("\n") : "*(no results)*",
        uuid: msg.uuid,
        toolUseId: wb.tool_use_id,
      });
      continue;
    }

    if (block.type === "text" && block.text.trim()) {
      const trimmed = block.text.trim();
      if (trimmed === "Discord sync enabled." || trimmed === "Discord sync disabled." || trimmed === "Discord sync enabled" || trimmed === "Discord sync disabled") continue;
      results.push({ type: "assistant-text", content: block.text, uuid: msg.uuid });
    }

    if (block.type === "tool_use") {
      const tb = block as ContentBlockToolUse;
      if (isHiddenToolUse(tb)) continue;

      const count = toolNameCounts.get(tb.name) || 0;
      if (count >= 2 && isGroupableTool(tb.name)) {
        if (emittedGroups.has(tb.name)) continue;
        emittedGroups.add(tb.name);

        const groupBlocks = blocks.filter(
          (b): b is ContentBlockToolUse =>
            b.type === "tool_use" &&
            (b as ContentBlockToolUse).name === tb.name &&
            !isHiddenToolUse(b as ContentBlockToolUse),
        );
        results.push({
          type: "tool-use-group",
          content: `${tb.name} × ${groupBlocks.length}`,
          uuid: msg.uuid,
          toolName: tb.name,
          toolUseIds: groupBlocks.map((b) => b.id),
          toolInputs: groupBlocks.map((b) => b.input),
        });
        continue;
      }

      if (INTERACTIVE_TOOLS.has(tb.name)) {
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
          toolInput: tb.input,
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
  /^\[Image: source: .+\]$/,
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

  // Collect top-level text and images from user messages (e.g. pasted images in CLI)
  const topTexts: string[] = [];
  const topImages: Array<{ mediaType: string; data: string }> = [];
  for (const block of content) {
    if (block.type === "text" && (block as { text: string }).text?.trim()) {
      const text = (block as { text: string }).text.trim();
      if (!isInternalContent(text)) topTexts.push(text);
    }
    if (block.type === "image") {
      const src = (block as { source?: { type: string; media_type: string; data: string } }).source;
      if (src?.type === "base64") {
        topImages.push({ mediaType: src.media_type, data: src.data });
      }
    }
  }
  if (topTexts.length > 0 || topImages.length > 0) {
    results.push({
      type: "user-prompt",
      content: topTexts.join("\n"),
      uuid: msg.uuid,
      images: topImages.length > 0 ? topImages : undefined,
    });
  }

  for (const block of content) {
    if (block.type === "tool_result") {
      const raw = extractToolResultText(block.content);
      const images = extractToolResultImages(block.content as Parameters<typeof extractToolResultImages>[0]);

      // Skip internal/discord-cmd results
      if (isInternalContent(raw) || /Discord sync (enabled|disabled)/.test(raw)) continue;

      results.push({
        type: block.is_error ? "tool-result-error" : "tool-result",
        content: raw,
        uuid: msg.uuid,
        toolUseId: block.tool_use_id,
        images: images.length > 0 ? images : undefined,
      });
    }
  }

  return results;
}

export function getToolInputPreview(name: string, input: Record<string, unknown>): string {
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

