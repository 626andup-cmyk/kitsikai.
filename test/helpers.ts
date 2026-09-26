/**
 * Shared test helpers.
 *
 * The most important one is `startFakeNanoGpt`: a tiny local server that
 * pretends to be nanoGPT. Tests point Kitsikai at it (via the base URL), so
 * the real request code runs end to end without needing an API key, network
 * access, or spending any money.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import type { ChatMessage } from "../src/types.ts";

/** What the fake server should do with the next request. */
export type FakeReply =
  | { content: string; finishReason?: string }
  | { status: number; error: string }
  /** Wait this many ms before replying, for testing overlapping turns. */
  | { content: string; delayMs: number }
  /** Start the reply, then never finish it: a model that stalls halfway. */
  | { stallMidReply: true }
  /**
   * Ask for tool calls through the API's `tool_calls` field, with optional
   * text alongside. `arguments` can be JSON text or an object (some
   * providers send objects).
   */
  | { toolCalls: { name: string; arguments: string | object }[]; content?: string | null };

/**
 * How the fake Jev answers one request (stage 7): an answer per question id,
 * as the option picked (95% sure) or with its own probability. Questions
 * left out get the default: their last option ("no", "neither", "not
 * answered"), 95% sure. Or an error.
 */
export type JevReply = Record<string, string | { selected: string; p: number }> | { status: number; error: string };

/** A request the fake Jev received. */
export interface JevRequest {
  model: string;
  state: string;
  questions: { id: string; question: string; options: string[] }[];
}

export interface FakeNanoGpt {
  baseUrl: string;
  /** Every request to Jev (a "questions" response format), oldest first. Not in `requests`. */
  jevRequests: JevRequest[];
  /** Queue Jev replies; each Jev request takes the next one, else `jev`, else the defaults. */
  jevReplies: JevReply[];
  /** Answer Jev requests with a function, when the queue is empty. */
  jev?: (request: JevRequest) => JevReply;
  /** Every chat completion request received, oldest first. */
  requests: Array<{
    model: string;
    messages: ChatMessage[];
    temperature: number;
    max_tokens: number;
    tools?: { function: { name: string } }[];
    auth: string | null;
  }>;
  /** Queue replies; each request takes the next one. Defaults to "Reply N". */
  replies: FakeReply[];
  stop: () => void;
}

export function startFakeNanoGpt(): FakeNanoGpt {
  const fake: FakeNanoGpt = { baseUrl: "", requests: [], replies: [], jevRequests: [], jevReplies: [], stop: () => {} };

  const server = Bun.serve({
    port: 0, // let the OS pick a free port
    async fetch(request) {
      const path = new URL(request.url).pathname;

      if (path === "/v1/models") {
        return Response.json({ data: [{ id: "zeta/model" }, { id: "alpha/model" }] });
      }

      if (path === "/v1/chat/completions") {
        const body = (await request.json()) as Omit<FakeNanoGpt["requests"][number], "auth"> & {
          response_format?: { type?: string; questions?: JevRequest["questions"] };
        };
        if (body.response_format?.type === "questions") return answerJev(fake, body);
        fake.requests.push({ ...body, auth: request.headers.get("authorization") });
        const reply = fake.replies.shift() ?? { content: `Reply ${fake.requests.length}` };

        if ("status" in reply) {
          return Response.json({ error: { message: reply.error } }, { status: reply.status });
        }
        if ("stallMidReply" in reply) {
          const stream = new ReadableStream({
            start: (controller) => controller.enqueue(new TextEncoder().encode('{"choices": [')),
          });
          return new Response(stream, { headers: { "Content-Type": "application/json" } });
        }
        if ("toolCalls" in reply) {
          return Response.json({
            model: body.model,
            choices: [
              {
                message: {
                  role: "assistant",
                  content: reply.content ?? null,
                  tool_calls: reply.toolCalls.map((call, i) => ({
                    id: `call_${fake.requests.length}_${i}`,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
                },
                finish_reason: "tool_calls",
              },
            ],
          });
        }
        if ("delayMs" in reply) await Bun.sleep(reply.delayMs);
        return Response.json({
          model: body.model,
          choices: [
            {
              message: { role: "assistant", content: reply.content },
              finish_reason: "finishReason" in reply ? reply.finishReason : "stop",
            },
          ],
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  fake.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  fake.stop = () => server.stop(true);
  return fake;
}

/** The fake Jev: answers every question, in one plausible reply layout. */
function answerJev(fake: FakeNanoGpt, body: { model: string; messages: ChatMessage[]; response_format?: { questions?: JevRequest["questions"] } }) {
  const request: JevRequest = { model: body.model, state: body.messages[0]?.content ?? "", questions: body.response_format?.questions ?? [] };
  fake.jevRequests.push(request);
  const reply = fake.jevReplies.shift() ?? fake.jev?.(request) ?? {};
  if ("status" in reply && typeof reply.status === "number") {
    return Response.json({ error: { message: reply.error } }, { status: reply.status });
  }
  const given = reply as Record<string, string | { selected: string; p: number }>;
  const answers = request.questions.map((q) => {
    const answer = given[q.id];
    const selected = typeof answer === "object" ? answer.selected : (answer ?? q.options.at(-1)!);
    const p = typeof answer === "object" ? answer.p : 0.95;
    const others = q.options.filter((o) => o !== selected);
    const probabilities = Object.fromEntries(q.options.map((o) => [o, o === selected ? p : (1 - p) / others.length]));
    return { id: q.id, selected, probabilities };
  });
  return Response.json({
    model: body.model,
    choices: [{ message: { role: "assistant", content: JSON.stringify({ answers }) }, finish_reason: "stop" }],
  });
}

/** A fresh, empty temporary folder, plus a function that deletes it. */
export function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "kitsikai-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** A config suitable for tests, pointing at a fake API and a temp data folder. */
export function testConfig(dataDir: string, apiBaseUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    publicDir: join(import.meta.dir, "..", "public"),
    themesDir: join(import.meta.dir, "..", "themes"),
    apiKey: "test-key",
    apiBaseUrl,
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

/** What `call` returns: the status and the parsed JSON (or text) body. */
export interface CallResult {
  status: number;
  data: any;
}

/**
 * Make a function that sends requests to an app's `fetch` handler the way
 * the browser would: JSON in, JSON out.
 */
export function caller(fetch: (request: Request) => Promise<Response>) {
  return async (method: string, path: string, body?: unknown): Promise<CallResult> => {
    const response = await fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data };
  };
}
