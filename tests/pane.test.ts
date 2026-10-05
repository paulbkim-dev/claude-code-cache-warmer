import { expect, test } from "claude-code/testing";
import type { ConfigRow, ConfigValue } from "claude-code";

import { TERMINAL_DEFAULT, cellsOf } from "../hooks/mascot";
import {
  MINUTE,
  SONNET,
  mountPane,
  start,
  toggle,
  turnUsage,
  world,
} from "./world";

const rowOf = (key: string, value: ConfigValue): ConfigRow => ({
  key,
  label: key,
  kind: key === "theme" ? "choice" : "boolean",
  value,
  provider: { plugin: "engine", tier: "core" },
  isLocked: false,
});

test("the open pane animates Clawd beside the menu, not on a sub-page, until it closes", async ($, on) => {
  const { blits, clock, prompt } = world(on);
  await start($);
  await prompt($, "t1");
  await clock.advance(30 * MINUTE);
  await toggle($);
  const desktop = await mountPane($, "desktop");
  expect(await desktop.find({ type: "Raster" })).toBeUndefined();
  await desktop.unmount();
  const pane = await mountPane($, "terminal", { columns: 120, bodyRows: 11 });
  expect(
    (await pane.find({ type: "Raster", key: "mascot" }))?.props,
  ).toMatchObject({ columns: 28, rows: 7 });
  await clock.advance(200);
  expect(
    blits.filter(({ requestId }) => requestId === "cache-warmer").length,
  ).toBe(6);
  await pane.press({ key: "menu:global" });
  expect(await pane.find({ type: "Raster" })).toBeUndefined();
  const before = blits.length;
  await clock.advance(200);
  expect(blits).toHaveLength(before);
  await pane.press({ key: "back" });
  expect(await pane.find({ type: "Raster" })).toBeDefined();
  expect((await toggle($)).text).toBe("Cache warmer closed.");
  const painted = blits.length;
  await clock.advance(1000);
  expect(blits).toHaveLength(painted);
  await pane.unmount();
});

test("Clawd stands beside the menu in a wide pane, above it in a narrow tall one, and nowhere when rows run out", async ($, on) => {
  const { prompt } = world(on);
  await start($);
  await prompt($, "t1", turnUsage(SONNET, 299_000, 1000));
  await toggle($);
  // At 60 columns 30 stay beside Clawd, where the stop reason wraps to five rows under the seven of the header and menu.
  // At 59 Clawd and a blank row stand above those seven and the reason's three rows.
  for (const [columns, bodyRows, direction] of [
    [60, 12, "row"],
    [60, 11, undefined],
    [59, 18, "column"],
    [59, 17, undefined],
    [27, 40, undefined],
  ] as const) {
    const pane = await mountPane($, "terminal", { columns, bodyRows });
    expect(await pane.find({ text: /^Stopped: 300\.0k tokens/ })).toBeDefined();
    expect((await pane.find({ type: "Raster" })) !== undefined).toBe(
      direction !== undefined,
    );
    if (direction)
      expect(await pane.find({ type: "Box" })).toMatchObject({
        props: { flexDirection: direction },
      });
    await pane.unmount();
  }
});

// A docked pane sits on Claude Code's sidebar background, which Clawd's empty cells take.
for (const [theme, colors, drawn, background] of [
  ["light-daltonized", "", "light", 0xebebeb],
  ["dark", "0;15", "dark", 0x262626],
  ["dark-ansi", "", "dark", TERMINAL_DEFAULT],
  ["auto", "0;15", "light", 0xf5f5f5],
  ["auto", "15;0", "dark", 0x262626],
  ["auto", "", "dark", 0x262626],
] as const)
  test(`with theme ${theme} and COLORFGBG "${colors}", the still pane draws Clawd for a ${drawn} background`, async ($, on) => {
    const { blits } = world(on, colors ? { COLORFGBG: colors } : {}, [
      rowOf("reduceMotion", true),
      rowOf("theme", theme),
    ]);
    await start($);
    await toggle($);
    const pane = await mountPane($, "terminal");
    expect(
      (await pane.find({ type: "Raster", key: "mascot" }))?.props,
    ).toMatchObject({ cells: cellsOf(1, "warming", 3, drawn, background) });
    expect(blits).toHaveLength(0);
    await pane.unmount();
  });
