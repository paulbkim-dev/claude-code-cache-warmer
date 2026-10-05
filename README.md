# cache-warmer

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/clawd-dark.gif">
  <img alt="Clawd sips from a steaming mug while the cache warms, hops under a heart of steam once it is warm, and dozes when it expired" src="assets/clawd-light.gif" width="914">
</picture>

Keeps the main conversation's prompt cache warm the way [Pi](https://github.com/earendil-works/pi) 1.0.2 does.
Shortly before the cache entry expires, the mod forks the main conversation's
last request with one short prompt, so the API reads the prefix and resets its
lifetime.
The fork never enters the conversation.
The transcript keeps one notice row per refresh, prefixed with ☕, which no request carries.
While a refresh runs, a band above the prompt shows Clawd, the Claude Code
mascot, sipping from a steaming mug, and then the result: a hop and a heart of
steam for a warm cache, or a cold mug and a dozing Clawd for an expired cache or
a failed refresh.
The band needs seven free rows and a terminal; elsewhere it shows the result
line alone, and `reduceMotion` holds Clawd still.
`/cache-warmer preview` plays the band's three states without a refresh.

## Install

Cache Warmer is a Claude Code mod; it was tested on Claude Code 2.1.289.

```sh
claude plugin marketplace add paulbkim-dev/claude-code-cache-warmer
claude plugin install cache-warmer@claude-code-cache-warmer
```

Restart Claude Code, then run `/cache-warmer` to open the pane.
`claude plugin disable cache-warmer` stops all warming.

## The pane

`/cache-warmer` toggles a pane that opens on a menu: Global configuration, Session configuration, Analytics and Debug mode.
Tab and the arrow keys move between items, Enter opens one, and the first item holds the focus when the pane takes the keyboard.
Each page starts with a Back button, which returns to the menu; reopening the pane starts on the menu.
Escape closes the pane when it has keyboard focus or the prompt is idle and empty.
Under the menu, one line says when the next refresh is due or why warming stopped.

A terminal pane with room for him shows Clawd left of the menu.
He plays the band's notice while one is up, sips while warming is on, and dozes once it stopped.
Clawd's mug and steam follow Claude Code's theme: a light theme draws them for a light background.
Under the `auto` theme, a light background in `COLORFGBG` does the same.
Claude Code also asks the terminal for its background under `auto`, but plugins cannot read that
answer, so a terminal that sets no `COLORFGBG` gets the dark palette.

## Global and session settings

The Global configuration page saves settings for new sessions in the plugin's `/config` rows.
Its Default lifetime buttons, the `/config` row `cache-warmer.ttl` and `/cache-warmer 5m` or `/cache-warmer 1h` save the default lifetime.
The page and `/config` save it even after the session's lifetime is locked; the current session follows only while it is unlocked.
The command also sets the current session, and refuses while the lifetime is locked.

The Session configuration page changes the current session alone and leaves the saved default as it was.
It shows the lifetime, the refresh interval, the idle limit, the next refresh or stop reason, and the `FORCE_PROMPT_CACHING_5M` warning.

## Lifetime

The mod sets `CLAUDE_CODE_PROMPT_CACHE_TTL` for this Claude Code process, so it
overrides the `promptCacheTtl` setting and any value inherited from the shell.
The change applies from the next request, and that request writes the cache again once.
The first main-conversation response of a session locks the session's lifetime:
the Session page shows it without buttons.
`/clear` unlocks it, and a new session starts unlocked.
`FORCE_PROMPT_CACHING_5M=1` keeps the cache at 5 minutes whatever the choice; the Session page says so.
A 1-hour write costs 2x the input price instead of 1.25x.
A refresh extends both lifetimes.
In a live test on 2026-10-05, a fork in the default 5-minute subagent bucket
kept a 1-hour entry past 60 minutes, while a session without the mod rewrote it.
A refresh that reads less than half the prefix reports the cache as expired and stops warming.

## When it refreshes

A refresh is due at 90% of the lifetime: every 4m30s for 5 minutes and every 54m for 1 hour.
At that point the mod applies Pi's rule: the chance of another request before
expiry, times the extra cost of rewriting the prefix, minus the refresh's cost,
must be at least $0.05.
The chance is 100% while a turn is running and 15% while the session is idle.
The rule gives each model a break-even prompt size, and the mod checks it when a response arrives, before it queues a refresh.
Idle 5-minute caches break even at about 104k tokens on Opus 5.5 and 359k on Sonnet 5.5; 1-hour caches at about 56k and 141k.
While a turn runs the sizes are far lower: about 12k and 25k for 5 minutes.
A prompt below its size gets no refresh, and the stop reason names both sizes.

While the session is idle, each lifetime gets at most its idle limit of refreshes after the last prompt request.
The Global page sets each limit from 0 to 20, 5 by default, as `/config` rows `cache-warmer.idle5m` and `cache-warmer.idle1h`.
Beside each limit the page shows how long an idle cache stays warm: the limit times the refresh interval, plus one lifetime.
The default keeps a 5-minute cache for 27m30s and a 1-hour cache for 5h30m.
Every idle refresh still has to pass Pi's rule.
While a turn runs, warming stops 60 minutes after the last prompt request, or after two lifetimes when that is longer.
Warming also stops on compaction, `/clear`, a model switch, a failed or expired
refresh and a timer that fired too late; the next request starts it again.

A fork has no output cap, so the estimate includes the previous refresh's
output tokens; Opus 5.5 at high effort used 182 in a test.

## Analytics

The Analytics page counts this session and all time side by side.
All-time totals persist in the plugin's store and start on the date the page shows.
Costs are estimates at the API list prices in `hooks/warmer.ts`, not subscription charges.

| Row | Meaning |
| --- | --- |
| Refreshes | Refreshes sent. |
| Warming fee | What the refreshes cost. |
| no prompt followed | The fees of refresh chains that no kept prompt followed. |
| Prompts kept | Prompts that read the cache after the point where, without refreshes, it would have expired. |
| Rewrites avoided | For each kept prompt, the cached tokens it read times the write price minus the read price. |
| Net saved | Rewrites avoided minus the warming fee. |

A refresh chain is the refreshes between two prompt requests.
The next prompt either keeps the chain or wastes its fee.
`/clear`, compaction and a model switch waste a chain's fee at once, and a chain still running counts as neither.

## Debug mode

The Debug mode menu item turns debug mode on and opens its page; Turn off ends it.
The page lists the newest refreshes that fit the pane, with their age, result, tokens read and written, output tokens, cost and estimated saving.
A refresh saves only when a prompt follows before expiry.
While debug mode is on, the mod appends one JSON line per refresh and per stop to
`<config>/cache-warmer/debug/<session id>.jsonl`, where `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`.
A refresh line has its time, model, token usage, cost, saving, result, phase and lifetime; a stop line has its time and reason.
A failed write is reported in a log line, and warming continues.

The mod cannot see `/rewind`; after one, refreshes keep the later prefix warm until the next request.

## What it sends and stores

Each refresh is a fork of the main conversation's last request, sent through
Claude Code to the model the conversation uses, with the prompt
"Prompt cache refresh. Reply with the single word ok."
It counts against your Claude plan or API key like any other request.
The mod makes no other network requests and sends no telemetry.
It sets `CLAUDE_CODE_PROMPT_CACHE_TTL` for the running Claude Code process,
keeps all-time totals in its plugin store, appends one notice row per refresh to the transcript,
and writes the debug log described above only while debug mode is on.
Setting both idle limits to 0 stops idle refreshes; disabling the plugin stops all of them.

## Credits

The refresh timing, the $0.05 rule and the idea of an idle limit come from the cache warmer in
[Pi](https://github.com/earendil-works/pi) by Mario Zechner.
cache-warmer ports them to a Claude Code mod and counts idle refreshes instead of stopping at 30 minutes;
it copies no Pi code.

## Support

Report problems at [github.com/paulbkim-dev/claude-code-cache-warmer/issues](https://github.com/paulbkim-dev/claude-code-cache-warmer/issues).
Cache Warmer is released under the [MIT License](LICENSE).
