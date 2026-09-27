/**
 * Tests for intimacy routing (src/intimacy.ts): Jev picking a register
 * before her turns, the safeword and its hold (src/hold.ts), bringing her
 * back, texting first during a hold, and notifications without a preview.
 *
 * The fake Jev answers routing questions from `fake.routeReplies`; left
 * alone, it says "warm" and "no" (she isn't brought back), 95% sure. The
 * chat is placeholders ("[message]"): what's tested is where things go,
 * not what anyone says.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ServerEvent } from "../src/events.ts";
import { isSafeword, registerPrompt, safewordIn, type Register } from "../src/intimacy.ts";
import type { Notification } from "../src/notify.ts";
import { createApp, type App } from "../src/server.ts";
import type { Channel, Message } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

setDefaultTimeout(15_000);

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let call: ReturnType<typeof caller>;
let general: Channel;
let notifications: Notification[];
let events: ServerEvent[];
/** The app's clock: Saturday, September 26, 2026, 9 PM, until a test moves it. */
let time: Date;

function start() {
  app = createApp(testConfig(dir.path, fake.baseUrl), {
    now: () => time,
    notifier: { available: () => true, notify: (n) => notifications.push(n) },
  });
  call = caller(app.fetch);
  general = app.store.listChannels()[0]!;
  events = [];
  app.events.listen((e) => events.push(e));
}

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  time = new Date(2026, 8, 26, 21, 0);
  notifications = [];
  start();
  app.store.updateSettings({ replyDebounceSeconds: 0 });
});

afterEach(async () => {
  await app.replies.flush();
  await app.proactive.settle();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

const later = (minutes: number) => {
  time = new Date(time.getTime() + minutes * 60_000);
};

/** Send a bubble and wait for her reply. */
async function send(content: string, channelId = general.id) {
  await call("POST", `/api/channels/${channelId}/messages`, { content });
  await app.replies.flush();
}

/** The system prompt of the last chat request. */
const lastSystem = () => fake.requests.at(-1)!.messages[0]!.content;
const layer = (register: Register) => `## Between you right now\n\n${registerPrompt(register)}`;
const hold = () => app.store.intimacy.get();
const holdEvents = () => events.filter((e) => e.type === "hold");

function message(author: Message["author"], content: string): Message {
  return { id: crypto.randomUUID(), channelId: "c1", author, content, turnId: null, createdAt: new Date().toISOString() };
}

// ------------------------------------------------------------ the safeword

describe("the safeword", () => {
  test("a short message with it counts, whatever else it says", () => {
    for (const text of ["seriously", "Seriously.", "no, seriously", "ok seriously", "SERIOUSLY?", "seriously, not right now"]) {
      expect(isSafeword(text)).toBe(true);
    }
  });

  test("a longer one counts with a boundary word in it, curly apostrophes too", () => {
    expect(isSafeword("i seriously need to stop for a minute, give me some room okay")).toBe(true);
    expect(isSafeword("i seriously can’t right now, this is a lot and i mean it")).toBe(true);
    expect(isSafeword("hey so i'm seriously not okay with this, let's pause here please")).toBe(true);
  });

  test("an easy-going longer message, or no safeword at all, doesn't", () => {
    expect(isSafeword("that was seriously the best pizza i have had in years honestly")).toBe(false);
    expect(isSafeword("stop")).toBe(false);
    expect(isSafeword("are you serious")).toBe(false);
    expect(isSafeword("")).toBe(false);
  });

  test("every bubble since her last reply counts; earlier ones, and hers, don't", () => {
    const said = message("user", "seriously");
    expect(safewordIn([message("kitsikai", "[message]"), said, message("user", "[message]")])).toBe(said);
    expect(safewordIn([message("user", "seriously"), message("kitsikai", "[message]"), message("user", "[message]")])).toBeNull();
    expect(safewordIn([message("user", "[message]"), message("kitsikai", "seriously")])).toBeNull();
  });
});

// ----------------------------------------------------------- registers

describe("registers", () => {
  test("Jev picks one before her turn, from the recent chat", async () => {
    await send("[message]");
    expect(fake.routeRequests).toHaveLength(1);
    const [question] = fake.routeRequests[0]!.questions;
    expect(question!.id).toBe("register");
    expect(question!.options).toEqual(["soft", "hard", "capture", "leverage", "contract", "warm"]);
    expect(fake.routeRequests[0]!.state).toContain("Recent chat between them and Kitsikai, oldest first:\n[Sat 9:00 PM] them: [message]");
    // "warm" (the default here) adds nothing: the persona alone.
    expect(lastSystem()).not.toContain("## Between you right now");
  });

  test("a confident pick goes into her prompt, after her notes and before the tools", async () => {
    app.store.profiles.update(app.store.profiles.list()[0]!.id, { supportsTools: true });
    fake.routeReplies.push({ register: "contract" });
    await send("[message]");
    const system = lastSystem();
    expect(system).toContain(layer("contract"));
    expect(system.indexOf("## Between you right now")).toBeLessThan(system.indexOf("## Tools"));
  });

  test("every register Jev can pick has a prompt; warm has none", () => {
    for (const register of ["soft", "hard", "capture", "leverage", "contract", "safe"] as const) expect(registerPrompt(register)).not.toBe("");
    expect(registerPrompt("warm")).toBe("");
  });

  test("unsure, or Jev failing: warm, and she still replies", async () => {
    fake.routeReplies.push({ register: { selected: "soft", p: 0.5 } }, { status: 503, error: "Model unavailable" });
    await send("[message]");
    expect(lastSystem()).not.toContain("## Between you right now");
    await send("[message]");
    expect(lastSystem()).not.toContain("## Between you right now");
    expect(fake.requests).toHaveLength(2);
  });

  test("turned off: Jev isn't asked, and it's the persona alone", async () => {
    app.store.updateSettings({ intimacyEnabled: false });
    await send("[message]");
    expect(fake.routeRequests).toHaveLength(0);
    expect(lastSystem()).not.toContain("## Between you right now");
  });

  test("an empty channel: nothing to read, so Jev isn't asked", async () => {
    await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(fake.routeRequests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- the hold

describe("the hold", () => {
  test("the safeword starts it at once, without asking Jev, and she's safe", async () => {
    await send("[message]");
    await send("no, seriously");
    expect(fake.routeRequests).toHaveLength(1); // only the first turn's
    expect(lastSystem()).toContain(layer("safe"));
    expect(hold()).toMatchObject({ since: time.toISOString() });
    expect(app.store.getMessage(hold()!.messageId!).content).toBe("no, seriously");
    expect(holdEvents()).toEqual([{ type: "hold", hold: hold() }]);
    expect((await call("GET", "/api/state")).data.intimacyHold).toEqual(hold());
  });

  test("it works with routing off, or Jev down", async () => {
    app.store.updateSettings({ intimacyEnabled: false, decisionModel: "" });
    await send("seriously");
    expect(hold()).not.toBeNull();
    expect(lastSystem()).toContain(layer("safe"));
  });

  test("it lasts: later turns, other channels, and a restart", async () => {
    await send("seriously");
    const since = hold()!.since;
    later(30);
    await send("[message]");
    expect(lastSystem()).toContain(layer("safe"));
    // Asked whether that brings her back: no (the default), so she holds.
    expect(fake.routeRequests.at(-1)!.questions.map((q) => q.id)).toEqual(["back"]);
    expect(fake.routeRequests.at(-1)!.state).toContain("What's been said since, oldest first:");

    const other = (await call("POST", "/api/channels", { name: "other" })).data.channel as Channel;
    await send("[message]", other.id);
    expect(lastSystem()).toContain(layer("safe"));

    // Saying it again keeps the time it started.
    later(5);
    await send("seriously");
    expect(hold()!.since).toBe(since);

    await app.replies.flush();
    app.store.close();
    start();
    expect(hold()!.since).toBe(since);
  });

  test("she comes back when Jev is sure you're bringing her back", async () => {
    await send("seriously");
    later(20);
    fake.routeReplies.push({ back: "yes" });
    await send("[message]");
    expect(hold()).toBeNull();
    // That turn is warm; the one after is routed again.
    expect(lastSystem()).not.toContain("## Between you right now");
    expect(holdEvents().at(-1)).toEqual({ type: "hold", hold: null });
    await send("[message]");
    expect(fake.routeRequests.at(-1)!.questions[0]!.id).toBe("register");
  });

  test("only if it's at least 90% sure, or unsure Jev keeps the hold", async () => {
    app.store.updateSettings({ decisionConfidence: 0.8 });
    await send("seriously");
    fake.routeReplies.push({ back: { selected: "yes", p: 0.85 } }, { status: 503, error: "down" });
    await send("[message]");
    expect(hold()).not.toBeNull();
    await send("[message]");
    expect(hold()).not.toBeNull();
    expect(lastSystem()).toContain(layer("safe"));
  });

  test("with nothing said since the safeword, Jev isn't asked", async () => {
    await send("seriously");
    await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(fake.routeRequests).toHaveLength(0);
    expect(lastSystem()).toContain(layer("safe"));
  });

  test('"Bring her back" ends it by hand', async () => {
    await send("seriously");
    const { status, data } = await call("POST", "/api/intimacy/lift", {});
    expect(status).toBe(200);
    expect(data.intimacyHold).toBeNull();
    expect(hold()).toBeNull();
    expect(holdEvents().at(-1)).toEqual({ type: "hold", hold: null });
    // Nothing to end: nothing to announce.
    const before = holdEvents().length;
    await call("POST", "/api/intimacy/lift", {});
    expect(holdEvents()).toHaveLength(before);
  });

  test("the prompt preview shows it", async () => {
    const preview = async () => (await call("GET", `/api/channels/${general.id}/prompt`)).data.messages[0].content as string;
    expect(await preview()).not.toContain("## Between you right now");
    await send("seriously");
    expect(await preview()).toContain(layer("safe"));
  });
});

// ------------------------------------------------------- texting first

describe("texting first during a hold", () => {
  test("nothing but reminders", async () => {
    await send("seriously");
    later(4 * 60); // quiet long enough for a "just because" text
    const asked = fake.jevRequests.length;
    const result = await app.proactive.check("manual");
    expect(result).toMatchObject({ outcome: "nothing", detail: "Holding after the safeword: only reminders, until they bring her back." });
    expect(fake.jevRequests).toHaveLength(asked);
  });

  test("a reminder still goes out, plain", async () => {
    await send("seriously");
    later(60);
    // Dentist tomorrow at 3 PM: its "day before" reminder went off at 6 PM.
    app.store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-09-27", startTime: "15:00" });
    const result = await app.proactive.check("manual");
    expect(result).toMatchObject({ outcome: "sent", reason: "reminder" });
    expect(lastSystem()).toContain(layer("safe"));
  });
});

// ------------------------------------------------------- notifications

describe("notifications", () => {
  test("show what she said, unless the preview is off", async () => {
    await send("[message]");
    expect(notifications.at(-1)).toMatchObject({ text: "Reply 1" });
    app.store.updateSettings({ notificationPreview: false });
    await send("[message]");
    expect(notifications.at(-1)).toEqual({ title: "Kitsikai in #general", text: "New message", channelId: general.id });
  });
});
