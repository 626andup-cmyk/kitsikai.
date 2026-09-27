# Intimacy: how it works

The persona's [INTIMACY] section describes several ways she can be with you, from ordinary warmth to its edges. This page is about the machinery that makes those real in the app: how she ends up in one, and the safeword that stops all of it. The code is `src/intimacy.ts`, with the hold saved by `src/hold.ts`.

## Registers

A **register** is one of those modes, by name:

| Register | What it is (in brief) |
| --- | --- |
| `warm` | Ordinary fondness and care. The resting state: nothing is added to her prompt. |
| `soft` | The soft edge. |
| `hard` | The hard edge. |
| `capture` | Being taken, and kept. |
| `leverage` | What you told her, used as leverage. |
| `contract` | Ownership made explicit. |
| `safe` | After the safeword. Never picked; only the safeword puts her here. |

The persona's own words for each are in `defaults/persona.md`. Jev gets short neutral descriptions (`REGISTER_DESCRIPTIONS`), because it only has to classify, and the chat model gets a few lines for the one she's in (`REGISTER_PROMPTS`).

## Before each of her turns

`routeTurn` decides, for every kind of turn: a reply, "Her turn", a regenerate, texting first. In order:

1. **The safeword**, in any of your bubbles since her last reply: the hold starts, and she's `safe`.
2. **A hold**: she stays `safe`, unless you've brought her back (below).
3. **Otherwise Jev picks.** It gets the last 12 messages and one question, "which mode is she in right now?", with the six registers as options. It answers with a probability for each, like every Jev question (see [stage 7](stage-7.md)). The top one counts only if Jev is at least as sure as Settings → **How sure Jev has to be** (80% by default). Unsure, Jev failing, or an empty channel: `warm`.

The register she's in becomes one short section of her prompt, **"Between you right now"**, after her notes and before the tools. `warm` adds nothing. The server log says which register she's in and why, never what was said:

```
[kitsikai] intimacy register: warm (no register was confident enough (top: soft at 62%))
```

**Preview prompt** (channel settings) can't show Jev's pick, since Jev makes it when her turn starts. During a hold, the preview does show `safe`.

It costs one extra Jev call per turn, usually under a second, before she starts typing. Settings → **Intimacy registers** off: no call, and it's the persona alone. The safeword still works.

## The safeword

The safeword is **"seriously"**, said as a boundary. `isSafeword` checks for it with a text match, not a model, so it works when Jev is down or routing is off, and nothing can talk it out of it. Because "seriously" is also an everyday word, it errs on the side of stopping:

- A **short** message (8 words or fewer) with "seriously" in it always counts: "seriously", "no, seriously", "seriously?".
- A **longer** one counts if it also has a boundary word: stop, no, can't, don't, wait, enough, pause, please, not okay, too much, and a few more.
- Only a longer, easy-going message without any doesn't: "that was seriously the best pizza i have had in years honestly".

A false alarm costs a mood, and one tap undoes it. A missed safeword would cost much more.

## The hold

After the safeword she **holds**, "until you bring me back", as the persona puts it. The hold is one row in the database, so it lasts across turns, **every channel**, and restarts:

- Her turns are `safe`: plain warmth, nothing else.
- She doesn't text first, **except reminders you set up**, and those go out plain too (`src/proactive.ts`).
- A banner above the text box says "Safeword heard: she's holding until you bring her back", and Settings → Intimacy shows since when.

**Bringing her back** takes one of two things:

- **Tell her.** While a hold is on, each turn asks Jev whether your messages since the safeword clearly invite her back: that you're okay now and want her to be herself again. Only a confident yes counts, at least 90% (or Settings → How sure Jev has to be, if that's higher). Unsure, or Jev failing, keeps the hold. The turn she comes back on is `warm`, and Jev picks again from the next one.
- **Tap "Bring her back"**, on the banner or in Settings → Intimacy. That ends the hold at once. If the safeword is still the last thing you said, though, her next turn starts it again, since you said it.

Saying the safeword again during a hold doesn't restart it: it keeps the time of the first one.

## Notifications

Settings → **Show what she said in notifications** is on by default. Off, a notification only says "New message", for a lock screen other people can see.

## Where things are

| | |
| --- | --- |
| `src/intimacy.ts` | The registers, Jev's question, the safeword, `routeTurn` and bringing her back |
| `src/hold.ts` | The hold, saved in the database |
| `src/kitsikai.ts` | Calls `routeTurn` at the start of every turn, and adds the register to her prompt |
| `src/prompt.ts` | The "Between you right now" section |
| `src/proactive.ts` | Only reminders during a hold |
| `test/intimacy.test.ts` | Tests, with placeholder messages |
