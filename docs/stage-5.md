# Stage 5: how it works

Stage 5 adds the 📈 **trackers channel**: things you'd like her to keep an eye out for, and a **sticker** on the day each time one happens. According to [DESIGN.md](../DESIGN.md), its new concept is **user-defined data**.

In this stage you add stickers yourself. From stage 7, she notices things in chat and adds them too (carefully: pencil first, pen later).

## The binder

DESIGN.md calls everything Kitsikai knows about your life **the binder**, and it has three kinds of record:

| Record | What it is | Stage |
| --- | --- | --- |
| **Plans** | What you plan | 3 |
| **Trackers** | What to watch for | 5 |
| **Log entries** | What actually happened | 5 |

A headache yesterday is a log entry of the "headache" tracker, on yesterday's date. The dentist on Thursday is a plan.

## Concept: user-defined data

Until now, every kind of data had a shape decided in advance: a plan always has a kind, a title, a start. Trackers are different: **you** decide what exists. One person tracks headaches and meds, another tracks payday and gym days. The app can't know in advance what you'll track, so it stores two layers:

1. **The definition**, which you make: a tracker's name, its **kind** of value, its hint words, and whether she may bring it up.
2. **The data**, which follows the definition's rules: each log entry's value must fit its tracker's kind.

That second part is the heart of it. A log entry's `value` is always stored as text, but what text is allowed depends on the tracker (`checkValue` in `src/trackers.ts`):

| Kind | Allowed values | Tidied |
| --- | --- | --- |
| Yes or no | `yes`, `no` | "Yes" becomes "yes"; `true` becomes "yes" |
| A scale from 1 to 10 | whole numbers 1 to 10 | " 7 " becomes "7"; 6.5 and 11 are refused |
| A note | any text up to 1000 characters | trimmed; empty is refused |

Because the rules come from the definition, **changing the definition could break the data**: if a yes/no tracker with 30 entries became a scale, "yes" wouldn't be a valid value any more. So a tracker's kind can only change while it has no entries. Its name, hint words and "can bring it up" can change any time, because entries don't depend on them.

This is a common pattern in apps with user-defined things (custom fields, forms, spreadsheets): check the data against the definition when it's saved, and protect existing data when the definition changes.

## Trackers

| Field | Notes |
| --- | --- |
| Name | "headache", "took meds", "payday" |
| Kind | Yes or no, a scale from 1 to 10, or a note |
| Hint words | Your keywords, like "head, migraine". **Clues, not rules**: in stage 7, Jev reads them as hints but still decides whether the thing actually happened, so "I *don't* have a headache" doesn't log one. Stored lowercase, without repeats. |
| She can bring it up | If off, it's logged quietly and she never raises it unprompted (from stage 8). |

Deleting a tracker deletes its stickers too (`ON DELETE CASCADE`), after asking.

## Log entries: stickers

A log entry is a sticker on a day:

| Field | Notes |
| --- | --- |
| Tracker, day, value | The value fits the tracker's kind |
| How it got there | `user` (you added it), `processing` (from stage 7: she noted it from chat and it held up), or `confirmed` (she asked and you said yes) |
| Source message | The message it came from, if any. **Show the message** opens its channel, scrolls to it and highlights it. If the message is deleted, the sticker stays (`ON DELETE SET NULL`). |

## Where you see them

- **The trackers channel** (one per server, like the planner; existing servers got one when they upgraded): each tracker as a card with its hint words, a two-week strip with a cell per day, one-tap logging for today (Yes/No, a number, or a note), and its latest stickers. Tap a day in the strip to add a sticker there, or a sticker to change or delete it.
- **The planner's calendar**: days with stickers get small dots, and the selected day's panel lists its stickers under its plans, with **Add a sticker**.

Stickers show their value compactly: ✓ and ✗ for yes/no (green and red), "7/10" for scales, the text for notes.

When trackers or stickers change, the server sends a `log` event, and whichever screen shows them redraws.

## Tests

- `test/trackers.test.ts`: `checkValue` for each kind; making, changing and deleting trackers (hint words tidied, kind locked once there are entries, deleting takes the entries along); stickers added, filtered by date and tracker, changed, deleted; everything refused that should be; and a sticker keeping its place when its source message is deleted.
- `test/ui.test.ts`: make a tracker in the browser, log today with one tap, change the sticker from the strip, delete the tracker; stickers on a calendar day, adding one from the day panel, and "show the message" jumping to the highlighted message in `#general`.
