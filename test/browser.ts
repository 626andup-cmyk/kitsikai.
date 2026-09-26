/**
 * Helpers for browser tests: the real app in a real (headless) Chromium,
 * talking to the real server, which talks to a fake nanoGPT.
 *
 * These tests need a Chromium browser. They look for one in
 * `$CHROME_PATH`, or where Playwright keeps its browsers
 * (`$PLAYWRIGHT_BROWSERS_PATH`). If there isn't one (for example on the
 * phone), the browser tests are skipped, and everything else still runs.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { createApp, type App, type AppOptions } from "../src/server.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

/** Where a Chromium browser is, or null if there's none. */
export function findChromium(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(root)) return null;
  for (const folder of readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
    const path = join(root, folder, "chrome-linux", "chrome");
    if (existsSync(path)) return path;
  }
  return null;
}

export const CHROMIUM = findChromium();

/** A running app with a browser page open on it. */
export interface BrowserApp {
  app: App;
  fake: FakeNanoGpt;
  page: Page;
  url: string;
  /** JavaScript errors the page hit. A passing test expects none. */
  errors: string[];
  close: () => Promise<void>;
}

let browser: Browser | null = null;

/** Start the app on a free port and open it in a new browser page. */
export async function openApp(options: AppOptions = {}, viewport = { width: 1100, height: 800 }): Promise<BrowserApp> {
  const { chromium } = await import("playwright-core");
  // The extra flags stop Chromium phoning home (updates, first-run checks) during tests.
  browser ??= await chromium.launch({
    executablePath: CHROMIUM!,
    args: ["--no-sandbox", "--no-first-run", "--disable-background-networking", "--disable-component-update"],
  });
  const fake = startFakeNanoGpt();
  const dir = tempDir();
  const app = createApp(testConfig(dir.path, fake.baseUrl), options);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 0 });
  const url = `http://127.0.0.1:${server.port}/`;
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(message.text());
  });
  await page.goto(url);
  return {
    app,
    fake,
    page,
    url,
    errors,
    close: async () => {
      await context.close();
      server.stop(true);
      app.store.close();
      fake.stop();
      dir.cleanup();
    },
  };
}

/** Close the shared browser (call from `afterAll`). */
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}
