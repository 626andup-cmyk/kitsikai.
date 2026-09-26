/**
 * Screenshot import (stage 4): the review list.
 *
 * You pick a screenshot of your work schedule; the server has the
 * screenshot-reading profile (a vision model) read it, and sends back rows,
 * already checked (see src/screenshot.ts). This file shows them beside the
 * screenshot, lets you fix any field, and saves them.
 *
 * Every edit is sent back to the server to be checked again (a moment after
 * you stop typing), so the draw time and the ⚠️ warnings always match what
 * the rows say now. Warnings never stop you saving.
 *
 * Uses `state`, `api`, `$` and friends from app.js, and the date helpers
 * from planner.js.
 */

"use strict";

const importer = {
  /** The rows being reviewed: what was read, plus what the server worked out. */
  rows: [],
  /** The picture, as a URL the <img> can show. */
  imageUrl: null,
  /** Timer for checking again after an edit. */
  checkTimer: null,
  /** Counts checks, so an old answer arriving late is ignored. */
  checks: 0,
};

const SHIFT_TYPE_OPTIONS = [
  ["regular", "Regular"],
  ["meeting", "Meeting"],
  ["oncall", "On-call"],
];

/** "Import screenshot": pick a picture. */
function chooseScreenshot() {
  $("import-file").click();
}

/** A picture was chosen: show it, and have the server read it. */
async function startImport(file) {
  if (!file) return;
  if (importer.imageUrl) URL.revokeObjectURL(importer.imageUrl);
  importer.imageUrl = URL.createObjectURL(file);
  importer.rows = [];
  $("import-image").src = importer.imageUrl;
  hideFormError($("import-dialog"));
  renderReview();
  setImportStatus("Reading your schedule…");
  $("import-dialog").showModal();
  try {
    const image = await readAsBase64(file);
    const { rows, profile } = await api("POST", "/api/screenshots/read", { image, mimeType: file.type || "image/png" });
    importer.rows = rows;
    setImportStatus(rows.length ? `${profile} found ${rows.length} shift${rows.length === 1 ? "" : "s"}. Check them against the screenshot.` : `${profile} didn't find any shifts. Add them yourself, or try another screenshot.`, false);
    renderReview();
  } catch (error) {
    setImportStatus("", false);
    showFormError($("import-dialog"), `Couldn't read the screenshot: ${error.message}`);
  }
}

function setImportStatus(text, working = true) {
  $("import-status").hidden = text === "";
  $("import-status-text").textContent = text;
  $("import-status").querySelector(".typing-dots").hidden = !working;
}

/** Draw the review list: one card per shift, with the same fields as the weekly list. */
function renderReview() {
  $("review-list").replaceChildren(...importer.rows.map(reviewRow));
  updateImportSummary();
}

/** One row: every field can be tapped and fixed. */
function reviewRow(row, index) {
  const element = document.createElement("div");
  element.className = "review-row";
  element.dataset.index = String(index);

  // Day: a date box, with the weekday it falls on.
  const day = document.createElement("label");
  day.className = "review-day";
  const date = input("date", row.date ?? "", "Day");
  date.addEventListener("input", () => editRow(index, { date: date.value || null }));
  const weekdayName = document.createElement("span");
  weekdayName.className = "review-weekday";
  day.append(date, weekdayName);

  const type = document.createElement("select");
  type.className = "review-type";
  type.setAttribute("aria-label", "Shift type");
  type.append(...SHIFT_TYPE_OPTIONS.map(([value, label]) => new Option(label, value)));
  type.value = row.shiftType;
  type.addEventListener("change", () => {
    editRow(index, { shiftType: type.value });
    element.querySelector(".review-draw").classList.toggle("not-regular", type.value !== "regular");
  });

  const hours = timePair(row.startTime, row.endTime, "Shift", (startTime, endTime) => editRow(index, { startTime, endTime }));
  hours.classList.add("review-hours");
  const draw = timePair(row.drawStart, row.drawEnd, "Draw", (drawStart, drawEnd) => editRow(index, { drawStart, drawEnd }));
  draw.classList.add("review-draw");
  if (row.shiftType !== "regular") draw.classList.add("not-regular");

  const drawTime = document.createElement("span");
  drawTime.className = "review-draw-time draw-time";
  drawTime.title = "Draw time, calculated from the draw hours";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-button review-remove";
  remove.textContent = "✕";
  remove.title = "Remove this shift";
  remove.setAttribute("aria-label", "Remove this shift");
  remove.addEventListener("click", () => {
    importer.rows.splice(index, 1);
    renderReview();
    scheduleCheck();
  });

  const notes = document.createElement("div");
  notes.className = "review-notes";

  element.append(day, type, hours, draw, drawTime, remove, notes);
  showRowChecks(element, row);
  return element;
}

/** Two time boxes, "from" and "to", with a label ("Shift", "Draw"). */
function timePair(start, end, label, onChange) {
  const pair = document.createElement("span");
  pair.className = "time-pair";
  const name = document.createElement("span");
  name.className = "time-pair-label";
  name.textContent = label;
  const from = input("time", start ?? "", `${label} from`);
  const to = input("time", end ?? "", `${label} to`);
  const dash = document.createElement("span");
  dash.textContent = "–";
  const changed = () => onChange(from.value || null, to.value || null);
  from.addEventListener("input", changed);
  to.addEventListener("input", changed);
  pair.append(name, from, dash, to);
  return pair;
}

function input(type, value, label) {
  const box = document.createElement("input");
  box.type = type;
  box.value = value;
  box.setAttribute("aria-label", label);
  return box;
}

/** Show what the server worked out for a row: its weekday, draw time, warnings and error. */
function showRowChecks(element, row) {
  element.querySelector(".review-weekday").textContent = row.date ? dayLabel(row.date).split(" ")[0] : "";
  element.querySelector(".review-draw-time").textContent =
    row.shiftType === "regular" && row.drawMinutes !== null && row.drawMinutes !== undefined ? `${duration(row.drawMinutes)} draw` : "";
  const notes = element.querySelector(".review-notes");
  const lines = [];
  if (row.error) {
    const error = document.createElement("p");
    error.className = "review-error";
    error.textContent = `✗ ${row.error}`;
    lines.push(error);
  }
  for (const warning of row.warnings ?? []) {
    const line = document.createElement("p");
    line.className = "review-warning";
    line.textContent = `⚠️ ${warning}`;
    lines.push(line);
  }
  notes.replaceChildren(...lines);
  element.classList.toggle("has-warnings", (row.warnings ?? []).length > 0);
  element.classList.toggle("has-error", Boolean(row.error));
}

/** A field was changed: remember it, and check the rows again in a moment. */
function editRow(index, changes) {
  Object.assign(importer.rows[index], changes);
  scheduleCheck();
}

function scheduleCheck() {
  clearTimeout(importer.checkTimer);
  importer.checkTimer = setTimeout(checkReview, 300);
}

/** Send the rows back to be checked, and update what was worked out, without redrawing the boxes you're typing in. */
async function checkReview() {
  const check = ++importer.checks;
  try {
    const { rows } = await api("POST", "/api/screenshots/check", { rows: importer.rows });
    if (check !== importer.checks || rows.length !== importer.rows.length) return;
    importer.rows = rows;
    for (const element of $("review-list").querySelectorAll(".review-row[data-index]")) {
      showRowChecks(element, rows[Number(element.dataset.index)]);
    }
    updateImportSummary();
  } catch (error) {
    showFormError($("import-dialog"), error.message);
  }
}

/** "3 shifts · 1 warning". */
function updateImportSummary() {
  const count = importer.rows.length;
  const warnings = importer.rows.reduce((sum, r) => sum + (r.warnings?.length ?? 0), 0);
  const errors = importer.rows.filter((r) => r.error).length;
  const parts = [`${count} shift${count === 1 ? "" : "s"}`];
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  if (errors) parts.push(`${errors} to fix`);
  $("import-summary").textContent = count ? parts.join(" · ") : "";
  $("import-save").disabled = count === 0;
}

/** "Add a shift": a blank row, on the day after the last one. */
function addReviewRow() {
  const last = importer.rows.at(-1);
  importer.rows.push({
    date: last?.date ? shiftDate(last.date, 1) : planner.selectedDate ?? todayDate(),
    shiftType: "regular",
    startTime: last?.startTime ?? null,
    endTime: last?.endTime ?? null,
    drawStart: null,
    drawEnd: null,
    weekdayRead: null,
    warnings: [],
    error: null,
  });
  renderReview();
  scheduleCheck();
}

/** "Looks good, save": every row becomes a checked shift. */
async function saveImport() {
  clearTimeout(importer.checkTimer);
  const button = $("import-save");
  button.disabled = true;
  try {
    const { plans } = await api("POST", "/api/screenshots/save", { rows: importer.rows });
    $("import-dialog").close();
    showNotice(`Saved ${plans.length} shift${plans.length === 1 ? "" : "s"} from the screenshot.`);
    if (plans[0]) {
      planner.selectedDate = plans[0].startDate;
      planner.month = firstOfMonth(plans[0].startDate);
      planner.weekDate = plans[0].startDate;
    }
    screens.planner.reload();
  } catch (error) {
    showFormError($("import-dialog"), error.message);
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------- wiring

$("planner-import").addEventListener("click", chooseScreenshot);
$("import-file").addEventListener("change", (event) => {
  startImport(event.target.files[0]);
  event.target.value = ""; // so choosing the same file again still counts
});
$("import-add-row").addEventListener("click", addReviewRow);
$("import-save").addEventListener("click", saveImport);
$("import-dialog").addEventListener("close", () => clearTimeout(importer.checkTimer));
