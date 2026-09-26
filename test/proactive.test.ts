/**
 * Tests for stage 8: texting first. Due reminders (src/reminders.ts), the
 * snapshot check, channel picking and the interruption check
 * (src/proactive.ts), the double-text cap, on-call, notifications
 * (src/notify.ts), and the scheduler.
 *
 * The fake Jev answers by question: each test routes the questions it
 * cares about. Anything else gets the question's last option ("no",
 * "pushy", the last channel), 95% sure.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { workStatus } from "../src/binder.ts";
import { promptForChannel } from "../src/kitsikai.ts";
import type { Notification } from "../src/notify.ts";
import { appNote, hoursWords } from "../src/proactive.ts";
import { dueReminders, remindersForPrompt } from "../src/reminders.ts";
import { createApp, type App } from "../src/server.ts";
import type { Channel } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt, type JevReply, type JevRequest } from "./helpers.ts";

setDefaultTimeout(15_000);

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let call: ReturnType<typeof caller>;
let general: Channel;
let notifications: Notification[];
/** The app's clock: Saturday, September 26, 2026, 6 PM, until a test moves it. */
let time: Date;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  time = new Date(2026, 8, 26, 18, 0);
  notifications = [];
  app = createApp(testConfig(dir.path, fake.baseUrl), {
    now: () => time,
    notifier: { available: () => true, notify: (n) => notifications.push(n) },
  });
  call = caller(app.fetch);
  app.store.updateSettings({ replyDebounceSeconds: 0 });
  general = app.store.listChannels()[0]!;
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
const ago = (minutes: number) => new Date(time.getTime() - minutes * 60_000).toISOString();

/** A message in a channel, some minutes ago. */
const say = (author: "user" | "kitsikai", content: string, minutesAgo: number, channelId = general.id) =>
  app.store.addMessage({ channelId, author, content, createdAt: ago(minutesAgo) });

/** Answer Jev's questions by id, whichever call they come in. */
function jevAnswers(answers: JevReply) {
  fake.jev = (request: JevRequest) => Object.fromEntries(request.questions.filter((q) => q.id in answers).map((q) => [q.id, (answers as Record<string, string>)[q.id]!]));
}

/** Dentist tomorrow at 3 PM: its "day before" reminder goes off today at 6 PM. */
const dentist = () => app.store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-09-27", startTime: "15:00" });

const check = () => app.proactive.check("manual");
const lastRequest = () => fake.requests.at(-1)!;
const lastNote = () => lastRequest().messages.at(-1)!.content;

// ------------------------------------------------------------- reminders

describe("due reminders", () => {
  test("are the ones that have gone off, until their plan starts", () => {
    dentist();
    later(-1);
    expect(dueReminders(app.store, time)).toHaveLength(0);
    later(1);
    const [due] = dueReminders(app.store, time);
    expect(due).toMatchObject({ text: "Dentist (appointment), tomorrow at 3:00p", queuedIn: null });
    expect(due!.reminder.id).toBe("day-before");
    expect(due!.key).toMatch(/:2026-09-27:day-before$/);
    // Tomorrow at 1 PM, the "2 hours before" one is due instead.
    later(19 * 60);
    expect(dueReminders(app.store, time).map((r) => r.reminder.id)).toEqual(["2h-before"]);
    later(2 * 60);
    expect(dueReminders(app.store, time)).toHaveLength(0);
  });

  test("a reminder more than a day late isn't sent", () => {
    app.store.plans.create({ kind: "birthday", title: "Mia's birthday", startDate: "2026-10-01" });
    // A week before, at noon: Sep 24. Two days late now.
    expect(dueReminders(app.store, time)).toHaveLength(0);
  });

  test("an all-day plan's reminders are due until the day is over", () => {
    app.store.plans.create({ kind: "hangout", title: "Beach day", startDate: "2026-09-26" });
    expect(dueReminders(app.store, time).map((r) => r.text)).toEqual(["Beach day (hangout), today (all day)"]);
    later(6 * 60);
    expect(dueReminders(app.store, time)).toHaveLength(0);
  });

  test("sent and skipped reminders aren't due; queued ones are, with their channel", () => {
    dentist();
    const [due] = dueReminders(app.store, time);
    app.store.reminders.record(due!, "queued", { channelId: general.id }, time);
    expect(dueReminders(app.store, time)[0]!.queuedIn).toBe(general.id);
    app.store.reminders.record(due!, "sent", { channelId: general.id }, time);
    expect(dueReminders(app.store, time)).toHaveLength(0);
  });

  test("are always in her prompt; queued ones to mention now", () => {
    dentist();
    const prompt = () => promptForChannel(app.store, general.id, { now: time })[0]!.content;
    expect(prompt()).toContain(
      "## Reminders due\n\nReminders that are due. If one fits naturally into what you're writing now, mention it, in your own words:\n- Dentist (appointment), tomorrow at 3:00p (day before reminder)",
    );
    app.store.reminders.record(dueReminders(app.store, time)[0]!, "queued", { channelId: general.id }, time);
    expect(prompt()).toContain('Mention these now, naturally, in what you write ("oh btw, dentist in 2 hours")');
    expect(remindersForPrompt([], general.id)).toBeNull();
  });
});

// --------------------------------------------------------- the snapshot

describe("the snapshot check", () => {
  test("nothing to text about: Jev isn't even asked", async () => {
    say("user", "night!", 30);
    const result = await check();
    expect(result).toMatchObject({ outcome: "nothing", detail: "Nothing to text about." });
    expect(fake.jevRequests).toHaveLength(0);
    // A manual check is always logged.
    expect(app.store.proactiveLog.recent()[0]).toMatchObject({ trigger: "manual", outcome: "nothing" });
  });

  test("before you've ever texted her, only reminders", async () => {
    expect(await check()).toMatchObject({ outcome: "nothing", detail: "Nothing to text about." });
    expect(fake.jevRequests).toHaveLength(0);
  });

  test("a due reminder: she texts it, in her own words, and it's sent once", async () => {
    dentist();
    say("user", "ok bye", 60);
    fake.replies.push({ content: "dentist tomorrow at 3!!<cht>don't forget" });
    const result = await check();

    expect(fake.jevRequests[0]!.questions.map((q) => q.id)).toEqual(["r1"]);
    expect(fake.jevRequests[0]!.state).toContain("Reminders due now:\n- r1: Dentist (appointment), tomorrow at 3:00p (day before reminder)");
    expect(result).toMatchObject({ outcome: "sent", reason: "reminder", channelId: general.id });
    expect(result.messages.map((m) => m.content)).toEqual(["dentist tomorrow at 3!!", "don't forget"]);
    // The chat ends on their message, so the note goes after it.
    expect(lastNote()).toBe(
      "ok bye\n\n(App note, not from them: you're texting first, to remind them: Dentist (appointment), tomorrow at 3:00p (day before reminder). Remind them in your own words, the way a friend would, not like a notification. If it doesn't feel right after all, you can choose not to text.)",
    );
    expect(app.store.reminders.recent()[0]).toMatchObject({ status: "sent", channelId: general.id, messageId: result.messages[0]!.id });
    expect(app.store.proactiveLog.recent()[0]).toMatchObject({ outcome: "sent", reason: "reminder", messageId: result.messages[0]!.id });
    expect(notifications).toEqual([{ title: "Kitsikai in #general", text: "dentist tomorrow at 3!!\ndon't forget", channelId: general.id }]);

    expect((await check()).outcome).toBe("nothing");
  });

  test("a reminder you just talked about is skipped", async () => {
    dentist();
    say("user", "dentist tomorrow ugh", 40);
    jevAnswers({ r1: "yes" });
    const result = await check();
    expect(result.outcome).toBe("nothing");
    expect(result.detail).toBe("Skipped 1 reminder they'd already talked about; nothing else worth texting about.");
    expect(app.store.reminders.recent()[0]).toMatchObject({ status: "skipped", reason: "they already talked about it (95% sure)" });
    expect(fake.requests).toHaveLength(0);
  });

  test("the double-text cap is a hard wall: Jev isn't even asked", async () => {
    app.store.updateSettings({ doubleTextCap: 1 });
    say("user", "bye", 5 * 60);
    say("kitsikai", "hey you", 3 * 60);
    app.store.proactiveLog.add({ trigger: "timer", outcome: "sent", reason: "just-because", channelId: general.id, messageId: null, detail: "", key: null }, new Date(ago(3 * 60)));
    const result = await check();
    expect(result).toMatchObject({ outcome: "nothing", detail: "The double-text cap (1) is reached: waiting for their reply." });
    expect(fake.jevRequests).toHaveLength(0);
  });

  test("reminders ignore the cap", async () => {
    app.store.updateSettings({ doubleTextCap: 1 });
    dentist();
    say("user", "bye", 5 * 60);
    app.store.proactiveLog.add({ trigger: "timer", outcome: "sent", reason: "just-because", channelId: general.id, messageId: null, detail: "", key: null }, new Date(ago(3 * 60)));
    expect((await check()).outcome).toBe("sent");
  });

  test("letting her judge: another text only if it would feel natural", async () => {
    say("user", "bye", 6 * 60);
    say("kitsikai", "thinking of you", 3 * 60);
    app.store.proactiveLog.add({ trigger: "timer", outcome: "sent", reason: "just-because", channelId: general.id, messageId: null, detail: "", key: null }, new Date(ago(3 * 60)));
    jevAnswers({ quiet: "yes" }); // "again" defaults to "pushy"
    const pushy = await check();
    expect(fake.jevRequests[0]!.questions.map((q) => q.id)).toEqual(["quiet", "again"]);
    expect(fake.jevRequests[0]!.questions[1]!.question).toBe("Kitsikai has already texted first once without a reply. Would another text now feel natural, or pushy?");
    expect(pushy).toMatchObject({ outcome: "nothing" });

    jevAnswers({ quiet: "yes", again: "natural" });
    fake.replies.push({ content: "ok last one i promise" });
    const natural = await check();
    expect(natural).toMatchObject({ outcome: "sent", reason: "just-because" });
    expect(lastNote()).toContain("just because: it's been quiet for 3 hours. They haven't answered your last text yet, so keep it light.");
  });

  test("work just ended: a check-in, once per work block", async () => {
    app.store.plans.create({ kind: "shift", title: "Work", startDate: "2026-09-26", startTime: "09:00", endTime: "17:30" });
    say("user", "morning", 10 * 60);
    jevAnswers({ checkin: "yes" });
    fake.replies.push({ content: "how'd it go??" });
    const result = await check();
    expect(fake.jevRequests[0]!.questions.find((q) => q.id === "checkin")!.question).toBe(
      "Their work just ended, at 5:30 PM. Would Kitsikai texting now to ask how it went feel natural?",
    );
    expect(result).toMatchObject({ outcome: "sent", reason: "checkin" });
    expect(lastNote()).toContain("because their work just ended (at 5:30 PM): a good moment to ask how it went");
    expect(app.store.proactiveLog.recent()[0]!.key).toBe(`checkin:${new Date(2026, 8, 26, 17, 30).toISOString()}`);

    // It's had its check-in: not asked about again.
    later(20);
    say("user", "it was fine", 0);
    later(25);
    const asked = fake.jevRequests.length;
    expect((await check()).outcome).toBe("nothing");
    expect(fake.jevRequests.slice(asked).flatMap((r) => r.questions.map((q) => q.id))).not.toContain("checkin");
  });

  test("following up on her notes and pins", async () => {
    app.store.memory.addPin({ text: "exam friday", reason: "they're nervous", unpinWhen: "after the exam", unpinDate: null, yours: false, noteId: null }, time);
    say("user", "k", 30);
    jevAnswers({ followup: "yes" });
    fake.replies.push({ content: "studying going ok?" });
    const result = await check();
    expect(fake.jevRequests[0]!.state).toContain("Things Kitsikai might follow up on:\n- pin: exam friday (why: they're nervous; unpin when: after the exam)");
    expect(result).toMatchObject({ outcome: "sent", reason: "followup" });
  });

  test("trackers she may not bring up stay out of it", async () => {
    const quiet = app.store.trackers.create({ name: "weight", kind: "note", canBringUp: false });
    app.store.trackers.addEntry({ trackerId: quiet.id, date: "2026-09-26", value: "160" });
    say("user", "k", 30);
    await check();
    expect(fake.jevRequests).toHaveLength(0);
  });

  test("soon after a message, only reminders count", async () => {
    app.store.memory.addPin({ text: "exam friday", reason: "", unpinWhen: "", unpinDate: null, yours: false, noteId: null }, time);
    say("user", "brb", 10);
    expect((await check()).outcome).toBe("nothing");
    expect(fake.jevRequests).toHaveLength(0);
  });

  test("not while she's replying somewhere, or with texting first off", async () => {
    dentist();
    app.store.updateSettings({ replyDebounceSeconds: 60 });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "hey" });
    expect(await check()).toMatchObject({ outcome: "nothing", detail: "She's in the middle of replying." });
    app.replies.cancel(general.id);
    app.store.updateSettings({ textFirst: false });
    expect(await check()).toMatchObject({ outcome: "nothing", detail: "Texting first is off in Settings." });
    expect(fake.jevRequests).toHaveLength(0);
  });

  test("she can decide not to text after all", async () => {
    dentist();
    const [profile] = app.store.profiles.list();
    app.store.profiles.update(profile!.id, { supportsTools: true });
    fake.replies.push({ toolCalls: [{ name: "do_nothing", arguments: { reason: "they know" } }] });
    const result = await check();
    expect(result).toMatchObject({ outcome: "declined", reason: "reminder" });
    expect(app.store.reminders.recent()[0]).toMatchObject({ status: "skipped", reason: "she chose not to text it" });
    expect(notifications).toHaveLength(0);
  });

  test("timer checks that decide nothing aren't kept (there'd be one every 10 minutes)", async () => {
    say("user", "bye", 3 * 60);
    expect((await app.proactive.check("timer")).outcome).toBe("nothing");
    expect(fake.jevRequests).toHaveLength(1);
    expect(app.store.proactiveLog.recent()).toHaveLength(0);
  });

  test("with Jev off and no reminders, nothing is asked", async () => {
    app.store.updateSettings({ decisionModel: "" });
    say("user", "bye", 3 * 60);
    expect(await app.proactive.check("timer")).toMatchObject({ outcome: "nothing", detail: "Jev is turned off (and there's no fallback), so only reminders can go out." });
    expect(fake.jevRequests).toHaveLength(0);
  });

  test("if Jev can't be reached, only reminders go out", async () => {
    dentist();
    say("user", "bye", 5 * 60);
    fake.jevReplies.push({ status: 503, error: "down" });
    expect(await check()).toMatchObject({ outcome: "error" });
    app.store.updateSettings({ decisionModel: "" });
    fake.replies.push({ content: "dentist tmrw!" });
    expect(await check()).toMatchObject({ outcome: "sent", reason: "reminder" });
  });
});

// ------------------------------------------------------ picking a channel

describe("picking the channel", () => {
  let work: Channel;
  beforeEach(() => {
    work = app.store.createChannel({ name: "work", kind: "text", topic: "work stuff, venting about shifts" });
    app.store.plans.create({ kind: "shift", title: "Work", startDate: "2026-09-26", startTime: "09:00", endTime: "17:30" });
    say("user", "morning", 10 * 60);
  });

  test("the channel that fits best, from names and topics", async () => {
    jevAnswers({ checkin: "yes", channel: "work" });
    fake.replies.push({ content: "how was it" });
    const result = await check();
    const pick = fake.jevRequests[1]!;
    expect(pick.questions[0]).toMatchObject({ id: "channel", options: ["general", "work"] });
    expect(pick.questions[0]!.question).toBe("Which channel fits best for this text from Kitsikai: asking how work went?");
    expect(pick.state).toContain("- #work: work stuff, venting about shifts");
    expect(pick.state).toContain("- #general (the home channel)");
    expect(result).toMatchObject({ outcome: "sent", channelId: work.id, detail: "Their work just ended at 5:30 PM (95% sure). #work fits best (95% sure)." });
  });

  test("unsure where it fits: the home channel", async () => {
    fake.jev = (request): JevReply =>
      request.questions.some((q) => q.id === "channel") ? { channel: { selected: "work", p: 0.6 } } : { checkin: "yes" };
    fake.replies.push({ content: "how was it" });
    expect(await check()).toMatchObject({ outcome: "sent", channelId: general.id });
  });

  test("a channel mid-conversation is skipped for the next best", async () => {
    // 25 minutes ago: quiet enough to text first, recent enough to be a conversation.
    say("user", "ugh this game", 25, work.id);
    jevAnswers({ checkin: "yes", channel: "work", i2: "yes" });
    fake.replies.push({ content: "done with work?" });
    const result = await check();
    expect(fake.jevRequests[1]!.questions.map((q) => q.id)).toEqual(["channel", "i2"]);
    expect(fake.jevRequests[1]!.state).toContain("The last 30 minutes in #work:\n[Sat 5:35 PM] them: ugh this game");
    expect(result).toMatchObject({ outcome: "sent", channelId: general.id });
    expect(result.detail).toContain("#work fits best (95% sure), but #work was mid-conversation, so #general.");
  });

  test("everyone mid-conversation: a reminder goes into the conversation you're having", async () => {
    dentist();
    say("user", "hm", 5);
    say("user", "lol", 3, work.id);
    jevAnswers({ channel: "work", i1: "yes", i2: "yes" });
    const result = await check();
    expect(result).toMatchObject({ outcome: "queued", reason: "reminder", channelId: work.id });
    expect(result.detail).toContain("She'll mention it in #work.");
    expect(dueReminders(app.store, time)[0]!.queuedIn).toBe(work.id);
    expect(fake.requests).toHaveLength(0);

    // Her next reply there mentions it, and then it counts as sent.
    fake.jev = (request): JevReply => (request.questions.some((q) => q.question.includes("remind them about")) ? { r1: "yes" } : {});
    fake.replies.push({ content: "lmao. oh btw dentist tomorrow at 3" });
    await call("POST", `/api/channels/${work.id}/messages`, { content: "anyway" });
    await app.replies.flush();
    await app.proactive.settle();
    expect(lastRequest().messages[0]!.content).toContain("Mention these now, naturally");
    expect(app.store.reminders.recent()[0]).toMatchObject({ status: "sent", channelId: work.id, reason: "mentioned in the conversation (95% sure)" });
  });

  test("everyone mid-conversation: anything else waits", async () => {
    say("user", "lol", 3, work.id);
    say("user", "wait", 4);
    jevAnswers({ checkin: "yes", i1: "yes", i2: "yes" });
    // Only 3 minutes of quiet: a check-in isn't even considered yet.
    expect((await check()).outcome).toBe("nothing");
    later(20);
    const result = await check();
    expect(result).toMatchObject({ outcome: "waiting", reason: "checkin" });
    expect(result.detail).toContain("were mid-conversation. Waiting for the next check.");
  });
});

// ------------------------------------------------ mentions in a conversation

describe("reminders mentioned in conversation", () => {
  test("a due reminder she worked into a reply counts as sent", async () => {
    dentist();
    fake.jev = (request): JevReply => (request.questions.some((q) => q.question.includes("remind them about")) ? { r1: "yes" } : {});
    fake.replies.push({ content: "also dentist tmrw at 3 dont forget" });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "what's up" });
    await app.replies.flush();
    await app.proactive.settle();
    expect(app.store.reminders.recent()[0]).toMatchObject({ status: "sent", channelId: general.id });
    expect(dueReminders(app.store, time)).toHaveLength(0);
  });

  test("one she didn't mention is still due", async () => {
    dentist();
    await call("POST", `/api/channels/${general.id}/messages`, { content: "what's up" });
    await app.replies.flush();
    await app.proactive.settle();
    expect(dueReminders(app.store, time)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- on call

describe("on call", () => {
  test("getting called in makes it work; saying you're done ends it", async () => {
    app.store.plans.create({ kind: "shift", title: "Work", shiftType: "oncall", startDate: "2026-09-26", startTime: "14:00", endTime: "22:00" });
    expect(workStatus(app.store, time, app.store.reminders.calledIn())).toBe("They're on call until 10:00 PM: free unless they get called in.");

    fake.jevReplies.push({ calledIn: "yes" });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "ugh they called me in" });
    await app.replies.flush();
    expect(fake.jevRequests[0]!.state).toContain("They're on call right now, until 10:00 PM: free unless they get called in.");
    expect(app.store.reminders.calledIn().size).toBe(1);
    expect(lastRequest().messages[0]!.content).toContain("They're at work right now, until 10:00 PM.");
    expect(app.store.memory.recentLog()[0]).toMatchObject({ action: "noted", text: "called in to work (on call until 10:00 PM)" });

    later(60);
    fake.jevReplies.push({ done: "yes" });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "ok done, heading home" });
    await app.replies.flush();
    expect(fake.jevRequests[1]!.questions.map((q) => q.id)).toContain("done");
    expect(app.store.reminders.calledIn().size).toBe(0);
    expect(workStatus(app.store, time, app.store.reminders.calledIn())).toContain("on call");
  });

  test("called in, the on-call window's end is a check-in", async () => {
    const plan = app.store.plans.create({ kind: "shift", title: "Work", shiftType: "oncall", startDate: "2026-09-26", startTime: "08:00", endTime: "17:30" });
    say("user", "called in, ugh", 8 * 60);
    app.store.reminders.callIn(`${plan.id}:2026-09-26`, time);
    jevAnswers({ checkin: "yes" });
    fake.replies.push({ content: "freeee?" });
    expect(await check()).toMatchObject({ outcome: "sent", reason: "checkin" });
  });
});

// ---------------------------------------------------------- notifications

describe("notifications", () => {
  test("only while the app isn't on screen", async () => {
    const stream = new AbortController();
    const response = app.events.response(stream.signal);
    expect(app.events.connections).toBe(1);
    await call("POST", "/api/presence", { visible: true });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "hi" });
    await app.replies.flush();
    expect(notifications).toHaveLength(0);

    await call("POST", "/api/presence", { visible: false });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "hi again" });
    await app.replies.flush();
    expect(notifications).toEqual([{ title: "Kitsikai in #general", text: "Reply 2", channelId: general.id }]);

    // Visible, but the app went away: notify.
    await call("POST", "/api/presence", { visible: true });
    stream.abort();
    await response.body?.cancel().catch(() => {});
    expect(app.events.connections).toBe(0);
    await call("POST", `/api/channels/${general.id}/messages`, { content: "hello?" });
    await app.replies.flush();
    expect(notifications).toHaveLength(2);
  });

  test("off in Settings, or unavailable on this device", async () => {
    app.store.updateSettings({ notifications: false });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "hi" });
    await app.replies.flush();
    expect(notifications).toHaveLength(0);
    expect((await call("POST", "/api/presence", { visible: "yes" })).status).toBe(400);
  });
});

// --------------------------------------------------------------- scheduler

describe("the scheduler", () => {
  test("runs the snapshot check every few minutes (settings: every 10)", async () => {
    say("user", "hi", 30);
    expect(app.scheduler.snapshotDue()).toBe(true);
    expect((await app.scheduler.tick()).checked).toMatchObject({ outcome: "nothing" });
    expect(app.scheduler.snapshotDue()).toBe(false);
    later(9);
    expect((await app.scheduler.tick()).checked).toBeNull();
    later(1);
    expect(app.scheduler.snapshotDue()).toBe(true);
    // Timer checks with nothing to ask aren't logged.
    expect(app.store.proactiveLog.recent()).toHaveLength(0);
  });
});

// --------------------------------------------------------------- the API

describe("the API", () => {
  test("GET /api/proactive: due reminders, reminders sent, the log, and what's next", async () => {
    dentist();
    fake.replies.push({ content: "dentist!!" });
    await call("POST", "/api/proactive/check", {});
    later(5);
    app.store.plans.create({ kind: "hangout", title: "Movies", startDate: "2026-09-26", startTime: "20:00" });
    const { data } = await call("GET", "/api/proactive");
    expect(data.due).toEqual([expect.objectContaining({ text: "Movies (hangout), today at 8:00p", label: "Morning of", queuedIn: null })]);
    expect(data.reminders[0]).toMatchObject({ status: "sent", text: "Dentist (appointment), tomorrow at 3:00p" });
    expect(data.log[0]).toMatchObject({ trigger: "manual", outcome: "sent", reason: "reminder" });
    expect(data.lastCheckAt).toBe(new Date(2026, 8, 26, 18, 0).toISOString());
    expect(data.nextCheckAt).toBe(new Date(2026, 8, 26, 18, 10).toISOString());
    expect(data.notificationsAvailable).toBe(true);
  });

  test("POST /api/proactive/check", async () => {
    say("user", "hi", 30);
    const { data } = await call("POST", "/api/proactive/check", {});
    expect(data.check).toMatchObject({ outcome: "nothing", messages: [] });
  });

  test("settings for texting first are checked", async () => {
    const good = await call("PUT", "/api/settings", { textFirst: false, snapshotMinutes: 15, doubleTextCap: 2, notifications: false });
    expect(good.data.settings).toMatchObject({ textFirst: false, snapshotMinutes: 15, doubleTextCap: 2, notifications: false });
    expect((await call("PUT", "/api/settings", { doubleTextCap: "judge" })).data.settings.doubleTextCap).toBe("judge");
    for (const body of [{ doubleTextCap: 4 }, { doubleTextCap: "2" }, { snapshotMinutes: 0 }, { textFirst: "yes" }]) {
      expect((await call("PUT", "/api/settings", body)).status).toBe(400);
    }
    const { data } = await call("GET", "/api/state");
    expect(data.notificationsAvailable).toBe(true);
  });
});

// ------------------------------------------------------------------ words

describe("in words", () => {
  test("how long", () => {
    expect(hoursWords(45)).toBe("45 minutes");
    expect(hoursWords(180)).toBe("3 hours");
    expect(hoursWords(3 * 1440)).toBe("3 days");
    expect(hoursWords(Infinity)).toBe("a long time");
  });

  test("the note that says why she's texting first", () => {
    expect(appNote("followup", { reminders: [], workEnd: null, quietMinutes: 30, inARow: 0 })).toBe(
      "(App note, not from them: you're texting first, to follow up on something from your pins or the things you might bring up, if it still feels right. If it doesn't feel right after all, you can choose not to text.)",
    );
  });
});
