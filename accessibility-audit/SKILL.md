---
name: accessibility-audit
description: Checks a website's color contrast against WCAG AA and AAA (text, text on photos and gradients, placeholders, form field edges, icon buttons, links told apart only by color) in light and dark mode at desktop and phone width, lists very small text, gives each issue a priority and a passing color, and scores the site as a percentage for AA and AAA. Then offers to fix it. Use it whenever the user asks for an accessibility audit, a11y check, WCAG or contrast check, "is my text readable", "does it pass AA", "audyt dostępności", "sprawdź kontrast", or before launching a site.
---

# Accessibility audit

Renders every page in the browser and measures the colors people actually see. Writes a report page, then fixes what the user approves.

## Step 1 - Find the site

- A URL the user gives, or their dev server (`npm run dev`, then its URL). Start it if it isn't running.
- A folder of plain HTML: pass the folder, the script serves it.

## Step 2 - Run it

`<skill-dir>` is the folder this file is in. Needs Node 20+ and Chrome or Edge on the computer.

First time only, if `<skill-dir>/scripts/node_modules` doesn't exist:

```bash
npm install --prefix <skill-dir>/scripts
```

Then:

```bash
node <skill-dir>/scripts/a11y_audit.mjs --url http://localhost:3000 --out site-reports
node <skill-dir>/scripts/a11y_audit.mjs --root ./site --out site-reports
```

Options: `--pages /,/about` checks only those, `--max 20` caps how many pages it finds by following links, `--light` skips dark mode.
It takes one to three minutes. It prints a short summary as JSON.

## Step 3 - Show the result

1. Open the report for the user: `open site-reports/accessibility.html` (Windows: `start`, Linux: `xdg-open`).
2. Read `site-reports/accessibility.json`. Each issue has `priority` (high, medium, low), `title`, `ratio`, `need`, `level`, `fix` and `elements` (with `selector` and `source`: the CSS rule that sets the color).
3. Reply in the user's language, short:

```
AA: 86% · AAA: 61%

Fix first
- Footer links: grey on black, 2.6:1 (needs 4.5:1). 14 places.
- ...

Fix next: 3 · Only fails AAA: 5 · Very small text: 2

Fix the "fix first" ones now? I'd use the nearest shade that passes, so the look barely changes.
```

What the levels mean, if they ask: AA is the usual legal and industry bar. AAA is stricter and optional. A site meets a level only when every check passes; the percentage shows how close it is.

## Step 4 - Fix what they approve

Ask once which colors to use: the **nearest passing shade** (`fix.color`, keeps the look) or **a color from their palette** (`fix.palette`, a token they already have). Default to the nearest shade.

- Change the color where `source` says it's set (`source.file`, `source.selector`, inside `source.media` if given). In app projects `source.file` is built CSS: find the real rule by its selector, or the Tailwind class.
- **Shared tokens**: if the color comes from a token used elsewhere, check where else it's used. Changing the token is cleanest, but it changes every use: say so and ask. Otherwise override it only where it fails.
- **Dark mode** issues (`elements[].scheme: "dark"`): edit the dark theme's values, not the light ones.
- **Faded text** (`fix.opacity`): the text is see-through because of `opacity` on it or a box around it (`elements[].opacitySource` is that rule; Tailwind `opacity-50`). Changing the color alone keeps the fade and can make it worse. Raise the opacity to `fix.opacity.needed`%, or remove it and use `fix.color` when given.
- **Text on a picture** (`needsInput: true`): ask which they prefer: a dark gradient behind the text, a solid shade, or moving the text off the picture.
- **No color reaches it** (`needsInput: true`, no `fix.color`): only a different background helps. Ask.
- **Links in text with no underline**: add `text-decoration: underline` (and a small `text-underline-offset`) to links inside paragraphs. No need to ask.
- **Form field edges**: set the border to `fix.color`.
- **Small text**: no rule forbids it, so only change it if they ask.
- Change only colors (and underlines). Don't touch layout or copy.

## Step 5 - Check again

Run the audit again and give the new AA and AAA numbers and anything still failing.

## Notes

- Reports go to `site-reports/`. Suggest adding it to `.gitignore`.
- Dark mode: it checks dark mode when the site follows the system setting. If the site switches dark mode with a class (a theme toggle), only light is checked; the JSON says so in `darkMode`. Tell the user.
- Hidden, collapsed and decorative content (`inert`, `aria-hidden`) is skipped. Text that fades in on scroll is measured after scrolling to it.
- It checks colors and text size. It does not replace testing with a keyboard and a screen reader; say so if they ask whether the site is "accessible".
- Text on photos is measured from the pixels under the text. Moving pictures (video, WebGL) are measured as they were at that moment.
