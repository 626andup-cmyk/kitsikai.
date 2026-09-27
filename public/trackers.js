/**
 * The trackers channel's screen (stage 5), and log entries ("stickers") on
 * calendar days.
 *
 * A tracker is "please keep an eye out for this"; a log entry is a sticker
 * on a day. You define the trackers yourself (see src/trackers.ts), and add,
 * edit and delete stickers here or on a day in the planner. From stage 7,
 * she adds stickers too, from what you tell her, and each one links back to
 * the message it came from.
 *
 * Uses `state`, `api`, `$` and friends from app.js, and the date helpers
 * from planner.js.
 */

"use strict";

const log = {
  /** Every tracker, in order. */
  trackers: [],
  /** Recent entries, for the trackers screen (newest first). */
  recent: [],
  /** Entries in the planner's calendar range, for stickers on days. */
  calendar: [],
  /** The tracker or entry open in its dialog (null for a new one). */
  editingTracker: null,
  editingEntry: null,
};

/** How many days the strip on each tracker shows. */
const STRIP_DAYS = 14;

const TRACKER_KIND_NAMES = { yesno: "yes/no", scale: "1–10", note: "note" };
const SOURCE_NAMES = {
  user: "You added this.",
  processing: "She noted this from chat, and it held up at processing.",
  confirmed: "She asked, and you confirmed.",
  kitsikai: "She logged this herself, from chat.",
};

function trackerById(id) {
  return log.trackers.find((t) => t.id === id);
}

// -------------------------------------------------------------- stickers

/** A sticker: a log entry shown on a day. */
function sticker(entry, { withName = true } = {}) {
  const tracker = trackerById(entry.trackerId);
  const element = document.createElement("button");
  element.type = "button";
  element.className = "log-sticker";
  element.dataset.kind = tracker?.kind ?? "";
  element.dataset.source = entry.source;
  element.dataset.value = entry.value;
  element.title = `${tracker?.name ?? "?"}: ${entry.value}`;
  const name = withName ? `${tracker?.name ?? "?"} ` : "";
  element.textContent = `${name}${stickerValue(tracker, entry.value)}`;
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    openEntry(entry);
  });
  return element;
}

/** "✓", "✗", "7/10", or the note. */
function stickerValue(tracker, value) {
  if (tracker?.kind === "yesno") return value === "yes" ? "✓" : "✗";
  if (tracker?.kind === "scale") return `${value}/10`;
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

// --------------------------------------------------------------- loading

async function loadTrackers() {
  log.trackers = (await api("GET", "/api/trackers")).trackers;
}

/** The trackers screen: trackers, and the last two weeks of entries. */
async function loadTrackerScreen() {
  try {
    const from = shiftDate(todayDate(), -(STRIP_DAYS - 1));
    const [, { entries }] = await Promise.all([loadTrackers(), api("GET", `/api/log?from=${from}`)]);
    log.recent = entries;
    renderTrackers();
  } catch (error) {
    showError(`Couldn't load the trackers: ${error.message}`, loadTrackerScreen);
  }
}

/** Stickers for the planner's calendar (called by planner.js). */
async function loadStickers(from, to) {
  const [, { entries }] = await Promise.all([loadTrackers(), api("GET", `/api/log?from=${from}&to=${to}`)]);
  log.calendar = entries;
}

/** The stickers on a day in the calendar range. */
function stickersOn(date) {
  return log.calendar.filter((e) => e.date === date);
}

// ------------------------------------------------------- trackers screen

function renderTrackers() {
  const list = $("tracker-list");
  if (log.trackers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty trackers-empty";
    empty.textContent = "No trackers yet. Add one for anything you'd like her to keep an eye out for: a headache, your meds, payday.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...log.trackers.map(trackerCard));
}

/** One tracker: its settings, a two-week strip of stickers, quick logging, and recent entries. */
function trackerCard(tracker) {
  const card = document.createElement("section");
  card.className = "tracker-card";
  card.dataset.kind = tracker.kind;
  card.dataset.trackerId = tracker.id;

  const head = document.createElement("header");
  head.className = "tracker-card-head";
  const name = document.createElement("h3");
  name.className = "tracker-name";
  name.textContent = tracker.name;
  const badges = document.createElement("span");
  badges.className = "entry-badges";
  badges.append(badge(TRACKER_KIND_NAMES[tracker.kind]));
  if (!tracker.canBringUp) badges.append(badge("logged quietly"));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "link-button tracker-edit";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openTracker(tracker));
  head.append(name, badges, edit);
  card.append(head);

  if (tracker.hintWords.length) {
    const words = document.createElement("p");
    words.className = "tracker-hints";
    words.append(...tracker.hintWords.map((word) => Object.assign(document.createElement("span"), { className: "hint-word", textContent: word })));
    card.append(words);
  }

  // The last two weeks: a cell per day, with that day's stickers.
  const entries = log.recent.filter((e) => e.trackerId === tracker.id);
  const strip = document.createElement("div");
  strip.className = "tracker-strip";
  const today = todayDate();
  for (let i = STRIP_DAYS - 1; i >= 0; i--) {
    const date = shiftDate(today, -i);
    const day = document.createElement("button");
    day.type = "button";
    day.className = "tracker-day";
    day.dataset.date = date;
    if (date === today) day.classList.add("today");
    const label = document.createElement("span");
    label.className = "tracker-day-label";
    label.textContent = dayLabel(date).split(" ")[0][0] + date.slice(8).replace(/^0/, "");
    day.append(label);
    const onDay = entries.filter((e) => e.date === date);
    for (const entry of onDay) day.append(sticker(entry, { withName: false }));
    day.title = onDay.length ? `${dayLabel(date)}: ${onDay.map((e) => e.value).join(", ")}` : `${dayLabel(date)}: add a sticker`;
    day.addEventListener("click", () => (onDay[0] ? openEntry(onDay[0]) : openEntry(null, { trackerId: tracker.id, date })));
    strip.append(day);
  }
  card.append(strip);

  card.append(quickLog(tracker));

  if (entries.length) {
    const recent = document.createElement("ul");
    recent.className = "log-entries";
    for (const entry of entries.slice(0, 5)) {
      const item = document.createElement("li");
      item.className = "log-entry";
      const date = document.createElement("span");
      date.className = "log-entry-date";
      date.textContent = dayLabel(entry.date);
      item.append(date, sticker(entry, { withName: false }));
      if (entry.source !== "user") item.append(badge(entry.source === "processing" ? "from chat" : "confirmed"));
      if (entry.messageId) item.append(messageLink(entry.messageId));
      recent.append(item);
    }
    card.append(recent);
  }
  return card;
}

/** Log today in one tap: Yes/No, a number, or a note. */
function quickLog(tracker) {
  const row = document.createElement("div");
  row.className = "quick-log";
  const label = document.createElement("span");
  label.className = "quick-log-label";
  label.textContent = "Today:";
  row.append(label);
  const logValue = async (value) => {
    try {
      await api("POST", "/api/log", { trackerId: tracker.id, date: todayDate(), value });
      await loadTrackerScreen();
    } catch (error) {
      showError(error.message, null);
    }
  };
  if (tracker.kind === "yesno") {
    row.append(actionButton("Yes", () => logValue("yes")), actionButton("No", () => logValue("no")));
  } else if (tracker.kind === "scale") {
    const select = document.createElement("select");
    select.className = "quick-log-scale";
    select.setAttribute("aria-label", `${tracker.name}, 1 to 10`);
    select.append(...Array.from({ length: 10 }, (_, i) => new Option(String(i + 1), String(i + 1))));
    select.value = "5";
    row.append(select, actionButton("Log", () => logValue(select.value)));
  } else {
    const input = document.createElement("input");
    input.className = "quick-log-note";
    input.placeholder = "A few words…";
    input.setAttribute("aria-label", `${tracker.name} note`);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && input.value.trim()) logValue(input.value);
    });
    row.append(input, actionButton("Log", () => input.value.trim() && logValue(input.value)));
  }
  return row;
}

/** "Show the message": the message a sticker came from. */
function messageLink(messageId) {
  const link = document.createElement("button");
  link.type = "button";
  link.className = "link-button inline-link message-link";
  link.textContent = "💬 show the message";
  link.addEventListener("click", (event) => {
    event.stopPropagation();
    showMessage(messageId);
  });
  return link;
}

// ------------------------------------------------------ stickers on days

/** A calendar day's stickers, in the planner's day panel (called by planner.js). */
function renderDayStickers(date) {
  const box = $("day-panel-stickers");
  box.hidden = false;
  const title = document.createElement("h4");
  title.className = "day-stickers-title";
  title.textContent = "Stickers";
  const list = document.createElement("div");
  list.className = "day-stickers";
  const onDay = stickersOn(date);
  if (onDay.length) list.append(...onDay.map((entry) => sticker(entry)));
  else list.append(Object.assign(document.createElement("span"), { className: "hint", textContent: "None." }));
  const add = actionButton("Add a sticker", () => openEntry(null, { date }));
  add.className = "button day-sticker-add";
  add.disabled = log.trackers.length === 0;
  if (add.disabled) add.title = "Make a tracker in the trackers channel first";
  box.replaceChildren(title, list, add);
}

// ------------------------------------------------------------ dialogs

/** Open a tracker in its dialog, or a new one. */
function openTracker(tracker) {
  log.editingTracker = tracker;
  const form = $("tracker-form");
  const f = form.elements;
  hideFormError(form);
  $("tracker-title").textContent = tracker ? tracker.name : "New tracker";
  f.name.value = tracker?.name ?? "";
  f.kind.value = tracker?.kind ?? "yesno";
  f.hintWords.value = tracker?.hintWords.join(", ") ?? "";
  f.canBringUp.checked = tracker?.canBringUp ?? true;
  $("tracker-delete").hidden = !tracker;
  $("tracker-dialog").showModal();
}

async function saveTracker(event) {
  event.preventDefault();
  const form = $("tracker-form");
  const f = form.elements;
  const body = {
    name: f.name.value,
    kind: f.kind.value,
    hintWords: f.hintWords.value.split(","),
    canBringUp: f.canBringUp.checked,
  };
  try {
    if (log.editingTracker) await api("PATCH", `/api/trackers/${encodeURIComponent(log.editingTracker.id)}`, body);
    else await api("POST", "/api/trackers", body);
    $("tracker-dialog").close();
    await reloadLogViews();
  } catch (error) {
    showFormError(form, error.message);
  }
}

async function deleteTracker() {
  const tracker = log.editingTracker;
  if (!confirm(`Delete the tracker "${tracker.name}" and all its stickers? This can't be undone.`)) return;
  try {
    await api("DELETE", `/api/trackers/${encodeURIComponent(tracker.id)}`, {});
    $("tracker-dialog").close();
    await reloadLogViews();
  } catch (error) {
    showFormError($("tracker-form"), error.message);
  }
}

/**
 * Open a log entry in its dialog, or a new one.
 *
 * @param start  For a new one: `{trackerId, date}` to start with.
 */
function openEntry(entry, start = {}) {
  log.editingEntry = entry;
  const form = $("log-entry-form");
  const f = form.elements;
  hideFormError(form);
  $("log-entry-title").textContent = entry ? `${trackerById(entry.trackerId)?.name ?? "Sticker"}` : "Add a sticker";
  f.trackerId.replaceChildren(...log.trackers.map((t) => new Option(t.name, t.id)));
  f.trackerId.value = entry?.trackerId ?? start.trackerId ?? log.trackers[0]?.id ?? "";
  f.trackerId.disabled = Boolean(entry);
  f.date.value = entry?.date ?? start.date ?? todayDate();
  renderEntryValue(entry?.value);
  $("log-entry-source").textContent = entry ? SOURCE_NAMES[entry.source] : "";
  $("log-entry-message").replaceChildren(...(entry?.messageId ? [messageLink(entry.messageId)] : []));
  $("log-entry-delete").hidden = !entry;
  $("log-entry-dialog").showModal();
}

/** The value box, depending on the tracker's kind. */
function renderEntryValue(value) {
  const tracker = trackerById($("log-entry-form").elements.trackerId.value);
  let box;
  if (tracker?.kind === "yesno") {
    box = document.createElement("select");
    box.append(new Option("Yes", "yes"), new Option("No", "no"));
    box.value = value ?? "yes";
  } else if (tracker?.kind === "scale") {
    box = document.createElement("select");
    box.append(...Array.from({ length: 10 }, (_, i) => new Option(String(i + 1), String(i + 1))));
    box.value = value ?? "5";
  } else {
    box = document.createElement("textarea");
    box.rows = 2;
    box.value = value ?? "";
  }
  box.name = "value";
  box.id = "log-entry-value";
  $("log-entry-value-box").replaceChildren(box);
}

async function saveEntry(event) {
  event.preventDefault();
  const form = $("log-entry-form");
  const f = form.elements;
  try {
    if (log.editingEntry) {
      await api("PATCH", `/api/log/${encodeURIComponent(log.editingEntry.id)}`, { date: f.date.value, value: f.value.value });
    } else {
      await api("POST", "/api/log", { trackerId: f.trackerId.value, date: f.date.value, value: f.value.value });
    }
    $("log-entry-dialog").close();
    await reloadLogViews();
  } catch (error) {
    showFormError(form, error.message);
  }
}

async function deleteEntry() {
  if (!confirm("Delete this sticker?")) return;
  try {
    await api("DELETE", `/api/log/${encodeURIComponent(log.editingEntry.id)}`, {});
    $("log-entry-dialog").close();
    await reloadLogViews();
  } catch (error) {
    showFormError($("log-entry-form"), error.message);
  }
}

/** After a change: redraw whichever screen shows trackers or stickers. */
async function reloadLogViews() {
  const kind = currentChannel()?.kind;
  if (kind === "trackers") await loadTrackerScreen();
  if (kind === "planner") screens.planner.reload();
}

// ------------------------------------------------------------- wiring

screens.trackers = {
  open: loadTrackerScreen,
  render: renderTrackers,
  reload: loadTrackerScreen,
};

$("new-tracker").addEventListener("click", () => openTracker(null));
$("tracker-form").addEventListener("submit", saveTracker);
$("tracker-delete").addEventListener("click", deleteTracker);
$("log-entry-form").addEventListener("submit", saveEntry);
$("log-entry-delete").addEventListener("click", deleteEntry);
$("log-entry-form").elements.trackerId.addEventListener("change", () => renderEntryValue());
