# Kitsikai

Kitsikai is an AI friend you text with. She lives in a small Discord-style app you share, and she's meant to be **proactive**: she knows your work schedule and plans, keeps an eye on things you've asked her to track, and texts you first when it makes sense. The full vision is in [DESIGN.md](DESIGN.md).

**Status: all 8 stages are built**, and ready for a live test on the phone (see [Live test notes](#live-test-notes)). Channels where you text her, in bubbles, a 📅 planner for your shifts and plans, a memory that notices what you tell her, and texting first, using models from [nanoGPT](https://nano-gpt.com), with the look and plumbing of [Aettica](https://github.com/626andup-cmyk/aettica). How it works inside: [stage 1](docs/stage-1.md) (reusing code across projects), [stage 2](docs/stage-2.md) (timing: bubbles, typing delays, waiting before replying) [stage 3](docs/stage-3.md) (dates, times, overnight shifts and repeats) [stage 4](docs/stage-4.md) (reading your schedule from a screenshot) [stage 5](docs/stage-5.md) (trackers: data you define yourself), [stage 6](docs/stage-6.md) (tools: she looks things up), [stage 7](docs/stage-7.md) (her memory: decision models, confidence and batch jobs) and [stage 8](docs/stage-8.md) (texting first: background timers and notifications). Also: [importing a chat](docs/importing.md), [intimacy](docs/intimacy.md) (registers, and the safeword) and [images in chat](docs/images.md).

## What it can do

- **Text her like texting**: each send is its own bubble (Enter sends; Shift+Enter makes a new line). She waits a few seconds after your last bubble before replying, so she doesn't answer halfway through your thought.
- **She texts in bubbles** that appear one at a time with a typing indicator. **Double-tap the typing indicator** to skip ahead.
- **The 📅 planner channel**: your plans as a month calendar and a weekly list.
  - **Plans**: shifts, appointments, birthdays, hangouts and anything else, on a day, maybe at a time, maybe repeating weekly or yearly. Overnight shifts (10pm–6am) just work.
  - **Shifts** are regular (with draw hours), meetings, or on-call. Draw time is always calculated from the draw hours. **Linked shifts**: tick "🏨 Overnight after this shift" for a hotel night between shifts, and she knows you're away. The weekly list shows every shift with all its fields, day totals on double-booked days, and week totals.
  - **Import a screenshot** of your work schedule: a vision model reads the shifts, you check them in a review list beside the screenshot (⚠️ warnings point out likely misreads, but never stop you), and they're saved as confirmed shifts.
  - **Reminders**: each kind has defaults (a birthday: a week before and the morning of), changeable per plan. A reminder that would land during work moves to before it. (She'll send them from stage 8.)
- **The 📈 trackers channel**: things for her to keep an eye out for (a headache, your meds, payday), each recording yes/no, a 1–10 scale, or a note, with your own hint words and whether she may bring it up. Log a **sticker** for a day in one tap; see the last two weeks at a glance; stickers also show on calendar days. **She can too**: tell her to keep track of something and she makes the tracker; tell her how it went and she puts the sticker on the day, or fixes it (if her profile can use tools).
- **Channels**: create, rename, reorder and delete them. Each can have a **topic** (she sees it), and one is the **home channel**. She's one person across all of them.
- **She knows your day**: today's and tomorrow's plans, and whether you're at work, are always in front of her. Anything further (next week's shifts, the headache log, another channel) she **looks up with tools** when it comes up, if her profile can use tools. What she looked up shows under her reply ("⚙ Kitsikai looked up plans for Oct 5–11"), and each channel has a **tool log**.
- **Her memory**: a fast decision model, **Jev**, reads each of your messages against your trackers and for plans, things worth remembering, and requests ("pin that"). What it notices goes on her **scratchpad** in pencil; every few hours she **processes** it: what's clearly true goes into the log, what's wrong is tossed, and she asks about anything she's unsure of. A plan from chat only goes into the planner once you say yes. Correct her just by talking ("wait no, it's Friday").
- **Pins**: what matters right now, always in her view, each with why and when to take it down, up to a cap. Unpinned things go into a drawer she can still look in. She can mention her notes when it feels natural ("noted 📌").
- **The advanced page** (Settings → Advanced): her notes, pins, drawer and a processing log of what she kept, tossed and asked about, and why, plus what her texting-first checks decided. **Process now** and **Check now** buttons for testing. Look, don't touch: everything changes through her.
- **She texts first**, when it makes sense, and usually doesn't: **reminders** for your plans in her own words (skipped if you just talked about it), "how'd it go?" when your **shift ends**, **following up** on something, or **just because** after a quiet stretch. She picks the channel that fits, and doesn't interrupt a conversation in progress. A **double-text cap** (or "let her judge") keeps her from overdoing it.
- **On call**: tell her you got called in, and she treats you as at work until you say you're done or the window ends.
- **Notifications** (Termux): her messages show up on your phone while the app isn't open; tap one to open that channel. Turn off **Show what she said** for a lock screen others can see.
- **Intimacy registers**: before each of her turns, Jev reads the mood and picks which mode from the persona's [INTIMACY] section she's in. **The safeword** ("seriously") stops everything at once, no model needed: she holds, plain and warm, and texts first only for reminders, until you bring her back by telling her or with **Bring her back**. See [docs/intimacy.md](docs/intimacy.md).
- **Bring over a chat** from Lumiverse or SillyTavern (Settings → Chat history): it goes into its own channel with the original dates, she can **search** everything you've said (not just the recent messages in view), and, if you like, she **catches up** on it, noting what's still worth knowing. The preview never shows message text. See [docs/importing.md](docs/importing.md).
- **Send her pictures** (🖼️ next to the text box, or paste one): a vision model of your choice describes each, and that description is what she (and every model) gets instead, so text-only models can follow along. You see the picture; under it, **what she sees**, which you can edit, or have read again. See [docs/images.md](docs/images.md).
- **Her turn**: let her text without a new message from you.
- **Stop** a reply that's taking too long. Nothing is saved.
- **Regenerate** her last reply (or **Regenerate with…** a particular profile), **edit** or **delete** any message.
- **Settings**: her name, your name, her persona (who she is), which profile reads screenshots, which reads the images you send, and which writes her notes, Jev's model (with **Test Jev**, and a **Jev log** of every call from the last 36 hours, exactly as sent and received) and a fallback profile, how sure Jev has to be, how often she processes, how many pins she keeps, texting first (on or off, how often she checks, the double-text cap), notifications (and whether they show what she said), intimacy registers (on or off), how many recent messages she sees, how long she waits before replying, and how fast she "types".
- **Connection profiles and roulettes** (Settings → Profiles and roulettes): a profile is a model with its settings and its own "model notes"; a roulette picks one of several profiles at random each turn, by weight. Each profile has a **Test tools** button.
- **Preview prompt** (channel settings): see exactly what the model receives on her next turn.
- **Themes** (the palette button): Classic, Frutiger Aero, Aero Glass, Liquid Glass, Liquid Glass Dark and Rainy Window, with sliders, real refracting glass in Chrome, Full/Lite/Automatic glass effects, per-channel themes, and a theme editor. See the [theme reference](docs/theme-reference.md).
- Install it to your home screen as an app (PWA).

## Running it

You need [Bun](https://bun.sh) and a nanoGPT API key.

```sh
# 1. Get the code and install the development tools (only needed for tests and type checking)
git clone https://github.com/626andup-cmyk/kitsikai..git kitsikai
cd kitsikai
bun install

# 2. Add your API key
cp .env.example .env
#    then edit .env and set NANOGPT_API_KEY=...

# 3. Start the server
bun start
```

Then open <http://127.0.0.1:3000> in your browser.

### On your phone (Termux)

The server is designed to run in [Termux](https://termux.dev) on the phone you text from, like Aettica. **[docs/install.md](docs/install.md) walks through it step by step**, for someone who's never done it before: Termux and Termux:API from F-Droid, battery settings, Bun inside `proot-distro`, your API key, starting it, and adding the app to your home screen.

The app only works while the server is running. If it says it can't connect, start the server in Termux again.

### Settings in `.env`

| Variable | Default | What it does |
| --- | --- | --- |
| `NANOGPT_API_KEY` | none (required) | Your nanoGPT API key |
| `HOST` | `127.0.0.1` | Where the server listens. The default means only this device can connect. |
| `PORT` | `3000` | Port for the web app |
| `DATA_DIR` | `./data` | Where your data is saved |
| `NANOGPT_BASE_URL` | `https://nano-gpt.com/api/v1` | API address (only change this for testing) |
| `REQUEST_TIMEOUT_SECONDS` | `180` | How long to wait for a reply before giving up |
| `TZ` | the system's | Your time zone, like `America/Chicago`. Only needed if the server's doesn't match your phone's: the app warns you if so. |

Everything else is changed in the app.

## Your data

Everything is saved in the `data/` folder: your chats and settings in an SQLite database, `data/kitsikai.db`, your own themes in `data/themes/`, and the images you've sent in `data/images/`. To back up, stop the server and copy the whole `data/` folder. (While the server is running, the database's recent changes are also in `kitsikai.db-wal` and `kitsikai.db-shm`, so copy those too.) The `data/` folder and `.env` are never committed to git.

Kitsikai has no login. Keep `HOST` at `127.0.0.1` so that nobody else on your Wi-Fi can open your chats.

## Development

```sh
bun run dev        # start the server, restarting whenever a file changes
bun test           # run the tests (they use a fake nanoGPT, so no key or credit is needed)
bun run typecheck  # check the TypeScript types
```

The browser tests in `test/ui.test.ts` need a Chromium browser. They find one through `CHROME_PATH` or Playwright's `PLAYWRIGHT_BROWSERS_PATH`, and are skipped when there isn't one.

Project layout:

```
src/
  server.ts    HTTP server: API routes and serving the web app
  kitsikai.ts  The one "Kitsikai takes a turn" function, and the tool test
  replies.ts   Waiting a few seconds after your last bubble before she replies
  events.ts    The events stream: telling the app what happened, as it happens
  bubbles.ts   Splitting her replies into bubbles on <cht>
  tools.ts     Her tools: looking things up in the binder, keeping your trackers, and jotting notes
  jev.ts       Jev, the decision model: questions, answers, confidence tiers, the fallback
  jevlog.ts    The Jev log: every call from the last 36 hours, exactly as sent and received
  scratchpad.ts  Jev's check of your messages during chat: new notes, corrections, your yes
  processing.ts  Processing her notes every few hours: pencil to pen, and her pins
  scheduler.ts What runs on a timer: processing her notes, and her snapshot check
  proactive.ts Texting first: the snapshot check, picking a channel, the double-text cap
  reminders.ts Due reminders and what happened to each, on-call status, the texting-first log
  notify.ts    Phone notifications through Termux, and whether the app is on screen
  images.ts    Images you send: the files, the vision model reading them, her reply waiting for it
  intimacy.ts  Which register she's in each turn, the safeword, and bringing her back
  hold.ts      The safeword hold, saved so it lasts
  importer.ts  Reading a Lumiverse/SillyTavern chat export, and importing it into a channel
  catchup.ts   Her reading an imported chat back, and noting what's still worth knowing
  writer.ts    The processing writer: words for her notes, pins and plan cards
  memory.ts    Her notes, pins and processing log in the database, and in her prompt
  binder.ts    Plans, work and stickers, in words (for the prompt and the tools)
  activity.ts  The tool log
  planner.ts   Plans: repeats, shift hours, draw time, work blocks, reminders, week totals
  dates.ts     Local dates and times, overnight ranges
  screenshot.ts  Reading shifts from a schedule screenshot, and checking them
  json.ts      Getting JSON out of a model's reply, forgivingly
  trackers.ts  Trackers and log entries (stickers on days)
  prompt.ts    Builds the prompt stack sent to the model
  toolcalls.ts Reading tool calls, including broken or written-as-text ones (from Aettica)
  profiles.ts  Connection profiles and roulettes (from Aettica)
  themes.ts    Themes: storing, editing, serving and scoping them (from Aettica)
  nanogpt.ts   Talks to nanoGPT's API (from Aettica)
  db.ts        The database's tables, and upgrading them (migrations)
  store.ts     Reading and writing channels, messages and settings
  errors.ts    Errors the server turns into 404 and 400 answers
  config.ts    Reads settings from .env
  types.ts     The shapes of channels, messages and settings
public/        The web app (plain HTML, CSS and JavaScript, no build step)
themes/        Built-in themes
defaults/      Her starting persona
test/          Tests
docs/          How things work, stage by stage, and the theme reference
```

## Live test notes

Everything is tested against a fake nanoGPT (`bun test`), but a few things can only be answered on your phone, with your real key. They're DESIGN.md's open questions. Here's what to try, and what to tell Claude (or check yourself) afterwards:

1. **Is Jev reachable, and does Kitsikai understand it?** Settings → **Test Jev**. "It's working" means yes. Anything else: copy the message and the **raw reply** shown under it. Later, if a decision looks wrong (a note that wasn't made, the wrong register), **Jev log** (next to Test Jev) shows exactly what Jev was asked and what it said; **Copy as text** to share it. The request format lives in `jevRequestBody` and the reading in `readAnswers` (`src/jev.ts`), so a mismatch is a small fix. Until then, set **If Jev can't answer, ask** to a profile, so her memory and texting first keep working.
2. **Bubbles:** chat for a bit. Does she split her replies into several bubbles (the model writing `<cht>` between them)? If one model never does, note which: its profile's **model notes** can remind it.
3. **Tools:** for each profile, **Test tools**. Then ask about next week ("what am I working next week?") and see whether "⚙ Kitsikai looked up plans…" appears under her reply. Channel settings → **Tool log** shows anything that went wrong.
4. **Screenshots:** in the 📅 planner, import a screenshot of your schedule, with a vision profile set in Settings. How many rows needed fixing? Which model read it best?
5. **Her memory:** make a tracker (say "headache", 1–10), then mention a headache in chat. Settings → Advanced → **Kitsikai's notes**: is it on her scratchpad? Press **Process now**: does it land in the log? Mention a plan ("dentist thursday at 3"): after processing, does she ask whether to add it, and does your "yes" put it in the planner?
6. **Texting first:** make an appointment for an hour from now. On the advanced page, press **Check now**: she should text you a reminder. Then lock your phone and wait for a regular check (every 10 minutes by default) on something else, like a shift ending.
7. **Notifications:** send her a message, then right away switch to another app (or lock the phone) before she answers. When her reply comes, a notification titled "Kitsikai in #general" should appear. Tap it: the app should open at that channel. If Settings says notifications aren't available, see the troubleshooting table in [docs/install.md](docs/install.md).
8. **Intimacy:** if your saved persona is older than this update, paste in the new `defaults/persona.md` (Settings → persona; saving Settings keeps the persona you had). Send "seriously" in a chat: the "Safeword heard" banner should appear, and she should answer plainly. Tell her you're okay and want her back, or tap **Bring her back**: the banner goes. The server log shows which register she was in each turn (`[kitsikai] intimacy register: ...`). If a pick feels wrong, raise **How sure Jev has to be**, or turn **Intimacy registers** off.
9. **Images:** set Settings → **Images you send are read by** to a vision profile (or leave it on "Same as screenshots"), then send her a photo. Does "What Kitsikai sees" describe it well? Tap the bubble → **Edit what she sees** to fix it. If it says it couldn't read the image, the profile probably isn't a vision model.
10. **Timings:** do the defaults feel right? Waiting before replying (4 s), typing speed, processing every 3 hours, checking every 10 minutes, 10 pins. All are in Settings.

## Licence

[GNU AGPL v3](LICENSE). Parts are copied from [Aettica](https://github.com/626andup-cmyk/aettica), under the same licence.
