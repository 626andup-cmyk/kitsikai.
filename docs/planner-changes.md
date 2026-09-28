# Planner changes: how it works

She can add, change and remove your plans and shifts, but only with your yes. The code is `src/planchanges.ts`, with her tools in `src/tools.ts`.

## Her tools

| Tool | What it does |
| --- | --- |
| `add_plan` | A new plan or shift: kind, title, day, and optionally times, shift type, draw hours, repeats, notes, and a hotel night after it |
| `change_plan` | Changes a plan: its `plan_id`, and only what changes ("start_time": "10am") |
| `remove_plan` | Removes a plan, by its `plan_id` |

Her lookups (`look_up_plans`, `find_plans`) now give each plan's `plan_id`, so she can point at the one she means. A repeating plan changes, or goes, every time it happens: there's no "just this Monday" yet, and the change says "every week" so that's clear.

Each change is checked like any plan you'd make yourself (a shift needs a start and an end, and so on). Mistakes go back to her to fix, like with every tool. Times can be written "15:00", "3pm" or "9:30a", and days "2026-10-01", "10/1", "today" or "tomorrow". An add that's already in the planner (the same title on the same day) is refused.

## Should she? Jev decides

Before anything changes, **Jev** is asked whether she should (`askedFor`). It reads the last ten messages and the change, and answers: *did they ask for exactly this change, or clearly say yes to it? Not if it's only her idea, or they haven't answered.*

- **A confident yes**: it's done at once. "can you put my dentist in for thursday at 3" needs no second yes. The line under her reply says "added Thu, Oct 1: Appointment: Dentist, 3:00p".
- **Anything else** (her own idea, unsure, Jev off or failing): it **waits**. She's told to ask you, and the line says "offered to add...".

How sure Jev has to be is Settings → How sure Jev has to be (80% by default).

## Your yes

A waiting change shows as a card under her reply, with **Yes** and **No**. You can answer it two ways:

- **Tap** Yes or No.
- **Say so.** Each time you write, the scratchpad check (`src/scratchpad.ts`) asks Jev, for every change waiting in that channel, whether your new messages say yes, no, or don't answer it. A confident yes makes it; a confident no drops it; anything else leaves it waiting.

A change that waits a day without an answer is dropped, as is one whose plan you delete meanwhile. If her reply is stopped, regenerated or ends up saying nothing, the changes it offered go with it: you never saw her ask.

Every change keeps how it ended and why: "they said yes (95% sure)", "you tapped No", "they asked for it (92% sure)". The card shows it.

## What she knows

Her prompt has a **Planner changes you offered** section: the ones waiting for your yes ("ask, if you haven't"), and the ones settled in the last six hours, with how. So she knows the dentist is in, or that you said no, without guessing. Today's and tomorrow's plans in her prompt are always the planner as it is.

## Where things are

| | |
| --- | --- |
| `src/planchanges.ts` | Changes in the database (`PlanChanges`), wording them, making them, asking Jev, and her prompt section |
| `src/tools.ts` | `add_plan`, `change_plan`, `remove_plan`, and plan ids in the lookups |
| `src/scratchpad.ts` | Your yes or no in chat |
| `src/kitsikai.ts` | Changes offered in a reply you never saw are dropped |
| `src/db.ts` | Migration 13: the `plan_changes` table |
| `public/app.js` | The cards, with Yes and No |
| `test/planchanges.test.ts` | Tests |
