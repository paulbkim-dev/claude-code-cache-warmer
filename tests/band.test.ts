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

test("the bar opens pages in place; turning the band off there hides the notice; /config turns it back on", async ($, on) => {
  const { configSets, opened } = world(on);
  await start($);
  expect((await toggle($)).text).toBe("Cache warmer opened.");
  expect(opened).toHaveLength(0);
  const bar = await mountBand($);
  await bar.press({ key: "menu:global" });
  await bar.press({ key: "band:off" });
  expect(configSets).toEqual([false]);
  await bar.press({ key: "back" });
  await runPreview($);
  expect(await bar.find({ text: /^☕ cache warmer / })).toBeUndefined();
  await $.config.set({ key: "cache-warmer.band", value: true });
  expect(await bar.find({ text: /^☕ cache warmer / })).toBeDefined();
  await bar.press({ key: "close" });
  expect((await bar.find({ text: /^☕ cache warmer / }))?.text).toMatch(
    /· Refreshing cache ·/,
  );
  expect(await bar.find({ key: "menu:global" })).toBeUndefined();
  await bar.unmount();
});

test("Debug mode moves the menu to the pane and back to the bar", async ($, on) => {
  const { opened, panes } = world(on);
  await start($);
  await toggle($);
  const bar = await mountBand($);
  await bar.press({ key: "menu:debug" });
  expect(opened).toHaveLength(1);
  expect(await bar.find({ key: "menu:global" })).toBeUndefined();
  const pane = await mountPane($, "terminal");
  await pane.press({ key: "menu:debug" });
  expect(panes.size).toBe(0);
  expect(await bar.find({ key: "menu:global" })).toBeDefined();
  await pane.unmount();
  await bar.unmount();
});

test("a reload with Debug mode off moves a pane left open by 0.7 to the bar", async ($, on) => {
  const { panes } = world(on);
  await start($);
  panes.add("cache-warmer");
  await start($);
  expect(panes.size).toBe(0);
  const bar = await mountBand($);
  expect(await bar.find({ key: "menu:global" })).toBeDefined();
  await bar.unmount();
});
