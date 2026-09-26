/**
 * Tests for stage 2's channels: creating, renaming, topics, ordering,
 * deleting, and the home channel.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, type App } from "../src/server.ts";
import type { Channel } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let call: ReturnType<typeof caller>;
let general: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  call = caller(app.fetch);
  [general] = app.store.listChannels() as [Channel];
});

afterEach(async () => {
  await app.replies.flush();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

describe("channels", () => {
  test("can be created with a topic, at the bottom of the list", async () => {
    const { status, data } = await call("POST", "/api/channels", { name: "Work Stuff", topic: " venting about shifts " });
    expect(status).toBe(200);
    expect(data.channel).toMatchObject({ name: "work-stuff", kind: "text", topic: "venting about shifts", position: 2 });
    expect(data.channels.map((c: Channel) => c.name)).toEqual(["general", "planner", "work-stuff"]);
  });

  test("are checked when created", async () => {
    expect((await call("POST", "/api/channels", { name: "" })).status).toBe(400);
    expect((await call("POST", "/api/channels", { name: "x", kind: "voice" })).status).toBe(400);
    expect((await call("POST", "/api/channels", { name: "x", topic: "t".repeat(301) })).status).toBe(400);
  });

  test("topics can be changed, and she sees hers and the others'", async () => {
    await call("PATCH", `/api/channels/${general.id}`, { topic: "anything goes" });
    await call("POST", "/api/channels", { name: "gaming", topic: "games" });
    await call("POST", `/api/channels/${general.id}/turn`, {});
    const system = fake.requests[0]!.messages[0]!.content;
    expect(system).toContain('You\'re in #general (topic: "anything goes").');
    expect(system).toContain('The other channels: #gaming (topic: "games").');
  });

  test("can be reordered, with every channel listed exactly once", async () => {
    const b = app.store.createChannel({ name: "b", kind: "text" });
    const planner = app.store.listChannels().find((c) => c.kind === "planner")!;
    const { data } = await call("PUT", "/api/channels/order", { ids: [b.id, planner.id, general.id] });
    expect(data.channels.map((c: Channel) => c.name)).toEqual(["b", "planner", "general"]);
    expect((await call("PUT", "/api/channels/order", { ids: [b.id, general.id] })).status).toBe(400);
    expect((await call("PUT", "/api/channels/order", { ids: [b.id, b.id, general.id] })).status).toBe(400);
  });

  test("can be deleted with their messages, but not the last text channel", async () => {
    const b = app.store.createChannel({ name: "b", kind: "text" });
    app.store.addMessage({ channelId: b.id, author: "user", content: "bye" });
    expect((await call("DELETE", `/api/channels/${b.id}`, {})).status).toBe(200);
    expect(app.store.listChannels().map((c) => c.name)).toEqual(["general", "planner"]);
    const last = await call("DELETE", `/api/channels/${general.id}`, {});
    expect(last.status).toBe(400);
    expect(last.data.error).toContain("at least one text channel");
  });

  test("deleting a channel she's waiting to reply in stops the wait", async () => {
    const b = app.store.createChannel({ name: "b", kind: "text" });
    await call("POST", `/api/channels/${b.id}/messages`, { content: "hi" });
    expect(app.replies.isWaiting(b.id)).toBe(true);
    await call("DELETE", `/api/channels/${b.id}`, {});
    expect(app.replies.isWaiting(b.id)).toBe(false);
    await app.replies.flush();
    expect(fake.requests).toHaveLength(0);
  });
});

describe("the home channel", () => {
  test("is the first text channel until you choose one", async () => {
    const b = app.store.createChannel({ name: "b", kind: "text" });
    expect(app.store.homeChannel().id).toBe(general.id);
    const { data } = await call("PUT", "/api/settings", { homeChannelId: b.id });
    expect(data.settings.homeChannelId).toBe(b.id);
    expect(app.store.homeChannel().id).toBe(b.id);
  });

  test("falls back to the first text channel when yours is deleted", async () => {
    const b = app.store.createChannel({ name: "b", kind: "text" });
    await call("PUT", "/api/settings", { homeChannelId: b.id });
    await call("DELETE", `/api/channels/${b.id}`, {});
    expect(app.store.homeChannel().id).toBe(general.id);
  });

  test("must be a channel that exists", async () => {
    expect((await call("PUT", "/api/settings", { homeChannelId: "nope" })).status).toBe(404);
    expect((await call("PUT", "/api/settings", { homeChannelId: "" })).status).toBe(200);
  });
});

describe("timing settings", () => {
  test("are checked", async () => {
    const ok = await call("PUT", "/api/settings", { replyDebounceSeconds: 2.5, typingBaseMs: 500, typingPerCharMs: 30 });
    expect(ok.data.settings).toMatchObject({ replyDebounceSeconds: 2.5, typingBaseMs: 500, typingPerCharMs: 30 });
    expect((await call("PUT", "/api/settings", { replyDebounceSeconds: -1 })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { typingPerCharMs: 1.5 })).status).toBe(400);
  });
});
