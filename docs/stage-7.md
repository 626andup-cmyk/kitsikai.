# Stage 7: how it works

Stage 7 gives her a **memory**: she notices things in chat, writes them on a scratchpad in pencil, and every few hours decides what to keep. According to [DESIGN.md](../DESIGN.md), there are three new concepts: **decision models**, **confidence thresholds** and **batch jobs**.

## The idea: pencil before pen

When you text "ugh my head is killing me, like a 7", she could log a headache straight away. But people correct themselves ("wait, that was yesterday"), joke, and change plans. If every message went straight into the binder, misunderstandings would become "facts".

So anything she'd save goes on her **scratchpad** first, as a sticky note, in pencil. Every few hours she **processes** the pile: what's clearly still true is committed (in pen), what's wrong is tossed, and what she's unsure of, she asks you about. In between, you correct things just by talking.

```
you text ──► Jev checks it ──► sticky note (pencil) ──► processing, every few hours
                                  ▲    │                   ├─ clearly true  → saved in the binder
             "wait, it's Friday" ─┘    │                   ├─ clearly wrong → tossed
                                       │                   └─ unsure        → she asks you
                                       └─ you say "yes" to her question → saved right away
```

## Concept: decision models

Most of this is small decisions: did that message say you had a headache? Is this note still true? Should this pin come down? A chat model *could* answer, but it's slow, costs more, and answers in words that then have to be read (and can be vague: "probably?").

**Jev** ([TypeSafe](https://typesafe.ai/blog/introducing-system-one-models-and-jev), on nanoGPT) is a **decision model**. You give it some **state** (what's going on, as text) and some **questions**, each with fixed options, and it returns, for every question, the option it picks and a **probability** for each option. It never writes words and can't read images.

```
state:     "... them (NEW): ugh my head is killing me, like a 7"
question:  Do their NEW messages say that "headache" happened?    options: yes, no
answer:    yes    (yes 0.94, no 0.06)
```

It's called through the same Chat Completions API as her chat model, with a "questions" response format, pinned to `typesafe/jev-1.13` (not `jev-latest`, so it only changes when you change it). The code is `src/jev.ts`.

"Can't hallucinate" means its answers are never malformed (always one of the options), **not** that they're never wrong. That's why everything goes through pencil first, and why you can always correct her by talking.

Since Jev can't write, anything that needs words (a note like "they seemed stressed about the new manager", a pin's reason, the plan card for "dentist thursday at 3") is written by the **processing writer** (`src/writer.ts`): a normal chat model, its own job in Settings, best given a cheap, steady one. It only wakes up when Jev has found something worth writing, and it's asked for JSON, read forgivingly like the screenshot reader in stage 4.

## Concept: confidence thresholds

A probability isn't a decision yet. Every answer is read in **three tiers** (`tier` in `src/jev.ts`), with one setting, **Sure enough at** (default 0.8):

| Jev says yes with probability | Tier |
| --- | --- |
| 0.8 or more | **confident yes** |
| 0.2 or less | **confident no** |
| anything in between | **unsure** |

The important part is what *unsure* does: it always takes the **safe path**, and what's safe depends on the question.

| Question | Unsure means |
| --- | --- |
| Did this happen? (during chat) | No note. Processing looks at everything again anyway. |
| Is this note still true? (processing) | She asks you. |
| Should this pin come down? | It stays up. Too long is harmless; too early is forgetting. |
| Which pin should make room? | The new one isn't pinned (it's still something she might bring up). |
| Did they answer yes? | Nothing changes: she's still waiting for your answer. |

Raising the setting to 0.9 makes her more careful (more "unsure", more questions); lowering it makes her decide more on her own.

A small computer detail: `1 − 0.8` is stored as `0.19999999999999996`, so a probability of exactly 0.2 would miss the "no" line. `tier` allows a hair of tolerance for that.

## The request, and the unknowns

When this stage was built, TypeSafe's documentation couldn't be reached, and nanoGPT once listed Jev as "Unavailable" (DESIGN.md's open question). So the Jev client is built to be easy to fix and hard to break:

- **The exact request is in one function**, `jevRequestBody`, and the reply is read forgivingly by `readAnswers` (a list or an object by question id, the pick as `selected`/`answer`/`choice`, probabilities as an object or a list, and more). If a live test shows the format differs, only those two change.
- **Settings → Test Jev** asks one tiny question with an obvious answer ("they just got a puppy: did they get a pet?") and shows what happened, with the **raw reply**, so a format mismatch is easy to see.
- **A fallback profile** (Settings → "If Jev can't answer, ask"): a normal profile that's asked the same questions and told to answer in JSON with a probability. Slower and less calibrated, but her memory keeps working.
- **Empty model** turns Jev off: the fallback answers everything, or, with no fallback, nothing is noticed or processed (she still chats normally).

A failed Jev call never stops her from replying: that decision is just skipped this time, and the advanced page says why.

**What the first live test found.** Jev was reachable, and nanoGPT's error said exactly what was wrong: "Jev decision models require a non-empty questions map". The questions had been sent as a list; they have to be a **map**, keyed by the question's id. Each question is a `choice`, with `instructions` (the question) and `criteria` (every option, with what it means), and a yes/no question is a choice between "yes" and "no":

```json
"response_format": {
  "type": "questions",
  "questions": {
    "t1": { "type": "choice", "instructions": "Did they have a headache?", "criteria": { "yes": "Yes.", "no": "No." } }
  }
}
```

Answers come back under the same keys, as `{"type": "choice", "choice": "yes", "probabilities": {...}, "confidence": 0.9}`. That was a change to `jevRequestBody` (and question ids like `t1_day` instead of `t1.day`, to keep keys plain): the one-place design paid off.

## During chat: the scratchpad check

`src/scratchpad.ts`. When she's done waiting for you to finish typing (stage 2's debounce), and **before** she replies, Jev reads your new messages and answers all of these at once:

| Question | Options |
| --- | --- |
| For each tracker: did it happen? Which day? How much (scale trackers)? | yes/no; today/yesterday; 1–10 |
| Did they mention a plan? | yes/no |
| Something a friend would remember? | yes/no |
| Did they ask you to pin something, or let something go? | pin / let go / neither |
| Is any of it happening in the next few hours? | yes/no |
| For each note on the scratchpad: did they take it back, or change it? | took it back / changed it / neither |
| For each thing she asked you: did they answer? | yes / no / not answered |

Your tracker **hint words** go into the state as clues, not rules: the question itself says "no headache today" doesn't count.

What happens with the answers:

- **A tracker hit** becomes a note like "headache 7/10 on Sat, Sep 26". If there's already a note for that tracker and day, it's **rewritten** instead ("actually it's more like a 9").
- **A plan** becomes a note with a **plan card** drafted by the writer, checked by the same rules as a plan you make yourself (`validatePlan`). **Nothing from chat becomes a plan until you say yes.**
- **Something to remember**, and **your requests** ("pin that", "you can let that go"), become notes too (requests marked as yours).
- **Taken back** → the note is tossed. **Changed** → the writer rewrites it (and its plan card).
- **Your "yes"** to something she asked commits it **right away**: the plan goes into the planner (confirmed), the sticker into the log (as "she asked and you confirmed"). A "no" tosses it.

Because the check runs before her reply, her reply already sees the new note, or the plan you just said yes to. If you send another bubble during the check, it stops and starts again after the next wait. Each of your messages is checked once: a **mark** remembers how far the check has read in each channel.

She can also jot notes herself during a turn, with the `jot_note` tool (below).

## Concept: batch jobs

**Processing** (`src/processing.ts`) is a **batch job**: instead of deciding each note the moment it's written, notes pile up and are decided together, every few hours (Settings: "Process every", default 3). Batching is what makes pencil-before-pen work:

- you get time to correct things before they're decided
- each note is judged with the chat **since** it was written in view ("is this still true, or did later chat change it?")
- it's one set of questions for the whole pile, not one request per note

For every note, Jev is asked whether it's still true:

| Note | Clearly true | Clearly wrong | Unsure |
| --- | --- | --- | --- |
| Tracker | A sticker in the log ("she noted this from chat") | Tossed | She asks you |
| Plan | She asks "want me to put the dentist on Thursday at 3?" | Tossed | She asks you |
| To remember | Something she might bring up (and pinned, if it matters right now) | Tossed | She asks you |
| Your request | Honored: pinned, or let go | Tossed | She asks you |

A few rules keep it sensible:

- A regular round leaves notes younger than **10 minutes** for next time (a moment for corrections). "Process now" takes everything.
- A plan already in the planner (same title, same day) is just marked done. A plan whose day and time couldn't be worked out is tossed.
- Something she asked that you haven't answered in **3 days** is let go.
- Things she might bring up are checked too: once they've been talked through or settled, they're done.

**Time-sensitive notes are processed early**: a note about something in the next few hours ("dentist in an hour") gets a small round of its own after **5 minutes**, instead of waiting for the next regular one.

## Pins

Pins are what matters **right now**. They're always in her view.

- A pin holds what it is (in her words), **why** she pinned it, and **when to unpin**: a condition ("once they say the manager thing settled") and/or a date. The writer writes these.
- Each round: a pin whose **date** has passed comes down without asking. For the others, Jev is asked whether the condition has happened, and only a **confident yes** takes it down.
- **The cap** (Settings: "Most pins", default 10). When it's full, Jev picks what matters least (maybe the new one). If you asked for the pin and Jev isn't sure, the oldest pin you didn't ask for makes room.
- **Unpinning isn't forgetting**: the pin goes into **the drawer**, and her `look_in_drawer` tool can find it.
- **You can ask**: "what do you have pinned?" (they're in her prompt), "pin that", "you can let that go".

## The scheduler

`src/scheduler.ts`. The real server starts a timer that looks once a minute: is a regular round due, or an early one? (At most one early round every 10 minutes, so a Jev outage can't turn into a request every minute.) Stage 8 adds her proactive check to the same timer.

The timer only runs in the real server. Tests call `tick()` with a fake clock instead, so three hours can pass in a millisecond.

## What she sees

A new section in her prompt, always in view, after today and tomorrow (`memoryForPrompt` in `src/memory.ts`):

```
## Your notes and pins

You keep a scratchpad. Anything you'd want to remember goes on it in pencil first, ...
You can mention your notes, pins and processing when it feels natural ("noted 📌", "took the
exam off my board, so glad it went well"), not every time. They set up how this works and can
look at your notes in the app, but nothing changes except through you, by talking ...

Pinned (1 of 10):
- exam on friday (why: they're nervous; unpin when: after the exam)

On your scratchpad (pencil, not processed yet):
- headache 7/10 on Sat, Sep 26

Things to ask them about, when it fits (casually, one at a time; if you've already asked in
the chat above, wait for their answer instead of asking again):
- whether they want "Dentist on Thu, Oct 1 at 3:00p" put in the planner

Things you might bring up, if it fits:
- they seemed stressed about the new manager, check in later

Since you last processed (2 hours ago):
- saved: took meds on Fri, Sep 25
- took down the pin: mom visiting (its date (2026-09-27) passed)
```

That last part is what lets her say "took the exam off my board" (DESIGN.md's **transparency**): she knows what her last round did, for a day.

## Her new tools

In `src/tools.ts`, alongside stage 6's lookups:

| Tool | What it does | Summary shown |
| --- | --- | --- |
| `jot_note` | A note on her scratchpad: something to remember, or your request to pin or let go. In pencil, like everything else. | "jotted down "they love pho"" |
| `look_in_drawer` | Search pins she's taken down | "looked in the drawer for "exam"" |

Neither changes the binder. Only processing does, and plans only after your yes.

## The advanced page

Settings → **Advanced** → tick **Show advanced** → **Kitsikai's notes…** (`public/memory.js`). It shows:

- her **pins** with their reasons and when they'll come down
- what's **on her scratchpad**, what she'll **ask you about**, and what she **might bring up**, each with "show the message"
- **the drawer**
- the **processing log**: every round that did something, and what happened during chat, with why and how sure Jev was ("Saved headache 7/10 on Sat, Sep 26 (still true, 95% sure: in the log)")
- when the next round is, whether Jev is working, and a **Process now** button for testing

**Look, don't touch.** There's nothing to edit on this page. Everything changes through her, by talking: one way for notes to change means one way for them to go wrong. Opening the page changes nothing about her.

## The data

Migration 6 (`src/db.ts`) adds five tables:

| Table | What it holds |
| --- | --- |
| `notes` | Sticky notes: kind (tracker, plan, remember, request), text, status (open, asking, bringup, done, tossed), and what each kind needs (tracker and value, plan card, request) |
| `pins` | Pins, pinned or in the drawer, with reason and when to unpin |
| `processing_runs` | Each processing round: what started it, when, and whether it stopped early |
| `memory_log` | Every change to a note or pin, with the reason and the source message |
| `scratchpad_marks` | How far the check has read in each channel |

`src/memory.ts` is the only code that reads and writes them.

## Tests

- `test/jev.test.ts`: the request's shape; reading answers in every layout it accepts, and dropping ones that don't fit; the three tiers at the threshold; asking the fake Jev, errors, the fallback profile, Jev turned off; Test Jev.
- `test/memory.test.ts`: the check (tracker hits with hint words, yesterday, scale and note values, each message checked once, rewrites, plans with their cards, time-sensitive notes, the writer failing, taking back and changing notes, your yes and no, Jev unreachable or off, stopping mid-check); processing (every row of the table above, plans that are already planned or undated, pins by date and by Jev, the cap, your pin and unpin requests, settled things, note age, early rounds, unanswered questions, Jev failing, one round at a time); the scheduler; the prompt section; the tools; the API; and the new settings.
- `test/ui.test.ts`: memory settings and Test Jev; the advanced page end to end (a note from chat, Process now, the log's "show the message").

The fake nanoGPT in `test/helpers.ts` now has a fake Jev: tests say what it answers, and anything they don't say gets the question's last option ("no", "neither", "not answered"), 95% sure.

**Is Jev reachable, and is its format what `readAnswers` expects?** That's DESIGN.md's first open question, and only a real key can answer it: see the live test notes in the README.
