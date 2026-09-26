/**
 * Kitsikai's web app: everything that happens in the browser.
 *
 * The app is deliberately simple, like Aettica's: no framework, no build
 * step. It keeps a copy of what's on screen in `state`, talks to the server
 * with `fetch`, and redraws with the `render...` functions whenever
 * something changes.
 *
 * The server is always the source of truth. The browser never guesses what
 * was saved; it shows what the server sends back.
 *
 * The open channel is kept in the address bar (`#/channel/<id>`), so reloading
 * the page, or reopening the app, brings you back to the same channel.
 */

"use strict";

// ------------------------------------------------------------------ state

/** Everything the page is currently showing. */
const state = {
  /** App-wide settings: name, userName, persona, chatAssignment, historyLimit, appTheme, themeOptions. */
  settings: null,
  /** Every channel, in sidebar order: {id, name, kind, theme, assignment, position}. */
  channels: [],
  /** Id of the open channel, or null if there are no channels. */
  channelId: null,
  /** Connection profiles: {id, name, model, temperature, maxTokens, topP, reasoningEffort, supportsTools, quirkPrompt, extraParams}. */
  profiles: [],
  /** Roulettes: {id, name, entries: [{profileId, weight}]}. */
  roulettes: [],
  /** The profile or roulette open in its editor (null for a new one). */
  editingProfile: null,
  editingRoulette: null,
  /** Messages in the open channel: {id, channelId, author, content, turnId, createdAt, editedAt?, model?, profile?}. */
  messages: [],
  /** Ids of channels where she's writing right now. */
  busy: new Set(),
  /** Id of the message being edited, if any. */
  editingId: null,
  /** What "Try again" does after an error, or null if retrying makes no sense. */
  retry: null,
  /** Unsent text for each channel, so switching channels doesn't lose it. */
  drafts: new Map(),
  /** Every theme: {id, name, description, builtIn, hasLite, swatch, options}. */
  themes: [],
  /** Added to theme URLs (`?v=`). Bumped after you edit a theme, so the browser fetches the new version. */
  themeVersion: 0,
  /** The theme open in the theme editor (with its css, liteCss and files). */
  editingTheme: null,
  /** Fingerprint of the app's files when this page loaded (see `checkForUpdate`). */
  appVersion: null,
};

// Shortcut for looking up elements by id.
const $ = (id) => document.getElementById(id);

const els = {
  app: $("app"),
  channelList: $("channel-list"),
  channelIndicator: Object.assign(document.createElement("li"), {
    className: "channel-indicator",
    ariaHidden: "true",
  }),
  channelView: $("channel-view"),
  channelName: $("channel-name"),
  channelTitleIcon: $("channel-title-icon"),
  channelTopic: $("channel-topic"),
  messages: $("messages"),
  composer: $("composer"),
  status: $("status"),
  error: $("error"),
  errorText: $("error-text"),
  errorRetry: $("error-retry"),
  form: $("composer-form"),
  input: $("composer-input"),
  send: $("send-button"),
  turn: $("turn-button"),
  settingsDialog: $("settings-dialog"),
  settingsForm: $("settings-form"),
  channelDialog: $("channel-dialog"),
  channelForm: $("channel-form"),
  promptDialog: $("prompt-dialog"),
  promptPreview: $("prompt-preview"),
  modelList: $("model-list"),
  loadModels: $("load-models"),
};

/** The open channel's full details, or undefined. */
function currentChannel() {
  return state.channels.find((c) => c.id === state.channelId);
}

/** Her name, for labels. */
function herName() {
  return state.settings?.name ?? "Kitsikai";
}

// ------------------------------------------------------------ server API

/**
 * Call the server's API and return the parsed JSON.
 *
 * Every request that sends data is marked as JSON; the server insists on it
 * (see `checkRequestIsFromTheApp` in src/server.ts). If the server answers
 * with an error, this throws an Error carrying the server's message.
 */
async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  }
  return data;
}

/** The API path for something in the open channel, e.g. channelPath("turn"). */
function channelPath(suffix, channelId = state.channelId) {
  return `/api/channels/${encodeURIComponent(channelId)}/${suffix}`;
}

/** Fetch settings, channels, profiles and busy channels from the server. */
async function loadState() {
  const data = await api("GET", "/api/state");
  state.settings = data.settings;
  state.channels = data.channels;
  state.profiles = data.profiles;
  state.roulettes = data.roulettes;
  state.busy = new Set(data.busyChannels);
  state.appVersion ??= data.appVersion;
  checkForUpdate(data.appVersion);
}

// ------------------------------------------------------------- updates

/*
 * An installed app can stay open in the background for days. After you
 * update Kitsikai and restart the server, a page that's still open would keep
 * running the old code. So the server sends a fingerprint of the app's files
 * (`appVersion`), and the page checks it whenever it hears from the server,
 * and whenever you come back to it.
 */

/**
 * Compare the server's app version with the one this page started with. If
 * they differ, reload, unless that would throw something away (unsent
 * text, an open dialog, a reply being written), in which case offer a
 * Reload button instead.
 */
function checkForUpdate(serverVersion) {
  if (!serverVersion || !state.appVersion || serverVersion === state.appVersion) return;

  const unsentText = els.input.value.trim() !== "" || [...state.drafts.values()].some((d) => d.trim() !== "");
  const busy = state.busy.size > 0 || state.editingId !== null || document.querySelector("dialog[open]");
  if (!unsentText && !busy) {
    location.reload();
  } else {
    $("update-banner").hidden = false;
  }
}

/** Ask the server for its app version (used when you come back to the app). */
async function checkServerVersion() {
  try {
    const data = await api("GET", "/api/state");
    checkForUpdate(data.appVersion);
  } catch {
    // Server not running right now; nothing to compare.
  }
}

// ------------------------------------------------------------- channels

/**
 * Open a channel: load its messages and redraw everything.
 * Also used to refresh the open channel after changes.
 */
async function openChannel(channelId) {
  // Keep whatever you'd typed in the channel you're leaving.
  if (state.channelId) state.drafts.set(state.channelId, els.input.value);

  state.channelId = channelId;
  state.editingId = null;
  state.messages = [];
  hideError();

  // Put the channel in the address bar without adding a history entry for
  // every switch. (Only if it isn't there already, to avoid a loop with the
  // hashchange handler.)
  const hash = channelId ? `#/channel/${channelId}` : "";
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);

  if (channelId) {
    try {
      const { messages } = await api("GET", channelPath("messages", channelId));
      // Ignore the answer if you switched again while it was loading.
      if (state.channelId !== channelId) return;
      state.messages = messages;
    } catch (error) {
      showError(`Couldn't load this channel: ${error.message}`, () => openChannel(channelId));
    }
  }

  els.input.value = state.drafts.get(channelId) ?? "";
  autoGrow();
  renderAll();
  scrollToBottom();
}

/** The channel named in the address bar, if it exists. */
function channelFromAddress() {
  const match = location.hash.match(/^#\/channel\/(.+)$/);
  const id = match && decodeURIComponent(match[1]);
  return state.channels.some((c) => c.id === id) ? id : null;
}

async function saveChannel(event) {
  event.preventDefault();
  const channel = currentChannel();
  const form = els.channelForm.elements;
  const body = { name: form.name.value, theme: form.theme.value || null, assignment: form.assignment.value || null };
  try {
    const { channel: updated } = await api("PATCH", `/api/channels/${encodeURIComponent(channel.id)}`, body);
    updateChannelInState(updated);
    els.channelDialog.close();
    renderAll();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

async function clearChannel() {
  const channel = currentChannel();
  if (!confirm(`Delete every message in #${channel.name}? This can't be undone.`)) return;
  try {
    await api("DELETE", channelPath("messages"), {});
    state.messages = [];
    els.channelDialog.close();
    renderMessages();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

/** Replace a channel in `state.channels` with a fresh copy from the server. */
function updateChannelInState(channel) {
  state.channels = state.channels.map((c) => (c.id === channel.id ? channel : c));
}

// ------------------------------------------------------ messages & turns

/**
 * Requests from *this* page that make her write, by channel id.
 * Each is `{ startedAt, onAbandon }`; see `withBusyChannel` and `checkBusy`.
 */
const pendingRequests = new Map();

/**
 * Run a request that makes her write in a channel: marks the channel busy
 * while it runs, and redraws afterwards.
 *
 * @param work       Does the request. It receives `stillMine()`, which turns
 *                   false if the request was abandoned (you pressed Stop, or
 *                   the page decided the request was lost). An abandoned
 *                   request's late answer must be ignored: the channel has
 *                   already been reloaded from the server.
 * @param onAbandon  Optional. Called with the reloaded messages if the
 *                   request is abandoned while you're in its channel.
 */
async function withBusyChannel(channelId, work, onAbandon) {
  const request = { startedAt: Date.now(), onAbandon };
  pendingRequests.set(channelId, request);
  state.busy.add(channelId);
  renderAll();
  if (channelId === state.channelId) scrollToBottom();
  startBusyWatch();

  const stillMine = () => pendingRequests.get(channelId) === request;
  try {
    await work(stillMine);
  } finally {
    if (stillMine()) {
      pendingRequests.delete(channelId);
      state.busy.delete(channelId);
      renderAll();
      if (channelId === state.channelId) scrollToBottom();
    }
  }
}

/**
 * Stop waiting for this page's request in a channel. Returns the request
 * (or undefined if there wasn't one), so its `onAbandon` can still be run.
 */
function abandonRequest(channelId) {
  const request = pendingRequests.get(channelId);
  pendingRequests.delete(channelId);
  state.busy.delete(channelId);
  return request;
}

/** Reload the open channel's messages, e.g. after a turn was stopped. */
async function refreshMessages(onAbandon) {
  const channelId = state.channelId;
  if (!channelId) return;
  try {
    const { messages } = await api("GET", channelPath("messages", channelId));
    if (state.channelId !== channelId) return;
    state.messages = messages;
    onAbandon?.(messages);
  } catch (error) {
    showError(`Couldn't reload this channel: ${error.message}`, () => refreshMessages());
  }
  renderAll();
  scrollToBottom();
}

/**
 * The Stop button: ask the server to stop her turn in the open channel, stop
 * waiting for it here, and reload the channel so it shows exactly what was
 * saved (your message, if you'd just sent one; no reply).
 */
async function stopTurn() {
  const channelId = state.channelId;
  const request = abandonRequest(channelId);
  hideError();
  renderAll();
  try {
    await api("POST", channelPath("cancel", channelId), {});
  } catch (error) {
    showError(`Couldn't reach the server to stop the reply: ${error.message}`, null);
  }
  await refreshMessages(request?.onAbandon);
}

/*
 * Checking in with the server while anything is busy.
 *
 * A request can be lost without ever failing: on a phone, the connection
 * can quietly drop when the app goes to the background or the screen locks,
 * and the page would wait for an answer that never comes, with the channel
 * stuck on "typing…". So while any channel is busy, the page asks the server
 * every few seconds which channels are *really* busy, and un-sticks the ones
 * the server has finished with. (From Aettica.)
 */

/** How often to check, in milliseconds. */
const BUSY_CHECK_INTERVAL = 3000;
/** A request younger than this is never treated as lost: it may simply not have reached the server yet. */
const LOST_REQUEST_GRACE = 8000;

let busyWatch = null;

function startBusyWatch() {
  if (!busyWatch) busyWatch = setInterval(checkBusy, BUSY_CHECK_INTERVAL);
}

async function checkBusy() {
  if (state.busy.size === 0) {
    clearInterval(busyWatch);
    busyWatch = null;
    return;
  }

  let serverBusy;
  try {
    const data = await api("GET", "/api/state");
    serverBusy = new Set(data.busyChannels);
    checkForUpdate(data.appVersion);
  } catch {
    return; // server unreachable for a moment; try again next time
  }

  for (const channelId of [...state.busy]) {
    if (serverBusy.has(channelId)) continue;
    const request = pendingRequests.get(channelId);
    if (request && Date.now() - request.startedAt < LOST_REQUEST_GRACE) continue;
    // The server is done, but this page never heard back. Catch up.
    abandonRequest(channelId);
    if (channelId === state.channelId) await refreshMessages(request?.onAbandon);
  }
  for (const channelId of serverBusy) state.busy.add(channelId);
  renderAll();
}

/**
 * Send what's in the text box. The server saves it and she replies in the
 * same request.
 */
async function sendMessage() {
  const channelId = state.channelId;
  const content = els.input.value;
  if (!channelId || content.trim() === "" || state.busy.has(channelId)) return;

  hideError();
  // Show your message straight away, as a placeholder, while she writes.
  // It's swapped for the saved copy when the server answers.
  const sentAt = new Date();
  const placeholder = {
    id: "pending",
    channelId,
    author: "user",
    content: content.trim(),
    turnId: null,
    createdAt: sentAt.toISOString(),
  };
  state.messages.push(placeholder);
  els.input.value = "";
  state.drafts.delete(channelId);
  autoGrow();

  // If the request is abandoned (Stop, or lost) and the server never saved
  // your message, put your text back in the box so it isn't lost.
  const restoreIfUnsaved = (messages) => {
    const saved = messages.some((m) => m.author === "user" && new Date(m.createdAt) >= sentAt - 2000);
    if (!saved && els.input.value === "") {
      els.input.value = content;
      autoGrow();
    }
  };

  await withBusyChannel(
    channelId,
    async (stillMine) => {
      try {
        const data = await api("POST", channelPath("messages", channelId), { content });
        if (!stillMine()) return; // abandoned; the channel was already reloaded
        if (state.channelId !== channelId) return; // you've moved on; it'll load when you return
        state.messages = state.messages.filter((m) => m !== placeholder);
        state.messages.push(...data.userMessages);
        if (data.kitsikaiMessages) {
          acceptTurn(data);
        } else if (data.error) {
          // Your message is saved but the reply failed. "Try again" asks her
          // for a turn, which answers the message you already sent.
          showError(data.error, herTurn);
        }
      } catch (error) {
        if (!stillMine()) return;
        // Nothing was saved (e.g. the server is down), so put your text back
        // in the box; "Try again" simply sends it again.
        state.messages = state.messages.filter((m) => m !== placeholder);
        if (state.channelId === channelId) {
          els.input.value = content;
          autoGrow();
          showError(error.message, sendMessage);
        } else {
          state.drafts.set(channelId, content);
        }
      }
    },
    restoreIfUnsaved,
  );
}

/** Let her text without a new message from you. */
async function herTurn() {
  await runTurn("turn", acceptTurn, herTurn);
}

/**
 * Replace her last reply (every bubble of it) with a fresh one.
 *
 * @param profileId  Write with this profile. Without one, the channel's
 *                   profile or roulette picks again.
 */
async function regenerate(profileId) {
  await runTurn(
    "regenerate",
    (data) => {
      const replaced = new Set(data.replacedIds);
      state.messages = state.messages.filter((m) => !replaced.has(m.id));
      acceptTurn(data);
    },
    () => regenerate(profileId),
    profileId ? { profileId } : {},
  );
}

/** Take in a turn's result: her new messages. */
function acceptTurn(data) {
  state.messages.push(...data.kitsikaiMessages);
}

/**
 * Shared wrapper for her turns in the open channel.
 *
 * @param action     "turn" or "regenerate" (the end of the API path).
 * @param onSuccess  Updates `state.messages` with the server's answer. Not
 *                   called if the turn was stopped.
 * @param retry      What "Try again" should do if it fails.
 * @param body       Sent with the request (e.g. the profile to regenerate with).
 */
async function runTurn(action, onSuccess, retry, body = {}) {
  const channelId = state.channelId;
  if (!channelId || state.busy.has(channelId)) return;
  hideError();
  await withBusyChannel(channelId, async (stillMine) => {
    try {
      const data = await api("POST", channelPath(action, channelId), body);
      if (stillMine() && state.channelId === channelId && data.kitsikaiMessages) onSuccess(data);
    } catch (error) {
      if (stillMine() && state.channelId === channelId) showError(error.message, retry);
    }
  });
}

async function saveEdit(id, content) {
  try {
    const data = await api("PATCH", `/api/messages/${encodeURIComponent(id)}`, { content });
    state.messages = state.messages.map((m) => (m.id === id ? data.message : m));
    state.editingId = null;
    renderMessages();
  } catch (error) {
    showError(error.message, null);
  }
}

async function deleteMessage(id) {
  if (!confirm("Delete this message?")) return;
  try {
    await api("DELETE", `/api/messages/${encodeURIComponent(id)}`, {});
    state.messages = state.messages.filter((m) => m.id !== id);
    renderMessages();
  } catch (error) {
    showError(error.message, null);
  }
}

// -------------------------------------------------------------- rendering

/** Redraw everything from `state`. */
function renderAll() {
  applyThemes();
  renderSidebar();
  renderChannelHeader();
  renderMessages();
  renderComposer();
}

/** The channel list and her card at the bottom of the sidebar. */
function renderSidebar() {
  els.channelList.replaceChildren(
    ...state.channels.map((channel) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.className = "channel-link";
      link.href = `#/channel/${channel.id}`;
      link.dataset.kind = channel.kind;
      if (channel.id === state.channelId) link.setAttribute("aria-current", "page");

      const name = document.createElement("span");
      name.className = "channel-link-name";
      name.textContent = channel.name;
      link.append(channelIcon(channel.kind), name);

      if (state.busy.has(channel.id)) {
        const dot = document.createElement("span");
        dot.className = "channel-busy";
        dot.title = `${herName()} is typing here`;
        link.append(dot);
      }
      item.append(link);
      return item;
    }),
  );

  // The indicator goes back in after the links, and moves to the open one.
  els.channelList.append(els.channelIndicator);
  moveChannelIndicator();

  $("server-name").textContent = herName();
  $("kitsikai-name").textContent = herName();
  $("kitsikai-avatar").textContent = initial(herName());
}

/**
 * Move the channel indicator (a pill a theme can show behind the open
 * channel's link) to the open channel. When it moves, it first stretches
 * to cover both links, then snaps into place with a little overshoot, like
 * a drop of liquid flowing from one to the other. (From Aettica.)
 */
function moveChannelIndicator() {
  const indicator = els.channelIndicator;
  const link = els.channelList.querySelector('.channel-link[aria-current="page"]');
  if (!link || getComputedStyle(indicator).display === "none") {
    delete indicator.dataset.top;
    return;
  }
  // Relative to the channel list, which is positioned.
  const top = link.offsetTop;
  const place = (y, stretch) => (indicator.style.transform = `translateY(${y}px) scaleY(${stretch})`);
  indicator.style.left = `${link.offsetLeft}px`;
  indicator.style.width = `${link.offsetWidth}px`;
  indicator.style.height = `${link.offsetHeight}px`;

  const from = Number(indicator.dataset.top);
  indicator.dataset.top = String(top);
  clearTimeout(moveChannelIndicator.timer);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!Number.isFinite(from) || from === top || reduced) {
    indicator.classList.remove("stretching", "settling");
    place(top, 1);
    return;
  }
  // Stretch over both links...
  const span = Math.abs(top - from) + link.offsetHeight;
  indicator.classList.remove("settling");
  indicator.classList.add("stretching");
  place(Math.min(from, top), span / link.offsetHeight);
  // ...then gather at the new one.
  moveChannelIndicator.timer = setTimeout(() => {
    indicator.classList.replace("stretching", "settling");
    place(top, 1);
  }, 170);
}

/** The icon for a kind of channel. */
function channelIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "channel-icon");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#icon-hash");
  svg.append(use);
  return svg;
}

/** Channel name at the top of the channel. */
function renderChannelHeader() {
  const channel = currentChannel();
  // These attributes are what per-channel themes hook onto.
  els.channelView.dataset.channelId = channel?.id ?? "";
  els.channelView.dataset.channelKind = channel?.kind ?? "";

  els.channelName.textContent = channel?.name ?? "";
  els.channelTopic.textContent = "";
  $("channel-settings-button").hidden = !channel;
  document.title = channel ? `#${channel.name} · ${herName()}` : herName();
}

/** Redraw the message list from `state.messages`. */
function renderMessages() {
  const channel = currentChannel();
  els.messages.replaceChildren();

  if (!channel) {
    els.messages.append(emptyNote("There are no channels yet."));
    return;
  }

  if (state.messages.length === 0) {
    els.messages.append(emptyNote(`Nothing here yet. Say hi, or press “Her turn” to let ${herName()} start.`));
    return;
  }

  // Her last turn can be regenerated; the button goes on its last bubble.
  const last = state.messages.at(-1);
  const canRegenerate = last?.author === "kitsikai";

  let previous = null;
  for (const message of state.messages) {
    els.messages.append(
      renderMessage(message, {
        continued: continuesGroup(previous, message),
        regenerate: canRegenerate && message === last,
      }),
    );
    previous = message;
  }
}

/**
 * Whether a message continues the one before it, Discord-style: same author
 * within a few minutes. A continued message hides its avatar and name, so a
 * burst of bubbles reads as one block.
 */
function continuesGroup(previous, message) {
  if (!previous) return false;
  const minutesApart = (new Date(message.createdAt) - new Date(previous.createdAt)) / 60000;
  return previous.author === message.author && minutesApart < 7;
}

function emptyNote(text) {
  const note = document.createElement("p");
  note.className = "empty";
  note.textContent = text;
  return note;
}

/**
 * Build the element for one message.
 *
 * Text is always inserted as text, never as raw HTML, except for the tiny
 * bit of formatting in `formatText`, which escapes everything first. That
 * way a model reply containing `<script>` can't run code in your browser.
 *
 * @param options.continued   Hide the avatar and name (see `continuesGroup`).
 * @param options.regenerate  Show the Regenerate button.
 */
function renderMessage(message, { continued = false, regenerate: showRegenerate = false } = {}) {
  const name = message.author === "user" ? state.settings.userName || "You" : herName();
  const pending = message.id === "pending";

  const root = document.createElement("article");
  root.className = ["message", pending && "pending", continued && "continued"].filter(Boolean).join(" ");
  root.dataset.author = message.author;
  root.dataset.messageId = message.id;
  // Tapping a bubble shows its Edit/Delete buttons (see style.css).
  root.addEventListener("click", (event) => {
    if (!event.target.closest("button, textarea")) root.classList.toggle("selected");
  });

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initial(name);
  avatar.setAttribute("aria-hidden", "true");

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.className = "message-author";
  author.textContent = name;
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = message.createdAt;
  time.textContent = formatTime(message.createdAt) + (message.editedAt ? " (edited)" : "");
  meta.append(author, time);
  if (message.model) {
    const model = document.createElement("span");
    model.className = "message-model";
    // The profile's name if it has one, otherwise the part of the model id
    // after the last "/", to save space on a phone. The full id shows when
    // you hover or long-press.
    model.textContent = message.profile ?? message.model.split("/").at(-1);
    model.title = message.model;
    meta.append(model);
  }

  root.append(avatar, meta);

  if (state.editingId === message.id) {
    root.append(renderEditor(message));
    return root;
  }

  const content = document.createElement("div");
  content.className = "message-content";
  content.innerHTML = formatText(message.content);
  root.append(content);

  // A message that's still being sent has no actions yet.
  if (pending) return root;

  const busy = state.busy.has(state.channelId);
  const actions = document.createElement("div");
  actions.className = "message-actions";
  if (showRegenerate) actions.classList.add("always");
  actions.append(
    actionButton("Edit", () => {
      state.editingId = message.id;
      renderMessages();
    }),
    actionButton("Delete", () => deleteMessage(message.id), busy),
  );
  if (showRegenerate) {
    actions.append(actionButton("Regenerate", () => regenerate(), busy));
    if (state.profiles.length > 1) actions.append(actionButton("Regenerate with…", openRegenerateWith, busy));
  }
  root.append(actions);
  return root;
}

/** The inline editor shown in place of a message's text while editing. */
function renderEditor(message) {
  const wrapper = document.createElement("div");
  const box = document.createElement("textarea");
  box.className = "edit-box";
  box.value = message.content;

  const actions = document.createElement("div");
  actions.className = "message-actions always";
  actions.append(
    actionButton("Save", () => {
      if (box.value.trim() !== "") saveEdit(message.id, box.value);
    }),
    actionButton("Cancel", () => {
      state.editingId = null;
      renderMessages();
    }),
  );

  wrapper.append(box, actions);
  // Focus the box once it's on the page.
  queueMicrotask(() => box.focus());
  return wrapper;
}

function actionButton(label, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

/** Show or hide the composer, the "typing…" indicator, and lock buttons while busy. */
function renderComposer() {
  const channel = currentChannel();
  els.composer.hidden = !channel;
  if (!channel) return;

  const busy = state.busy.has(channel.id);
  els.status.hidden = !busy;
  $("status-text").textContent = `${herName()} is typing…`;
  els.send.disabled = busy;
  els.turn.disabled = busy;
  els.input.placeholder = `Message #${channel.name}`;
}

/**
 * Turn message text into safe HTML with light formatting: `**bold**` and
 * `*italics*` (or `_italics_`). Line breaks are kept by CSS
 * (`white-space: pre-wrap`).
 */
function formatText(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/(^|\W)_(.+?)_(?=\W|$)/g, "$1<em>$2</em>");
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The first letter of a name, for avatars. */
function initial(name) {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** "14:05" for today, "Sep 24, 14:05" for older messages. */
function formatTime(iso) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

// ------------------------------------------------------------------ errors

/**
 * Show an error above the composer. `retry` is the function "Try again"
 * should call, or null to hide that button.
 */
function showError(message, retry) {
  state.retry = retry;
  els.errorText.textContent = message;
  els.errorRetry.hidden = !retry;
  els.error.hidden = false;
}

function hideError() {
  state.retry = null;
  els.error.hidden = true;
}

/** Show an error inside a dialog's form. */
function showFormError(form, message) {
  const box = form.querySelector(".form-error");
  box.textContent = message;
  box.hidden = false;
}

function hideFormError(form) {
  form.querySelector(".form-error").hidden = true;
}

function showNotice(text) {
  $("notice-text").textContent = text;
  $("notice").hidden = false;
}

// ----------------------------------------------------------------- themes

/*
 * Themes are CSS files served by the server (see src/themes.ts). Applying
 * one just means pointing a <link> at it; index.html has four, in order:
 *
 *   theme-app           the app theme                  /themes/<id>/theme.css
 *   theme-app-lite      its Lite version, if in use    /themes/<id>/theme-lite.css
 *   theme-channel       the open channel's own theme   /themes/<id>/channel.css
 *   theme-channel-lite  its Lite version, if in use    /themes/<id>/channel-lite.css
 *
 * The channel versions are rewritten by the server to only affect the
 * channel view. And while a channel theme is showing, the app theme is
 * loaded as `outside.css` instead: rewritten to affect everything *but* the
 * channel view, so the channel theme fully replaces it there.
 */

/** Keys for things remembered on this device only (in the browser's localStorage). */
const EFFECTS_KEY = "kitsikai.effects"; // "auto" | "full" | "lite"
const AUTO_LITE_KEY = "kitsikai.autoLite"; // "1" once Automatic has switched to Lite
const LAST_THEME_KEY = "kitsikai.lastAppTheme"; // to apply the theme before the server answers

/*
 * localStorage can be unavailable (private browsing, storage turned off),
 * so every use is wrapped: if it fails, Kitsikai just forgets.
 */
function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the setting just won't be remembered.
  }
}

/** This device's glass effects choice: "auto", "full" or "lite". */
function effectsMode() {
  return readLocal(EFFECTS_KEY) ?? "auto";
}

/** Whether Lite versions of themes should be loaded right now. */
function liteEffects() {
  const mode = effectsMode();
  return mode === "lite" || (mode === "auto" && readLocal(AUTO_LITE_KEY) === "1");
}

function themeInfo(id) {
  return state.themes.find((t) => t.id === id);
}

/**
 * Point a theme <link> at a stylesheet, or unload it (`href` null).
 *
 * Swapping one stylesheet for another would briefly show the page without
 * either while the new one downloads. So the new one is loaded in a second
 * <link> next to the old, and the old is removed once the new has arrived.
 */
function setStylesheet(linkId, href) {
  const link = $(linkId);
  const current = link.getAttribute("href");
  if (!href) {
    link.removeAttribute("href");
    return;
  }
  if (current === href) return;
  if (!current) {
    link.addEventListener(
      "load",
      () => {
        scrollToBottom();
        themeLoaded();
      },
      { once: true },
    );
    link.setAttribute("href", href);
    return;
  }
  const next = link.cloneNode();
  next.setAttribute("href", href);
  link.removeAttribute("id"); // the new link takes over the id straight away
  const done = () => {
    link.remove();
    scrollToBottom();
    themeLoaded();
  };
  next.addEventListener("load", done, { once: true });
  next.addEventListener("error", done, { once: true });
  link.after(next);
}

/** The app theme and the open channel's theme, if it has a different one. */
function activeThemes() {
  const app = state.settings?.appTheme ?? "classic";
  const channel = currentChannel();
  return { app, channel: channel?.theme && channel.theme !== app ? channel.theme : null };
}

/** Load the stylesheets for the current app theme, channel theme and effects. */
function applyThemes() {
  const { app, channel } = activeThemes();
  const lite = liteEffects();
  const v = state.themeVersion;
  // Classic is the base stylesheet itself, so there's nothing to load for it.
  const appTheme = app === "classic" ? null : app;

  const appFile = channel ? "outside" : "theme";
  setStylesheet("theme-app", appTheme && `/themes/${appTheme}/${appFile}.css?v=${v}`);
  setStylesheet("theme-app-lite", appTheme && lite && themeInfo(appTheme)?.hasLite && `/themes/${appTheme}/${appFile}-lite.css?v=${v}`);
  setStylesheet("theme-channel", channel && `/themes/${channel}/channel.css?v=${v}`);
  setStylesheet("theme-channel-lite", channel && lite && themeInfo(channel)?.hasLite && `/themes/${channel}/channel-lite.css?v=${v}`);

  // For theme authors: the channel view says which channel theme it has.
  els.channelView.dataset.channelTheme = channel ?? "";
  writeLocal(LAST_THEME_KEY, appTheme ?? "");
  applyThemeOptions();
  updateGlass();
}

/**
 * Once a theme's stylesheet has loaded: things that depend on how the theme
 * looks.
 */
function themeLoaded() {
  updateGlass();
  moveChannelIndicator();
}

/**
 * Real liquid glass (public/glass.js): on when a theme asks for it (with
 * `--lensing: on` in its :root), and glass effects aren't Lite.
 */
function updateGlass() {
  const wants = (element) => getComputedStyle(element).getPropertyValue("--lensing").trim() === "on";
  Glass.setEnabled(!liteEffects() && (wants(document.documentElement) || wants(els.channelView)));
  Glass.refresh();
}

/*
 * Theme options: sliders a theme declares in its theme.json, each setting a
 * CSS variable (like --bubble-transparency). The values are set straight on
 * the page: the app theme's on <html>, and a channel theme's on the channel
 * view, where they win over the theme's own defaults.
 */

/** The variables set by the last call, so they can be cleared. */
const appliedOptions = { root: [], channel: [] };

/** A theme's option values: yours where you've moved a slider, the theme's default elsewhere. */
function themeOptionValues(themeId) {
  const saved = state.settings?.themeOptions?.[themeId] ?? {};
  return (themeInfo(themeId)?.options ?? []).map((option) => {
    const raw = saved[option.id];
    const value = typeof raw === "number" ? Math.min(option.max, Math.max(option.min, raw)) : option.default;
    return { option, value };
  });
}

function applyThemeOptions() {
  const { app, channel } = activeThemes();
  const set = (element, key, themeId) => {
    for (const variable of appliedOptions[key]) element.style.removeProperty(variable);
    appliedOptions[key] = [];
    if (!themeId) return;
    for (const { option, value } of themeOptionValues(themeId)) {
      element.style.setProperty(option.variable, `${value}${option.unit}`);
      appliedOptions[key].push(option.variable);
    }
  };
  set(document.documentElement, "root", app);
  set(els.channelView, "channel", channel);
  // Sliders can change the glass's settings: remake its lenses.
  Glass.refresh();
}

async function loadThemes() {
  state.themes = (await api("GET", "/api/themes")).themes;
}

/*
 * Automatic glass effects: real blur can make scrolling stutter on some
 * phones. In Automatic mode, the first few times you scroll the message
 * list, the page times its frames. If a typical frame took longer than
 * STUTTER_FRAME_MS (fewer than about 35 frames a second), it switches this
 * device to the Lite versions of themes, and says so.
 */
const STUTTER_FRAME_MS = 28;
const STUTTER_SAMPLES = 90;
const STUTTER_WATCH_MS = 2500;
const stutter = { samples: [], watchedMs: 0, sampling: false, done: false };

function watchForStutter() {
  if (stutter.done || stutter.sampling || effectsMode() !== "auto" || liteEffects()) return;
  // Only worth measuring if a theme with a Lite version is in use.
  const { app, channel } = activeThemes();
  if (!themeInfo(app)?.hasLite && !themeInfo(channel)?.hasLite) return;

  stutter.sampling = true;
  let last = performance.now();
  const stopAt = last + 1000; // sample for a second after scrolling starts
  const frame = (now) => {
    stutter.samples.push(now - last);
    stutter.watchedMs += now - last;
    last = now;
    if (now < stopAt) {
      requestAnimationFrame(frame);
    } else {
      stutter.sampling = false;
      judgeStutter();
    }
  };
  requestAnimationFrame(frame);
}

function judgeStutter() {
  // Keep collecting on later scrolls until there's enough to go on.
  if (stutter.samples.length < STUTTER_SAMPLES && stutter.watchedMs < STUTTER_WATCH_MS) return;
  stutter.done = true;
  const sorted = [...stutter.samples].sort((a, b) => a - b);
  const typicalFrame = sorted[Math.floor(sorted.length / 2)];
  if (typicalFrame > STUTTER_FRAME_MS) {
    writeLocal(AUTO_LITE_KEY, "1");
    applyThemes();
    showNotice("Scrolling was stuttering, so glass effects switched to Lite on this device. You can change this in Appearance.");
  }
}

// ------------------------------------------------------------- appearance

function openAppearance() {
  renderThemeList();
  renderThemeOptions();
  for (const radio of document.querySelectorAll('input[name="effects"]')) radio.checked = radio.value === effectsMode();
  hideFormError($("appearance-dialog"));
  $("appearance-dialog").showModal();
}

/** The theme cards in Appearance. The app theme is the selected one. */
function renderThemeList() {
  const selected = state.settings.appTheme;
  $("theme-list").replaceChildren(
    ...state.themes.map((theme) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "theme-card";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(theme.id === selected));

      // The preview: a strip of the theme's colours.
      const swatch = document.createElement("span");
      swatch.className = "theme-swatch";
      for (const colour of theme.swatch.length ? theme.swatch : ["var(--input-bg)"]) {
        const part = document.createElement("span");
        part.style.background = colour;
        swatch.append(part);
      }

      const name = document.createElement("span");
      name.className = "theme-name";
      name.textContent = theme.name;
      const badge = document.createElement("span");
      badge.className = "theme-badge";
      badge.textContent = theme.builtIn ? "Built-in" : "Yours";
      name.append(" ", badge);

      const description = document.createElement("span");
      description.className = "theme-description";
      description.textContent = theme.description;

      card.append(swatch, name, description);
      card.addEventListener("click", () => chooseAppTheme(theme.id));
      return card;
    }),
  );

  // Edit and Delete are only for your own themes.
  const current = themeInfo(selected);
  $("theme-edit").hidden = !current || current.builtIn;
  $("theme-delete").hidden = !current || current.builtIn;
}

async function chooseAppTheme(id) {
  try {
    const { settings } = await api("PUT", "/api/settings", { appTheme: id });
    state.settings = settings;
    renderThemeList();
    renderThemeOptions();
    renderAll();
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

/** Copy the selected theme into a new theme of your own, and open it in the editor. */
async function copyTheme() {
  const source = themeInfo(state.settings.appTheme);
  const name = prompt("Name for your theme:", source ? `My ${source.name}` : "My theme");
  if (!name) return;
  try {
    const { theme } = await api("POST", "/api/themes", { name, from: source?.id });
    await loadThemes();
    await chooseAppTheme(theme.id);
    openThemeEditor(theme.id);
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

async function deleteTheme() {
  const theme = themeInfo(state.settings.appTheme);
  if (!theme || !confirm(`Delete the theme "${theme.name}" and its images? This can't be undone.`)) return;
  try {
    const data = await api("DELETE", `/api/themes/${encodeURIComponent(theme.id)}`, {});
    // Anything that used it has gone back to the default.
    state.settings = data.settings;
    state.channels = data.channels;
    await loadThemes();
    renderThemeList();
    renderAll();
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

/**
 * The sliders in Appearance: the app theme's, and the open channel's theme's
 * if it has its own. Moving one applies at once; letting go saves it.
 */
function renderThemeOptions() {
  const { app, channel } = activeThemes();
  const groups = [];
  const add = (themeId, title) => {
    const values = themeOptionValues(themeId);
    if (values.length === 0 || groups.some((g) => g.themeId === themeId)) return;
    groups.push({ themeId, title, values });
  };
  add(app, themeInfo(app)?.name ?? "App theme");
  if (channel) add(channel, `#${currentChannel()?.name}: ${themeInfo(channel)?.name ?? channel}`);

  const box = $("theme-options");
  box.hidden = groups.length === 0;
  box.replaceChildren(
    ...groups.map(({ themeId, title, values }) => {
      const section = document.createElement("fieldset");
      section.className = "theme-option-group";
      const legend = document.createElement("legend");
      legend.textContent = title;
      section.append(legend);
      for (const { option, value } of values) {
        const row = document.createElement("label");
        row.className = "theme-option";
        const name = document.createElement("span");
        name.className = "theme-option-label";
        name.textContent = option.label;
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = option.min;
        slider.max = option.max;
        slider.step = option.step;
        slider.value = value;
        const shown = document.createElement("output");
        shown.className = "theme-option-value";
        const show = (v) => (shown.textContent = formatOption(option, v));
        show(value);
        slider.addEventListener("input", () => {
          setThemeOption(themeId, option.id, Number(slider.value));
          show(Number(slider.value));
        });
        slider.addEventListener("change", saveThemeOptions);
        row.append(name, slider, shown);
        section.append(row);
      }
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "link-button";
      reset.textContent = "Reset to the theme's defaults";
      reset.addEventListener("click", () => {
        delete state.settings.themeOptions[themeId];
        applyThemeOptions();
        renderThemeOptions();
        saveThemeOptions();
      });
      section.append(reset);
      return section;
    }),
  );
}

/** "55%" for fractions of 1, "14px", or the plain number. */
function formatOption(option, value) {
  if (!option.unit && option.min >= 0 && option.max <= 1) return `${Math.round(value * 100)}%`;
  return `${Math.round(value * 100) / 100}${option.unit}`;
}

/** Change one slider's value locally, and show it straight away. */
function setThemeOption(themeId, optionId, value) {
  const all = (state.settings.themeOptions ??= {});
  all[themeId] = { ...all[themeId], [optionId]: value };
  applyThemeOptions();
}

async function saveThemeOptions() {
  try {
    const { settings } = await api("PUT", "/api/settings", { themeOptions: state.settings.themeOptions ?? {} });
    state.settings = settings;
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

function chooseEffects(mode) {
  writeLocal(EFFECTS_KEY, mode);
  if (mode === "auto") {
    // Choosing Automatic again starts the stutter check afresh.
    writeLocal(AUTO_LITE_KEY, null);
    Object.assign(stutter, { samples: [], watchedMs: 0, sampling: false, done: false });
  }
  applyThemes();
}

// ----------------------------------------------------------- theme editor

async function openThemeEditor(id) {
  try {
    const { theme } = await api("GET", `/api/themes/${encodeURIComponent(id)}`);
    state.editingTheme = theme;
    const form = $("theme-editor-form").elements;
    form.name.value = theme.name;
    form.description.value = theme.description;
    form.css.value = theme.css;
    form.liteCss.value = theme.liteCss;
    form.options.value = theme.options.length ? JSON.stringify(theme.options, null, 2) : "";
    renderThemeFiles(theme.files);
    hideFormError($("theme-editor-form"));
    $("theme-editor").showModal();
  } catch (error) {
    showFormError($("appearance-dialog"), error.message);
  }
}

/** Save the editor's changes and reload the theme's stylesheets. */
async function saveTheme(close) {
  const form = $("theme-editor-form").elements;
  try {
    let options;
    try {
      options = form.options.value.trim() ? JSON.parse(form.options.value) : [];
    } catch {
      throw new Error('The sliders must be valid JSON: a list like [{"id": ...}].');
    }
    await api("PATCH", `/api/themes/${encodeURIComponent(state.editingTheme.id)}`, {
      name: form.name.value,
      description: form.description.value,
      css: form.css.value,
      liteCss: form.liteCss.value,
      options,
    });
    state.themeVersion++;
    await loadThemes();
    renderThemeList();
    renderThemeOptions();
    renderAll();
    if (close) $("theme-editor").close();
  } catch (error) {
    showFormError($("theme-editor-form"), error.message);
  }
}

/** The list of images and fonts in the theme being edited. */
function renderThemeFiles(files) {
  const list = $("theme-files");
  if (files.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = "No files yet.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...files.map((name) => {
      const item = document.createElement("li");
      const label = document.createElement("code");
      label.textContent = name;
      item.append(label, actionButton("Remove", () => removeThemeFile(name)));
      return item;
    }),
  );
}

/** Upload the chosen files into the theme being edited. */
async function uploadThemeFiles(fileList) {
  const id = state.editingTheme.id;
  for (const file of fileList) {
    try {
      const data = await readAsBase64(file);
      const { files } = await api("POST", `/api/themes/${encodeURIComponent(id)}/files`, { name: file.name, data });
      renderThemeFiles(files);
    } catch (error) {
      showFormError($("theme-editor-form"), `${file.name}: ${error.message}`);
    }
  }
  state.themeVersion++;
  applyThemes();
}

async function removeThemeFile(name) {
  if (!confirm(`Remove ${name} from this theme?`)) return;
  try {
    const { files } = await api(
      "DELETE",
      `/api/themes/${encodeURIComponent(state.editingTheme.id)}/files/${encodeURIComponent(name)}`,
      {},
    );
    renderThemeFiles(files);
  } catch (error) {
    showFormError($("theme-editor-form"), error.message);
  }
}

/** A file's contents as base64 text (the "data:...;base64," prefix removed). */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- dialogs

/** App-wide settings: fill the form from `state.settings` and open it. */
function openSettings() {
  const s = state.settings;
  const form = els.settingsForm.elements;
  form.name.value = s.name;
  form.userName.value = s.userName;
  form.persona.value = s.persona;
  fillAssignmentSelect(form.chatAssignment, s.chatAssignment);
  form.historyLimit.value = s.historyLimit;
  hideFormError(els.settingsForm);
  els.settingsDialog.showModal();
}

async function saveSettings(event) {
  // Stop the <form method="dialog"> from closing the dialog before we know
  // the save worked.
  event.preventDefault();
  const form = els.settingsForm.elements;
  try {
    const data = await api("PUT", "/api/settings", {
      name: form.name.value,
      userName: form.userName.value,
      persona: form.persona.value,
      chatAssignment: form.chatAssignment.value,
      // Number boxes give text; the server wants numbers.
      historyLimit: Number(form.historyLimit.value),
    });
    state.settings = data.settings;
    els.settingsDialog.close();
    renderAll();
  } catch (error) {
    showFormError(els.settingsForm, error.message);
  }
}

/** Channel settings for the open channel. */
function openChannelSettings() {
  const channel = currentChannel();
  if (!channel) return;
  const form = els.channelForm.elements;
  form.name.value = channel.name;
  form.theme.replaceChildren(new Option("Same as the app theme", ""), ...state.themes.map((t) => new Option(t.name, t.id)));
  form.theme.value = channel.theme ?? "";
  fillAssignmentSelect(
    form.assignment,
    channel.assignment,
    `Same as the app (${assignmentName(state.settings.chatAssignment)})`,
  );
  hideFormError(els.channelForm);
  els.channelDialog.showModal();
}

/**
 * Show the exact prompt stack her next turn in the open channel would send.
 * Uses the *saved* settings, so save first if you want to preview a change.
 */
async function previewPrompt() {
  try {
    const { messages } = await api("GET", channelPath("prompt"));
    els.promptPreview.replaceChildren(
      ...messages.map((m) => {
        const block = document.createElement("div");
        block.className = "prompt-message";
        const role = document.createElement("div");
        role.className = "prompt-role";
        role.textContent = m.role;
        const pre = document.createElement("pre");
        pre.textContent = m.content;
        block.append(role, pre);
        return block;
      }),
    );
    els.promptDialog.showModal();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

// ------------------------------------------------- profiles and roulettes

/*
 * Connection profiles (a model and its settings) and roulettes (a weighted
 * set of profiles), from Aettica. The server keeps them; the app lists,
 * edits and assigns them. An assignment is written "profile:<id>" or
 * "roulette:<id>"; "" means the first profile.
 */

/** Reload profiles and roulettes, and redraw whatever shows them. */
async function refreshProfiles() {
  const { profiles, roulettes } = await api("GET", "/api/profiles");
  state.profiles = profiles;
  state.roulettes = roulettes;
  if ($("models-dialog").open) renderModels();
  // Settings may be open underneath: keep its choices current.
  if (els.settingsDialog.open) {
    const form = els.settingsForm.elements;
    fillAssignmentSelect(form.chatAssignment, form.chatAssignment.value);
  }
}

/**
 * Fill a select with every profile and roulette.
 *
 * @param emptyLabel  If given, a first option with value "" and this label
 *                    (e.g. "Same as the app").
 * @param profilesOnly  Leave roulettes out (for jobs that need one model).
 */
function fillAssignmentSelect(select, value, emptyLabel, profilesOnly = false) {
  const profiles = document.createElement("optgroup");
  profiles.label = "Profiles";
  profiles.append(...state.profiles.map((p) => new Option(p.name, `profile:${p.id}`)));
  const roulettes = document.createElement("optgroup");
  roulettes.label = "Roulettes";
  roulettes.append(...state.roulettes.map((r) => new Option(`🎲 ${r.name}`, `roulette:${r.id}`)));
  select.replaceChildren(
    ...(emptyLabel ? [new Option(emptyLabel, "")] : []),
    profiles,
    ...(state.roulettes.length && !profilesOnly ? [roulettes] : []),
  );
  // "" (no assignment) means the first profile, where there's no "" option.
  select.value = value || (emptyLabel ? "" : `profile:${state.profiles[0]?.id}`);
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}

/** A readable name for an assignment, e.g. "DeepSeek" or "🎲 Variety". */
function assignmentName(value) {
  const [kind, id] = (value || "").split(":");
  if (kind === "roulette") return `🎲 ${state.roulettes.find((r) => r.id === id)?.name ?? "?"}`;
  return (state.profiles.find((p) => p.id === id) ?? state.profiles[0])?.name ?? "?";
}

function openModels() {
  hideFormError($("models-dialog"));
  renderModels();
  $("models-dialog").showModal();
}

/** Which jobs and channels use an assignment, for the badges. */
function usesOf(value, index) {
  const jobs = [];
  if (state.settings.chatAssignment === value || (index === 0 && !state.settings.chatAssignment)) jobs.push("chat");
  const channels = state.channels.filter((c) => c.assignment === value).map((c) => `#${c.name}`);
  return [...jobs, ...channels];
}

/** Draw the lists of profiles and roulettes. */
function renderModels() {
  $("profile-list").replaceChildren(
    ...state.profiles.map((profile, index) =>
      profileRow(
        profile.name,
        [
          profile.model.split("/").at(-1),
          profile.supportsTools ? "tools" : "no tools",
          ...usesOf(`profile:${profile.id}`, index).map((u) => `used by ${u}`),
        ],
        () => openProfile(profile),
      ),
    ),
  );

  const byId = new Map(state.profiles.map((p) => [p.id, p]));
  $("roulette-list").replaceChildren(
    ...state.roulettes.map((roulette) => {
      const total = roulette.entries.reduce((sum, e) => sum + e.weight, 0);
      const shares = roulette.entries.map((e) => `${Math.round((e.weight / total) * 100)}% ${byId.get(e.profileId)?.name ?? "?"}`);
      return profileRow(
        `🎲 ${roulette.name}`,
        [...(shares.length ? shares : ["empty"]), ...usesOf(`roulette:${roulette.id}`, -1).map((u) => `used by ${u}`)],
        () => openRoulette(roulette),
      );
    }),
  );
}

function badge(text) {
  const span = document.createElement("span");
  span.className = "entry-badge";
  span.textContent = text;
  return span;
}

/** One row in the profile or roulette list: a name, badges, and the whole row opens it. */
function profileRow(name, badges, onOpen) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "profile-row";
  const title = document.createElement("span");
  title.className = "profile-row-name";
  title.textContent = name;
  const tags = document.createElement("span");
  tags.className = "entry-badges";
  tags.append(...badges.map(badge));
  button.append(title, tags);
  button.addEventListener("click", onOpen);
  item.append(button);
  return item;
}

/** Open a profile in the editor, or start a new one (`null`). */
function openProfile(profile) {
  state.editingProfile = profile;
  const form = $("profile-form");
  const f = form.elements;
  hideFormError(form);
  $("profile-title").textContent = profile ? profile.name : "New profile";
  const base = profile ?? state.profiles[0] ?? {};
  f.name.value = profile?.name ?? "";
  f.model.value = profile?.model ?? base.model ?? "";
  f.temperature.value = profile?.temperature ?? 0.9;
  f.maxTokens.value = profile?.maxTokens ?? 1024;
  f.topP.value = profile?.topP ?? "";
  f.reasoningEffort.value = profile?.reasoningEffort ?? "";
  f.supportsTools.checked = profile?.supportsTools ?? true;
  f.quirkPrompt.value = profile?.quirkPrompt ?? "";
  f.extraParams.value = profile?.extraParams ?? "";
  form.querySelector(".advanced").open = Boolean(profile?.extraParams);
  $("profile-delete").hidden = !profile;
  renderToolTest(profile);
  $("profile-dialog").showModal();
}

async function saveProfile(event) {
  event.preventDefault();
  const form = $("profile-form");
  const f = form.elements;
  const body = {
    name: f.name.value,
    model: f.model.value,
    // Number boxes give text; the server wants numbers.
    temperature: Number(f.temperature.value),
    maxTokens: Number(f.maxTokens.value),
    topP: f.topP.value === "" ? null : Number(f.topP.value),
    reasoningEffort: f.reasoningEffort.value || null,
    supportsTools: f.supportsTools.checked,
    quirkPrompt: f.quirkPrompt.value,
    extraParams: f.extraParams.value,
  };
  try {
    const profile = state.editingProfile;
    if (profile) await api("PATCH", `/api/profiles/${encodeURIComponent(profile.id)}`, body);
    else await api("POST", "/api/profiles", body);
    $("profile-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError(form, error.message);
  }
}

async function deleteProfile() {
  const profile = state.editingProfile;
  if (!confirm(`Delete the profile "${profile.name}"? Anything using it goes back to the default.`)) return;
  try {
    const { settings, channels } = await api("DELETE", `/api/profiles/${encodeURIComponent(profile.id)}`, {});
    state.settings = settings;
    state.channels = channels;
    $("profile-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError($("profile-form"), error.message);
  }
}

/** Ask the server which models nanoGPT offers and offer them as suggestions. */
async function loadModels() {
  els.loadModels.disabled = true;
  els.loadModels.textContent = "Loading…";
  try {
    const { models } = await api("GET", "/api/models");
    els.modelList.replaceChildren(...models.map((id) => new Option(id, id)));
    els.loadModels.textContent = `${models.length} models`;
    // Focus the model box so the suggestions are one tap away.
    $("profile-form").elements.model.focus();
  } catch (error) {
    showFormError($("profile-form"), error.message);
    els.loadModels.textContent = "Load list";
  } finally {
    els.loadModels.disabled = false;
  }
}

function openRoulette(roulette) {
  state.editingRoulette = roulette;
  const form = $("roulette-form");
  hideFormError(form);
  $("roulette-title").textContent = roulette ? `🎲 ${roulette.name}` : "New roulette";
  form.elements.name.value = roulette?.name ?? "";
  const entries = roulette?.entries ?? state.profiles.slice(0, 2).map((p) => ({ profileId: p.id, weight: 1 }));
  $("roulette-entries").replaceChildren(...entries.map(rouletteEntryRow));
  updateRouletteShares();
  $("roulette-delete").hidden = !roulette;
  $("roulette-dialog").showModal();
}

/** One row of the roulette editor: a profile, its weight, its share, and a remove button. */
function rouletteEntryRow(entry) {
  const row = document.createElement("div");
  row.className = "roulette-entry";
  const select = document.createElement("select");
  select.className = "roulette-profile";
  select.setAttribute("aria-label", "Profile");
  select.append(...state.profiles.map((p) => new Option(p.name, p.id)));
  select.value = entry.profileId;
  const weight = document.createElement("input");
  weight.className = "roulette-weight";
  weight.type = "number";
  weight.min = "0.01";
  weight.step = "any";
  weight.value = entry.weight;
  weight.setAttribute("aria-label", "Weight");
  const share = document.createElement("span");
  share.className = "roulette-share";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-button";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", "Remove");
  remove.addEventListener("click", () => {
    row.remove();
    updateRouletteShares();
  });
  row.append(select, weight, share, remove);
  return row;
}

/** Show each row's chance, e.g. "40%". */
function updateRouletteShares() {
  const rows = [...$("roulette-entries").querySelectorAll(".roulette-entry")];
  const weights = rows.map((row) => Math.max(0, Number(row.querySelector(".roulette-weight").value) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  rows.forEach((row, i) => {
    row.querySelector(".roulette-share").textContent = total ? `${Math.round((weights[i] / total) * 100)}%` : "";
  });
}

async function saveRoulette(event) {
  event.preventDefault();
  const form = $("roulette-form");
  const entries = [...$("roulette-entries").querySelectorAll(".roulette-entry")].map((row) => ({
    profileId: row.querySelector(".roulette-profile").value,
    weight: Number(row.querySelector(".roulette-weight").value),
  }));
  try {
    const roulette = state.editingRoulette;
    const body = { name: form.elements.name.value, entries };
    if (roulette) await api("PATCH", `/api/roulettes/${encodeURIComponent(roulette.id)}`, body);
    else await api("POST", "/api/roulettes", body);
    $("roulette-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError(form, error.message);
  }
}

async function deleteRoulette() {
  const roulette = state.editingRoulette;
  if (!confirm(`Delete the roulette "${roulette.name}"? Anything using it goes back to the default.`)) return;
  try {
    const { settings, channels } = await api("DELETE", `/api/roulettes/${encodeURIComponent(roulette.id)}`, {});
    state.settings = settings;
    state.channels = channels;
    $("roulette-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError($("roulette-form"), error.message);
  }
}

/** "Regenerate with...": choose a profile, or let the channel's pick again. */
function openRegenerateWith() {
  const channel = currentChannel();
  const select = $("regenerate-profile");
  select.replaceChildren(
    new Option(`Pick again (${assignmentName(channel.assignment ?? state.settings.chatAssignment)})`, ""),
    ...state.profiles.map((p) => new Option(p.name, p.id)),
  );
  $("regenerate-dialog").showModal();
}

// ------------------------------------------------------------- tool test

/** Under "Test tools" in the profile editor: the last result, or a hint. */
function renderToolTest(profile, result) {
  const box = $("profile-test-result");
  $("profile-test").disabled = !profile;
  box.dataset.verdict = result?.verdict ?? "";
  if (!profile) {
    box.textContent = "Save the profile first, then test it.";
  } else if (!result) {
    box.textContent = "Checks whether this model can call tools, with one small request.";
  } else {
    const labels = { native: "✓ Works", text: "~ Works, as text", none: "✗ No tool call", broken: "✗ Broken arguments" };
    box.textContent = `${labels[result.verdict]} (${result.seconds}s). ${result.detail}`;
  }
}

async function testProfileTools() {
  const profile = state.editingProfile;
  const button = $("profile-test");
  button.disabled = true;
  button.textContent = "Testing…";
  try {
    const { test } = await api("POST", `/api/profiles/${encodeURIComponent(profile.id)}/test`, {});
    renderToolTest(profile, test);
  } catch (error) {
    showFormError($("profile-form"), error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Test tools";
  }
}

// ---------------------------------------------------------------- sidebar

/** On phones, the sidebar slides over the channel. These open and close it. */
function openSidebar() {
  els.app.classList.add("sidebar-open");
}

function closeSidebar() {
  els.app.classList.remove("sidebar-open");
}

// ---------------------------------------------------------------- composer

/** Grow the text box to fit what you've typed (CSS caps the height). */
function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${els.input.scrollHeight + 2}px`;
}

// ------------------------------------------------------------ wiring it up

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

// Enter sends, like texting. Shift+Enter makes a new line.
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});
els.input.addEventListener("input", autoGrow);

els.turn.addEventListener("click", herTurn);
$("stop-button").addEventListener("click", stopTurn);
$("appearance-button").addEventListener("click", openAppearance);
$("theme-copy").addEventListener("click", copyTheme);
$("theme-edit").addEventListener("click", () => openThemeEditor(state.settings.appTheme));
$("theme-delete").addEventListener("click", deleteTheme);
$("appearance-dialog").addEventListener("change", (event) => {
  if (event.target.name === "effects") chooseEffects(event.target.value);
});
$("theme-editor-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveTheme(true);
});
$("theme-apply").addEventListener("click", () => saveTheme(false));
$("theme-upload").addEventListener("change", (event) => {
  uploadThemeFiles([...event.target.files]);
  event.target.value = ""; // so choosing the same file again still counts
});
$("notice-dismiss").addEventListener("click", () => ($("notice").hidden = true));
els.messages.addEventListener("scroll", watchForStutter, { passive: true });
$("update-reload").addEventListener("click", () => location.reload());

// Coming back to the app (switching to it, unlocking the phone) is when an
// update is most likely to have happened while it sat in the background.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkServerVersion();
});
els.errorRetry.addEventListener("click", () => state.retry && state.retry());
$("error-dismiss").addEventListener("click", hideError);

// Clicking a channel link changes the address; this opens that channel.
window.addEventListener("hashchange", () => {
  const id = channelFromAddress();
  if (id && id !== state.channelId) openChannel(id);
  closeSidebar();
});
// Tapping the channel you're already in should still close the phone sidebar.
els.channelList.addEventListener("click", closeSidebar);
// The channel indicator follows the links' size when the sidebar changes width.
new ResizeObserver(() => moveChannelIndicator()).observe(els.channelList);

$("menu-button").addEventListener("click", openSidebar);
$("sidebar-scrim").addEventListener("click", closeSidebar);

$("settings-button").addEventListener("click", openSettings);
els.settingsForm.addEventListener("submit", saveSettings);
els.loadModels.addEventListener("click", loadModels);

$("channel-settings-button").addEventListener("click", openChannelSettings);
els.channelForm.addEventListener("submit", saveChannel);
$("preview-prompt").addEventListener("click", previewPrompt);
$("clear-channel").addEventListener("click", clearChannel);

$("open-models").addEventListener("click", openModels);
$("new-profile").addEventListener("click", () => openProfile(null));
$("new-roulette").addEventListener("click", () => openRoulette(null));
$("profile-form").addEventListener("submit", saveProfile);
$("profile-delete").addEventListener("click", deleteProfile);
$("profile-test").addEventListener("click", testProfileTools);
$("roulette-form").addEventListener("submit", saveRoulette);
$("roulette-delete").addEventListener("click", deleteRoulette);
$("roulette-add").addEventListener("click", () => {
  const used = new Set([...$("roulette-entries").querySelectorAll(".roulette-profile")].map((s) => s.value));
  const next = state.profiles.find((p) => !used.has(p.id)) ?? state.profiles[0];
  $("roulette-entries").append(rouletteEntryRow({ profileId: next.id, weight: 1 }));
  updateRouletteShares();
});
$("roulette-entries").addEventListener("input", updateRouletteShares);
$("regenerate-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $("regenerate-dialog").close();
  regenerate($("regenerate-profile").value || undefined);
});

// Every "Cancel" / "Close" button closes the dialog it's in.
for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}

// Register the service worker, which is what makes the app installable.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((error) => {
    console.warn("Service worker registration failed:", error);
  });
}

// Start: apply the last app theme straight away, so the page doesn't flash
// the default look while the server answers (applyThemes corrects it after),
// then load the server's state and open the channel in the address bar (or
// the first channel).
if (readLocal(LAST_THEME_KEY)) setStylesheet("theme-app", `/themes/${readLocal(LAST_THEME_KEY)}/theme.css?v=0`);

Promise.all([loadState(), loadThemes()])
  .then(() => {
    // A turn may already be running (from another tab, or from before a
    // reload): keep an eye on it.
    if (state.busy.size > 0) startBusyWatch();
    return openChannel(channelFromAddress() ?? state.channels[0]?.id ?? null);
  })
  .catch((error) => showError(`Couldn't load Kitsikai: ${error.message}`, () => location.reload()));
