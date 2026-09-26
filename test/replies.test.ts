/**
 * Tests for stage 2's timing on the server: waiting before replying
 * (src/replies.ts), bubbles (src/bubbles.ts), and the events stream
 * (src/events.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { joinBubbles, splitBubbles } from "../src/bubbles.ts";
import type { ServerEvent } from "../src/events.ts";
import { createApp, type App } from "../src/server.ts";
import type { Channel } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let call: ReturnType<typeof caller>;
let general: Channel;
let events: ServerEvent[];

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  call = caller(app.fetch);
  [general] = app.store.listChannels() as [Channel];
  // A short wait, so tests can use real timers.
  app.store.updateSettings({ replyDebounceSeconds: 0.08 });
  events = [];
  app.events.listen((event) => events.push(event));
});

afterEach(async () => {
  await app.replies.flush();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

const send = (content: string, channel = general) => call("POST", `/api/channels/${channel.id}/messages`, { content });

describe("splitBubbles", () => {
  test("splits on <cht>, forgiving untidy markers", () => {
    expect(splitBubbles("omg wait<cht>you said that??<cht>legend")).toEqual(["omg wait", "you said that??", "legend"]);
    expect(splitBubbles("a <CHT> b < cht > c </cht> d <cht/> e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(splitBubbles("one\n<cht>\ntwo")).toEqual(["one", "two"]);
  });

  test("a reply with no markers is one bubble, and empty pieces are ignored", () => {
    expect(splitBubbles("just one\nwith two lines")).toEqual(["just one\nwith two lines"]);
    expect(splitBubbles("<cht>hey<cht><cht>there<cht>")).toEqual(["hey", "there"]);
    expect(splitBubbles("  <cht>  ")).toEqual([]);
  });

  test("joinBubbles puts the marker back", () => {
    expect(joinBubbles(["a", "b"])).toBe("a <cht> b");
  });
});

describe("her replies", () => {
  test("are split into bubbles that share a turn id", async () => {
    fake.replies.push({ content: "omg<cht>tell me everything<cht>" });
    await send("guess what");
    await app.replies.flush();
    const hers = app.store.getMessages(general.id).filter((m) => m.author === "kitsikai");
    expect(hers.map((m) => m.content)).toEqual(["omg", "tell me everything"]);
    expect(hers[0]!.turnId).toBe(hers[1]!.turnId!);
  });

  test("regenerating replaces every bubble of her last reply", async () => {
    fake.replies.push({ content: "one<cht>two<cht>three" }, { content: "fresh" });
    await send("hi");
    await app.replies.flush();
    const { data } = await call("POST", `/api/channels/${general.id}/regenerate`, {});
    expect(data.replacedIds).toHaveLength(3);
    expect(app.store.getMessages(general.id).map((m) => m.content)).toEqual(["hi", "fresh"]);
  });

  test("time notes she copies by mistake are taken out", async () => {
    fake.replies.push({ content: "[9:12 PM, 3 hours later] morning!!<cht>[Sun 10:00 AM, 2 days later] miss me?" });
    await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(app.store.getMessages(general.id).map((m) => m.content)).toEqual(["morning!!", "miss me?"]);
  });
});

describe("waiting before replying", () => {
  test("she waits until you stop sending, then answers everything at once", async () => {
    await send("hey");
    await Bun.sleep(40);
    await send("so guess what");
    await Bun.sleep(40);
    await send("the manager moved my break AGAIN");
    expect(fake.requests).toHaveLength(0); // still waiting
    await Bun.sleep(150);
    await app.replies.flush();
    expect(fake.requests).toHaveLength(1);
    // All three bubbles, as one turn with <cht> between them.
    expect(fake.requests[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: "hey <cht> so guess what <cht> the manager moved my break AGAIN",
    });
    const yours = app.store.getMessages(general.id).filter((m) => m.author === "user");
    expect(new Set(yours.map((m) => m.turnId)).size).toBe(1);
  });

  test("typing makes her wait longer, but only if she's waiting", async () => {
    expect((await call("POST", `/api/channels/${general.id}/typing`, {})).data).toEqual({ waiting: false });
    await send("hmm");
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(40);
      expect((await call("POST", `/api/channels/${general.id}/typing`, {})).data).toEqual({ waiting: true });
    }
    expect(fake.requests).toHaveLength(0);
    await Bun.sleep(150);
    await app.replies.flush();
    expect(fake.requests).toHaveLength(1);
  });

  test("a new bubble while she's writing stops that reply, and she starts over", async () => {
    fake.replies.push({ content: "out of date", delayMs: 200 }, { content: "answering both" });
    await send("first");
    await Bun.sleep(120); // the wait is over; she's writing
    expect(app.kitsikai.isBusy(general.id)).toBe(true);
    await send("second");
    expect(app.kitsikai.isBusy(general.id)).toBe(false);
    await Bun.sleep(350);
    await app.replies.flush();
    expect(app.store.getMessages(general.id).map((m) => m.content)).toEqual(["first", "second", "answering both"]);
  });

  test("Stop cancels the wait too", async () => {
    await send("nvm");
    const { data } = await call("POST", `/api/channels/${general.id}/cancel`, {});
    expect(data).toEqual({ cancelled: true });
    await Bun.sleep(150);
    expect(fake.requests).toHaveLength(0);
  });

  test("she doesn't reply if your message was deleted while she waited", async () => {
    const { data } = await send("oops wrong chat");
    await call("DELETE", `/api/messages/${data.userMessages[0].id}`, {});
    await Bun.sleep(150);
    await app.replies.flush();
    expect(fake.requests).toHaveLength(0);
  });

  test("channels wait separately", async () => {
    const gaming = app.store.createChannel({ name: "gaming", kind: "text" });
    fake.replies.push({ content: "general reply" }, { content: "gaming reply" });
    await send("in general");
    await send("in gaming", gaming);
    await Bun.sleep(150);
    await app.replies.flush();
    expect(app.store.getMessages(general.id).at(-1)!.content).toBe("general reply");
    expect(app.store.getMessages(gaming.id).at(-1)!.content).toBe("gaming reply");
  });
});

describe("events", () => {
  test("announce your bubbles, her typing, and her reply", async () => {
    fake.replies.push({ content: "yo<cht>sup" });
    await send("hey");
    await app.replies.flush();
    const types = events.map((e) => e.type);
    expect(types).toEqual(["messages", "busy", "messages", "busy"]);
    expect(events[1]).toEqual({ type: "busy", channelIds: [general.id] });
    const reply = events[2] as Extract<ServerEvent, { type: "messages" }>;
    expect(reply.messages.map((m) => m.content)).toEqual(["yo", "sup"]);
    expect(events[3]).toEqual({ type: "busy", channelIds: [] });
  });

  test("announce deletions and channel changes", async () => {
    const message = app.store.addMessage({ channelId: general.id, author: "user", content: "x" });
    await call("DELETE", `/api/messages/${message.id}`, {});
    await call("POST", "/api/channels", { name: "new" });
    expect(events[0]).toEqual({ type: "deleted", channelId: general.id, ids: [message.id] });
    expect(events[1]!.type).toBe("channels");
  });

  test("stream to the app as Server-Sent Events", async () => {
    const before = app.events.connections; // listeners from code (like this test's) don't count
    const response = await app.fetch(new Request("http://localhost/api/events"));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const hello = decoder.decode((await reader.read()).value);
    expect(hello).toContain(": connected");

    await call("POST", "/api/channels", { name: "streamed" });
    const line = decoder.decode((await reader.read()).value);
    expect(line.startsWith("data: ")).toBe(true);
    const event = JSON.parse(line.slice(6));
    expect(event.type).toBe("channels");
    expect(event.channels.map((c: Channel) => c.name)).toContain("streamed");
    expect(app.events.connections).toBe(before + 1);
    await reader.cancel();
    expect(app.events.connections).toBe(before);
  });
});
