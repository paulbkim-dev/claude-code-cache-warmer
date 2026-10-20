import type { ConfigValue, ModelForkResult, ModelUsage } from "claude-code";

import type { Notice, Refresh, Totals, Ttl, Usage } from "../types";

export const PRICES_AS_OF = "2026-10-20";

type Price = { input: number; cacheRead: number; output: number };

const price = (input: number, cacheRead: number, output: number): Price => ({
  input,
  cacheRead,
  output,
});

// A model priced higher for a prompt over `upTo` tokens, counting input of every kind.
type Tiered = { upTo: number; short: Price; long: Price };

// USD per million tokens at standard rates, from https://platform.claude.com/docs/en/about-claude/pricing.
// Cache writes cost 1.25x input for the 5-minute lifetime and 2x for the 1-hour lifetime.
const PRICES = {
  "claude-fable-5-1": price(10, 0.25, 50),
  "claude-mythos-5-1": price(10, 0.25, 50),
  "claude-fable-5": price(10, 1, 50),
  "claude-mythos-5": price(10, 1, 50),
  "claude-opus-5-5": price(4, 0.2, 20),
  "claude-opus-5": price(5, 0.5, 25),
  "claude-opus-4-8": price(5, 0.5, 25),
  "claude-opus-4-7": price(5, 0.5, 25),
  "claude-opus-4-6": price(5, 0.5, 25),
  "claude-opus-4-5": price(5, 0.5, 25),
  "claude-opus-4-1": price(15, 1.5, 75),
  "claude-opus-4": price(15, 1.5, 75),
  "claude-sonnet-5-5": price(2, 0.1, 10),
  "claude-sonnet-5": price(2, 0.2, 10),
  "claude-sonnet-4-6": price(3, 0.3, 15),
  "claude-sonnet-4-5": price(3, 0.3, 15),
  "claude-sonnet-4": price(3, 0.3, 15),
  "claude-haiku-5-5": {
    upTo: 100_000,
    short: price(0.1, 0.01, 0.5),
    long: price(0.5, 0.05, 2.5),
  },
  "claude-haiku-4-5": price(1, 0.1, 5),
  "claude-3-5-haiku": price(0.8, 0.08, 4),
} satisfies Record<string, Price | Tiered>;

const WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2 } satisfies Record<Ttl, number>;

export const TTL_MS = { "5m": 300_000, "1h": 3_600_000 } satisfies Record<
  Ttl,
  number
>;

// Pi 1.0.2's rule: send a refresh only when it is expected to save this much.
export const MIN_SAVINGS_USD = 0.05;
// Pi's measured chance that a prompt arrives before the entry expires while the session is idle.
export const IDLE_CONTINUATION = 0.15;
// A fork has no output cap; Opus 5.5 at high effort answered a refresh in 182 output tokens.
export const DEFAULT_OUTPUT_TOKENS = 200;
// The refreshes each lifetime may send while the session is idle, by default and at most.
export const IDLE_LIMIT_DEFAULT = 5;
export const IDLE_LIMIT_MAX = 20;

export const ZERO_TOTALS: Totals = {
  refreshes: 0,
  costUsd: 0,
  wastedUsd: 0,
  kept: 0,
  keptUsd: 0,
};

const isPriceKey = (id: string): id is keyof typeof PRICES =>
  Object.hasOwn(PRICES, id);

// The model as the API, a gateway, Bedrock or Vertex names it: a Bedrock inference
// profile (`us.anthropic.…-v1:0`), its ARN or Mantle's `anthropic.…`, and Vertex's `…@date`.
// An application inference profile ARN does not name its model, so it has no price.
const entryOf = (model: string): Price | Tiered | undefined => {
  const id = model
    .replace(/^arn:aws[\w-]*:bedrock:[^/]*\//, "")
    .replace(/^(?:claude-gateway|anthropic)\//, "")
    .replace(/^(?:[a-z-]+\.)?anthropic\./, "")
    .replace(/\[\d+(?:k|m)\]$/, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/@\d{8}$/, "");
  const key = isPriceKey(id)
    ? id
    : id.match(/^(claude-[a-z0-9-]+?)-\d{8}$/)?.[1];
  return key !== undefined && isPriceKey(key) ? PRICES[key] : undefined;
};

const priceAt = (entry: Price | Tiered, promptTokens: number): Price =>
  "upTo" in entry
    ? promptTokens > entry.upTo
      ? entry.long
      : entry.short
    : entry;

const rates = (model: string, promptTokens: number): Price | undefined => {
  const entry = entryOf(model);
  return entry && priceAt(entry, promptTokens);
};

// A fork that made a request; the other kind found nothing to fork.
export type ForkReply = Exclude<ModelForkResult, { reason: "nothing-to-fork" }>;

export const isTtl = (value: string): value is Ttl =>
  value === "5m" || value === "1h";

export const usageOf = (usage: ModelUsage): Usage => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheRead: usage.cache_read_input_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
});

export const promptTokensOf = (usage: Usage) =>
  usage.input + usage.cacheRead + usage.cacheWrite;

// Refresh at 90% of the lifetime, leaving at least ten seconds before expiry.
export const delayOf = (ttl: Ttl) =>
  Math.floor(Math.min(TTL_MS[ttl] * 0.9, TTL_MS[ttl] - 10_000));

// Pi stops run warming 60 minutes after the last prompt request; the 1-hour
// lifetime stretches that to two lifetimes so that it warms at all.
export const horizonOf = (ttl: Ttl) => Math.max(60 * 60_000, 2 * TTL_MS[ttl]);

// A /config value or option as an idle limit: a whole number from 0 to IDLE_LIMIT_MAX.
export const limitOf = (value: ConfigValue) => {
  const count = Math.round(Number(value));
  return Number.isFinite(count)
    ? Math.min(IDLE_LIMIT_MAX, Math.max(0, count))
    : IDLE_LIMIT_DEFAULT;
};

// How long an idle cache stays warm: the limit's refreshes, then one lifetime.
export const idleSpanOf = (count: number, ttl: Ttl) =>
  count * delayOf(ttl) + TTL_MS[ttl];

export const addTotals = <T extends Totals>(
  base: T,
  delta: Partial<Totals>,
): T => ({
  ...base,
  refreshes: base.refreshes + (delta.refreshes ?? 0),
  costUsd: base.costUsd + (delta.costUsd ?? 0),
  wastedUsd: base.wastedUsd + (delta.wastedUsd ?? 0),
  kept: base.kept + (delta.kept ?? 0),
  keptUsd: base.keptUsd + (delta.keptUsd ?? 0),
});

// A timer that fires this late would likely find the entry expired and pay a full write.
export const deadlineOf = (lastAt: number, ttl: Ttl) =>
  lastAt + delayOf(ttl) + Math.floor((TTL_MS[ttl] - delayOf(ttl)) / 2);

export const costOf = (
  model: string,
  usage: Usage,
  ttl: Ttl,
): number | null => {
  const p = rates(model, promptTokensOf(usage));
  if (!p) return null;
  return (
    (usage.input * p.input +
      usage.cacheWrite * p.input * WRITE_MULTIPLIER[ttl] +
      usage.cacheRead * p.cacheRead +
      usage.output * p.output) /
    1_000_000
  );
};

// What losing the entry adds to the next prompt: writing the prefix again instead of reading it.
export const missCostOf = (
  model: string,
  promptTokens: number,
  ttl: Ttl,
): number | null => {
  const p = rates(model, promptTokens);
  if (!p) return null;
  return Math.max(
    0,
    (promptTokens * (p.input * WRITE_MULTIPLIER[ttl] - p.cacheRead)) /
      1_000_000,
  );
};

export type Decision = {
  warmUsd: number;
  missUsd: number;
  probability: number;
  expectedUsd: number;
  isWarm: boolean;
  // Set when a refresh does not pay: the prompt is under the size where the expected saving reaches MIN_SAVINGS_USD.
  reason?: string;
};

const breakEvenAt = (
  p: Price,
  ttl: Ttl,
  probability: number,
  outputTokens: number,
): number | null => {
  const savedPerToken =
    probability * (p.input * WRITE_MULTIPLIER[ttl] - p.cacheRead) - p.cacheRead;
  if (savedPerToken <= 0) return null;
  return Math.ceil(
    (MIN_SAVINGS_USD * 1_000_000 + outputTokens * p.output) / savedPerToken,
  );
};

// A tiered model breaks even in its short tier, or else just over it at the long tier's price.
const breakEvenOf = (
  entry: Price | Tiered,
  ttl: Ttl,
  probability: number,
  outputTokens: number,
): number | null => {
  if (!("upTo" in entry))
    return breakEvenAt(entry, ttl, probability, outputTokens);
  const short = breakEvenAt(entry.short, ttl, probability, outputTokens);
  if (short !== null && short <= entry.upTo) return short;
  const long = breakEvenAt(entry.long, ttl, probability, outputTokens);
  return long === null ? null : Math.max(long, entry.upTo + 1);
};

export const decide = (
  model: string,
  promptTokens: number,
  ttl: Ttl,
  phase: "run" | "idle",
  outputTokens: number,
): Decision | null => {
  const entry = entryOf(model);
  const missUsd = missCostOf(model, promptTokens, ttl);
  if (!entry || missUsd === null || promptTokens <= 0) return null;
  const p = priceAt(entry, promptTokens);
  const warmUsd =
    (promptTokens * p.cacheRead + outputTokens * p.output) / 1_000_000;
  const probability = phase === "idle" ? IDLE_CONTINUATION : 1;
  const expectedUsd = probability * missUsd - warmUsd;
  const isWarm = expectedUsd >= MIN_SAVINGS_USD;
  const breakEven = isWarm
    ? null
    : breakEvenOf(entry, ttl, probability, outputTokens);
  const where = `${model} at ${ttl} (${phase})`;
  const reason = isWarm
    ? undefined
    : breakEven === null
      ? `a refresh never saves on ${where}`
      : `${formatTokens(promptTokens)} tokens is below the ${formatTokens(breakEven)} break-even on ${where}`;
  return { warmUsd, missUsd, probability, expectedUsd, isWarm, reason };
};

// A refresh that read under half the prefix found the entry gone and wrote it again.
export const outcomeOf = (
  reply: ForkReply,
  usage: Usage,
  promptTokens: number,
): Pick<Refresh, "result" | "detail"> => {
  if (usage.cacheRead >= promptTokens / 2) return { result: "warmed" };
  if (reply.isAnswered) return { result: "expired" };
  return {
    result: "failed",
    detail:
      reply.reason === "api-error"
        ? `${reply.error} ${reply.status ?? ""}`.trim()
        : reply.reason,
  };
};

export const noticeOf = (entry: Refresh): Pick<Notice, "head" | "detail"> => {
  const cost = `${entry.usage ? `read ${formatTokens(entry.usage.cacheRead)} · ` : ""}${entry.costUsd === null ? "cost unknown" : formatUsd(entry.costUsd)}`;
  if (entry.result === "expired")
    return {
      head: "Cache had expired",
      detail: `the refresh rewrote it · ${cost}`,
    };
  if (entry.result === "failed")
    return {
      head: "Cache refresh failed",
      detail: entry.detail ? `${entry.detail} · ${cost}` : cost,
    };
  return {
    head: "Cache warmed",
    detail: `${cost} · saves ${entry.savesUsd === null ? "unknown" : formatUsd(entry.savesUsd)} vs rewrite`,
  };
};

export const formatUsd = (usd: number): string => {
  const sign = usd < 0 ? "-" : "";
  const value = Math.abs(usd);
  return `${sign}$${value > 0 && value < 0.01 ? value.toPrecision(2) : value.toFixed(2)}`;
};

export const formatTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);

export const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600)
    return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
  return `${s}s`;
};
