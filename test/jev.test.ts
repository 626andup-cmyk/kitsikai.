/**
 * Tests for stage 7's Jev client (src/jev.ts): the request, reading answers
 * in every layout it accepts, the three confidence tiers, the fallback
 * profile, and Settings → "Test Jev".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { confidentChoice, Decider, jevRequestBody, readAnswers, testJev, tier, type Answer, type JevCall, type Question } from "../src/jev.ts";
import { ApiError } from "../src/nanogpt.ts";
import type { Profile } from "../src/types.ts";
import { startFakeNanoGpt, type FakeNanoGpt } from "./helpers.ts";

const QUESTIONS: Question[] = [
  { id: "q1", kind: "yesno", question: "Did they say they had a headache?" },
  { id: "q2", kind: "choice", question: "Which day?", options: ["today", "yesterday"] },
];

const answer = (selected: string, yes: number): Answer => ({ id: "q", selected, probabilities: { yes, no: 1 - yes }, confidence: Math.max(yes, 1 - yes) });

describe("the request", () => {
  test("is chat completions, with the state as the message and the questions as a map of choices", () => {
    expect(jevRequestBody("typesafe/jev-1.13", "They said hi.", QUESTIONS)).toEqual({
      model: "typesafe/jev-1.13",
      messages: [{ role: "user", content: "They said hi." }],
      response_format: {
        type: "questions",
        questions: {
          q1: { type: "choice", instructions: "Did they say they had a headache?", criteria: { yes: "Yes.", no: "No." } },
          q2: { type: "choice", instructions: "Which day?", criteria: { today: "today", yesterday: "yesterday" } },
        },
      },
      stream: false,
    });
  });
});

describe("reading answers", () => {
  const content = (value: unknown) => ({ choices: [{ message: { content: JSON.stringify(value) } }] });

  test("TypeSafe's documented format: answers by name, each with its choice, probabilities and confidence", () => {
    const answers = readAnswers(
      content({
        answers: {
          q1: { type: "choice", choice: "yes", probabilities: { yes: 0.91, no: 0.09 }, confidence: 0.84 },
          q2: { type: "choice", choice: "yesterday", probabilities: { today: 0.3, yesterday: 0.7 }, confidence: 0.55 },
        },
      }),
      QUESTIONS,
    );
    expect(answers.get("q1")).toEqual({ id: "q1", selected: "yes", probabilities: { yes: 0.91, no: 0.09 }, confidence: 0.84 });
    expect(tier(answers.get("q1"), 0.8)).toBe("yes");
    expect(confidentChoice(answers.get("q2"), 0.8)).toBeNull();
    // The same, straight on the response rather than in the message.
    expect(readAnswers({ answers: { q1: { type: "choice", choice: "no", probabilities: { yes: 0.1, no: 0.9 } } } }, QUESTIONS).get("q1")!.selected).toBe("no");
  });

  test("a list of answers in the message content", () => {
    const answers = readAnswers(
      content({ answers: [{ id: "q1", selected: "yes", probabilities: { yes: 0.9, no: 0.1 } }, { id: "q2", selected: "today", probabilities: { today: 0.7, yesterday: 0.3 } }] }),
      QUESTIONS,
    );
    expect(answers.get("q1")).toEqual({ id: "q1", selected: "yes", probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9 });
    expect(answers.get("q2")!.selected).toBe("today");
  });

  test("an object by id, parsed on the message, or at the top level", () => {
    const byId = { q1: { answer: "no", probability: 0.8 } };
    for (const json of [content(byId), { choices: [{ message: { parsed: byId } }] }, { answers: byId }, { results: byId }]) {
      const answers = readAnswers(json, QUESTIONS);
      expect(answers.get("q1")).toEqual({ id: "q1", selected: "no", probabilities: { no: 0.8, yes: expect.closeTo(0.2) }, confidence: 0.8 });
    }
  });

  test("probabilities as a list, without a pick: the most likely option is picked", () => {
    const answers = readAnswers(
      { answers: [{ id: "q2", probabilities: [{ option: "today", probability: 0.2 }, { label: "Yesterday", p: 0.8 }] }] },
      QUESTIONS,
    );
    expect(answers.get("q2")).toEqual({ id: "q2", selected: "yesterday", probabilities: { today: 0.2, yesterday: 0.8 }, confidence: 0.8 });
  });

  test("true/false picks, and answers without ids, in question order", () => {
    const answers = readAnswers({ answers: [{ value: true }, { choice: "YESTERDAY" }] }, QUESTIONS);
    expect(answers.get("q1")!.selected).toBe("yes");
    expect(answers.get("q2")!.selected).toBe("yesterday");
  });

  test("answers that don't fit are dropped: unknown ids, picks that aren't options, nothing readable", () => {
    const answers = readAnswers({ answers: [{ id: "q9", selected: "yes" }, { id: "q2", selected: "tomorrow" }, { id: "q1" }] }, QUESTIONS);
    expect(answers.size).toBe(0);
    expect(readAnswers(content("not answers"), QUESTIONS).size).toBe(0);
    expect(readAnswers({ choices: [{ message: { content: "I think yes" } }] }, QUESTIONS).size).toBe(0);
  });
});

describe("the three tiers", () => {
  test("confident yes, confident no, or unsure, at the threshold", () => {
    expect(tier(answer("yes", 0.8), 0.8)).toBe("yes");
    expect(tier(answer("yes", 0.79), 0.8)).toBe("unsure");
    expect(tier(answer("no", 0.21), 0.8)).toBe("unsure");
    expect(tier(answer("no", 0.2), 0.8)).toBe("no");
    expect(tier(answer("yes", 0.92), 0.95)).toBe("unsure");
  });

  test("no answer at all is unsure: the safe path", () => {
    expect(tier(undefined, 0.8)).toBe("unsure");
    expect(confidentChoice(undefined, 0.8)).toBeNull();
  });

  test("a choice counts only when its pick is confident", () => {
    const pick = (p: number): Answer => ({ id: "q2", selected: "today", probabilities: { today: p, yesterday: 1 - p }, confidence: p });
    expect(confidentChoice(pick(0.85), 0.8)).toBe("today");
    expect(confidentChoice(pick(0.6), 0.8)).toBeNull();
  });
});

describe("the decider", () => {
  let fake: FakeNanoGpt;
  let settings: { decisionModel: string; fallback: Profile | null };
  let decider: Decider;
  const fallback: Profile = {
    id: "p1",
    name: "Steady",
    model: "steady/model",
    temperature: 0.7,
    maxTokens: 500,
    topP: null,
    reasoningEffort: null,
    supportsTools: false,
    quirkPrompt: "",
    extraParams: "",
    position: 0,
    createdAt: "",
  };

  beforeEach(() => {
    fake = startFakeNanoGpt();
    settings = { decisionModel: "typesafe/jev-1.13", fallback: null };
    decider = new Decider({ apiKey: "test-key", baseUrl: fake.baseUrl, timeoutMs: 5000 }, () => settings);
  });
  afterEach(() => fake.stop());

  test("asks Jev, with the pinned model, and reads its answers", async () => {
    fake.jevReplies.push({ q1: "yes", q2: { selected: "yesterday", p: 0.7 } });
    const answers = await decider.ask("They said their head hurt yesterday.", QUESTIONS);
    expect(fake.jevRequests[0]!.model).toBe("typesafe/jev-1.13");
    expect(fake.jevRequests[0]!.state).toBe("They said their head hurt yesterday.");
    expect(answers.get("q1")!.selected).toBe("yes");
    expect(answers.get("q2")!.probabilities.yesterday).toBe(0.7);
    expect(decider.lastReport).toMatchObject({ answeredBy: "jev", jevError: null });
    expect(decider.lastReport!.raw).toContain("answers");
  });

  test("no questions: nothing is asked", async () => {
    expect((await decider.ask("state", [])).size).toBe(0);
    expect(fake.jevRequests).toHaveLength(0);
  });

  test("when Jev fails and there's no fallback, the error says why", async () => {
    fake.jevReplies.push({ status: 503, error: "Model unavailable" });
    const error = await decider.ask("state", QUESTIONS).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("HTTP 503");
    expect(decider.lastReport!.jevError).toContain("Model unavailable");
  });

  test("the questions go as a map (a list is what nanoGPT refused)", async () => {
    await decider.ask("state", QUESTIONS);
    expect(fake.jevRequests[0]!.questions.map((q) => [q.id, q.options])).toEqual([
      ["q1", ["yes", "no"]],
      ["q2", ["today", "yesterday"]],
    ]);
  });

  test("a reply with no answers Kitsikai can read counts as a failure", async () => {
    // A 200 reply whose body has no answers in it: {"error": {"message": ""}}.
    fake.jevReplies.push({ status: 200, error: "" });
    const error = await decider.ask("state", QUESTIONS).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("no answers in a shape Kitsikai understands");
  });

  test("when Jev fails, the fallback profile answers in JSON", async () => {
    settings.fallback = fallback;
    fake.jevReplies.push({ status: 503, error: "Model unavailable" });
    fake.replies.push({ content: '```json\n{"q1": {"answer": "yes", "probability": 0.9}, "q2": {"answer": "today", "probability": 0.6}}\n```' });
    const answers = await decider.ask("They have a headache today.", QUESTIONS);
    expect(fake.requests[0]!.model).toBe("steady/model");
    expect(fake.requests[0]!.messages[1]!.content).toContain('"q1": Did they say they had a headache? Options: "yes", "no"');
    expect(answers.get("q1")).toMatchObject({ selected: "yes", confidence: 0.9 });
    expect(tier(answers.get("q1"), 0.8)).toBe("yes");
    expect(confidentChoice(answers.get("q2"), 0.8)).toBeNull();
    expect(decider.lastReport).toMatchObject({ answeredBy: "fallback" });
  });

  test("with Jev turned off, the fallback answers straight away, or nothing can", async () => {
    settings.decisionModel = "";
    expect(decider.enabled()).toBe(false);
    expect((await decider.ask("state", QUESTIONS).catch((e) => e)).message).toContain("Jev is turned off");
    settings.fallback = fallback;
    expect(decider.enabled()).toBe(true);
    fake.replies.push({ content: '{"q1": {"answer": "no", "probability": 0.95}}' });
    expect((await decider.ask("state", QUESTIONS)).get("q1")!.selected).toBe("no");
    expect(fake.jevRequests).toHaveLength(0);
  });
});

describe("Test Jev", () => {
  let fake: FakeNanoGpt;
  let decider: Decider;
  beforeEach(() => {
    fake = startFakeNanoGpt();
    decider = new Decider({ apiKey: "test-key", baseUrl: fake.baseUrl, timeoutMs: 5000 }, () => ({ decisionModel: "typesafe/jev-1.13", fallback: null }));
  });
  afterEach(() => fake.stop());

  test("a working Jev answers the obvious question", async () => {
    fake.jevReplies.push({ pet: { selected: "yes", p: 0.97 } });
    const result = await testJev(decider);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('Jev answered "yes", 97% sure, as expected. It\'s working.');
    expect(result.report!.raw).toContain("answers");
  });

  test("a wrong answer, or an error, is explained", async () => {
    fake.jevReplies.push({ pet: "no" });
    const wrong = await testJev(decider);
    expect(wrong.ok).toBe(false);
    expect(wrong.detail).toContain('should have been "yes"');

    fake.jevReplies.push({ status: 404, error: "No such model" });
    const failed = await testJev(decider);
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("HTTP 404");
    expect(failed.answer).toBeNull();
  });
});

describe("the Jev log", () => {
  let fake: FakeNanoGpt;
  let settings: { decisionModel: string; fallback: Profile | null };
  let calls: JevCall[];
  let decider: Decider;
  const fallback: Profile = {
    id: "p1",
    name: "Steady",
    model: "steady/model",
    temperature: 0.7,
    maxTokens: 500,
    topP: null,
    reasoningEffort: null,
    supportsTools: false,
    quirkPrompt: "",
    extraParams: "",
    position: 0,
    createdAt: "",
  };

  beforeEach(() => {
    fake = startFakeNanoGpt();
    settings = { decisionModel: "typesafe/jev-1.13", fallback: null };
    calls = [];
    decider = new Decider({ apiKey: "test-key", baseUrl: fake.baseUrl, timeoutMs: 5000 }, () => settings, (call) => calls.push(call));
  });
  afterEach(() => fake.stop());

  test("every call: what asked, the request exactly as sent, the reply exactly as received, and the answers in short", async () => {
    fake.jevReplies.push({ q1: "yes", q2: { selected: "yesterday", p: 0.7 } });
    await decider.ask("They said hi.", QUESTIONS, { purpose: "Scratchpad check" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toMatchObject({ purpose: "Scratchpad check", model: "typesafe/jev-1.13", error: null, answeredBy: "jev", fallback: null });
    expect(call!.request).toEqual(jevRequestBody("typesafe/jev-1.13", "They said hi.", QUESTIONS));
    expect(JSON.parse(call!.response).choices[0].message.content).toContain('"answers"');
    expect(call!.summary).toBe("q1: yes (95%), q2: yesterday (70%)");
    expect(call!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("without a purpose it's \"Other\"; no questions, nothing sent, nothing logged", async () => {
    await decider.ask("state", QUESTIONS);
    await decider.ask("state", []);
    expect(calls.map((c) => c.purpose)).toEqual(["Other"]);
  });

  test("a failed call keeps Jev's whole reply and the error", async () => {
    fake.jevReplies.push({ status: 503, error: "Model unavailable" });
    await decider.ask("state", QUESTIONS, { purpose: "Processing" }).catch(() => {});
    expect(calls[0]).toMatchObject({ answeredBy: null, summary: "", fallback: null });
    expect(calls[0]!.error).toContain("HTTP 503");
    expect(calls[0]!.response).toBe('{"error":{"message":"Model unavailable"}}');
  });

  test("when the fallback answers, its request and reply are there too", async () => {
    settings.fallback = fallback;
    fake.jevReplies.push({ status: 503, error: "Model unavailable" });
    fake.replies.push({ content: '{"q1": {"answer": "yes", "probability": 0.9}}' });
    await decider.ask("They have a headache.", QUESTIONS, { purpose: "Scratchpad check" });
    const [call] = calls;
    expect(call).toMatchObject({ answeredBy: "fallback", summary: "q1: yes (90%)" });
    expect(call!.error).toContain("HTTP 503");
    expect(call!.fallback).toMatchObject({ profile: "Steady", model: "steady/model", response: '{"q1": {"answer": "yes", "probability": 0.9}}', error: null });
    expect(call!.fallback!.messages[1]!.content).toContain("The situation:\n\nThey have a headache.");

    // Jev turned off: only the fallback was asked (and its reply couldn't be read).
    settings.decisionModel = "";
    fake.replies.push({ content: "no idea" });
    await decider.ask("state", QUESTIONS).catch(() => {});
    expect(calls[1]).toMatchObject({ model: "", request: null, response: "", answeredBy: null, summary: "" });
    expect(calls[1]!.error).toContain("Jev is turned off");
    expect(calls[1]!.fallback).toMatchObject({ response: "no idea", error: "The model's reply wasn't the JSON it was asked for." });
  });

  test("a stopped call says so", async () => {
    fake.jevReplies.push({ q1: "yes" });
    const stop = new AbortController();
    stop.abort();
    await decider.ask("state", QUESTIONS, { signal: stop.signal, purpose: "Scratchpad check" }).catch(() => {});
    expect(calls[0]!.error).toBe("Stopped: a newer message came in, or you pressed Stop.");
  });

  test("a log that can't be written never gets in the way of a decision", async () => {
    const failing = new Decider({ apiKey: "test-key", baseUrl: fake.baseUrl, timeoutMs: 5000 }, () => settings, () => {
      throw new Error("disk full");
    });
    fake.jevReplies.push({ q1: "yes" });
    expect((await failing.ask("state", QUESTIONS)).get("q1")!.selected).toBe("yes");
  });
});
