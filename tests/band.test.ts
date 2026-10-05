import { expect, test } from "claude-code/testing";

import { COMMAND, mountBand, mountPane, start, toggle, world } from "./world";

const runPreview = ($: Parameters<typeof start>[0]) =>
  $.command.run({ ...COMMAND, command: "cache-warmer", args: "preview" });

test("the default band plays refreshing, warmed and cold beside Clawd, repainting him by blit, then goes", async ($, on) => {
  const { blits, clock, forks } = world(on);
  await start($);
  expect((await runPreview($)).text).toBe("Cache warmer band preview started.");
  const band = await mountBand($);
  const line = async () =>
    (await band.find({ text: /^☕ cache warmer / }))?.text;
  expect(await line()).toBe(
    "☕ cache warmer 5m every 4m30s · Refreshing cache · preview",
  );
  expect(
    (await band.find({ type: "Raster", key: "mascot" }))?.props,
  ).toMatchObject({ columns: 28, rows: 7 });
  await clock.advance(1000);
  // 30 frames a second, each 28 x 7 cells of 12 bytes in base64.
  expect(blits).toHaveLength(30);
  expect(
    blits.every(({ key, cells }) => key === "mascot" && cells.length === 3136),
  ).toBe(true);
  await clock.advance(5000);
  expect(await line()).toMatch(/· Cache warmed ·/);
  await clock.advance(5500);
  expect(await line()).toMatch(/· Cache had expired ·/);
  await clock.advance(5000);
  expect(await band.find({ text: "engine band" })).toBeDefined();
  const painted = blits.length;
  await clock.advance(1000);
  expect(blits).toHaveLength(painted);
  expect(forks).toHaveLength(0);
  await band.unmount();
});

test("the band button cycles default, simplified and off; simplified is one line, off leaves the engine's band", async ($, on) => {
  const { blits, clock, configSets } = world(on);
  await start($);
  await toggle($);
  const pane = await mountPane($, "terminal");
  await pane.press({ key: "menu:config" });
  expect(await pane.find({ key: "toggle:band" })).toMatchObject({
    props: { label: "● default  ○ simplified  ○ off" },
  });
  await pane.press({ key: "toggle:band" });
  await runPreview($);
  const band = await mountBand($);
  expect((await band.find({ text: /^☕ cache warmer / }))?.text).toMatch(
    /· Refreshing cache ·/,
  );
  expect(await band.find({ type: "Raster" })).toBeUndefined();
  await clock.advance(1000);
  expect(blits).toHaveLength(0);
  await pane.press({ key: "toggle:band" });
  await pane.unmount();
  expect(configSets).toEqual(["simplified", "off"]);
  expect(await band.find({ text: /^☕ cache warmer / })).toBeUndefined();
  expect(await band.find({ text: "engine band" })).toBeDefined();
  await $.config.set({ key: "cache-warmer.band", value: "default" });
  expect(await band.find({ type: "Raster" })).toBeDefined();
  await band.unmount();
});
