/**
 * Tests for prompt assembly (src/prompt.ts).
 */

import { describe, expect, test } from "bun:test";
import { buildPromptStack, describeNow, FRAMING, NUDGES, renderLayers, toChatHistory } from "../src/prompt.ts";
import { defaultSettings } from "../src/store.ts";
import type { Channel, Message } from "../src/types.ts";

const channel: Channel = {
  id: "c1",
  name: "general",
  kind: "text",
  theme: null,
  assignment: null,
  position: 0,
  createdAt: "2026-09-26T10:00:00.000Z",
};

function message(author: Message["author"], content: string): Message {
  return { id: crypto.randomUUID(), channelId: "c1", author, content, turnId: null, createdAt: new Date().toISOString() };
}

const now = new Date(2026, 8, 26, 16, 12); // Saturday, September 26, 2026, 4:12 PM (local time)

describe("buildPromptStack", () => {
  test("starts with who she is, how she texts, and the time", () => {
    const [system] = buildPromptStack({ settings: defaultSettings(), channel, messages: [], now });
    expect(system!.role).toBe("system");
    expect(system!.content).toStartWith(`## Who you are\n\n${FRAMING}`);
    expect(system!.content).toContain("You're Kitsikai");
    expect(system!.content).toContain("## How you text");
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
  test("merges messages in a row from the same person, and skips empty ones", () => {
    const history = toChatHistory([
      message("user", "one"),
      message("user", "two"),
      message("kitsikai", "  "),
      message("kitsikai", "three"),
    ]);
    expect(history).toEqual([
      { role: "user", content: "one\n\ntwo" },
      { role: "assistant", content: "three" },
    ]);
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
