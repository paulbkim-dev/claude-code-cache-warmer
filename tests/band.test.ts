import { expect, test } from "claude-code/testing";

import { COMMAND, mountBand, start, world } from "./world";

test("the preview plays warming, warmed and cold, repainting Clawd by blit, then goes", async ($, on) => {
  const { blits, clock, forks } = world(on);
  await start($);
  expect(
    (
      await $.command.run({
        ...COMMAND,
        command: "cache-warmer",
        args: "preview",
      })
    ).text,
  ).toBe("Cache warmer band preview started.");
  const band = await mountBand($);
  expect(
    await band.find({ text: "Preview: warming the prompt cache…" }),
  ).toBeDefined();
  await clock.advance(1000);
  // 30 frames a second, each 28 x 7 cells of 12 bytes in base64.
  expect(blits).toHaveLength(30);
  expect(
    blits.every(({ key, cells }) => key === "mascot" && cells.length === 3136),
  ).toBe(true);
  await clock.advance(6000);
  expect(await band.find({ text: "Preview: cache warmed" })).toBeDefined();
  await clock.advance(5500);
  expect(await band.find({ text: "Preview: cache had expired" })).toBeDefined();
  await clock.advance(5000);
  expect(await band.find({ type: "Raster" })).toBeUndefined();
  const painted = blits.length;
  await clock.advance(1000);
  expect(blits).toHaveLength(painted);
  expect(forks).toHaveLength(0);
  await band.unmount();
});
