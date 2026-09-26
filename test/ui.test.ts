/**
 * Browser tests: the web app (public/) in a headless Chromium, against the
 * real server and a fake nanoGPT. Skipped when there's no browser (see
 * test/browser.ts).
 */

import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { CHROMIUM, closeBrowser, openApp, type BrowserApp } from "./browser.ts";

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
});

