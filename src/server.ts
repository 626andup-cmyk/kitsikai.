/**
 * The Kitsikai server.
 *
 * This is a small web server, run by Bun in Termux on your phone. It does two
 * jobs:
 *
 *   1. Serves the web app (the files in `public/`) to your browser.
 *   2. Answers the app's API requests under `/api/...`: reading channels and
 *      messages, saving changes, and asking Kitsikai to write.
 *
 * The browser never talks to nanoGPT itself. Your API key stays on the server,
 * and the server is the only thing that reads or writes your data.
 *
 * API overview (all request and response bodies are JSON):
 *
 *   GET    /api/state                     Settings, channels, profiles, roulettes, where she's writing,
 *                                         and the app version
 *   GET    /api/events                    A stream of what happens, as it happens (see src/events.ts)
 *   PUT    /api/settings                  Change settings (any subset of fields)
 *   GET    /api/models                    List models available on nanoGPT
 *
 *   POST   /api/channels                  Create a channel
 *   PUT    /api/channels/order            Put the channels in a new order
 *   PATCH  /api/channels/:id              Rename a channel, or change its topic, theme or profile
 *   DELETE /api/channels/:id              Delete a channel and all its messages
 *   GET    /api/channels/:id/messages     Every message in a channel
 *   POST   /api/channels/:id/messages     Send one bubble; she replies after a short wait (src/replies.ts)
 *   POST   /api/channels/:id/typing       You're still typing: she waits a little longer
 *   DELETE /api/channels/:id/messages     Delete every message in a channel
 *   POST   /api/channels/:id/turn         She takes a turn without a new message from you
 *   POST   /api/channels/:id/regenerate   Replace her last reply with a new one (optionally with a given profile)
 *   POST   /api/channels/:id/cancel       Stop her turn in progress (the Stop button)
 *   GET    /api/channels/:id/prompt       The exact prompt stack the next turn would send
 *
 *   GET    /api/plans?from=&to=           Every plan occurrence between two dates, with shift hours, draw
 *                                         time and reminder times worked out (see src/planner.ts)
 *   GET    /api/planner/week?date=        The weekly list for the week (Monday to Sunday) a date is in
 *   POST   /api/plans                     Make a plan
 *   GET    /api/plans/:id                 One plan
 *   PATCH  /api/plans/:id                 Change a plan
 *   DELETE /api/plans/:id                 Delete a plan
 *
 *   PATCH  /api/messages/:id              Edit a message's text
 *   DELETE /api/messages/:id              Delete one message
 *
 *   GET    /api/profiles                  Connection profiles and roulettes
 *   POST   /api/profiles                  Make a profile
 *   PATCH  /api/profiles/:id              Change a profile
 *   DELETE /api/profiles/:id              Delete a profile
 *   POST   /api/profiles/:id/test         Check whether its model can call tools
 *   POST   /api/roulettes                 Make a roulette
 *   PATCH  /api/roulettes/:id             Change a roulette
 *   DELETE /api/roulettes/:id             Delete a roulette
 *
 *   GET    /api/themes                    Every theme, for the theme picker
 *   POST   /api/themes                    Make a new theme, copying another
 *   GET    /api/themes/:id                One theme's CSS and files, for the editor
 *   PATCH  /api/themes/:id                Change one of your themes
 *   DELETE /api/themes/:id                Delete one of your themes
 *   POST   /api/themes/:id/files          Add an image or font to one of your themes
 *   DELETE /api/themes/:id/files/:name    Remove one
 *
 * Theme files themselves are served at /themes/<id>/<file> (see src/themes.ts).
 *
 * Run it with `bun start`.
 */

import { readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { Events } from "./events.ts";
import { BusyError, Kitsikai, pickProfile, promptForChannel, testToolCalling, type TurnResult } from "./kitsikai.ts";
import { ApiError, CancelledError, listModels, type ApiOptions } from "./nanogpt.ts";
import { Replies } from "./replies.ts";
import { daysBetween, isDate, mondayOf } from "./dates.ts";
import { DEFAULT_REMINDERS, REMINDER_LABELS } from "./planner.ts";
import {
  NotFoundError,
  Store,
  ValidationError,
  validateChannelUpdate,
  validateNewChannel,
  validateSettings,
} from "./store.ts";
import { DEFAULT_THEME, ThemeLibrary } from "./themes.ts";

/** Longest message you can send, in characters. A generous guard against accidents. */
const MAX_MESSAGE_LENGTH = 100_000;

/**
 * An error that should be sent to the browser with a specific HTTP status.
 * Thrown by route handlers; turned into a JSON response by `fetch`.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Options for building the app, mostly for tests. */
export interface AppOptions {
  /** What time it is. Tests pass a fake clock. */
  now?: () => Date;
}

/** The pieces a running app is made of, returned so tests can reach into them. */
export interface App {
  /** Handles one HTTP request. This is what `Bun.serve` calls. */
  fetch: (request: Request) => Promise<Response>;
  store: Store;
  kitsikai: Kitsikai;
  /** What the app hears about as it happens (src/events.ts). */
  events: Events;
  /** Her waits before replying (src/replies.ts). */
  replies: Replies;
  themes: ThemeLibrary;
}

/**
 * One API route: a method, a path pattern, and what to do.
 *
 * In a pattern, `:id` matches one path segment, and its value arrives in
 * `params.id`. So `/api/channels/:id/turn` matches `/api/channels/abc/turn`
 * with `params.id === "abc"`.
 */
export interface Route {
  method: string;
  pattern: string;
  handler: (request: Request, params: Record<string, string>) => Promise<Response> | Response;
}

/**
 * Check a request's method and path against a route.
 * Returns the `:name` values if it matches, or `null` if it doesn't.
 */
export function matchRoute(route: Pick<Route, "method" | "pattern">, method: string, path: string) {
  if (route.method !== method) return null;
  const want = route.pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith(":")) {
      if (got[i] === "") return null;
      try {
        params[want[i]!.slice(1)] = decodeURIComponent(got[i]!);
      } catch {
        return null; // badly encoded, like "%zz": treat as no match
      }
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

/**
 * A fingerprint of the web app's files: it changes whenever any file in
 * `public/` changes.
 *
 * An installed app can stay open in the background for days. After you
 * update Kitsikai and restart the server, that open page is still running the
 * old code. The page compares this fingerprint with the one it started with,
 * and reloads when they differ (see `checkForUpdate` in public/app.js).
 */
export function appVersion(publicDir: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  // Sorted, so the same files always give the same fingerprint.
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: publicDir })].sort();
  for (const file of files) {
    hasher.update(file);
    hasher.update(readFileSync(join(publicDir, file)));
  }
  return hasher.digest("hex").slice(0, 12);
}

/**
 * Wire everything together: open the store, create Kitsikai, and build the
 * request handler. Nothing is listening yet; `main()` does that.
 */
export function createApp(config: Config, options: AppOptions = {}): App {
  const now = options.now ?? (() => new Date());
  const store = new Store(config.dataDir);
  const api: ApiOptions = {
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.requestTimeoutMs,
  };
  const events = new Events();
  const kitsikai = new Kitsikai(store, api, now, events);
  const replies = new Replies(store, kitsikai, events);
  const version = appVersion(config.publicDir);
  const themes = new ThemeLibrary(
    config.themesDir,
    join(config.dataDir, "themes"),
    readFileSync(join(config.publicDir, "style.css"), "utf8"),
  );

  /** Refuse a theme id that doesn't exist (for settings and channels). */
  function ensureTheme(id: string | null | undefined): void {
    if (id && !themes.exists(id)) throw new HttpError(400, "That theme doesn't exist.");
  }

  /** Refuse to change a channel's messages while she's writing there. */
  function ensureIdle(channelId: string): void {
    if (kitsikai.isBusy(channelId)) throw new BusyError();
  }

  /** Tell every open app that the channel list changed, and return it. */
  function channelsChanged() {
    const channels = store.listChannels();
    events.publish({ type: "channels", channels });
    return channels;
  }

  /**
   * The turn id for a bubble you're sending: the same as your previous
   * bubble's if she hasn't replied since, so bubbles sent together form
   * one turn.
   */
  function userTurnId(channelId: string): string {
    const last = store.lastMessage(channelId);
    return last?.author === "user" && last.turnId ? last.turnId : crypto.randomUUID();
  }

  // Routes are checked in order and the first match wins, so fixed paths
  // must come before patterns that would also match them.
  const routes: Route[] = [
    // ------------------------------------------------------- app-wide
    {
      method: "GET",
      pattern: "/api/state",
      handler: () =>
        json({
          settings: store.getSettings(),
          channels: store.listChannels(),
          profiles: store.profiles.list(),
          roulettes: store.profiles.listRoulettes(),
          busyChannels: kitsikai.busyChannels(),
          appVersion: version,
          // For the planner's plan editor.
          planner: { defaultReminders: DEFAULT_REMINDERS, reminderLabels: REMINDER_LABELS },
        }),
    },
    {
      method: "GET",
      pattern: "/api/events",
      handler: (request) => events.response(request.signal),
    },
    {
      method: "PUT",
      pattern: "/api/settings",
      handler: async (request) => {
        const update = validateSettings(await readJson(request));
        ensureTheme(update.appTheme);
        if (update.chatAssignment) store.profiles.checkAssignment(update.chatAssignment);
        if (update.homeChannelId && store.getChannel(update.homeChannelId).kind !== "text") {
          throw new HttpError(400, "The home channel must be a text channel.");
        }
        return json({ settings: store.updateSettings(update) });
      },
    },
    {
      method: "GET",
      pattern: "/api/models",
      handler: async () => json({ models: await listModels(api) }),
    },

    // ---------------------------------------------------------- channels
    {
      method: "POST",
      pattern: "/api/channels",
      handler: async (request) => {
        const channel = store.createChannel(validateNewChannel(await readJson(request)));
        return json({ channel, channels: channelsChanged() });
      },
    },
    {
      method: "PUT",
      pattern: "/api/channels/order",
      handler: async (request) => {
        const body = (await readJson(request)) as { ids?: unknown };
        if (!Array.isArray(body?.ids) || !body.ids.every((id) => typeof id === "string")) {
          throw new HttpError(400, '"ids" must be a list of channel ids.');
        }
        store.reorderChannels(body.ids);
        return json({ channels: channelsChanged() });
      },
    },
    {
      method: "PATCH",
      pattern: "/api/channels/:id",
      handler: async (request, { id }) => {
        const update = validateChannelUpdate(await readJson(request));
        ensureTheme(update.theme);
        if (update.assignment) store.profiles.checkAssignment(update.assignment);
        const channel = store.updateChannel(id!, update);
        return json({ channel, channels: channelsChanged() });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id",
      handler: (_request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        // Nothing may be written into a channel that's gone.
        replies.cancel(id!);
        kitsikai.cancel(id!);
        store.deleteChannel(id!);
        return json({ settings: store.getSettings(), channels: channelsChanged() });
      },
    },
    {
      method: "GET",
      pattern: "/api/channels/:id/messages",
      handler: (_request, { id }) => json({ messages: store.getMessages(id!) }),
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/messages",
      handler: async (request, { id }) => {
        const content = requireText(await readJson(request), "content");
        if (store.getChannel(id!).kind !== "text") throw new HttpError(400, "You can only text in text channels.");
        // Each send is one bubble. Bubbles you send before she replies share
        // a turn id.
        const message = store.addMessage({ channelId: id!, author: "user", content: content.trim(), turnId: userTurnId(id!) });
        events.publish({ type: "messages", channelId: id!, messages: [message] });
        // She replies after a short wait, through the events stream. If a
        // reply of hers was on its way, it's out of date now: she starts over.
        replies.bubbleSent(id!);
        return json({ userMessages: [message] });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/typing",
      handler: (_request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        replies.typing(id!);
        return json({ waiting: replies.isWaiting(id!) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id/messages",
      handler: (_request, { id }) => {
        ensureIdle(id!);
        replies.cancel(id!);
        const ids = store.getMessages(id!).map((m) => m.id);
        store.clearMessages(id!);
        events.publish({ type: "deleted", channelId: id!, ids });
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/turn",
      handler: async (_request, { id }) => json(turnResult(await kitsikai.takeTurn(id!, "continue"))),
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/regenerate",
      handler: async (request, { id }) => {
        ensureIdle(id!);
        // Optional: the profile to write with ("Regenerate with..."). Without
        // one, the channel's profile or roulette picks again.
        const body = (await readJson(request)) as { profileId?: unknown } | null;
        const profileId = typeof body?.profileId === "string" && body.profileId ? body.profileId : undefined;
        if (profileId) store.profiles.get(profileId); // 404 for an unknown profile
        // Her whole last reply: every bubble of it.
        const replacedIds = store.lastKitsikaiTurn(id!).map((m) => m.id);
        if (replacedIds.length === 0) {
          throw new HttpError(400, "The last message isn't hers, so there's nothing to regenerate.");
        }
        // Generate first, and only delete the old reply once the new one exists.
        const result = await kitsikai.takeTurn(id!, "regenerate", { replacing: replacedIds, profileId });
        return json({ ...turnResult(result), replacedIds: result.replaced });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/cancel",
      handler: (_request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        // Stop waiting to reply, too. `cancelled` is false if nothing was
        // running, e.g. the reply arrived just before you pressed Stop.
        const waiting = replies.isWaiting(id!);
        replies.cancel(id!);
        return json({ cancelled: kitsikai.cancel(id!) || waiting });
      },
    },
    {
      method: "GET",
      pattern: "/api/channels/:id/prompt",
      handler: (request, { id }) => {
        // For a roulette, the model notes depend on the profile picked, so
        // the preview shows a given profile (`?profile=<id>`), or the one a
        // roulette would pick first.
        const profileId = new URL(request.url).searchParams.get("profile");
        const profile = profileId ? store.profiles.get(profileId) : pickProfile(store, store.getChannel(id!), 0);
        return json({ messages: promptForChannel(store, id!, { profile, now: now() }), profile });
      },
    },

    // ----------------------------------------------------------- planner
    {
      method: "GET",
      pattern: "/api/plans",
      handler: (request) => {
        const params = new URL(request.url).searchParams;
        const from = params.get("from");
        const to = params.get("to");
        if (!isDate(from) || !isDate(to)) throw new HttpError(400, '"from" and "to" must be dates like 2026-09-28.');
        const days = daysBetween(from, to);
        if (days < 0 || days > 400) throw new HttpError(400, '"to" must be on or after "from", and within 400 days of it.');
        return json({ occurrences: store.plans.occurrences(from, to) });
      },
    },
    {
      method: "GET",
      pattern: "/api/planner/week",
      handler: (request) => {
        const date = new URL(request.url).searchParams.get("date");
        if (!isDate(date)) throw new HttpError(400, '"date" must be a date like 2026-09-28.');
        return json({ week: store.plans.week(mondayOf(date)) });
      },
    },
    {
      method: "POST",
      pattern: "/api/plans",
      handler: async (request) => {
        const plan = store.plans.create(await readObject(request));
        events.publish({ type: "plans" });
        return json({ plan });
      },
    },
    {
      method: "GET",
      pattern: "/api/plans/:id",
      handler: (_request, { id }) => json({ plan: store.plans.get(id!) }),
    },
    {
      method: "PATCH",
      pattern: "/api/plans/:id",
      handler: async (request, { id }) => {
        const plan = store.plans.update(id!, await readObject(request));
        events.publish({ type: "plans" });
        return json({ plan });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/plans/:id",
      handler: (_request, { id }) => {
        store.plans.delete(id!);
        events.publish({ type: "plans" });
        return json({ ok: true });
      },
    },

    // ---------------------------------------------------------- messages
    {
      method: "PATCH",
      pattern: "/api/messages/:id",
      handler: async (request, { id }) =>
        json({ message: store.editMessage(id!, requireText(await readJson(request), "content")) }),
    },
    {
      method: "DELETE",
      pattern: "/api/messages/:id",
      handler: (_request, { id }) => {
        const { channelId } = store.getMessage(id!);
        ensureIdle(channelId);
        store.deleteMessage(id!);
        events.publish({ type: "deleted", channelId, ids: [id!] });
        return json({ ok: true });
      },
    },

    // ------------------------------------------- profiles and roulettes
    {
      method: "GET",
      pattern: "/api/profiles",
      handler: () => json({ profiles: store.profiles.list(), roulettes: store.profiles.listRoulettes() }),
    },
    {
      method: "POST",
      pattern: "/api/profiles",
      handler: async (request) => json({ profile: store.profiles.create(await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/profiles/:id",
      handler: async (request, { id }) => json({ profile: store.profiles.update(id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/profiles/:id",
      handler: (_request, { id }) => {
        store.profiles.delete(id!);
        return json({ settings: store.getSettings(), channels: channelsChanged() });
      },
    },
    {
      method: "POST",
      pattern: "/api/profiles/:id/test",
      handler: async (_request, { id }) => json({ test: await testToolCalling(api, store.profiles.get(id!)) }),
    },
    {
      method: "POST",
      pattern: "/api/roulettes",
      handler: async (request) => json({ roulette: store.profiles.createRoulette(await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/roulettes/:id",
      handler: async (request, { id }) =>
        json({ roulette: store.profiles.updateRoulette(id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/roulettes/:id",
      handler: (_request, { id }) => {
        store.profiles.deleteRoulette(id!);
        return json({ settings: store.getSettings(), channels: channelsChanged() });
      },
    },

    // ------------------------------------------------------------ themes
    {
      method: "GET",
      pattern: "/api/themes",
      handler: () => json({ themes: themes.list() }),
    },
    {
      method: "POST",
      pattern: "/api/themes",
      handler: async (request) => {
        const body = (await readJson(request)) as { name?: unknown; from?: unknown } | null;
        const from = typeof body?.from === "string" ? body.from : DEFAULT_THEME;
        return json({ theme: themes.create(body?.name as string, from) });
      },
    },
    {
      method: "GET",
      pattern: "/api/themes/:id",
      handler: (_request, { id }) => json({ theme: themes.details(id!) }),
    },
    {
      method: "PATCH",
      pattern: "/api/themes/:id",
      handler: async (request, { id }) => {
        const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
        return json({ theme: themes.update(id!, body) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/themes/:id",
      handler: (_request, { id }) => {
        themes.remove(id!);
        // Anything using the theme goes back to the default.
        store.forgetTheme(id!);
        return json({ settings: store.getSettings(), channels: store.listChannels() });
      },
    },
    {
      method: "POST",
      pattern: "/api/themes/:id/files",
      handler: async (request, { id }) => {
        // Files arrive as base64 text inside JSON, so every request that
        // changes something stays JSON (see checkRequestIsFromTheApp).
        const body = (await readJson(request)) as { name?: unknown; data?: unknown } | null;
        if (typeof body?.name !== "string" || typeof body?.data !== "string") {
          throw new HttpError(400, '"name" and "data" (base64) are required.');
        }
        return json({ files: themes.addFile(id!, body.name, Buffer.from(body.data, "base64")) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/themes/:id/files/:name",
      handler: (_request, { id, name }) => json({ files: themes.removeFile(id!, name!) }),
    },
  ];

  /**
   * The top-level request handler: API routes, then static files, and turn
   * any thrown error into a JSON error response.
   */
  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Theme files: /themes/<id>/<file>.
    const themeFile = url.pathname.match(/^\/themes\/([^/]+)\/([^/]+)$/);
    if (themeFile && (request.method === "GET" || request.method === "HEAD")) {
      return themes.serve(themeFile[1]!, themeFile[2]!) ?? new Response("Not found", { status: 404 });
    }

    if (!url.pathname.startsWith("/api/")) {
      return serveStatic(config.publicDir, url.pathname);
    }

    try {
      checkRequestIsFromTheApp(request);
      for (const route of routes) {
        const params = matchRoute(route, request.method, url.pathname);
        if (params) return await route.handler(request, params);
      }
      return errorResponse(404, "No such API route.");
    } catch (error) {
      return errorFor(error);
    }
  }

  return { fetch, store, kitsikai, events, replies, themes };
}

/** Turn a thrown error into the right JSON error response. */
export function errorFor(error: unknown): Response {
  if (error instanceof HttpError) return errorResponse(error.status, error.message);
  if (error instanceof NotFoundError) return errorResponse(404, error.message);
  if (error instanceof BusyError) return errorResponse(409, error.message);
  if (error instanceof ValidationError) return errorResponse(400, error.message);
  // A turn you stopped isn't an error: the request that started it just
  // learns that nothing was written.
  if (error instanceof CancelledError) return json({ cancelled: true });
  if (error instanceof ApiError) return errorResponse(502, error.message);
  // Anything else is a bug, not something you did. Log the details for
  // debugging, and send a general message.
  console.error("[server] unexpected error", error);
  return errorResponse(500, "Something went wrong on the server.");
}

/** A turn's result, as the app receives it. */
function turnResult(result: TurnResult) {
  return { kitsikaiMessages: result.messages };
}

// -------------------------------------------------------- request helpers

/**
 * Basic protection against other websites using your server.
 *
 * Any web page open in your phone's browser could try to send requests to
 * `http://127.0.0.1:3000`. Browsers block such pages from *reading* the
 * answers, but a simple form-style POST could still make Kitsikai take a turn
 * (and spend your nanoGPT balance). Requiring a JSON content type on every
 * request that changes something stops that: browsers won't send a
 * cross-site JSON request without first asking the server for permission,
 * and this server never gives it.
 */
function checkRequestIsFromTheApp(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) {
    throw new HttpError(415, "API requests that change data must be sent as JSON.");
  }
}

/** Parse the request body as JSON, with a clear error if it isn't. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "The request body isn't valid JSON.");
  }
}

/** Read a JSON body that must be an object. */
export async function readObject(request: Request): Promise<Record<string, unknown>> {
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/** Read a required, non-empty text field from a JSON body. */
export function requireText(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `"${field}" must be non-empty text.`);
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `"${field}" is too long.`);
  }
  return value;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

// ------------------------------------------------------------ static files

/**
 * Serve a file from `public/`.
 *
 * `/` serves `index.html`. The path is normalised and checked to stay inside
 * the public folder, so a request like `/../.env` can't read files elsewhere.
 */
async function serveStatic(publicDir: string, pathname: string): Promise<Response> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const filePath = normalize(join(publicDir, relative));
  if (!filePath.startsWith(publicDir + sep)) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  // `no-cache` means "check with the server before using a cached copy", so
  // updates to the app show up on the next load instead of being stuck behind
  // a stale cache.
  return new Response(file, { headers: { "Cache-Control": "no-cache" } });
}

// --------------------------------------------------------------- start up

/** Start listening. Only runs when this file is executed directly. */
function main(): void {
  const config = loadConfig();
  const app = createApp(config);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: app.fetch,
    // Model replies can take a while; don't let Bun close the connection on
    // a slow generation. (Bun's limit is in seconds, 255 at most; 0 = never.)
    idleTimeout: 0,
  });

  console.log(`Kitsikai is running at http://${server.hostname}:${server.port}`);
  console.log(`Saving your data in ${config.dataDir}`);
  if (!config.apiKey) {
    console.warn("Warning: NANOGPT_API_KEY is not set, so Kitsikai can't reply yet. See .env.example.");
  }
}

// `import.meta.main` is true when this file is run with `bun run src/server.ts`,
// and false when the tests import it. That way importing doesn't start a server.
if (import.meta.main) {
  main();
}
