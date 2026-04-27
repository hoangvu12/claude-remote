/**
 * Per-model pricing + cost computation, ported verbatim from upstream
 * `utils/modelCost.ts`. The shape mirrors upstream so future model launches
 * map cleanly. Prices are USD per 1M input/output tokens; cache prices are
 * also per-Mtok.
 *
 * Source of truth: https://platform.claude.com/docs/en/about-claude/pricing
 */

export interface ModelCosts {
  inputTokens: number;
  outputTokens: number;
  promptCacheWriteTokens: number;
  promptCacheReadTokens: number;
  webSearchRequests: number;
}

const COST_TIER_3_15: ModelCosts = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
};

const COST_TIER_15_75: ModelCosts = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
};

const COST_TIER_5_25: ModelCosts = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
};

const COST_HAIKU_35: ModelCosts = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
};

const COST_HAIKU_45: ModelCosts = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
};

const DEFAULT_COSTS = COST_TIER_5_25;

/**
 * Map a JSONL `model` string (full id or short) to its cost tier. Pattern-
 * matched against the canonical first-party names — this avoids depending on
 * the canonicalize logic in upstream's model.ts. Unknown models fall back to
 * Opus 4.5 pricing (a safe over-estimate for typical usage).
 */
export function getModelCosts(model: string | undefined | null): ModelCosts {
  if (!model) return DEFAULT_COSTS;
  const m = model.toLowerCase();

  // Haiku
  if (m.includes("haiku-4-5") || m.includes("haiku-4.5")) return COST_HAIKU_45;
  if (m.includes("haiku")) return COST_HAIKU_35;

  // Opus tiers — 4.5/4.6 use the cheaper $5/$25 tier; 4/4.1 use $15/$75
  if (m.includes("opus-4-5") || m.includes("opus-4.5") || m.includes("opus-4-6") || m.includes("opus-4.6") || m.includes("opus-4-7") || m.includes("opus-4.7")) return COST_TIER_5_25;
  if (m.includes("opus")) return COST_TIER_15_75;

  // Sonnet — all tiers $3/$15
  if (m.includes("sonnet")) return COST_TIER_3_15;

  return DEFAULT_COSTS;
}

export interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

/** Cost in USD for a single assistant turn's usage block. */
export function calculateUSDCost(model: string | undefined | null, usage: UsageBlock): number {
  const c = getModelCosts(model);
  const inT = usage.input_tokens ?? 0;
  const outT = usage.output_tokens ?? 0;
  const cacheR = usage.cache_read_input_tokens ?? 0;
  const cacheW = usage.cache_creation_input_tokens ?? 0;
  const ws = usage.server_tool_use?.web_search_requests ?? 0;
  return (
    (inT / 1_000_000) * c.inputTokens +
    (outT / 1_000_000) * c.outputTokens +
    (cacheR / 1_000_000) * c.promptCacheReadTokens +
    (cacheW / 1_000_000) * c.promptCacheWriteTokens +
    ws * c.webSearchRequests
  );
}

/** Compact token count: 12345 → "12.3k". */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`;
}

/** Format USD: <$0.01 → "<$0.01"; <$1 → "$0.04"; >=$1 → "$1.23". */
export function formatUSD(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Render a 5-block context-window % bar with color thresholds.
 *
 *   ▓▓▓░░ 62%
 *
 * Color is hex for embed border; threshold matches statusline.ts:97-101.
 */
export function renderContextBar(usedPct: number): { bar: string; color: number; warn: boolean } {
  const pct = Math.max(0, Math.min(100, usedPct));
  const filled = Math.round((pct / 100) * 5);
  const bar = "▓".repeat(filled) + "░".repeat(5 - filled);
  const text = `${bar} ${Math.round(pct)}%`;
  let color = 0x2b2d31;
  let warn = false;
  if (pct >= 95) { color = 0xed4245; warn = true; }
  else if (pct >= 80) { color = 0xf5a623; warn = true; }
  return { bar: text, color, warn };
}

/** Default context window size for cost/% computation. Modern Claude is 200k. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Mirrors upstream `getContextWindowForModel` (utils/context.ts:51) — picks
 * 1M for explicitly-flagged models, 200k otherwise. We don't have access to
 * the SDK beta headers here, so 1M only kicks in when the model id carries
 * the `[1m]` suffix (the explicit client-side opt-in upstream respects over
 * all other detection).
 */
export function getContextWindowForModel(model: string | undefined | null): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  if (/\[1m\]/i.test(model)) return 1_000_000;
  return DEFAULT_CONTEXT_WINDOW;
}
