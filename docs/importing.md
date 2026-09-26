# Importing a chat: how it works

If you've been talking to her somewhere else, like Lumiverse or SillyTavern, that history is worth keeping. Settings → **Chat history → Import a chat…** brings it over. (For the steps on the phone, see [install.md](install.md#bringing-over-a-chat-from-lumiverse-or-sillytavern).)

## The file

SillyTavern, and frontends that use its format, export a chat as a **`.jsonl`** file: **JSON Lines**, one JSON object per line. The first line is about the chat (your name, hers), and every line after it is one message:

```
{"user_name": "Sam", "character_name": "Kitsikai", "create_date": "2026-06-26@21h14m05s"}
{"name": "Sam", "is_user": true, "send_date": "June 26, 2026 9:14pm", "mes": "hey"}
{"name": "Kitsikai", "is_user": false, "send_date": "June 26, 2026 9:15pm", "mes": "hiii<cht>how was work"}
```

`parseChat` in `src/importer.ts` reads that **forgivingly**, the way stage 4 reads a screenshot model's JSON: a JSON list works too; `role` and `content` work instead of `is_user` and `mes`; dates can be SillyTavern's two text formats, ISO 8601, or a number. Hidden system messages and empty ones are left out; lines it can't read are counted, not fatal.

## Privacy

Everything happens on your phone. And because a chat can be personal, nothing about importing ever shows or logs message text:

- **The preview** shows only counts, names, dates and what was left out: "452 messages: 230 from you (as "Sam"), 222 from her (as "Kitsikai"). From Jun 26, 2026 to Sep 25, 2026."
- **If the file can't be read**, the error shows the file's **layout**: field names and types, like `{ name: text, is_user: true/false, send_date: text, mes: text }`. That's safe to copy and share when asking for help.
- Errors from catching up say what failed, never what was in the chat.

Once imported, her messages are sent to her models like any others: her chat model sees the channel's newest messages each turn and whatever `search_history` finds, and Jev sees a few recent ones when it checks your new messages.

## Into a channel

`importChat` puts the messages into a **new channel** (or an **empty** one: a channel's messages are kept in the order they arrived, so older messages can't go after newer ones), all or nothing:

- **With their original dates**, so the time notes she reads ("[Sun 9:12 PM, 2 days later]") are right.
- **In bubbles**: a message with `<cht>` in it becomes several bubbles, like her new replies. Messages in a row from the same person share a turn.
- **Not as new**: the scratchpad check's mark is moved past them (so Jev doesn't go through three months of chat as if you'd just said it), no notifications go out, and she doesn't reply.

## Reaching further back: `search_history`

She sees only a channel's newest messages each turn (Settings → History, 40 by default). Her **`search_history`** tool searches everything you've said to each other, in every channel: every word you give has to be in a message, in any order. Results come with the date and channel, newest first, leaving out what's already in front of her.

## Catching up

Optional, and ticked when you import (`src/catchup.ts`). Her notes model reads the whole chat back, oldest first, in parts of about 12,000 characters. For each part, it gets the notes so far and the next part, and returns the updated list: things are added, and dropped once they're settled, so what's left at the end is what matters **now**, at most 10 notes.

Those go on her scratchpad like anything she notices, and the next processing round decides what to keep (stage 7): usually things she might bring up, maybe a pin. Pencil before pen, like everything else. The advanced page shows the catch-up's progress, and its notes.

It sends the whole chat to your notes model (Settings → Her notes are written by), so pick a model whose rules are fine with what's in it.

## Tests

`test/importer.test.ts` (every chat made up): reading SillyTavern's format and the variations, dates, undated and future dates, files it can't read (their layout, never their text), the preview, importing (dates, bubbles, turns, the mark, no notifications or replies), empty and non-empty channels, `search_history`, and catching up (one part, several, failing, one at a time). `test/ui.test.ts` imports a file through the dialog.
