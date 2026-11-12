---
name: design-cleanup
description: Finds design inconsistencies on a website and cleans them up - components that exist in slightly different versions (three primary buttons with different padding, cards with 12, 14 and 16px corners, two near-identical headings), colors that look the same but aren't, almost identical text styles, extra fonts, spacing off the 4px grid, and design tokens that repeat, go unused or get typed out by hand. Shows each version side by side in a report, then merges them into one. Use it whenever the user asks to clean up tokens, check design consistency, find duplicate styles or button variants, tidy the CSS or design system, "audit the design system", "sprawdź spójność", "posprzątaj style", or after a site has been through many rounds of changes.
---

# Design cleanup

Renders every page, measures what's actually used, and groups things that are nearly the same. Writes a report page, then merges what the user approves.

## Step 1 - Find the site

- A URL the user gives, or their dev server (start it if it isn't running).
- A folder of plain HTML: pass the folder.

## Step 2 - Run it

`<skill-dir>` is the folder this file is in. Needs Node 20+ and Chrome or Edge.

First time only, if `<skill-dir>/scripts/node_modules` doesn't exist: `npm install --prefix <skill-dir>/scripts`

```bash
node <skill-dir>/scripts/cleanup_audit.mjs --url http://localhost:3000 --out site-reports
node <skill-dir>/scripts/cleanup_audit.mjs --root ./site --out site-reports
```

Options: `--pages /,/about`, `--max 20`. Takes about a minute.

## Step 3 - Show the result

1. Open `site-reports/design-cleanup.html` for the user (`open`, `start` or `xdg-open`). Components are shown as pictures, side by side.
2. Read `site-reports/design-cleanup.json`. `findings` are grouped by `area`: components, colors, tokens, text, spacing, corners. Component findings have `variants`, each with `uses`, `look` (what differs), `examples` (`selector`, `classes`, `page`) and `sources` (the CSS rule behind each differing value). Token findings that are a safe swap have `edits` (file, selector, prop, from, to).
3. Reply in the user's language, short. Components first, they matter most:

```
Components
- Button: 4 versions. Differ in padding, font size, corners and fill.
- Card: 3 versions. Differ in corners.

Colors: 2 look-alike pairs · Tokens: 3 typed out by hand, 1 never used
Text: 2 near-identical styles, 1 extra font · Spacing: 5 values off the 4px grid

Start with the buttons? I'd make them all like the most used one.
```

## Step 4 - Clean up what they approve

Go one finding at a time, or all at once if they say so.

- **Component versions**: first ask whether some versions are meant to be different sizes or kinds (small, large, nav, hero). Leave those. Make the rest match the one they pick (default: the most used, `variants[0]`; uses count each element once, even if it's on every page). Two ways, ask once which they prefer:
  - **Align the values** (small change): edit each version's rule at `sources` so the differing values match.
  - **One shared class** (cleaner): give every instance the same class, move the styles there, delete the extra rules. In React, use one component or variant.
- **Look-alike colors**: replace the others with the kept one (`keep`, or its token `keepToken`).
- **Typed-out values** (`edits`): swap each literal for `var(--token)`. The value may be written as any of `writtenAs` (`#fff`, `#ffffff`, `rgb(...)`) or as a color name; find it in that rule. Only hand-written CSS is listed (not build output), and only tokens that stay the same in dark mode. Still ask once: a token is a promise about meaning (a background token used for text color may change later).
- **Duplicate or near-duplicate tokens**: keep one, point the other at it (`--b: var(--a)`) or replace its uses. Ask before deleting a token.
- **Unused tokens**: "not used on the checked pages" only. Search the whole codebase for each name (scripts, other pages, components) before suggesting removal, then ask.
- **Near-identical text styles, odd fonts**: switch to the kept style.
- **Spacing off the grid, near-identical spacing and corners**: round as suggested. These change the look slightly, so show the list first.
- Tailwind projects: change classes (or the theme config for tokens), not generated CSS.
- Change only what was approved. Don't reformat files.

## Step 5 - Check again

Run the audit again. Say what's left, and how the counts changed ("colors in use: 18 → 13").

## Notes

- Reports go to `site-reports/`. Suggest adding it to `.gitignore`.
- It looks at desktop width. Values that only exist on phones won't show up.
- "Nearly the same" is a guess. Some differences are on purpose (a bigger hero button). When the user says so, leave it.
