/**
 * Bubbles: how one of her replies becomes several text messages.
 *
 * People don't text in paragraphs; they send a burst of short messages. So
 * the model is asked to put a `<cht>` marker between the bubbles of a reply
 * (the texting style from the owner's Lumiverse extension and Tiny RP):
 *
 *   omg wait<cht>you actually said that to him??<cht>legend
 *
 * becomes three bubbles: "omg wait", "you actually said that to him??",
 * "legend". The same marker goes between bubbles in the conversation the
 * model reads (see `toChatHistory` in src/prompt.ts), so it keeps mirroring
 * the format.
 *
 * Models aren't perfectly tidy, so the splitter forgives: `<CHT>`,
 * `< cht >`, `</cht>` and `<cht/>` all count as markers, and so does a
 * marker on its own line.
 */

/** The marker, as written in prompts. */
export const BUBBLE_MARKER = "<cht>";

/** Every way of writing the marker that counts. */
const MARKER = /<\s*\/?\s*cht\s*\/?\s*>/gi;

/**
 * Split a reply into bubbles.
 *
 * A reply with no markers is one bubble. Empty pieces (a marker at the very
 * start or end, or two markers in a row) are ignored.
 */
export function splitBubbles(text: string): string[] {
  return text
    .split(MARKER)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
}

/** The opposite: bubbles joined with the marker, for the prompt. */
export function joinBubbles(bubbles: string[]): string {
  return bubbles.join(` ${BUBBLE_MARKER} `);
}
