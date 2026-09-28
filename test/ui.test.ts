/**
 * Browser tests: the web app (public/) in a headless Chromium, against the
 * real server and a fake nanoGPT. Skipped when there's no browser (see
 * test/browser.ts).
 */

import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { runTool } from "../src/tools.ts";
import { CHROMIUM, closeBrowser, openApp, type BrowserApp } from "./browser.ts";
import { testPng } from "./helpers.ts";

const describeUi = CHROMIUM ? describe : describe.skip;

// A browser is slower than calling the server directly.
setDefaultTimeout(30_000);

describeUi("the app in a browser", () => {
  let t: BrowserApp;

  beforeEach(async () => {
    t = await openApp();
    // A short wait before she replies, and quick typing, so tests are fast.
    t.app.store.updateSettings({ replyDebounceSeconds: 0.1, typingBaseMs: 50, typingPerCharMs: 1 });
    await t.page.reload();
    await t.page.waitForSelector(".channel-link");
  });

  afterEach(async () => {
    await t.close();
  });

  afterAll(closeBrowser);

  test("opens #general, and you can text her", async () => {
    const { page, fake } = t;
    expect(await page.textContent("#channel-name")).toBe("general");
    fake.replies.push({ content: "hiii **you**" });
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    await page.fill("#composer-input", "hey");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.message[data-author="kitsikai"]');
    const texts = await page.$$eval(".message .message-content", (nodes) => nodes.map((n) => n.innerHTML));
    expect(texts).toEqual(["hey", "hiii <strong>you</strong>"]);
    expect(t.errors).toEqual([]);
  });

  test("shows an error with Try again when the reply fails, and retrying works", async () => {
    const { page, fake } = t;
    fake.replies.push({ status: 500, error: "boom" });
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    await page.fill("#composer-input", "hello?");
    await page.click("#send-button");
    await page.waitForSelector("#error:not([hidden])");
    expect(await page.textContent("#error-text")).toContain("boom");
    fake.replies.push({ content: "sorry" });
    await page.click("#error-retry");
    await page.waitForSelector('.message[data-author="kitsikai"]');
    expect(t.errors).toEqual([]);
  });

  test("settings, profiles, appearance and channel settings open and save", async () => {
    const { page, app } = t;
    await page.click("#settings-button");
    await page.fill("#setting-name", "Kit");
    await page.click('#settings-form button[type="submit"]');
    await page.waitForSelector("#settings-dialog", { state: "hidden" });
    expect(app.store.getSettings().name).toBe("Kit");
    expect(await page.textContent("#kitsikai-name")).toBe("Kit");

    await page.click("#settings-button");
    await page.click("#open-models");
    await page.waitForSelector("#models-dialog[open] .profile-row");
    await page.click("#models-dialog [data-close]");
    await page.click("#settings-dialog [data-close]");

    await page.click("#appearance-button");
    await page.click('.theme-card:has-text("Rainy Window")');
    await page.waitForFunction('document.getElementById("theme-app")?.getAttribute("href")?.includes("rainy-window")');
    expect(app.store.getSettings().appTheme).toBe("rainy-window");
    await page.click("#appearance-dialog [data-close]");

    await page.click("#channel-settings-button");
    await page.fill("#channel-setting-name", "Late Night");
    await page.click('#channel-form button[type="submit"]');
    await page.waitForFunction('document.getElementById("channel-name")?.textContent === "late-night"');
    expect(t.errors).toEqual([]);
  });

  test("regenerate replaces her last reply", async () => {
    const { page, fake, app } = t;
    const channel = app.store.listChannels()[0]!;
    app.store.addMessage({ channelId: channel.id, author: "kitsikai", content: "first try" });
    await page.reload();
    await page.waitForSelector('.message-actions.always button:has-text("Regenerate")');
    fake.replies.push({ content: "second try" });
    await page.click('button:has-text("Regenerate")');
    await page.waitForSelector('.message-content:has-text("second try")');
    expect(await page.$$eval(".message-content", (nodes) => nodes.map((n) => n.textContent))).toEqual(["second try"]);
  });

  test("her bubbles appear one at a time, with the typing indicator between", async () => {
    const { page, fake, app } = t;
    app.store.updateSettings({ typingBaseMs: 400, typingPerCharMs: 0 });
    await page.reload();
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    fake.replies.push({ content: "omg<cht>wait<cht>tell me" });
    await page.fill("#composer-input", "guess what");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.message[data-author="kitsikai"]');
    // The first bubble at once, then the typing indicator for the next.
    expect(await page.$$eval('.message[data-author="kitsikai"]', (n) => n.length)).toBe(1);
    expect(await page.isVisible("#status")).toBe(true);
    await page.waitForFunction("document.querySelectorAll('.message[data-author=kitsikai]').length === 3");
    expect(await page.isVisible("#status")).toBe(false);
    expect(t.errors).toEqual([]);
  });

  test("double-tapping the typing indicator shows the rest at once", async () => {
    const { page, fake, app } = t;
    app.store.updateSettings({ typingBaseMs: 10_000 });
    await page.reload();
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    fake.replies.push({ content: "one<cht>two<cht>three" });
    await page.fill("#composer-input", "hi");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#status.revealing");
    await page.click("#status-text");
    await page.click("#status-text");
    await page.waitForFunction("document.querySelectorAll('.message[data-author=kitsikai]').length === 3");
    expect(await page.isVisible("#status")).toBe(false);
  });

  test("bubbles you send quickly get one reply", async () => {
    const { page, fake, app } = t;
    app.store.updateSettings({ replyDebounceSeconds: 0.6 });
    await page.reload();
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    for (const text of ["hey", "so", "guess what"]) {
      await page.fill("#composer-input", text);
      await page.keyboard.press("Enter");
    }
    await page.waitForSelector('.message[data-author="kitsikai"]');
    expect(fake.requests).toHaveLength(1);
    expect(await page.$$eval(".message.pending", (n) => n.length)).toBe(0);
    expect(await page.$$eval('.message[data-author="user"] .message-content', (n) => n.map((e) => e.textContent))).toEqual([
      "hey",
      "so",
      "guess what",
    ]);
  });

  test("channels can be made with a topic, and a reply elsewhere marks that channel unread", async () => {
    const { page, app, fake } = t;
    await page.click("#new-channel-button");
    await page.fill("#new-channel-name", "Gaming");
    await page.fill("#new-channel-topic", "games and streams");
    await page.click('#new-channel-form button[type="submit"]');
    await page.waitForFunction('document.getElementById("channel-name").textContent === "gaming"');
    expect(await page.textContent("#channel-topic")).toBe("games and streams");

    // Back to #general; she writes in #gaming.
    await page.click('.channel-link:has-text("general")');
    await page.waitForFunction('document.getElementById("channel-name").textContent === "general"');
    const gaming = app.store.listChannels().find((c) => c.name === "gaming")!;
    fake.replies.push({ content: "gg" });
    await app.kitsikai.takeTurn(gaming.id, "continue");
    await page.waitForSelector('.channel-link.unread:has-text("gaming")');
    await page.click('.channel-link:has-text("gaming")');
    await page.waitForSelector('.message-content:has-text("gg")');
    expect(await page.$$eval(".channel-link.unread", (n) => n.length)).toBe(0);
    expect(t.errors).toEqual([]);
  });

  test("the planner: add a plan, see it on the calendar and the weekly list, edit and delete it", async () => {
    const { page, app } = t;
    await page.click('.channel-link:has-text("planner")');
    await page.waitForSelector(".calendar-day");
    expect(await page.isVisible("#composer")).toBe(false);

    // An overnight shift with draw hours, on the selected day (today).
    await page.click("#planner-add");
    await page.selectOption("#plan-kind", "shift");
    expect(await page.inputValue("#plan-title-input")).toBe("Work");
    await page.fill("#plan-start-time", "22:00");
    await page.fill("#plan-end-time", "06:00");
    await page.fill("#plan-draw-start", "23:00");
    await page.fill("#plan-draw-end", "03:30");
    expect(await page.textContent("#plan-draw-time")).toContain("4h 30m");
    await page.click('#plan-form button[type="submit"]');
    await page.waitForSelector(".calendar-day .shift-chip");
    expect(await page.textContent(".calendar-day .shift-chip")).toBe("10:00p–6:00a");
    const [plan] = app.store.plans.list();
    expect(plan).toMatchObject({ kind: "shift", endTime: "06:00", drawStart: "23:00", checked: true });
    expect(plan!.endDate! > plan!.startDate).toBe(true);
    await page.waitForSelector('.shift-card:has-text("Draw time 4h 30m")');

    // The weekly list shows it with its totals.
    await page.click('.planner-tab[data-view="week"]');
    await page.waitForSelector(".shift-row");
    expect(await page.textContent(".week-totals")).toBe("Shift hours 8h · Draw time 4h 30m");

    // Edit it into a meeting, then delete it.
    await page.click(".shift-row");
    await page.selectOption("#plan-shift-type", "meeting");
    expect(await page.isVisible("#plan-draw-fields")).toBe(false);
    await page.click('#plan-form button[type="submit"]');
    await page.waitForSelector('.shift-row[data-shift-type="meeting"]');
    page.once("dialog", (dialog) => dialog.accept());
    await page.click(".shift-row");
    await page.click("#plan-delete");
    await page.waitForSelector(".shift-row", { state: "detached" });
    expect(app.store.plans.list()).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  test("linked shifts: 'overnight after' shows the hotel night on the calendar, the day card and the weekly list", async () => {
    const { page, app } = t;
    // Tomorrow's shift, for today's to link to.
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    app.store.plans.create({ kind: "shift", title: "Work", startDate: iso(tomorrow), startTime: "07:00", endTime: "15:00", checked: true });

    await page.click('.channel-link:has-text("planner")');
    await page.waitForSelector(".calendar-day");
    await page.click("#planner-add");
    await page.selectOption("#plan-kind", "shift");
    await page.fill("#plan-start-time", "06:00");
    await page.fill("#plan-end-time", "14:00");
    await page.check('#plan-form input[name="overnight"]');
    await page.click('#plan-form button[type="submit"]');
    await page.waitForSelector(".shift-chip.overnight");
    expect(await page.textContent(".shift-chip.overnight")).toBe("6:00a–2:00p 🏨");
    const label = `${tomorrow.toLocaleDateString("en-US", { weekday: "short" })} ${tomorrow.getMonth() + 1}/${tomorrow.getDate()}`;
    expect(await page.textContent(".plan-card-stay")).toBe(`🏨 Hotel night, then ${label} 7:00a`);
    expect(app.store.plans.list().filter((p) => p.overnight)).toHaveLength(1);

    // Opening it again shows the box ticked.
    await page.click(".plan-card-stay");
    expect(await page.isChecked('#plan-form input[name="overnight"]')).toBe(true);
    await page.click("#plan-dialog [data-close]");

    await page.click('.planner-tab[data-view="week"]');
    await page.waitForSelector(".shift-row-stay");
    expect(await page.textContent(".shift-row-stay")).toBe(`🏨 Hotel night, then ${label} 7:00a`);
    expect(t.errors).toEqual([]);
  });

  test("the calendar's weeks start on Sunday", async () => {
    const { page } = t;
    await page.click('.channel-link:has-text("planner")');
    await page.waitForSelector(".calendar-day");
    expect(await page.$$eval(".calendar-weekday", (nodes) => nodes.map((n) => n.textContent))).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    // The first day in the grid is a Sunday, and so is every 7th after it.
    const days = await page.$$eval(".calendar-day", (nodes) => nodes.map((n) => n.getAttribute("data-date")!));
    expect(days.length % 7).toBe(0);
    for (let i = 0; i < days.length; i += 7) {
      const [y, m, d] = days[i]!.split("-").map(Number);
      expect(new Date(y!, m! - 1, d!).getDay()).toBe(0);
    }
    expect(t.errors).toEqual([]);
  });

  test("the planner: plan errors show in the editor, and the calendar moves between months", async () => {
    const { page } = t;
    await page.click('.channel-link:has-text("planner")');
    await page.waitForSelector(".calendar-day");
    const title = await page.textContent("#planner-title");
    await page.click("#planner-next");
    await page.waitForFunction(`document.getElementById("planner-title").textContent !== ${JSON.stringify(title)}`);
    await page.click("#planner-today");
    await page.waitForFunction(`document.getElementById("planner-title").textContent === ${JSON.stringify(title)}`);

    await page.click("#planner-add");
    await page.fill("#plan-title-input", "");
    await page.click('#plan-form button[type="submit"]');
    await page.waitForSelector("#plan-form .form-error:not([hidden])");
    expect(await page.textContent("#plan-form .form-error")).toContain("needs a title");
  });

  test("channel settings for the planner hide what's only for chats", async () => {
    const { page } = t;
    await page.click('.channel-link:has-text("planner")');
    await page.click("#channel-settings-button");
    expect(await page.isVisible("#channel-home-row")).toBe(false);
    expect(await page.isVisible("#preview-prompt")).toBe(false);
    await page.click("#channel-dialog [data-close]");
    await page.click("#new-channel-button");
    expect(await page.isDisabled('#new-channel-form input[value="planner"]')).toBe(true);
  });

  test("screenshot import: read, review with warnings, fix a row, remove one, save", async () => {
    const { page, fake, app } = t;
    await page.click('.channel-link:has-text("planner")');
    await page.waitForSelector(".calendar-day");
    const today = new Date();
    const date = (offset: number) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    fake.replies.push({
      content: JSON.stringify({
        shifts: [
          { date: date(1), type: "regular", start: "09:00", end: "17:30", drawStart: null, drawEnd: null },
          { date: date(2), type: "regular", start: "22:00", end: "06:00", drawStart: "23:00", drawEnd: "03:00" },
          { date: date(3), type: "meeting", start: "08:00", end: "09:00" },
        ],
      }),
    });
    await page.setInputFiles("#import-file", { name: "schedule.png", mimeType: "image/png", buffer: Buffer.from("png") });
    await page.waitForSelector(".review-row[data-index='2']");
    expect(await page.textContent("#import-status-text")).toContain("found 3 shifts");
    // The first row has no draw hours: a warning, which doesn't block.
    expect(await page.textContent(".review-row[data-index='0'] .review-warning")).toContain("no draw hours");
    expect(await page.textContent(".review-row[data-index='1'] .review-draw-time")).toBe("4h draw");

    // Fix the first row's draw hours; the warning goes, and draw time appears.
    const draw = page.locator(".review-row[data-index='0'] .review-draw input");
    await draw.nth(0).fill("10:00");
    await draw.nth(1).fill("14:30");
    await page.waitForFunction("!document.querySelector(\".review-row[data-index='0'] .review-warning\")");
    expect(await page.textContent(".review-row[data-index='0'] .review-draw-time")).toBe("4h 30m draw");

    // A hotel night after the first shift, linked to the second: ticked by hand.
    await page.check(".review-row[data-index='0'] .review-overnight input");

    // Remove the meeting, then save.
    await page.click(".review-row[data-index='2'] .review-remove");
    expect(await page.textContent("#import-summary")).toBe("2 shifts");
    await page.click("#import-save");
    await page.waitForSelector("#import-dialog", { state: "hidden" });
    const plans = app.store.plans.list();
    expect(plans.map((p) => [p.drawStart, p.source, p.checked, p.overnight])).toEqual([
      ["10:00", "screenshot", true, true],
      ["23:00", "screenshot", true, false],
    ]);
    await page.waitForSelector(".shift-chip");
    expect(t.errors).toEqual([]);
  });

  test("trackers: make one, log today, edit the sticker from the strip, delete the tracker", async () => {
    const { page, app } = t;
    await page.click('.channel-link:has-text("trackers")');
    await page.waitForSelector(".trackers-empty");
    await page.click("#new-tracker");
    await page.fill("#tracker-name", "headache");
    await page.check('#tracker-form input[value="scale"]');
    await page.fill("#tracker-hints", "head, migraine");
    await page.click('#tracker-form button[type="submit"]');
    await page.waitForSelector('.tracker-card:has-text("headache")');
    expect(await page.textContent(".tracker-hints")).toBe("headmigraine");

    await page.selectOption(".quick-log-scale", "7");
    await page.click('.quick-log button:has-text("Log")');
    await page.waitForSelector(".tracker-day.today .log-sticker");
    expect(await page.textContent(".tracker-day.today .log-sticker")).toBe("7/10");

    await page.click(".tracker-day.today .log-sticker");
    expect(await page.textContent("#log-entry-source")).toBe("You added this.");
    await page.selectOption("#log-entry-value", "4");
    await page.click('#log-entry-form button[type="submit"]');
    await page.waitForFunction("document.querySelector('.tracker-day.today .log-sticker')?.textContent === '4/10'");
    expect(app.store.trackers.entries()[0]).toMatchObject({ value: "4", source: "user" });

    page.once("dialog", (dialog) => dialog.accept());
    await page.click(".tracker-edit");
    await page.click("#tracker-delete");
    await page.waitForSelector(".trackers-empty");
    expect(app.store.trackers.entries()).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  test("stickers on calendar days, and 'show the message' jumps to where one came from", async () => {
    const { page, app } = t;
    const general = app.store.listChannels()[0]!;
    const message = app.store.addMessage({ channelId: general.id, author: "user", content: "took my meds finally" });
    const meds = app.store.trackers.create({ name: "meds", kind: "yesno" });
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    app.store.trackers.addEntry({ trackerId: meds.id, date: today, value: "yes", source: "processing", messageId: message.id });
    const headache = app.store.trackers.create({ name: "headache", kind: "note" });

    await page.click('.channel-link:has-text("planner")');
    await page.waitForSelector(".calendar-day.today .calendar-stickers");
    await page.waitForSelector('.day-stickers .log-sticker:has-text("meds ✓")');

    // Add another from the day panel.
    await page.click(".day-sticker-add");
    await page.selectOption("#log-entry-tracker", headache.id);
    await page.fill("#log-entry-value", "mild, afternoon");
    await page.click('#log-entry-form button[type="submit"]');
    await page.waitForSelector('.day-stickers .log-sticker:has-text("mild, afternoon")');

    // The meds sticker came from chat: show that message.
    await page.click('.day-stickers .log-sticker:has-text("meds")');
    expect(await page.textContent("#log-entry-source")).toContain("processing");
    await page.click("#log-entry-message .message-link");
    await page.waitForSelector(`.message.highlighted[data-message-id="${message.id}"]`);
    expect(await page.textContent("#channel-name")).toBe("general");
    expect(t.errors).toEqual([]);
  });

  test("a tracker she makes, and a sticker she logs, show up while you look", async () => {
    const { page, app } = t;
    const general = app.store.listChannels()[0]!;
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    await page.click('.channel-link:has-text("planner")');
    await page.waitForSelector(".calendar-day.today");
    const ctx = { store: app.store, channel: general, now: new Date(), events: app.events };
    expect((await runTool(ctx, "make_tracker", { name: "headache", records: "1 to 10" })).ok).toBe(true);
    expect((await runTool(ctx, "log_sticker", { tracker: "headache", value: "6" })).ok).toBe(true);
    await page.waitForSelector('.day-stickers .log-sticker:has-text("headache")');
    await page.click('.day-stickers .log-sticker:has-text("headache")');
    expect(await page.textContent("#log-entry-source")).toBe("She logged this herself, from chat.");
    expect(t.errors).toEqual([]);
  });

  test("images: pick one, send it with text, see what she sees, fix it, view it big", async () => {
    const { page, app, fake } = t;
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    const png = { name: "dog.png", mimeType: "image/png", buffer: testPng(80, 60) };

    // Picked, then taken out again: nothing is sent.
    await page.setInputFiles("#attach-input", png);
    await page.waitForSelector(".composer-attachment img");
    await page.click(".composer-attachment-remove");
    expect(await page.isVisible("#composer-attachments")).toBe(false);

    fake.replies.push({ content: "A puppy on a blue couch.", delayMs: 300 }, { content: "cute!!" });
    await page.setInputFiles("#attach-input", png);
    await page.waitForSelector(".composer-attachment img");
    await page.fill("#composer-input", "look");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.image-seen[data-status="reading"]');
    await page.waitForSelector('.image-seen[data-status="read"]');
    expect(await page.textContent(".image-seen")).toBe("What Kitsikai sees: A puppy on a blue couch.");
    await page.waitForSelector('.message[data-author="kitsikai"]:has-text("cute!!")');
    expect(await page.$$eval('.message[data-author="user"] .message-content', (nodes) => nodes.map((n) => n.textContent))).toEqual(["look"]);
    const [sent] = app.store.getMessages(app.store.listChannels()[0]!.id).filter((m) => m.image);
    expect(await page.getAttribute(".message-image img", "src")).toBe(`/api/images/${sent!.id}`);

    // Fix what she sees.
    await page.click(".message-image img");
    await page.waitForSelector("#image-viewer[open]");
    await page.click("#image-viewer");
    await page.waitForSelector("#image-viewer", { state: "hidden" });
    await page.click(`.message[data-message-id="${sent!.id}"]`);
    expect(await page.isVisible(`.message[data-message-id="${sent!.id}"] button:has-text("Read again")`)).toBe(true);
    await page.click(`.message[data-message-id="${sent!.id}"] button:has-text("Edit what she sees")`);
    await page.fill(".edit-box", "A puppy on a green couch.");
    await page.click('.message-actions button:has-text("Save")');
    await page.waitForSelector('.image-seen:has-text("(you edited it)")');
    expect(app.store.getMessage(sent!.id).content).toBe("A puppy on a green couch.");

    // Its own setting, next to the screenshot reader.
    await page.click("#settings-button");
    expect(await page.$eval("#setting-image-assignment", (s: any) => s.options[s.selectedIndex].text)).toBe("Same as screenshots");
    await page.click("#settings-dialog [data-close]");
    expect(t.errors).toEqual([]);
  });

  test("planner changes she offers: a card under her reply, Yes adds it, No doesn't", async () => {
    const { page, app, fake } = t;
    app.store.profiles.update(app.store.profiles.list()[0]!.id, { supportsTools: true });
    await page.reload();
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    fake.replies.push(
      { toolCalls: [{ name: "add_plan", arguments: { kind: "hangout", title: "Movie night", date: "tomorrow", start_time: "8pm" } }] },
      { toolCalls: [{ name: "add_plan", arguments: { kind: "hangout", title: "Board games", date: "tomorrow", start_time: "6pm" } }] },
      { content: "movie night at 8, or board games at 6?" },
    );
    await page.fill("#composer-input", "we should do something tomorrow");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.plan-change[data-status="pending"] >> nth=1');
    expect(await page.$$eval(".plan-change-summary", (nodes) => nodes.map((n) => n.textContent))).toEqual([
      expect.stringMatching(/^📅 Add: .*: Hangout: Movie night, 8:00p$/),
      expect.stringMatching(/^📅 Add: .*: Hangout: Board games, 6:00p$/),
    ]);
    await page.click('.plan-change:has-text("Movie night") button:has-text("Yes")');
    await page.waitForSelector('.plan-change[data-status="applied"]:has-text("Movie night")');
    await page.click('.plan-change:has-text("Board games") button:has-text("No")');
    await page.waitForSelector('.plan-change[data-status="declined"]:has-text("Board games")');
    expect(await page.textContent('.plan-change[data-status="declined"] .plan-change-status')).toBe("✕ Not done (you tapped No)");
    expect(app.store.plans.list().map((p) => p.title)).toEqual(["Movie night"]);
    // After a reload, the cards are still there, settled.
    await page.reload();
    await page.waitForSelector('.plan-change[data-status="applied"]');
    expect(await page.locator(".plan-change button").count()).toBe(0);
    expect(t.errors).toEqual([]);
  });

  test("her lookups show under her reply, open into details, and fill the tool log", async () => {
    const { page, fake } = t;
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    fake.replies.push(
      { toolCalls: [{ name: "list_trackers", arguments: {} }] },
      { content: "nothing tracked yet<cht>want me to watch for something?" },
    );
    await page.fill("#composer-input", "what are you keeping an eye on");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".activity-summary");
    expect(await page.textContent(".activity-summary")).toBe("⚙ Kitsikai looked at the trackers");
    // The activity line comes after both bubbles.
    const order = await page.$$eval(".messages > *", (nodes) => nodes.map((n) => n.className.split(" ")[0]));
    expect(order.slice(-3)).toEqual(["message", "message", "activity"]);
    await page.click(".activity-summary");
    await page.waitForSelector(".activity-details .tool-call-name:has-text('list_trackers')");

    await page.click("#channel-settings-button");
    await page.click("#open-tool-log");
    await page.waitForSelector("#tool-log-list .tool-call");
    expect(await page.$$eval("#tool-log-list .tool-call", (n) => n.length)).toBe(1);
    expect(t.errors).toEqual([]);
  });

  test("her memory settings save, and Test Jev shows what came back", async () => {
    const { page, app, fake } = t;
    await page.click("#settings-button");
    expect(await page.inputValue("#setting-decision-model")).toBe("typesafe/jev-1.13");
    expect(await page.inputValue("#setting-decision-fallback")).toBe("");
    fake.jevReplies.push({ pet: { selected: "yes", p: 0.97 } });
    await page.click("#test-jev");
    await page.waitForSelector("#jev-test-result.ok");
    expect(await page.textContent("#jev-test-result p")).toBe('✓ Jev answered "yes", 97% sure, as expected. It\'s working.');

    // The Jev log has that call, with everything sent and received.
    fake.jevReplies.push({ status: 503, error: "Model unavailable" });
    await page.click("#test-jev");
    await page.waitForSelector("#jev-test-result.failed");
    await page.click("#open-jev-log");
    await page.waitForSelector("#jev-log-dialog[open] .jev-call");
    expect(await page.$$eval(".jev-call .tool-call-name", (nodes) => nodes.map((n) => n.textContent))).toEqual(["Test Jev", "Test Jev"]);
    expect(await page.textContent("#jev-log-count")).toMatch(/^2 calls to Jev in the last 36 hours, 1 with an error/);
    expect(await page.textContent('.jev-call[data-status="error"] .tool-call-summary')).toContain("HTTP 503");
    expect(await page.textContent('.jev-call[data-status="ok"] .tool-call-summary')).toBe("pet: yes (97%)");
    await page.click('.jev-call[data-status="ok"] summary');
    expect(await page.textContent('.jev-call[data-status="ok"] .jev-call-part pre')).toContain("guess what, I just got a puppy");
    expect(await page.textContent('.jev-call[data-status="ok"] .tool-call-raw')).toContain('"response_format"');
    await page.check("#jev-log-errors");
    expect(await page.locator(".jev-call").count()).toBe(1);
    await page.click("#jev-log-dialog [data-close]");

    await page.fill("#setting-processing-hours", "2");
    await page.fill("#setting-pin-cap", "5");
    await page.fill("#setting-confidence", "0.9");
    await page.click('#settings-form button[type="submit"]');
    await page.waitForSelector("#settings-dialog", { state: "hidden" });
    expect(app.store.getSettings()).toMatchObject({ processingHours: 2, pinCap: 5, decisionConfidence: 0.9, decisionFallback: "" });
    expect(t.errors).toEqual([]);
  });

  test("the advanced page: her notes from chat, Process now, and the log links to the message", async () => {
    const { page, app, fake } = t;
    app.store.trackers.create({ name: "headache", kind: "scale" });
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    fake.jevReplies.push({ t1: "yes", "t1_day": "today", "t1_level": "7" });
    fake.replies.push({ content: "ugh noted 📌" });
    await page.fill("#composer-input", "my head is killing me, like a 7");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.message[data-author="kitsikai"]');

    // Hidden until "Show advanced" is ticked.
    await page.click("#settings-button");
    expect(await page.isHidden("#open-notes")).toBe(true);
    await page.check("#setting-show-advanced");
    await page.click("#open-notes");
    await page.waitForSelector("#notes-scratchpad .note-card");
    expect(await page.textContent("#notes-scratchpad .memory-card-text")).toMatch(/^headache 7\/10 on \w+, \w+ \d+$/);
    expect(await page.textContent("#notes-pins .memory-empty")).toBe("Nothing pinned right now.");
    expect(await page.textContent("#notes-log .memory-round-title")).toBe("During chat");

    fake.jevReplies.push({ n1: "yes" });
    await page.click("#process-now");
    await page.waitForSelector('#notes-log .memory-round[data-trigger="manual"]');
    expect(await page.textContent('.memory-round[data-trigger="manual"] .memory-log-action')).toBe("Saved");
    expect(await page.textContent("#notes-scratchpad .memory-empty")).toBe("Nothing waiting to be processed.");
    expect(app.store.trackers.entries()).toEqual([expect.objectContaining({ value: "7", source: "processing" })]);

    // "show the message" jumps to where it came from.
    await page.click('.memory-round[data-trigger="manual"] .memory-source');
    await page.waitForSelector("#notes-dialog", { state: "hidden" });
    await page.waitForSelector(".message.highlighted");
    expect(await page.textContent(".message.highlighted .message-content")).toBe("my head is killing me, like a 7");
    expect(t.errors).toEqual([]);
  });

  test("importing a chat: a preview without text, then a new channel with the history", async () => {
    const { page, app } = t;
    const file = [
      { user_name: "Sam", character_name: "Kitsikai" },
      // Midday UTC: June 26 in any time zone the browser might be in.
      { name: "Sam", is_user: true, send_date: "2026-06-26T12:00:00Z", mes: "hey you" },
      { name: "Kitsikai", is_user: false, send_date: "2026-06-26T12:01:00Z", mes: "hiii<cht>how was work" },
      { name: "System", is_user: false, is_system: true, mes: "hidden" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    await page.click("#settings-button");
    await page.click("#open-import-chat");
    await page.setInputFiles("#import-chat-file", { name: "chat.jsonl", mimeType: "application/jsonl", buffer: Buffer.from(file) });
    await page.waitForSelector("#import-chat-preview.ok");
    expect(await page.$$eval("#import-chat-preview p", (nodes) => nodes.map((n) => n.textContent))).toEqual([
      '2 messages: 1 from you (as "Sam"), 1 from her (as "Kitsikai").',
      "From Jun 26, 2026 to Jun 26, 2026.",
      "Left out: 1 hidden system messages.",
    ]);
    await page.fill('#import-chat-form input[name="newChannel"]', "old chat");
    await page.click("#import-chat-submit");
    await page.waitForSelector("#import-chat-dialog", { state: "hidden" });
    await page.waitForSelector('#channel-name:has-text("old-chat")');
    await page.waitForSelector('.message[data-author="kitsikai"] .message-content:has-text("how was work")');
    expect(await page.$$eval(".message .message-content", (nodes) => nodes.map((n) => n.textContent))).toEqual(["hey you", "hiii", "how was work"]);
    expect(await page.textContent("#notice-text")).toBe("Imported 3 messages into #old-chat.");
    expect(app.store.listChannels().map((c) => c.name)).toContain("old-chat");

    // A file it can't read shows its layout instead.
    await page.click("#settings-button");
    await page.click("#open-import-chat");
    await page.setInputFiles("#import-chat-file", { name: "odd.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([{ sender: "me", body: "hi" }])) });
    await page.waitForSelector("#import-chat-preview.failed pre");
    expect(await page.textContent("#import-chat-preview pre")).toBe("record 1: { sender: text, body: text }");
    expect(await page.isDisabled("#import-chat-submit")).toBe(true);
    expect(t.errors).toEqual([]);
  });

  test("texting first: its settings save, and Check now texts a due reminder into the chat", async () => {
    const { page, app, fake } = t;
    // An appointment in an hour: its "2 hours before" reminder went off an hour ago.
    const start = new Date(Date.now() + 60 * 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    app.store.plans.create({
      kind: "appointment",
      title: "Dentist",
      startDate: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
      startTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
    });
    await page.waitForFunction("eventSource && eventSource.readyState === 1");

    await page.click("#settings-button");
    expect(await page.isChecked("#setting-text-first")).toBe(true);
    expect(await page.inputValue("#setting-double-text-cap")).toBe("judge");
    // No Termux here, so notifications say they're unavailable.
    expect(await page.isVisible("#notifications-unavailable")).toBe(true);
    await page.selectOption("#setting-double-text-cap", "2");
    await page.fill("#setting-snapshot-minutes", "15");
    await page.check("#setting-show-advanced");
    await page.click('#settings-form button[type="submit"]');
    await page.waitForSelector("#settings-dialog", { state: "hidden" });
    expect(app.store.getSettings()).toMatchObject({ doubleTextCap: 2, snapshotMinutes: 15, showAdvanced: true });

    await page.click("#settings-button");
    await page.click("#open-notes");
    await page.waitForSelector("#notes-proactive .reminder-due");
    expect(await page.textContent("#notes-proactive .reminder-due")).toMatch(/^Dentist \(appointment\), (today|tomorrow) at .* \(2 hours before\)$/);
    fake.replies.push({ content: "dentist in an hour!!" });
    await page.click("#check-now");
    await page.waitForSelector('.proactive-check-result[data-outcome="sent"]');
    expect(await page.textContent(".proactive-check-result")).toContain("Texted first: Reminders due: Dentist");
    expect(await page.textContent('#notes-proactive .reminder-record[data-status="sent"] .memory-log-action')).toBe("Sent");
    await page.click("#notes-dialog [data-close]");
    await page.click("#settings-dialog [data-close]");
    await page.waitForSelector('.message[data-author="kitsikai"] .message-content:has-text("dentist in an hour!!")');
    expect(t.errors).toEqual([]);
  });

  test("the safeword: a banner while she holds, Bring her back, and the intimacy settings", async () => {
    const { page, app } = t;
    await page.waitForFunction("eventSource && eventSource.readyState === 1");
    expect(await page.isVisible("#hold-banner")).toBe(false);
    await page.fill("#composer-input", "seriously");
    await page.keyboard.press("Enter");
    // The hold starts with her turn, and the app hears about it.
    await page.waitForSelector("#hold-banner:not([hidden])");
    expect(await page.textContent("#hold-banner")).toContain("Safeword heard");
    expect(app.store.intimacy.get()).not.toBeNull();

    await page.click("#hold-lift");
    await page.waitForSelector("#hold-banner", { state: "hidden" });
    expect(app.store.intimacy.get()).toBeNull();

    // Held again (say, after a reload), Settings shows it too, with its own button.
    app.store.intimacy.start(new Date(), null);
    await page.reload();
    await page.waitForSelector("#hold-banner:not([hidden])");
    await page.click("#settings-button");
    expect(await page.textContent("#hold-status-text")).toMatch(/^Holding since .+, after the safeword\.$/);
    expect(await page.isChecked("#setting-intimacy")).toBe(true);
    expect(await page.isChecked("#setting-notification-preview")).toBe(true);
    await page.click("#hold-status-lift");
    await page.waitForSelector("#hold-status", { state: "hidden" });
    expect(await page.isVisible("#hold-banner")).toBe(false);

    await page.uncheck("#setting-intimacy");
    await page.uncheck("#setting-notification-preview");
    await page.click('#settings-form button[type="submit"]');
    await page.waitForSelector("#settings-dialog", { state: "hidden" });
    expect(app.store.getSettings()).toMatchObject({ intimacyEnabled: false, notificationPreview: false });
    expect(t.errors).toEqual([]);
  });
});

