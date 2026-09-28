/**
 * Tests for images in chat (src/images.ts): sending one, the vision model
 * reading it, the description standing in for the image for every model,
 * editing it, reading it again, and the files.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerEvent } from "../src/events.ts";
import { DESCRIBE_PROMPT } from "../src/images.ts";
import { modelText } from "../src/prompt.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool } from "../src/tools.ts";
import type { Channel, Message } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, testPng, type FakeNanoGpt } from "./helpers.ts";

setDefaultTimeout(15_000);

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let call: ReturnType<typeof caller>;
let general: Channel;
let events: ServerEvent[];

const PNG = testPng(40, 30);
const SEEN = 'A golden retriever puppy asleep on a blue couch. A sticky note on the wall reads "NO SOCKS".';

function start() {
  app = createApp(testConfig(dir.path, fake.baseUrl));
  call = caller(app.fetch);
  general = app.store.listChannels()[0]!;
  events = [];
  app.events.listen((e) => events.push(e));
}

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  start();
  app.store.updateSettings({ replyDebounceSeconds: 0 });
});

afterEach(async () => {
  await app.images.settled();
  await app.replies.flush();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

/** Send an image; returns the message as the upload answered it. */
async function sendImage(channelId = general.id, body: Record<string, unknown> = {}) {
  const response = await call("POST", `/api/channels/${channelId}/images`, { image: PNG.toString("base64"), mimeType: "image/png", width: 40, height: 30, ...body });
  return response;
}

const imageDir = () => join(dir.path, "images");
const message = (id: string) => app.store.getMessage(id);

describe("sending an image", () => {
  test("it's saved, shown at once as your bubble, and read in the background", async () => {
    fake.replies.push({ content: SEEN }, { content: "omg" });
    const { status, data } = await sendImage();
    expect(status).toBe(200);
    const sent: Message = data.userMessages[0];
    expect(sent).toMatchObject({ author: "user", content: "", image: { mimeType: "image/png", width: 40, height: 30, status: "reading", error: null } });
    expect(readdirSync(imageDir())).toEqual([sent.image!.file]);
    expect(events.find((e) => e.type === "messages")).toMatchObject({ messages: [{ id: sent.id }] });

    await app.images.settled();
    expect(message(sent.id)).toMatchObject({ content: SEEN, image: { status: "read", readBy: "DeepSeek-V3.1-Terminus", model: "deepseek-ai/DeepSeek-V3.1-Terminus" } });
    expect(message(sent.id).editedAt).toBeUndefined();
    expect(events.filter((e) => e.type === "message").at(-1)).toMatchObject({ message: { id: sent.id, content: SEEN } });
  });

  test("the vision model is asked to describe it, with the image itself", async () => {
    fake.replies.push({ content: SEEN });
    await sendImage();
    await app.images.settled();
    const request = fake.requests[0]!;
    expect(request.messages[0]).toEqual({ role: "system", content: DESCRIBE_PROMPT });
    expect(request.messages[1]!.content as unknown).toEqual([
      { type: "text", text: "Describe this image." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
    ]);
  });

  test("read by the image profile, or the screenshot reader when that's left alone", async () => {
    const vision = app.store.profiles.create({ name: "Eyes", model: "vision/model" });
    const screenshots = app.store.profiles.create({ name: "Schedules", model: "screenshot/model" });
    app.store.updateSettings({ screenshotAssignment: `profile:${screenshots.id}` });
    await sendImage();
    await app.images.settled();
    expect(fake.requests.at(-1)!.model).toBe("screenshot/model");
    const saved = await call("PUT", "/api/settings", { imageAssignment: `profile:${vision.id}` });
    expect(saved.data.settings.imageAssignment).toBe(`profile:${vision.id}`);
    await sendImage();
    await app.images.settled();
    expect(fake.requests.at(-1)!.model).toBe("vision/model");
    // Deleting the profile puts the setting back.
    app.store.profiles.delete(vision.id);
    expect(app.store.getSettings().imageAssignment).toBe("");
  });

  test("only real images, and only in text channels", async () => {
    expect((await sendImage(general.id, { mimeType: "image/svg+xml" })).data.error).toBe("The image must be a PNG, JPEG, WebP or GIF.");
    expect((await sendImage(general.id, { image: "" })).status).toBe(400);
    const planner = app.store.listChannels().find((c) => c.kind === "planner")!;
    expect((await sendImage(planner.id)).data.error).toBe("You can only send images in text channels.");
    expect(existsSync(imageDir()) ? readdirSync(imageDir()) : []).toEqual([]);
  });

  test("the image is served back, by its message", async () => {
    const { data } = await sendImage();
    const response = await app.fetch(new Request(`http://localhost/api/images/${data.userMessages[0].id}`));
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    const text = app.store.addMessage({ channelId: general.id, author: "user", content: "hi" });
    expect((await app.fetch(new Request(`http://localhost/api/images/${text.id}`))).status).toBe(404);
  });
});

describe("what every model gets instead", () => {
  test("her reply waits for the reading, and her prompt has the description", async () => {
    fake.replies.push({ content: SEEN, delayMs: 200 }, { content: "OMG" });
    await sendImage();
    await call("POST", `/api/channels/${general.id}/messages`, { content: "look who did it again" });
    await app.replies.flush();
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: `[Sent an image: ${SEEN}] <cht> look who did it again` });
  });

  test("Jev reads it too, in the scratchpad check", async () => {
    fake.replies.push({ content: SEEN });
    await sendImage();
    await app.replies.flush();
    expect(fake.jevRequests[0]!.state).toContain(`them (NEW): [Sent an image: ${SEEN}]`);
  });

  test("her tools: search_history finds it by what's in it", async () => {
    fake.replies.push({ content: SEEN });
    await sendImage();
    await app.images.settled();
    const other = app.store.createChannel({ name: "other", kind: "text" });
    const found = runTool({ store: app.store, channel: other, now: new Date() }, "search_history", { query: "retriever" });
    expect(found.result).toEqual([expect.objectContaining({ from: "them", text: `[Sent an image: ${SEEN}]` })]);
  });

  test("a description with the safeword in it isn't you saying it", async () => {
    fake.replies.push({ content: 'A meme that says "seriously?" in big letters.' });
    await sendImage();
    await app.replies.flush();
    expect(app.store.intimacy.get()).toBeNull();
  });

  test("modelText: text as it is; an image as its description, or what happened", () => {
    const base = { id: "m", channelId: "c", author: "user" as const, turnId: null, createdAt: "" };
    const image = { file: "f", mimeType: "image/png", width: null, height: null, error: null, readBy: null, model: null };
    expect(modelText({ ...base, content: "hi" })).toBe("hi");
    expect(modelText({ ...base, content: "a cat\n on a mat ", image: { ...image, status: "read" } })).toBe("[Sent an image: a cat on a mat]");
    expect(modelText({ ...base, content: "", image: { ...image, status: "reading" } })).toBe("[Sent an image. It's still being looked at.]");
    expect(modelText({ ...base, content: "", image: { ...image, status: "failed" } })).toBe("[Sent an image that couldn't be described.]");
  });
});

describe("seeing and fixing what she sees", () => {
  test("a failed read says why; Read again tries again", async () => {
    fake.replies.push({ status: 500, error: "no vision here" }, { content: "hm?" });
    const { data } = await sendImage();
    await app.replies.flush();
    const id = data.userMessages[0].id;
    expect(message(id)).toMatchObject({ content: "", image: { status: "failed" } });
    expect(message(id).image!.error).toContain("no vision here");
    expect(fake.requests[1]!.messages.at(-1)!.content).toBe("[Sent an image that couldn't be described.]");

    fake.replies.push({ content: SEEN });
    const again = await call("POST", `/api/messages/${id}/read-image`, {});
    expect(again.data.message.image).toMatchObject({ status: "reading", error: null });
    await app.images.settled();
    expect(message(id)).toMatchObject({ content: SEEN, image: { status: "read" } });
    expect((await call("POST", `/api/messages/${app.store.addMessage({ channelId: general.id, author: "user", content: "x" }).id}/read-image`, {})).status).toBe(400);
  });

  test("editing it is what every model gets from then on; reading again replaces the edit", async () => {
    fake.replies.push({ content: "A cat." });
    const { data } = await sendImage();
    await app.images.settled();
    const id = data.userMessages[0].id;
    const edited = await call("PATCH", `/api/messages/${id}`, { content: "A dog, actually." });
    expect(edited.data.message).toMatchObject({ content: "A dog, actually.", image: { status: "read" } });
    expect(edited.data.message.editedAt).toBeDefined();
    expect(events.filter((e) => e.type === "message").at(-1)).toMatchObject({ message: { id, content: "A dog, actually." } });
    expect(modelText(message(id))).toBe("[Sent an image: A dog, actually.]");

    fake.replies.push({ content: SEEN });
    await call("POST", `/api/messages/${id}/read-image`, {});
    await app.images.settled();
    expect(message(id).content).toBe(SEEN);
    expect(message(id).editedAt).toBeUndefined();
  });

  test("an edit made while it's being read wins", async () => {
    fake.replies.push({ content: SEEN, delayMs: 200 });
    const { data } = await sendImage();
    const id = data.userMessages[0].id;
    await Bun.sleep(20);
    await call("PATCH", `/api/messages/${id}`, { content: "My own words." });
    await app.images.settled();
    expect(message(id)).toMatchObject({ content: "My own words.", image: { status: "read" } });
  });
});

describe("the files", () => {
  test("go when their message, channel, or history does; strays go at startup", async () => {
    const first = (await sendImage()).data.userMessages[0];
    const second = (await sendImage()).data.userMessages[0];
    await app.images.settled();
    await app.replies.flush();
    expect(readdirSync(imageDir())).toHaveLength(2);

    await call("DELETE", `/api/messages/${first.id}`, {});
    expect(readdirSync(imageDir())).toEqual([second.image.file]);
    await call("DELETE", `/api/channels/${general.id}/messages`, {});
    expect(readdirSync(imageDir())).toEqual([]);

    const other = (await call("POST", "/api/channels", { name: "pics" })).data.channel as Channel;
    await sendImage(other.id);
    await app.images.settled();
    await app.replies.flush();
    await call("DELETE", `/api/channels/${other.id}`, {});
    expect(readdirSync(imageDir())).toEqual([]);

    writeFileSync(join(imageDir(), "00000000-0000-0000-0000-000000000000.png"), PNG);
    app.store.close();
    start();
    expect(readdirSync(imageDir())).toEqual([]);
  });

  test("Stop while it's being read: she doesn't reply", async () => {
    fake.replies.push({ content: SEEN, delayMs: 200 });
    app.store.updateSettings({ replyDebounceSeconds: 0.05 });
    await sendImage();
    await Bun.sleep(100); // the wait is over; the image is still being read
    await call("POST", `/api/channels/${general.id}/cancel`, {});
    await app.images.settled();
    await app.replies.flush();
    expect(fake.requests).toHaveLength(1); // only the vision model
  });
});
