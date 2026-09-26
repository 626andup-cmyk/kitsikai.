/**
 * Her memory in the app (stage 7): "Test Jev" in settings, and the advanced
 * page, "Kitsikai's notes". From stage 8 the page also shows texting first:
 * due reminders, what her snapshot checks decided and why, and "Check now".
 *
 * The advanced page shows her scratchpad notes, her pins with their reasons,
 * the drawer of pins she's taken down, and the processing log: what was
 * kept, tossed, asked about and why, each linked to the message it came
 * from. "Process now" runs a processing round straight away, for testing.
 *
 * **Look, don't touch** (DESIGN.md): there's nothing to edit here. Her notes
 * change through her, by talking, so there's only one way for them to go
 * wrong. The page only reads (GET /api/memory), and refreshes itself when
 * the server says her memory changed (a "memory" event).
 *
 * Uses `state`, `api`, `$` and friends from app.js.
 */

"use strict";

const notesPage = {
  /** The last GET /api/memory. */
  data: null,
  /** The last GET /api/proactive (stage 8). */
  proactive: null,
  /** What "Check now" last found, shown until the page is closed. */
  lastCheck: null,
};

/** How each action reads in the log. */
const ACTION_WORDS = {
  noted: "Noted",
  rewritten: "Rewrote",
  committed: "Saved",
  asking: "Will ask",
  bringup: "Might bring up",
  pinned: "Pinned",
  unpinned: "Took down",
  tossed: "Tossed",
  kept: "Kept",
  confirmed: "They said yes",
  declined: "They said no",
  done: "Settled",
  error: "Problem",
};

const NOTE_KINDS = { tracker: "tracker", plan: "plan", remember: "to remember", request: "your request" };
const TRIGGER_WORDS = { timer: "Regular round", early: "Early round (time-sensitive)", manual: "Process now" };

// ---------------------------------------------------------------- Test Jev

/** Settings → "Test Jev": one tiny question, and what came back, raw. */
async function testJevButton() {
  const box = $("jev-test-result");
  box.hidden = false;
  box.className = "jev-test-result";
  box.textContent = "Asking Jev…";
  try {
    const { test } = await api("POST", "/api/jev/test", {});
    box.classList.add(test.ok ? "ok" : "failed");
    const detail = document.createElement("p");
    detail.textContent = `${test.ok ? "✓" : "⚠️"} ${test.detail}`;
    box.replaceChildren(detail);
    if (test.report) {
      const raw = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `Raw reply (${test.report.seconds}s)`;
      const pre = document.createElement("pre");
      pre.textContent = test.report.raw || "(nothing)";
      raw.append(summary, pre);
      box.append(raw);
    }
  } catch (error) {
    box.classList.add("failed");
    box.textContent = `⚠️ ${error.message}`;
  }
}

// ------------------------------------------------------------ the page

async function openNotes() {
  hideFormError($("notes-dialog"));
  notesPage.lastCheck = null;
  $("notes-dialog").showModal();
  await loadNotes();
}

async function loadNotes() {
  try {
    [notesPage.data, notesPage.proactive] = await Promise.all([api("GET", "/api/memory"), api("GET", "/api/proactive")]);
    renderNotes();
    renderProactive();
  } catch (error) {
    showFormError($("notes-dialog"), error.message);
  }
}

/** "Sat 4:10 PM" */
function memoryTime(iso) {
  const date = new Date(iso);
  return `${date.toLocaleDateString([], { weekday: "short" })} ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** "Fri, Oct 2", from "2026-10-02". */
function dateWords(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "from a message": a link that jumps to it. */
function sourceLink(messageId) {
  const link = element("button", "link-button memory-source", "show the message");
  link.type = "button";
  link.addEventListener("click", () => showMessage(messageId));
  return link;
}

/** A section with a title and a list, or a line saying it's empty. */
function fillSection(section, title, items, empty, hint) {
  const heading = element("h3", "section-title", title);
  const children = [heading];
  if (hint) children.push(element("p", "hint", hint));
  if (items.length) {
    const list = element("ol", "memory-list");
    list.append(...items);
    children.push(list);
  } else {
    children.push(element("p", "memory-empty", empty));
  }
  section.replaceChildren(...children);
}

function pinCard(pin) {
  const card = element("li", "memory-card pin-card");
  card.dataset.status = pin.status;
  card.append(element("div", "memory-card-text", `📌 ${pin.text}`));
  const facts = [];
  if (pin.reason) facts.push(`Why: ${pin.reason}`);
  const when = [pin.unpinWhen, pin.unpinDate ? `after ${dateWords(pin.unpinDate)}` : ""].filter(Boolean).join(", ");
  if (when) facts.push(`Unpin when: ${when}`);
  if (pin.yours) facts.push("You asked for this.");
  facts.push(pin.status === "pinned" ? `Pinned ${memoryTime(pin.pinnedAt)}` : `Taken down ${memoryTime(pin.unpinnedAt)}: ${pin.unpinReason ?? ""}`);
  for (const fact of facts) card.append(element("div", "memory-card-fact", fact));
  return card;
}

function noteCard(note) {
  const card = element("li", "memory-card note-card");
  card.dataset.kind = note.kind;
  card.dataset.status = note.status;
  card.append(element("div", "memory-card-text", note.status === "asking" && note.ask ? note.ask : note.text));
  const facts = element("div", "memory-card-fact");
  const bits = [NOTE_KINDS[note.kind], note.origin === "jotted" ? "she jotted it" : "Jev noticed it", memoryTime(note.createdAt)];
  if (note.timeSensitive && note.status === "open") bits.push("soon: processed early");
  if (note.confirmed) bits.push("you said yes");
  facts.textContent = `${bits.join(" · ")} `;
  if (note.messageId) facts.append(sourceLink(note.messageId));
  card.append(facts);
  return card;
}

function logLine(entry) {
  const line = element("li", "memory-log-line");
  line.dataset.action = entry.action;
  line.append(element("span", "memory-log-action", ACTION_WORDS[entry.action] ?? entry.action));
  line.append(element("span", "memory-log-text", ` ${entry.text}`));
  if (entry.reason) line.append(element("span", "memory-log-reason", ` (${entry.reason})`));
  if (entry.messageId) {
    line.append(" ");
    line.append(sourceLink(entry.messageId));
  }
  return line;
}

function renderNotes() {
  const data = notesPage.data;
  if (!data) return;

  // Status: Jev, and when she processes next.
  const status = [];
  const jev = data.jev;
  if (!jev.enabled) status.push("⚠️ Jev is turned off and there's no fallback, so nothing gets noticed or processed.");
  else if (jev.checkError) status.push(`⚠️ The last check of your messages failed: ${jev.checkError}`);
  else if (jev.lastReport?.jevError && jev.lastReport.answeredBy === "fallback") status.push(`Jev failed, so the fallback answered: ${jev.lastReport.jevError}`);
  else status.push(`Decisions by ${jev.model || "the fallback profile"}.`);
  status.push(
    data.processing.running
      ? "Processing right now…"
      : `Next processing round: ${memoryTime(data.processing.nextRunAt)} (every ${data.processing.every} hours).`,
  );
  $("notes-status").replaceChildren(...status.map((text) => element("p", "hint", text)));
  $("process-now").disabled = data.processing.running;

  const byStatus = (s) => data.notes.filter((n) => n.status === s);
  fillSection($("notes-pins"), `Pins (${data.pins.length} of ${data.pinCap})`, data.pins.map(pinCard), "Nothing pinned right now.", "What matters right now. Always in her view.");
  fillSection($("notes-scratchpad"), "On her scratchpad", byStatus("open").map(noteCard), "Nothing waiting to be processed.", "In pencil: processed every few hours.");
  fillSection($("notes-asking"), "She'll ask you about", byStatus("asking").map(noteCard), "Nothing to ask.");
  fillSection($("notes-bringup"), "She might bring up", byStatus("bringup").map(noteCard), "Nothing right now.");
  $("notes-drawer").replaceChildren(...(data.drawer.length ? data.drawer.map(pinCard) : [element("p", "memory-empty", "Empty.")]));

  // The processing log: rounds that did something, and what happened during chat.
  const rounds = data.runs.filter((run) => run.log.length || run.error);
  const groups = [];
  if (data.duringChat.length) {
    const group = element("li", "memory-round");
    group.append(element("div", "memory-round-title", "During chat"));
    const lines = element("ol", "memory-log");
    lines.append(...data.duringChat.slice(0, 30).map(logLine));
    group.append(lines);
    groups.push(group);
  }
  for (const run of rounds) {
    const group = element("li", "memory-round");
    group.dataset.trigger = run.trigger;
    group.append(element("div", "memory-round-title", `${TRIGGER_WORDS[run.trigger]}, ${memoryTime(run.startedAt)}${run.error ? " (stopped early)" : ""}`));
    const lines = element("ol", "memory-log");
    lines.append(...run.log.map(logLine));
    group.append(lines);
    groups.push(group);
  }
  fillSection($("notes-log"), "Processing log", groups, "Nothing has happened yet.", "What she kept, tossed and asked about, and why. Newest round first.");
  const list = $("notes-log").querySelector(".memory-list");
  if (list) list.classList.add("memory-rounds");
}

async function processNow() {
  const button = $("process-now");
  button.disabled = true;
  button.textContent = "Processing…";
  try {
    await api("POST", "/api/processing/run", {});
    await loadNotes();
  } catch (error) {
    showFormError($("notes-dialog"), error.message);
  } finally {
    button.textContent = "Process now";
    button.disabled = false;
  }
}

/** Show "Kitsikai's notes…" in settings only when Show advanced is ticked. */
function updateAdvanced() {
  $("open-notes").hidden = !$("setting-show-advanced").checked;
}

// ---------------------------------------------------------- texting first

const OUTCOME_WORDS = {
  sent: "Texted first",
  queued: "Queued a reminder",
  waiting: "Waiting",
  declined: "Chose not to",
  nothing: "Nothing",
  error: "Problem",
};
const REASON_WORDS = { reminder: "a reminder", checkin: "a check-in after work", followup: "a follow-up", "just-because": "just because" };
const REMINDER_STATUS = { sent: "Sent", skipped: "Skipped", queued: "Queued" };

/** The advanced page's texting-first section (stage 8). */
function renderProactive() {
  const data = notesPage.proactive;
  if (!data) return;
  const section = $("notes-proactive");
  const children = [element("h3", "section-title", "Texting first")];
  const status = [
    data.lastCheckAt ? `Last check: ${memoryTime(data.lastCheckAt)}. Next: ${memoryTime(data.nextCheckAt)}.` : "No check since the server started.",
  ];
  if (!state.settings.textFirst) status.push("Texting first is off in Settings.");
  if (!data.notificationsAvailable) status.push("Notifications aren't available on this device.");
  children.push(...status.map((text) => element("p", "hint", text)));
  if (notesPage.lastCheck) {
    const found = element("p", "proactive-check-result", `${OUTCOME_WORDS[notesPage.lastCheck.outcome]}: ${notesPage.lastCheck.detail}`);
    found.dataset.outcome = notesPage.lastCheck.outcome;
    children.push(found);
  }

  children.push(element("div", "memory-round-title", "Reminders due now"));
  if (data.due.length) {
    const list = element("ol", "memory-log");
    list.append(
      ...data.due.map((r) => {
        const line = element("li", "memory-log-line reminder-due");
        line.append(element("span", "memory-log-text", `${r.text} (${r.label.toLowerCase()})`));
        if (r.queuedIn) line.append(element("span", "memory-log-reason", " queued: she'll mention it in the conversation"));
        return line;
      }),
    );
    children.push(list);
  } else {
    children.push(element("p", "memory-empty", "None."));
  }

  children.push(element("div", "memory-round-title", "Recent checks"));
  if (data.log.length) {
    const list = element("ol", "memory-log");
    list.append(
      ...data.log.map((entry) => {
        const line = element("li", "memory-log-line proactive-line");
        line.dataset.outcome = entry.outcome;
        line.append(element("span", "memory-log-action", `${OUTCOME_WORDS[entry.outcome]}${entry.reason ? ` (${REASON_WORDS[entry.reason]})` : ""}`));
        line.append(element("span", "memory-log-text", ` ${memoryTime(entry.createdAt)}: ${entry.detail}`));
        if (entry.messageId) {
          line.append(" ");
          line.append(sourceLink(entry.messageId));
        }
        return line;
      }),
    );
    children.push(list);
  } else {
    children.push(element("p", "memory-empty", "Nothing yet. Checks that find nothing to ask about aren't kept."));
  }

  if (data.reminders.length) {
    children.push(element("div", "memory-round-title", "Reminders"));
    const list = element("ol", "memory-log");
    list.append(
      ...data.reminders.map((r) => {
        const line = element("li", "memory-log-line reminder-record");
        line.dataset.status = r.status;
        line.append(element("span", "memory-log-action", REMINDER_STATUS[r.status]));
        line.append(element("span", "memory-log-text", ` ${r.text}`));
        if (r.reason) line.append(element("span", "memory-log-reason", ` (${r.reason})`));
        if (r.messageId) {
          line.append(" ");
          line.append(sourceLink(r.messageId));
        }
        return line;
      }),
    );
    children.push(list);
  }
  section.replaceChildren(...children);
}

/** "Check now": run her snapshot check straight away, and show what it decided. */
async function checkNow() {
  const button = $("check-now");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const { check } = await api("POST", "/api/proactive/check", {});
    notesPage.lastCheck = check;
    await loadNotes();
  } catch (error) {
    showFormError($("notes-dialog"), error.message);
  } finally {
    button.textContent = "Check now";
    button.disabled = false;
  }
}

// ------------------------------------------------------------- wiring

$("test-jev").addEventListener("click", testJevButton);
$("open-notes").addEventListener("click", openNotes);
$("process-now").addEventListener("click", processNow);
$("check-now").addEventListener("click", checkNow);
$("setting-show-advanced").addEventListener("change", updateAdvanced);
