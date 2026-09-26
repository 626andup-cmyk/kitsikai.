# Installing Kitsikai on your phone, step by step

This guide assumes you've never done this before. Every step says what to tap or type, and what you should see. It takes about 30 minutes, most of it waiting for downloads.

**What you're setting up:** Kitsikai is two parts. A small **server** (the part that talks to the AI models and saves your chats) runs inside an app called **Termux**, and the **app** you actually use runs in **Chrome**, installed to your home screen. Both are on your phone; nothing else is needed except an internet connection for the AI.

**Typing commands:** in Termux you type a command and press **Enter**. Lines in the grey boxes below are commands: type them exactly (or copy and paste them: long-press in Termux → Paste). Don't type the `#` lines; those are just notes.

---

## Part 1: Get the apps (5 minutes)

1. **Install F-Droid**, an app store for free apps. On your phone, open <https://f-droid.org> in Chrome, tap **Download F-Droid**, open the downloaded file and allow installing. (Android will ask to allow "install unknown apps" for Chrome: say yes.)
2. In F-Droid, search for and install **Termux**.
3. In F-Droid, also install **Termux:API**. (This is what lets Kitsikai post notifications. It has to come from the same store as Termux, so don't get it from the Play Store.)

> **Why not the Play Store?** The Play Store version of Termux is old and broken. Termux and Termux:API must both come from F-Droid.

## Part 2: Stop Android from putting Termux to sleep (2 minutes)

Kitsikai has to keep running when your screen is off, so she can text you first.

1. Open your phone's **Settings → Apps → Termux → Battery**, and choose **Unrestricted** (on some phones: "Don't optimize" or "No restrictions").
2. Do the same for **Termux:API**.

## Part 3: Set up Termux (10 minutes)

1. Open **Termux**. You'll see a black screen with a `$` prompt. The first time, it takes a moment to set itself up.
2. Update it, and install the Termux:API tools and a Linux environment:

   ```sh
   pkg update && pkg upgrade -y
   pkg install -y termux-api proot-distro
   ```

   If it asks a question (like "keep your version or install the new one?"), just press **Enter**.

3. Install **Debian**, a small Linux inside Termux. Kitsikai's engine (Bun) runs there:

   ```sh
   proot-distro install debian
   ```

4. Step into Debian. This long command also shares Termux's tools with Debian, which is how notifications reach your phone:

   ```sh
   proot-distro login debian --bind /data/data/com.termux/files/usr:/data/data/com.termux/files/usr
   ```

   The prompt changes to something like `root@localhost:~#`. You're now "inside" Debian.

5. Install the tools Kitsikai needs, then **Bun**:

   ```sh
   apt update && apt install -y curl unzip git nano
   curl -fsSL https://bun.sh/install | bash
   source ~/.bashrc
   bun --version
   ```

   The last line should print a version number like `1.3.11`. If it says "command not found", close Termux completely, open it again, repeat step 4, and try `bun --version` again.

## Part 4: Get Kitsikai (5 minutes)

Still inside Debian (the `root@localhost` prompt):

1. Download the code:

   ```sh
   git clone https://github.com/626andup-cmyk/kitsikai..git kitsikai
   cd kitsikai
   ```

   (Yes, the name has two dots: the repository is called `kitsikai.`, and `.git` comes after it.)

2. Put in your nanoGPT key. First get one: on <https://nano-gpt.com>, log in, open **API**, and create a key (it looks like a long string of letters and numbers). Then:

   ```sh
   cp .env.example .env
   nano .env
   ```

   A simple text editor opens. Use the arrow keys to go to the line `NANOGPT_API_KEY=` and paste your key right after the `=` (no spaces). Then press **Ctrl+O** and **Enter** to save, and **Ctrl+X** to close. (In Termux, **Ctrl** is on the extra row of keys above the keyboard.)

## Part 5: Start it (1 minute)

1. Start the server:

   ```sh
   bun start
   ```

   You should see:

   ```
   Kitsikai is running at http://127.0.0.1:3000
   Time zone: America/Chicago (it's 4:12 PM here)
   ```

   **Check that time.** If it isn't the time on your phone, Debian is using the wrong time zone (it often starts on UTC), and your plans would be hours off. To fix it: press **Ctrl+C** to stop the server, and run `nano .env`. The last line reads `# TZ=America/Chicago`: delete the `#` and the space after it (a line starting with `#` is ignored), and change `America/Chicago` to your own time zone if it's different (it's a region and a city: `Europe/London`, `Asia/Manila`...). The line should read exactly like `TZ=America/Chicago`. Save, and run `bun start` again. The app also warns you if the time zones don't match, and tells you the exact line to add.

   **Leave Termux open** (you can switch to other apps, just don't close it).

2. **Keep it awake:** pull down your notification shade. There's a Termux notification; tap **Acquire wakelock** on it. (Kitsikai also asks for this itself when it starts; tapping it makes sure.)

## Part 6: Open the app (2 minutes)

1. Open **Chrome** and go to **<http://127.0.0.1:3000>**. You'll see Kitsikai: a sidebar of channels with `#general`, 📅 planner, and trackers.
2. Tap Chrome's **⋮ menu → Add to Home screen** (or **Install app**). Now Kitsikai has its own icon and opens like an app.
3. Say hi in `#general`. She should answer in a few seconds.

## Every time after this

Your data is saved, so next time you only need to start the server. Open Termux and type:

```sh
proot-distro login debian --bind /data/data/com.termux/files/usr:/data/data/com.termux/files/usr
cd kitsikai
bun start
```

**Shortcut:** so you don't have to type that every time, make a start script. In Termux (not inside Debian: if your prompt says `root@localhost`, type `exit` first), run this once:

```sh
echo 'proot-distro login debian --bind /data/data/com.termux/files/usr:/data/data/com.termux/files/usr -- bash -c "cd ~/kitsikai && ~/.bun/bin/bun start"' > ~/kitsikai.sh
chmod +x ~/kitsikai.sh
```

From then on, starting Kitsikai is just:

```sh
./kitsikai.sh
```

**Updating Kitsikai** later: stop the server (**Ctrl+C**), then inside Debian run `cd ~/kitsikai && git pull`, and start it again. The open app reloads itself.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Chrome says "This site can't be reached" | The server isn't running. Open Termux and start it (above). |
| She doesn't reply, and an error mentions the API key | Check `.env` (Part 4, step 2): the key has to be right after `NANOGPT_API_KEY=`, no spaces. Restart the server after changing it. |
| An error mentions a model | That model might be unavailable on nanoGPT right now. Open **Settings → Profiles and roulettes** and pick another model. |
| Settings says notifications aren't available | Make sure Termux:API is installed from F-Droid, and that you started the server with the `--bind` command (or `./kitsikai.sh`). |
| She stops texting first when the screen is off | Check Part 2 (battery: Unrestricted) and tap **Acquire wakelock** again. |
| `bun: command not found` | Close Termux fully, open it, log in to Debian again (Part 3, step 4). |
| The app says the server is in a different time zone, or plans show at the wrong time | In `.env`, the `TZ=` line must not start with `#` (Part 5). Restart the server after changing it. Still wrong? Start it with the time zone on the command: `TZ=America/Chicago bun start`. |

## Bringing over a chat from Lumiverse or SillyTavern

If you've been talking to her somewhere else, export that chat (in Lumiverse or SillyTavern, the chat's menu → **Export**, as `.jsonl`), and save the file to your phone. Then in Kitsikai: ⚙ **Settings → Chat history → Import a chat…** and choose the file.

- It shows a preview first: how many messages, from whom, and the dates. No message text is shown, and nothing is saved until you press **Import**.
- It goes into a new channel (or an empty one), with the original dates.
- **Let her catch up** (optional): her notes model reads the whole chat once and writes down what's still worth knowing, at most 10 notes. This sends the whole chat to that model, so pick one whose rules are fine with what's in it.
- If the file can't be read, it shows the file's *layout* instead: field names only, no messages, so it's safe to copy and share when asking for help.

## Once it's running: setting her up

These are all in the app, under ⚙ **Settings**:

- **Profiles and roulettes**: the models she uses. There's one to start with (DeepSeek). Press **Test tools** on it: if it passes, her lookups will work.
- **Screenshots are read by**: for importing your work schedule, pick a profile with a vision model, like Gemini Flash (make one in Profiles).
- **Her notes are written by**: a cheap, steady model is best.
- **Her decisions are made by (Jev)**: press **Test Jev**. If it says "It's working", everything's set. If not, see the live test notes in the README, and set a fallback profile meanwhile.
- **Texting first**: on by default. "Let her judge" lets her decide whether a second text would be too much; pick a number for a hard limit.
