/**
 * Phone notifications (stage 8), through Termux.
 *
 * When she texts and the app isn't open, you should still find out. Version
 * one uses **Termux:API**, the simplest route that works with the app closed
 * (DESIGN.md): the server runs a small command-line program that posts a
 * notification, titled "Kitsikai in #general" with her message as the text.
 * Tapping it runs `termux-open-url`, which opens the app at that channel.
 *
 *   termux-notification --title "Kitsikai in #general" --content "omg wait"
 *                       --action "termux-open-url 'http://127.0.0.1:3000/#/channel/…'"
 *
 * Two more pieces keep it working while the phone sleeps: the server takes
 * a **wake lock** (`termux-wake-lock`) when it starts, and you exempt Termux
 * from battery optimization (see the README).
 *
 * **When** to notify: only when the app isn't on screen. The app tells the
 * server whether it's visible (POST /api/presence) every time that changes;
 * with no app connected at all, it isn't. A notification for a message
 * you're already looking at would just be noise.
 *
 * On a computer (no Termux), there's nothing to run, so notifications are
 * quietly off: Settings says so. Web Push from the PWA is a later upgrade.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** One notification. */
export interface Notification {
  /** "Kitsikai in #general" */
  title: string;
  /** Her message. */
  text: string;
  /** The channel to open when it's tapped. */
  channelId: string;
}

/** Something that can post notifications. Tests use a fake one. */
export interface Notifier {
  /** Whether notifications can be posted on this device. */
  available(): boolean;
  notify(notification: Notification): void;
}

/** The longest notification text, in characters. */
const MAX_TEXT = 500;

/** Where Termux keeps its commands. */
const TERMUX_BIN = "/data/data/com.termux/files/usr/bin";

/**
 * Where a command is, or `null` if it isn't installed. If Bun runs inside a
 * Linux environment (`proot-distro`), Termux's own commands aren't on the
 * PATH there, so Termux's folder is checked too.
 */
function find(command: string): string | null {
  const path = `${TERMUX_BIN}/${command}`;
  return Bun.which(command) ?? (existsSync(path) ? path : null);
}

/** Run a command without waiting for it, logging (not throwing) if it fails. */
function run(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", (error) => console.warn(`[notify] ${command} failed: ${error.message}`));
    child.unref();
  } catch (error) {
    console.warn(`[notify] ${command} failed: ${(error as Error).message}`);
  }
}

/** Notifications through Termux:API's `termux-notification`. */
export class TermuxNotifier implements Notifier {
  /** @param appUrl  Where the app is, like http://127.0.0.1:3000, for tapping a notification. */
  constructor(private readonly appUrl: string) {}

  available(): boolean {
    return find("termux-notification") !== null;
  }

  notify({ title, text, channelId }: Notification): void {
    const command = find("termux-notification");
    if (!command) return;
    const url = `${this.appUrl}/#/channel/${encodeURIComponent(channelId)}`;
    run(command, [
      "--title",
      title,
      "--content",
      text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
      // One notification per channel: a newer message replaces the older one.
      "--id",
      `kitsikai-${channelId}`,
      "--group",
      "kitsikai",
      // The URL is ours (a channel id is letters, digits and dashes), so
      // quoting it is enough to keep the shell from reading it as anything else.
      "--action",
      `termux-open-url '${url}'`,
    ]);
  }
}

/** Keep the phone from putting the server to sleep, if Termux can. */
export function keepAwake(): void {
  const command = find("termux-wake-lock");
  if (command) run(command, []);
}

/**
 * Whether the app is on screen. The app reports it (POST /api/presence);
 * `connected` is how many apps are listening to the events stream.
 */
export class Presence {
  private visible = false;

  set(visible: boolean): void {
    this.visible = visible;
  }

  /** Whether someone's looking at the app right now. */
  isVisible(connected: number): boolean {
    return connected > 0 && this.visible;
  }
}
