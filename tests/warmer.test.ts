import { expect, test } from "claude-code/testing";

import { decide } from "../hooks/warmer";
import {
  OPUS,
  SONNET,
  MINUTE,
  turnUsage,
  world,
  start,
  COMMAND,
  mountPane,
  mountBand,
  near,
  toggle,
} from "./world";

test("the refresh decision follows Pi: idle prompts need 15% odds to clear $0.05; running turns count fully", () => {
  // 200k Opus 5.5 tokens: read $0.04 + 200 output tokens $0.004; a 5m rewrite is $1.00, so a miss adds $0.96.
  const idle = decide(OPUS, 200_000, "5m", "idle", 200);
  near(idle?.warmUsd, 0.044);
  near(idle?.missUsd, 0.96);
  near(idle?.expectedUsd, 0.15 * 0.96 - 0.044);
  expect(idle?.isWarm).toBe(true);
  // 50k tokens: 0.15 * $0.24 - $0.014 = $0.022 idle, below the threshold; $0.226 while a turn runs.
  expect(decide(OPUS, 50_000, "5m", "idle", 200)?.isWarm).toBe(false);
  // Break-even sizes solved by hand: Opus 5.5 idle (54,000 / 0.52 per token) and Sonnet 5.5 idle (52,000 / 0.145).
  expect(idle?.reason).toBeUndefined();
  expect(decide(OPUS, 50_000, "5m", "idle", 200)?.reason).toBe(
    "50.0k tokens is below the 103.8k break-even on claude-opus-5-5 at 5m (idle)",
  );
  expect(decide(SONNET, 300_000, "5m", "idle", 200)?.reason).toBe(
    "300.0k tokens is below the 358.6k break-even on claude-sonnet-5-5 at 5m (idle)",
  );
  near(decide(OPUS, 50_000, "5m", "run", 200)?.expectedUsd, 0.226);
  // A 1h rewrite costs 2x input: 200k * $8 / 1M = $1.60.
  near(decide(OPUS, 200_000, "1h", "idle", 200)?.missUsd, 1.56);
  expect(
    decide("claude-gateway/gpt-6-astra", 200_000, "5m", "idle", 200),
  ).toBeNull();
});

test("a response schedules a fork at 90% of the lifetime; the band shows its lifetime, cost and saving, then goes", async ($, on) => {
  const { clock, envSets, forks, logged, prompt } = world(on);
  await start($);
  expect(envSets).toEqual([["CLAUDE_CODE_PROMPT_CACHE_TTL", "5m"]]);
  await prompt($, "t1");
  await clock.advance(270_000 - 1);
  expect(forks).toHaveLength(0);
  await clock.advance(1);
  expect(forks).toHaveLength(1);
  expect(forks[0]).toMatch(/^\[cache-warmer\] /);
  const band = await mountBand($);
  expect((await band.find({ text: /^☕ cache warmer / }))?.text).toBe(
    "☕ cache warmer 5m every 4m30s · Cache warmed · read 200.0k · $0.04 · saves $0.92 vs rewrite",
  );
  expect(await band.find({ type: "Raster" })).toBeUndefined();
  expect(logged).toEqual([
    "Cache warmer could not record the refresh: no implementation for session.append",
  ]);
  await band.unmount();
  await clock.advance(5000);
  const after = await mountBand($);
  expect(await after.find({ text: /^☕ cache warmer / })).toBeUndefined();
  expect(await after.find({ text: "engine band" })).toBeDefined();
  await after.unmount();
  await clock.advance(265_000);
  expect(forks).toHaveLength(2);
});

test("idle warming stops after five idle refreshes; a prompt within their reach counts as kept", async ($, on) => {
  const { clock, forks, opened, panes, prompt } = world(on);
  await start($);
  await prompt($, "t1");
  // Refreshes at 4m30s intervals; the fifth, at 22m30s, reaches the default idle limit.
  await clock.advance(25 * MINUTE);
  expect(forks).toHaveLength(5);
  await toggle($);
  const stopped = await mountPane($, "terminal");
  expect(
    await stopped.find({
      text: "Stopped: 5 idle refreshes reached. The next prompt restarts warming.",
    }),
  ).toBeDefined();
  await stopped.unmount();
  await toggle($);
  await prompt($, "t2", turnUsage(OPUS, 200_000, 50));
  expect((await toggle($)).text).toBe("Cache warmer opened.");
  expect(opened.at(-1)).toEqual({
    id: "cache-warmer",
    title: "Cache warmer",
    rows: 14,
    closeOnEscape: true,
  });
  for (const surface of ["terminal", "desktop"] as const) {
    const pane = await mountPane($, surface);
    expect(
      await pane.find({
        text: /^Next refresh in 4m30s · idle · expected saving \$0\.10$/,
      }),
    ).toBeDefined();
    await pane.press({ key: "menu:analytics" });
    // Five refreshes cost 5 * $0.043852; the kept prompt read 200k tokens, a $0.96 rewrite avoided.
    for (const row of [
      /^Refreshes +5 +5$/,
      /^Warming fee +\$0\.22 +\$0\.22$/,
      /^Prompts kept +1 +1$/,
      /^Rewrites avoided +\$0\.96 +\$0\.96$/,
      /^Net saved +\$0\.74 +\$0\.74$/,
    ])
      expect(await pane.find({ text: row })).toBeDefined();
    await pane.press({ key: "back" });
    await pane.unmount();
  }
  expect((await toggle($)).text).toBe("Cache warmer closed.");
  expect(panes.size).toBe(0);
});

test("a small idle prompt is not worth a refresh, and the pane says why", async ($, on) => {
  const { clock, forks, prompt } = world(on);
  await start($);
  await prompt($, "t1", turnUsage(SONNET, 19_000, 1000));
  await clock.advance(10 * MINUTE);
  expect(forks).toHaveLength(0);
  const pane = await mountPane($, "terminal");
  expect(
    await pane.find({
      text: /^Stopped: 20\.0k tokens is below the 24\.8k break-even on claude-sonnet-5-5 at 5m \(run\)\./,
    }),
  ).toBeDefined();
  await pane.unmount();
});

test("the command saves the lifetime and sets the variable; the Session page changes only this session", async ($, on) => {
  const { clock, configSets, envSets, forks, prompt } = world(on);
  await start($);
  const answer = await $.command.run({
    ...COMMAND,
    command: "cache-warmer",
    args: "1h",
  });
  expect(answer.text).toBe(
    "Cache lifetime 1h; refreshes every 54m. The next request rewrites the cache once.",
  );
  expect(configSets).toEqual(["1h"]);
  expect(envSets.at(-1)).toEqual(["CLAUDE_CODE_PROMPT_CACHE_TTL", "1h"]);
  const pane = await mountPane($, "terminal");
  await pane.press({ key: "menu:session" });
  await pane.press({ key: "ttl:5m" });
  expect(envSets.at(-1)).toEqual(["CLAUDE_CODE_PROMPT_CACHE_TTL", "5m"]);
  await pane.press({ key: "ttl:1h" });
  expect(configSets).toEqual(["1h"]);
  expect(
    await pane.find({ text: "Refreshes every 54m · idle limit 5 refreshes" }),
  ).toBeDefined();
  await pane.unmount();
  await prompt($, "t1");
  await clock.advance(54 * MINUTE - 1);
  expect(forks).toHaveLength(0);
  await clock.advance(1);
  expect(forks).toHaveLength(1);
});

test("the first response locks the session's lifetime until /clear; the command refuses meanwhile", async ($, on) => {
  const { configSets, envSets, prompt } = world(on);
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  await start($);
  await prompt($, "t1");
  const refused = await $.command.run({
    ...COMMAND,
    command: "cache-warmer",
    args: "1h",
  });
  expect(refused.text).toBe(
    "Cache lifetime unchanged: the cache is written at 5m for this session; /clear or a new session unlocks it",
  );
  expect(configSets).toEqual([]);
  expect(envSets).toEqual([["CLAUDE_CODE_PROMPT_CACHE_TTL", "5m"]]);
  const locked = await mountPane($, "terminal");
  await locked.press({ key: "menu:session" });
  expect(
    await locked.find({ text: "  locked: /clear or a new session unlocks it" }),
  ).toBeDefined();
  expect(await locked.find({ key: "ttl:1h" })).toBeUndefined();
  await locked.unmount();
  await $.session.end({
    reason: "clear",
    sessionId: "s1",
    resume: { id: "s1" },
  });
  const allowed = await $.command.run({
    ...COMMAND,
    command: "cache-warmer",
    args: "1h",
  });
  expect(allowed.text).toBe(
    "Cache lifetime 1h; refreshes every 54m. The next request rewrites the cache once.",
  );
  expect(configSets).toEqual(["1h"]);
});

test(
  "FORCE_PROMPT_CACHING_5M keeps the cache at 5m whatever the choice, and says so",
  { options: { ttl: "1h" } },
  async ($, on) => {
    const { clock, envSets, forks, prompt } = world(on, {
      FORCE_PROMPT_CACHING_5M: "1",
    });
    await start($);
    expect(envSets).toEqual([["CLAUDE_CODE_PROMPT_CACHE_TTL", "1h"]]);
    await prompt($, "t1");
    await clock.advance(270_000);
    expect(forks).toHaveLength(1);
    const pane = await mountPane($, "terminal");
    await pane.press({ key: "menu:session" });
    expect(
      await pane.find({
        text: "FORCE_PROMPT_CACHING_5M overrides 1h; the cache lives 5m.",
      }),
    ).toBeDefined();
    await pane.unmount();
  },
);

test("a refresh that found the cache expired stops warming until the next prompt, even when the turn ends", async ($, on) => {
  const { clock, forks, replies } = world(on);
  await start($);
  replies.push({
    isAnswered: true,
    text: "ok",
    usage: {
      input_tokens: 16,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 200_000,
    },
  });
  await $.turn.start({ text: "x", turnId: "t1" });
  for await (const _ of $.turn.step({
    turnId: "t1",
    index: 0,
    model: OPUS,
    messageCount: 1,
  })) {
    // drain the stream
  }
  await clock.advance(270_000);
  expect(forks).toHaveLength(1);
  await $.turn.complete({
    answer: "ACK",
    durationMs: 5,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  await clock.advance(10 * MINUTE);
  expect(forks).toHaveLength(1);
  const pane = await mountPane($, "terminal");
  expect(
    await pane.find({ text: /^Stopped: cache had expired\./ }),
  ).toBeDefined();
  await pane.unmount();
});

test("a turn that ends while a refresh settles waits for it instead of forking again", async ($, on) => {
  const { clock, forks, holdStoreSet } = world(on);
  await start($);
  let release: () => void = () => undefined;
  holdStoreSet(
    () =>
      new Promise((resolve) => {
        release = () => resolve();
      }),
  );
  await $.turn.start({ text: "x", turnId: "t1" });
  for await (const _ of $.turn.step({
    turnId: "t1",
    index: 0,
    model: OPUS,
    messageCount: 1,
  })) {
    // drain the stream
  }
  // The refresh's fork answered; recording it waits on the held store write.
  await clock.advance(270_000);
  expect(forks).toHaveLength(1);
  await $.turn.complete({
    answer: "ACK",
    durationMs: 5,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  await clock.advance(1);
  expect(forks).toHaveLength(1);
  release();
  await clock.advance(270_000);
  expect(forks).toHaveLength(2);
});

test("a failed all-time save is logged, and warming and later saves go on", async ($, on) => {
  const { clock, forks, holdStoreSet, logged, prompt, stored } = world(on);
  await start($);
  await prompt($, "t1");
  holdStoreSet(() => Promise.reject(new Error("store write failed")));
  await clock.advance(270_000);
  expect(
    logged.some((line) =>
      line.startsWith("Cache warmer could not save its all-time totals: "),
    ),
  ).toBe(true);
  await clock.advance(270_000);
  expect(forks).toHaveLength(2);
  expect(stored.get("allTime")).toMatchObject({ refreshes: 1 });
});
