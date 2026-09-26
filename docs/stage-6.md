# Stage 6: how it works

Stage 6 lets her **look things up**. Today's and tomorrow's plans are always in front of her; anything further (next week's shifts, last month's headaches, what you said in another channel) she looks up with a **tool** when it comes up. According to [DESIGN.md](../DESIGN.md), the new concept is **tool calling**, reusing Aettica's `toolcalls.ts` and tool loop.

## What's in her head

DESIGN.md splits what she knows into two parts:

| Always in view (every message) | Looked up with tools (when needed) |
| --- | --- |
| Who she is, the time, the channels | Plans further out |
| **Today's and tomorrow's plans**, and whether you're at work | The trackers, and older log entries |
| The current channel's recent messages | Other channels' recent messages |
| (Stage 7 adds her pins and notes; stage 8 due reminders) | (Stage 7 adds the drawer of old pins) |

Why not put everything in the prompt? A prompt costs money and attention for every word, on every message. Most texts are about today, so today and tomorrow are always there, and the rest waits until it's relevant.

## Today and tomorrow

`todayAndTomorrow` in `src/binder.ts` writes both days' plans the way she reads them best: in short lines, from the planner's own calculations.

```
## Today and tomorrow

From the planner you share with them (their shifts and plans; "not confirmed yet" means they haven't checked it):

Today, Mon, Sep 28:
- Work (shift) 9:00a–5:30p, 8h 30m, draw 10:00a–2:00p (4h)
Tomorrow, Tue, Sep 29:
- Hangout: Movies, 7:00p (not confirmed yet)
They're at work right now, until 5:30 PM.
```

An overnight shift that started yesterday still shows today ("started Sun, Sep 27"). The last line says whether you're **at work** right now (inside a work block, from stage 3), or **on call** ("free unless they get called in"). Stage 8 will know when you've been called in.

The same wording (`describeOccurrence`) is used by her lookup tools, so a plan reads the same whether it's in view or looked up.

## Concept: tool calling

A model can only write text. **Tool calling** lets it ask for something to be done instead: the app describes some tools (a name, what it does, what arguments it takes), and the model can reply with a request like "call `look_up_plans` with `from: 2026-10-05, to: 2026-10-11`" instead of, or as well as, text. The app runs the tool and sends the result back, and the model carries on with the answer in front of it.

This is the same mechanism Aettica uses for its partner's actions, and the code came over almost unchanged:

- **The tool loop** (`toolLoop` in `src/kitsikai.ts`, from Aettica's `partner.ts`): ask the model; if it called tools, run each one, log it, send the results back; repeat until it writes without calling anything, up to 6 rounds. The last round offers no tools, so it has to write.
- **Messy tool calls are handled, not failed** (`src/toolcalls.ts`, unchanged from stage 1): broken JSON arguments are repaired or explained back to the model so it can try again, and tool calls written into the text in Qwen/GLM, Kimi or DeepSeek formats are found, run, and taken out of her reply.
- **Tools are only offered on profiles marked "Can use tools"**, with short guidance in the prompt: use them only when they help, look things up instead of guessing, and never mention tools or looking things up ("just know it, like a friend who remembers").

## Her tools

`src/tools.ts`, in the same shape as Aettica's: each tool has a name, a description the model reads, a JSON schema for its arguments, and a `run` function that returns a **result** for the model (as JSON) and a **summary** for people.

| Tool | What it does | Summary shown |
| --- | --- | --- |
| `look_up_plans` | Plans between two dates (at most 3 months), optionally one kind | "looked up plans for Oct 5–11" |
| `find_plans` | Search plans by title or notes, and when each happens next (or last) | "searched plans for "dentist"" |
| `list_trackers` | The trackers: what each records, hint words, whether she may bring it up | "looked at the trackers" |
| `look_up_log` | Log entries (stickers), optionally one tracker and a date range, with how each got there | "checked the headache log" |
| `read_channel` | Another text channel's latest messages (up to 40) | "read #gaming" |
| `do_nothing` | Choose not to reply | "chose not to reply" |

Dates can be written as `2026-10-05` or as "today", "tomorrow", "yesterday". Mistakes come back as results the model can read ("There's no tracker called "gym". Trackers: headache, meds."), so it can correct itself in the next round rather than the turn failing.

These tools only **read**. Changing the binder through her comes in stage 7, and on purpose goes through her scratchpad first, never straight into your plans.

## Seeing what she did

Every tool call is saved in the **tool log** (`tool_calls` table, migration 5; `src/activity.ts`, from Aettica), with the arguments exactly as the model wrote them (even if broken), what was sent back, whether it worked, and whether the model used the API or wrote the call as text.

- **Under her reply**, a line says what the turn looked up: "⚙ Kitsikai looked up plans for Oct 5–11". Tap it to see each call in full. It appears after the reply's last bubble, once they've all appeared. A turn that only acted (like `do_nothing`) shows its line on its own.
- **Channel settings → Tool log** lists every call in the channel, newest first, with "Errors only" and "Copy as text", for troubleshooting a model that gets tools wrong.
- **Test tools** (in each profile, since stage 1) checks whether a model can call tools at all.

Her messages and her tool calls from the same turn share a turn id, which is how the app knows which line goes under which reply. The events stream now carries a turn's tool calls along with its messages.

## Tests

`test/tools.test.ts`:

- each tool, with fixed dates and made-up plans, trackers and messages, including the mistakes each one explains
- today and tomorrow: both days' plans, being at work, an overnight shift from yesterday, on-call (and called in)
- the prompt: today and tomorrow always there; the tools and their guidance only for tool-capable profiles
- the tool loop end to end against the fake nanoGPT: a lookup then a reply (the result really goes back to the model, and the calls share the reply's turn id), a call written as text, broken arguments, `do_nothing`, running out of rounds, and regenerating a reply that used tools

`test/ui.test.ts` checks the activity line appears after both bubbles, opens into details, and fills the tool log.

Which models reliably call tools is one of DESIGN.md's open questions: **Test tools** and the tool log answer it per model, and it needs a real key (see the live test notes in the README).
