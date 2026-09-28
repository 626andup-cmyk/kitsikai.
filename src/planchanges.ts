/**
 * Planner changes she makes: adding, changing or removing your plans and
 * shifts, with your yes.
 *
 * Her tools `add_plan`, `change_plan` and `remove_plan` (src/tools.ts) never
 * just change the planner. Each one:
 *
 * 1. Drafts the change, checked like any plan (`validatePlan`), and words
 *    it: "Add: Thu, Oct 1: Appointment: Dentist, 3:00p".
 * 2. Asks **Jev** whether she should (`askedFor`): did you ask for this, or
 *    clearly say yes to it? A confident yes means it's done right away:
 *    "can you add my dentist thursday at 3" needs no second yes.
 * 3. Otherwise it waits, **pending**, and she asks you in her reply. It
 *    happens when you say yes:
 *    - in chat: the scratchpad check (src/scratchpad.ts) asks Jev, for each
 *      change waiting in that channel, whether your new messages say yes,
 *      no, or don't answer it; or
 *    - with a tap: the change shows under her message, with Yes and No.
 *
 * A pending change expires after a day, or when its plan is deleted.
 * Without Jev, nothing is done without a tap. Every change remembers how it
 * ended and why ("they said yes (95% sure)", "you tapped Yes"), and the
 * ones waiting or just done are in her prompt, so she knows.
 */

import type { Database } from "bun:sqlite";
import { dayName, describeOccurrence } from "./binder.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import type { Events } from "./events.ts";
import { probabilityOf, percent, tier, type Decider } from "./jev.ts";
import { shiftFacts, validatePlan, type PlanInput } from "./planner.ts";
import { chatLine } from "./scratchpad.ts";
import type { Store } from "./store.ts";
import type { Plan } from "./types.ts";

/** How long a change waits for your yes. */
export const PENDING_HOURS = 24;
/** How long a change that's been settled stays in her prompt. */
const RECENT_HOURS = 6;
/** How many recent messages Jev reads when asked whether she should. */
const CONTEXT_MESSAGES = 10;

export type PlanChangeAction = "add" | "change" | "remove";
export type PlanChangeStatus = "pending" | "applied" | "declined" | "expired" | "failed";

/** A change to the planner she offered or made. */
export interface PlanChange {
  id: string;
  action: PlanChangeAction;
  /** The plan it changes or removes (null for an add, or if it was deleted since). */
  planId: string | null;
  /** The plan as it would be afterwards (null for a removal). */
  plan: PlanInput | null;
  /** In words: "Add: Thu, Oct 1: Appointment: Dentist, 3:00p". */
  summary: string;
  /** For a change: the plan before it, in words. */
  before: string | null;
  status: PlanChangeStatus;
  /** Why it ended that way: "they said yes (95% sure)", "you tapped No"... */
  reason: string | null;
  channelId: string | null;
  /** Her turn that offered it, so the app can show it under that reply. */
  turnId: string | null;
  /** Your message that answered it, if one did. */
  messageId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface PlanChangeRow {
  id: string;
  action: PlanChangeAction;
  plan_id: string | null;
  plan: string | null;
  summary: string;
  before: string | null;
  status: PlanChangeStatus;
  reason: string | null;
  channel_id: string | null;
  turn_id: string | null;
  message_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

function toChange(row: PlanChangeRow): PlanChange {
  return {
    id: row.id,
    action: row.action,
    planId: row.plan_id,
    plan: row.plan === null ? null : (JSON.parse(row.plan) as PlanInput),
    summary: row.summary,
    before: row.before,
    status: row.status,
    reason: row.reason,
    channelId: row.channel_id,
    turnId: row.turn_id,
    messageId: row.message_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

// ----------------------------------------------------------------- store

/** The changes, in the database. */
export class PlanChanges {
  constructor(private readonly db: Database) {}

  add(input: Pick<PlanChange, "action" | "planId" | "plan" | "summary" | "before" | "channelId" | "turnId">, now: Date): PlanChange {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO plan_changes (id, action, plan_id, plan, summary, before, status, channel_id, turn_id, created_at)
         VALUES ($id, $action, $planId, $plan, $summary, $before, 'pending', $channelId, $turnId, $now)`,
      )
      .run({
        id,
        action: input.action,
        planId: input.planId,
        plan: input.plan === null ? null : JSON.stringify(input.plan),
        summary: input.summary,
        before: input.before,
        channelId: input.channelId,
        turnId: input.turnId,
        now: now.toISOString(),
      });
    return this.get(id);
  }

  get(id: string): PlanChange {
    const row = this.db.query("SELECT * FROM plan_changes WHERE id = $id").get({ id }) as PlanChangeRow | null;
    if (!row) throw new NotFoundError("planner change");
    return toChange(row);
  }

  /** Changes waiting for your yes (in one channel, or anywhere), oldest first. Ones too old, or whose plan is gone, expire first. */
  pending(now: Date, channelId?: string): PlanChange[] {
    const cutoff = new Date(now.getTime() - PENDING_HOURS * 3600_000).toISOString();
    this.db
      .query("UPDATE plan_changes SET status = 'expired', reason = 'no answer for a day', resolved_at = $now WHERE status = 'pending' AND created_at < $cutoff")
      .run({ now: now.toISOString(), cutoff });
    this.db
      .query("UPDATE plan_changes SET status = 'expired', reason = 'the plan was deleted', resolved_at = $now WHERE status = 'pending' AND action != 'add' AND plan_id IS NULL")
      .run({ now: now.toISOString() });
    const rows = this.db
      .query("SELECT * FROM plan_changes WHERE status = 'pending' AND ($channelId IS NULL OR channel_id = $channelId) ORDER BY created_at, rowid")
      .all({ channelId: channelId ?? null }) as PlanChangeRow[];
    return rows.map(toChange);
  }

  /** A channel's changes, oldest first (for showing them under her messages). */
  forChannel(channelId: string, limit = 200): PlanChange[] {
    const rows = this.db
      .query("SELECT * FROM (SELECT rowid AS r, * FROM plan_changes WHERE channel_id = $channelId ORDER BY created_at DESC, rowid DESC LIMIT $limit) ORDER BY created_at, r")
      .all({ channelId, limit }) as PlanChangeRow[];
    return rows.map(toChange);
  }

  /** Changes in a channel settled since a time (for her prompt). */
  settledSince(channelId: string, since: Date): PlanChange[] {
    const rows = this.db
      .query("SELECT * FROM plan_changes WHERE channel_id = $channelId AND status != 'pending' AND resolved_at >= $since ORDER BY resolved_at, rowid")
      .all({ channelId, since: since.toISOString() }) as PlanChangeRow[];
    return rows.map(toChange);
  }

  /** Record how a change ended. */
  settle(id: string, status: Exclude<PlanChangeStatus, "pending">, reason: string, messageId: string | null, now: Date, planId?: string): PlanChange {
    this.db
      .query(
        `UPDATE plan_changes SET status = $status, reason = $reason, message_id = $messageId, resolved_at = $now,
           plan_id = COALESCE($planId, plan_id) WHERE id = $id`,
      )
      .run({ id, status, reason, messageId, now: now.toISOString(), planId: planId ?? null });
    return this.get(id);
  }

  /** A turn that's replaced (Regenerate) takes the changes it was still waiting on with it. Returns them. */
  dropPending(turnId: string): PlanChange[] {
    const rows = this.db.query("SELECT * FROM plan_changes WHERE turn_id = $turnId AND status = 'pending'").all({ turnId }) as PlanChangeRow[];
    this.db.query("DELETE FROM plan_changes WHERE turn_id = $turnId AND status = 'pending'").run({ turnId });
    return rows.map(toChange);
  }
}

// ---------------------------------------------------------------- words

/** A plan, as it would appear on its first day: "Thu, Oct 1: Appointment: Dentist, 3:00p". */
export function describePlan(plan: PlanInput | Plan): string {
  const full: Plan = { id: "", createdAt: "", updatedAt: "", ...plan };
  const t = { date: plan.startDate, startTime: plan.startTime, endDate: plan.endDate, endTime: plan.endTime };
  const facts = shiftFacts(full, t);
  const occurrence = {
    key: "",
    plan: full,
    ...t,
    shiftMinutes: facts.shiftMinutes,
    drawMinutes: facts.drawMinutes,
    busy: false,
    reminders: [],
    stay: null,
  };
  // Every change she makes is confirmed, so "(not confirmed yet)" never applies.
  return `${dayName(plan.startDate)}: ${describeOccurrence({ ...occurrence, plan: { ...full, checked: true } })}`;
}

const VERBS: Record<PlanChangeAction, string> = { add: "Add", change: "Change", remove: "Remove" };

/** "Add: Thu, Oct 1: Appointment: Dentist, 3:00p", or for a change, what it becomes. */
export function summarize(action: PlanChangeAction, plan: PlanInput | Plan): string {
  return `${VERBS[action]}: ${describePlan(plan)}`;
}

// ----------------------------------------------------------------- doing

/** Make the change in the planner. Returns the plan it added or changed (null for a removal). */
export function applyChange(store: Store, change: PlanChange): Plan | null {
  if (change.action === "add") return store.plans.create({ ...change.plan!, checked: true, source: "chat" });
  if (!change.planId) throw new NotFoundError("plan");
  if (change.action === "change") return store.plans.update(change.planId, { ...change.plan! });
  store.plans.delete(change.planId);
  return null;
}

/**
 * Settle a change: your yes makes it (or fails, if the planner changed
 * underneath it), your no drops it. Tells the app either way.
 */
export function settleChange(
  deps: { store: Store; events?: Events },
  change: PlanChange,
  answer: "yes" | "no",
  reason: string,
  messageId: string | null,
  now: Date,
): PlanChange {
  const { store, events } = deps;
  let settled: PlanChange;
  if (answer === "no") {
    settled = store.planChanges.settle(change.id, "declined", reason, messageId, now);
  } else {
    try {
      const plan = applyChange(store, change);
      settled = store.planChanges.settle(change.id, "applied", reason, messageId, now, plan?.id);
      events?.publish({ type: "plans" });
    } catch (error) {
      if (!(error instanceof ValidationError || error instanceof NotFoundError)) throw error;
      settled = store.planChanges.settle(change.id, "failed", `${reason}, but it couldn't be done: ${error.message}`, messageId, now);
    }
  }
  events?.publish({ type: "plan-change", change: settled });
  return settled;
}

/**
 * Should she? Jev reads the recent chat: did they ask for this change, or
 * clearly say yes to it? Only a confident yes counts; unsure, Jev off or
 * failing all mean "ask them first".
 */
export async function askedFor(
  deps: { store: Store; decider?: Decider },
  channelId: string,
  summary: string,
  before: string | null,
): Promise<{ yes: boolean; reason: string }> {
  const { store, decider } = deps;
  if (!decider?.enabled()) return { yes: false, reason: "Jev is off" };
  const settings = store.getSettings();
  const recent = store.recentMessages(channelId, CONTEXT_MESSAGES);
  const state = [
    `The chat between them and ${settings.name}, oldest first:\n${recent.map((m) => chatLine(m, settings.name)).join("\n")}`,
    `${settings.name} wants to change their planner:\n${summary}${before ? `\n(Now it's: ${before})` : ""}`,
  ].join("\n\n");
  try {
    const answers = await decider.ask(
      state,
      [
        {
          id: "asked",
          kind: "yesno",
          question: `Did they ask ${settings.name} to make exactly this change to their planner, or clearly say yes to it? Not if it's only her idea, or they haven't answered.`,
        },
      ],
      { purpose: "Planner: did they ask for this?" },
    );
    const answer = answers.get("asked");
    const yes = tier(answer, settings.decisionConfidence) === "yes";
    return { yes, reason: `${yes ? "they asked for it" : "not sure they asked for it"} (${percent(probabilityOf(answer, "yes"))} sure)` };
  } catch {
    return { yes: false, reason: "Jev couldn't be reached" };
  }
}

// ---------------------------------------------------------------- prompt

/** The changes waiting in a channel, and the ones settled in the last few hours, for her prompt. `null` if none. */
export function planChangesForPrompt(store: Store, channelId: string, now: Date): string | null {
  const waiting = store.planChanges.pending(now, channelId);
  const settled = store.planChanges.settledSince(channelId, new Date(now.getTime() - RECENT_HOURS * 3600_000));
  if (waiting.length === 0 && settled.length === 0) return null;
  const done: Record<Exclude<PlanChangeStatus, "pending">, string> = {
    applied: "done",
    declined: "not done: they said no",
    expired: "dropped",
    failed: "couldn't be done",
  };
  return [
    waiting.length ? `Waiting for their yes (ask, if you haven't):\n${waiting.map((c) => `- ${c.summary}`).join("\n")}` : "",
    settled.length ? `Recently:\n${settled.map((c) => `- ${c.summary}: ${done[c.status as Exclude<PlanChangeStatus, "pending">]} (${c.reason})`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
