import { expect, test } from "claude-code/testing";

import { decide } from "../hooks/warmer";
import {
  OPUS,
  SONNET,
  MINUTE,
  START,
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

test("without a saved lifetime the cache lives 1h and refreshes at 54m", async ($, on) => {
  const { clock, envSets, forks, prompt } = world(on);
  await start($);
  expect(envSets).toEqual([["CLAUDE_CODE_PROMPT_CACHE_TTL", "1h"]]);
  await prompt($, "t1");
  await clock.advance(54 * MINUTE - 1);
  expect(forks).toHaveLength(0);
  await clock.advance(1);
  expect(forks).toHaveLength(1);
});

test(
  "a response schedules a fork at 90% of the lifetime; the band shows its lifetime, cost and saving, holds still while idle and goes at the next prompt",
  { options: { ttl: "5m" } },
  async ($, on) => {
    const { appended, blits, clock, envSets, forks, logged, prompt } =
      world(on);
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
    expect(await band.find({ type: "Raster" })).toBeDefined();
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatch(/^☕ 5m · Cache warmed · /);
    expect(logged).toEqual([]);
    await clock.advance(5000);
    expect((await band.find({ text: /^☕ cache warmer / }))?.text).toMatch(
      /· Cache warmed ·/,
    );
    expect(await band.find({ type: "Raster" })).toBeDefined();
    const painted = blits.length;
    await clock.advance(1000);
    expect(blits).toHaveLength(painted);
    await clock.advance(264_000);
    expect(forks).toHaveLength(2);
    await prompt($, "t2");
    expect(await band.find({ text: /^☕ cache warmer / })).toBeUndefined();
    expect(await band.find({ text: "engine band" })).toBeDefined();
    await band.unmount();
  },
);

test(
  "idle warming stops after five idle refreshes; a prompt within their reach counts as kept",
  { options: { ttl: "5m" } },
  async ($, on) => {
    const { clock, forks, opened, panes, prompt } = world(on);
    await start($);
    await prompt($, "t1");
    // Refreshes at 4m30s intervals; the fifth, at 22m30s, reaches the default idle limit.
    await clock.advance(25 * MINUTE);
    expect(forks).toHaveLength(5);
    // Its warning holds until the next prompt, with the cache's expiry 5m after it.
    const band = await mountBand($);
    const expiresAt = new Date(START + 27.5 * MINUTE)
      .toTimeString()
      .slice(0, 5);
    expect((await band.find({ text: /^☕ cache warmer / }))?.text).toBe(
      `☕ cache warmer 5m every 4m30s · Warming stopped · all 5 idle refreshes used · cache expires at ${expiresAt}`,
    );
    await band.unmount();
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
      focus: true,
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
    // A pane that lost the keyboard takes it back instead of closing.
    panes.set("cache-warmer", false);
    expect((await toggle($)).text).toBe("Cache warmer focused.");
    expect(opened.at(-1)).toMatchObject({ focus: true });
    expect((await toggle($)).text).toBe("Cache warmer closed.");
    expect(panes.size).toBe(0);
  },
);

test(
  "a small idle prompt is not worth a refresh, and the pane says why",
  { options: { ttl: "5m" } },
  async ($, on) => {
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
  },
);

test(
  "the command saves the lifetime and sets the variable; the configuration page's session lifetime changes only this session",
  { options: { ttl: "5m" } },
  async ($, on) => {
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
    await pane.press({ key: "menu:config" });
    await pane.press({ key: "toggle:ttl" });
    expect(envSets.at(-1)).toEqual(["CLAUDE_CODE_PROMPT_CACHE_TTL", "5m"]);
    await pane.press({ key: "toggle:ttl" });
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
  },
);

test(
  "the first response locks the session's lifetime until /clear; the command refuses meanwhile",
  { options: { ttl: "5m" } },
  async ($, on) => {
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
    await locked.press({ key: "menu:config" });
    expect(
      await locked.find({
        text: "  locked: /clear or a new session unlocks it",
      }),
    ).toBeDefined();
    expect(await locked.find({ key: "toggle:ttl" })).toBeUndefined();
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
  },
);

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
    await pane.press({ key: "menu:config" });
    expect(
      await pane.find({
        text: "FORCE_PROMPT_CACHING_5M overrides 1h; the cache lives 5m.",
      }),
    ).toBeDefined();
    await pane.unmount();
  },
);

test(
  "a refresh that found the cache expired stops warming until the next prompt, even when the turn ends",
  { options: { ttl: "5m" } },
  async ($, on) => {
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
  },
);

test(
  "a refresh the API refused names the error and its status in the band",
  { options: { ttl: "5m" } },
  async ($, on) => {
    const { clock, prompt, replies } = world(on);
    await start($);
    replies.push({
      isAnswered: false,
      reason: "api-error",
      status: 429,
      error: "rate_limit",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    await prompt($, "t1");
    await clock.advance(270_000);
    const band = await mountBand($);
    expect((await band.find({ text: /^☕ cache warmer / }))?.text).toBe(
      "☕ cache warmer 5m every 4m30s · Cache refresh failed · rate_limit 429 · read 0 · $0.00",
    );
    await band.unmount();
  },
);

test(
  "a turn that ends while a refresh settles waits for it instead of forking again",
  { options: { ttl: "5m" } },
  async ($, on) => {
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
  },
);

test(
  "a failed all-time save is logged, and warming and later saves go on",
  { options: { ttl: "5m" } },
  async ($, on) => {
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
  },
);
