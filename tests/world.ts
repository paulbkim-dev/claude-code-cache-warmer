import { expect, mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { AllTime } from "../types";
import type {
  ConfigRow,
  ModelForkResult,
  On,
  PaneOpenArgs,
  RenderElement,
  TurnUsage,
} from "claude-code";

export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";
export const START = 1_000_000;
export const MINUTE = 60_000;
export const SESSION_ID = "s-test";

export const turnUsage = (
  model: string,
  cacheRead: number,
  cacheWrite: number,
): TurnUsage => ({
  model,
  input_tokens: 0,
  output_tokens: 5,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

// A refresh of the 200k-token Opus prompt: (16*4 + 30*5 + 199,990*0.2 + 182*20) / 1e6 = $0.043852.
export const WARMED: ModelForkResult = {
  isAnswered: true,
  text: "ok",
  usage: {
    input_tokens: 16,
    output_tokens: 182,
    cache_read_input_tokens: 199_990,
    cache_creation_input_tokens: 30,
  },
};

export const stubPanes = (on: On) => {
  const panes = new Set<string>();
  const opened: PaneOpenArgs[] = [];
  on("ui.panes", () => ({
    value: [...panes].map((id) => ({
      id,
      title: "Cache warmer",
      isShown: true,
      isFocused: false,
      isPlaced: true,
    })),
  }));
  on("ui.open", (_, e) => {
    opened.push(e);
    panes.add(e.id);
    return { value: { isPlaced: true } };
  });
  on("ui.close", (_, e) => {
    panes.delete(e.id);
    return { value: undefined };
  });
  return { opened, panes };
};

const stubBlits = (on: On) => {
  const blits: { requestId: string; key: string; cells: string }[] = [];
  on("ui.blit", (_, e) => {
    blits.push({
      requestId: e.requestId,
      key: e.key,
      cells: "cells" in e ? e.cells : "",
    });
    return { value: {} };
  });
  return blits;
};

// The /config rows the mod lists, and each value it sets.
const stubConfig = (on: On, config: ConfigRow[]) => {
  const configSets: unknown[] = [];
  on("config.set", (_, e) => {
    configSets.push(e.value);
    return { value: e.value };
  });
  on("config.list", () => ({ value: config }));
  return configSets;
};

// The mod's $.store, held in memory where a test can read it.
// holdStoreSet makes the next store.set wait for `until`, then save, or fail when it rejects.
const stubStore = (on: On, entries: Record<string, AllTime>) => {
  const stored = new Map<string, unknown>(Object.entries(entries));
  let held: (() => Promise<void>) | undefined;
  on("store.get", (_, e) => ({ value: stored.get(e.key) }));
  on("store.set", async (_, e) => {
    const until = held;
    held = undefined;
    await until?.();
    stored.set(e.key, e.value);
    return { value: undefined };
  });
  const holdStoreSet = (until: () => Promise<void>) => {
    held = until;
  };
  return { stored, holdStoreSet };
};

// Files the mod reads and writes, held in memory; each write is recorded whole.
const stubFiles = (on: On) => {
  const files = new Map<string, string>();
  const writes: { path: string; text: string }[] = [];
  on("fs.exists", (_, e) => ({ value: files.has(e.path) }));
  on("fs.read", (_, e) => {
    const text = files.get(e.path);
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: text };
  });
  on("fs.write", (_, e) => {
    files.set(e.path, e.text);
    writes.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  return { files, writes };
};

// Forks answer WARMED unless a test queues replies; each prompt runs one turn of one step.
const stubTurns = (on: On) => {
  const forks: string[] = [];
  const replies: ModelForkResult[] = [];
  on("model.fork", (_, e) => {
    forks.push(e.prompt);
    return { value: replies.shift() ?? WARMED };
  });
  let next: TurnUsage = turnUsage(OPUS, 199_000, 1000);
  on("turn.step", async function* (_, e) {
    yield { kind: "stop", stopReason: "end_turn", usage: next };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "",
      toolUses: [],
      stopReason: "end_turn",
      usage: next,
    };
  });
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  const prompt = async ($: Engine, turnId: string, usage?: TurnUsage) => {
    if (usage) next = usage;
    await $.turn.start({ text: "x", turnId });
    for await (const _ of $.turn.step({
      turnId,
      index: 0,
      model: next.model,
      messageCount: 1,
    })) {
      // drain the stream
    }
    await $.turn.complete({
      answer: "ACK",
      durationMs: 5,
      isAborted: false,
      turnId,
      reason: "answer",
    });
  };
  return { forks, prompt, replies };
};

export const world = (
  on: On,
  env: Record<string, string> = {},
  config: ConfigRow[] = [],
  store: Record<string, AllTime> = {},
) => {
  const clock = mock.clock(on, { now: START });
  mock.env(on, { HOME: "/home/t", ...env });
  const { stored, holdStoreSet } = stubStore(on, store);
  const { files, writes } = stubFiles(on);
  on("session.id", () => ({ value: SESSION_ID }));
  const envSets: [string, string | undefined][] = [];
  on("env.set", (_, e) => {
    envSets.push([e.name, e.value]);
    return { value: undefined };
  });
  const configSets = stubConfig(on, config);
  on("command.register", () => ({ value: { command: "cache-warmer" } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  const { opened, panes } = stubPanes(on);
  const blits = stubBlits(on);
  // The test kit cannot answer a plugin's session.append, so each refresh reports the failed record here.
  const logged: string[] = [];
  on("ui.log", (_, e) => {
    logged.push(e.text);
    return { value: undefined };
  });
  // The engine's own band, drawn when the mod has nothing to show.
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    // SAFETY: h of a Text element with one string child draws that element.
    return h(Text, {}, "engine band") as RenderElement;
  });
  const { forks, prompt, replies } = stubTurns(on);
  return {
    blits,
    clock,
    files,
    holdStoreSet,
    stored,
    writes,
    logged,
    configSets,
    envSets,
    forks,
    opened,
    panes,
    prompt,
    replies,
  };
};

export const start = ($: Engine) =>
  $.session.start({ cwd: "/w", surface: "terminal", isInteractive: true });

export const COMMAND = {
  origin: { kind: "composer" },
  presentation: { isFullscreen: true, columns: 200 },
} as const;

export const toggle = ($: Engine) =>
  $.command.run({ ...COMMAND, command: "cache-warmer", args: "" });

// Debug mode moves the menu from the bar to the pane.
export const openPane = async ($: Engine) => {
  await toggle($);
  const bar = await mountBand($);
  await bar.press({ key: "menu:debug" });
  await bar.unmount();
};

export const mountPane = (
  $: Engine,
  surface: "terminal" | "desktop",
  { columns, bodyRows } = { columns: 200, bodyRows: 20 },
) =>
  $.ui.mount({
    plugin: "cache-warmer",
    surface,
    component: "Pane",
    requestId: "cache-warmer",
    props: {
      title: "Cache warmer",
      isFocused: true,
      bodyColumns: columns,
      placement: "dock",
      scroll: { offset: 0, bodyRows },
      view: {},
    },
    viewport: { columns: 200, rows: 24 },
  });

export const mountBand = ($: Engine) =>
  $.ui.mount({
    plugin: "cache-warmer",
    surface: "terminal",
    component: "AbovePrompt",
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 12,
      bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 12 },
      view: {},
    },
    viewport: { columns: 120, rows: 40 },
  });

export const near = (actual: number | undefined, expected: number) =>
  expect(Math.abs((actual ?? NaN) - expected)).toBeLessThan(1e-9);
