import { expect, test } from "claude-code/testing";

import { COMMAND, MINUTE, mountPane, start, world } from "./world";

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
