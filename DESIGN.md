# Kitsikai — Design Doc

Sep 26, 2026 · working title: the app is named after her until it has a name of its own

## Concept

A dedicated app for **Kitsikai**, an AI friend you text with. Unlike a normal chat frontend, she can be **proactive**: she knows your work schedule and your plans, keeps an eye on things you've asked her to track, remembers what matters right now, and texts you first when it makes sense.

- The app looks and feels like a small Discord server shared by you and her: a sidebar of channels, including a 📅 planner.
- She texts in short bubbles with realistic typing delays, like a real person.
- She writes things down in pencil first (a private scratchpad) and only commits them to pen after a few hours, so misunderstandings get corrected before anything becomes "fact."
- A fast decision model, **Jev**, makes the many small yes/no calls (did this happen? should she text now? which channel?), and a normal chat model only wakes up when there's something to write.

**Who this doc is for:** Claude Code, and the owner, who is learning to code. Explain things for a beginner: plain language, why things work and not just what they do. Each build stage gets a `docs/stage-N.md` explaining how it works, like Aettica's.

## Core architecture

A small Bun server runs in Termux on the phone and holds all data in SQLite; the app runs in Chrome, installed to the home screen as a PWA. Same setup as Aettica. Everything stays on the phone except the API calls to nanoGPT.

### Furniture from Aettica

This is a **fresh repo**, not a fork. Copy these proven pieces from [Aettica](https://github.com/626andup-cmyk/aettica) (public, same owner, AGPL-3.0) and adapt them. Leave everything else behind (scenes, literary/casual modes, the notebook, permissions, comments).

| From Aettica | Why |
| --- | --- |
| `themes/`, `public/glass.js`, the CSS-variable and theme-scoping system, Appearance sliders, Full/Lite/Automatic glass | The design language. Kitsikai's app should look and feel like a sibling of Aettica. |
| `src/nanogpt.ts`, `src/profiles.ts` | Connection profiles and roulettes, one per job (see "Models and jobs") |
| `src/toolcalls.ts` and the tool loop from `src/partner.ts` | Messy tool calls (broken JSON, tool calls written as text by DeepSeek/GLM/Kimi) are handled, not failed |
| The channel sidebar, channel parts of `db.ts` / `store.ts` | Channels (see below) |
| `config.ts`, `errors.ts`, PWA manifest, Stop button, prompt preview, the per-profile "Test tools" button and tool log | Plumbing that already works |
| The one "takes a turn" function | **Core rule, same as Aettica:** a Kitsikai turn never requires a user message. Your message, a timer, or an event can all call it. |

Every new screen (calendar, weekly list, review list, trackers, advanced page) uses named CSS variables and descriptive class names (`.calendar-day`, `.shift-card`, `.log-sticker`) so themes can restyle it.

### The binder: three kinds of data

Kitsikai's knowledge about your life lives in three kinds of records. **Plans are what you plan, trackers are what to watch for, log entries are what actually happened.**

## Channels

Channels split up the conversation, but not her. She is one person.

- **Per channel:** chat history, optional channel theme, optional **topic** (a short description like Discord's, e.g. "work stuff, venting about shifts").
- **Shared across all channels:** her scratchpad, her pins, and the whole binder. A headache mentioned in `#general` is known in `#gaming`.
- **Channel types**, like Discord's: normal text channels, plus a 📅 **planner** channel (calendar + weekly list) and a **trackers** channel. Opening these shows their screen instead of a chat.
- One text channel is the **home channel** (fallback for proactive messages). Default: the first one.
- Create, rename, reorder and delete channels from the sidebar, like Aettica.

## The chat

Bring over the multi-bubble texting style from the owner's Lumiverse extension and Tiny RP.

- **Her replies are split into bubbles** on a `<cht>` marker the model is asked to write between bubbles. A reply with no markers is one bubble; an empty piece (a marker at the very start) is ignored.
- **Her bubbles stagger in** one at a time with a typing indicator between them. Delay scales with length (`base + characters × perChar`), no cap. **Double-tap the typing indicator to skip** the wait. History and your own messages render instantly.
- **You text like texting:** each send is its own bubble. Kitsikai waits a few seconds after your last bubble before replying (a debounce), so she doesn't answer halfway through your thought. Bubbles sent together form one turn.
- **In the prompt, turns show `<cht>` between bubbles** (yours and hers), so she keeps mirroring the format.
- Edit, delete, regenerate, and Stop work like Aettica. Regenerate replaces her whole last turn.

### What's in her head while you talk

- **Always in view** (every message): who she is, today's and tomorrow's plans, due reminders, her pins, her current scratchpad notes, and the current channel's recent messages.
- **Looked up with tools** (when needed): anything further out in the binder, older log entries, other channels' recent messages.

Her persona prompt is editable in the app, with a starting version in `defaults/`.

## Plans

A plan is anything planned, on a day, maybe at a time. Shifts and events are the same record with different kinds.

| Field | Notes |
| --- | --- |
| Kind | shift, appointment, birthday, hangout, other |
| Title | "Dentist", "Mia's birthday", "Work" |
| Start | Date, plus time unless all-day |
| End | Optional. **Has its own date**, so overnight shifts (10pm–6am) work |
| Repeats | never, weekly, yearly |
| Remind me | Per-plan override of the kind's default |
| Checked | Whether you've confirmed it |

**All times are the phone's local time.**

### Shifts

Shift plans have a **shift type** and extra fields:

| Shift type | Shift hours | Draw hours | Draw time | Counts as busy |
| --- | --- | --- | --- | --- |
| Regular | Yes | Yes (start and end) | **Calculated, never stored** | Yes |
| Meeting | Yes | No | No | Yes |
| On-call | Yes (the on-call window) | No | No | Only when called in |

- **Draw time is calculated from draw hours** every time it's shown, so it can never disagree with them.
- **Double-booked days** are two shift plans on the same date, shown as two, exactly like the job's scheduling program. When one shift ends as the next begins, they're treated as **one continuous work block** for check-ins and reminder dodging.
- **On-call is free by default.** If you mention getting called in, Jev notices and she treats you as at work until you say you're done **or** the on-call window ends, whichever comes first.

### Reminders

Defaults per kind, changeable per plan:

| Kind | Default reminders |
| --- | --- |
| Appointment | Day before, and ~2 hours before |
| Birthday | A week before, and the morning of |
| Hangout | Morning of |
| Other | Day before |
| Shift | None. She just knows your schedule and uses it naturally |

- **Reminders dodge work.** A reminder that would land during a shift or work block moves to before it.
- **Reminders skip what you just said.** Jev checks whether you already talked about the plan recently; if so, the reminder can be skipped.
- **No quiet hours.** The owner handles that with phone notification rules.
- Reminders are written by her, in her voice, not as robotic notifications.

### How plans get in

1. **Screenshots** (shifts), see below.
2. **Manually**: tap a day, fill in the card.
3. **From chat**: Jev notices you mentioned a future plan; it becomes a scratchpad note; during processing, she asks "want me to put the dentist on thursday at 3?" **Nothing from chat becomes a plan until you say yes.**

### Views

The planner channel has two views of the same data (nothing stored twice):

- **Calendar**: month grid, shifts at a glance, stacked on double-booked days; tap a day for its full cards, other plans and tracker stickers.
- **Weekly list**: Monday to Sunday, every shift with all its fields, day totals on double-booked days, and week totals (shift hours, draw time) at the bottom.

## Screenshot import

1. Upload a screenshot of the work schedule.
2. The **screenshot-reading profile** (a vision model, e.g. Gemini Flash; Jev can't read images) returns structured shifts.
3. **Review list**, with the screenshot beside it:

| Day | Shift type | Shift hours | Draw hours | Draw time |
| --- | --- | --- | --- | --- |
| Mon 9/28 | Regular | 9:00a–5:30p | 10:00a–2:00p | 4h (grayed, calculated) |

4. Every field is tappable to fix. **Warnings (⚠️), never blocks:** a regular shift with no draw hours; draw hours outside the shift hours; anything that looks like a misread. Double-booked days show as two rows.
5. "Looks good, save" commits them as checked plans.

## Trackers and log entries

**A tracker** is "please keep an eye out for this":

| Field | Notes |
| --- | --- |
| Name | "headache", "took meds", "payday" |
| Kind | yes/no, scale 1–10, or note |
| Hint words | Your keywords. Clues for Jev, not rules: Jev still decides whether it actually happened, so "I *don't* have a headache" doesn't log one |
| Can she bring it up? | If off, it's logged quietly and she never raises it unprompted |

**A log entry** is a sticker on a day:

| Field | Notes |
| --- | --- |
| Tracker, day, value | yes, a number, or a note |
| How it got there | you added it, processing committed it, or she asked and you confirmed |
| Source message | Tap to see exactly which message it came from |

You can add, edit and delete log entries yourself in the trackers channel and on calendar days.

## Her memory: scratchpad, processing, pins

Pencil before pen. Anything she'd save goes on the **scratchpad** first.

### The scratchpad

- During chat, Jev checks each of your messages against the trackers ("did this happen? how confident?") and for mentioned plans. Hits become **sticky notes**, as do things she wants to remember ("they seemed stressed about the new manager, check in later").
- Between processing rounds, you correct things just by talking ("wait no, the dentist is *Friday*"), and the note updates.

### Processing

Every few hours (default: every 3 hours), she processes the pile. For each note, Jev asks: is this still true, or did later chat change it?

- **Clearly true** → committed to the binder (a log entry; a plan after your "yes").
- **Clearly wrong or corrected** → tossed.
- **Unsure** → she asks you in her next message.

**Time-sensitive notes are processed early**: a note about something happening before the next round ("dentist in an hour") doesn't wait.

Notes meant for her ("check in about the manager thing") become things she might bring up, feeding the proactivity check.

### Pins

During processing she can **pin** things that matter right now. Pins are always in view.

- A pin holds: what it is (in her words), why she pinned it, and **when to unpin**: a date ("after Friday") or a condition ("once they say the manager thing settled").
- Each round, Jev checks each pin. Clear yes to unpin → it comes down. Unsure → it stays (too long is harmless; too early means forgetting).
- Unpinning isn't forgetting: the pin moves back "into the drawer" where tools can find it.
- **Pin cap** (default 10). When full, she decides what to take down to make room.
- **You can ask** "what do you have pinned?", "pin that", "you can let that go". Your requests become notes marked as yours and are honored at processing; if pins are full, she chooses what to drop or asks you.

### Transparency

She can mention her notes, pins and processing when it feels natural ("noted 📌", "took the exam off my board, so glad it went well"), not every time. She knows the owner has some control over how she works.

### The advanced page

Settings → **Advanced** (off by default) shows "Kitsikai's notes": her current notes, her pins with reasons, a **processing log** (what was kept, tossed, asked about, and why, linked to source messages), and a **"process now"** button for testing.

**Look, don't touch.** Everything changes through her, by talking. One way for notes to change means one way for them to go wrong. Opening the page changes nothing about her behavior.

## Proactivity

She texts first when it makes sense, and usually doesn't.

### The snapshot check

Every few minutes (default: every 10), the server takes a snapshot: current time, today's and tomorrow's plans, due reminders, busy status (shift, work block, called-in), when you last talked and who sent the last message, **how many messages she's sent in a row without a reply**, how long since her last one, recent log entries, and her pins and notes.

Jev answers, each with a confidence score:

- Is a reminder due?
- Did a shift or work block just end? (good time for "how'd it go?")
- Is there something worth following up on? (only trackers she may bring up, and her own notes)
- Has it been quiet long enough for a "just because" message?
- If she's already waiting on a reply: would another message feel natural, or pushy?

Any confident yes → her turn runs. All no → nothing happens (most of the time).

### Picking the channel

1. Jev picks the best-fitting channel for the reason, using names and topics, with a confidence score. Unsure → home channel.
2. **Interruption check:** Jev looks at that channel's recent history: would a message now interrupt a conversation in progress? If yes, try the next-best channel.
3. If every candidate fails: a **reminder** goes into the conversation you're already having (she mentions it naturally, "oh btw, dentist in 2 hours"); anything else waits for the next check.
4. The chat model writes her message with that channel's recent history in view.

### Double-text cap

Settings: **Let her judge** (Jev decides every time) or a cap of **1, 2 or 3** unanswered messages in a row. **The cap is a hard wall**: once reached, Jev isn't even asked. **Reminders ignore the cap.**

### Notifications

Version one uses **Termux**, the simplest route that works with the app closed:

- `termux-wake-lock` keeps the server alive; the owner exempts Termux from battery optimization.
- **Termux:API**'s `termux-notification` posts her messages as notifications titled "Kitsikai in #channel", and tapping one opens the app at that channel (`termux-open-url`).
- Web Push from the PWA is a later upgrade (see Endgame).

## Models and jobs

All through nanoGPT, using Aettica's connection profiles and roulettes. Each job has its own assignment.

| Job | Assigned to | Notes |
| --- | --- | --- |
| Chat (her messages, reminders, check-ins) | Profile or roulette | Tools needed for lookups |
| Screenshot reading | A vision-capable profile | Returns structured shifts |
| Processing writer (writing notes, pins, plan cards from chat) | A cheap, steady profile | Structured output |
| Decisions | **Jev**, pinned to `typesafe/jev-1.13` | Not `jev-latest`: upgrade on purpose |

**Jev** ([TypeSafe](https://typesafe.ai/blog/introducing-system-one-models-and-jev), on nanoGPT) returns typed answers with calibrated probabilities, never text. Call it through Chat Completions with a "questions" response format. It can't write words (so plan titles and pin text come from the processing writer) and can't read images. "Can't hallucinate" means never malformed, **not** never wrong, which is why corrections through her matter. Use its confidence for three tiers everywhere: confident yes, confident no, unsure → safe fallback.

## Build stages

Each stage adds one new concept, so there's only ever one new thing to learn.

**Progress:** all 8 stages are built. See [docs/stage-1.md](docs/stage-1.md), [docs/stage-2.md](docs/stage-2.md), [docs/stage-3.md](docs/stage-3.md), [docs/stage-4.md](docs/stage-4.md), [docs/stage-5.md](docs/stage-5.md), [docs/stage-6.md](docs/stage-6.md), [docs/stage-7.md](docs/stage-7.md) and [docs/stage-8.md](docs/stage-8.md), and [docs/install.md](docs/install.md) for putting it on the phone. The open questions below need a live test with a real key (see the README's live test notes).

| Stage | Adds | New concept learned |
| --- | --- | --- |
| 1 | Fresh repo with Aettica furniture: server, nanoGPT, profiles, themes and glass, PWA; one chat with Kitsikai | Reusing code across projects |
| 2 | Channels, topics, home channel; bubbles, typing delays, double-tap skip, reply debounce | Timing and async rendering |
| 3 | Planner channel: plans, shifts with types and draw fields, repeats, reminder defaults (stored, not sent), calendar and weekly views | Dates, times, overnight ranges, recurrence |
| 4 | Screenshot import: vision profile, review list, warnings | Image input, structured output, validation |
| 5 | Trackers channel and log entries (manual) | User-defined data |
| 6 | Tools: binder lookups, today/tomorrow always in view | Tool calling (reusing `toolcalls.ts`) |
| 7 | Jev, the scratchpad, processing, pins, the advanced page | Decision models, confidence thresholds, batch jobs |
| 8 | Proactivity: snapshot check, reminders sent, channel picking and interruption check, double-text cap, on-call, Termux notifications | Background timers, notifications |

## Endgame features

Parked until the core works.

- **Web Push** notifications from the PWA instead of Termux.
- **Generate-and-grade** "just because" messages: she drafts an idea and only sends it if she still likes it on review (shared idea with Aettica's endgame).
- Share back to Aettica: the heartbeat, notifications and multi-bubble OOC built here are on Aettica's endgame list.
- Tracker charts over time.

## Open questions

- [x] Is Jev reachable? nanoGPT's model page showed "Unavailable" on Sep 26, 2026. Test a call before stage 7. (Yes: the first live Test Jev reached it. Its error showed the questions must be a map keyed by id, each `{type: "choice", instructions, criteria}`; `jevRequestBody` now sends that. See docs/stage-7.md.)
- [ ] Which vision model reads the schedule screenshots most reliably?
- [ ] Which models reliably write the `<cht>` bubble format and handle tool calls? ("Test tools" and the tool log will answer the second.)
- [ ] Good defaults for the snapshot interval (10 min?), processing interval (3 hours?), pin cap (10?), reply debounce (a few seconds?), and typing-delay numbers. (All are settings now, with those defaults; living with them will tell.)
- [x] How far back does the interruption check look, and what counts as "a conversation in progress"? Stage 8: the last 30 minutes, and Jev judges whether a text would interrupt; a channel with nothing in that time can't be interrupted. Unsure counts as interrupting. Easy to change (`INTERRUPT_MINUTES`) if it feels off in use.
- [x] Should week totals count on-call hours? Stage 3 shows them separately, marked "not counted", so both numbers are there.
