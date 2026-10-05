import type { ElementTable, RenderElement } from "claude-code";

import type {
  AllTime,
  IdleLimits,
  Page,
  Refresh,
  Status,
  Totals,
  Ttl,
} from "../types";
import { MASCOT_COLUMNS, MASCOT_ROWS } from "./mascot";
import { formatDuration, formatUsd } from "./warmer";

export const MASCOT_KEY = "mascot";
// Clawd sits left of the main page's column when this many columns, the repository link's, stay beside him.
const SIDE_COLUMNS = 48;
const SIDE_GAP = 2;
// The main page's column above its status line: title, link and four menu items.
const MENU_ROWS = 6;

export type PaneData = {
  page: Page;
  // This session's lifetime, and the saved default new sessions start with.
  chosen: Ttl;
  saved: Ttl;
  limits: IdleLimits;
  isForced: boolean;
  isLocked: boolean;
  isDebug: boolean;
  state: Status;
  totals: Totals;
  allTime: AllTime;
  list: Refresh[];
  logPath: string;
  at: number;
  width: number;
  rows: number;
};

export type PaneActions = {
  open: (page: Page) => void;
  openDebug: () => void;
  turnOffDebug: () => void;
  chooseDefault: (value: Ttl) => void;
  chooseSession: (value: Ttl) => void;
  setLimit: (ttl: Ttl, count: number) => void;
};

export const statusTextOf = (state: Status, at: number): string => {
  if (state.state === "waiting") return "Waiting for the first response.";
  if (state.state === "refreshing") return "Refreshing now.";
  if (state.state === "stopped")
    return `Stopped: ${state.reason}. The next prompt restarts warming.`;
  const phase = state.phase === "run" ? "turn running" : "idle";
  return `Next refresh in ${formatDuration(state.nextAt - at)} · ${phase} · expected saving ${formatUsd(state.expectedUsd)}`;
};

// Rows a text takes wrapped at spaces, a word longer than the width broken across rows.
export const rowsOf = (text: string, width: number) => {
  let rows = 1;
  let used = 0;
  for (const word of text.split(" ")) {
    const gap = used === 0 ? 0 : 1;
    if (used + gap + word.length <= width) {
      used += gap + word.length;
      continue;
    }
    rows += Math.ceil(word.length / width) - (used === 0 ? 1 : 0);
    used = word.length % width || width;
  }
  return rows;
};

// The band and the pane draw Clawd under one key; blits repaint him there.
export const rasterOf = (
  { Raster }: ElementTable<"terminal">,
  cells: string,
) => (
  <Raster
    key={MASCOT_KEY}
    columns={MASCOT_COLUMNS}
    rows={MASCOT_ROWS}
    cells={cells}
  />
);

export const bandOf = (
  elements: ElementTable<"terminal">,
  text: string,
  cells: string,
) => {
  const { Box, Text } = elements;
  return (
    <Box flexDirection="row">
      {rasterOf(elements, cells)}
      <Box flexDirection="column" justifyContent="center" marginLeft={1}>
        <Text dimColor>{text}</Text>
      </Box>
    </Box>
  );
};

// Surfaces without a Raster, and bands too short for Clawd, show the notice alone.
export const plainBandOf = ({ Text }: ElementTable, text: string) => (
  <Text dimColor>{`☕ ${text}`}</Text>
);

// Every sub-page opens with the Back button, which holds the focus first, and its title.
export const headerOf = (
  { Box, Text, Button }: ElementTable,
  title: string,
  open: (page: Page) => void,
) => (
  <Box key="header" flexDirection="row" columnGap={2}>
    <Button
      key="back"
      label="‹ Back"
      plain
      autoFocus
      onPress={() => open("main")}
    />
    <Text bold>{title}</Text>
  </Box>
);

// Clawd needs the column's width beside him, and rows for its menu and its wrapped status line.
export const fitsMascot = ({ state, at, width, rows }: PaneData) =>
  width >= MASCOT_COLUMNS + SIDE_GAP + SIDE_COLUMNS &&
  rows >=
    Math.max(
      MASCOT_ROWS,
      MENU_ROWS +
        rowsOf(statusTextOf(state, at), width - MASCOT_COLUMNS - SIDE_GAP),
    );

// `mascot`, when the pane has room for Clawd, stands left of the menu.
export const mainPageOf = (
  elements: ElementTable,
  data: PaneData,
  actions: PaneActions,
  mascot?: RenderElement,
) => {
  const { Box, Text, Button } = elements;
  const item = (key: Page, label: string, onPress: () => void) => (
    <Button
      key={`menu:${key}`}
      label={`› ${label}`}
      plain
      autoFocus={key === "global" ? true : undefined}
      onPress={onPress}
    />
  );
  const column = (
    <Box key="menu" flexDirection="column">
      <Text bold>Cache Warmer by paulbkimdev</Text>
      <Text dimColor>github.com/paulbkim-dev/claude-code-cache-warmer</Text>
      {item("global", "Global configuration", () => actions.open("global"))}
      {item("session", "Session configuration", () => actions.open("session"))}
      {item("analytics", "Analytics", () => actions.open("analytics"))}
      {item(
        "debug",
        `Debug mode · ${data.isDebug ? "on" : "off"}`,
        actions.openDebug,
      )}
      <Text dimColor wrap="wrap">
        {statusTextOf(data.state, data.at)}
      </Text>
    </Box>
  );
  if (!mascot) return column;
  return (
    <Box flexDirection="row" columnGap={SIDE_GAP}>
      {mascot}
      <Box
        flexDirection="column"
        width={data.width - MASCOT_COLUMNS - SIDE_GAP}
      >
        {column}
      </Box>
    </Box>
  );
};
