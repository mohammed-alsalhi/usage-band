# usage-band

A band above the Claude Code prompt that shows your rate limits and spend, built as a
Claude Code plugin (a hooks module).

```
(ring)  3%  5h            · resets 4h31m  [graph]            (ring) 32%  7d        · resets 4d7h  [graph]
($)  $2.99  $12.08 today  · $12.08 mo                        (ring) 11%  7d fable  · resets 4d7h  [graph]
```

## Layout

The band is two groups. The 5h window and the cost sit on the left; the weekly windows (`7d` and
each per-model weekly, such as `7d fable`) are pinned to the right edge.

Within a group, every field is its own column, so they line up down the rows whatever the text
widths: rings, then percentages (right-aligned, so `3%` sits under the `9` of `$2.99`), then labels
(`5h`, `7d`, `$12.08 today`), then reset times, then graphs. The cost row shares those columns.

The space between the two groups is left free, so more can be added in the middle.

If the window is too narrow for both groups side by side, they stack into one group, so all four
rows share the same columns instead of each group lining up on its own.

## The rings

Each rate-limit ring has two parts: the **outer ring** is how much of the limit you have used,
and the **inner pie** is how much of the window has gone by since its last reset. If the ring is
further round than the pie, you are burning faster than time is passing.

| | |
| --- | --- |
| <img src="docs/ring-ahead.svg" width="40" alt="Outer ring about an eighth full, inner pie about 40% full"> | **Ahead of pace.** 12% used, 40% of the window gone. Green below 70%. |
| <img src="docs/ring-behind.svg" width="40" alt="Outer ring three-quarters full in amber, inner pie almost full"> | **Close to the line.** 75% used, 95% of the window gone. Amber from 70%. |
| <img src="docs/ring-over.svg" width="40" alt="Outer ring almost full in red, inner pie half full"> | **Burning too fast.** 95% used, only half the window gone. Red from 90%. |
| <img src="docs/ring-cost.svg" width="40" alt="Full green ring with a dollar sign"> | **Cost.** This session's spend, then today and this month. No window, so no pie. |

Beside each ring: the percent used, the window (`5h`, `7d`, or a per-model weekly such as
`7d fable`), when it resets, and a line graph of usage since the reset. The graph spans the whole
window, so where the line stops is how far in you are. In a terminal, which can't draw SVG, the
graph is text instead: one cell per slice of the window, `▁▂▃▄▅▆▇█` by usage and `·` where the
slice is still ahead.

## Install

```sh
git clone https://github.com/mohammed-alsalhi/usage-band ~/.claude/mods/usage-band
```

Point Claude Code at the folder in `~/.claude/settings.json`, and set the watch flag so a running
session reloads the mod when you save it:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/usage-band",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

Then start a new session. The mod needs a Claude Code build with the plugin hooks API
(2.1.286 here).

## How it works

- Readings come from the session's own usage plus the account usage endpoint, which is where the
  per-model weekly limits live. The engine holds the credential; the mod never sees the token.
- Readings and spend are kept in the plugin store, shared by every session, so graphs and the
  today/month totals carry across sessions. Spend is counted once per session however often it
  is measured.
- The rings are plain SVG built in `hooks/register.tsx`. The files in `docs/` are samples
  made with the same code.

## Develop

```sh
claude plugin validate .
claude plugin test .
```
