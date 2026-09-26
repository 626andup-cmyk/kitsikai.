# Stage 8: how it works

Stage 8 lets her **text first**: reminders in her own words, "how'd work go?" when your shift ends, following up on something, or just because. Usually she doesn't. According to [DESIGN.md](../DESIGN.md), the new concepts are **background timers** and **notifications**.

## The core rule pays off

Since stage 1, Kitsikai has had one rule, copied from Aettica: **a turn never requires a message from you.** There's one "takes a turn" function (`takeTurn` in `src/kitsikai.ts`), and it only ever reads what's saved. Your message was one thing that could call it; the "Her turn" button was another. Stage 8 adds a third: a timer. Texting first is an add-on, not a rewrite, because of that rule.

The only new thing a proactive turn passes is a **note** saying why she's texting (never saved, never shown), which ends her prompt instead of your message:

```
(App note, not from them: you're texting first, because their work just ended (at 5:30 PM):
a good moment to ask how it went. If it doesn't feel right after all, you can choose not to text.)
```

## Concept: background timers

A web server normally only does things when asked: a request comes in, an answer goes out. Texting first needs the opposite, something that happens **when nobody asked**. That's a **background timer**: `setInterval` runs a function every so often, for as long as the server runs.

Kitsikai has exactly one (`src/scheduler.ts`, from stage 7). Once a minute it looks at what's due:

- a **processing round** of her notes, every few hours (stage 7)
- her **snapshot check**, every few minutes (Settings: "Check every", default 10)

Two things make timers manageable:

- **One timer, many jobs.** Each job says when it's due (`due()`, `snapshotDue()`); the timer just asks. Adding stage 8's job didn't need a second timer.
- **Time comes from a clock you can swap.** Everything asks `clock()` instead of `new Date()`. The real server's clock is the real time; tests pass a fake one and call `tick()` themselves, so "10 minutes later" takes a millisecond, and nothing depends on when the tests happen to run. (Stage 8 also made new messages use that clock, so her timers and your messages always agree on the time.)

## The snapshot check

`src/proactive.ts`. Every check takes a **snapshot** of what's going on:

- the time, and today's and tomorrow's plans (and whether you're at work)
- **due reminders**
- when you last talked, who sent the last message, and **how many times she's texted first without a reply**
- a work block that **just ended** (and hasn't had its check-in)
- things to follow up on: her pins, the things she might bring up, and recent stickers from trackers **she may bring up** (a tracker with "Can she bring it up?" off stays out of it)
- the last few hours of chat

Then Jev answers, each with a probability:

| Question | Asked when |
| --- | --- |
| Did they already talk about this reminder? (then it's skipped) | a reminder is due |
| Their work just ended: would asking how it went feel natural? | a work block ended in the last 90 minutes |
| Is something worth following up on right now? | there's something to follow up on |
| It's been quiet: would a "just because" text feel natural, not needy? | it's been quiet for 2 hours |
| She's already waiting on a reply: would another text feel natural, or pushy? | she's texted first without a reply, and the cap is "Let her judge" |

A due reminder that wasn't just talked about, or any other confident yes → **her turn runs**. All no → nothing happens, which is most of the time. Only questions worth asking are asked: most checks find nothing to ask about and never call Jev at all.

### Rules that aren't up to Jev

- **The double-text cap** (Settings: "Texts in a row without a reply"). **Let her judge** asks Jev every time. A cap of **1, 2 or 3** is a **hard wall**: once she's texted first that many times without a reply, Jev isn't even asked. **Reminders ignore the cap**: a reminder isn't chatting.
- Nothing but reminders within **20 minutes** of the last message anywhere: that's still a conversation, not texting first. And nothing but reminders before you've ever texted her.
- No check at all while she's writing, or waiting to reply, anywhere.
- **Texting first** can be turned off in Settings: then she only ever replies.

"How many times she's texted first without a reply" counts her proactive texts since your last message. Her reply to you isn't one of them: a conversation that ends on her reply ended naturally.

## Reminders, sent

Stage 3 worked out *when* each plan's reminders go off, and moved them earlier when they'd land during work. `src/reminders.ts` finds the ones that are **due**, gone off and not yet dealt with, and remembers what happened to each (`reminders_sent`), so every reminder goes out once:

| Status | Meaning |
| --- | --- |
| sent | she texted it, or mentioned it in a conversation |
| skipped | you'd just talked about it (Jev), or she chose not to |
| queued | every channel was mid-conversation: she'll mention it in the one you're in |

A reminder stops being due once its plan starts (for an all-day plan, once the day is over), or a day after it went off, so reminders missed while the phone was off aren't sent days late. If an earlier reminder was missed, only the latest is due: a missed "day before" is replaced by "2 hours before", not sent alongside it.

Due reminders are also **always in her prompt**, so if one fits naturally into a conversation that's already going, she can mention it. After each of her turns, Jev checks whether she did (`noticeTurn`), and if so, it counts as sent.

## Picking the channel

1. Jev picks the channel that fits the reason best, from the channels' **names and topics** (a check-in about work → `#work`, if its topic is "work stuff"). Unsure → the **home channel**.
2. **The interruption check.** For a channel with messages in the last **30 minutes**, Jev is asked whether a text now would interrupt a conversation in progress. Yes, or unsure → the next-best channel. (A channel with nothing in the last 30 minutes can't be interrupted.)
3. If every candidate is mid-conversation: a **reminder** is queued into the conversation you're already having, and her prompt there says to mention it now ("oh btw, dentist in 2 hours"). Anything else waits for the next check.
4. Her turn runs in that channel, with its recent history in view, like any other turn.

How far back to look, and what counts as "a conversation in progress", was an open question in DESIGN.md. This stage answers it with 30 minutes and Jev's judgement; both are easy to change (`INTERRUPT_MINUTES`).

## On call

An on-call shift is free by default. The scratchpad check (stage 7) now also asks, while you're inside an on-call window: **did you get called in?** If Jev is sure, that occurrence counts as work (`called_in` table), so she treats you as at work, reminders dodge it, and when the window ends it's a check-in. While you're called in, it asks instead: **are you done?** Whichever comes first, your "done" or the window ending, ends it.

## Concept: notifications

A notification is how an app reaches you when you're not looking at it. A web page can't do that on its own once it's closed, and a server can't reach into your phone's notification shade. Version one uses **Termux:API** (`src/notify.ts`): a companion app for Termux that gives command-line programs access to Android features. The server runs:

```
termux-notification --title "Kitsikai in #general" --content "how'd it go??"
                    --id kitsikai-<channel> --action "termux-open-url 'http://127.0.0.1:3000/#/channel/<channel>'"
```

- One notification per channel: a newer message replaces the older one.
- Tapping it opens the app **at that channel**.
- **Only when the app isn't on screen.** The app tells the server whether it's visible (`POST /api/presence`) whenever that changes; with no app connected, it isn't. Every message she sends goes through this, replies included, so a reply that arrives after you've locked your phone also notifies you.
- The server takes a **wake lock** when it starts (`termux-wake-lock`), and you exempt Termux from battery optimization, so the timer keeps running while the phone sleeps (see [install.md](install.md)).
- On a computer, there's no Termux: notifications are off, and Settings says so.

Web Push from the PWA is a later upgrade (DESIGN.md's endgame).

## The advanced page

Settings → Advanced → **Kitsikai's notes** now has a **Texting first** section: when the last check ran and when the next is due, the reminders that are due now, the recent checks (what she decided and why: "Texted first (a check-in after work): Their work just ended at 5:30 PM (95% sure). #work fits best (93% sure)."), and every reminder sent, skipped or queued. **Check now** runs a snapshot check straight away, for testing.

Checks that decide nothing aren't kept (there'd be one every 10 minutes), except when you press Check now.

## The data

Migration 7 (`src/db.ts`) adds:

| Table | What it holds |
| --- | --- |
| `reminders_sent` | What happened to each reminder of each occurrence (`planId:date:reminderId`) |
| `called_in` | On-call occurrences you got called in to, and when you said you were done |
| `proactive_log` | Each snapshot check that did something: outcome, reason, channel, message, and why; kept two weeks |

## Tests

- `test/proactive.test.ts`: due reminders (going off, the plan starting, stale ones, all-day plans, the latest-only rule, queued ones) and in the prompt; the snapshot check (nothing to ask, a reminder texted once, skipped reminders, the cap as a hard wall, reminders ignoring it, "Let her judge", check-ins once per work block, follow-ups, trackers she can't bring up, quiet time, not while replying, turned off, choosing not to text, Jev unreachable or off, what's logged); picking the channel (best fit, unsure → home, the interruption check, queued reminders mentioned later, waiting); reminders mentioned in conversation; on call (called in, done, the window's end as a check-in); notifications (only while the app isn't on screen); the scheduler; the API; the settings.
- `test/ui.test.ts`: the texting-first settings, and Check now texting a due reminder into the chat.

Notifications and the wake lock can only be tested on the phone: see the live test notes in the README.
