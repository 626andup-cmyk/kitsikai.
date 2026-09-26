# Kitsikai

Kitsikai is an AI friend you text with. She lives in a small Discord-style app you share, and she's meant to be **proactive**: she knows your work schedule and plans, keeps an eye on things you've asked her to track, and texts you first when it makes sense. The full vision is in [DESIGN.md](DESIGN.md).

**Status: stage 1 of 8.** One channel where you text her, using models from [nanoGPT](https://nano-gpt.com), with the look and plumbing of [Aettica](https://github.com/626andup-cmyk/aettica). How it works inside: [stage 1](docs/stage-1.md) (reusing code across projects).

## What it can do

- **Text her** in `#general`. Enter sends; Shift+Enter makes a new line.
- **Her turn**: let her text without a new message from you.
- **Stop** a reply that's taking too long. Nothing is saved.
- **Regenerate** her last reply (or **Regenerate with…** a particular profile), **edit** or **delete** any message.
- **Settings**: her name, your name, her persona (who she is), and how many recent messages she sees.
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

The server is designed to run in [Termux](https://termux.dev) on the phone you text from, like Aettica:

1. Install Bun inside Termux. If the installer from bun.sh doesn't work on your phone, run it inside a Linux environment set up with `proot-distro` instead.
2. Follow the steps above, then run `bun start` and leave Termux open.
3. Open <http://127.0.0.1:3000> in Chrome, then choose **menu → Add to Home screen** (or **Install app**). Kitsikai now opens like an app.

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

Everything else is changed in the app.

## Your data

Everything is saved in the `data/` folder: your chats and settings in an SQLite database, `data/kitsikai.db`, and your own themes in `data/themes/`. To back up, stop the server and copy the whole `data/` folder. (While the server is running, the database's recent changes are also in `kitsikai.db-wal` and `kitsikai.db-shm`, so copy those too.) The `data/` folder and `.env` are never committed to git.

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

## Licence

[GNU AGPL v3](LICENSE). Parts are copied from [Aettica](https://github.com/626andup-cmyk/aettica), under the same licence.
