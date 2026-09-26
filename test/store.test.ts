/**
 * Tests for the store (src/store.ts) and the database layout (src/db.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { SCHEMA_VERSION } from "../src/db.ts";
import { channelName, defaultSettings, Store, validateChannelUpdate, validateSettings } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

let dir: ReturnType<typeof tempDir>;
let store: Store;

beforeEach(() => {
  dir = tempDir();
  store = new Store(dir.path);
});

afterEach(() => {
  store.close();
  dir.cleanup();
});

describe("a new database", () => {
  test("is built by every migration, and seeded once", () => {
    const db = new Database(join(dir.path, "kitsikai.db"));
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    db.close();
    expect(store.listChannels().map((c) => c.name)).toEqual(["general"]);

    // Opening it again doesn't seed again.
    store.close();
    store = new Store(dir.path);
    expect(store.listChannels()).toHaveLength(1);
    expect(store.profiles.list()).toHaveLength(1);
  });

  test("refuses a database from a newer version", () => {
    store.close();
    const db = new Database(join(dir.path, "kitsikai.db"));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => new Store(dir.path)).toThrow(/newer version of Kitsikai/);
    store = new Store(":memory:");
  });
});

describe("settings", () => {
  test("start from the defaults, and keep what you change", () => {
    expect(store.getSettings()).toEqual(defaultSettings());
    store.updateSettings({ name: "Kit" });
    expect(store.getSettings()).toMatchObject({ name: "Kit", historyLimit: 40 });
  });

  test("are validated, dropping unknown fields", () => {
    expect(validateSettings({ name: " Kit ", banana: 1 })).toEqual({ name: "Kit" });
    expect(validateSettings({ chatAssignment: "" })).toEqual({ chatAssignment: "" });
    expect(() => validateSettings({ historyLimit: 1.5 })).toThrow(/whole number/);
    expect(() => validateSettings({ persona: 5 })).toThrow(/must be text/);
    expect(() => validateSettings({ themeOptions: { "rainy-window": { rain: "lots" } } })).toThrow(/numbers/);
    expect(() => validateSettings([])).toThrow(/JSON object/);
  });
});

describe("channels", () => {
  test("names are made Discord-style", () => {
    expect(channelName("  Work Stuff ")).toBe("work-stuff");
    expect(channelName("#gaming")).toBe("gaming");
    expect(() => channelName("   ")).toThrow();
    expect(() => channelName("x".repeat(101))).toThrow(/too long/);
  });

  test("updates are checked", () => {
    expect(validateChannelUpdate({ theme: "", assignment: null })).toEqual({ theme: null, assignment: null });
    expect(() => validateChannelUpdate({ theme: "Not A Theme!" })).toThrow(/theme id/);
  });
});

describe("messages", () => {
  test("are kept in order, and a turn's bubbles share an id", () => {
    const channel = store.listChannels()[0]!;
    store.addMessage({ channelId: channel.id, author: "user", content: "hi" });
    const turn = store.addTurn([
      { channelId: channel.id, author: "kitsikai", content: "hey" },
      { channelId: channel.id, author: "kitsikai", content: "what's up" },
    ]);
    expect(turn[0]!.turnId).toBe(turn[1]!.turnId!);
    expect(store.getMessages(channel.id).map((m) => m.content)).toEqual(["hi", "hey", "what's up"]);
    expect(store.lastKitsikaiTurn(channel.id).map((m) => m.content)).toEqual(["hey", "what's up"]);
    expect(store.recentMessages(channel.id, 2).map((m) => m.content)).toEqual(["hey", "what's up"]);
  });

  test("her last turn is empty when you spoke last", () => {
    const channel = store.listChannels()[0]!;
    store.addMessage({ channelId: channel.id, author: "kitsikai", content: "hey" });
    store.addMessage({ channelId: channel.id, author: "user", content: "hi" });
    expect(store.lastKitsikaiTurn(channel.id)).toEqual([]);
  });

  test("unknown ids are NotFoundErrors", () => {
    expect(() => store.getMessage("nope")).toThrow(/doesn't exist/);
    expect(() => store.getMessages("nope")).toThrow(/doesn't exist/);
    expect(() => store.editMessage("nope", "x")).toThrow(/doesn't exist/);
  });
});
