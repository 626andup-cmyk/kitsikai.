/**
 * The safeword hold: saved, so it lasts.
 *
 * When you say the safeword, everything halts, and she holds there "until
 * you bring me back" (the persona's words). That has to survive more than
 * one turn, a restart, and every channel: it's one row in the database, not
 * something worked out again each time. See src/intimacy.ts for when it
 * starts and ends.
 */

import type { Database } from "bun:sqlite";

/** The hold, while it's on. */
export interface Hold {
  /** When you said the safeword. */
  since: string;
  /** The message you said it in (if it still exists). */
  messageId: string | null;
}

export class IntimacyHold {
  constructor(private readonly db: Database) {}

  /** The hold, or `null` if there isn't one. */
  get(): Hold | null {
    const row = this.db.query("SELECT since, message_id FROM intimacy_hold WHERE id = 1").get() as { since: string; message_id: string | null } | null;
    return row ? { since: row.since, messageId: row.message_id } : null;
  }

  /** Start the hold (or keep the one there is: it started with the first safeword). */
  start(now: Date, messageId: string | null): Hold {
    this.db
      .query("INSERT INTO intimacy_hold (id, since, message_id) VALUES (1, $since, $messageId) ON CONFLICT (id) DO NOTHING")
      .run({ since: now.toISOString(), messageId });
    return this.get()!;
  }

  /** End the hold: you brought her back. */
  lift(): void {
    this.db.query("DELETE FROM intimacy_hold WHERE id = 1").run();
  }
}
