export type Ttl = "5m" | "1h";

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type Refresh = {
  at: number;
  model: string;
  usage: Usage | null;
  costUsd: number | null;
  // The rewrite the next prompt avoids, less this refresh's cost; earned only if a prompt follows before expiry.
  savesUsd: number | null;
  result: "warmed" | "expired" | "failed";
  detail?: string;
};

export type Status =
  | { state: "waiting" }
  | {
      state: "scheduled";
      nextAt: number;
      phase: "run" | "idle";
      expectedUsd: number;
    }
  | { state: "refreshing" }
  | { state: "stopped"; reason: string };

// How Clawd behaves in the pane and the band: sipping while a refresh runs, hopping after
// a warm one, dozing off over a cold mug after a failure or an expired cache.
export type Mood = "warming" | "warmed" | "cold";

// How a notice ends: a refresh under way stays until its outcome replaces it,
// one during a turn fades after a few seconds, and one in an idle session
// holds still from then on until the next prompt.
export type NoticeEnding = "stays" | "fades" | "holds";

// The band's line: `head` is the highlighted outcome and `detail` the dim rest.
// `startedAt` is when the notice appeared, `since` when its mood began and
// `heldAt` when Clawd stopped moving in a held notice, in epoch milliseconds;
// `prompt` counts the prompts before the refresh it tells of.
export type Notice = {
  ttl: Ttl;
  head: string;
  detail: string;
  mood: Mood;
  ending: NoticeEnding;
  startedAt: number;
  since: number;
  heldAt: number | null;
  prompt: number;
};

export type Totals = {
  refreshes: number;
  costUsd: number;
  // The fees of refresh chains that no kept prompt followed.
  wastedUsd: number;
  kept: number;
  keptUsd: number;
};

// Totals across sessions, kept in $.store; `since` is when counting began, in epoch milliseconds.
export type AllTime = Totals & { since: number };

// The refreshes each lifetime may send while the session is idle.
export type IdleLimits = { "5m": number; "1h": number };

export type Page = "main" | "config" | "analytics";

// The band above the prompt during a refresh: Clawd beside the notice, the notice as one line, or nothing.
export type BandStyle = "default" | "simplified" | "off";

// The main conversation's last request: the prefix a fork replays and keeps warm.
export type Anchor = {
  at: number;
  lastAt: number;
  model: string;
  promptTokens: number;
  ttl: Ttl;
  refreshes: number;
  // Refreshes sent while the session was idle; the idle limit counts these.
  idleRefreshes: number;
  // What this chain's refreshes cost: wasted unless the next prompt is kept.
  feeUsd: number;
  isStopped: boolean;
};

// Kept in state so that a reload, which a lifetime switch causes, can re-arm the timer.
export type Warming = {
  anchor: Anchor | null;
  isRunning: boolean;
  outputTokens: number;
};

declare module "claude-code" {
  interface PluginState {
    "cache-warmer": {
      // This session's lifetime; `defaultTtl` is the saved one new sessions start with.
      ttl: Ttl;
      defaultTtl: Ttl;
      // Set when the session page chose `ttl`, so a reload keeps it instead of the default.
      isSessionTtl: boolean;
      idleLimits: IdleLimits;
      isForced: boolean;
      // Set by the first main-thread response: the lifetime cannot change until /clear or a new session.
      isLocked: boolean;
      // While on, the main page lists the newest refreshes and a JSONL log records refreshes and stops.
      isDebug: boolean;
      bandStyle: BandStyle;
      page: Page;
      refreshes: Refresh[];
      status: Status;
      notice: Notice | null;
      totals: Totals;
      allTime: AllTime;
      now: number;
      warming: Warming;
    };
  }
}
