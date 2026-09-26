/**
 * The 📅 planner channel's screen (stage 3): a month calendar and a weekly
 * list, two views of the same plans (nothing is stored twice), and the plan
 * editor.
 *
 * All the working out (repeats, overnight shifts, draw time, reminder times,
 * totals) happens on the server, in src/planner.ts, and arrives ready to
 * show. This file only draws it. The small date helpers below are just for
 * moving around the calendar.
 *
 * Uses `state`, `api`, `$` and friends from app.js, which is loaded first.
 */

"use strict";

// ------------------------------------------------------------------ state

const planner = {
  /** "calendar" or "week". */
  view: "calendar",
  /** The first day of the month the calendar shows: "2026-09-01". */
  month: null,
  /** The day whose cards are shown under the calendar. */
  selectedDate: null,
  /** Any date in the week the weekly list shows. */
  weekDate: null,
  /** The calendar's occurrences (see `Occurrence` in src/types.ts). */
  occurrences: [],
  /** The weekly list (see `WeekSummary` in src/planner.ts). */
  week: null,
  /** The plan open in the editor, or null for a new one. */
  editing: null,
};

/** Emoji for each kind of plan, on the calendar. */
const PLAN_ICONS = { shift: "💼", appointment: "📌", birthday: "🎂", hangout: "🎉", other: "•" };
const PLAN_KIND_NAMES = { shift: "Shift", appointment: "Appointment", birthday: "Birthday", hangout: "Hangout", other: "Other" };
const SHIFT_TYPE_NAMES = { regular: "Regular", meeting: "Meeting", oncall: "On-call" };
const REPEAT_NAMES = { never: "", weekly: "every week", yearly: "every year" };

// ------------------------------------------------------------ date helpers

const pad2 = (n) => String(n).padStart(2, "0");

/** Today's date on this phone: "2026-09-28". */
function todayDate() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** A date `days` days later (or earlier). Noon, so daylight saving can't shift the day. */
function shiftDate(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const moved = new Date(y, m - 1, d + days, 12);
  return `${moved.getFullYear()}-${pad2(moved.getMonth() + 1)}-${pad2(moved.getDate())}`;
}

/** The Monday of a date's week. */
function mondayOfDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y, m - 1, d, 12).getDay();
  return shiftDate(date, -((day + 6) % 7));
}

/** The first of the month a date is in. */
function firstOfMonth(date) {
  return `${date.slice(0, 7)}-01`;
}

/** The first of the month before or after. */
function shiftMonth(first, months) {
  const [y, m] = first.split("-").map(Number);
  const moved = new Date(y, m - 1 + months, 1, 12);
  return `${moved.getFullYear()}-${pad2(moved.getMonth() + 1)}-01`;
}

/** "9:00a" */
function clock(time) {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad2(m)}${h < 12 ? "a" : "p"}`;
}

/** "4h 30m" */
function duration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "Mon 9/28" */
function dayLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  const weekdayName = new Date(y, m - 1, d, 12).toLocaleDateString("en-US", { weekday: "short" });
  return `${weekdayName} ${m}/${d}`;
}

/** "September 2026" */
function monthLabel(first) {
  const [y, m] = first.split("-").map(Number);
  return new Date(y, m - 1, 1, 12).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** "9:00a–5:30p", or "All day". */
function timeRange(occurrence) {
  if (!occurrence.startTime) return "All day";
  return occurrence.endTime ? `${clock(occurrence.startTime)}–${clock(occurrence.endTime)}` : clock(occurrence.startTime);
}

/** A regular shift's draw hours, like "10:00a–2:00p". */
function drawRange(plan) {
  return plan.drawStart && plan.drawEnd ? `${clock(plan.drawStart)}–${clock(plan.drawEnd)}` : null;
}

// ------------------------------------------------------------- loading

/** The first time the planner is shown: start on this month and this week. */
function startPlannerOnToday() {
  const today = todayDate();
  planner.month ??= firstOfMonth(today);
  planner.selectedDate ??= today;
  planner.weekDate ??= today;
}

/** Open the planner, and load what it shows. */
function openPlanner() {
  renderPlanner();
  loadPlanner();
}

/** The dates the calendar grid shows: whole weeks, Monday to Sunday, covering the month. */
function calendarRange() {
  const start = mondayOfDate(planner.month);
  const lastOfMonth = shiftDate(shiftMonth(planner.month, 1), -1);
  const end = shiftDate(mondayOfDate(lastOfMonth), 6);
  return { start, end };
}

/** Fetch what the current view shows, then draw it. */
async function loadPlanner() {
  try {
    if (planner.view === "calendar") {
      const { start, end } = calendarRange();
      const month = planner.month;
      const [{ occurrences }] = await Promise.all([
        api("GET", `/api/plans?from=${start}&to=${end}`),
        // Tracker stickers on the days (trackers.js, stage 5).
        loadStickers(start, end),
      ]);
      if (planner.month !== month) return; // moved on while loading
      planner.occurrences = occurrences;
    } else {
      const date = planner.weekDate;
      const { week } = await api("GET", `/api/planner/week?date=${date}`);
      if (planner.weekDate !== date) return;
      planner.week = week;
    }
    renderPlanner();
  } catch (error) {
    showError(`Couldn't load the planner: ${error.message}`, loadPlanner);
  }
}

// ------------------------------------------------------------- drawing

function renderPlanner() {
  startPlannerOnToday();
  for (const tab of document.querySelectorAll(".planner-tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.view === planner.view));
  }
  $("calendar-view").hidden = planner.view !== "calendar";
  $("week-view").hidden = planner.view !== "week";
  if (planner.view === "calendar") {
    $("planner-title").textContent = monthLabel(planner.month);
    renderCalendar();
    renderDayPanel();
  } else {
    const monday = mondayOfDate(planner.weekDate);
    $("planner-title").textContent = `Week of ${dayLabel(monday)}`;
    renderWeek();
  }
}

/** The month grid: shifts at a glance, stacked on double-booked days. */
function renderCalendar() {
  const { start, end } = calendarRange();
  const today = todayDate();
  const grid = $("calendar-grid");
  const cells = [];
  for (const name of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
    const head = document.createElement("div");
    head.className = "calendar-weekday";
    head.textContent = name;
    cells.push(head);
  }
  for (let date = start; date <= end; date = shiftDate(date, 1)) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "calendar-day";
    cell.dataset.date = date;
    if (date.slice(0, 7) !== planner.month.slice(0, 7)) cell.classList.add("outside");
    if (date === today) cell.classList.add("today");
    if (date === planner.selectedDate) cell.setAttribute("aria-pressed", "true");

    const number = document.createElement("span");
    number.className = "calendar-day-number";
    number.textContent = String(Number(date.slice(8)));
    cell.append(number);

    const onDay = planner.occurrences.filter((o) => o.date === date);
    const shifts = onDay.filter((o) => o.plan.kind === "shift");
    if (shifts.length > 1) cell.classList.add("double-booked");
    for (const shift of shifts) {
      const chip = document.createElement("span");
      chip.className = "shift-chip";
      chip.dataset.shiftType = shift.plan.shiftType;
      if (!shift.plan.checked) chip.classList.add("unchecked");
      chip.textContent = `${clock(shift.startTime)}–${clock(shift.endTime)}`;
      cell.append(chip);
    }
    for (const other of onDay.filter((o) => o.plan.kind !== "shift")) {
      const chip = document.createElement("span");
      chip.className = "plan-chip";
      chip.dataset.kind = other.plan.kind;
      if (!other.plan.checked) chip.classList.add("unchecked");
      chip.textContent = `${PLAN_ICONS[other.plan.kind]} ${other.plan.title}`;
      cell.append(chip);
    }
    // A small dot for each sticker that day (stage 5).
    const stickers = stickersOn(date);
    if (stickers.length) {
      const dots = document.createElement("span");
      dots.className = "calendar-stickers";
      dots.textContent = "•".repeat(Math.min(stickers.length, 5));
      dots.title = `${stickers.length} sticker${stickers.length === 1 ? "" : "s"}`;
      cell.append(dots);
    }
    cell.addEventListener("click", () => {
      planner.selectedDate = date;
      renderCalendar();
      renderDayPanel();
    });
    cells.push(cell);
  }
  grid.replaceChildren(...cells);
}

/** The selected day's full cards, under the calendar. */
function renderDayPanel() {
  const date = planner.selectedDate;
  $("day-panel-title").textContent = dayLabel(date);
  const onDay = planner.occurrences.filter((o) => o.date === date);
  const list = $("day-panel-cards");
  if (onDay.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Nothing planned.";
    list.replaceChildren(empty);
  } else {
    list.replaceChildren(...onDay.map(planCard));
  }
  // The day's tracker stickers (trackers.js, stage 5).
  renderDayStickers(date);
}

/** A plan's full card: everything about it, with calculated values greyed. */
function planCard(occurrence) {
  const { plan } = occurrence;
  const card = document.createElement("button");
  card.type = "button";
  card.className = plan.kind === "shift" ? "plan-card shift-card" : "plan-card";
  card.dataset.kind = plan.kind;
  if (plan.shiftType) card.dataset.shiftType = plan.shiftType;
  if (!plan.checked) card.classList.add("unchecked");

  const head = document.createElement("div");
  head.className = "plan-card-head";
  const title = document.createElement("span");
  title.className = "plan-card-title";
  title.textContent = plan.kind === "shift" ? `${SHIFT_TYPE_NAMES[plan.shiftType]} shift` : `${PLAN_ICONS[plan.kind]} ${plan.title}`;
  const time = document.createElement("span");
  time.className = "plan-card-time";
  time.textContent = timeRange(occurrence);
  head.append(title, time);
  card.append(head);

  const facts = [];
  if (plan.kind === "shift") {
    if (plan.title !== "Work" && plan.title !== "Shift") facts.push(plan.title);
    facts.push(`Shift hours ${duration(occurrence.shiftMinutes)}`);
    if (plan.shiftType === "regular") {
      facts.push(drawRange(plan) ? `Draw ${drawRange(plan)}` : "No draw hours");
    }
  }
  if (plan.repeats !== "never") facts.push(`Repeats ${REPEAT_NAMES[plan.repeats]}`);
  if (!plan.checked) facts.push("Not confirmed yet");
  if (plan.notes) facts.push(plan.notes);
  if (facts.length) {
    const details = document.createElement("div");
    details.className = "plan-card-details";
    details.textContent = facts.join(" · ");
    card.append(details);
  }
  if (occurrence.drawMinutes !== null) {
    const draw = document.createElement("div");
    draw.className = "plan-card-details draw-time";
    draw.title = "Calculated from the draw hours";
    draw.textContent = `Draw time ${duration(occurrence.drawMinutes)}`;
    card.append(draw);
  }
  if (occurrence.reminders.length) {
    const reminders = document.createElement("div");
    reminders.className = "plan-card-reminders";
    reminders.textContent = `🔔 ${occurrence.reminders
      .map((r) => `${r.label} (${dayLabel(r.date)} ${clock(r.time)}${r.dodged ? ", moved before work" : ""})`)
      .join(", ")}`;
    card.append(reminders);
  }
  card.addEventListener("click", () => openPlan(plan));
  return card;
}

/** The weekly list: every shift with all its fields, day totals, week totals. */
function renderWeek() {
  const list = $("week-list");
  const week = planner.week;
  if (!week) {
    list.replaceChildren();
    return;
  }
  const today = todayDate();
  const days = week.days.map((day) => {
    const section = document.createElement("section");
    section.className = "week-day";
    section.dataset.date = day.date;
    if (day.date === today) section.classList.add("today");
    const heading = document.createElement("h3");
    heading.className = "week-day-title";
    heading.textContent = dayLabel(day.date);
    section.append(heading);

    if (day.occurrences.length === 0) {
      const off = document.createElement("p");
      off.className = "week-day-empty";
      off.textContent = "—";
      section.append(off);
    }
    for (const occurrence of day.occurrences) {
      section.append(occurrence.plan.kind === "shift" ? shiftRow(occurrence) : planRow(occurrence));
    }
    if (day.doubleBooked) {
      const total = document.createElement("p");
      total.className = "week-day-total";
      total.textContent = `Day total: ${duration(day.shiftMinutes)} shift, ${duration(day.drawMinutes)} draw`;
      section.append(total);
    }
    return section;
  });

  const totals = document.createElement("section");
  totals.className = "week-totals";
  const parts = [`Shift hours ${duration(week.totals.shiftMinutes)}`, `Draw time ${duration(week.totals.drawMinutes)}`];
  if (week.totals.onCallMinutes) parts.push(`On-call ${duration(week.totals.onCallMinutes)} (not counted)`);
  totals.textContent = parts.join(" · ");
  list.replaceChildren(...days, totals);
}

/** One shift in the weekly list: type, shift hours, draw hours, draw time. */
function shiftRow(occurrence) {
  const { plan } = occurrence;
  const row = document.createElement("button");
  row.type = "button";
  row.className = "shift-row";
  row.dataset.shiftType = plan.shiftType;
  if (!plan.checked) row.classList.add("unchecked");
  const cells = [
    ["shift-row-type", SHIFT_TYPE_NAMES[plan.shiftType]],
    ["shift-row-hours", timeRange(occurrence)],
    ["shift-row-length", `${duration(occurrence.shiftMinutes)} shift`],
    ["shift-row-draw", plan.shiftType === "regular" ? (drawRange(plan) ? `Draw ${drawRange(plan)}` : "No draw hours") : ""],
    ["shift-row-draw-time draw-time", occurrence.drawMinutes !== null ? `${duration(occurrence.drawMinutes)} draw` : ""],
  ];
  for (const [className, text] of cells) {
    const cell = document.createElement("span");
    cell.className = className;
    cell.textContent = text;
    row.append(cell);
  }
  row.addEventListener("click", () => openPlan(plan));
  return row;
}

/** Any other plan in the weekly list. */
function planRow(occurrence) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "week-plan";
  row.dataset.kind = occurrence.plan.kind;
  if (!occurrence.plan.checked) row.classList.add("unchecked");
  row.textContent = `${PLAN_ICONS[occurrence.plan.kind]} ${occurrence.plan.title} · ${timeRange(occurrence)}`;
  row.addEventListener("click", () => openPlan(occurrence.plan));
  return row;
}

// ----------------------------------------------------------- navigating

function plannerStep(step) {
  if (planner.view === "calendar") planner.month = shiftMonth(planner.month, step);
  else planner.weekDate = shiftDate(planner.weekDate, step * 7);
  renderPlanner();
  loadPlanner();
}

function plannerToday() {
  const today = todayDate();
  planner.month = firstOfMonth(today);
  planner.selectedDate = today;
  planner.weekDate = today;
  renderPlanner();
  loadPlanner();
}

function plannerView(view) {
  planner.view = view;
  // Keep the two views on the same stretch of time.
  if (view === "week") planner.weekDate = planner.selectedDate ?? planner.weekDate;
  else planner.month = firstOfMonth(planner.weekDate);
  renderPlanner();
  loadPlanner();
}

// ----------------------------------------------------------- the editor

/** Open a plan in the editor, or a new one (with `date` to start on). */
function openPlan(plan, date = planner.selectedDate ?? todayDate()) {
  planner.editing = plan;
  const form = $("plan-form");
  const f = form.elements;
  hideFormError(form);
  $("plan-title").textContent = plan ? plan.title : "New plan";
  f.kind.value = plan?.kind ?? "appointment";
  f.title.value = plan?.title ?? "";
  f.shiftType.value = plan?.shiftType ?? "regular";
  f.allDay.checked = plan ? plan.startTime === null : false;
  f.startDate.value = plan?.startDate ?? date;
  f.startTime.value = plan?.startTime ?? "";
  f.endDate.value = plan?.endDate ?? "";
  f.endTime.value = plan?.endTime ?? "";
  f.drawStart.value = plan?.drawStart ?? "";
  f.drawEnd.value = plan?.drawEnd ?? "";
  f.repeats.value = plan?.repeats ?? "never";
  f.checked.checked = plan ? plan.checked : true;
  f.notes.value = plan?.notes ?? "";
  f.reminderMode.value = plan?.reminders === null || !plan ? "default" : "custom";
  for (const box of form.querySelectorAll('input[name="reminder"]')) {
    box.checked = Boolean(plan?.reminders?.includes(box.value));
  }
  $("plan-delete").hidden = !plan;
  updatePlanForm();
  $("plan-dialog").showModal();
}

/** Show the fields that apply to the chosen kind, and the calculated draw time. */
function updatePlanForm() {
  const f = $("plan-form").elements;
  const shift = f.kind.value === "shift";
  const regular = shift && f.shiftType.value === "regular";
  $("plan-shift-fields").hidden = !shift;
  $("plan-draw-fields").hidden = !regular;
  $("plan-all-day-row").hidden = shift;
  const allDay = !shift && f.allDay.checked;
  $("plan-start-time-field").hidden = allDay;
  $("plan-end-time-field").hidden = allDay;

  // Draw time is calculated from the draw hours, never typed in.
  const drawTime = $("plan-draw-time");
  if (regular && f.drawStart.value && f.drawEnd.value) {
    const [sh, sm] = f.drawStart.value.split(":").map(Number);
    const [eh, em] = f.drawEnd.value.split(":").map(Number);
    let minutes = eh * 60 + em - (sh * 60 + sm);
    if (minutes < 0) minutes += 24 * 60; // past midnight
    drawTime.textContent = `Draw time: ${duration(minutes)} (calculated)`;
  } else {
    drawTime.textContent = regular ? "Draw time: add draw hours to calculate it" : "";
  }

  // The kind's default reminders, named in the Default option.
  const defaults = state.planner?.defaultReminders?.[f.kind.value] ?? [];
  const labels = state.planner?.reminderLabels ?? {};
  $("plan-reminder-default").textContent = `Default for this kind (${defaults.map((id) => labels[id]).join(", ") || "none"})`;
  $("plan-reminder-choices").hidden = f.reminderMode.value !== "custom";
}

async function savePlan(event) {
  event.preventDefault();
  const form = $("plan-form");
  const f = form.elements;
  const shift = f.kind.value === "shift";
  const allDay = !shift && f.allDay.checked;
  const mode = f.reminderMode.value;
  const body = {
    kind: f.kind.value,
    title: f.title.value,
    startDate: f.startDate.value,
    startTime: allDay ? null : f.startTime.value || null,
    endDate: f.endDate.value || null,
    endTime: allDay ? null : f.endTime.value || null,
    repeats: f.repeats.value,
    reminders:
      mode === "default" ? null : mode === "none" ? [] : [...form.querySelectorAll('input[name="reminder"]:checked')].map((b) => b.value),
    checked: f.checked.checked,
    notes: f.notes.value,
    shiftType: shift ? f.shiftType.value : null,
    drawStart: f.drawStart.value || null,
    drawEnd: f.drawEnd.value || null,
  };
  try {
    if (planner.editing) await api("PATCH", `/api/plans/${encodeURIComponent(planner.editing.id)}`, body);
    else await api("POST", "/api/plans", body);
    $("plan-dialog").close();
    planner.selectedDate = body.startDate;
    if (planner.view === "calendar" && firstOfMonth(body.startDate) !== planner.month) planner.month = firstOfMonth(body.startDate);
    loadPlanner();
  } catch (error) {
    showFormError(form, error.message);
  }
}

async function deletePlan() {
  const plan = planner.editing;
  const repeatNote = plan.repeats === "never" ? "" : ` It repeats ${REPEAT_NAMES[plan.repeats]}: every time goes.`;
  if (!confirm(`Delete "${plan.title}"?${repeatNote}`)) return;
  try {
    await api("DELETE", `/api/plans/${encodeURIComponent(plan.id)}`, {});
    $("plan-dialog").close();
    loadPlanner();
  } catch (error) {
    showFormError($("plan-form"), error.message);
  }
}

// ------------------------------------------------------------- wiring

screens.planner = { open: openPlanner, render: renderPlanner, reload: loadPlanner };

for (const tab of document.querySelectorAll(".planner-tab")) {
  tab.addEventListener("click", () => plannerView(tab.dataset.view));
}
$("planner-prev").addEventListener("click", () => plannerStep(-1));
$("planner-next").addEventListener("click", () => plannerStep(1));
$("planner-today").addEventListener("click", plannerToday);
$("planner-add").addEventListener("click", () => openPlan(null));
$("plan-form").addEventListener("submit", savePlan);
$("plan-form").addEventListener("change", (event) => {
  // A new shift is usually called "Work"; you can change it.
  const f = event.currentTarget.elements;
  if (event.target === f.kind && f.kind.value === "shift" && !f.title.value) f.title.value = "Work";
  updatePlanForm();
});
$("plan-form").addEventListener("input", updatePlanForm);
$("plan-delete").addEventListener("click", deletePlan);
