/**
 * Shared test helpers.
 *
 * The most important one is `startFakeNanoGpt`: a tiny local server that
 * pretends to be nanoGPT. Tests point Kitsikai at it (via the base URL), so
 * the real request code runs end to end without needing an API key, network
 * access, or spending any money.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";
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
  /**
   * Every intimacy routing request to Jev (src/intimacy.ts: the "register"
   * and "back" questions), oldest first. Not in `jevRequests`, so the rest
   * of the tests don't count the one before each of her turns.
   */
  routeRequests: JevRequest[];
  /** Queue routing replies; else the defaults ("warm", and "no": she isn't brought back). */
  routeReplies: JevReply[];
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
  const fake: FakeNanoGpt = { baseUrl: "", requests: [], replies: [], jevRequests: [], jevReplies: [], routeRequests: [], routeReplies: [], stop: () => {} };

  const server = Bun.serve({
    port: 0, // let the OS pick a free port
    async fetch(request) {
      const path = new URL(request.url).pathname;

      if (path === "/v1/models") {
        return Response.json({ data: [{ id: "zeta/model" }, { id: "alpha/model" }] });
      }

      if (path === "/v1/chat/completions") {
        const body = (await request.json()) as Omit<FakeNanoGpt["requests"][number], "auth"> & {
          response_format?: { type?: string; questions?: unknown };
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

/** A question as the fake Jev receives it: TypeSafe's shape, in a map keyed by id. */
interface JevWireQuestion {
  type: string;
  instructions: string;
  criteria: Record<string, string>;
}

/** The question ids intimacy routing asks, alone (see `routeRequests`). */
const ROUTING = ["register", "back"];

/**
 * The fake Jev: checks the request has TypeSafe's shape (like nanoGPT does),
 * and answers every question in TypeSafe's format:
 * `{"answers": {"q1": {"type": "choice", "choice": "yes", "probabilities": {...}, "confidence": 0.95}}}`.
 */
function answerJev(fake: FakeNanoGpt, body: { model: string; messages: ChatMessage[]; response_format?: { questions?: unknown } }) {
  const wire = body.response_format?.questions;
  // The error nanoGPT really sends for a list, or an empty map.
  if (!wire || typeof wire !== "object" || Array.isArray(wire) || Object.keys(wire).length === 0) {
    return Response.json(
      { error: { message: "Jev decision models require a non-empty questions map.", type: "invalid_request_error", param: "response_format.questions", code: "invalid_questions" } },
      { status: 400 },
    );
  }
  const questions = Object.entries(wire as Record<string, JevWireQuestion>).map(([id, q]) => ({
    id,
    question: q.instructions,
    options: Object.keys(q.criteria ?? {}),
  }));
  const request: JevRequest = { model: body.model, state: body.messages[0]?.content ?? "", questions };
  const routing = questions.length === 1 && ROUTING.includes(questions[0]!.id);
  let reply: JevReply;
  if (routing) {
    fake.routeRequests.push(request);
    reply = fake.routeReplies.shift() ?? {};
  } else {
    fake.jevRequests.push(request);
    reply = fake.jevReplies.shift() ?? fake.jev?.(request) ?? {};
  }
  if ("status" in reply && typeof reply.status === "number") {
    return Response.json({ error: { message: reply.error } }, { status: reply.status });
  }
  const given = reply as Record<string, string | { selected: string; p: number }>;
  const answers = Object.fromEntries(
    questions.map((q) => {
      const answer = given[q.id];
      const choice = typeof answer === "object" ? answer.selected : (answer ?? q.options.at(-1)!);
      const p = typeof answer === "object" ? answer.p : 0.95;
      const others = q.options.filter((o) => o !== choice);
      const probabilities = Object.fromEntries(q.options.map((o) => [o, o === choice ? p : (1 - p) / others.length]));
      return [q.id, { type: "choice", choice, probabilities, confidence: p }];
    }),
  );
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

/** CRC-32, for PNG chunks. */
function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

/** A real PNG of one colour, for tests that send images. */
export function testPng(width = 40, height = 30, rgb: [number, number, number] = [240, 160, 60]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3]!)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}
