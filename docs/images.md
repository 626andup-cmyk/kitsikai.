# Images in chat: how it works

You can send her pictures: a photo, a screenshot, a meme. She "sees" them through a **vision model**, a model that can read images, whose description of the picture is what she gets instead. The code is `src/images.ts`.

## Sending one

Tap **🖼️** next to the text box (or paste an image into it). What you pick shows above the text box, with a ✕ to take it out again. **Send** sends the images first, each its own bubble, then your text, if you wrote any.

A big phone photo is shrunk before it's sent: its longest side to 2048 pixels, as a JPEG. That's plenty for a vision model and for the chat, and keeps the upload quick. A small PNG, JPEG, WebP or GIF goes as it is. Images are saved in `data/images/`, one file each, and are deleted when their message is (or its channel, or the channel's history).

## Reading it

As soon as it's sent, the image shows in the chat, with "Looking at the image…" under it, while the **image-reading profile** describes it. That's Settings → **Images you send are read by**. Left on "Same as screenshots", it's whichever profile reads your schedule screenshots. Either way it needs a vision model (Gemini Flash, GPT-4o mini, Qwen VL...).

The vision model is asked (`DESCRIBE_PROMPT`) to describe the picture for someone who can't see it: what kind of image it is, who and what is in it, what's happening, and any text in it, word for word. No preamble, no opinions, under about 150 words unless it's mostly text.

**Her reply waits** until your images have been read, so she never answers a picture she hasn't seen. Stop still stops her. "Her turn" and Regenerate wait too.

## What every model gets instead

The description becomes the message's text, and **every model gets it in place of the image** (`modelText` in `src/prompt.ts`):

```
[Sent an image: A golden retriever puppy asleep on a blue couch. A sticky note on the wall reads "NO SOCKS".]
```

That covers her chat model, Jev's scratchpad check, the processing writer, catching up, `read_channel` and `search_history` (which can find a picture by what's in it). So a text-only model can follow a chat with pictures in it. The picture is read **once**, not re-sent on every turn. Her prompt tells her these brackets describe a picture you sent, to react as if she'd seen it, and not to mention the description.

If reading failed, models get `[Sent an image that couldn't be described.]`. The safeword is only ever what you typed: a picture of the word "seriously" doesn't start the hold.

## Seeing it, and fixing it

Under each image, **What Kitsikai sees** shows the description: three lines, and all of it when you tap. Tap the image itself for a big view.

Tap the bubble for its buttons:

- **Edit what she sees**: fix anything the vision model got wrong, or describe it yourself if reading failed. From then on, that's what every model gets. It's marked "(you edited it)".
- **Read again**: the vision model looks at it again, and its new description replaces the old one (and your edit, if you made one). If you edit while it's still reading, your words win.
- **Delete**: the message and its file.

If reading failed, the reason shows under the image (usually: the profile isn't a vision model).

## Where things are

| | |
| --- | --- |
| `src/images.ts` | Saving and deleting files (`ImageFiles`), the vision request (`describeImage`), reading in the background and waiting for it (`ImageReader`) |
| `src/prompt.ts` | `modelText`: a message as models see it |
| `src/replies.ts` | Her reply waiting for images to be read |
| `src/db.ts` | Migration 12: a message's image, as JSON |
| `public/app.js` | Picking, shrinking and sending; the image and "What Kitsikai sees" in the chat |
| `test/images.test.ts` | Tests, with a made-up PNG and descriptions |
