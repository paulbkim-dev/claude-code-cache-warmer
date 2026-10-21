import { expect, test } from "claude-code/testing";

import { decide } from "../hooks/warmer";
import { OPUS, SONNET, near } from "./world";

test("the refresh decision follows Pi: idle prompts need 15% odds to clear $0.05; running turns count fully", () => {
  // 200k Opus 5.5 tokens: read $0.04 + 200 output tokens $0.004; a 5m rewrite is $1.00, so a miss adds $0.96.
  const idle = decide(OPUS, 200_000, "5m", "idle", 200);
  near(idle?.warmUsd, 0.044);
  near(idle?.missUsd, 0.96);
  near(idle?.expectedUsd, 0.15 * 0.96 - 0.044);
  expect(idle?.isWarm).toBe(true);
  // 50k tokens: 0.15 * $0.24 - $0.014 = $0.022 idle, below the threshold; $0.226 while a turn runs.
  expect(decide(OPUS, 50_000, "5m", "idle", 200)?.isWarm).toBe(false);
  // Break-even sizes solved by hand: Opus 5.5 idle (54,000 / 0.52 per token) and Sonnet 5.5 idle (52,000 / 0.26).
  expect(idle?.reason).toBeUndefined();
  expect(decide(OPUS, 50_000, "5m", "idle", 200)?.reason).toBe(
    "50.0k tokens is below the 103.8k break-even on claude-opus-5-5 at 5m (idle)",
  );
  expect(decide(SONNET, 150_000, "5m", "idle", 200)?.reason).toBe(
    "150.0k tokens is below the 200.0k break-even on claude-sonnet-5-5 at 5m (idle)",
  );
  near(decide(OPUS, 50_000, "5m", "run", 200)?.expectedUsd, 0.226);
  // A 1h rewrite costs 2x input: 200k * $8 / 1M = $1.60.
  near(decide(OPUS, 200_000, "1h", "idle", 200)?.missUsd, 1.56);
  expect(
    decide("claude-gateway/gpt-6-astra", 200_000, "5m", "idle", 200),
  ).toBeNull();
});

test("Bedrock, Mantle and Vertex model ids take the price of the model they name", () => {
  const opus = decide(OPUS, 200_000, "1h", "idle", 200);
  for (const id of [
    "us.anthropic.claude-opus-5-5",
    "global.anthropic.claude-opus-5-5",
    "us-gov.anthropic.claude-opus-5-5",
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/apac.anthropic.claude-opus-5-5",
    "anthropic.claude-opus-5-5",
    "claude-opus-5-5@20260901",
  ])
    expect(decide(id, 200_000, "1h", "idle", 200)).toEqual(opus);
  // Haiku 4.5 at $1 input: a 1h rewrite of 1M tokens costs 1M * ($2 - $0.10) / 1M = $1.90.
  for (const id of [
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "claude-haiku-4-5@20251001",
  ])
    near(decide(id, 1_000_000, "1h", "run", 200)?.missUsd, 1.9);
  expect(
    decide(
      "arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/opus-prod",
      200_000,
      "1h",
      "idle",
      200,
    ),
  ).toBeNull();
});

test("Haiku 5.5 takes its long-prompt price over 100,000 tokens", () => {
  // At 200k the long tier applies: 200k * ($0.625 - $0.05) / 1M = $0.115 to rewrite at 5m.
  near(decide("claude-haiku-5-5", 200_000, "5m", "run", 200)?.missUsd, 0.115);
  // At 50k the short tier: 50k * ($0.125 - $0.01) / 1M = $0.00575.
  near(decide("claude-haiku-5-5", 50_000, "5m", "run", 200)?.missUsd, 0.00575);
  // The short tier never reaches $0.05, so the break-even is just over 100k at the long tier's price.
  expect(decide("claude-haiku-5-5", 50_000, "5m", "run", 200)?.reason).toBe(
    "50.0k tokens is below the 100.0k break-even on claude-haiku-5-5 at 5m (run)",
  );
});
