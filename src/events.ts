/**
 * Events: how the server tells the app that something happened.
 *
 * Until stage 2, the app only ever heard from the server when it asked: you
 * send a message, and the answer comes back in the reply to that request.
 * That stops working once she doesn't reply straight away. She waits a few
 * seconds after your last bubble (so she doesn't answer halfway through
 * your thought), and from stage 8 she texts you first, when you haven't
 * asked for anything at all.
 *
 * So the app keeps one long request open, `GET /api/events`, and the server
 * writes a line down it whenever something happens. This is called
 * **Server-Sent Events** (SSE): a normal HTTP response that never ends,
 * made of little messages like
 *
 *   data: {"type":"messages","channelId":"...","messages":[...]}
 *
 * each followed by a blank line. Browsers have this built in (`EventSource`
 * in public/app.js), including reconnecting by themselves if the connection
 * drops, like when the phone locks.
 *
 * Events are hints to keep the app up to date. The database stays the
 * source of truth: when the app reconnects, it reloads what's on screen
 * instead of trusting that it saw every event.
 */

import type { Channel, Message } from "./types.ts";

/** Everything the server announces. */
export type ServerEvent =
  /** New messages in a channel (yours or hers), possibly replacing old ones (a regeneration). */
  | { type: "messages"; channelId: string; messages: Message[]; replacedIds?: string[] }
  /** Messages were deleted. */
  | { type: "deleted"; channelId: string; ids: string[] }
  /** The channels where she's writing right now changed. */
  | { type: "busy"; channelIds: string[] }
  /** A reply she started on her own (after the wait) failed. */
  | { type: "turn-error"; channelId: string; error: string }
  /** The channel list changed. */
  | { type: "channels"; channels: Channel[] };

/** How often to send a comment line, so nothing in between closes a quiet connection. */
const KEEPALIVE_MS = 25_000;

export class Events {
  /** One writer per open connection. */
  private readonly listeners = new Set<(event: ServerEvent) => void>();

  /** Tell every open app about something. */
  publish(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Listen from code (used by tests). Returns a function that stops listening. */
  listen(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** How many apps are connected right now. */
  get connections(): number {
    return this.listeners.size;
  }

  /**
   * The response for `GET /api/events`: a stream that stays open, carrying
   * every event from now on, until the app goes away.
   */
  response(signal?: AbortSignal): Response {
    const encoder = new TextEncoder();
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            stop(); // the connection is gone
          }
        };
        const unlisten = this.listen((event) => send(`data: ${JSON.stringify(event)}\n\n`));
        // A comment (a line starting with ":") keeps the connection alive.
        const keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
        stop = () => {
          unlisten();
          clearInterval(keepalive);
        };
        signal?.addEventListener("abort", () => {
          stop();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
        // Tell the browser how long to wait before reconnecting, then say hello.
        send("retry: 2000\n: connected\n\n");
      },
      cancel: () => stop(),
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}
