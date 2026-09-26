/**
 * Tests for prompt assembly (src/prompt.ts).
 */

import { describe, expect, test } from "bun:test";
import {
  buildPromptStack,
  describeChannels,
  describeNow,
  FRAMING,
  NUDGES,
  renderLayers,
  stripTimeMarkers,
  timeMarker,
  toChatHistory,
} from "../src/prompt.ts";
import { defaultSettings } from "../src/store.ts";
import type { Channel, Message } from "../src/types.ts";

const channel: Channel = {
  id: "c1",
  name: "general",
  kind: "text",
  topic: "",
  theme: null,
  assignment: null,
  position: 0,
  createdAt: "2026-09-26T10:00:00.000Z",
};

function message(author: Message["author"], content: string, createdAt = new Date()): Message {
  return { id: crypto.randomUUID(), channelId: "c1", author, content, turnId: null, createdAt: createdAt.toISOString() };
}

const now = new Date(2026, 8, 26, 16, 12); // Saturday, September 26, 2026, 4:12 PM (local time)

describe("buildPromptStack", () => {
  test("starts with who she is, how she texts, and the time", () => {
    const [system] = buildPromptStack({ settings: defaultSettings(), channel, messages: [], now });
    expect(system!.role).toBe("system");
    expect(system!.content).toStartWith(`## Who you are\n\n${FRAMING}`);
    expect(system!.content).toContain("You're Kitsikai");
    expect(system!.content).toContain("## How you text");
    expect(system!.content).toContain("<cht>");
    expect(system!.content).toContain("## Where you're texting\n\nYou're in #general.");
    expect(system!.content).toContain("## Right now\n\nIt's Saturday, September 26, 2026, 4:12 PM.");
    expect(system!.content).not.toContain("## Model notes");
  });

  test("adds your name and the model notes when there are some", () => {
    const settings = { ...defaultSettings(), userName: "Sam" };
    const [system] = buildPromptStack({ settings, channel, messages: [], now, modelNotes: "Short replies." });
    expect(system!.content).toContain("The person you're texting is Sam.");
    expect(system!.content).toEndWith("## Model notes\n\nShort replies.");
  });

  test("ends on your message, or a note when there isn't one", () => {
    const settings = defaultSettings();
    expect(buildPromptStack({ settings, channel, messages: [], now }).at(-1)).toEqual({ role: "user", content: NUDGES.opening });
    const hers = [message("kitsikai", "hi")];
    expect(buildPromptStack({ settings, channel, messages: hers, now }).at(-1)).toEqual({ role: "user", content: NUDGES.continue });
    const yours = [message("kitsikai", "hi"), message("user", "hey")];
    expect(buildPromptStack({ settings, channel, messages: yours, now }).at(-1)).toEqual({ role: "user", content: "hey" });
  });
});

describe("toChatHistory", () => {
  test("joins a run of bubbles with <cht>, and skips empty ones", () => {
    const history = toChatHistory([
      message("user", "one"),
      message("user", "two"),
      message("kitsikai", "  "),
      message("kitsikai", "three"),
      message("kitsikai", "four"),
    ]);
    expect(history).toEqual([
      { role: "user", content: "one <cht> two" },
      { role: "assistant", content: "three <cht> four" },
    ]);
  });

  test("notes when an hour or more has passed", () => {
    const morning = new Date(2026, 8, 26, 9, 0);
    const history = toChatHistory([
      message("user", "morning", morning),
      message("kitsikai", "hey", new Date(2026, 8, 26, 9, 5)),
      message("user", "back from work", new Date(2026, 8, 26, 17, 30)),
    ]);
    expect(history.map((m) => m.content)).toEqual(["morning", "hey", "[5:30 PM, 8 hours later] back from work"]);
  });
});

describe("time notes", () => {
  test("say the time and the gap, and the day when it changed", () => {
    const before = new Date(2026, 8, 26, 21, 0);
    expect(timeMarker(before, new Date(2026, 8, 26, 21, 40))).toBe("");
    expect(timeMarker(before, new Date(2026, 8, 26, 23, 0))).toBe("[11:00 PM, 2 hours later]");
    expect(timeMarker(before, new Date(2026, 8, 27, 9, 0))).toBe("[Sun 9:00 AM, 12 hours later]");
    expect(timeMarker(before, new Date(2026, 8, 29, 9, 0))).toBe("[Tue 9:00 AM, 3 days later]");
  });

  test("are taken out of her replies if she copies them", () => {
    expect(stripTimeMarkers("[11:00 PM, 2 hours later] hi")).toBe("hi");
    expect(stripTimeMarkers("[Sun 9:00 AM, 12 hours later] morning")).toBe("morning");
    expect(stripTimeMarkers("I'm [not a marker] really")).toBe("I'm [not a marker] really");
  });
});

describe("describeChannels", () => {
  test("names this channel and the other text channels, with topics", () => {
    const work = { ...channel, id: "c2", name: "work", topic: "shifts" };
    expect(describeChannels(channel, [channel, work])).toBe(
      "You're in #general. The channels split up your conversations, but you're one person: you remember everything from all of them.\n" +
        'The other channels: #work (topic: "shifts").',
    );
  });
});

describe("helpers", () => {
  test("renderLayers skips empty sections", () => {
    expect(
      renderLayers([
        { title: "A", content: "a" },
        { title: "B", content: "  " },
        { title: "C", content: null },
      ]),
    ).toBe("## A\n\na");
  });

  test("describeNow says the day and time like a person", () => {
    expect(describeNow(new Date(2026, 0, 1, 9, 5))).toBe("It's Thursday, January 1, 2026, 9:05 AM.");
  });
});
