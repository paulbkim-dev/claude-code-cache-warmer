import { expect, test } from "claude-code/testing";

import {
  MINUTE,
  OPUS,
  SESSION_ID,
  START,
  mountPane,
  near,
  start,
  toggle,
  turnUsage,
  world,
} from "./world";

const clear = {
  reason: "clear",
  sessionId: "s1",
  resume: { id: "s1" },
} as const;

test("each menu item opens its page, Back returns to the menu, and reopening starts there", async ($, on) => {
  world(on, { HOME: "/home/t" });
  await start($);
  await toggle($);
  const pane = await mountPane($, "terminal");
  expect(
    await pane.find({
      text: "github.com/paulbkim-dev/claude-code-cache-warmer",
    }),
  ).toBeDefined();
  expect(await pane.find({ type: "Link" })).toBeUndefined();
  for (const [key, title] of [
    ["config", "Configuration"],
    ["analytics", "Analytics"],
  ] as const) {
    await pane.press({ key: `menu:${key}` });
    expect(await pane.find({ text: title })).toBeDefined();
    expect(await pane.find({ key: "back" })).toMatchObject({
      props: { plain: true, autoFocus: true },
    });
    await pane.press({ key: "back" });
    expect(await pane.find({ text: "Cache Warmer" })).toBeDefined();
  }
  await pane.press({ key: "menu:config" });
  await toggle($);
  await toggle($);
  expect(await pane.find({ key: "menu:config" })).toMatchObject({
    props: { autoFocus: true },
  });
  await pane.unmount();
});

test("the idle limit stops warming after that many idle refreshes; + raises it", async ($, on) => {
  const { clock, configSets, forks, prompt } = world(on);
  await start($);
  await prompt($, "t1");
  await clock.advance(60 * MINUTE);
  expect(forks).toHaveLength(5);
  const pane = await mountPane($, "terminal");
  expect(
    await pane.find({ text: /^Stopped: 5 idle refreshes reached\./ }),
  ).toBeDefined();
  await pane.press({ key: "menu:config" });
  // 5 * 4m30s + 5m, and 5 * 54m + 1h.
  expect(await pane.find({ text: "  covers 27m30s idle" })).toBeDefined();
  expect(await pane.find({ text: "  covers 5h30m idle" })).toBeDefined();
  await pane.press({ key: "idle:5m:+" });
  expect(configSets).toEqual([6]);
  expect(await pane.find({ text: "  covers 32m idle" })).toBeDefined();
  await pane.unmount();
  await prompt($, "t2");
  await clock.advance(60 * MINUTE);
  expect(forks).toHaveLength(11);
});

test("the Global default lifetime saves even when locked; this session follows only while unlocked", async ($, on) => {
  const { configSets, envSets, prompt } = world(on);
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  await start($);
  await prompt($, "t1");
  const pane = await mountPane($, "terminal");
  await pane.press({ key: "menu:config" });
  await pane.press({ key: "toggle:default" });
  expect(configSets).toEqual(["1h"]);
  expect(await pane.find({ key: "toggle:default" })).toMatchObject({
    props: { label: "○ 5m  ● 1h" },
  });
  expect(
    await pane.find({ text: /^Enter switches a setting\./ }),
  ).toBeDefined();
  // /config saves it too, without the refusal 0.5 gave.
  const answer = await $.config.set({
    key: "cache-warmer.ttl",
    value: "1h",
    previous: "1h",
    provider: { plugin: "cache-warmer", tier: "user" },
    origin: { kind: "composer" },
  });
  expect(answer.deny).toBeUndefined();
  expect(envSets).toEqual([["CLAUDE_CODE_PROMPT_CACHE_TTL", "5m"]]);
  // /clear starts a new session, which takes the saved default; unlocked, a new default applies at once.
  await $.session.end(clear);
  expect(envSets.at(-1)).toEqual(["CLAUDE_CODE_PROMPT_CACHE_TTL", "1h"]);
  await pane.press({ key: "toggle:default" });
  expect(envSets.at(-1)).toEqual(["CLAUDE_CODE_PROMPT_CACHE_TTL", "5m"]);
  await pane.unmount();
});

test(
  "analytics credit a kept prompt with the tokens it read, count unkept and forgotten fees, and add $.store's all-time totals",
  {},
  async ($, on) => {
    const since = Date.UTC(2026, 8, 1);
    const { clock, prompt, stored } = world(on, {}, [], {
      allTime: {
        since,
        refreshes: 10,
        costUsd: 1,
        wastedUsd: 0.25,
        kept: 2,
        keptUsd: 3,
      },
    });
    on("session.end", (_, e) => ({ sessionId: e.sessionId }));
    await start($);
    await prompt($, "t1");
    // One refresh at 4m30s; the prompt at 4m40s came within the lifetime, so its fee is wasted.
    await clock.advance(280_000);
    await prompt($, "t2");
    // Refreshes at 9m10s and 13m40s; the prompt at 14m40s reads 150k tokens: 150k * ($5 - $0.20) / 1M.
    await clock.advance(10 * MINUTE);
    await prompt($, "t3", turnUsage(OPUS, 150_000, 50_000));
    const pane = await mountPane($, "terminal");
    await pane.press({ key: "menu:analytics" });
    for (const row of [
      /^ +This session +All time$/,
      /^Refreshes +3 +13$/,
      /^Warming fee +\$0\.13 +\$1\.13$/,
      /^ {2}no prompt followed +\$0\.04 +\$0\.29$/,
      /^Prompts kept +1 +3$/,
      /^Rewrites avoided +\$0\.72 +\$3\.72$/,
      /^Net saved +\$0\.59 +\$2\.59$/,
    ])
      expect(await pane.find({ text: row })).toBeDefined();
    expect(
      await pane.find({ text: "All time since 2026-09-01" }),
    ).toBeDefined();
    // A refresh and then /clear: no prompt will judge that chain, so its fee is wasted now.
    await clock.advance(270_000);
    await $.session.end(clear);
    expect(
      await pane.find({ text: /^ {2}no prompt followed +\$0\.09 +\$0\.34$/ }),
    ).toBeDefined();
    expect(stored.get("allTime")).toMatchObject({
      since,
      refreshes: 14,
      kept: 3,
    });
    await pane.unmount();
  },
);

test("the Debug mode item toggles in place; while on, a JSON line per refresh and per stop goes to the session's log", async ($, on) => {
  const { clock, files, prompt, writes } = world(on, { HOME: "/home/t" });
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  await start($);
  await prompt($, "t1");
  await clock.advance(270_000);
  expect(writes).toHaveLength(0);
  const path = `/home/t/.claude/cache-warmer/debug/${SESSION_ID}.jsonl`;
  const pane = await mountPane($, "terminal");
  await pane.press({ key: "menu:debug" });
  expect(await pane.find({ text: "› Debug mode · on" })).toBeDefined();
  expect(await pane.find({ key: "back" })).toBeUndefined();
  expect(await pane.find({ text: `Log: ${path}` })).toBeDefined();
  await clock.advance(270_000);
  await $.session.end(clear);
  expect(writes.map((one) => one.path)).toEqual([path, path]);
  const lines = (files.get(path) ?? "").trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  const [refresh, stop] = lines.map((line) => JSON.parse(line));
  expect(refresh).toMatchObject({
    at: new Date(START + 540_000).toISOString(),
    model: OPUS,
    result: "warmed",
    phase: "idle",
    ttl: "5m",
    usage: { cacheRead: 199_990, cacheWrite: 30, output: 182 },
  });
  near(refresh.costUsd, 0.043852);
  expect(stop).toEqual({
    at: new Date(START + 540_000).toISOString(),
    reason: "conversation cleared",
  });
  await pane.press({ key: "menu:debug" });
  expect(await pane.find({ text: "› Debug mode · off" })).toBeDefined();
  expect(await pane.find({ text: /^Log: / })).toBeUndefined();
  await pane.unmount();
});

test("the debug table under the menu keeps the newest rows that fit the pane, aligned in columns", async ($, on) => {
  const { clock, forks, prompt } = world(on, { CLAUDE_CONFIG_DIR: "/c" });
  await start($);
  await prompt($, "t1");
  await clock.advance(30 * MINUTE);
  expect(forks).toHaveLength(5);
  const rowsIn = async (pane: Awaited<ReturnType<typeof mountPane>>) =>
    (await pane.findAll({ type: "Text", text: /  warmed  / })).map(
      (one) => one.text,
    );
  // The menu's six rows, the repository's two, the stop reason's two, the log path and the column names leave three of 15; Clawd would need eight.
  const narrow = await mountPane($, "terminal", { columns: 40, bodyRows: 15 });
  await narrow.press({ key: "menu:debug" });
  expect(
    await narrow.find({
      text: /^ {3}ago {2}result {4}read {2}write {2}out {3}cost {2}saves$/,
    }),
  ).toBeDefined();
  expect(await rowsIn(narrow)).toEqual([
    "16m30s  warmed  200.0k     30  182  $0.04  $0.92",
    "   12m  warmed  200.0k     30  182  $0.04  $0.92",
    " 7m30s  warmed  200.0k     30  182  $0.04  $0.92",
  ]);
  await narrow.unmount();
  const none = await mountPane($, "terminal", { columns: 40, bodyRows: 11 });
  expect(
    await none.find({ text: "Log: /c/cache-warmer/debug/s-test.jsonl" }),
  ).toBeDefined();
  expect(await rowsIn(none)).toHaveLength(0);
  await none.unmount();
});

test("a refresh that settles while a prompt runs starts the new chain, and any session ending settles its fee", async ($, on) => {
  const { clock, prompt, stored } = world(on);
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  await start($);
  await prompt($, "t1");
  await clock.advance(6 * MINUTE);
  await $.turn.start({ text: "x", turnId: "t2" });
  for await (const _ of $.turn.step({
    turnId: "t2",
    index: 0,
    model: OPUS,
    messageCount: 1,
  }))
    // The 9m refresh lands while the 6m request runs; that prompt keeps the 4m30s chain.
    await clock.advance(4 * MINUTE);
  await $.session.end({
    reason: "prompt_input_exit",
    sessionId: "s1",
    resume: { id: "s1" },
  });
  expect(stored.get("allTime")).toMatchObject({ refreshes: 2, kept: 1 });
  // SAFETY: the mod stores an AllTime under allTime, as the match above checks.
  near((stored.get("allTime") as { wastedUsd: number }).wastedUsd, 0.043852);
});

test("an idle limit set through /config applies to the refresh already scheduled", async ($, on) => {
  const { clock, forks, prompt } = world(on);
  await start($);
  await prompt($, "t1");
  await $.config.set({
    key: "cache-warmer.idle5m",
    value: 0,
    previous: 5,
    provider: { plugin: "cache-warmer", tier: "user" },
    origin: { kind: "composer" },
  });
  await clock.advance(10 * MINUTE);
  expect(forks).toHaveLength(0);
});
