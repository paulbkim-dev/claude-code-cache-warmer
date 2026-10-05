import type { ElementTable, RenderElement } from "claude-code";

import type {
  AllTime,
  BandStyle,
  IdleLimits,
  Mood,
  Notice,
  Page,
  Refresh,
  Status,
  Totals,
  Ttl,
} from "../types";
import { MASCOT_COLUMNS, MASCOT_ROWS } from "./mascot";
import { delayOf, formatDuration, formatTokens, formatUsd } from "./warmer";

export const MASCOT_KEY = "mascot";
// Plain text, which terminals link themselves: a Link where OSC 8 is unsupported draws its label and then the URL.
const REPOSITORY = "github.com/paulbkim-dev/claude-code-cache-warmer";
// Clawd stands left of the main page's column when this many columns stay beside him, and above it in a narrower pane.
const SIDE_COLUMNS = 30;
const SIDE_GAP = 2;
// The main page's column above its status line besides the repository line: two header rows, a blank row and three menu items.
const MENU_ROWS = 6;
const COLUMN_GAP = "  ";

export type PaneData = {
  page: Page;
  // This session's lifetime, and the saved default new sessions start with.
  chosen: Ttl;
  saved: Ttl;
  limits: IdleLimits;
  isForced: boolean;
  isLocked: boolean;
  isDebug: boolean;
  bandStyle: BandStyle;
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
  toggleDebug: () => void;
  setBand: (value: BandStyle) => void;
  chooseDefault: (value: Ttl) => void;
  chooseSession: (value: Ttl) => void;
  setLimit: (ttl: Ttl, count: number) => void;
};

export const statusTextOf = (state: Status, at: number): string | undefined => {
  if (state.state === "waiting") return undefined;
  if (state.state === "refreshing") return "Refreshing now.";
  if (state.state === "stopped")
    return `Stopped: ${state.reason}. The next prompt restarts warming.`;
  const phase = state.phase === "run" ? "turn running" : "idle";
  return `Next refresh in ${formatDuration(state.nextAt - at)} · ${phase} · expected saving ${formatUsd(state.expectedUsd)}`;
};

// Rows a text takes wrapped at spaces, a word longer than the width broken across rows.
const rowsOf = (text: string, width: number) => {
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

// Lays rows of cells out in columns, each as wide as its widest cell; `isLeft` columns align left.
export const tableOf = (rows: string[][], isLeft: boolean[]) => {
  const widths = (rows[0] ?? []).map((_, index) =>
    Math.max(...rows.map((row) => (row[index] ?? "").length)),
  );
  return rows.map((row) =>
    row
      .map((cell, index) =>
        isLeft[index]
          ? cell.padEnd(widths[index] ?? 0)
          : cell.padStart(widths[index] ?? 0),
      )
      .join(COLUMN_GAP)
      .trimEnd(),
  );
};

// The pane and the band draw Clawd under one key; blits repaint him there.
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

const TTL_COLORS = { "5m": "cyan", "1h": "magenta" } satisfies Record<
  Ttl,
  string
>;
const MOOD_COLORS = {
  warming: "yellow",
  warmed: "green",
  cold: "red",
} satisfies Record<Mood, string>;

const noticeTextOf = (
  { Text }: ElementTable,
  { ttl, head, detail, mood }: Notice,
  wrap: "truncate-end" | "wrap",
) => (
  <Text wrap={wrap}>
    <Text dimColor>{"☕ cache warmer "}</Text>
    <Text color={TTL_COLORS[ttl]}>{ttl}</Text>
    <Text dimColor>{` every ${formatDuration(delayOf(ttl))} · `}</Text>
    <Text color={MOOD_COLORS[mood]}>{head}</Text>
    {detail && <Text dimColor>{` · ${detail}`}</Text>}
  </Text>
);

// One dim line with the lifetime and the outcome in color.
export const bandOf = (elements: ElementTable, shown: Notice) =>
  noticeTextOf(elements, shown, "truncate-end");

// Clawd's raster with the notice wrapped beside him.
export const mascotBandOf = (
  elements: ElementTable<"terminal">,
  shown: Notice,
  raster: RenderElement,
) => {
  const { Box } = elements;
  return (
    <Box flexDirection="row" columnGap={2}>
      {raster}
      <Box flexDirection="column" justifyContent="center" flexShrink={1}>
        {noticeTextOf(elements, shown, "wrap")}
      </Box>
    </Box>
  );
};

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

const DEBUG_HEADER = ["ago", "result", "read", "write", "out", "cost", "saves"];
const DEBUG_LEFT = DEBUG_HEADER.map((name) => name === "result");

const debugCellsOf = (one: Refresh, at: number) => [
  formatDuration(at - one.at),
  one.detail ? `${one.result} (${one.detail})` : one.result,
  one.usage ? formatTokens(one.usage.cacheRead) : "-",
  one.usage ? formatTokens(one.usage.cacheWrite) : "-",
  one.usage ? String(one.usage.output) : "-",
  one.costUsd === null ? "?" : formatUsd(one.costUsd),
  one.savesUsd === null ? "" : formatUsd(one.savesUsd),
];

const logTextOf = (path: string) => `Log: ${path}`;

// Rows the main page's column takes at `width`, all but the debug table's refreshes, which take the rows left.
const columnRowsOf = (
  { state, at, isDebug, logPath }: PaneData,
  width: number,
) => {
  const status = statusTextOf(state, at);
  return (
    MENU_ROWS +
    rowsOf(REPOSITORY, width) +
    (status ? rowsOf(status, width) : 0) +
    (isDebug ? rowsOf(logTextOf(logPath), width) + 1 : 0)
  );
};

// The log path, the column names and the newest refreshes that fit in `room` rows.
const debugTableOf = (
  { Text }: ElementTable,
  { list, logPath, at }: PaneData,
  room: number,
) => {
  const shown = room > 0 ? list.slice(-room) : [];
  const [columns = "", ...lines] = tableOf(
    [DEBUG_HEADER, ...shown.map((one) => debugCellsOf(one, at))],
    DEBUG_LEFT,
  );
  return [
    <Text key="log" dimColor wrap="wrap">
      {logTextOf(logPath)}
    </Text>,
    <Text key="columns" dimColor wrap="truncate-end">
      {list.length === 0 ? "No refreshes yet." : columns}
    </Text>,
    ...lines.map((line, index) => (
      <Text
        key={`refresh:${shown[index]?.at ?? index}`}
        wrap="truncate-end"
        dimColor={shown[index]?.result !== "warmed"}
      >
        {line}
      </Text>
    )),
  ];
};

type Layout = "beside" | "above";

// Clawd's raster and where layoutOf placed him.
export type Mascot = { raster: RenderElement; layout: Layout };

// Where Clawd fits on the main page: beside the column, above it with a blank row between, or nowhere.
// Beside him the column scrolls, so a turn's spinner shrinking an inline pane keeps him drawn.
export const layoutOf = (data: PaneData): Layout | undefined => {
  if (
    data.width - MASCOT_COLUMNS - SIDE_GAP >= SIDE_COLUMNS &&
    data.rows >= MASCOT_ROWS
  )
    return "beside";
  if (
    data.width >= MASCOT_COLUMNS &&
    data.rows >= MASCOT_ROWS + 1 + columnRowsOf(data, data.width)
  )
    return "above";
  return undefined;
};

export const mainPageOf = (
  elements: ElementTable,
  data: PaneData,
  actions: PaneActions,
  mascot?: Mascot,
) => {
  const { Box, Text, Button } = elements;
  const layout = mascot?.layout;
  const width =
    layout === "beside" ? data.width - MASCOT_COLUMNS - SIDE_GAP : data.width;
  const status = statusTextOf(data.state, data.at);
  const item = (key: string, label: string, onPress: () => void) => (
    <Button
      key={`menu:${key}`}
      label={`› ${label}`}
      plain
      autoFocus={key === "config" ? true : undefined}
      onPress={onPress}
    />
  );
  const column = (
    <Box key="menu" flexDirection="column" width={width}>
      <Box
        key="header"
        flexDirection="column"
        alignItems="center"
        marginBottom={1}
      >
        <Text bold>Cache Warmer</Text>
        <Text dimColor>paulbkim.dev</Text>
        <Text dimColor wrap="wrap">
          {REPOSITORY}
        </Text>
      </Box>
      {item("config", "Configuration", () => actions.open("config"))}
      {item("analytics", "Analytics", () => actions.open("analytics"))}
      {item(
        "debug",
        `Debug mode · ${data.isDebug ? "on" : "off"}`,
        actions.toggleDebug,
      )}
      {status && (
        <Text key="status" dimColor wrap="wrap">
          {status}
        </Text>
      )}
      {data.isDebug &&
        debugTableOf(
          elements,
          data,
          data.rows -
            (layout === "above" ? MASCOT_ROWS + 1 : 0) -
            columnRowsOf(data, width),
        )}
    </Box>
  );
  if (!mascot) return column;
  if (mascot.layout === "beside")
    return (
      <Box flexDirection="row" columnGap={SIDE_GAP}>
        {mascot.raster}
        {column}
      </Box>
    );
  return (
    <Box flexDirection="column" alignItems="center" rowGap={1}>
      {mascot.raster}
      {column}
    </Box>
  );
};
