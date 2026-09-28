/**
 * Images in chat: you send a picture, she "sees" it through a vision model.
 *
 * 1. You pick an image in the composer. The app shrinks a big one (phone
 *    photos are huge) and uploads it; it's saved in `data/images/`
 *    (`ImageFiles`) and becomes a message of yours, shown in the chat.
 * 2. The **image-reading profile** (Settings → "Images you send are read
 *    by", or the screenshot reader if that's left alone) is asked to
 *    describe it (`describeImage`): what's in it, and any text in it,
 *    word for word.
 * 3. That description becomes the message's text. **Every model gets it
 *    instead of the image** (`modelText` in src/prompt.ts): her chat model,
 *    Jev, the writer, her tools, as "[Sent an image: ...]". So any model can
 *    follow a chat with pictures in it, vision or not, and the picture is
 *    read once, not on every turn.
 * 4. You can see what she sees under the image, **edit** it if the vision
 *    model got something wrong, or have it **read again**.
 *
 * Her reply waits until the images you sent have been read
 * (`ImageReader.settled`), so she never answers a picture she hasn't seen.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "./errors.ts";
import type { Events } from "./events.ts";
import { profileRequest } from "./kitsikai.ts";
import { ApiError, createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import { IMAGE_TYPES } from "./screenshot.ts";
import type { Store } from "./store.ts";
import type { Message, Profile } from "./types.ts";

/** The biggest image accepted, as base64 text (about 15 MB of image). The app shrinks photos well under this. */
export const MAX_CHAT_IMAGE_BASE64 = 20_000_000;

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

// ------------------------------------------------------------------ files

/** The image files, in `data/images/`. */
export class ImageFiles {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "images");
  }

  /** Save an image; returns its file name. */
  save(data: Buffer, mimeType: string): string {
    const extension = EXTENSIONS[mimeType];
    if (!extension) throw new ValidationError("An image must be a PNG, JPEG, WebP or GIF.");
    mkdirSync(this.dir, { recursive: true });
    const file = `${crypto.randomUUID()}.${extension}`;
    writeFileSync(join(this.dir, file), data);
    return file;
  }

  /** Where a file is. File names are ours (a uuid and an extension), never a path. */
  path(file: string): string {
    if (!/^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/.test(file)) throw new ValidationError("Not an image file name.");
    return join(this.dir, file);
  }

  /** Delete image files no message has any more (after deleting messages or a channel). Returns how many went. */
  sweep(keep: Set<string>): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const file of readdirSync(this.dir)) {
      if (keep.has(file)) continue;
      rmSync(join(this.dir, file), { force: true });
      removed++;
    }
    return removed;
  }
}

/** Check an uploaded image: its type, and that it's base64 of a sensible size. */
export function checkUpload(body: Record<string, unknown>): { data: Buffer; mimeType: string; width: number | null; height: number | null } {
  if (typeof body.mimeType !== "string" || !IMAGE_TYPES.includes(body.mimeType)) {
    throw new ValidationError("The image must be a PNG, JPEG, WebP or GIF.");
  }
  if (typeof body.image !== "string" || body.image.length === 0 || body.image.length > MAX_CHAT_IMAGE_BASE64) {
    throw new ValidationError('"image" must be the image as base64, 15 MB at most.');
  }
  const data = Buffer.from(body.image, "base64");
  if (data.length === 0) throw new ValidationError('"image" isn\'t base64.');
  const size = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 && value < 100_000 ? value : null);
  return { data, mimeType: body.mimeType, width: size(body.width), height: size(body.height) };
}

// ---------------------------------------------------------------- reading

/** What the vision model is asked to do. */
export const DESCRIBE_PROMPT = `You describe images for someone who can't see them. A friend has been sent this picture in a text chat, and your description is all they'll have of it, so they can react to it as if they'd seen it.

Describe it plainly and specifically: what kind of image it is (a photo, a selfie, a screenshot, a meme, a drawing...), who and what is in it, what's happening, expressions, the setting, and anything that stands out. Copy any text in it exactly, in quotes. Don't guess who people are unless it's written in the image.

No preamble ("This image shows..."), no opinions, no jokes, no advice. Keep it under about 150 words, unless it's mostly text: then copy the text in full.`;

/**
 * Ask a vision model what's in an image.
 *
 * @throws ApiError if the request fails, or nothing came back.
 */
export async function describeImage(api: ApiOptions, profile: Profile, image: { data: string; mimeType: string }): Promise<string> {
  const response = await createChatCompletion(api, {
    ...profileRequest(profile),
    messages: [
      { role: "system", content: DESCRIBE_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
        ],
      },
    ],
  });
  const text = response.content.trim();
  if (!text) throw new ApiError(`${profile.name} didn't describe the image. Is it a vision model?`);
  return text;
}

/** What reading images needs. */
export interface ImageReaderDeps {
  store: Store;
  api: ApiOptions;
  files: ImageFiles;
  events: Events;
}

/**
 * Reads images in the background, one message at a time, and remembers
 * which channels still have images being read, so her reply can wait.
 */
export class ImageReader {
  /** Reads in progress, by message id, with their channel. */
  private readonly reading = new Map<string, { channelId: string; done: Promise<void> }>();

  constructor(private readonly deps: ImageReaderDeps) {}

  /** The profile that reads images: Settings → images, or the screenshot reader. */
  profile(): Profile {
    const settings = this.deps.store.getSettings();
    return this.deps.store.profiles.pick(settings.imageAssignment || settings.screenshotAssignment, false);
  }

  /**
   * Read an image message (again): start it, and return straight away. The
   * app hears about it through a `message` event when it's done.
   */
  read(message: Message): Message {
    if (!message.image) throw new ValidationError("That message has no image.");
    const existing = this.reading.get(message.id);
    if (existing) return this.deps.store.getMessage(message.id);
    const updated = this.deps.store.updateImage(message.id, { status: "reading", error: null });
    this.deps.events.publish({ type: "message", message: updated });
    const done = this.run(updated).finally(() => this.reading.delete(message.id));
    this.reading.set(message.id, { channelId: message.channelId, done });
    return updated;
  }

  /** Whether an image in this channel is being read. */
  isReading(channelId: string): boolean {
    return [...this.reading.values()].some((r) => r.channelId === channelId);
  }

  /** Wait until every image being read in a channel (or anywhere, without one) is done. Never throws. */
  async settled(channelId?: string): Promise<void> {
    for (;;) {
      const pending = [...this.reading.values()].filter((r) => !channelId || r.channelId === channelId);
      if (pending.length === 0) return;
      await Promise.all(pending.map((r) => r.done));
    }
  }

  private async run(message: Message): Promise<void> {
    const { store, api, files, events } = this.deps;
    const started = new Date().toISOString();
    let profile: Profile | null = null;
    let updated: Message;
    try {
      profile = this.profile();
      const image = message.image!;
      const data = (await Bun.file(files.path(image.file)).arrayBuffer()) as ArrayBuffer;
      const seen = await describeImage(api, profile, { data: Buffer.from(data).toString("base64"), mimeType: image.mimeType });
      const now = store.getMessage(message.id);
      // You edited it while it was being read: your words win.
      const yours = now.editedAt !== undefined && now.editedAt > started;
      updated = store.updateImage(message.id, { status: "read", error: null, readBy: profile.name, model: profile.model }, yours ? undefined : seen);
      console.log(`[images] ${profile.name} read an image in #${store.getChannel(message.channelId).name}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        updated = store.updateImage(message.id, { status: "failed", error: reason, readBy: profile?.name ?? null, model: profile?.model ?? null });
      } catch {
        return; // the message was deleted meanwhile
      }
      console.warn(`[images] couldn't read an image: ${reason}`);
    }
    events.publish({ type: "message", message: updated });
  }
}
