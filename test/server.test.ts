/**
 * End-to-end tests for the server (src/server.ts), with a fake nanoGPT.
 *
 * Requests go straight to the app's `fetch` handler, so no port is opened for
 * Kitsikai itself, but everything behind it is real: routing, her turn,
 * prompt assembly, the HTTP call to the (fake) API, and the database.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMING, NUDGES } from "../src/prompt.ts";
import { appVersion, createApp, matchRoute, type App } from "../src/server.ts";
import type { Channel } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let call: ReturnType<typeof caller>;
/** The channel every new server starts with. */
let general: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  call = caller(app.fetch);
  [general] = app.store.listChannels() as [Channel];
});

afterEach(() => {
  app.store.close();
  fake.stop();
  dir.cleanup();
});

describe("a new server", () => {
  test("starts with #general, the planner, the trackers, and one profile", async () => {
    const { status, data } = await call("GET", "/api/state");
    expect(status).toBe(200);
    expect(data.channels.map((c: Channel) => c.name)).toEqual(["general", "planner", "trackers"]);
    expect(data.profiles).toHaveLength(1);
    expect(data.settings.name).toBe("Kitsikai");
    expect(data.settings.persona).toContain("i live in my own app now");
    expect(data.busyChannels).toEqual([]);
    expect(data.appVersion).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("sending a message", () => {
  test("saves your bubble at once, and her reply comes after the wait, with the model and profile", async () => {
    fake.replies.push({ content: "heyyy how was your day" });
    const { status, data } = await call("POST", `/api/channels/${general.id}/messages`, { content: "  hi!  " });

    expect(status).toBe(200);
    expect(data.userMessages[0]).toMatchObject({ content: "hi!", author: "user" });
    expect(data.kitsikaiMessages).toBeUndefined();
    expect(app.replies.isWaiting(general.id)).toBe(true);

    await app.replies.flush();
    const [profile] = app.store.profiles.list();
    expect(app.store.getMessages(general.id).at(-1)).toMatchObject({
      content: "heyyy how was your day",
      author: "kitsikai",
      model: profile!.model,
      profile: profile!.name,
    });
  });

  test("sends her prompt stack and the profile's settings to the API", async () => {
    const [profile] = app.store.profiles.list();
    app.store.profiles.update(profile!.id, { temperature: 0.7, maxTokens: 321, model: "some/model", quirkPrompt: "No emojis." });
    app.store.updateSettings({ persona: "You love frogs.", userName: "Sam" });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "hello" });
    await app.replies.flush();

    const request = fake.requests[0]!;
    expect(request).toMatchObject({ model: "some/model", temperature: 0.7, max_tokens: 321, auth: "Bearer test-key" });
    const system = request.messages[0]!.content;
    expect(system).toContain(FRAMING);
    expect(system).toContain("You love frogs.");
    expect(system).toContain("The person you're texting is Sam.");
    expect(system).toContain("## Model notes\n\nNo emojis.");
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "hello" });
  });

  test("keeps your message when the reply fails, tells the app, and her turn answers it later", async () => {
    const events: any[] = [];
    app.events.listen((event) => events.push(event));
    fake.replies.push({ status: 500, error: "boom" });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "you there?" });
    await app.replies.flush();
    expect(events.find((e) => e.type === "turn-error")).toMatchObject({ channelId: general.id });
    expect(events.find((e) => e.type === "turn-error").error).toContain("boom");
    expect(app.store.getMessages(general.id).map((m) => m.author)).toEqual(["user"]);

    fake.replies.push({ content: "sorry!! here" });
    const retry = await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(retry.data.kitsikaiMessages[0].content).toBe("sorry!! here");
    // The retry answers your message: it's the last thing in the prompt.
    expect(fake.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: "you there?" });
  });

  test("refuses empty messages and unknown channels", async () => {
    expect((await call("POST", `/api/channels/${general.id}/messages`, { content: "   " })).status).toBe(400);
    expect((await call("POST", `/api/channels/nope/messages`, { content: "hi" })).status).toBe(404);
  });
});

describe("her turn without a message from you", () => {
  test("opens an empty channel with the opening note", async () => {
    fake.replies.push({ content: "hiii" });
    const { data } = await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(data.kitsikaiMessages[0].content).toBe("hiii");
    expect(fake.requests[0]!.messages.at(-1)).toEqual({ role: "user", content: NUDGES.opening });
  });

  test("continues after her own message with the continue note", async () => {
    app.store.addMessage({ channelId: general.id, author: "kitsikai", content: "morning!" });
    await call("POST", `/api/channels/${general.id}/turn`, {});
    const messages = fake.requests[0]!.messages;
    expect(messages.at(-2)).toEqual({ role: "assistant", content: "morning!" });
    expect(messages.at(-1)).toEqual({ role: "user", content: NUDGES.continue });
  });

  test("strips <think> reasoning from the reply", async () => {
    fake.replies.push({ content: "<think>they seem tired</think>you sound tired" });
    const { data } = await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(data.kitsikaiMessages[0].content).toBe("you sound tired");
  });
});

describe("regenerating", () => {
  test("replaces her last reply, leaving it out of the prompt", async () => {
    app.store.addMessage({ channelId: general.id, author: "user", content: "hi" });
    const [old] = app.store.addTurn([{ channelId: general.id, author: "kitsikai", content: "old reply" }]);
    fake.replies.push({ content: "new reply" });

    const { data } = await call("POST", `/api/channels/${general.id}/regenerate`, {});
    expect(data.replacedIds).toEqual([old!.id]);
    expect(data.kitsikaiMessages[0].content).toBe("new reply");
    expect(app.store.getMessages(general.id).map((m) => m.content)).toEqual(["hi", "new reply"]);
    expect(JSON.stringify(fake.requests[0]!.messages)).not.toContain("old reply");
  });

  test("with a chosen profile", async () => {
    const other = app.store.profiles.create({ name: "Other", model: "other/model" });
    app.store.addMessage({ channelId: general.id, author: "kitsikai", content: "old" });
    const { data } = await call("POST", `/api/channels/${general.id}/regenerate`, { profileId: other.id });
    expect(data.kitsikaiMessages[0]).toMatchObject({ profile: "Other", model: "other/model" });
    expect(fake.requests[0]!.model).toBe("other/model");
  });

  test("keeps the old reply if the new one fails", async () => {
    app.store.addMessage({ channelId: general.id, author: "kitsikai", content: "keep me" });
    fake.replies.push({ status: 500, error: "nope" });
    const { status } = await call("POST", `/api/channels/${general.id}/regenerate`, {});
    expect(status).toBe(502);
    expect(app.store.getMessages(general.id).map((m) => m.content)).toEqual(["keep me"]);
  });

  test("needs her message last", async () => {
    app.store.addMessage({ channelId: general.id, author: "user", content: "hi" });
    const { status, data } = await call("POST", `/api/channels/${general.id}/regenerate`, {});
    expect(status).toBe(400);
    expect(data.error).toContain("nothing to regenerate");
  });
});

describe("the Stop button", () => {
  test("stops her turn: nothing is saved and the channel is free straight away", async () => {
    fake.replies.push({ content: "too late", delayMs: 300 });
    const turn = call("POST", `/api/channels/${general.id}/turn`, {});
    await Bun.sleep(50);
    const stop = await call("POST", `/api/channels/${general.id}/cancel`, {});
    expect(stop.data).toEqual({ cancelled: true });
    expect(app.kitsikai.isBusy(general.id)).toBe(false);
    expect((await turn).data).toEqual({ cancelled: true });
    expect(app.store.getMessages(general.id)).toHaveLength(0);
  });

  test("says so when nothing was running", async () => {
    expect((await call("POST", `/api/channels/${general.id}/cancel`, {})).data).toEqual({ cancelled: false });
  });

  test("a model that stalls halfway times out instead of hanging forever", async () => {
    const slowDir = tempDir();
    const slow = createApp(testConfig(slowDir.path, fake.baseUrl, { requestTimeoutMs: 200 }));
    const channel = slow.store.listChannels()[0]!;
    fake.replies.push({ stallMidReply: true });
    const { status, data } = await caller(slow.fetch)("POST", `/api/channels/${channel.id}/turn`, {});
    expect(status).toBe(502);
    expect(data.error).toContain("took longer than");
    expect(slow.kitsikai.isBusy(channel.id)).toBe(false);
    slow.store.close();
    slowDir.cleanup();
  });
});

describe("messages", () => {
  test("can be edited and deleted", async () => {
    const message = app.store.addMessage({ channelId: general.id, author: "user", content: "typo" });
    const edited = await call("PATCH", `/api/messages/${message.id}`, { content: "fixed" });
    expect(edited.data.message).toMatchObject({ content: "fixed" });
    expect(edited.data.message.editedAt).toBeString();
    expect((await call("DELETE", `/api/messages/${message.id}`, {})).status).toBe(200);
    expect((await call("GET", `/api/channels/${general.id}/messages`)).data.messages).toEqual([]);
    expect((await call("DELETE", `/api/messages/${message.id}`, {})).status).toBe(404);
  });

  test("a channel can be cleared", async () => {
    app.store.addMessage({ channelId: general.id, author: "user", content: "a" });
    await call("DELETE", `/api/channels/${general.id}/messages`, {});
    expect(app.store.getMessages(general.id)).toEqual([]);
  });
});

describe("settings", () => {
  test("can be changed, and are checked", async () => {
    const { data } = await call("PUT", "/api/settings", { name: "Kit", userName: "Sam", historyLimit: 12 });
    expect(data.settings).toMatchObject({ name: "Kit", userName: "Sam", historyLimit: 12 });
    expect((await call("PUT", "/api/settings", { historyLimit: 0 })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { name: "" })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { appTheme: "no-such-theme" })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { chatAssignment: "profile:nope" })).status).toBe(404);
    expect((await call("PUT", "/api/settings", { chatAssignment: "banana" })).status).toBe(400);
  });

  test("the history limit decides how much she sees", async () => {
    for (let i = 1; i <= 5; i++) app.store.addMessage({ channelId: general.id, author: i % 2 ? "user" : "kitsikai", content: `m${i}` });
    await call("PUT", "/api/settings", { historyLimit: 2 });
    await call("POST", `/api/channels/${general.id}/turn`, {});
    const history = fake.requests[0]!.messages.slice(1);
    expect(history).toEqual([
      { role: "assistant", content: "m4" },
      { role: "user", content: "m5" },
    ]);
  });
});

describe("channels", () => {
  test("can be renamed (Discord-style), themed and given their own profile", async () => {
    const other = app.store.profiles.create({ name: "Other", model: "o/m" });
    const { data } = await call("PATCH", `/api/channels/${general.id}`, {
      name: "Late Night",
      theme: "rainy-window",
      assignment: `profile:${other.id}`,
    });
    expect(data.channel).toMatchObject({ name: "late-night", theme: "rainy-window", assignment: `profile:${other.id}` });
    await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(fake.requests[0]!.model).toBe("o/m");
    expect((await call("PATCH", `/api/channels/${general.id}`, { theme: "nope" })).status).toBe(400);
  });

  test("the prompt preview shows exactly what a turn would send", async () => {
    app.store.addMessage({ channelId: general.id, author: "user", content: "hey" });
    const preview = await call("GET", `/api/channels/${general.id}/prompt`);
    await call("POST", `/api/channels/${general.id}/turn`, {});
    // The time can differ by a minute between the two, so compare the rest.
    const withoutTime = (messages: { content: string }[]) =>
      messages.map((m) => m.content.replace(/## Right now\n\n.*\n/, ""));
    expect(withoutTime(preview.data.messages)).toEqual(withoutTime(fake.requests[0]!.messages));
    expect(preview.data.profile.id).toBe(app.store.profiles.list()[0]!.id);
  });
});

describe("profiles over the API", () => {
  test("can be made, changed, tested and deleted", async () => {
    const made = await call("POST", "/api/profiles", { name: "GLM", model: "zai/glm" });
    expect(made.data.profile).toMatchObject({ name: "GLM", supportsTools: true });
    const id = made.data.profile.id;
    expect((await call("PATCH", `/api/profiles/${id}`, { temperature: 1.1 })).data.profile.temperature).toBe(1.1);

    fake.replies.push({ toolCalls: [{ name: "check_in", arguments: { word: "lighthouse" } }] });
    const tested = await call("POST", `/api/profiles/${id}/test`, {});
    expect(tested.data.test.verdict).toBe("native");

    fake.replies.push({ content: '<tool_call>{"name": "check_in", "arguments": {"word": "lighthouse"}}</tool_call>' });
    expect((await call("POST", `/api/profiles/${id}/test`, {})).data.test.verdict).toBe("text");

    fake.replies.push({ content: "I can't do that." });
    expect((await call("POST", `/api/profiles/${id}/test`, {})).data.test.verdict).toBe("none");

    await call("PUT", "/api/settings", { chatAssignment: `profile:${id}` });
    const deleted = await call("DELETE", `/api/profiles/${id}`, {});
    expect(deleted.data.settings.chatAssignment).toBe("");
  });

  test("roulettes can be made and assigned", async () => {
    const [first] = app.store.profiles.list();
    const { data } = await call("POST", "/api/roulettes", { name: "Mix", entries: [{ profileId: first!.id, weight: 2 }] });
    expect((await call("PUT", "/api/settings", { chatAssignment: `roulette:${data.roulette.id}` })).status).toBe(200);
    const list = await call("GET", "/api/profiles");
    expect(list.data.roulettes).toHaveLength(1);
  });

  test("the model list comes from nanoGPT, sorted", async () => {
    expect((await call("GET", "/api/models")).data.models).toEqual(["alpha/model", "zeta/model"]);
  });
});

describe("themes over the API", () => {
  test("list, copy, edit and delete", async () => {
    const list = await call("GET", "/api/themes");
    expect(list.data.themes[0].id).toBe("classic");
    const made = await call("POST", "/api/themes", { name: "Mine", from: "rainy-window" });
    const id = made.data.theme.id;
    await call("PUT", "/api/settings", { appTheme: id });
    const edited = await call("PATCH", `/api/themes/${id}`, { css: ":root { --accent: red; }" });
    expect(edited.data.theme.css).toContain("red");
    const css = await app.fetch(new Request(`http://localhost/themes/${id}/theme.css`));
    expect(await css.text()).toContain("red");
    const deleted = await call("DELETE", `/api/themes/${id}`, {});
    expect(deleted.data.settings.appTheme).toBe("classic");
  });
});

describe("serving the app", () => {
  test("serves the page and its files", async () => {
    const page = await app.fetch(new Request("http://localhost/"));
    expect(await page.text()).toContain("<title>Kitsikai</title>");
    for (const file of ["/app.js", "/style.css", "/glass.js", "/sw.js", "/manifest.webmanifest", "/icon.svg"]) {
      expect((await app.fetch(new Request(`http://localhost${file}`))).status).toBe(200);
    }
  });

  test("never serves files outside public/", async () => {
    expect((await app.fetch(new Request("http://localhost/../.env"))).status).toBe(404);
    expect((await app.fetch(new Request("http://localhost/%2e%2e/package.json"))).status).toBe(404);
  });

  test("refuses API requests that change data unless they're JSON", async () => {
    const response = await app.fetch(
      new Request(`http://localhost/api/channels/${general.id}/turn`, { method: "POST", body: "x" }),
    );
    expect(response.status).toBe(415);
  });

  test("unknown API routes are 404s", async () => {
    expect((await call("GET", "/api/nope")).status).toBe(404);
  });

  test("the app version changes when the app's files change", () => {
    const copy = tempDir();
    cpSync(join(import.meta.dir, "..", "public"), copy.path, { recursive: true });
    const before = appVersion(copy.path);
    expect(appVersion(copy.path)).toBe(before);
    writeFileSync(join(copy.path, "app.js"), "// changed");
    expect(appVersion(copy.path)).not.toBe(before);
    copy.cleanup();
  });
});

describe("matchRoute", () => {
  test("matches patterns and decodes their parts", () => {
    const route = { method: "GET", pattern: "/api/channels/:id/messages" };
    expect(matchRoute(route, "GET", "/api/channels/a%20b/messages")).toEqual({ id: "a b" });
    expect(matchRoute(route, "POST", "/api/channels/a/messages")).toBeNull();
    expect(matchRoute(route, "GET", "/api/channels//messages")).toBeNull();
    expect(matchRoute(route, "GET", "/api/channels/%zz/messages")).toBeNull();
  });
});
