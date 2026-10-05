import { expect, test } from "claude-code/testing";

import { COMMAND, mountBand, mountPane, start, toggle, world } from "./world";

const runPreview = ($: Parameters<typeof start>[0]) =>
  $.command.run({ ...COMMAND, command: "cache-warmer", args: "preview" });

test("the preview plays refreshing, warmed and cold as one line, then goes", async ($, on) => {
  const { blits, clock, forks } = world(on);
  await start($);
  expect((await runPreview($)).text).toBe("Cache warmer band preview started.");
  const band = await mountBand($);
  const line = async () =>
    (await band.find({ text: /^☕ cache warmer / }))?.text;
  expect(await line()).toBe(
    "☕ cache warmer 5m every 4m30s · Refreshing cache · preview",
  );
  expect(await band.find({ type: "Raster" })).toBeUndefined();
  await clock.advance(6000);
  expect(await line()).toMatch(/· Cache warmed ·/);
  await clock.advance(5500);
  expect(await line()).toMatch(/· Cache had expired ·/);
  await clock.advance(5000);
  expect(await band.find({ text: "engine band" })).toBeDefined();
  expect(blits).toHaveLength(0);
  expect(forks).toHaveLength(0);
  await band.unmount();
});

test("turning the band off on the Global page saves it and leaves the engine's band; /config turns it back on", async ($, on) => {
  const { configSets } = world(on);
  await start($);
  await toggle($);
  const pane = await mountPane($, "terminal");
  await pane.press({ key: "menu:global" });
  await pane.press({ key: "band:off" });
  expect(configSets).toEqual([false]);
  await pane.unmount();
  await runPreview($);
  const band = await mountBand($);
  expect(await band.find({ text: /^☕ cache warmer / })).toBeUndefined();
  expect(await band.find({ text: "engine band" })).toBeDefined();
  await $.config.set({ key: "cache-warmer.band", value: true });
  expect((await band.find({ text: /^☕ cache warmer / }))?.text).toMatch(
    /· Refreshing cache ·/,
  );
  await band.unmount();
});
