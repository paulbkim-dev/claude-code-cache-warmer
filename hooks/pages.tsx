import type { ElementTable } from "claude-code";

import type { Totals, Ttl } from "../types";
import type { Mascot, PaneActions, PaneData } from "./pane";
import { headerOf, mainPageOf, statusTextOf, tableOf } from "./pane";
import {
  MIN_SAVINGS_USD,
  PRICES_AS_OF,
  delayOf,
  formatDuration,
  formatUsd,
  idleSpanOf,
} from "./warmer";

const TTLS = ["5m", "1h"] as const;

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
  band: "Refresh band",
  "5m": "Idle refreshes, 5m",
  "1h": "Idle refreshes, 1h",
};
const GLOBAL_LABEL_WIDTH = Math.max(
  ...Object.values(GLOBAL_LABELS).map((label) => label.length),
);

const globalPageOf = (
  elements: ElementTable,
  { saved, limits, isBandShown }: PaneData,
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
      <Box key="band" flexDirection="row">
        {label(GLOBAL_LABELS.band)}
        {[true, false].map((value) => (
          <Button
            key={`band:${value ? "on" : "off"}`}
            label={value ? "on" : "off"}
            variant={value === isBandShown ? "primary" : undefined}
            dimColor={value !== isBandShown}
            onPress={() => {
              if (value !== isBandShown) actions.toggleBand();
            }}
          />
        ))}
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
  const status = statusTextOf(state, at);
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
      {status && (
        <Text key="status" dimColor>
          {status}
        </Text>
      )}
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

export const paneOf = (
  elements: ElementTable,
  data: PaneData,
  actions: PaneActions,
  mascot?: Mascot,
) => {
  if (data.page === "global") return globalPageOf(elements, data, actions);
  if (data.page === "session") return sessionPageOf(elements, data, actions);
  if (data.page === "analytics")
    return analyticsPageOf(elements, data, actions);
  return mainPageOf(elements, data, actions, mascot);
};
