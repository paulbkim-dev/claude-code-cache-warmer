import { atom, read, update } from "claude-code";
import type {
  Args,
  ConfigValue,
  EngineInterface,
  Frozen,
  Hook,
  MatchedEvent,
  Next,
  Register,
  StreamNext,
  Timer,
  TurnStepChunk,
  TurnStepResult,
} from "claude-code";

import type {
  AllTime,
  Anchor,
  BandStyle,
  IdleLimits,
  Notice,
  Page,
  Refresh,
  Status,
  Totals,
  Ttl,
  Warming,
} from "../types";
import { MASCOT_ROWS, TERMINAL_DEFAULT, cellsOf } from "./mascot";
import { paneOf } from "./pages";
import type { Mascot, PaneActions, PaneData } from "./pane";
import { MASCOT_KEY, bandOf, layoutOf, mascotBandOf, rasterOf } from "./pane";
import type { ForkReply } from "./warmer";
import {
  DEFAULT_OUTPUT_TOKENS,
  IDLE_LIMIT_DEFAULT,
  TTL_MS,
  ZERO_TOTALS,
  addTotals,
  costOf,
  deadlineOf,
  decide,
  delayOf,
  formatDuration,
  formatTokens,
  horizonOf,
  isTtl,
  limitOf,
  missCostOf,
  noticeOf,
  outcomeOf,
  promptTokensOf,
  usageOf,
} from "./warmer";

const PANE = "cache-warmer";
const CONFIG_KEY = "cache-warmer.ttl";
const IDLE_KEYS = {
  "5m": "cache-warmer.idle5m",
  "1h": "cache-warmer.idle1h",
} as const;
const BAND_KEY = "cache-warmer.band";
const ALL_TIME_KEY = "allTime";
const FORK_PROMPT =
  "[cache-warmer] Automated prompt cache refresh by the cache-warmer plugin, not a message from the user. Reply with the single word ok.";
const NOTICE_MS = 5000;
const FRAME_MS = 33;
// The preview's warm and cold notices, in milliseconds after it starts.
const PREVIEW_WARMED_MS = 6000;
const PREVIEW_COLD_MS = 11_500;
// How long before the pane opened a stopped warmer's Clawd fell asleep, so he shows already dozing.
const DOZED_MS = 2000;

const ttl = atom({ plugin: "cache-warmer", key: "ttl" } as const, "5m");
const defaultTtl = atom(
  { plugin: "cache-warmer", key: "defaultTtl" } as const,
  "5m",
);
const isSessionTtl = atom(
  { plugin: "cache-warmer", key: "isSessionTtl" } as const,
  false,
);
const idleLimits = atom(
  { plugin: "cache-warmer", key: "idleLimits" } as const,
  { "5m": IDLE_LIMIT_DEFAULT, "1h": IDLE_LIMIT_DEFAULT },
);
const isForced = atom(
  { plugin: "cache-warmer", key: "isForced" } as const,
  false,
);
const isLocked = atom(
  { plugin: "cache-warmer", key: "isLocked" } as const,
  false,
);
const isDebug = atom(
  { plugin: "cache-warmer", key: "isDebug" } as const,
  false,
);
const bandStyle = atom(
  { plugin: "cache-warmer", key: "bandStyle" } as const,
  "default",
);
const page = atom({ plugin: "cache-warmer", key: "page" } as const, "main");
const refreshes = atom(
  { plugin: "cache-warmer", key: "refreshes" } as const,
  [],
);
const status = atom({ plugin: "cache-warmer", key: "status" } as const, {
  state: "waiting",
});
const notice = atom({ plugin: "cache-warmer", key: "notice" } as const, null);
const totals = atom(
  { plugin: "cache-warmer", key: "totals" } as const,
  ZERO_TOTALS,
);
const allTime = atom({ plugin: "cache-warmer", key: "allTime" } as const, {
  ...ZERO_TOTALS,
  since: 0,
});
const now = atom({ plugin: "cache-warmer", key: "now" } as const, 0);
const warming = atom({ plugin: "cache-warmer", key: "warming" } as const, {
  anchor: null,
  isRunning: false,
  outputTokens: DEFAULT_OUTPUT_TOKENS,
});

let timer: Timer | undefined;
let animation: Timer | undefined;
let hideNotice: Timer | undefined;
let previewSteps: Timer[] = [];
let isStill = false;
// Claude Code's theme, "auto" resolved to "light" or "dark".
let theme = "dark";
// The pane's and the band's requestIds while they draw Clawd, each with the
// color behind him there; blits repaint him in each.
const sites = new Map<string, number>();
let paneSince = 0;
let isPainting = false;
let syncs = 0;
// The anchor a refresh has claimed, one object per refresh; schedule() leaves
// the anchor until chain() records the refresh.
let forking: { at: number } | undefined;
// Debug log appends and all-time store updates each run one at a time, since
// each reads and rewrites the whole value; a failed one is logged and the next runs.
let debugWrites = Promise.resolve();
let allTimeWrites = Promise.resolve();

type Scene = Pick<Notice, "mood" | "startedAt" | "since">;

type DebugLine =
  | (Omit<Refresh, "at"> & { at: string; phase: "run" | "idle"; ttl: Ttl })
  | { at: string; reason: string };

const effectiveTtl = async ($: EngineInterface): Promise<Ttl> =>
  (await read($, isForced)) ? "5m" : read($, ttl);

const debugPathOf = async ($: EngineInterface) => {
  const configDir = await $.env.get("CLAUDE_CONFIG_DIR");
  const home = await $.env.get("HOME");
  if (configDir === undefined && home === undefined)
    throw new Error("neither CLAUDE_CONFIG_DIR nor HOME is set");
  return `${configDir ?? `${home}/.claude`}/cache-warmer/debug/${await $.session.id()}.jsonl`;
};

const appendDebug = async ($: EngineInterface, line: DebugLine) => {
  try {
    const path = await debugPathOf($);
    const before = (await $.fs.exists(path)) ? await $.fs.read(path) : "";
    await $.fs.write(path, `${before}${JSON.stringify(line)}\n`);
  } catch (error) {
    $.ui.log(
      `Cache warmer could not write its debug log: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

// While debug mode is on, one JSON line per refresh and per stop; a failed write is logged and warming goes on.
const logDebug = async ($: EngineInterface, line: DebugLine) => {
  if (!(await read($, isDebug))) return;
  debugWrites = debugWrites.then(() => appendDebug($, line));
  await debugWrites;
};

// SAFETY: only addToTotals and startSession write ALL_TIME_KEY, always as AllTime; the store's JSON round trip keeps it.
const storedAllTime = async ($: EngineInterface) =>
  (await $.store.get(ALL_TIME_KEY)) as AllTime | undefined;

const addToAllTime = async ($: EngineInterface, delta: Partial<Totals>) => {
  const next = addTotals(
    (await storedAllTime($)) ?? { ...ZERO_TOTALS, since: await $.clock.now() },
    delta,
  );
  await $.store.set(ALL_TIME_KEY, next);
  await update($, allTime, () => next);
};

// This session's totals and the all-time totals in $.store take the same delta.
const addToTotals = async ($: EngineInterface, delta: Partial<Totals>) => {
  await update($, totals, (current) => addTotals(current, delta));
  allTimeWrites = allTimeWrites.then(async () => {
    try {
      await addToAllTime($, delta);
    } catch (error) {
      $.ui.log(
        `Cache warmer could not save its all-time totals: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  await allTimeWrites;
};

const reportStop = async ($: EngineInterface, reason: string) => {
  await update($, status, (): Status => ({ state: "stopped", reason }));
  await logDebug($, {
    at: new Date(await $.clock.now()).toISOString(),
    reason,
  });
};

// Compaction, /clear, a session's end and a model switch forget the chain:
// only the next prompt's turn.step starts warming again, and the chain's fee
// is wasted now, since no prompt will judge it.
const forget = async ($: EngineInterface, reason: string) => {
  timer?.cancel();
  timer = undefined;
  const { anchor } = await read($, warming);
  if (anchor && anchor.feeUsd > 0)
    await addToTotals($, { wastedUsd: anchor.feeUsd });
  await update($, warming, (current): Warming => ({
    ...current,
    anchor: null,
  }));
  await reportStop($, reason);
};

// Stops the chain anchored at `at`, adding `feeUsd` to it, until the next
// prompt; a prompt that replaced it meanwhile keeps its own warming. A timer
// left for it finds it stopped. Answers whether it stopped that chain.
const stopChain = async (
  $: EngineInterface,
  at: number,
  reason: string,
  feeUsd = 0,
) => {
  let isStopped = false;
  await update($, warming, (state): Warming => {
    const { anchor } = state;
    isStopped = anchor?.at === at && !anchor.isStopped;
    if (!anchor || !isStopped) return state;
    return {
      ...state,
      anchor: { ...anchor, feeUsd: anchor.feeUsd + feeUsd, isStopped: true },
    };
  });
  if (isStopped) await reportStop($, reason);
  return isStopped;
};

// A running turn stops at the run horizon; an idle session after its lifetime's idle limit.
// The anchor is read last, so the timer is set from the anchor as it stands:
// a refresh that settled while an earlier read waited cannot leave a stale one.
const schedule = async ($: EngineInterface) => {
  const limits = await read($, idleLimits);
  const at = await $.clock.now();
  const { anchor: current, isRunning, outputTokens } = await read($, warming);
  if (!current || current.isStopped || current.at === forking?.at) return;
  const phase = isRunning ? "run" : "idle";
  const nextAt = current.lastAt + delayOf(current.ttl);
  const horizon = horizonOf(current.ttl);
  if (phase === "run" && nextAt > current.at + horizon)
    return stopChain(
      $,
      current.at,
      `${formatDuration(horizon)} run limit reached`,
    );
  const limit = limits[current.ttl];
  if (phase === "idle" && current.idleRefreshes >= limit)
    return stopChain($, current.at, `${limit} idle refreshes reached`);
  const decision = decide(
    current.model,
    current.promptTokens,
    current.ttl,
    phase,
    outputTokens,
  );
  if (!decision)
    return stopChain($, current.at, `no price for ${current.model}`);
  if (decision.reason) return stopChain($, current.at, decision.reason);
  timer?.cancel();
  timer = $.clock.after(Math.max(0, nextAt - at), () => void refresh($));
  await update($, status, (): Status => ({
    state: "scheduled",
    nextAt,
    phase,
    expectedUsd: decision.expectedUsd,
  }));
};

const isPaneOpen = async ($: EngineInterface) =>
  (await $.ui.panes()).some((pane) => pane.id === PANE);

// Under "auto", a light background in COLORFGBG means light. Claude Code also
// asks the terminal under "auto"; plugins cannot read that answer.
const themeOf = async ($: EngineInterface): Promise<string> => {
  const chosen = String(
    (await $.config.list()).find((row) => row.key === "theme")?.value ?? "auto",
  );
  if (chosen !== "auto") return chosen;
  const background = Number((await $.env.get("COLORFGBG"))?.split(";").at(-1));
  return background === 7 || (background >= 9 && background <= 15)
    ? "light"
    : "dark";
};

// A docked pane is drawn on Claude Code's composerSidebarBackground (as of
// 2.1.289); its ANSI themes name a terminal color, which a Raster cannot.
const dockBackgroundOf = (name: string) => {
  if (name === "dark" || name === "dark-daltonized") return 0x262626;
  if (name === "light") return 0xf5f5f5;
  if (name === "light-daltonized") return 0xebebeb;
  return TERMINAL_DEFAULT;
};

// Reduced motion draws one frame: Clawd standing, the steam mid-rise.
const mascotOf = (scene: Scene, at: number, background: number) => {
  const palette = theme.startsWith("light") ? "light" : "dark";
  return isStill
    ? cellsOf(1, scene.mood, 3, palette, background)
    : cellsOf(
        (at - scene.startedAt) / 1000,
        scene.mood,
        (at - scene.since) / 1000,
        palette,
        background,
      );
};

// The pane plays the notice while one is up, and otherwise the
// warmer's state: Clawd sips while it warms and dozes once it stopped.
const sceneOf = async ($: EngineInterface): Promise<Scene> => {
  const shown = await read($, notice);
  if (shown) return shown;
  const isStopped = (await read($, status)).state === "stopped";
  return {
    mood: isStopped ? "cold" : "warming",
    startedAt: paneSince,
    since: paneSince - DOZED_MS,
  };
};

// A refused blit means a site no longer shows Clawd: the pane closed or left
// the main page, or the band's notice went. Painting there resumes when it
// draws Clawd again.
const paint = async ($: EngineInterface) => {
  if (isPainting || sites.size === 0) return;
  isPainting = true;
  try {
    const at = await $.clock.now();
    for (const [requestId, background] of sites) {
      const answer = await $.ui.blit({
        requestId,
        key: MASCOT_KEY,
        cells: mascotOf(await sceneOf($), at, background),
      });
      if (answer.deny !== undefined) sites.delete(requestId);
    }
  } finally {
    isPainting = false;
  }
};

// Frames run while the pane is open or the band shows Clawd with a notice.
// A theme change shows from the next start. The latest call decides: one that
// a later call overtook while it waited leaves the timer alone.
const syncAnimation = async ($: EngineInterface) => {
  const call = ++syncs;
  const isShown =
    ((await read($, notice)) !== null &&
      (await read($, bandStyle)) === "default") ||
    (await isPaneOpen($));
  const resolved = isShown && !animation ? await themeOf($) : theme;
  if (call !== syncs) return;
  theme = resolved;
  if (!isShown) {
    animation?.cancel();
    animation = undefined;
  } else if (!animation && !isStill)
    animation = $.clock.every(FRAME_MS, () => void paint($));
};

const clearNotice = async ($: EngineInterface) => {
  await update($, notice, () => null);
  await syncAnimation($);
};

const showNotice = async (
  $: EngineInterface,
  shown: Pick<Notice, "ttl" | "head" | "detail" | "mood">,
  isDone: boolean,
) => {
  hideNotice?.cancel();
  hideNotice = undefined;
  const at = await $.clock.now();
  await update($, notice, (current): Notice => ({
    ...shown,
    startedAt: current?.startedAt ?? at,
    since: current?.mood === shown.mood ? current.since : at,
  }));
  await syncAnimation($);
  if (isDone) hideNotice = $.clock.after(NOTICE_MS, () => void clearNotice($));
};

const record = async (
  $: EngineInterface,
  entry: Refresh,
  phase: "run" | "idle",
  entryTtl: Ttl,
) => {
  await update($, refreshes, (list) => [...list, entry].slice(-200));
  await addToTotals($, { refreshes: 1, costUsd: entry.costUsd ?? 0 });
  await logDebug($, {
    ...entry,
    at: new Date(entry.at).toISOString(),
    phase,
    ttl: entryTtl,
  });
};

// Moves a warm refresh's chain on, when the chain is still current; answers whether it was.
const extend = async (
  $: EngineInterface,
  current: Anchor,
  entry: Refresh,
  phase: "run" | "idle",
) => {
  let isChained = false;
  await update($, warming, (state): Warming => {
    const { anchor } = state;
    isChained = anchor?.at === current.at && !anchor.isStopped;
    if (!anchor || !isChained) return state;
    return {
      ...state,
      outputTokens: entry.usage?.output || DEFAULT_OUTPUT_TOKENS,
      anchor: {
        ...anchor,
        lastAt: entry.at,
        refreshes: anchor.refreshes + 1,
        idleRefreshes: anchor.idleRefreshes + (phase === "idle" ? 1 : 0),
        feeUsd: anchor.feeUsd + (entry.costUsd ?? 0),
      },
    };
  });
  return isChained;
};

// The chain carries each refresh's fee. A refresh that a prompt overtook
// during its fork kept nothing that prompt read, so its fee is wasted; so is
// one whose chain was forgotten. Each check runs inside the write, so a stop
// or a prompt that lands meanwhile wins.
const chain = async (
  $: EngineInterface,
  current: Anchor,
  entry: Refresh,
  phase: "run" | "idle",
) => {
  const costUsd = entry.costUsd ?? 0;
  const isWarmed = entry.result === "warmed";
  const reason =
    entry.result === "expired" ? "cache had expired" : "refresh failed";
  const isChained = isWarmed
    ? await extend($, current, entry, phase)
    : await stopChain($, current.at, reason, costUsd);
  // The anchor holds this refresh now, so scheduling it cannot fork it twice.
  if (forking?.at === current.at) forking = undefined;
  if (!isChained) {
    if (costUsd > 0) await addToTotals($, { wastedUsd: costUsd });
    return;
  }
  if (isWarmed) await schedule($);
};

const settle = async (
  $: EngineInterface,
  current: Anchor,
  at: number,
  phase: "run" | "idle",
  missUsd: number,
  reply: ForkReply,
) => {
  const usage = usageOf(reply.usage);
  // The fork's own write is its short tail; pricing it at the entry's lifetime overstates it at most.
  const costUsd = costOf(current.model, usage, current.ttl);
  const outcome = outcomeOf(reply, usage, current.promptTokens);
  const savesUsd =
    outcome.result === "warmed" && costUsd !== null ? missUsd - costUsd : null;
  const entry: Refresh = {
    at,
    model: current.model,
    usage,
    costUsd,
    savesUsd,
    ...outcome,
  };
  await record($, entry, phase, current.ttl);
  const { head, detail } = noticeOf(entry);
  await showNotice(
    $,
    {
      ttl: current.ttl,
      head,
      detail,
      mood: entry.result === "warmed" ? "warmed" : "cold",
    },
    true,
  );
  // A prompt that arrived during the fork set a new anchor and its own timer.
  await chain($, current, entry, phase);
  // A notice row: the transcript file keeps the refresh, and no request carries it.
  try {
    await $.session.append({
      message: {
        type: "system",
        content: [
          { type: "text", text: `☕ ${current.ttl} · ${head} · ${detail}` },
        ],
      },
    });
  } catch (error) {
    $.ui.log(
      `Cache warmer could not record the refresh: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const forkFor = async (
  $: EngineInterface,
  current: Anchor,
  phase: "run" | "idle",
  outputTokens: number,
) => {
  const at = await $.clock.now();
  if (at > deadlineOf(current.lastAt, current.ttl))
    return stopChain($, current.at, "refresh deadline missed");
  const decision = decide(
    current.model,
    current.promptTokens,
    current.ttl,
    phase,
    outputTokens,
  );
  if (!decision)
    return stopChain($, current.at, `no price for ${current.model}`);
  if (decision.reason) return stopChain($, current.at, decision.reason);
  await update($, status, (): Status => ({ state: "refreshing" }));
  stopPreview();
  await showNotice(
    $,
    {
      ttl: current.ttl,
      head: "Refreshing cache",
      detail: `resending the cached ${formatTokens(current.promptTokens)}-token prompt…`,
      mood: "warming",
    },
    false,
  );
  const reply = await $.model.fork({ prompt: FORK_PROMPT });
  if (!reply.isAnswered && reply.reason === "nothing-to-fork") {
    await showNotice(
      $,
      { ttl: current.ttl, head: "Nothing to warm", detail: "", mood: "cold" },
      true,
    );
    return stopChain($, current.at, "nothing to refresh");
  }
  await settle($, current, at, phase, decision.missUsd, reply);
};

// The refresh claims its anchor until chain() records it there, so a
// schedule() meanwhile, from a turn that ended, cannot fork it again.
const refresh = async ($: EngineInterface) => {
  timer = undefined;
  const { anchor: current, isRunning, outputTokens } = await read($, warming);
  if (!current || current.isStopped || current.at === forking?.at) return;
  const claim = { at: current.at };
  forking = claim;
  try {
    await forkFor($, current, isRunning ? "run" : "idle", outputTokens);
  } finally {
    if (forking === claim) forking = undefined;
  }
};

const setTtl = async ($: EngineInterface, value: Ttl) => {
  await $.env.set("CLAUDE_CODE_PROMPT_CACHE_TTL", value);
  await update($, ttl, () => value);
};

const describeTtl = async ($: EngineInterface) => {
  const chosen = await read($, ttl);
  if (await read($, isForced))
    return `Cache lifetime ${chosen}, overridden to 5m by FORCE_PROMPT_CACHING_5M.`;
  return `Cache lifetime ${chosen}; refreshes every ${formatDuration(delayOf(chosen))}. The next request rewrites the cache once.`;
};

const lockedReason = async ($: EngineInterface) =>
  (await read($, isLocked))
    ? `the cache is written at ${await read($, ttl)} for this session; /clear or a new session unlocks it`
    : undefined;

// A saved default reaches this session only while no response has locked its lifetime.
const applyDefault = async ($: EngineInterface, value: Ttl) => {
  await update($, defaultTtl, () => value);
  if (await read($, isLocked)) return;
  await update($, isSessionTtl, () => false);
  await setTtl($, value);
};

const logDenied = ($: EngineInterface, what: string, reason: string) =>
  $.ui.log(`Cache warmer could not save the ${what}: ${reason}`);

// The command sets this session and the saved default, and refuses once locked.
// $.config.set skips this plugin's own config.set hook, so each caller applies the value itself.
const chooseTtl = async ($: EngineInterface, value: Ttl) => {
  const locked = await lockedReason($);
  if (locked) return `Cache lifetime unchanged: ${locked}`;
  const answer = await $.config.set({ key: CONFIG_KEY, value });
  if (answer.deny !== undefined)
    return `Cache lifetime unchanged: ${answer.deny}`;
  await applyDefault($, value);
  return describeTtl($);
};

// The Global page saves the default even while this session is locked.
const chooseDefault = async ($: EngineInterface, value: Ttl) => {
  const answer = await $.config.set({ key: CONFIG_KEY, value });
  if (answer.deny !== undefined)
    return logDenied($, "default lifetime", answer.deny);
  await applyDefault($, value);
};

// The Session page changes this session alone, not the saved default.
const chooseSessionTtl = async ($: EngineInterface, value: Ttl) => {
  if (await read($, isLocked)) return;
  await update($, isSessionTtl, () => true);
  await setTtl($, value);
};

// A new limit applies to the warming under way; a refresh in flight schedules itself when it settles.
const setLimit = async ($: EngineInterface, limitTtl: Ttl, count: number) => {
  const value = limitOf(count);
  const answer = await $.config.set({ key: IDLE_KEYS[limitTtl], value });
  if (answer.deny !== undefined)
    return logDenied($, `${limitTtl} idle limit`, answer.deny);
  await update($, idleLimits, (limits) => ({ ...limits, [limitTtl]: value }));
  if ((await read($, status)).state === "scheduled") await schedule($);
};

const bandStyleOf = (value: ConfigValue | undefined): BandStyle =>
  value === "simplified" || value === "off" ? value : "default";

const applyBand = async ($: EngineInterface, value: BandStyle) => {
  await update($, bandStyle, () => value);
  await syncAnimation($);
};

const setBand = async ($: EngineInterface, value: BandStyle) => {
  const answer = await $.config.set({ key: BAND_KEY, value });
  if (answer.deny !== undefined) return logDenied($, "band style", answer.deny);
  await applyBand($, bandStyleOf(answer.value));
};

const tick = async ($: EngineInterface) => {
  if (!(await isPaneOpen($))) return;
  const at = await $.clock.now();
  await update($, now, () => at);
};

// A reload from 0.5 kept state written without the 0.6 fields.
const migrate = async ($: EngineInterface) => {
  await update($, totals, (current) => ({ ...ZERO_TOTALS, ...current }));
  await update($, warming, (current): Warming => ({
    ...current,
    anchor: current.anchor && {
      ...current.anchor,
      idleRefreshes: current.anchor.idleRefreshes ?? 0,
      feeUsd: current.anchor.feeUsd ?? 0,
    },
  }));
  // 0.6.3's Debug page is now the menu's toggle.
  await update($, page, (current) =>
    ["config", "analytics"].includes(current) ? current : "main",
  );
};

const startSession = async (
  $: EngineInterface,
  option: Ttl,
  limits: IdleLimits,
  band: BandStyle,
) => {
  await $.command.register({
    name: "cache-warmer",
    description:
      "Toggle the cache warmer pane, set the prompt cache lifetime, or preview the band",
    argumentHint: "[5m|1h|preview]",
  });
  const forced = await $.env.get("FORCE_PROMPT_CACHING_5M");
  await update($, isForced, () => forced === "1" || forced === "true");
  await update($, defaultTtl, () => option);
  await update($, idleLimits, () => limits);
  await update($, bandStyle, () => band);
  // A reload after the first response keeps the lifetime the cache was written
  // with, and one after a Session page choice keeps that choice.
  const isKept = (await read($, isLocked)) || (await read($, isSessionTtl));
  await setTtl($, isKept ? await read($, ttl) : option);
  await migrate($);
  const stored = await storedAllTime($);
  const total = stored ?? { ...ZERO_TOTALS, since: await $.clock.now() };
  if (!stored) await $.store.set(ALL_TIME_KEY, total);
  await update($, allTime, () => total);
  isStill = (await $.config.list()).some(
    (row) => row.key === "reduceMotion" && row.value === true,
  );
  $.clock.every(1000, () => void tick($));
  // A reload cancels the old timers: drop a notice left up, re-arm warming
  // and animate a pane left open.
  await update($, notice, () => null);
  await schedule($);
  paneSince = await $.clock.now();
  await syncAnimation($);
};

const stopPreview = () => {
  for (const step of previewSteps) step.cancel();
  previewSteps = [];
};

// Plays the band a refresh shows, without a fork: warming, warmed, then cold.
const preview = async ($: EngineInterface) => {
  stopPreview();
  const shownTtl = await effectiveTtl($);
  const step = (head: string, mood: Notice["mood"], isDone: boolean) =>
    showNotice($, { ttl: shownTtl, head, detail: "preview", mood }, isDone);
  await step("Refreshing cache", "warming", false);
  previewSteps = [
    $.clock.after(
      PREVIEW_WARMED_MS,
      () => void step("Cache warmed", "warmed", false),
    ),
    $.clock.after(
      PREVIEW_COLD_MS,
      () => void step("Cache had expired", "cold", true),
    ),
  ];
};

const runCommand = async ($: EngineInterface, args: string) => {
  const arg = args.trim();
  if (isTtl(arg)) return { text: await chooseTtl($, arg) };
  if (arg === "preview") {
    if ((await read($, status)).state === "refreshing")
      return { text: "A refresh is running; the band shows it now." };
    await preview($);
    return { text: "Cache warmer band preview started." };
  }
  if (arg) return { text: "Usage: /cache-warmer [5m|1h|preview]" };
  const shown = (await $.ui.panes()).find((pane) => pane.id === PANE);
  if (shown?.isFocused) {
    await $.ui.close({ id: PANE });
    await syncAnimation($);
    return { text: "Cache warmer closed." };
  }
  // An open pane without the keyboard takes it back on the main page instead of closing.
  if (!shown) paneSince = await $.clock.now();
  await update($, page, (): Page => "main");
  await $.ui.open({
    id: PANE,
    title: "Cache warmer",
    rows: 14,
    focus: true,
    closeOnEscape: true,
  });
  await syncAnimation($);
  return { text: shown ? "Cache warmer focused." : "Cache warmer opened." };
};

// A prompt is kept when it read an entry that would have expired without the
// refreshes since the last prompt; it avoided rewriting the tokens it read.
// Otherwise the previous chain's fee is wasted.
const judgeChain = async (
  $: EngineInterface,
  previous: Anchor | null,
  at: number,
  cacheRead: number,
) => {
  if (!previous) return;
  const isKept =
    previous.refreshes > 0 &&
    at - previous.at > TTL_MS[previous.ttl] &&
    cacheRead >= previous.promptTokens / 2;
  const keptUsd = isKept
    ? missCostOf(previous.model, cacheRead, previous.ttl)
    : null;
  if (keptUsd !== null) await addToTotals($, { kept: 1, keptUsd });
  else if (previous.feeUsd > 0)
    await addToTotals($, { wastedUsd: previous.feeUsd });
};

const stepTurn = async function* (
  $: EngineInterface,
  e: Frozen<Args<"turn.step">>,
  next: StreamNext<"turn.step">,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if (e.agentId !== undefined) return yield* next(e);
  const at = await $.clock.now();
  const before = (await read($, warming)).anchor;
  // The lifetime this request is sent with; a choice made while it runs applies to the next one.
  const entryTtl = await effectiveTtl($);
  const result = yield* next(e);
  if (!result.usage) return result;
  await update($, isLocked, () => true);
  const usage = usageOf(result.usage);
  await judgeChain($, before, at, usage.cacheRead);
  // Refreshes that settled while this request ran came after it, so they start the new chain.
  const after = (await read($, warming)).anchor;
  const isSameChain = before !== null && after?.at === before.at;
  const model = result.usage.model;
  await update($, warming, (current): Warming => ({
    ...current,
    anchor: {
      at,
      lastAt: at,
      model,
      promptTokens: promptTokensOf(usage),
      ttl: entryTtl,
      refreshes: isSameChain ? after.refreshes - before.refreshes : 0,
      idleRefreshes: 0,
      feeUsd: isSameChain ? after.feeUsd - before.feeUsd : 0,
      isStopped: false,
    },
  }));
  await schedule($);
  return result;
};

const onTurnStart: Hook<"turn.start"> = async ($, e, next) => {
  await update($, warming, (current): Warming => ({
    ...current,
    isRunning: true,
  }));
  return next(e);
};

const onTurnComplete: Hook<"turn.complete"> = async ($, e, next) => {
  if (e.agentId === undefined) {
    await update($, warming, (current): Warming => ({
      ...current,
      isRunning: false,
    }));
    await schedule($);
  }
  return next(e);
};

// /config saves the default whatever the lock; applyDefault decides whether this session follows.
const onTtlConfigSet: Hook<"config.set"> = async ($, e, next) => {
  const answer = await next(e);
  const value = String(answer.value);
  if (answer.deny === undefined && isTtl(value)) await applyDefault($, value);
  return answer;
};

// /config clamps an idle limit to 0..20 before saving it.
const setIdleFromConfig = async (
  $: EngineInterface,
  e: Frozen<Args<"config.set">>,
  next: Next<"config.set">,
  limitTtl: Ttl,
) => {
  const answer = await next({ ...e, value: limitOf(e.value) });
  if (answer.deny === undefined) {
    const value = limitOf(answer.value);
    await update($, idleLimits, (limits) => ({ ...limits, [limitTtl]: value }));
    if ((await read($, status)).state === "scheduled") await schedule($);
  }
  return answer;
};

const renderBand = async (
  $: EngineInterface,
  e: Frozen<MatchedEvent<"ui.render", { component: "AbovePrompt" }>>,
) => {
  const shown = await read($, notice);
  const style = await read($, bandStyle);
  sites.delete(e.requestId);
  if (!shown || e.props.hasSurvey || style === "off") return undefined;
  if (
    style === "simplified" ||
    e.surface !== "terminal" ||
    e.props.maxRows < MASCOT_ROWS
  )
    return bandOf($.ui.resolve(e), shown);
  sites.set(e.requestId, TERMINAL_DEFAULT);
  const elements = $.ui.resolve(e);
  const cells = mascotOf(shown, await $.clock.now(), TERMINAL_DEFAULT);
  return mascotBandOf(elements, shown, rasterOf(elements, cells));
};

const renderPane = async (
  $: EngineInterface,
  e: Frozen<
    MatchedEvent<"ui.render", { component: "Pane"; requestId: typeof PANE }>
  >,
) => {
  const shown = await read($, page);
  const debugOn = await read($, isDebug);
  const data: PaneData = {
    page: shown,
    chosen: await read($, ttl),
    saved: await read($, defaultTtl),
    limits: await read($, idleLimits),
    isForced: await read($, isForced),
    isLocked: await read($, isLocked),
    isDebug: debugOn,
    bandStyle: await read($, bandStyle),
    state: await read($, status),
    totals: await read($, totals),
    allTime: await read($, allTime),
    list: await read($, refreshes),
    logPath: shown === "main" && debugOn ? await debugPathOf($) : "",
    at: Math.max(await read($, now), await $.clock.now()),
    width: e.props.bodyColumns,
    rows: e.props.scroll.bodyRows,
  };
  let mascot: Mascot | undefined;
  sites.delete(PANE);
  const scene = await sceneOf($);
  const layout = shown === "main" ? layoutOf(data) : undefined;
  if (e.surface === "terminal" && layout) {
    const background =
      e.props.placement === "dock" ? dockBackgroundOf(theme) : TERMINAL_DEFAULT;
    sites.set(PANE, background);
    const cells = mascotOf(scene, data.at, background);
    mascot = { raster: rasterOf($.ui.resolve(e), cells), layout };
  }
  const actions: PaneActions = {
    open: (next) => void update($, page, () => next),
    toggleDebug: () => void update($, isDebug, (current) => !current),
    setBand: (value) => void setBand($, value),
    chooseDefault: (value) => void chooseDefault($, value),
    chooseSession: (value) => void chooseSessionTtl($, value),
    setLimit: (limitTtl, count) => void setLimit($, limitTtl, count),
  };
  return paneOf($.ui.resolve(e), data, actions, mascot);
};

export const register: Register = (on, options) => {
  const chosen = String(options.ttl);
  const option = isTtl(chosen) ? chosen : "5m";
  const limits = {
    "5m": limitOf(options.idle5m ?? IDLE_LIMIT_DEFAULT),
    "1h": limitOf(options.idle1h ?? IDLE_LIMIT_DEFAULT),
  };
  const band = bandStyleOf(options.band);
  on("session.start", async ($, e, next) => {
    await startSession($, option, limits, band);
    return next(e);
  });
  on("command.run", { command: "cache-warmer" }, ($, e) =>
    runCommand($, e.args),
  );
  on("config.set", { key: CONFIG_KEY }, onTtlConfigSet);
  on("config.set", { key: "cache-warmer.idle5m" }, ($, e, next) =>
    setIdleFromConfig($, e, next, "5m"),
  );
  on("config.set", { key: "cache-warmer.idle1h" }, ($, e, next) =>
    setIdleFromConfig($, e, next, "1h"),
  );
  on("config.set", { key: BAND_KEY }, async ($, e, next) => {
    const answer = await next(e);
    if (answer.deny === undefined)
      await applyBand($, bandStyleOf(answer.value));
    return answer;
  });
  on("turn.start", onTurnStart);
  on("turn.step", async function* ($, e, next) {
    return yield* stepTurn($, e, next);
  });
  on("turn.complete", onTurnComplete);
  on("session.compact", async ($, e, next) => {
    const answer = await next(e);
    if (e.agentId === undefined) await forget($, "conversation compacted");
    return answer;
  });
  // Every ending forgets the chain, so its fee is settled before the process can exit.
  on("session.end", async ($, e, next) => {
    if (e.reason !== "clear") await forget($, "session ended");
    else {
      await forget($, "conversation cleared");
      await update($, isLocked, () => false);
      // /clear starts a new session id without session.start, so it takes the saved default here.
      await applyDefault($, await read($, defaultTtl));
    }
    return next(e);
  });
  on("classic.PostModelSwitch", async ($, e, next) => {
    await forget($, "model switched");
    return next(e);
  });
  on(
    "ui.render",
    { component: "AbovePrompt" },
    async ($, e, next) => (await renderBand($, e)) ?? next(e),
  );
  on("ui.render", { component: "Pane", requestId: PANE }, renderPane);
  on("ui.close", { id: PANE }, async ($, e, next) => {
    const answer = await next(e);
    await syncAnimation($);
    return answer;
  });
};
