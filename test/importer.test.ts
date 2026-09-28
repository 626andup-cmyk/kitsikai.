/**
 * Tests for importing a chat from Lumiverse or SillyTavern
 * (src/importer.ts), her search_history tool, and catching up on an
 * imported chat (src/catchup.ts). Every chat here is made up.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { partsOf } from "../src/catchup.ts";
import type { ServerEvent } from "../src/events.ts";
import { describeLayout, ImportError, parseChat, parseDate, previewOf } from "../src/importer.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool } from "../src/tools.ts";
import type { Channel } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

setDefaultTimeout(15_000);

const NOW = new Date(2026, 8, 26, 18, 0);

/** A SillyTavern-style export: a header line, then one message per line. */
const SILLYTAVERN = [
  { user_name: "Sam", character_name: "Kitsikai", create_date: "2026-06-26@21h14m05s", chat_metadata: {} },
  { name: "Sam", is_user: true, is_system: false, send_date: "June 26, 2026 9:14pm", mes: "hey you", swipes: ["hey you"] },
  { name: "Kitsikai", is_user: false, send_date: "June 26, 2026 9:15pm", mes: "hiii<cht>how was work", swipes: ["hi", "hiii<cht>how was work"], swipe_id: 1, extra: {} },
  { name: "Sam", is_user: true, send_date: "2026-6-27 @08h 02m 11s 120ms", mes: "PINEAPPLE morning" },
  { name: "Sam", is_user: true, send_date: "2026-06-27T08:03:00.000Z", mes: "still tired" },
  { name: "System", is_user: false, is_system: true, send_date: "June 27, 2026 8:04am", mes: "[a hidden note]" },
  { name: "Kitsikai", is_user: false, send_date: new Date(2026, 5, 27, 8, 5).getTime(), mes: "<think>hmm</think>coffee first" },
  { name: "Kitsikai", is_user: false, send_date: "June 27, 2026 8:06am", mes: "   " },
]
  .map((line) => JSON.stringify(line))
  .concat(["this line isn't json"])
  .join("\n");

// ----------------------------------------------------------------- reading

describe("reading an export", () => {
  test("SillyTavern's .jsonl: the header, who's who, bubbles, and what's left out", async () => {
    const chat = parseChat(SILLYTAVERN, NOW);
    expect(chat.format).toBe("sillytavern");
    expect(chat.messages.map((m) => [m.author, m.bubbles])).toEqual([
      ["user", ["hey you"]],
      ["kitsikai", ["hiii", "how was work"]],
      ["user", ["PINEAPPLE morning"]],
      ["user", ["still tired"]],
      ["kitsikai", ["coffee first"]],
    ]);
    expect(chat.messages[0]!.createdAt).toBe(new Date(2026, 5, 26, 21, 14).toISOString());
    expect(chat.messages[2]!.createdAt).toBe(new Date(2026, 5, 27, 8, 2, 11, 120).toISOString());
    expect(chat.messages[3]!.createdAt).toBe("2026-06-27T08:03:00.000Z");
    expect(chat.messages[4]!.createdAt).toBe(new Date(2026, 5, 27, 8, 5).toISOString());
    expect(chat.names).toEqual({ you: ["Sam"], her: ["Kitsikai"] });
    expect(chat.skipped).toEqual({ system: 1, empty: 1, unreadable: 1 });
  });

  test("the dates chat exports use", async () => {
    expect(parseDate("June 26, 2026 9:14pm")).toEqual(new Date(2026, 5, 26, 21, 14));
    expect(parseDate("Jun 26, 2026, 12:05 AM")).toEqual(new Date(2026, 5, 26, 0, 5));
    expect(parseDate("September 3, 2026 at 12:30 pm")).toEqual(new Date(2026, 8, 3, 12, 30));
    expect(parseDate("2026-6-27 @8h 2m")).toEqual(new Date(2026, 5, 27, 8, 2));
    expect(parseDate("2026-06-27T08:03:00Z")).toEqual(new Date("2026-06-27T08:03:00Z"));
    expect(parseDate(1782548700)).toEqual(new Date(1782548700 * 1000));
    expect(parseDate("1782548700000")).toEqual(new Date(1782548700000));
    for (const nothing of ["", "someday", null, undefined, {}]) expect(parseDate(nothing)).toBeNull();
  });

  test("a JSON list with role and content, and undated messages", async () => {
    const chat = parseChat(
      JSON.stringify([
        { role: "user", content: "hi", timestamp: new Date(2026, 6, 1, 10, 0).getTime() },
        { role: "assistant", content: [{ type: "text", text: "hey" }] },
        { role: "system", content: "rules" },
      ]),
      NOW,
    );
    expect(chat.format).toBe("json");
    expect(chat.messages.map((m) => [m.author, m.bubbles[0], m.createdAt])).toEqual([
      ["user", "hi", new Date(2026, 6, 1, 10, 0).toISOString()],
      ["kitsikai", "hey", new Date(2026, 6, 1, 10, 0).toISOString()],
    ]);
    expect(chat.undated).toBe(1);
    expect(chat.skipped.system).toBe(1);
    expect(parseChat(JSON.stringify({ messages: [{ role: "user", content: "yo" }] }), NOW).messages).toHaveLength(1);
  });

  test("names from the header, when messages don't say who's the user", async () => {
    const text = [{ user_name: "Sam", character_name: "Kit" }, { name: "Sam", mes: "hi" }, { name: "Kit", mes: "hey" }].map((l) => JSON.stringify(l)).join("\n");
    expect(parseChat(text, NOW).messages.map((m) => m.author)).toEqual(["user", "kitsikai"]);
  });

  test("no dates at all: a second apart, ending now; future dates become now", async () => {
    const undated = parseChat(JSON.stringify([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]), NOW);
    expect(undated.messages.map((m) => m.createdAt)).toEqual([new Date(NOW.getTime() - 2000).toISOString(), new Date(NOW.getTime() - 1000).toISOString()]);
    const future = parseChat(JSON.stringify([{ role: "user", content: "a", date: "2030-01-01T00:00:00Z" }]), NOW);
    expect(future.messages[0]!.createdAt).toBe(NOW.toISOString());
  });

  test("a file it can't read describes its layout, never its text", async () => {
    const error = (() => {
      try {
        parseChat(JSON.stringify([{ sender: "me", body: "SECRET words", at: 5, tags: ["x"] }]), NOW);
      } catch (e) {
        return e as ImportError;
      }
    })()!;
    expect(error).toBeInstanceOf(ImportError);
    expect(error.layout).toBe("record 1: { sender: text, body: text, at: number, tags: list }");
    expect(`${error.message} ${error.layout}`).not.toContain("SECRET");
    expect(() => parseChat("", NOW)).toThrow("The file is empty.");
    expect(() => parseChat("hello\nthere", NOW)).toThrow("none of it is JSON");
    expect(describeLayout(["text", [1], null])).toBe("record 1: text\nrecord 2: list\nrecord 3: empty");
  });

  test("the preview has counts, names and dates: no text", async () => {
    const preview = previewOf(parseChat(SILLYTAVERN, NOW));
    expect(preview).toEqual({
      format: "sillytavern",
      total: 5,
      you: { messages: 3, names: ["Sam"] },
      her: { messages: 2, names: ["Kitsikai"] },
      from: new Date(2026, 5, 26, 21, 14).toISOString(),
      to: new Date(2026, 5, 27, 8, 5).toISOString(),
      undated: 0,
      skipped: { system: 1, empty: 1, unreadable: 1 },
    });
    expect(JSON.stringify(preview)).not.toMatch(/PINEAPPLE|hey you|coffee/);
  });
});

// --------------------------------------------------------------- the app

describe("importing into the app", () => {
  let fake: FakeNanoGpt;
  let dir: ReturnType<typeof tempDir>;
  let app: App;
  let call: ReturnType<typeof caller>;
  let general: Channel;
  let notified: number;
  let events: ServerEvent[];

  beforeEach(() => {
    fake = startFakeNanoGpt();
    dir = tempDir();
    notified = 0;
    app = createApp(testConfig(dir.path, fake.baseUrl), { now: () => NOW, notifier: { available: () => true, notify: () => notified++ } });
    call = caller(app.fetch);
    app.store.updateSettings({ replyDebounceSeconds: 0 });
    general = app.store.listChannels()[0]!;
    events = [];
    app.events.listen((e) => events.push(e));
  });

  afterEach(async () => {
    await app.replies.flush();
    await app.catchUp.settle();
    await app.proactive.settle();
    app.store.close();
    fake.stop();
    dir.cleanup();
  });

  test("the preview, over the API: no text", async () => {
    const { status, data } = await call("POST", "/api/import/preview", { text: SILLYTAVERN });
    expect(status).toBe(200);
    expect(data.preview.total).toBe(5);
    expect(JSON.stringify(data)).not.toMatch(/PINEAPPLE|hey you|coffee/);
  });

  test("a file it can't read: the error and its layout, over the API", async () => {
    const { status, data } = await call("POST", "/api/import/preview", { text: JSON.stringify([{ sender: "me", body: "SECRET" }]) });
    expect(status).toBe(400);
    expect(data.layout).toBe("record 1: { sender: text, body: text }");
    expect(JSON.stringify(data)).not.toContain("SECRET");
  });

  test("into a new channel: dates kept, bubbles and turns, and nothing treated as new", async () => {
    const { status, data } = await call("POST", "/api/import", { text: SILLYTAVERN, newChannel: "Lumiverse" });
    expect(status).toBe(200);
    expect(data).toMatchObject({ channel: { name: "lumiverse", kind: "text" }, imported: 6, catchUp: false });
    const messages = app.store.getMessages(data.channel.id);
    expect(messages.map((m) => [m.author, m.content])).toEqual([
      ["user", "hey you"],
      ["kitsikai", "hiii"],
      ["kitsikai", "how was work"],
      ["user", "PINEAPPLE morning"],
      ["user", "still tired"],
      ["kitsikai", "coffee first"],
    ]);
    expect(messages[0]!.createdAt).toBe(new Date(2026, 5, 26, 21, 14).toISOString());
    // Bubbles of one reply, and messages in a row from you, share a turn.
    expect(messages[1]!.turnId).toBe(messages[2]!.turnId!);
    expect(messages[3]!.turnId).toBe(messages[4]!.turnId!);
    expect(messages[0]!.turnId).not.toBe(messages[1]!.turnId!);

    // No "messages" event: no notifications, no reply, no reminder checks.
    expect(events.map((e) => e.type)).toEqual(["channels"]);
    expect(notified).toBe(0);
    expect(fake.requests).toHaveLength(0);
    expect(fake.jevRequests).toHaveLength(0);

    // Jev's next check sees them as context, not as new.
    fake.replies.push({ content: "morning!" });
    await call("POST", `/api/channels/${data.channel.id}/messages`, { content: "back again" });
    await app.replies.flush();
    const state = fake.jevRequests[0]!.state;
    expect(state).toContain("them: still tired");
    expect(state).not.toContain("(NEW): still tired");
    expect(state).toContain("them (NEW): back again");
    // Her reply sees the imported history, with a time note for the gap.
    expect(fake.requests[0]!.messages.at(-1)!.content).toMatch(/^\[Sat 6:00 PM, \d+ days later\] back again$/);
  });

  test("into an empty channel, but never one with messages", async () => {
    expect((await call("GET", "/api/import/targets")).data.channels.map((c: Channel) => c.name)).toEqual(["general"]);
    expect((await call("POST", "/api/import", { text: SILLYTAVERN, channelId: general.id })).data.imported).toBe(6);
    expect((await call("GET", "/api/import/targets")).data.channels).toEqual([]);
    const again = await call("POST", "/api/import", { text: SILLYTAVERN, channelId: general.id });
    expect(again.status).toBe(400);
    expect(again.data.error).toBe("#general already has messages. Import into a new channel, or an empty one.");
    const planner = app.store.listChannels().find((c) => c.kind === "planner")!;
    expect((await call("POST", "/api/import", { text: SILLYTAVERN, channelId: planner.id })).status).toBe(400);
    expect((await call("POST", "/api/import", { text: SILLYTAVERN })).status).toBe(400);
    expect((await call("POST", "/api/import", { text: 5, newChannel: "x" })).status).toBe(400);
  });

  test("search_history finds older messages, in every channel", async () => {
    const { data } = await call("POST", "/api/import", { text: SILLYTAVERN, newChannel: "lumiverse" });
    const ctx = { store: app.store, channel: general, now: NOW };
    expect(await runTool(ctx, "search_history", { query: "pineapple" })).toMatchObject({
      ok: true,
      result: [{ when: "Sat, Jun 27 2026, 8:02 AM", channel: "#lumiverse", from: "them", text: "PINEAPPLE morning" }],
      summary: 'searched the history for "pineapple"',
    });
    // Every word has to be there.
    expect((await runTool(ctx, "search_history", { query: "tired still" })).result).toHaveLength(1);
    expect((await runTool(ctx, "search_history", { query: "tired pineapple" })).result).toEqual({ note: 'Nothing older mentions "tired pineapple".' });
    // % and _ are just characters.
    expect((await runTool(ctx, "search_history", { query: "%" })).result).toEqual({ note: 'Nothing older mentions "%".' });
    expect((await runTool(ctx, "search_history", { query: "tired", channel: "#general" })).result).toEqual({ note: 'Nothing older mentions "tired".' });
    // What's already in view in her own channel isn't found again.
    const inChannel = { store: app.store, channel: data.channel as Channel, now: NOW };
    expect((await runTool(inChannel, "search_history", { query: "tired" })).result).toEqual({ note: 'Nothing older mentions "tired".' });
    app.store.updateSettings({ historyLimit: 1 });
    expect((await runTool(inChannel, "search_history", { query: "tired" })).result).toHaveLength(1);
    expect((await runTool(ctx, "search_history", {})).ok).toBe(false);
  });

  test("catching up: the notes model reads it back, and what's worth knowing goes on her scratchpad", async () => {
    fake.replies.push({ content: '{"notes": ["they work nights at the warehouse", "they\'ve been tired a lot lately"]}' });
    const { data } = await call("POST", "/api/import", { text: SILLYTAVERN, newChannel: "lumiverse", catchUp: true });
    expect(data.catchUp).toBe(true);
    await app.catchUp.settle();

    const request = fake.requests[0]!;
    expect(request.messages[0]!.content).toContain("She's reading back through an old chat");
    expect(request.messages[1]!.content).toContain("What you've noted so far:\n(nothing yet)");
    expect(request.messages[1]!.content).toContain("[Jun 26, 2026, 9:14 PM] them: hey you\n[Jun 26, 2026, 9:15 PM] Kitsikai: hiii");
    expect(request.messages[1]!.content).toContain("At most 10 notes.");
    expect(app.store.memory.notes()).toEqual([
      expect.objectContaining({ kind: "remember", status: "open", text: "they work nights at the warehouse", channelId: data.channel.id }),
      expect.objectContaining({ text: "they've been tired a lot lately" }),
    ]);
    expect(app.store.memory.recentLog()[0]!.reason).toBe("from catching up on the imported chat (since 2026-06-26)");
    expect(app.catchUp.status()).toMatchObject({ running: false, partsDone: 1, parts: 1 });
    expect((await call("GET", "/api/memory")).data.catchUp).toMatchObject({ running: false, parts: 1 });
  });

  test("a long chat is read in parts, and the list is kept up to date as it goes", async () => {
    // About 15,000 characters: two parts.
    const lines = Array.from({ length: 120 }, (_, i) => JSON.stringify({ role: i % 2 ? "assistant" : "user", content: `message ${i} ${"x".repeat(90)}` }));
    fake.replies.push({ content: '{"notes": ["an early thing"]}' }, { content: '{"notes": ["an early thing", "a later thing"]}' });
    await call("POST", "/api/import", { text: lines.join("\n"), newChannel: "long", catchUp: true });
    await app.catchUp.settle();
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.messages[1]!.content).toContain("What you've noted so far:\n- an early thing");
    expect(app.store.memory.notes().map((n) => n.text)).toEqual(["an early thing", "a later thing"]);
  });

  test("parts never split a message", async () => {
    expect(partsOf(["aaaa", "bbbb", "cc", "dddddddd"], 9)).toEqual(["aaaa\nbbbb", "cc", "dddddddd"]);
  });

  test("if the notes model fails, nothing is noted, and the log says why without quoting the chat", async () => {
    fake.replies.push({ status: 500, error: "boom" });
    await call("POST", "/api/import", { text: SILLYTAVERN, newChannel: "lumiverse", catchUp: true });
    await app.catchUp.settle();
    expect(app.store.memory.notes()).toHaveLength(0);
    const [entry] = app.store.memory.recentLog();
    expect(entry).toMatchObject({ action: "error", text: "Catching up on the imported chat stopped" });
    expect(JSON.stringify(entry)).not.toMatch(/PINEAPPLE|hey you/);
  });

  test("one catch-up at a time", async () => {
    fake.replies.push({ content: '{"notes": []}', delayMs: 300 });
    await call("POST", "/api/import", { text: SILLYTAVERN, newChannel: "one", catchUp: true });
    const second = await call("POST", "/api/import", { text: SILLYTAVERN, newChannel: "two", catchUp: true });
    expect(second.status).toBe(409);
    expect(app.store.listChannels().map((c) => c.name)).not.toContain("two");
  });
});
