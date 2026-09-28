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
  /**
   * App-wide settings: name, userName, persona, chatAssignment, historyLimit,
   * appTheme, themeOptions, homeChannelId, replyDebounceSeconds,
   * typingBaseMs, typingPerCharMs, her memory (stage 7) and texting first
   * (stage 8). See `Settings` in src/types.ts.
   */
  settings: null,
  /** Every channel, in sidebar order: {id, name, kind, topic, theme, assignment, position}. */
  channels: [],
  /** Channels where she's written something you haven't seen yet. */
  unread: new Set(),
  /** For the plan editor: each plan kind's default reminders, and reminder labels (stage 3). */
  planner: null,
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
  /** The open channel's tool calls (her lookups), oldest first (stage 6). */
  toolCalls: [],
  /** Planner changes she offered or made in the open channel (src/planchanges.ts). */
  planChanges: [],
  /** Turn ids whose action details are expanded under their messages. */
  openActivity: new Set(),
  /** The full tool log of the open channel, while the tool log is open. */
  toolLog: [],
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
  /** Whether the server can post phone notifications (Termux:API, stage 8). */
  notificationsAvailable: false,
  /** The safeword hold, {since, messageId}, while it's on (src/intimacy.ts); else null. */
  intimacyHold: null,
  /** Images picked in the composer, waiting to be sent: {image (base64), mimeType, width, height, url (a preview)}. */
  attachments: [],
  /**
   * The newest version of messages changed in place (a `message` event), by
   * id: an image can be read before its upload's answer arrives, and this
   * keeps the answer from showing it as still being read.
   */
  changed: new Map(),
};

// Shortcut for looking up elements by id.
const $ = (id) => document.getElementById(id);

/**
 * Screens for channels that aren't chats, by channel kind: the 📅 planner
 * (planner.js, stage 3) and the trackers (trackers.js, stage 5). Each has
 * `open()` (the channel was opened), `render()` (redraw) and `reload()`
 * (fetch again, when something changed).
 */
const screens = {};

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

/**
 * Plans, reminders and "today" all use the server's local time. On a phone,
 * the Linux environment Bun runs in can be set to a different time zone
 * than the phone itself (often UTC), which would put every plan hours off.
 * So the app compares, once, and says how to fix it.
 */
let timeZoneChecked = false;
function checkTimeZone(server) {
  if (timeZoneChecked || !server) return;
  timeZoneChecked = true;
  if (server.offsetMinutes === new Date().getTimezoneOffset()) return;
  const phone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  showNotice(
    `Kitsikai's server is set to a different time zone (${server.zone}) than this phone (${phone}), so times would be off. ` +
      `Add the line TZ=${phone} to the .env file and restart the server.`,
  );
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
  state.notificationsAvailable = data.notificationsAvailable;
  state.intimacyHold = data.intimacyHold ?? null;
  checkTimeZone(data.clock);
  state.planner = data.planner;
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

  const unsentText =
    els.input.value.trim() !== "" || [...state.drafts.values()].some((d) => d.trim() !== "") || state.attachments.length > 0;
  const busy = state.busy.size > 0 || state.editingId !== null || document.querySelector("dialog[open]");
  if (!unsentText && !busy) {
    location.reload();
  } else {
    $("update-banner").hidden = false;
  }
}

// ------------------------------------------------------------- channels

/**
 * Open a channel: load its messages and redraw everything.
 * Also used to refresh the open channel after changes.
 */
async function openChannel(channelId) {
  // Keep whatever you'd typed in the channel you're leaving. Images you'd
  // picked but not sent aren't kept.
  if (state.channelId) state.drafts.set(state.channelId, els.input.value);
  clearAttachments();

  state.channelId = channelId;
  state.editingId = null;
  state.messages = [];
  state.changed.clear();
  state.toolCalls = [];
  state.planChanges = [];
  state.unread.delete(channelId);
  resetReveal();
  hideError();

  // Put the channel in the address bar without adding a history entry for
  // every switch. (Only if it isn't there already, to avoid a loop with the
  // hashchange handler.)
  const hash = channelId ? `#/channel/${channelId}` : "";
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);

  const screen = screens[state.channels.find((c) => c.id === channelId)?.kind];
  if (screen) {
    // A planner (or later, trackers) channel shows its screen instead of a chat.
    renderAll();
    screen.open();
    return;
  }

  if (channelId) {
    try {
      const { messages, toolCalls, planChanges } = await api("GET", channelPath("messages", channelId));
      // Ignore the answer if you switched again while it was loading.
      if (state.channelId !== channelId) return;
      state.messages = messages;
      state.toolCalls = toolCalls;
      state.planChanges = planChanges ?? [];
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

async function createChannel(event) {
  event.preventDefault();
  const form = $("new-channel-form").elements;
  const body = { name: form.name.value, topic: form.topic.value, kind: form.kind?.value || "text" };
  try {
    const { channel, channels } = await api("POST", "/api/channels", body);
    state.channels = channels;
    $("new-channel-dialog").close();
    closeSidebar();
    openChannel(channel.id);
  } catch (error) {
    showFormError($("new-channel-form"), error.message);
  }
}

async function saveChannel(event) {
  event.preventDefault();
  const channel = currentChannel();
  const form = els.channelForm.elements;
  const body = {
    name: form.name.value,
    topic: form.topic.value,
    theme: form.theme.value || null,
    assignment: form.assignment.value || null,
  };
  try {
    const { channel: updated } = await api("PATCH", `/api/channels/${encodeURIComponent(channel.id)}`, body);
    updateChannelInState(updated);
    // The home channel is an app-wide setting.
    const isHome = homeChannelId() === channel.id;
    if (form.home.checked !== isHome && channel.kind === "text") {
      const { settings } = await api("PUT", "/api/settings", { homeChannelId: form.home.checked ? channel.id : "" });
      state.settings = settings;
    }
    els.channelDialog.close();
    renderAll();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

/** Move the open channel one place up (-1) or down (+1) in the sidebar. */
async function moveChannel(step) {
  const ids = state.channels.map((c) => c.id);
  const from = ids.indexOf(state.channelId);
  const to = from + step;
  if (to < 0 || to >= ids.length) return;
  // Swap the two neighbours.
  [ids[from], ids[to]] = [ids[to], ids[from]];
  try {
    const { channels } = await api("PUT", "/api/channels/order", { ids });
    state.channels = channels;
    renderAll();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

async function deleteChannel() {
  const channel = currentChannel();
  if (!confirm(`Delete #${channel.name} and every message in it? This can't be undone.`)) return;
  try {
    const { channels, settings } = await api("DELETE", `/api/channels/${encodeURIComponent(channel.id)}`, {});
    state.channels = channels;
    state.settings = settings;
    state.drafts.delete(channel.id);
    els.channelDialog.close();
    openChannel(state.channels[0]?.id ?? null);
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

/**
 * The home channel's id: the one chosen in settings, or the first text
 * channel. (The server works this out the same way.)
 */
function homeChannelId() {
  const text = state.channels.filter((c) => c.kind === "text");
  return (text.find((c) => c.id === state.settings.homeChannelId) ?? text[0])?.id ?? null;
}

/** Whether the open channel shows a screen (the planner...) instead of a chat. */
function onScreen() {
  return Boolean(screens[currentChannel()?.kind]);
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

/*
 * How her replies reach the page (stage 2).
 *
 * When you send a bubble, the server saves it and answers straight away. She
 * replies a few seconds after your *last* bubble (see src/replies.ts), and
 * that reply arrives through the events stream (see "Live events" below),
 * not as the answer to a request. So there's one way in for new messages,
 * `receiveMessages`, whether they come from the stream or from a request
 * like Regenerate. Messages already on screen are skipped, so hearing about
 * one twice is harmless.
 *
 * Her new bubbles don't all appear at once. They go into `reveal.queue`
 * and appear one at a time, with the typing indicator in between, each
 * taking `typingBaseMs + characters × typingPerCharMs`. Double-tapping the
 * typing indicator shows the rest straight away. History (opening a
 * channel, reloading) always appears instantly.
 */

/** Her bubbles waiting to appear in the open channel, and the timer for the next. */
const reveal = { queue: [], timer: null };

/** Your bubbles on their way to the server, shown faded until it confirms them. */
let placeholderCount = 0;

/**
 * Take in messages the server says are new: from the events stream, or the
 * answer to a request.
 *
 * @param replacedIds  Messages these replace (a regeneration).
 */
function receiveMessages(channelId, messages, replacedIds = [], toolCalls = []) {
  if (channelId !== state.channelId) {
    // Another channel: just mark it unread if she wrote something there.
    if (messages.some((m) => m.author === "kitsikai")) {
      state.unread.add(channelId);
      renderSidebar();
    }
    return;
  }
  if (replacedIds.length) {
    const replaced = new Set(replacedIds);
    state.messages = state.messages.filter((m) => !replaced.has(m.id));
    reveal.queue = reveal.queue.filter((m) => !replaced.has(m.id));
  }
  // Her actions this turn (stage 6), shown under its last bubble.
  for (const call of toolCalls) if (!state.toolCalls.some((c) => c.id === call.id)) state.toolCalls.push(call);
  const known = (id) => state.messages.some((m) => m.id === id) || reveal.queue.some((m) => m.id === id);
  for (const original of messages) {
    if (known(original.id)) continue;
    const message = state.changed.get(original.id) ?? original;
    if (message.author === "user") {
      // Your bubble: it replaces its faded placeholder, if there's one.
      const placeholder = state.messages.find((m) => m.pending && m.content === message.content);
      if (placeholder) state.messages[state.messages.indexOf(placeholder)] = message;
      else state.messages.push(message);
    } else {
      reveal.queue.push(message);
    }
  }
  renderAll();
  scrollToBottom();
  pumpReveal();
}

/** How long one of her bubbles takes to "type", in milliseconds. */
function typingDelay(message) {
  const { typingBaseMs, typingPerCharMs } = state.settings;
  return typingBaseMs + message.content.length * typingPerCharMs;
}

/**
 * Show her next waiting bubble when it's time. The first bubble of a reply
 * appears as soon as it arrives (writing it took time already); each one
 * after it waits its typing delay, with the typing indicator showing.
 */
function pumpReveal() {
  if (reveal.timer || reveal.queue.length === 0) return;
  const next = reveal.queue[0];
  const previous = state.messages.at(-1);
  const continuesReply = previous && previous.author === "kitsikai" && previous.turnId === next.turnId;
  if (!continuesReply) {
    showNextBubble();
    pumpReveal();
    return;
  }
  reveal.timer = setTimeout(() => {
    reveal.timer = null;
    showNextBubble();
    pumpReveal();
  }, typingDelay(next));
  renderComposer();
}

function showNextBubble() {
  state.messages.push(reveal.queue.shift());
  renderMessages();
  renderComposer();
  scrollToBottom();
}

/** Double-tapping the typing indicator: show everything she's already written. */
function skipReveal() {
  clearTimeout(reveal.timer);
  reveal.timer = null;
  state.messages.push(...reveal.queue);
  reveal.queue = [];
  renderMessages();
  renderComposer();
  scrollToBottom();
}

/** Forget waiting bubbles (switching channels: they'll load as history). */
function resetReveal() {
  clearTimeout(reveal.timer);
  reveal.timer = null;
  reveal.queue = [];
}

/** Reload the open channel's messages, e.g. after reconnecting. */
async function refreshMessages() {
  const channelId = state.channelId;
  if (!channelId) return;
  try {
    const { messages, toolCalls, planChanges } = await api("GET", channelPath("messages", channelId));
    if (state.channelId !== channelId) return;
    // Keep bubbles that are still on their way to the server.
    const pending = state.messages.filter((m) => m.pending);
    resetReveal();
    state.messages = [...messages, ...pending];
    state.toolCalls = toolCalls;
    state.planChanges = planChanges ?? [];
  } catch (error) {
    showError(`Couldn't reload this channel: ${error.message}`, () => refreshMessages());
  }
  renderAll();
  scrollToBottom();
}

/**
 * The Stop button: stop her reply in the open channel (or her wait before
 * replying). Nothing she was writing is saved.
 */
async function stopTurn() {
  const channelId = state.channelId;
  hideError();
  try {
    await api("POST", channelPath("cancel", channelId), {});
  } catch (error) {
    showError(`Couldn't reach the server to stop the reply: ${error.message}`, null);
  }
  state.busy.delete(channelId);
  renderAll();
}

/**
 * Send what's in the text box as one bubble. Each send is its own bubble,
 * like texting; she replies a few seconds after your last one.
 */
async function sendMessage() {
  const channelId = state.channelId;
  const content = els.input.value.trim();
  if (!channelId || (content === "" && state.attachments.length === 0)) return;

  hideError();
  // Images go first, each its own bubble, then your text.
  if (state.attachments.length) {
    const attachments = state.attachments;
    state.attachments = [];
    renderAttachments();
    for (const [i, attachment] of attachments.entries()) {
      if (!(await sendImage(channelId, attachment))) {
        // Not sent: it and the ones after it go back in the composer, for "Try again".
        state.attachments = [...attachments.slice(i), ...state.attachments];
        renderAttachments();
        return;
      }
    }
  }
  if (content === "") return;

  // Show your bubble straight away, faded, until the server has it.
  const placeholder = {
    id: `pending-${++placeholderCount}`,
    pending: true,
    channelId,
    author: "user",
    content,
    turnId: null,
    createdAt: new Date().toISOString(),
  };
  state.messages.push(placeholder);
  els.input.value = "";
  state.drafts.delete(channelId);
  autoGrow();
  renderMessages();
  scrollToBottom();

  try {
    const { userMessages } = await api("POST", channelPath("messages", channelId), { content });
    if (state.channelId !== channelId) return; // you've moved on; it'll load when you return
    const saved = userMessages[0];
    const index = state.messages.indexOf(placeholder);
    if (index >= 0) {
      if (state.messages.some((m) => m.id === saved.id)) state.messages.splice(index, 1);
      else state.messages[index] = saved;
    }
    renderMessages();
  } catch (error) {
    // Nothing was saved (e.g. the server is down), so put your text back in
    // the box; "Try again" simply sends it again.
    state.messages = state.messages.filter((m) => m !== placeholder);
    renderMessages();
    if (state.channelId === channelId && els.input.value === "") {
      els.input.value = content;
      autoGrow();
    }
    showError(error.message, sendMessage);
  }
}

/**
 * While you type, tell the server now and then, so that if she's waiting to
 * reply she waits a little longer (see `typing` in src/replies.ts).
 */
let lastTypingPing = 0;
function typingPing() {
  if (!state.channelId || els.input.value.trim() === "" || Date.now() - lastTypingPing < 1500) return;
  lastTypingPing = Date.now();
  api("POST", channelPath("typing"), {}).catch(() => {});
}

/** Let her text without a new message from you. */
async function herTurn() {
  await runTurn("turn", herTurn);
}

/**
 * Replace her last reply (every bubble of it) with a fresh one.
 *
 * @param profileId  Write with this profile. Without one, the channel's
 *                   profile or roulette picks again.
 */
async function regenerate(profileId) {
  await runTurn("regenerate", () => regenerate(profileId), profileId ? { profileId } : {});
}

/**
 * Shared wrapper for her turns in the open channel. The server announces
 * that she's writing and what she wrote through the events stream too; the
 * answer here covers the case where the stream is reconnecting.
 *
 * @param action  "turn" or "regenerate" (the end of the API path).
 * @param retry   What "Try again" should do if it fails.
 * @param body    Sent with the request (e.g. the profile to regenerate with).
 */
async function runTurn(action, retry, body = {}) {
  const channelId = state.channelId;
  if (!channelId || state.busy.has(channelId)) return;
  hideError();
  state.busy.add(channelId);
  renderAll();
  try {
    const data = await api("POST", channelPath(action, channelId), body);
    state.busy.delete(channelId);
    if (data.kitsikaiMessages) receiveMessages(channelId, data.kitsikaiMessages, data.replacedIds ?? [], data.toolCalls ?? []);
    if (data.skipped && state.channelId === channelId) showNotice(`${herName()} chose not to reply this time.`);
  } catch (error) {
    state.busy.delete(channelId);
    if (state.channelId === channelId) showError(error.message, retry);
  }
  renderAll();
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

// ------------------------------------------------------------ live events

/*
 * The events stream (see src/events.ts): one request that stays open, down
 * which the server sends a line whenever something happens. The browser's
 * EventSource reconnects by itself if the connection drops (the phone
 * locks, the server restarts). Events can be missed while it's
 * disconnected, so every reconnect reloads what's on screen.
 */

let eventSource = null;
let connectedBefore = false;

function connectEvents() {
  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("open", () => {
    if (connectedBefore) catchUp();
    connectedBefore = true;
    reportPresence();
  });
  eventSource.addEventListener("message", (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    handleEvent(data);
  });
}

/** One event from the server. */
function handleEvent(event) {
  switch (event.type) {
    case "messages":
      receiveMessages(event.channelId, event.messages, event.replacedIds ?? [], event.toolCalls ?? []);
      break;
    case "deleted":
      if (event.channelId === state.channelId) {
        const gone = new Set(event.ids);
        state.messages = state.messages.filter((m) => !gone.has(m.id));
        reveal.queue = reveal.queue.filter((m) => !gone.has(m.id));
        renderMessages();
      }
      break;
    case "busy":
      state.busy = new Set(event.channelIds);
      renderSidebar();
      renderComposer();
      if (state.busy.has(state.channelId)) scrollToBottom();
      break;
    case "turn-error":
      if (event.channelId === state.channelId) showError(event.error, herTurn);
      break;
    case "channels":
      state.channels = event.channels;
      if (!currentChannel()) openChannel(state.channels[0]?.id ?? null);
      else renderAll();
      break;
    case "plans":
      if (currentChannel()?.kind === "planner") screens.planner.reload();
      break;
    case "log":
      if (currentChannel()?.kind === "trackers") screens.trackers.reload();
      if (currentChannel()?.kind === "planner") screens.planner.reload();
      break;
    case "memory":
      // The advanced page, if it's open (public/memory.js).
      if ($("notes-dialog").open) loadNotes();
      break;
    case "hold":
      state.intimacyHold = event.hold;
      renderHold();
      break;
    case "plan-change":
      // A planner change she offered, made or dropped.
      if (event.change.channelId === state.channelId) {
        const known = state.planChanges.some((c) => c.id === event.change.id);
        state.planChanges = known ? state.planChanges.map((c) => (c.id === event.change.id ? event.change : c)) : [...state.planChanges, event.change];
        renderMessages();
      }
      break;
    case "message":
      // One message changed: edited, or an image was read.
      if (event.message.channelId === state.channelId) state.changed.set(event.message.id, event.message);
      if (state.messages.some((m) => m.id === event.message.id)) {
        state.messages = state.messages.map((m) => (m.id === event.message.id ? event.message : m));
        // Don't pull the rug out from under an edit in progress.
        if (state.editingId !== event.message.id) renderMessages();
      }
      break;
  }
}

/** After a reconnect, or coming back to the app: reload what's on screen. */
async function catchUp() {
  try {
    await loadState();
  } catch {
    return; // server not reachable yet; the next reconnect tries again
  }
  if (!currentChannel()) {
    await openChannel(state.channels[0]?.id ?? null);
    return;
  }
  if (onScreen()) screens[currentChannel().kind].reload();
  else await refreshMessages();
}

// -------------------------------------------------------------- rendering

/** Redraw everything from `state`. */
function renderAll() {
  applyThemes();
  renderSidebar();
  renderChannelHeader();
  // A planner channel shows its screen; a text channel, its messages and composer.
  const screen = screens[currentChannel()?.kind];
  for (const kind of ["planner", "trackers"]) $(kind).hidden = currentChannel()?.kind !== kind;
  els.messages.hidden = Boolean(screen);
  if (screen) {
    els.composer.hidden = true;
    screen.render();
    return;
  }
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
      if (channel.id === homeChannelId()) link.dataset.home = "true";
      link.title = [channel.id === homeChannelId() ? "Home channel" : "", channel.topic].filter(Boolean).join(": ");

      const name = document.createElement("span");
      name.className = "channel-link-name";
      name.textContent = channel.name;
      link.append(channelIcon(channel.kind), name);

      if (state.busy.has(channel.id)) {
        const dot = document.createElement("span");
        dot.className = "channel-busy";
        dot.title = `${herName()} is typing here`;
        link.append(dot);
      } else if (state.unread.has(channel.id)) {
        link.classList.add("unread");
        const dot = document.createElement("span");
        dot.className = "channel-unread";
        dot.title = "New messages";
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

/** The icon for each kind of channel. */
const CHANNEL_ICONS = { text: "#icon-hash", planner: "#icon-calendar", trackers: "#icon-trackers" };

/** The icon for a kind of channel. */
function channelIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "channel-icon");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", CHANNEL_ICONS[kind] ?? "#icon-hash");
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
  els.channelTitleIcon.setAttribute("href", CHANNEL_ICONS[channel?.kind] ?? "#icon-hash");
  els.channelTopic.textContent = channel?.topic ?? "";
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

  if (state.messages.length === 0 && state.toolCalls.length === 0) {
    els.messages.append(emptyNote(`Nothing here yet. Say hi, or press “Her turn” to let ${herName()} start.`));
    return;
  }

  // Her last turn can be regenerated; the button goes on its last bubble.
  const last = state.messages.at(-1);
  const canRegenerate = last?.author === "kitsikai";

  // Tool calls grouped by turn (stage 6). Turns that wrote messages show
  // their actions under them; turns that only acted are shown on their own,
  // in time order.
  const turns = toolCallsByTurn();
  const withMessages = new Set(state.messages.map((m) => m.turnId).filter(Boolean));
  const waiting = new Set(reveal.queue.map((m) => m.turnId));
  const loose = [...turns].filter(([turnId]) => !withMessages.has(turnId) && !waiting.has(turnId));

  let previous = null;
  state.messages.forEach((message, index) => {
    while (loose.length && loose[0][1][0].createdAt <= message.createdAt) {
      const [turnId, calls] = loose.shift();
      els.messages.append(renderActivity(turnId, calls), ...renderPlanChanges(turnId));
      previous = null;
    }
    els.messages.append(
      renderMessage(message, {
        continued: continuesGroup(previous, message),
        regenerate: canRegenerate && message === last,
      }),
    );
    previous = message;
    // After a turn's last bubble (once they've all appeared), what it looked up.
    const next = state.messages[index + 1];
    if (message.turnId && turns.has(message.turnId) && next?.turnId !== message.turnId && !waiting.has(message.turnId)) {
      els.messages.append(renderActivity(message.turnId, turns.get(message.turnId)), ...renderPlanChanges(message.turnId));
      previous = null;
    }
  });
  for (const [turnId, calls] of loose) els.messages.append(renderActivity(turnId, calls), ...renderPlanChanges(turnId));
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
  const pending = Boolean(message.pending);

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
    if (message.image) root.append(renderImage(message, { caption: false }));
    root.append(renderEditor(message));
    return root;
  }

  if (message.image) {
    root.append(renderImage(message));
  } else {
    const content = document.createElement("div");
    content.className = "message-content";
    content.innerHTML = formatText(message.content);
    root.append(content);
  }

  // A message that's still being sent has no actions yet.
  if (pending) return root;

  const busy = state.busy.has(state.channelId);
  const actions = document.createElement("div");
  actions.className = "message-actions";
  if (showRegenerate) actions.classList.add("always");
  actions.append(
    actionButton(message.image ? "Edit what she sees" : "Edit", () => {
      state.editingId = message.id;
      renderMessages();
    }),
  );
  if (message.image) actions.append(actionButton("Read again", () => readImageAgain(message.id), message.image.status === "reading"));
  actions.append(actionButton("Delete", () => deleteMessage(message.id), busy));
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
  if (message.image) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = `What ${herName()} sees in the image: every model gets this instead of the picture. Fix anything the vision model got wrong.`;
    wrapper.append(hint);
  }
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

  // The typing indicator shows while she's writing (busy), and while her
  // bubbles are still appearing one by one (double-tap it to skip ahead).
  const busy = state.busy.has(channel.id);
  const revealing = reveal.timer !== null;
  els.status.hidden = !busy && !revealing;
  els.status.classList.toggle("revealing", revealing);
  $("status-text").textContent = `${herName()} is typing…`;
  $("status").title = revealing ? "Double-tap to skip ahead" : "";
  $("stop-button").hidden = !busy;
  els.turn.disabled = busy;
  els.input.placeholder = `Message #${channel.name}`;
  renderHold();
}

/**
 * The safeword hold (src/intimacy.ts): a banner above the composer while
 * it's on, so you know she heard it (and can undo a false alarm), and its
 * status in Settings.
 */
function renderHold() {
  const hold = state.intimacyHold;
  $("hold-banner").hidden = !hold;
  $("hold-status").hidden = !hold;
  if (hold) $("hold-status-text").textContent = `Holding since ${formatTime(hold.since)}, after the safeword.`;
}

/** "Bring her back": end the hold by hand. */
async function liftHold() {
  try {
    const data = await api("POST", "/api/intimacy/lift", {});
    state.intimacyHold = data.intimacyHold;
    renderHold();
  } catch (error) {
    showError(`Couldn't bring her back: ${error.message}`, liftHold);
  }
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

// ------------------------------------------------------------------ images

/** The longest side an image is sent at, in pixels, and the size it's sent as-is under. */
const IMAGE_MAX_SIDE = 2048;
const IMAGE_KEEP_BYTES = 2_000_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * Get a picked image ready to send: a big phone photo is shrunk (and sent as
 * a JPEG), a small PNG, JPEG, WebP or GIF goes as it is.
 */
async function prepareImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name || "That file"} isn't an image this browser can open.`);
  }
  let { width, height } = bitmap;
  if (IMAGE_TYPES.includes(file.type) && file.size <= IMAGE_KEEP_BYTES && Math.max(width, height) <= IMAGE_MAX_SIDE) {
    bitmap.close();
    return { image: await readAsBase64(file), mimeType: file.type, width, height, url: URL.createObjectURL(file) };
  }
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  // JPEG has no transparency: see-through parts become white, not black.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("Couldn't shrink the image.");
  return { image: await readAsBase64(blob), mimeType: "image/jpeg", width, height, url: URL.createObjectURL(blob) };
}

/** Images were picked (or pasted): get them ready, and show them above the text box. */
async function addAttachments(files) {
  const channelId = state.channelId;
  for (const file of files) {
    try {
      const attachment = await prepareImage(file);
      if (state.channelId !== channelId) return URL.revokeObjectURL(attachment.url);
      state.attachments.push(attachment);
    } catch (error) {
      showError(error.message, null);
    }
  }
  renderAttachments();
  els.input.focus();
}

function clearAttachments() {
  for (const attachment of state.attachments) URL.revokeObjectURL(attachment.url);
  state.attachments = [];
  renderAttachments();
}

/** The images waiting to be sent, each with a ✕ to take it out. */
function renderAttachments() {
  const strip = $("composer-attachments");
  strip.hidden = state.attachments.length === 0;
  strip.replaceChildren(
    ...state.attachments.map((attachment) => {
      const item = document.createElement("div");
      item.className = "composer-attachment";
      const img = document.createElement("img");
      img.src = attachment.url;
      img.alt = "An image to send";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-attachment-remove";
      remove.setAttribute("aria-label", "Don't send this image");
      remove.textContent = "✕";
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(attachment.url);
        state.attachments = state.attachments.filter((a) => a !== attachment);
        renderAttachments();
      });
      item.append(img, remove);
      return item;
    }),
  );
}

/** Send one image: a faded bubble at once, the real one when the server has it. Returns whether it worked. */
async function sendImage(channelId, attachment) {
  const placeholder = {
    id: `pending-${++placeholderCount}`,
    pending: true,
    channelId,
    author: "user",
    content: "",
    turnId: null,
    createdAt: new Date().toISOString(),
    image: { url: attachment.url, width: attachment.width, height: attachment.height, status: "sending" },
  };
  state.messages.push(placeholder);
  renderMessages();
  scrollToBottom();
  try {
    const { image, mimeType, width, height } = attachment;
    const { userMessages } = await api("POST", channelPath("images", channelId), { image, mimeType, width, height });
    if (state.channelId === channelId) {
      const saved = state.changed.get(userMessages[0].id) ?? userMessages[0];
      const index = state.messages.indexOf(placeholder);
      if (index >= 0) {
        if (state.messages.some((m) => m.id === saved.id)) state.messages.splice(index, 1);
        else state.messages[index] = saved;
      }
      renderMessages();
    }
    URL.revokeObjectURL(attachment.url);
    return true;
  } catch (error) {
    state.messages = state.messages.filter((m) => m !== placeholder);
    renderMessages();
    showError(`Couldn't send the image: ${error.message}`, sendMessage);
    return false;
  }
}

/** An image in a bubble: the picture (tap for a big view), and what she sees in it. */
function renderImage(message, { caption = true } = {}) {
  const figure = document.createElement("figure");
  figure.className = "message-image";
  const img = document.createElement("img");
  img.src = message.pending ? message.image.url : `/api/images/${encodeURIComponent(message.id)}`;
  img.alt = message.content || "An image you sent";
  // Its size, so the chat makes room before it loads (CSS scales it down).
  if (message.image.width && message.image.height) {
    img.width = message.image.width;
    img.height = message.image.height;
  }
  img.addEventListener("click", (event) => {
    event.stopPropagation();
    openImageViewer(img.src, img.alt);
  });
  figure.append(img);
  if (caption && !message.pending) figure.append(renderSeen(message));
  return figure;
}

/**
 * Under an image: what she sees in it (the vision model's description,
 * which is what every model gets instead of the picture), or how reading
 * it is going. Tap to see all of it.
 */
function renderSeen(message) {
  const seen = document.createElement("figcaption");
  seen.className = "image-seen";
  const text = message.content.trim();
  const status = text ? "read" : message.image.status;
  seen.dataset.status = status;
  if (status === "reading") {
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.setAttribute("aria-hidden", "true");
    dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
    seen.append(dots, ` Looking at the image…`);
  } else if (status === "failed") {
    seen.textContent = `⚠️ Couldn't read the image: ${message.image.error ?? "no reason given"}. Tap it for "Read again", or "Edit what she sees" to describe it yourself.`;
  } else {
    const label = document.createElement("strong");
    label.className = "image-seen-label";
    label.textContent = `What ${herName()} sees${message.editedAt ? " (you edited it)" : ""}: `;
    seen.append(label, text);
    seen.title = "Tap to see all of it";
    seen.addEventListener("click", (event) => {
      event.stopPropagation();
      seen.classList.toggle("expanded");
    });
  }
  return seen;
}

function openImageViewer(src, alt) {
  $("image-viewer-img").src = src;
  $("image-viewer-img").alt = alt;
  $("image-viewer").showModal();
}

/** "Read again": the vision model looks at the image again. */
async function readImageAgain(id) {
  try {
    const { message } = await api("POST", `/api/messages/${encodeURIComponent(id)}/read-image`, {});
    state.messages = state.messages.map((m) => (m.id === id ? message : m));
    renderMessages();
  } catch (error) {
    showError(error.message, null);
  }
}

// --------------------------------------------------------- planner changes

/** How each way a planner change can end is shown. */
const PLAN_CHANGE_STATUS = {
  pending: "Waiting for your yes",
  applied: "✓ Done",
  declined: "✕ Not done",
  expired: "Dropped",
  failed: "⚠️ Couldn't be done",
};

/** The planner changes one of her turns offered or made: cards, with Yes and No while they wait. */
function renderPlanChanges(turnId) {
  return state.planChanges.filter((c) => c.turnId === turnId).map(renderPlanChange);
}

function renderPlanChange(change) {
  const card = document.createElement("div");
  card.className = "plan-change";
  card.dataset.status = change.status;
  card.dataset.changeId = change.id;

  const summary = document.createElement("p");
  summary.className = "plan-change-summary";
  summary.textContent = `📅 ${change.summary}`;
  card.append(summary);
  if (change.before) {
    const before = document.createElement("p");
    before.className = "plan-change-before";
    before.textContent = `Now: ${change.before}`;
    card.append(before);
  }

  const status = document.createElement("p");
  status.className = "plan-change-status";
  status.textContent = PLAN_CHANGE_STATUS[change.status] + (change.reason && change.status !== "pending" ? ` (${change.reason})` : "");
  card.append(status);

  if (change.status === "pending") {
    const buttons = document.createElement("div");
    buttons.className = "plan-change-buttons";
    const yes = actionButton("Yes", () => answerPlanChange(change.id, "yes"));
    yes.className = "button button-primary";
    const no = actionButton("No", () => answerPlanChange(change.id, "no"));
    no.className = "button";
    buttons.append(yes, no);
    card.append(buttons);
  }
  return card;
}

/** Yes or No, tapped. */
async function answerPlanChange(id, answer) {
  try {
    const { change } = await api("POST", `/api/plan-changes/${encodeURIComponent(id)}`, { answer });
    state.planChanges = state.planChanges.map((c) => (c.id === id ? change : c));
    renderMessages();
  } catch (error) {
    showError(error.message, null);
  }
}

// ------------------------------------------------------------------ errors

/**
 * Show an error above the composer. `retry` is the function "Try again"
 * should call, or null to hide that button.
 */
function showError(message, retry) {
  // Screens like the planner have no composer, so the error goes at the top.
  if (onScreen()) {
    showNotice(message);
    return;
  }
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
  fillAssignmentSelect(form.screenshotAssignment, s.screenshotAssignment, null, true);
  fillAssignmentSelect(form.imageAssignment, s.imageAssignment, "Same as screenshots", true);
  form.historyLimit.value = s.historyLimit;
  form.replyDebounceSeconds.value = s.replyDebounceSeconds;
  form.typingBaseMs.value = s.typingBaseMs;
  form.typingPerCharMs.value = s.typingPerCharMs;
  // Her memory (stage 7).
  fillAssignmentSelect(form.writerAssignment, s.writerAssignment);
  fillAssignmentSelect(form.decisionFallback, s.decisionFallback, "Nobody: skip that decision", true);
  form.decisionModel.value = s.decisionModel;
  form.decisionConfidence.value = s.decisionConfidence;
  form.processingHours.value = s.processingHours;
  form.pinCap.value = s.pinCap;
  form.showAdvanced.checked = s.showAdvanced;
  // Texting first (stage 8).
  form.textFirst.checked = s.textFirst;
  form.snapshotMinutes.value = s.snapshotMinutes;
  form.doubleTextCap.value = String(s.doubleTextCap);
  form.notifications.checked = s.notifications;
  form.notificationPreview.checked = s.notificationPreview;
  $("notifications-unavailable").hidden = state.notificationsAvailable;
  // Intimacy (src/intimacy.ts).
  form.intimacyEnabled.checked = s.intimacyEnabled;
  renderHold();
  $("jev-test-result").hidden = true;
  updateAdvanced();
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
      screenshotAssignment: form.screenshotAssignment.value,
      imageAssignment: form.imageAssignment.value,
      // Number boxes give text; the server wants numbers.
      historyLimit: Number(form.historyLimit.value),
      replyDebounceSeconds: Number(form.replyDebounceSeconds.value),
      typingBaseMs: Number(form.typingBaseMs.value),
      typingPerCharMs: Number(form.typingPerCharMs.value),
      writerAssignment: form.writerAssignment.value,
      decisionModel: form.decisionModel.value,
      decisionFallback: form.decisionFallback.value,
      decisionConfidence: Number(form.decisionConfidence.value),
      processingHours: Number(form.processingHours.value),
      pinCap: Number(form.pinCap.value),
      showAdvanced: form.showAdvanced.checked,
      textFirst: form.textFirst.checked,
      snapshotMinutes: Number(form.snapshotMinutes.value),
      doubleTextCap: form.doubleTextCap.value === "judge" ? "judge" : Number(form.doubleTextCap.value),
      notifications: form.notifications.checked,
      notificationPreview: form.notificationPreview.checked,
      intimacyEnabled: form.intimacyEnabled.checked,
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
  form.topic.value = channel.topic;
  form.home.checked = homeChannelId() === channel.id;
  // Some settings only make sense where she texts.
  for (const element of els.channelForm.querySelectorAll(".text-only")) element.hidden = channel.kind !== "text";
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

/** The new channel dialog. There can only be one planner. */
function openNewChannel() {
  $("new-channel-form").reset();
  hideFormError($("new-channel-form"));
  for (const radio of $("new-channel-form").querySelectorAll('input[name="kind"]')) {
    const taken = radio.value !== "text" && state.channels.some((c) => c.kind === radio.value);
    radio.disabled = taken;
    radio.closest(".kind-option").classList.toggle("taken", taken);
  }
  updateNewChannelKind();
  $("new-channel-dialog").showModal();
}

/** Suggest a name for a planner or trackers channel. */
function updateNewChannelKind() {
  const form = $("new-channel-form").elements;
  $("new-channel-topic-row").hidden = form.kind.value !== "text";
  if (form.kind.value !== "text" && !form.name.value) form.name.value = form.kind.value;
}

/**
 * Show a message in its channel, scrolled into view and highlighted for a
 * moment: "show the message" on a sticker that came from chat (stage 5).
 */
async function showMessage(messageId) {
  try {
    const { message } = await api("GET", `/api/messages/${encodeURIComponent(messageId)}`);
    for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
    await openChannel(message.channelId);
    const element = els.messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!element) return;
    element.scrollIntoView({ block: "center" });
    element.classList.add("highlighted");
    setTimeout(() => element.classList.remove("highlighted"), 2500);
  } catch (error) {
    showNotice(`Couldn't show that message: ${error.message}`);
  }
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
    fillAssignmentSelect(form.screenshotAssignment, form.screenshotAssignment.value, null, true);
    fillAssignmentSelect(form.writerAssignment, form.writerAssignment.value);
    fillAssignmentSelect(form.decisionFallback, form.decisionFallback.value, "Nobody: skip that decision", true);
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
  if (state.settings.screenshotAssignment === value || (index === 0 && !state.settings.screenshotAssignment)) jobs.push("screenshots");
  if (state.settings.writerAssignment === value || (index === 0 && !state.settings.writerAssignment)) jobs.push("notes");
  if (state.settings.decisionFallback === value) jobs.push("Jev fallback");
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

// ------------------------------------------------------ her actions (stage 6)

/*
 * She looks things up with tools (src/tools.ts). Each turn's tool calls are
 * shown under the bubbles it wrote, as one line ("⚙ Kitsikai looked up plans
 * for Oct 1–7") that opens into the details: every call, its arguments
 * exactly as the model wrote them, and what it was told back. (From Aettica.)
 */

/** The open channel's tool calls, grouped by turn: Map of turnId → calls. */
function toolCallsByTurn() {
  const turns = new Map();
  for (const call of state.toolCalls) {
    if (!turns.has(call.turnId)) turns.set(call.turnId, []);
    turns.get(call.turnId).push(call);
  }
  return turns;
}

/** One turn's actions: a summary line that opens into the details. */
function renderActivity(turnId, calls) {
  const root = document.createElement("div");
  root.className = "activity";
  const errors = calls.filter((c) => c.status === "error").length;
  if (errors) root.classList.add("has-errors");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "activity-summary";
  const open = state.openActivity.has(turnId);
  toggle.setAttribute("aria-expanded", String(open));
  // Only the actions that did something, once each ("read X" twice is noise).
  const done = [...new Set(calls.filter((c) => c.status === "ok").map((c) => c.summary))];
  const text = done.length ? `${herName()} ${done.join(", ")}` : `${herName()} tried to look something up`;
  toggle.textContent = `⚙ ${text}${errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}`;
  toggle.addEventListener("click", () => {
    if (state.openActivity.has(turnId)) state.openActivity.delete(turnId);
    else state.openActivity.add(turnId);
    renderMessages();
  });
  root.append(toggle);

  if (open) {
    const list = document.createElement("ol");
    list.className = "activity-details";
    list.append(...calls.map(renderToolCall));
    root.append(list);
  }
  return root;
}

/** One tool call, in full: for the activity details and the tool log. */
function renderToolCall(call) {
  const item = document.createElement("li");
  item.className = "tool-call";
  item.dataset.status = call.status;
  item.dataset.source = call.source;

  const head = document.createElement("div");
  head.className = "tool-call-head";
  const name = document.createElement("code");
  name.className = "tool-call-name";
  name.textContent = call.name;
  head.append(name, badge(call.status === "ok" ? "ok" : "error"));
  if (call.source === "text") head.append(badge("written as text"));
  head.append(badge(`round ${call.round + 1}`));
  if (call.profile) head.append(badge(call.profile));
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = call.createdAt;
  time.textContent = formatTime(call.createdAt);
  head.append(time);

  const summary = document.createElement("p");
  summary.className = "tool-call-summary";
  summary.textContent = call.summary;

  const details = document.createElement("details");
  details.className = "tool-call-raw";
  const label = document.createElement("summary");
  label.textContent = "Arguments and result";
  const args = document.createElement("pre");
  args.textContent = prettyJson(call.arguments);
  const result = document.createElement("pre");
  result.textContent = prettyJson(call.result);
  details.append(label, args, result);

  item.append(head, summary, details);
  return item;
}

/** JSON text, indented if it parses, as-is if it doesn't (broken arguments stay visible). */
function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text || "(empty)";
  }
}

async function openToolLog() {
  $("tool-log-copy").textContent = "Copy as text";
  try {
    const { toolCalls } = await api("GET", channelPath("tool-log"));
    state.toolLog = toolCalls;
    renderToolLog();
    $("tool-log-dialog").showModal();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

function renderToolLog() {
  const errorsOnly = $("tool-log-errors").checked;
  const calls = [...state.toolLog].reverse().filter((c) => !errorsOnly || c.status === "error");
  const list = $("tool-log-list");
  if (calls.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = errorsOnly ? "No errors." : `${herName()} hasn't used any tools here yet.`;
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...calls.map(renderToolCall));
}

/** Copy the tool log as plain text, e.g. to share when something goes wrong. */
async function copyToolLog() {
  const text = state.toolLog
    .map((c) =>
      [`${c.createdAt}  ${c.profile ?? ""}  round ${c.round + 1}  ${c.source}  ${c.status}`, `${c.name} ${c.arguments}`, `-> ${c.result}`].join("\n"),
    )
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    $("tool-log-copy").textContent = "Copied";
  } catch {
    showFormError($("tool-log-dialog"), "Couldn't copy: your browser didn't allow it.");
  }
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
els.input.addEventListener("input", () => {
  autoGrow();
  typingPing();
});

// Double-tap the typing indicator to skip her typing delays. (A double tap
// is two taps within 350 ms; checked by hand because phones don't always
// send a dblclick.)
let lastStatusTap = 0;
els.status.addEventListener("pointerup", (event) => {
  if (event.target.closest("button")) return;
  const now = Date.now();
  if (now - lastStatusTap < 350) {
    skipReveal();
    lastStatusTap = 0;
  } else {
    lastStatusTap = now;
  }
});

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
$("hold-lift").addEventListener("click", liftHold);
$("attach-button").addEventListener("click", () => $("attach-input").click());
$("attach-input").addEventListener("change", (event) => {
  addAttachments([...event.target.files]);
  event.target.value = ""; // so picking the same image again still counts
});
// Pasting an image into the text box attaches it.
els.input.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (files.length === 0) return;
  event.preventDefault();
  addAttachments(files);
});
$("image-viewer").addEventListener("click", () => $("image-viewer").close());
$("hold-status-lift").addEventListener("click", liftHold);

// Coming back to the app (switching to it, unlocking the phone): catch up on
// anything missed while it sat in the background, and check for an update.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") catchUp();
  reportPresence();
});

/**
 * Tell the server whether the app is on screen (stage 8): it only posts
 * phone notifications while it isn't. Best effort: if this fails, the
 * worst case is a notification you didn't need.
 */
function reportPresence() {
  const visible = document.visibilityState === "visible";
  // Going into the background, the page may be paused straight away:
  // sendBeacon is made for that, and still delivers.
  if (!visible && navigator.sendBeacon) {
    navigator.sendBeacon("/api/presence", new Blob([JSON.stringify({ visible })], { type: "application/json" }));
    return;
  }
  api("POST", "/api/presence", { visible }).catch(() => {});
}
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
$("channel-move-up").addEventListener("click", () => moveChannel(-1));
$("channel-move-down").addEventListener("click", () => moveChannel(1));
$("delete-channel").addEventListener("click", deleteChannel);
$("new-channel-button").addEventListener("click", openNewChannel);
$("new-channel-form").addEventListener("submit", createChannel);
$("new-channel-form").addEventListener("change", updateNewChannelKind);
$("preview-prompt").addEventListener("click", previewPrompt);
$("open-tool-log").addEventListener("click", openToolLog);
$("tool-log-errors").addEventListener("change", renderToolLog);
$("tool-log-copy").addEventListener("click", copyToolLog);
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

// The other scripts (planner.js...) run after this one, so wait for them
// before starting: DOMContentLoaded fires once every deferred script has run.
document.addEventListener("DOMContentLoaded", () => {
  Promise.all([loadState(), loadThemes()])
    .then(() => {
      connectEvents();
      return openChannel(channelFromAddress() ?? state.channels[0]?.id ?? null);
    })
    .catch((error) => showError(`Couldn't load Kitsikai: ${error.message}`, () => location.reload()));
});
