import type { ElementTable, RenderElement } from "claude-code";

import type { Refresh, Totals, Ttl } from "../types";
import type { PaneActions, PaneData } from "./pane";
import { headerOf, mainPageOf, rowsOf, statusTextOf } from "./pane";
import {
  MIN_SAVINGS_USD,
  PRICES_AS_OF,
  delayOf,
  formatDuration,
  formatTokens,
  formatUsd,
  idleSpanOf,
} from "./warmer";

const TTLS = ["5m", "1h"] as const;
const COLUMN_GAP = "  ";

// Lays rows of cells out in columns, each as wide as its widest cell; `isLeft` columns align left.
const tableOf = (rows: string[][], isLeft: boolean[]) => {
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

const ttlButtonsOf = (
  { Button }: ElementTable,
  prefix: string,
  chosen: Ttl,
  choose: (value: Ttl) => void,
) =>
  TTLS.map((value) => (
    <Button
      key={`${prefix}:${value}`}
      label={value}
      variant={value === chosen ? "primary" : undefined}
      dimColor={value !== chosen}
      onPress={() => choose(value)}
    />
  ));

const GLOBAL_LABELS = {
  default: "Default lifetime",
  "5m": "Idle refreshes, 5m",
  "1h": "Idle refreshes, 1h",
};
const GLOBAL_LABEL_WIDTH = Math.max(
  ...Object.values(GLOBAL_LABELS).map((label) => label.length),
);

const globalPageOf = (
  elements: ElementTable,
  { saved, limits }: PaneData,
  actions: PaneActions,
) => {
  const { Box, Text, Button } = elements;
  const label = (text: string) => (
    <Text>{`${text.padEnd(GLOBAL_LABEL_WIDTH)}  `}</Text>
  );
  return (
    <Box flexDirection="column">
      {headerOf(elements, "Global configuration", actions.open)}
      <Box key="default" flexDirection="row">
        {label(GLOBAL_LABELS.default)}
        {ttlButtonsOf(elements, "default", saved, actions.chooseDefault)}
      </Box>
      {TTLS.map((ttl) => (
        <Box key={`idle:${ttl}`} flexDirection="row">
          {label(GLOBAL_LABELS[ttl])}
          <Button
            key={`idle:${ttl}:-`}
            label="−"
            onPress={() => actions.setLimit(ttl, limits[ttl] - 1)}
          />
          <Text>{String(limits[ttl]).padStart(3).padEnd(4)}</Text>
          <Button
            key={`idle:${ttl}:+`}
            label="+"
            onPress={() => actions.setLimit(ttl, limits[ttl] + 1)}
          />
          <Text dimColor>
            {`  covers ${formatDuration(idleSpanOf(limits[ttl], ttl))} idle`}
          </Text>
        </Box>
      ))}
      <Text key="note" dimColor>
        {`Saved for new sessions. Each refresh still needs Pi's ${formatUsd(MIN_SAVINGS_USD)} expected saving.`}
      </Text>
    </Box>
  );
};

const sessionPageOf = (
  elements: ElementTable,
  data: PaneData,
  actions: PaneActions,
) => {
  const { Box, Text } = elements;
  const { chosen, isForced, isLocked, limits, state, at } = data;
  const effective = isForced ? "5m" : chosen;
  return (
    <Box flexDirection="column">
      {headerOf(elements, "Session configuration", actions.open)}
      <Box key="ttl" flexDirection="row">
        <Text>Lifetime </Text>
        {isLocked ? (
          <Text bold>{chosen}</Text>
        ) : (
          ttlButtonsOf(elements, "ttl", chosen, actions.chooseSession)
        )}
        {isLocked && (
          <Text dimColor>{"  locked: /clear or a new session unlocks it"}</Text>
        )}
      </Box>
      <Text key="interval" dimColor>
        {`Refreshes every ${formatDuration(delayOf(effective))} · idle limit ${limits[effective]} refreshes`}
      </Text>
      <Text key="status" dimColor>
        {statusTextOf(state, at)}
      </Text>
      {isForced && (
        <Text key="forced" color="yellow">
          {`FORCE_PROMPT_CACHING_5M overrides ${chosen}; the cache lives 5m.`}
        </Text>
      )}
    </Box>
  );
};

const ANALYTICS_ROWS: [label: string, valueOf: (totals: Totals) => string][] = [
  ["Refreshes", (totals) => String(totals.refreshes)],
  ["Warming fee", (totals) => formatUsd(totals.costUsd)],
  ["  no prompt followed", (totals) => formatUsd(totals.wastedUsd)],
  ["Prompts kept", (totals) => String(totals.kept)],
  ["Rewrites avoided", (totals) => formatUsd(totals.keptUsd)],
  ["Net saved", (totals) => formatUsd(totals.keptUsd - totals.costUsd)],
];

const BASIS_LINES = [
  "A prompt is kept when it reads the cache after the point where, without refreshes, it would have expired.",
  `Avoided = cached tokens read × (write − read price). API list prices (${PRICES_AS_OF}).`,
];

const analyticsPageOf = (
  elements: ElementTable,
  { totals, allTime }: PaneData,
  actions: PaneActions,
) => {
  const { Box, Text } = elements;
  const lines = tableOf(
    [
      ["", "This session", "All time"],
      ...ANALYTICS_ROWS.map(([label, valueOf]) => [
        label,
        valueOf(totals),
        valueOf(allTime),
      ]),
    ],
    [true, false, false],
  );
  return (
    <Box flexDirection="column">
      {headerOf(elements, "Analytics", actions.open)}
      {lines.map((line, index) => (
        <Text
          key={`row:${index}`}
          wrap="truncate-end"
          dimColor={index === 0}
          bold={index === lines.length - 1}
        >
          {line}
        </Text>
      ))}
      <Text key="since" dimColor>
        {`All time since ${new Date(allTime.since).toISOString().slice(0, 10)}`}
      </Text>
      {BASIS_LINES.map((line, index) => (
        <Text key={`basis:${index}`} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
};

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

const debugPageOf = (
  elements: ElementTable,
  { list, logPath, at, width, rows }: PaneData,
  actions: PaneActions,
) => {
  const { Box, Text, Button } = elements;
  const logText = `Log: ${logPath}`;
  // The header row, the Turn off row, the wrapped log path and the table's header.
  const room = Math.max(0, rows - 3 - rowsOf(logText, Math.max(10, width)));
  const shown = room > 0 ? list.slice(-room) : [];
  const [header = "", ...lines] = tableOf(
    [DEBUG_HEADER, ...shown.map((one) => debugCellsOf(one, at))],
    DEBUG_LEFT,
  );
  return (
    <Box flexDirection="column">
      {headerOf(elements, "Debug mode", actions.open)}
      <Box key="off" flexDirection="row">
        <Button
          key="debug:off"
          label="Turn off"
          onPress={actions.turnOffDebug}
        />
      </Box>
      <Text key="log" dimColor wrap="wrap">
        {logText}
      </Text>
      <Text key="columns" dimColor wrap="truncate-end">
        {list.length === 0 ? "No refreshes yet." : header}
      </Text>
      {lines.map((line, index) => (
        <Text
          key={`refresh:${shown[index]?.at ?? index}`}
          wrap="truncate-end"
          dimColor={shown[index]?.result !== "warmed"}
        >
          {line}
        </Text>
      ))}
    </Box>
  );
};

export const paneOf = (
  elements: ElementTable,
  data: PaneData,
  actions: PaneActions,
  mascot?: RenderElement,
) => {
  if (data.page === "global") return globalPageOf(elements, data, actions);
  if (data.page === "session") return sessionPageOf(elements, data, actions);
  if (data.page === "analytics")
    return analyticsPageOf(elements, data, actions);
  if (data.page === "debug") return debugPageOf(elements, data, actions);
  return mainPageOf(elements, data, actions, mascot);
};
