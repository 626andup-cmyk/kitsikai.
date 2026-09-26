/**
 * Tests for stage 7: her memory. The scratchpad check during chat
 * (src/scratchpad.ts), processing (src/processing.ts), pins, the scheduler
 * (src/scheduler.ts), her notes in the prompt (src/memory.ts), her note
 * tools, and the API behind the advanced page.
 *
 * Jev is the fake one in test/helpers.ts: each test says what it answers.
 * Anything it isn't told, it answers with the question's last option
 * ("no", "neither", "not answered"), 95% sure.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { promptForChannel } from "../src/kitsikai.ts";
import type { NewNote } from "../src/memory.ts";
import { AlreadyProcessingError } from "../src/processing.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool } from "../src/tools.ts";
import type { ServerEvent } from "../src/events.ts";
import type { Channel, PlanDraft } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

setDefaultTimeout(15_000);

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let call: ReturnType<typeof caller>;
let general: Channel;
/** The app's clock: Saturday, September 26, 2026, 4 PM, until a test moves it. */
let time: Date;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  time = new Date(2026, 8, 26, 16, 0);
  app = createApp(testConfig(dir.path, fake.baseUrl), { now: () => time });
  call = caller(app.fetch);
  app.store.updateSettings({ replyDebounceSeconds: 0 });
  general = app.store.listChannels()[0]!;
});

afterEach(async () => {
  await app.replies.flush();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

/** Move the clock on. */
const later = (minutes: number) => {
  time = new Date(time.getTime() + minutes * 60_000);
};

/** Send a bubble, and wait for the check and her reply. */
async function send(content: string) {
  const { data } = await call("POST", `/api/channels/${general.id}/messages`, { content });
  await app.replies.flush();
  return data.userMessages[0] as { id: string };
}

const memory = () => app.store.memory;
const addNote = (input: Omit<NewNote, "origin"> & { origin?: NewNote["origin"] }) => memory().addNote({ origin: "noticed", channelId: general.id, ...input }, time);
const addPin = (text: string, extra: Partial<Parameters<ReturnType<typeof memory>["addPin"]>[0]> = {}) =>
  memory().addPin({ text, reason: "", unpinWhen: "", unpinDate: null, yours: false, noteId: null, ...extra }, time);

const DENTIST: PlanDraft = {
  kind: "appointment",
  title: "Dentist",
  startDate: "2026-10-01",
  startTime: "15:00",
  endDate: null,
  endTime: null,
  shiftType: null,
  notes: "",
};

/** Every event the app is told about, from now on. */
function listen(): ServerEvent[] {
  const seen: ServerEvent[] = [];
  app.events.listen((e) => seen.push(e));
  return seen;
}

// ---------------------------------------------------------------- check

describe("the scratchpad check", () => {
  test("Jev reads your new messages with the trackers as clues, and a hit becomes a note she can see", async () => {
    const headache = app.store.trackers.create({ name: "headache", kind: "scale", hintWords: ["head", "migraine"] });
    fake.jevReplies.push({ t1: "yes", "t1.day": "today", "t1.level": "7" });
    const message = await send("ugh my head is killing me");

    const request = fake.jevRequests[0]!;
    expect(request.model).toBe("typesafe/jev-1.13");
    expect(request.state).toContain("Today is Saturday, September 26, 2026, 4:00 PM.");
    expect(request.state).toContain("them (NEW): ugh my head is killing me");
    expect(request.state).toContain("- headache: how much, 1 to 10 (clue words: head, migraine)");
    expect(request.questions.map((q) => q.id)).toEqual(["t1", "t1.day", "t1.level", "plan", "remember", "request", "soon"]);
    expect(request.questions[0]!.question).toContain('"no headache today" doesn\'t count');

    expect(memory().notes()).toEqual([
      expect.objectContaining({
        kind: "tracker",
        text: "headache 7/10 on Sat, Sep 26",
        status: "open",
        origin: "noticed",
        trackerId: headache.id,
        value: "7",
        date: "2026-09-26",
        messageId: message.id,
      }),
    ]);
    expect(memory().recentLog()[0]).toMatchObject({ runId: null, action: "noted", reason: "they said so (95% sure)", messageId: message.id });
    // She replied after the check, with the note in view. Nothing is logged yet: it's pencil.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.messages[0]!.content).toContain("On your scratchpad (pencil, not processed yet):\n- headache 7/10 on Sat, Sep 26");
    expect(app.store.trackers.entries()).toHaveLength(0);
  });

  test("nothing confident, nothing noted: saying the word isn't the same as it happening", async () => {
    app.store.trackers.create({ name: "headache", kind: "scale" });
    fake.jevReplies.push({ t1: { selected: "yes", p: 0.6 }, plan: { selected: "yes", p: 0.7 } });
    await send("no headache today, finally");
    expect(memory().notes()).toHaveLength(0);
    expect(fake.requests).toHaveLength(1); // only her reply: the writer wasn't needed
  });

  test("yes/no trackers, and yesterday", async () => {
    app.store.trackers.create({ name: "took meds", kind: "yesno" });
    fake.jevReplies.push({ t1: "yes", "t1.day": "yesterday" });
    await send("I did take my meds last night btw");
    expect(memory().notes()[0]).toMatchObject({ text: "took meds on Fri, Sep 25", value: "yes", date: "2026-09-25" });
  });

  test("note trackers get their value from the processing writer", async () => {
    app.store.trackers.create({ name: "payday", kind: "note" });
    fake.jevReplies.push({ t1: "yes", "t1.day": "today" });
    fake.replies.push({ content: '{"w1": {"text": "got paid", "value": "$1,240"}}' }, { content: "yay" });
    await send("PAYDAY. $1240 baby");
    expect(fake.requests[0]!.messages[1]!.content).toContain('what to log for their "payday" tracker');
    expect(memory().notes()[0]).toMatchObject({ text: "payday: $1,240 on Sat, Sep 26", value: "$1,240" });
  });

  test("each of your messages is checked once", async () => {
    await send("hey");
    await send("so guess what");
    expect(fake.jevRequests).toHaveLength(2);
    expect(fake.jevRequests[1]!.state).toContain("them: hey");
    expect(fake.jevRequests[1]!.state).not.toContain("(NEW): hey");
    expect(fake.jevRequests[1]!.state).toContain("them (NEW): so guess what");
    expect(fake.jevRequests[1]!.state).toContain("Kitsikai: Reply 1");
  });

  test("a new value rewrites the note for that tracker and day, instead of adding another", async () => {
    app.store.trackers.create({ name: "headache", kind: "scale" });
    fake.jevReplies.push({ t1: "yes", "t1.day": "today", "t1.level": "6" }, { t1: "yes", "t1.day": "today", "t1.level": "9", n1: "changed it" });
    await send("headache again");
    await send("ok it's more like a 9 now");
    expect(fake.jevRequests[1]!.state).toContain("Kitsikai's notes, not processed yet:\n- n1: headache 6/10 on Sat, Sep 26");
    expect(memory().notes()).toEqual([expect.objectContaining({ value: "9", text: "headache 9/10 on Sat, Sep 26" })]);
    expect(memory().recentLog()[0]).toMatchObject({ action: "rewritten", reason: 'was "headache 6/10 on Sat, Sep 26"; they said so (95% sure)' });
  });

  test("a plan they mention becomes a note with a plan card, written by the processing writer", async () => {
    fake.jevReplies.push({ plan: "yes" });
    fake.replies.push(
      { content: '{"w1": {"text": "dentist on thursday at 3", "plan": {"kind": "appointment", "title": "Dentist", "date": "10/1", "time": "3pm"}}}' },
      { content: "ugh dentists" },
    );
    await send("dentist thursday at 3, kill me");

    const writer = fake.requests[0]!;
    expect(writer.messages[0]!.content).toContain("You write short notes for Kitsikai");
    expect(writer.messages[1]!.content).toContain("Today is Saturday, September 26, 2026, 4:00 PM.");
    expect(writer.messages[1]!.content).toContain('- "w1": a plan they mentioned.');
    expect(memory().notes()[0]).toMatchObject({ kind: "plan", text: "dentist on thursday at 3", timeSensitive: false, planDraft: DENTIST });
    // Nothing from chat becomes a plan until they say yes.
    expect(app.store.plans.list()).toHaveLength(0);
  });

  test("something happening in the next few hours is time-sensitive", async () => {
    fake.jevReplies.push({ remember: "yes", soon: "yes" });
    fake.replies.push({ content: '{"w1": {"text": "exam in an hour, they\'re nervous"}}' }, { content: "you got this" });
    await send("exam in an hour, I'm freaking out");
    expect(memory().notes()[0]).toMatchObject({ kind: "remember", text: "exam in an hour, they're nervous", timeSensitive: true });
    expect(memory().recentLog()[0]!.reason).toBe("worth remembering (95% sure), and it's soon");
  });

  test("if the writer fails, the note keeps a quote of your message", async () => {
    fake.jevReplies.push({ remember: "yes" });
    fake.replies.push({ status: 500, error: "boom" }, { content: "oh no" });
    await send("my manager yelled at me today");
    expect(memory().notes()[0]!.text).toBe('worth remembering: "my manager yelled at me today"');
    expect(memory().recentLog().map((e) => e.action)).toEqual(["noted", "error"]);
    expect(fake.requests.at(-1)!.messages.at(-1)!.content).toBe("my manager yelled at me today");
  });

  test("asking her to pin something becomes a note marked as yours", async () => {
    fake.jevReplies.push({ request: "pin" });
    fake.replies.push({ content: '{"w1": {"text": "pin: mom\'s surgery on tuesday"}}' }, { content: "pinned 📌" });
    await send("can you pin mom's surgery on tuesday");
    expect(memory().notes()[0]).toMatchObject({ kind: "request", request: "pin", yours: true, timeSensitive: false });
  });

  test("taking something back tosses its note", async () => {
    const note = addNote({ kind: "remember", text: "they're quitting their job" });
    fake.jevReplies.push({ n1: "took it back" });
    await send("jk I'm not quitting lol");
    expect(memory().getNote(note.id).status).toBe("tossed");
    expect(memory().recentLog()[0]).toMatchObject({ action: "tossed", reason: "they took it back (95% sure)" });
  });

  test("changing a plan rewrites its note and card instead of adding another", async () => {
    const note = addNote({ kind: "plan", text: "dentist on thursday at 3", planDraft: DENTIST });
    fake.jevReplies.push({ n1: "changed it", plan: "yes" });
    fake.replies.push(
      { content: '{"w1": {"text": "dentist on friday at 3", "plan": {"kind": "appointment", "title": "Dentist", "date": "2026-10-02", "time": "15:00"}}}' },
      { content: "got it" },
    );
    await send("wait no, the dentist is friday");
    expect(fake.requests[0]!.messages[1]!.content).toContain('They\'ve changed it since you wrote "dentist on thursday at 3"');
    expect(memory().notes()).toEqual([expect.objectContaining({ id: note.id, text: "dentist on friday at 3", planDraft: { ...DENTIST, startDate: "2026-10-02" } })]);
  });

  test("your yes to her question puts the plan in the planner, right away", async () => {
    const note = addNote({ kind: "plan", text: "dentist on thursday at 3", planDraft: DENTIST });
    memory().updateNote(note.id, { status: "asking", ask: 'whether they want "Dentist on Thu, Oct 1 at 3:00p" put in the planner' }, time);
    fake.jevReplies.push({ a1: "yes" });
    const events = listen();
    const answer = await send("yes please!");

    expect(fake.jevRequests[0]!.state).toContain('What Kitsikai asked them about:\n- a1: whether they want "Dentist on Thu, Oct 1 at 3:00p" put in the planner');
    expect(app.store.plans.list()).toEqual([expect.objectContaining({ title: "Dentist", startDate: "2026-10-01", startTime: "15:00", checked: true, source: "chat" })]);
    expect(memory().getNote(note.id)).toMatchObject({ status: "done", confirmed: true });
    expect(memory().recentLog()[0]).toMatchObject({ action: "confirmed", text: "Dentist on Thu, Oct 1 at 3:00p", reason: "they said yes (95% sure), so it's in the planner", messageId: answer.id });
    expect(events.map((e) => e.type)).toContain("plans");
    // Her reply already sees it in today-and-tomorrow's planner, not as a question.
    expect(fake.requests[0]!.messages[0]!.content).not.toContain("Things to ask them about");
  });

  test("your yes to a tracker question logs it as confirmed; a no tosses it", async () => {
    const tracker = app.store.trackers.create({ name: "headache", kind: "scale" });
    const yes = addNote({ kind: "tracker", text: "headache 6/10 on Sat, Sep 26", trackerId: tracker.id, value: "6", date: "2026-09-26" });
    const no = addNote({ kind: "remember", text: "they're thinking of moving" });
    for (const note of [yes, no]) memory().updateNote(note.id, { status: "asking", ask: `whether this is right: ${note.text}` }, time);
    fake.jevReplies.push({ a1: "yes", a2: "no" });
    await send("yeah the headache was real. and nah not moving");
    expect(app.store.trackers.entries()).toEqual([expect.objectContaining({ value: "6", source: "confirmed" })]);
    expect(memory().getNote(yes.id).status).toBe("done");
    expect(memory().getNote(no.id).status).toBe("tossed");
    expect(memory().recentLog().map((e) => e.action)).toEqual(["declined", "confirmed"]);
  });

  test("a yes to anything else marks it confirmed, for processing to keep", async () => {
    const note = addNote({ kind: "remember", text: "they're stressed about the new manager" });
    memory().updateNote(note.id, { status: "asking", ask: "whether this is still the case" }, time);
    fake.jevReplies.push({ a1: "yes" });
    await send("yeah still stressed");
    expect(memory().getNote(note.id)).toMatchObject({ status: "open", confirmed: true, ask: null });
  });

  test("an unanswered question stays asked", async () => {
    const note = addNote({ kind: "remember", text: "they're thinking of moving" });
    memory().updateNote(note.id, { status: "asking", ask: "whether they're still thinking of moving" }, time);
    await send("anyway what are you up to");
    expect(memory().getNote(note.id).status).toBe("asking");
  });

  test("if Jev can't be reached, she still replies, and those messages are skipped", async () => {
    fake.jevReplies.push({ status: 503, error: "Model unavailable" });
    await send("hi");
    expect(fake.requests).toHaveLength(1);
    expect(app.scratchpad.lastError).toContain("HTTP 503");
    await send("again");
    expect(fake.jevRequests[1]!.state).not.toContain("(NEW): hi");
    expect(app.scratchpad.lastError).toBeNull();
  });

  test("with Jev turned off (and no fallback), there's no check at all", async () => {
    app.store.updateSettings({ decisionModel: "" });
    await send("hi");
    expect(fake.jevRequests).toHaveLength(0);
    expect(fake.requests).toHaveLength(1);
  });

  test("the first check in a channel with history only reads your messages since her last reply", async () => {
    for (const content of ["old news", "older plans"]) app.store.addMessage({ channelId: general.id, author: "user", content });
    app.store.addMessage({ channelId: general.id, author: "kitsikai", content: "mhm" });
    await send("new thing");
    expect(fake.jevRequests[0]!.state).toContain("them: old news");
    expect(fake.jevRequests[0]!.state).not.toContain("(NEW): old news");
    expect(fake.jevRequests[0]!.state).toContain("them (NEW): new thing");
  });

  test("a check in progress stops when you send another bubble, and reads it again next time", async () => {
    app.store.addMessage({ channelId: general.id, author: "user", content: "hello?" });
    const check = app.scratchpad.check(general.id);
    app.scratchpad.cancel(general.id);
    expect((await check).skipped).toBe("stopped");
    expect(memory().mark(general.id)).toBe(0);
  });
});

// ----------------------------------------------------------- processing

describe("processing", () => {
  const process = () => app.processing.run("manual");

  test("a tracker note that's still true goes in the log, linked to its message", async () => {
    const tracker = app.store.trackers.create({ name: "headache", kind: "scale" });
    const message = app.store.addMessage({ channelId: general.id, author: "user", content: "head hurts, like a 7", createdAt: time.toISOString() });
    const note = addNote({ kind: "tracker", text: "headache 7/10 on Sat, Sep 26", trackerId: tracker.id, value: "7", date: "2026-09-26", messageId: message.id });
    later(60);
    fake.jevReplies.push({ n1: "yes" });
    const { run, log } = await process();

    const request = fake.jevRequests[0]!;
    expect(request.questions.map((q) => q.id)).toEqual(["n1"]);
    expect(request.questions[0]!.question).toContain("Is note n1 still true, given the chat since Kitsikai wrote it?");
    expect(request.state).toContain("Today is Saturday, September 26, 2026, 5:00 PM.");
    expect(request.state).toContain("#general:\n[Sat 4:00 PM] them: head hurts, like a 7");
    expect(request.state).toContain("- n1 (written Sat 4:00 PM in #general): headache 7/10 on Sat, Sep 26");

    expect(app.store.trackers.entries()).toEqual([expect.objectContaining({ value: "7", date: "2026-09-26", source: "processing", messageId: message.id })]);
    expect(memory().getNote(note.id).status).toBe("done");
    expect(log).toEqual([expect.objectContaining({ runId: run.id, action: "committed", reason: "still true, 95% sure: in the log", messageId: message.id })]);
    expect(run).toMatchObject({ trigger: "manual", error: null });
    expect(run.finishedAt).not.toBeNull();
  });

  test("wrong or taken back: tossed. Unsure: she asks", async () => {
    const tracker = app.store.trackers.create({ name: "headache", kind: "scale" });
    const wrong = addNote({ kind: "tracker", text: "headache 3/10 on Sat, Sep 26", trackerId: tracker.id, value: "3", date: "2026-09-26" });
    const unsure = addNote({ kind: "tracker", text: "headache 5/10 on Fri, Sep 25", trackerId: tracker.id, value: "5", date: "2026-09-25" });
    fake.jevReplies.push({ n1: "no", n2: { selected: "yes", p: 0.6 } });
    const { log } = await process();
    expect(memory().getNote(wrong.id).status).toBe("tossed");
    expect(memory().getNote(unsure.id)).toMatchObject({ status: "asking", ask: "whether this is right: headache 5/10 on Fri, Sep 25" });
    expect(log.map((e) => [e.action, e.reason])).toEqual([
      ["tossed", "no longer true, 95% sure"],
      ["asking", "unsure (60% it's still true), so she'll ask"],
    ]);
    expect(app.store.trackers.entries()).toHaveLength(0);
  });

  test("a plan is never saved by processing: she asks first", async () => {
    const note = addNote({ kind: "plan", text: "dentist thursday at 3", planDraft: DENTIST });
    fake.jevReplies.push({ n1: "yes" });
    const { log } = await process();
    expect(memory().getNote(note.id)).toMatchObject({ status: "asking", ask: 'whether they want "Dentist on Thu, Oct 1 at 3:00p" put in the planner' });
    expect(log[0]!.reason).toBe("still true, 95% sure; plans from chat need their yes");
    expect(app.store.plans.list()).toHaveLength(0);
  });

  test("a plan already in the planner is done; one with no day or time is tossed", async () => {
    app.store.plans.create({ kind: "appointment", title: "dentist", startDate: "2026-10-01", startTime: "10:00" });
    const already = addNote({ kind: "plan", text: "dentist thursday", planDraft: DENTIST });
    const vague = addNote({ kind: "plan", text: "something next month", planDraft: null });
    fake.jevReplies.push({ n1: "yes", n2: "yes" });
    await process();
    expect(memory().getNote(already.id).status).toBe("done");
    expect(memory().getNote(vague.id).status).toBe("tossed");
  });

  test("something to remember is kept to bring up, and pinned if it matters right now", async () => {
    const note = addNote({ kind: "remember", text: "exam on friday, they're nervous" });
    fake.jevReplies.push({ n1: "yes", "n1.pin": "yes" });
    fake.replies.push({ content: '{"new1": {"text": "exam on friday", "reason": "they\'re really nervous", "unpin_when": "after the exam", "unpin_date": "2026-10-02"}}' });
    const { log } = await process();
    expect(fake.requests[0]!.messages[1]!.content).toContain('- "new1": exam on friday, they\'re nervous');
    expect(memory().getNote(note.id).status).toBe("bringup");
    expect(memory().pins()).toEqual([
      expect.objectContaining({ text: "exam on friday", reason: "they're really nervous", unpinWhen: "after the exam", unpinDate: "2026-10-02", yours: false, noteId: note.id }),
    ]);
    expect(log.map((e) => e.action)).toEqual(["bringup", "pinned"]);
  });

  test("confirmed notes aren't asked about again", async () => {
    const note = addNote({ kind: "remember", text: "stressed about the new manager" });
    memory().updateNote(note.id, { confirmed: true }, time);
    const { log } = await process();
    expect(fake.jevRequests[0]!.questions.map((q) => q.id)).toEqual(["n1.pin"]);
    expect(fake.jevRequests[0]!.state).toContain("they confirmed it): stressed about the new manager");
    expect(memory().getNote(note.id).status).toBe("bringup");
    expect(log[0]!.reason).toBe("they confirmed it");
  });

  test("pins come down after their date without asking, or on a confident yes; unsure stays up", async () => {
    const dated = addPin("mom visiting", { unpinDate: "2026-09-25" });
    const done = addPin("exam on friday", { unpinWhen: "after the exam" });
    const unsure = addPin("new manager", { unpinWhen: "once it settles" });
    fake.jevReplies.push({ p1: "yes", p2: { selected: "yes", p: 0.6 } });
    const { log } = await process();
    expect(fake.jevRequests[0]!.questions.map((q) => q.id)).toEqual(["p1", "p2"]);
    expect(fake.jevRequests[0]!.state).toContain('- p1 (pinned Sat 4:00 PM): exam on friday (unpin when: after the exam)');
    expect(memory().getPin(dated.id)).toMatchObject({ status: "drawer", unpinReason: "its date passed" });
    expect(memory().getPin(done.id).status).toBe("drawer");
    expect(memory().getPin(unsure.id).status).toBe("pinned");
    expect(log.map((e) => [e.action, e.text])).toEqual([
      ["unpinned", "mom visiting"],
      ["unpinned", "exam on friday"],
      ["kept", "new manager"],
    ]);
  });

  test("when the pins are full, Jev picks what comes down", async () => {
    app.store.updateSettings({ pinCap: 1 });
    const old = addPin("old thing");
    addNote({ kind: "remember", text: "exam on friday" });
    fake.jevReplies.push({ n1: "yes", "n1.pin": "yes" }, { drop: "p1" });
    fake.replies.push({ content: '{"new1": {"text": "exam on friday", "reason": "big deal"}}' });
    await process();
    expect(fake.jevRequests[1]!.state).toContain("Kitsikai's pins are full (1). She wants to pin: \"exam on friday\"");
    expect(memory().getPin(old.id)).toMatchObject({ status: "drawer", unpinReason: 'made room for "exam on friday"' });
    expect(memory().pins().map((p) => p.text)).toEqual(["exam on friday"]);
  });

  test("when the pins are full and Jev isn't sure, the new one isn't pinned, but isn't forgotten", async () => {
    app.store.updateSettings({ pinCap: 1 });
    addPin("old thing");
    const note = addNote({ kind: "remember", text: "exam on friday" });
    fake.jevReplies.push({ n1: "yes", "n1.pin": "yes" }, { drop: { selected: "p1", p: 0.5 } });
    fake.replies.push({ content: '{"new1": {"text": "exam on friday"}}' });
    const { log } = await process();
    expect(memory().pins().map((p) => p.text)).toEqual(["old thing"]);
    expect(memory().getNote(note.id).status).toBe("bringup");
    expect(log.at(-1)).toMatchObject({ action: "kept", reason: "her pins are full, and this mattered least" });
  });

  test("your request to pin is honored, making room with the oldest pin you didn't ask for", async () => {
    app.store.updateSettings({ pinCap: 2 });
    addPin("yours already", { yours: true });
    const theirs = addPin("hers");
    const note = addNote({ kind: "request", text: "pin: mom's surgery on tuesday", yours: true, request: "pin" });
    fake.jevReplies.push({ n1: "yes" }, { drop: { selected: "the new one", p: 0.55 } });
    fake.replies.push({ content: '{"new1": {"text": "mom\'s surgery tuesday", "reason": "they asked", "unpin_when": "after the surgery"}}' });
    await process();
    expect(memory().getPin(theirs.id)).toMatchObject({ status: "drawer", unpinReason: 'made room for their request "mom\'s surgery tuesday" (the oldest pin)' });
    expect(memory().pins().map((p) => [p.text, p.yours])).toEqual([
      ["yours already", true],
      ["mom's surgery tuesday", true],
    ]);
    expect(memory().getNote(note.id).status).toBe("done");
  });

  test("your request to let a pin go", async () => {
    const exam = addPin("exam on friday");
    addPin("new manager");
    const note = addNote({ kind: "request", text: "let go of: the exam", yours: true, request: "unpin" });
    fake.jevReplies.push({ n1: "yes", "n1.which": "p1" });
    const { log } = await process();
    expect(fake.jevRequests[0]!.questions.find((q) => q.id === "n1.which")!.options).toEqual(["p1", "p2", "none of these"]);
    expect(memory().getPin(exam.id)).toMatchObject({ status: "drawer", unpinReason: "they asked" });
    expect(memory().getNote(note.id).status).toBe("done");
    expect(log[0]).toMatchObject({ action: "unpinned", text: "exam on friday", reason: "they asked (95% sure)" });
  });

  test("not sure which pin you meant: she asks", async () => {
    addPin("exam on friday");
    const note = addNote({ kind: "request", text: "let go of: that thing", yours: true, request: "unpin" });
    fake.jevReplies.push({ n1: "yes", "n1.which": { selected: "p1", p: 0.5 } });
    await process();
    expect(memory().getNote(note.id)).toMatchObject({ status: "asking", ask: "which pin they want you to let go of (let go of: that thing)" });
  });

  test("things to bring up are done once they're settled", async () => {
    const settled = addNote({ kind: "remember", text: "job interview on monday" });
    const open = addNote({ kind: "remember", text: "new manager" });
    for (const note of [settled, open]) memory().updateNote(note.id, { status: "bringup" }, time);
    fake.jevReplies.push({ b1: "yes" });
    await process();
    expect(memory().getNote(settled.id).status).toBe("done");
    expect(memory().getNote(open.id).status).toBe("bringup");
  });

  test("a regular round leaves brand-new notes for next time; Process now takes them all", async () => {
    const note = addNote({ kind: "remember", text: "just said" });
    await app.processing.run("timer");
    expect(fake.jevRequests).toHaveLength(0);
    expect(memory().getNote(note.id).status).toBe("open");
    later(10);
    fake.jevReplies.push({ n1: "yes" });
    await app.processing.run("timer");
    expect(memory().getNote(note.id).status).toBe("bringup");
  });

  test("an early round only takes time-sensitive notes", async () => {
    const soon = addNote({ kind: "remember", text: "exam in an hour", timeSensitive: true });
    const other = addNote({ kind: "remember", text: "likes pho" });
    addPin("some pin");
    fake.jevReplies.push({ n1: "yes" });
    await app.processing.run("early");
    expect(fake.jevRequests[0]!.questions.map((q) => q.id)).toEqual(["n1", "n1.pin"]);
    expect(memory().getNote(soon.id).status).toBe("bringup");
    expect(memory().getNote(other.id).status).toBe("open");
  });

  test("questions nobody answers for 3 days are let go", async () => {
    const note = addNote({ kind: "remember", text: "moving?" });
    memory().updateNote(note.id, { status: "asking", ask: "whether they're moving" }, time);
    later(3 * 24 * 60 + 1);
    const { log } = await process();
    expect(memory().getNote(note.id).status).toBe("tossed");
    expect(log[0]).toMatchObject({ action: "tossed", reason: "never answered in 3 days" });
  });

  test("if Jev can't be reached, the round stops and nothing changes", async () => {
    const note = addNote({ kind: "remember", text: "something" });
    fake.jevReplies.push({ status: 503, error: "Model unavailable" });
    const { run, log } = await process();
    expect(run.error).toContain("HTTP 503");
    expect(memory().getNote(note.id).status).toBe("open");
    expect(log).toEqual([expect.objectContaining({ action: "error", text: "Processing stopped" })]);
  });

  test("nothing to process: no questions", async () => {
    const { run, log } = await process();
    expect(fake.jevRequests).toHaveLength(0);
    expect(log).toHaveLength(0);
    expect(run.error).toBeNull();
  });

  test("one round at a time", async () => {
    addNote({ kind: "remember", text: "something" });
    const first = app.processing.run("manual");
    expect(app.processing.isRunning()).toBe(true);
    await expect(app.processing.run("manual")).rejects.toBeInstanceOf(AlreadyProcessingError);
    const busy = await call("POST", "/api/processing/run", {});
    expect(busy.status).toBe(409);
    await first;
    expect(app.processing.isRunning()).toBe(false);
  });
});

// ------------------------------------------------------------ scheduler

describe("the scheduler", () => {
  test("processes every few hours (settings: every 3)", async () => {
    expect(app.scheduler.due()).toBe("timer"); // never processed yet
    expect((await app.scheduler.tick())!.run.trigger).toBe("timer");
    expect(app.scheduler.due()).toBeNull();
    expect(app.scheduler.nextRunAt()).toEqual(new Date(2026, 8, 26, 19, 0));
    later(179);
    expect(app.scheduler.due()).toBeNull();
    later(1);
    expect(app.scheduler.due()).toBe("timer");
    app.store.updateSettings({ processingHours: 4 });
    expect(app.scheduler.due()).toBeNull();
  });

  test("a time-sensitive note gets an early round after a few minutes, at most every 10 minutes", async () => {
    await app.scheduler.tick();
    addNote({ kind: "remember", text: "exam in an hour", timeSensitive: true });
    later(4);
    expect(app.scheduler.due()).toBeNull();
    later(1);
    expect(app.scheduler.due()).toBe("early");
    fake.jevReplies.push({ status: 503, error: "down" }); // the round fails, the note stays
    await app.scheduler.tick();
    later(5);
    expect(app.scheduler.due()).toBeNull();
    later(5);
    expect(app.scheduler.due()).toBe("early");
  });
});

// --------------------------------------------------------------- prompt

describe("in her prompt", () => {
  const prompt = () => promptForChannel(app.store, general.id, { now: time })[0]!.content;

  test("her pins, notes, questions and things to bring up are always in view", () => {
    addPin("exam on friday", { reason: "they're nervous", unpinWhen: "after the exam", unpinDate: "2026-10-02" });
    addNote({ kind: "tracker", text: "headache 7/10 on Sat, Sep 26" });
    const asking = addNote({ kind: "plan", text: "dentist" });
    memory().updateNote(asking.id, { status: "asking", ask: 'whether they want "Dentist on Thu, Oct 1 at 3:00p" put in the planner' }, time);
    const bringUp = addNote({ kind: "remember", text: "stressed about the new manager, check in later" });
    memory().updateNote(bringUp.id, { status: "bringup" }, time);

    const content = prompt();
    expect(content).toContain("## Your notes and pins\n\nYou keep a scratchpad.");
    expect(content).toContain('"noted 📌"');
    expect(content).toContain("Pinned (1 of 10):\n- exam on friday (why: they're nervous; unpin when: after the exam, after 2026-10-02)");
    expect(content).toContain("On your scratchpad (pencil, not processed yet):\n- headache 7/10 on Sat, Sep 26");
    expect(content).toContain('Things to ask them about, when it fits (casually, one at a time; if you\'ve already asked in the chat above, wait for their answer instead of asking again):\n- whether they want "Dentist on Thu, Oct 1 at 3:00p" put in the planner');
    expect(content).toContain("Things you might bring up, if it fits:\n- stressed about the new manager, check in later");
    // In order: after today and tomorrow, before the tools.
    expect(content.indexOf("## Today and tomorrow")).toBeLessThan(content.indexOf("## Your notes and pins"));
  });

  test("with nothing pinned, she knows that too", () => {
    expect(prompt()).toContain("Pinned: nothing right now.");
    expect(prompt()).not.toContain("On your scratchpad");
  });

  test("what her last round did, for a day, so she can mention it", async () => {
    const tracker = app.store.trackers.create({ name: "headache", kind: "scale" });
    addNote({ kind: "tracker", text: "headache 7/10 on Sat, Sep 26", trackerId: tracker.id, value: "7", date: "2026-09-26" });
    addPin("exam on friday", { unpinWhen: "after the exam" });
    fake.jevReplies.push({ n1: "yes", p1: "yes" });
    await app.processing.run("manual");
    later(120);
    expect(prompt()).toContain(
      "Since you last processed (2 hours ago):\n- saved: headache 7/10 on Sat, Sep 26\n- took down the pin: exam on friday (time to come down, 95% sure)",
    );
    later(24 * 60);
    expect(prompt()).not.toContain("Since you last processed");
  });

  test("the tool guidance mentions her notes", async () => {
    const [profile] = app.store.profiles.list();
    app.store.profiles.update(profile!.id, { supportsTools: true });
    const content = promptForChannel(app.store, general.id, { now: time, profile: app.store.profiles.get(profile!.id) })[0]!.content;
    expect(content).toContain("jot_note");
    expect(content).toContain("look_in_drawer");
  });
});

// ---------------------------------------------------------------- tools

describe("her note tools", () => {
  const ctx = () => ({ store: app.store, channel: general, now: time, events: app.events });

  test("jot_note puts a note on her scratchpad, in pencil", () => {
    const message = app.store.addMessage({ channelId: general.id, author: "user", content: "ugh new manager again" });
    const events = listen();
    const outcome = runTool(ctx(), "jot_note", { text: "they're stressed about the new manager", soon: false });
    expect(outcome).toMatchObject({ ok: true, summary: 'jotted down "they\'re stressed about the new manager"' });
    expect(memory().notes()).toEqual([expect.objectContaining({ kind: "remember", origin: "jotted", yours: false, status: "open", messageId: message.id })]);
    expect(memory().recentLog()[0]).toMatchObject({ action: "noted", reason: "you jotted it down" });
    expect(events).toEqual([{ type: "memory" }]);
  });

  test("jot_note for their requests to pin or let go", () => {
    runTool(ctx(), "jot_note", { text: "pin: mom's surgery", kind: "pin", soon: true });
    runTool(ctx(), "jot_note", { text: "let go of the exam pin", kind: "let go" });
    expect(memory().notes().map((n) => [n.kind, n.request, n.yours, n.timeSensitive])).toEqual([
      ["request", "pin", true, true],
      ["request", "unpin", true, false],
    ]);
    expect(runTool(ctx(), "jot_note", { text: "x", kind: "forget" }).ok).toBe(false);
    expect(runTool(ctx(), "jot_note", {}).summary).toBe('"text" is required.');
  });

  test("look_in_drawer finds pins she took down", () => {
    const pin = addPin("exam on friday", { reason: "they were nervous" });
    memory().unpin(pin.id, "it's over", time);
    addPin("still up");
    expect(runTool(ctx(), "look_in_drawer", { query: "exam" })).toMatchObject({
      ok: true,
      result: [{ pin: "exam on friday", why: "they were nervous", pinned: "Sat, Sep 26", taken_down: "Sat, Sep 26", because: "it's over" }],
      summary: 'looked in the drawer for "exam"',
    });
    expect(runTool(ctx(), "look_in_drawer", { query: "manager" }).result).toEqual({ note: 'Nothing in the drawer about "manager".' });
  });

  test("she can jot a note during a turn, and the app hears about it", async () => {
    const [profile] = app.store.profiles.list();
    app.store.profiles.update(profile!.id, { supportsTools: true });
    fake.replies.push({ toolCalls: [{ name: "jot_note", arguments: { text: "they love pho" } }] }, { content: "noted 📌" });
    const events = listen();
    await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(memory().notes()[0]!.text).toBe("they love pho");
    expect(events.map((e) => e.type)).toContain("memory");
  });
});

// ------------------------------------------------------------------ API

describe("the API", () => {
  test("GET /api/memory: notes, pins, drawer, rounds with their log, and Jev's status", async () => {
    addNote({ kind: "remember", text: "something" });
    const pin = addPin("exam");
    memory().unpin(pin.id, "done", time);
    addPin("manager");
    fake.jevReplies.push({ n1: "no" });
    await call("POST", "/api/processing/run", {});
    const { status, data } = await call("GET", "/api/memory");
    expect(status).toBe(200);
    expect(data.notes).toHaveLength(0);
    expect(data.pins.map((p: { text: string }) => p.text)).toEqual(["manager"]);
    expect(data.drawer.map((p: { text: string }) => p.text)).toEqual(["exam"]);
    expect(data.runs[0]).toMatchObject({ trigger: "manual", error: null });
    expect(data.runs[0].log.map((e: { action: string }) => e.action)).toEqual(["tossed", "kept"]);
    expect(data.processing).toEqual({ running: false, nextRunAt: new Date(2026, 8, 26, 19, 0).toISOString(), every: 3 });
    expect(data.jev).toMatchObject({ model: "typesafe/jev-1.13", enabled: true, checkError: null });
    expect(data.jev.lastReport.answeredBy).toBe("jev");
    expect(data.pinCap).toBe(10);
  });

  test("GET /api/memory lists what happened during chat separately", async () => {
    runTool({ store: app.store, channel: general, now: time }, "jot_note", { text: "likes pho" });
    const { data } = await call("GET", "/api/memory");
    expect(data.duringChat).toEqual([expect.objectContaining({ action: "noted", text: "likes pho", runId: null })]);
    expect(data.notes).toEqual([expect.objectContaining({ text: "likes pho" })]);
  });

  test("POST /api/jev/test", async () => {
    fake.jevReplies.push({ pet: "yes" });
    const { data } = await call("POST", "/api/jev/test", {});
    expect(data.test).toMatchObject({ ok: true, answer: { selected: "yes" } });
  });

  test("settings for her memory are checked", async () => {
    const good = await call("PUT", "/api/settings", { decisionConfidence: 0.9, processingHours: 1.5, pinCap: 5, showAdvanced: true, decisionModel: " typesafe/jev-1.14 " });
    expect(good.data.settings).toMatchObject({ decisionConfidence: 0.9, processingHours: 1.5, pinCap: 5, showAdvanced: true, decisionModel: "typesafe/jev-1.14" });
    for (const body of [{ decisionConfidence: 0.4 }, { decisionConfidence: 1 }, { pinCap: 0 }, { processingHours: 0 }, { showAdvanced: "yes" }]) {
      expect((await call("PUT", "/api/settings", body)).status).toBe(400);
    }
    const roulette = app.store.profiles.createRoulette({ name: "Mix", entries: [{ profileId: app.store.profiles.list()[0]!.id, weight: 1 }] });
    expect((await call("PUT", "/api/settings", { decisionFallback: `roulette:${roulette.id}` })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { writerAssignment: "profile:nope" })).status).toBe(404);
  });

  test("deleting the fallback profile turns the fallback off", async () => {
    const spare = app.store.profiles.create({ name: "Spare", model: "spare/model" });
    await call("PUT", "/api/settings", { decisionFallback: `profile:${spare.id}`, writerAssignment: `profile:${spare.id}` });
    expect((await call("DELETE", `/api/profiles/${spare.id}`, {})).status).toBe(200);
    expect(app.store.getSettings()).toMatchObject({ decisionFallback: "", writerAssignment: "" });
  });

  test("the database has the memory tables (layout version 6)", async () => {
    const { SCHEMA_VERSION } = await import("../src/db.ts");
    expect(SCHEMA_VERSION).toBe(6);
    const tables = app.store.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["notes", "pins", "processing_runs", "memory_log", "scratchpad_marks"]));
  });
});
