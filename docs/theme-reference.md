# Theme reference

This is everything a theme can change. Kitsikai's theme system is Aettica's: how themes are stored, loaded and scoped is explained in [Aettica's stage-3.5.md](https://github.com/626andup-cmyk/aettica/blob/main/docs/stage-3.5.md), and [stage-1.md](stage-1.md) says how it came over.

A theme is CSS. Most themes only need to redefine the **variables** below. Anything variables can't express, a theme can do by targeting the **classes**.

## Making a theme

1. Open **Appearance** (the palette button at the bottom of the channel list).
2. Pick the theme closest to what you want and press **Copy to edit**. Copying **Classic** gives you every variable below with its default value.
3. Change values in the editor and press **Apply** to see the result behind the editor. **Save** keeps it and closes the editor.
4. To use an image or font, add it under **Images and fonts**, then refer to it by name: `--app-background: url(sky.jpg) center / cover;`. Fonts go in an `@font-face` rule, which works in channel themes too.
5. For phones, add a **Lite version**: CSS loaded on top of the theme when glass effects are Lite. Usually it turns blur off (`--sidebar-backdrop: none;` and the other `*-backdrop` variables) and makes panels more solid.

Your theme is a folder in `data/themes/`, so you can also edit it there with any text editor.

### As a channel theme

Any theme can be a channel's own theme (channel settings → Theme). Then:

- Write the theme as usual, with `:root` and all. Kitsikai rewrites it so it only applies inside the channel: `:root`, `html` and `body` become the channel view, and rules for things outside it (like `.sidebar`) simply match nothing.
- Every variable starts from its default, not from the app theme, so the channel looks the same whatever the app theme is.
- The channel shows the theme's `--app-background`, with its `--channel-background` tint behind the messages.
- The app theme doesn't reach into a channel with its own theme, so layout changes it makes (floating panels, shapes) stay outside.

## Variables

All are defined in the `:root` block of `public/style.css`.

### Type

| Variable | What it sets |
| --- | --- |
| `--font-body` | Main font |
| `--font-heading` | Server name, channel title, dialog titles |
| `--font-mono` | Prompt preview |
| `--font-size`, `--line-height` | Base text size and spacing |

### Text and accents

| Variable | What it sets |
| --- | --- |
| `--text`, `--text-muted`, `--text-strong` | Normal, secondary, and emphasised text |
| `--em-color` | `*italic*` text |
| `--accent`, `--accent-hover`, `--accent-text` | Main highlight colour, its hover shade, text drawn on it |
| `--danger`, `--danger-text` | Delete buttons |
| `--error-bg`, `--error-text` | Error banner and form errors |
| `--update-bg` | The "Kitsikai has been updated" banner, and notices |
| `--user-color`, `--kitsikai-color` | Author name colours: yours and hers |
| `--avatar-user-bg`, `--avatar-kitsikai-bg`, `--avatar-text` | Avatar circles |

### Shape

| Variable | What it sets |
| --- | --- |
| `--radius-sm`, `--radius-md`, `--radius-lg` | Rounded corners: small (channel links, badges), medium (inputs, buttons), large (dialogs) |
| `--radius-avatar` | Avatar shape (`50%` is a circle) |

### Backgrounds and panels

Every `*-bg` can be a colour, gradient or image. Every `*-backdrop` is a [`backdrop-filter`](https://developer.mozilla.org/docs/Web/CSS/backdrop-filter), which is how glass effects blur what's behind a panel (for example `blur(16px) saturate(1.4)`). They default to `none`.

| Variable | What it sets |
| --- | --- |
| `--app-background` | Behind everything: the wallpaper |
| `--sidebar-width` | Sidebar width on large screens |
| `--sidebar-bg`, `--sidebar-border`, `--sidebar-shadow`, `--sidebar-backdrop` | The channel sidebar |
| `--drawer-bg` | The sidebar when it slides over the channel on a phone (defaults to `--sidebar-bg`). Glass themes usually make this more solid. |
| `--sidebar-footer-bg` | Her card at the bottom of the sidebar |
| `--channel-link-color`, `--channel-link-hover-bg`, `--channel-link-active-bg`, `--channel-link-active-color` | Channel links |
| `--channel-background` | Behind the open channel, on top of the wallpaper |
| `--header-bg`, `--header-border`, `--header-shadow`, `--header-backdrop` | The channel header |
| `--message-hover-bg` | A message under your finger or mouse |
| `--composer-bg`, `--composer-border`, `--composer-backdrop` | The area around the text box |
| `--dialog-bg`, `--dialog-border`, `--dialog-shadow`, `--dialog-backdrop` | Dialogs |
| `--scrim` | The dark layer behind dialogs and the phone sidebar |
| `--code-bg` | Prompt preview blocks |

### Planner

| Variable | What it sets |
| --- | --- |
| `--calendar-day-bg`, `--calendar-day-border` | A day on the calendar |
| `--calendar-outside-opacity` | Days from the months before and after |
| `--today-ring` | Today's date, the selected day, and today in the weekly list |
| `--shift-chip-bg`, `--meeting-chip-bg`, `--oncall-chip-bg`, `--shift-chip-text` | Shift chips on the calendar, by shift type |
| `--plan-chip-bg`, `--plan-chip-text` | Other plans on the calendar |
| `--card-bg`, `--card-border` | Plan cards, and days in the weekly list |
| `--calculated-text` | Values that are worked out, never typed, like draw time |

### Trackers and stickers

| Variable | What it sets |
| --- | --- |
| `--sticker-bg`, `--sticker-text` | A sticker (a log entry on a day) |
| `--sticker-yes-bg`, `--sticker-no-bg` | Yes and no stickers |
| `--highlight-bg` | A message you jumped to with "show the message" |

### Her notes (the advanced page)

| Variable | What it sets |
| --- | --- |
| `--pin-accent` | The stripe on a pin |
| `--memory-saved-color` | "Saved", "They said yes" and "Pinned" in the processing log, and a working Test Jev |
| `--memory-ask-color` | "Will ask", and the stripe on something she'll ask you |
| `--memory-tossed-color` | "Tossed", "They said no" and "Kept" |

### Controls

| Variable | What it sets |
| --- | --- |
| `--input-bg`, `--input-border`, `--input-focus-border` | Text boxes |
| `--button-bg`, `--button-hover-bg`, `--button-text`, `--button-border`, `--button-shadow` | Ordinary buttons |
| `--button-primary-bg`, `--button-primary-hover-bg`, `--button-primary-text` | Send, Save, Create |
| `--icon-button-hover-bg` | Round icon buttons (gear, +, ☰) |

## Classes

| Class | Element |
| --- | --- |
| `.app` | Everything. Gets `.sidebar-open` when the phone drawer is open. |
| `.surface` | Any panel a glass theme might blur: sidebar, channel header, composer, dialogs |
| `.sidebar`, `.sidebar-header`, `.sidebar-footer`, `.sidebar-scrim` | The sidebar and its parts |
| `.server-name` | Her name at the top of the sidebar |
| `.channel-list`, `.channel-link`, `.channel-link-name`, `.channel-icon`, `.channel-busy`, `.channel-unread` | The channel list. The open channel's link has `aria-current="page"`; each link has `data-kind`, the home channel's has `data-home="true"`, and a channel with messages you haven't seen gets `.unread` and a `.channel-unread` dot. |
| `.kitsikai-card`, `.kitsikai-card-name`, `.kitsikai-card-role` | Her card at the bottom of the sidebar |
| `.channel-view` | The open channel. Has `data-channel-id` and `data-channel-kind`. |
| `.channel-header`, `.channel-title`, `.channel-topic` | The bar at the top of the channel |
| `.messages` | The scrolling message list |
| `.message` | One bubble. Has `data-author="user"` or `"kitsikai"`. Also `.pending` while being sent, `.continued` when grouped under the bubble before it, and `.selected` when tapped. |
| `.avatar`, `.message-meta`, `.message-author`, `.message-time`, `.message-model`, `.message-content`, `.message-actions` | Parts of a message |
| `.composer`, `.composer-input`, `.composer-buttons`, `.status`, `.typing-dots`, `.stop-button`, `.error-banner` | The composer area. `.status` is the typing indicator; it gets `.revealing` while her bubbles are appearing one by one (double-tap it to skip). |
| `.update-banner` | "Kitsikai has been updated", at the top of the channel |
| `.jev-log`, `.jev-call`, `.jev-call-part` | The Jev log (Settings → Her memory → Jev log). It reuses the tool log's classes; each call also has `.jev-call` with `data-answered-by` (`jev`, `fallback` or `nobody`), and each part of it (what it was told, the request, the reply) is a `.jev-call-part`. |
| `.message-image`, `.image-seen`, `.image-seen-label` | An image you sent, and "What she sees" under it. `.image-seen` has `data-status` (`reading`, `read`, `failed`) and gets `.expanded` when tapped. |
| `.composer-attachments`, `.composer-attachment`, `.composer-attachment-remove`, `.attach-button` | Images waiting to be sent, above the text box, and the button that picks them |
| `.image-viewer` | The big view of an image (a `<dialog>`) |
| `.plan-change`, `.plan-change-summary`, `.plan-change-before`, `.plan-change-status`, `.plan-change-buttons` | A planner change she offered or made, under her reply. Has `data-status` (`pending`, `applied`, `declined`, `expired`, `failed`); while pending, it has Yes and No buttons. |
| `.hold-banner` | "Safeword heard", above the composer while the safeword hold is on |
| `.hold-status` | The safeword hold's status in Settings → Intimacy |
| `.notice-banner` | Short notices at the top of the channel, e.g. about glass effects |
| `.button`, `.button-primary`, `.button-danger`, `.icon-button`, `.link-button` | Buttons |
| `.dialog`, `.dialog-title`, `.dialog-buttons`, `.hint`, `.form-error` | Dialogs and their parts |
| `.theme-list`, `.theme-card`, `.theme-swatch`, `.theme-name`, `.theme-badge`, `.theme-description` | The theme picker in Appearance. The chosen card has `aria-checked="true"`. |
| `.theme-editor`, `.code-input`, `.theme-files` | The theme editor |
| `.profile-list`, `.profile-row`, `.profile-row-name`, `.roulette-entries`, `.roulette-entry`, `.roulette-share` | Profiles and roulettes |
| `.entry-badges`, `.entry-badge` | Small labels, like "tools" on a profile |
| `.activity`, `.activity-summary`, `.activity-details` | What her turn looked up, under its last bubble. `.activity` gets `.has-errors` if a call failed. |
| `.tool-call`, `.tool-call-head`, `.tool-call-name`, `.tool-call-summary`, `.tool-call-raw` | One tool call, in the activity details and the tool log. Has `data-status` (`ok` or `error`) and `data-source` (`native` or `text`). |
| `.tool-log`, `.tool-log-list`, `.tool-log-actions` | The tool log dialog |
| `.tool-test-row`, `.tool-test` | "Test tools" and its result, which has `data-verdict` (`native`, `text`, `none` or `broken`) |
| `.planner-view`, `.planner-toolbar`, `.planner-tabs`, `.planner-tab`, `.planner-period`, `.planner-nav`, `.planner-title` | The planner channel's screen and its toolbar. The chosen tab has `aria-selected="true"`. |
| `.calendar`, `.calendar-weekday`, `.calendar-day`, `.calendar-day-number` | The month grid. A day has `data-date`, and `.outside` (another month), `.today`, `.double-booked`, and `aria-pressed="true"` when selected. |
| `.shift-chip`, `.plan-chip` | Plans on a calendar day. A shift chip has `data-shift-type` (`regular`, `meeting`, `oncall`); a plan chip has `data-kind`. |
| `.calendar-day-panel`, `.day-panel-title`, `.day-panel-cards` | The selected day's cards, under the calendar |
| `.plan-card`, `.shift-card`, `.plan-card-head`, `.plan-card-title`, `.plan-card-time`, `.plan-card-details`, `.plan-card-reminders` | A plan's full card. Has `data-kind` (and `data-shift-type` for shifts). |
| `.draw-time` | A calculated value (draw time), shown greyed |
| `.unchecked` | A plan you haven't confirmed yet, on any chip, card or row |
| `.week-view`, `.week-list`, `.week-day`, `.week-day-title`, `.week-day-empty`, `.week-day-total`, `.week-totals` | The weekly list. A day has `data-date`, and `.today`. |
| `.shift-row`, `.shift-row-type`, `.shift-row-hours`, `.shift-row-length`, `.shift-row-draw`, `.shift-row-draw-time`, `.week-plan` | Rows in the weekly list |
| `.plan-editor`, `.reminder-choices` | The plan editor |
| `.import-dialog`, `.import-layout`, `.import-screenshot`, `.import-review`, `.import-status`, `.import-summary` | Screenshot import: the screenshot beside the review list |
| `.review-list`, `.review-row`, `.review-day`, `.review-weekday`, `.review-type`, `.review-hours`, `.review-draw`, `.review-draw-time`, `.review-remove` | The review list. A row gets `.has-warnings` or `.has-error`; `.review-draw` gets `.not-regular` for meetings and on-call. |
| `.time-pair`, `.time-pair-label` | Two time boxes ("from" and "to") with their label |
| `.review-notes`, `.review-warning`, `.review-error` | A row's ⚠️ warnings and ✗ error |
| `.trackers-view`, `.trackers-toolbar`, `.trackers-intro`, `.tracker-list`, `.trackers-empty` | The trackers channel's screen |
| `.tracker-card`, `.tracker-card-head`, `.tracker-name`, `.tracker-edit`, `.tracker-hints`, `.hint-word` | A tracker. Has `data-kind` (`yesno`, `scale`, `note`). |
| `.tracker-strip`, `.tracker-day`, `.tracker-day-label` | The two-week strip. A day has `data-date`, and `.today`. |
| `.quick-log`, `.quick-log-label`, `.quick-log-scale`, `.quick-log-note` | Logging today in one tap |
| `.log-entries`, `.log-entry`, `.log-entry-date`, `.message-link` | A tracker's latest stickers, and "show the message" |
| `.log-sticker` | A sticker. Has `data-kind`, `data-value` and `data-source` (`user`, `processing`, `confirmed`, `kitsikai`). |
| `.calendar-stickers`, `.day-panel-stickers`, `.day-stickers-title`, `.day-stickers`, `.day-sticker-add` | Stickers on calendar days: dots in the grid, and the day panel's list |
| `.message.highlighted` | A message you jumped to |
| `.shift-chip.overnight`, `.plan-card-stay`, `.shift-row-stay`, `.plan-overnight`, `.review-overnight` | Linked shifts: 🏨 on the calendar chip, the hotel-night line on a card and in the weekly list (`.unlinked` when there's no shift to link to), and the checkbox in the plan editor and review list |
| `.memory-grid`, `.jev-test-result` | Her memory settings, and what Test Jev got back (`.ok` or `.failed`) |
| `.notes-page`, `.notes-status`, `.notes-actions`, `.notes-section`, `.notes-drawer`, `.memory-list`, `.memory-empty` | The advanced page, "Kitsikai's notes" |
| `.memory-card`, `.memory-card-text`, `.memory-card-fact`, `.memory-source` | A pin or note, and its "show the message" link |
| `.pin-card` | A pin. Has `data-status` (`pinned`, `drawer`). |
| `.note-card` | A note. Has `data-kind` (`tracker`, `plan`, `remember`, `request`) and `data-status` (`open`, `asking`, `bringup`). |
| `.memory-rounds`, `.memory-round`, `.memory-round-title` | The processing log's rounds. A round has `data-trigger` (`timer`, `early`, `manual`). |
| `.memory-log`, `.memory-log-line`, `.memory-log-action`, `.memory-log-text`, `.memory-log-reason` | One line of the log. Has `data-action` (`noted`, `committed`, `tossed`, `asking`, `pinned`, `unpinned`...). |
| `.proactive-check-result` | What "Check now" found (texting first). Has `data-outcome` (`sent`, `queued`, `waiting`, `declined`, `nothing`, `error`). |
| `.proactive-line` | One texting-first check in the log. Has `data-outcome`. |
| `.reminder-due`, `.reminder-record` | A reminder that's due, and one that was dealt with (`data-status`: `sent`, `skipped`, `queued`) |
| `.import-chat`, `.import-chat-preview`, `.import-target` | Importing a chat: the dialog, its preview (`.ok` or `.failed`), and where to import |
| `.theme-layers`, `.layer-1` to `.layer-4` | Empty layers for themes to draw on (see Layers below) |
| `.channel-indicator` | A pill behind the open channel's link, hidden unless a theme shows it (see Liquid glass below). Gets `.stretching`, then `.settling`, as it moves between channels. |
| `.theme-options`, `.theme-option-group`, `.theme-option`, `.theme-option-label`, `.theme-option-value` | Sliders in Appearance |
| `.check-option`, `.check-inline`, `.section-title`, `.advanced` | Checkboxes, section headings and "advanced" details in dialogs |

## Sliders (theme options)

A theme can offer sliders in Appearance, each setting a CSS variable its CSS uses. Declare them in the theme's `theme.json`, or in the theme editor under **Sliders**:

```json
"options": [
  { "id": "bubble-transparency", "label": "Bubble transparency", "variable": "--bubble-transparency",
    "min": 0, "max": 0.95, "step": 0.05, "default": 0.55 },
  { "id": "bubble-blur", "label": "Bubble blur", "variable": "--bubble-blur",
    "min": 0, "max": 30, "step": 1, "default": 14, "unit": "px" }
]
```

- `id`: lowercase letters, digits and dashes. `variable`: the CSS variable, starting with `--`.
- `unit` (optional): `px`, `em`, `rem`, `%`, `deg`, `s` or `ms`, added after the number. Without one, the variable is a plain number, which works inside `calc()`: `rgb(0 0 0 / calc(1 - var(--bubble-transparency)))`.
- Give each variable its default in your `:root` block too, so the theme also looks right before the app applies the sliders.
- The app sets the app theme's variables on `<html>`, and a channel theme's on `.channel-view`, where they win over the theme's own values. Up to 12 sliders per theme.

**Rainy Window** is a worked example of sliders, layers (below) and parallax: its layers drift with the message list's scrolling through a scroll-driven animation (`scroll-timeline` on `.messages`, `timeline-scope` on `body`). The Liquid Glass themes and Rainy Window have sliders for their refraction (see Liquid glass below).

## Layers

For backgrounds with depth (a picture, rain, drifting fog), the page has empty elements for themes to draw on:

```html
<div class="theme-layers"><i class="layer-1"></i><i class="layer-2"></i><i class="layer-3"></i><i class="layer-4"></i></div>
```

One set is behind the whole app (a child of `<body>`), and one is in the channel view, for a channel theme. They're hidden until a theme shows them, and the channel view's only appear when the channel has its own theme. A typical start:

```css
body { position: relative; isolation: isolate; overflow: hidden; }
.theme-layers { display: block; position: absolute; inset: 0; z-index: -1; overflow: hidden; }
.theme-layers > * { position: absolute; inset: 0; }
.layer-1 { background: url(far.svg) center / cover; }
```

`isolation` keeps the layers behind the app's content but in front of the page's background. As a channel theme, `body` becomes the channel view, so the same CSS works there. Rainy Window uses all four: the city, rain falling outside, drops on the glass (each showing the city upside down, cut out with a `mask`), and drops sliding down (an animated SVG).

## Free layers for glass effects

Glass themes usually stack several layers on a panel: the blurred backdrop, a glossy highlight across the top, and a soft glow at the edges. The backdrop comes from the `*-backdrop` variables. For the other two, **elements with the `surface` class never use `::before` or `::after` in the base stylesheet**, so a theme can add them freely:

Every surface is already positioned, so these layers can use `position: absolute` without the theme touching layout. Each surface is also its own layer stack (`isolation: isolate`), so `z-index: -1` puts a layer above the panel's background but below its text and buttons:

```css
/* A glossy highlight across the top half of every glass panel. */
.surface::before {
  content: "";
  position: absolute;
  inset: 0 0 50% 0;
  background: linear-gradient(rgb(255 255 255 / 0.35), transparent);
  border-radius: inherit;
  pointer-events: none;
  z-index: -1;
}
```

## Liquid glass (real refraction)

A blur makes glass look frosted, but flat. Real glass is clear, and its thick, rounded edge works like a lens: what's behind bends as it nears the rim, and splits into a faint rainbow there. `public/glass.js` does that for a theme, in Chrome and other Chromium browsers (including on Android). **Liquid Glass**, **Liquid Glass Dark** and **Rainy Window** use it.

Turn it on in your `:root`, then mark which elements are lensed glass:

```css
:root {
  --lensing: on;
  --lens-depth: 26;        /* how far the rim bends what's behind, in px (default 24) */
  --lens-bevel: 20;        /* how wide the curved rim is at least, in px (default 18) */
  --lens-dispersion: 0.4;  /* how much the colours split at the rim, 0 to 1 (default 0.3) */
  --lens-frost: 0.5;       /* a blur behind the glass, in px (default 0: clear) */
  --lens-saturate: 1.35;   /* colour boost through the glass (default 1.2) */
}

.message, .surface, .button, .icon-button { --lens: 1; }
```

- `--lens` doesn't inherit, so only the elements you name are lensed, not everything inside them. glass.js looks at these classes: `.surface`, `.message`, `.button`, `.icon-button`, `.channel-indicator`, `.theme-card`, `.composer-input`, `.profile-row` (and a few Aettica ones Kitsikai doesn't use).
- The tuning variables can be set anywhere, so a slider can drive them: `--lens-depth: var(--refraction)`.
- A deeper lens needs a wider rim, so the rim grows with the depth (as far as the element's size allows). The very edge magnifies up to about 3.3 times.
- Keep a normal `backdrop-filter` on the same elements (e.g. `blur(10px) saturate(160%)`): it's what other browsers show, and what Lite mode shows, since Lite turns lensing off.
- Glass inside other glass (a button in the composer) isn't lensed. A panel with a backdrop filter only lets the elements in it see its own fill, not the page behind, so there'd be nothing to bend. It keeps your `backdrop-filter`.
- **A lensed element gets the class `lensed`, and must not reach outside its own box**: no outer `box-shadow` (on it, or on anything inside it) while it's lensed. Chrome versions disagree about where a backdrop filter goes when an element's shadow spills over its edges (some move it by the shadow's size, some don't), so on some phones the lens would miss the right and bottom edges. Keep your floating shadows for other browsers and Lite, and drop them under `.lensed`:

```css
.message { box-shadow: var(--glass-rim), 0 14px 34px -12px rgb(0 0 0 / 0.3); }
.lensed { box-shadow: var(--glass-rim) !important; }
```
- **Don't move your theme layers with `transform`** (not even a static one): Chrome doesn't give a lens the full picture of a transformed layer, and cuts part of it off behind the rims. For parallax, animate `background-position` instead. Both Liquid Glass themes do. Rainy Window, whose layers also need masks and several backgrounds to move together, animates registered custom properties (`@property --near { syntax: "<length>"; ... }`) and uses them in each `background-position` and `mask-position`:

```css
@keyframes drift {
  from { background-position-y: calc(50% + 5vh); }
  to { background-position-y: calc(50% - 5vh); }
}
```

- **What it costs.** The lens itself is cheap: a bubble growing as she writes only moves the pieces of its map, and nothing is recalculated while you scroll. The browser redraws the glass every frame something behind it moves, though, and two settings multiply that work: rainbow edges (`--lens-dispersion` above 0) take three passes instead of one, and frost (`--lens-frost`) adds a blur. For the smoothest glass, set rainbow edges to 0 and keep frost at 0.5px or less (a hint of blur is free, and smooths the magnified rim).

glass.js also provides two things for liquid themes, in every browser:

- **Goo** (`filter: url(#kitsikai-goo)`): shapes that touch merge like drops of water. Both Liquid Glass themes use it on `.typing-dots`.
- **The channel indicator** (`.channel-indicator`, in style.css and app.js): a pill that sits behind the open channel's link and flows to the next one when you switch, stretching over both links (`.stretching`) and then settling with a little overshoot (`.settling`). It's hidden unless a theme gives it `display: block`, a background and a `transition: transform ...`.

## Hooks for theme authors

- `.channel-view` has `data-channel-id`, `data-channel-kind` and `data-channel-theme` (the channel's own theme, or empty). An app theme can use these to style kinds of channel differently.
- Every `.surface` is positioned and isolated (see above), so `::before` and `::after` layers can use `position: absolute` and `z-index: -1` safely.
