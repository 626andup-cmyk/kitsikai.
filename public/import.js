/**
 * Importing a chat from Lumiverse or SillyTavern (src/chatImport.ts).
 *
 * Choose the exported file, and the server reads it and sends back a
 * preview: how many messages, who's who, the dates, and what was skipped.
 * Never any message text. If the file can't be read, it sends back the
 * file's layout (field names and types only), which is safe to share when
 * asking for help. Nothing is saved until you press Import.
 *
 * Uses `state`, `api`, `$` and friends from app.js.
 */

"use strict";

const chatImport = {
  /** The chosen file's text, once read. */
  text: null,
  /** Empty text channels, where it can go besides a new one. */
  targets: [],
};

/** "Jun 26, 2026" */
function importDate(iso) {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function openImportChat() {
  const form = $("import-chat-form");
  form.reset();
  chatImport.text = null;
  hideFormError(form);
  $("import-chat-preview").hidden = true;
  $("import-chat-options").hidden = true;
  $("import-chat-submit").disabled = true;
  $("import-chat-dialog").showModal();
}

/** The chosen file: read it, and ask the server for a preview. */
async function previewImportChat() {
  const form = $("import-chat-form");
  const file = $("import-chat-file").files[0];
  hideFormError(form);
  $("import-chat-submit").disabled = true;
  $("import-chat-options").hidden = true;
  const box = $("import-chat-preview");
  box.hidden = false;
  box.className = "import-chat-preview";
  if (!file) {
    box.hidden = true;
    return;
  }
  box.textContent = "Reading…";
  try {
    chatImport.text = await file.text();
    const response = await fetch("/api/import/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: chatImport.text }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showImportProblem(data.error || `Couldn't read the file (HTTP ${response.status}).`, data.layout);
      return;
    }
    showImportPreview(data.preview);
  } catch (error) {
    showImportProblem(error.message);
  }
}

/** What's in the file: counts, names and dates. */
function showImportPreview(preview) {
  const box = $("import-chat-preview");
  const who = (side, label) => `${side.messages} from ${label}${side.names.length ? ` (as ${side.names.map((n) => `"${n}"`).join(", ")})` : ""}`;
  const lines = [
    `${preview.total} messages: ${who(preview.you, "you")}, ${who(preview.her, "her")}.`,
    preview.from ? `From ${importDate(preview.from)} to ${importDate(preview.to)}.` : "",
    preview.undated ? `${preview.undated} had no date, so they get the date of the message before.` : "",
  ];
  const skipped = [];
  if (preview.skipped.system) skipped.push(`${preview.skipped.system} hidden system messages`);
  if (preview.skipped.empty) skipped.push(`${preview.skipped.empty} empty ones`);
  if (preview.skipped.unreadable) skipped.push(`${preview.skipped.unreadable} that couldn't be read`);
  if (skipped.length) lines.push(`Left out: ${skipped.join(", ")}.`);
  box.classList.add("ok");
  box.replaceChildren(...lines.filter(Boolean).map((text) => Object.assign(document.createElement("p"), { textContent: text })));

  // Where to: a new channel, or an empty one.
  const form = $("import-chat-form").elements;
  form.channelId.replaceChildren(...chatImport.targets.map((c) => new Option(`#${c.name}`, c.id)));
  $("import-chat-existing").hidden = chatImport.targets.length === 0;
  $("import-chat-options").hidden = false;
  $("import-chat-submit").disabled = false;
}

/** A file that couldn't be read: why, and its layout (safe to share). */
function showImportProblem(message, layout) {
  const box = $("import-chat-preview");
  box.classList.add("failed");
  const children = [Object.assign(document.createElement("p"), { textContent: `⚠️ ${message}` })];
  if (layout) {
    children.push(
      Object.assign(document.createElement("p"), { className: "hint", textContent: "The file's layout (field names only, no messages: safe to share when asking for help):" }),
      Object.assign(document.createElement("pre"), { textContent: layout }),
    );
  }
  box.replaceChildren(...children);
}

async function submitImportChat(event) {
  event.preventDefault();
  const form = $("import-chat-form");
  const fields = form.elements;
  const button = $("import-chat-submit");
  button.disabled = true;
  button.textContent = "Importing…";
  try {
    const target = fields.target.value === "existing" ? { channelId: fields.channelId.value } : { newChannel: fields.newChannel.value };
    const { channel, imported, catchUp } = await api("POST", "/api/import", { text: chatImport.text, ...target, catchUp: fields.catchUp.checked });
    chatImport.text = null;
    for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
    await loadState();
    await openChannel(channel.id);
    showNotice(
      `Imported ${imported} messages into #${channel.name}.` +
        (catchUp ? " She's catching up on it in the background: her notes will show up on the advanced page." : ""),
    );
  } catch (error) {
    showFormError(form, error.message);
    button.disabled = false;
  } finally {
    button.textContent = "Import";
  }
}

$("open-import-chat").addEventListener("click", async () => {
  openImportChat();
  try {
    chatImport.targets = (await api("GET", "/api/import/targets")).channels;
  } catch {
    chatImport.targets = [];
  }
});
$("import-chat-file").addEventListener("change", previewImportChat);
$("import-chat-form").addEventListener("submit", submitImportChat);
