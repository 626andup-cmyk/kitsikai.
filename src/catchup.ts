/**
 * Catching up on an imported chat.
 *
 * Importing a chat (src/importer.ts) puts its messages in a channel, but she
 * only sees the newest ones each turn. A **catch-up** is her reading the
 * whole thing back, once, and writing down what's still worth knowing.
 *
 * The chat is read in parts, oldest first. For each part, the processing
 * writer gets the notes so far and the next part, and returns the updated
 * list: things are added, and dropped once they're settled, so what's left
 * at the end is what matters *now*, at most 10 notes. Those go on her
 * scratchpad like anything she notices, and processing decides what to keep
 * (src/processing.ts): the same pencil-before-pen as everything else.
 *
 * It runs in the background after importing, and can take a minute for a
 * long chat. It's opt-in: it sends the whole chat to the notes model.
 */

import { dateOf } from "./dates.ts";
import type { Message, MemoryLogEntry } from "./types.ts";
import { formatClock } from "./prompt.ts";
import type { MemoryDeps } from "./scratchpad.ts";
import { updateCatchUp } from "./writer.ts";

/** How much chat goes in one part, in characters. */
export const PART_CHARS = 12_000;
/** The most notes a catch-up writes. */
export const MAX_NOTES = 10;

/** How far along a catch-up is, for the advanced page. */
export interface CatchUpStatus {
  running: boolean;
  channelId: string | null;
  partsDone: number;
  parts: number;
}

/** "[Jun 26, 2026, 9:14 PM] them: hey": dates with the year, since the chat spans months. */
function line(message: Message, name: string): string {
  const date = new Date(message.createdAt);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `[${day}, ${formatClock(date)}] ${message.author === "user" ? "them" : name}: ${message.content.replace(/\s+/g, " ").trim()}`;
}

/** Split a chat into parts of about `PART_CHARS`, never splitting a message. */
export function partsOf(lines: string[], size = PART_CHARS): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const text of lines) {
    if (current.length && length + text.length > size) {
      parts.push(current.join("\n"));
      current = [];
      length = 0;
    }
    current.push(text);
    length += text.length + 1;
  }
  if (current.length) parts.push(current.join("\n"));
  return parts;
}

export class CatchUp {
  private progress: CatchUpStatus = { running: false, channelId: null, partsDone: 0, parts: 0 };
  private job: Promise<MemoryLogEntry[]> | null = null;

  constructor(private readonly deps: MemoryDeps) {}

  status(): CatchUpStatus {
    return { ...this.progress };
  }

  /** Start catching up on a channel, in the background. */
  start(channelId: string): void {
    if (this.job) throw new Error("She's already catching up on a chat. Wait for that to finish.");
    this.job = this.run(channelId).finally(() => {
      this.job = null;
    });
    this.job.catch(() => {}); // failures are logged in `run`
  }

  /** Wait for a catch-up in progress (for tests). */
  async settle(): Promise<void> {
    await this.job?.catch(() => {});
  }

  /** Read a channel's whole chat back and note what's still worth knowing. */
  async run(channelId: string): Promise<MemoryLogEntry[]> {
    const { store, api, events, clock } = this.deps;
    const settings = store.getSettings();
    const lines = store.getMessages(channelId).map((m) => line(m, settings.name));
    const parts = partsOf(lines);
    this.progress = { running: true, channelId, partsDone: 0, parts: parts.length };
    events?.publish({ type: "memory" });
    const logged: MemoryLogEntry[] = [];
    try {
      const profile = store.profiles.pick(settings.writerAssignment, false);
      let notes: string[] = [];
      for (const part of parts) {
        notes = await updateCatchUp(api, profile, notes, part, MAX_NOTES);
        this.progress.partsDone++;
        events?.publish({ type: "memory" });
      }
      const now = clock();
      const since = store.getMessages(channelId)[0]?.createdAt;
      const reason = `from catching up on the imported chat${since ? ` (since ${dateOf(new Date(since))})` : ""}`;
      for (const text of notes) {
        const note = store.memory.addNote({ kind: "remember", text, origin: "noticed", channelId }, now);
        logged.push(store.memory.log({ runId: null, action: "noted", text, reason, noteId: note.id }, now));
      }
      console.log(`[catch-up] read ${lines.length} messages in ${parts.length} part(s), wrote ${notes.length} note(s)`);
    } catch (error) {
      // The error, never the chat: messages don't go in the log.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[catch-up] stopped: ${reason}`);
      logged.push(store.memory.log({ runId: null, action: "error", text: "Catching up on the imported chat stopped", reason }, clock()));
    } finally {
      this.progress.running = false;
      events?.publish({ type: "memory" });
    }
    return logged;
  }
}
