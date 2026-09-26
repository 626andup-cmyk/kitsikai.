/**
 * The tool log (stage 6): every tool call she makes, with the arguments
 * exactly as the model wrote them and what was sent back.
 *
 * The app shows each turn's actions under its messages ("⚙ Kitsikai looked
 * up plans for Oct 1–7"), and the whole log per channel for
 * troubleshooting, since tool support varies so much between models.
 *
 * Copied from Aettica's activity.ts (its tool log part; Kitsikai has no
 * comments or proposals).
 */

import type { Database } from "bun:sqlite";
import type { ToolCallRecord } from "./types.ts";

interface ToolCallRow {
  id: string;
  channel_id: string;
  turn_id: string;
  round: number;
  name: string;
  arguments: string;
  result: string;
  status: "ok" | "error";
  summary: string;
  source: "native" | "text";
  profile: string | null;
  created_at: string;
}

/** Rows may carry extra columns (like `seq`); only the known ones are kept. */
function toToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    turnId: row.turn_id,
    round: row.round,
    name: row.name,
    arguments: row.arguments,
    result: row.result,
    status: row.status,
    summary: row.summary,
    source: row.source,
    profile: row.profile,
    createdAt: row.created_at,
  };
}

export class ToolLog {
  constructor(private readonly db: Database) {}

  add(record: Omit<ToolCallRecord, "id" | "createdAt">): ToolCallRecord {
    const full: ToolCallRecord = { ...record, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .query(
        `INSERT INTO tool_calls (id, channel_id, turn_id, round, name, arguments, result, status, summary, source, profile, created_at)
         VALUES ($id, $channelId, $turnId, $round, $name, $arguments, $result, $status, $summary, $source, $profile, $createdAt)`,
      )
      .run({ ...full });
    return full;
  }

  /** A channel's tool calls, oldest first (the newest `limit`). */
  forChannel(channelId: string, limit = 300): ToolCallRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM (SELECT *, rowid AS seq FROM tool_calls WHERE channel_id = $channelId
                         ORDER BY created_at DESC, rowid DESC LIMIT $limit)
          ORDER BY created_at, seq`,
      )
      .all({ channelId, limit }) as ToolCallRow[];
    return rows.map(toToolCall);
  }

  /** One turn's tool calls, in order. */
  forTurn(turnId: string): ToolCallRecord[] {
    const rows = this.db
      .query("SELECT * FROM tool_calls WHERE turn_id = $turnId ORDER BY created_at, rowid")
      .all({ turnId }) as ToolCallRow[];
    return rows.map(toToolCall);
  }
}
