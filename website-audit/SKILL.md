---
name: website-audit
description: A full pre-launch check of a website - links that go nowhere, to a homepage instead of a profile (github.com, x.com) or to missing pages, the 404 page, missing or useless alt text, favicon, privacy policy and terms pages, cookie banner when there's tracking, page titles, descriptions and share images, typos, layouts that scroll sideways, cut off text or hide the navigation at 375, 768, 1024 and 1440px, stretched images, script errors and missing files. Gives a prioritised report, splits it into what Claude can fix alone and what needs the user, then fixes it. Use it whenever the user asks for a website audit, site check, QA, launch checklist, "is my site ready", "check everything before launch", "audyt strony", "sprawdź stronę przed publikacją", or "what's broken on my site".
---

# Website audit

Opens every page at four screen widths and checks what usually gets missed before launch. Writes a report page, then fixes what it can and asks about the rest.

## Step 1 - Find the site

- A URL the user gives, or their dev server (start it if it isn't running).
- A folder of plain HTML: pass the folder. The script serves it the way static hosts do (a `404.html` is used for missing pages).

## Step 2 - Run it

`<skill-dir>` is the folder this file is in. Needs Node 20+ and Chrome or Edge.

First time only, if `<skill-dir>/scripts/node_modules` doesn't exist: `npm install --prefix <skill-dir>/scripts`

```bash
node <skill-dir>/scripts/site_audit.mjs --url http://localhost:3000 --out site-reports
node <skill-dir>/scripts/site_audit.mjs --root ./site --out site-reports
```

Options: `--pages /,/about`, `--max 20`, `--no-external` (skip checking outside links). Takes one to three minutes.

## Step 3 - Proofread

The script only catches repeated words ("the the"). You do the rest:

1. Read `site-reports/site-text.md`: the words on each page.
2. Find real typos and spelling mistakes in the page's language. Skip brand names, product names, code and deliberate style. Don't flag grammar or tone, only clear mistakes.
3. Write them to `site-reports/typos.json`, including the repeated words the script found (they're in the Spelling issue in `website-audit.json`, if any):
   `[{ "page": "/", "wrong": "privatly", "right": "privately", "context": "...a few words around it..." }]`
   (write `[]` if there are none)
4. Add them to the report: `node <skill-dir>/scripts/site_audit.mjs --report-only --typos site-reports/typos.json --out site-reports`

## Step 4 - Show the result

1. Open `site-reports/website-audit.html` for the user (`open`, `start` or `xdg-open`).
2. Read `site-reports/website-audit.json`. Each issue has `priority`, `who` (`me`: you can fix it, `you`: you need their input), `title`, `detail`, `ask` (the question to put to them) and `items` (pages, selectors, links).
3. Reply in the user's language, short, in two lists:

```
14 issues, 6 to fix first.

I can fix these now
- No designed 404 page
- 4 images without alt text (I'll write it from the images, you check it)
- Page scrolls sideways on phones (the logo row)
- ...

I need from you
- GitHub and X links go to the homepage. Send the profile links.
- Terms of use: the link leads nowhere. Do you have the text?
- Analytics runs without a cookie banner. Add a banner, or drop the tracking?

Start with mine?
```

## Step 5 - Fix

Do the "me" issues once they say go. For each:

- **404 page**: make one in the site's own style (its header, footer, fonts and colors), short text and a link home. Static sites: `404.html`. Next.js: `app/not-found.tsx` (App Router) or `pages/404.tsx` (Pages Router). Others: the framework's way.
- **Missing alt text**: look at each image (open the file), write a short, specific description. Decorative images get `alt=""`. Show the user the list.
- **Useless alt text** ("image", file names): same.
- **Sideways scrolling**: find what forces the width (a fixed `width` or `min-width`, a long word, a wide table or code block, a flex row that doesn't wrap) and make it fit: `max-width: 100%`, wrapping, or scrolling inside its own box.
- **Text cut off**: let it wrap (`white-space: nowrap` and `overflow: hidden` are the usual cause) or make it smaller at that width.
- **Navigation that disappears**: add a menu button for small screens (a real `<button>` with `aria-expanded`) that shows the links.
- **Stretched images**: `object-fit: cover`, or fix the width/height.
- **Missing descriptions, titles, language, share card tags**: write them from the page's content. Reuse the home page's share image for pages without one.
- **Script errors, missing files**: find the cause and fix it.
- **Typos**: fix them in the source.
- **Anchors to nowhere**: point them at the right section or remove them.
- **Links used as buttons** (`href="#"` that runs a script): make them `<button type="button">` with the same look, keeping the script working.

Then ask the "you" questions one by one (`ask`), and fix each once answered. Don't invent profile URLs, legal text or a cookie setup. For privacy policy and terms, offer to draft them and say a lawyer should check.

## Step 6 - Check again

Run the audit again (with `--no-external` if outside links were fine) and say what's left.

## Notes

- Reports go to `site-reports/`. Suggest adding it to `.gitignore`.
- Outside sites sometimes block automated checks (LinkedIn, Instagram). Those are listed as "couldn't open", not as broken.
- Hidden, collapsed and decorative content (closed menus and accordions, `inert`, `aria-hidden` mockups) is skipped.
- Cookie rules: the check records tracker requests while each page loads, before anyone clicks anything. With a banner, trackers that load anyway are reported as "Tracking starts before people agree". Whether a banner is legally required depends on the country and the tools; say it's a flag, not legal advice.
