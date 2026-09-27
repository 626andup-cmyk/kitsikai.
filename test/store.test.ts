/**
 * Tests for the store (src/store.ts) and the database layout (src/db.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { MIGRATIONS, openDatabase, SCHEMA_VERSION } from "../src/db.ts";
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
    expect(store.listChannels().map((c) => c.name)).toEqual(["general", "planner", "trackers"]);

    // Opening it again doesn't seed again.
    store.close();
    store = new Store(dir.path);
    expect(store.listChannels()).toHaveLength(3);
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

  test("closes all the way, however many queries it has run (Bun alone keeps only 20)", () => {
    const db = openDatabase(join(dir.path, "many.db"));
    for (let i = 0; i < 50; i++) db.query(`SELECT ${i} AS n`).get();
    expect(db.query("SELECT 7 AS n").get()).toEqual({ n: 7 });
    // Throws "database is locked" if any query was left open.
    expect(() => db.close(true)).not.toThrow();
  });
});

describe("upgrading", () => {
  test("a stage 2 database gets planner and trackers channels at the bottom of its list", () => {
    store.close();
    // Build a database as stage 2 left it: migrations 1 and 2 only.
    const path = join(dir.path, "old.db");
    const db = new Database(path, { create: true, strict: true });
    db.exec(MIGRATIONS[0] as string);
    db.exec(MIGRATIONS[1] as string);
    db.exec("PRAGMA user_version = 2");
    db.query("INSERT INTO channels (id, name, kind, position, created_at) VALUES ('c1', 'general', 'text', 0, 'x')").run();
    db.query("INSERT INTO channels (id, name, kind, position, created_at) VALUES ('c2', 'gaming', 'text', 1, 'x')").run();
    db.close();

    const upgraded = openDatabase(path);
    const channels = upgraded.query("SELECT name, kind, position FROM channels ORDER BY position").all();
    expect(channels).toEqual([
      { name: "general", kind: "text", position: 0 },
      { name: "gaming", kind: "text", position: 1 },
      { name: "planner", kind: "planner", position: 2 },
      { name: "trackers", kind: "trackers", position: 3 },
    ]);
    upgraded.close();
    store = new Store(":memory:");
  });

  test("stickers survive the rebuild that lets her log them herself (migration 10)", () => {
    store.close();
    const path = join(dir.path, "old.db");
    const db = new Database(path, { create: true, strict: true });
    for (const step of MIGRATIONS.slice(0, 9)) typeof step === "string" ? db.exec(step) : step(db);
    db.exec("PRAGMA user_version = 9");
    db.query("INSERT INTO trackers (id, name, kind, hint_words, can_bring_up, position, created_at) VALUES ('t1', 'headache', 'scale', '[]', 1, 0, 'x')").run();
    const insert = (id: string, source: string) =>
      db.query(`INSERT INTO log_entries (id, tracker_id, date, value, source, created_at, updated_at) VALUES ('${id}', 't1', '2026-09-26', '6', '${source}', 'x', 'y')`).run();
    insert("e1", "confirmed");
    expect(() => insert("e2", "kitsikai")).toThrow(/CHECK/);
    db.close();

    const upgraded = openDatabase(path);
    expect(upgraded.query("SELECT id, tracker_id, date, value, source, message_id, created_at, updated_at FROM log_entries").all()).toEqual([
      { id: "e1", tracker_id: "t1", date: "2026-09-26", value: "6", source: "confirmed", message_id: null, created_at: "x", updated_at: "y" },
    ]);
    upgraded.query("INSERT INTO log_entries (id, tracker_id, date, value, source, created_at, updated_at) VALUES ('e2', 't1', '2026-09-27', '7', 'kitsikai', 'x', 'x')").run();
    expect(upgraded.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'log_entries' AND name NOT LIKE 'sqlite_%'").all()).toEqual([
      { name: "log_entries_by_date" },
    ]);
    // Deleting a tracker still deletes its stickers.
    upgraded.exec("PRAGMA foreign_keys = ON");
    upgraded.query("DELETE FROM trackers WHERE id = 't1'").run();
    expect(upgraded.query("SELECT COUNT(*) AS n FROM log_entries").get()).toEqual({ n: 0 });
    upgraded.close();
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
