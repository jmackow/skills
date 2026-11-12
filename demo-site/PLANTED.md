# Brightwork: a demo site with planted problems

A made-up freelance jobs site for trying the skills. The brand, companies and people are invented. Run Claude Code in
this folder and ask for any skill, for example "audit the website" or "turn on tweak mode".

The font is Instrument Sans (SIL Open Font License, `fonts/OFL.txt`).

## What is planted

### Accessibility audit
- White on orange: primary buttons, the "Find your next project" button, the orange band (3.4:1).
- Orange text on light orange: "View job", "I'm hiring", the eyebrow tags, step numbers (about 2.8-3.2:1).
- Light grey text: "Posted ..." dates, hero note, footer headings (`--fg-tertiary` #978E87).
- Placeholders #C2BBB6 on white (1.9:1).
- Form field edges: `--border-secondary` on white.
- Very small text: footer note and form note at 11px.
- Green "Most popular" badge on light green.

### Design cleanup
- Primary buttons in four versions: `.btn-primary` (12/20, 8px), `.hero .cta` (13/22, 10px), `.send` and `.choose` (12/20, 9px).
- Near-identical oranges: #FF4405, #FF4507 (hero button), #FE4406 ("View job"). Greys #716A65 and #726B66.
- Card corners 12, 14 (`.job`) and 16px (`.benefit`, `.form-card`).
- Almost the same 20px titles: `.card-title`, `.job-title` (-0.01em), `.plan-name` (27px line), `.benefit-title`.
- Off-grid spacing: 13px row gap in `.job`, 22px and 6px.
- Tokens: `#261C14` typed out instead of `var(--fg-primary)`; unused `--unused-accent`, `--unused-gap`.

### Website audit
- Footer links: Instagram and X go to the homepage; LinkedIn too.
- Missing pages: `/blog`, `login.html`, `signup.html`, `jobs/*.html`, `privacy.html`, `terms.html`.
- No favicon, no share images, no 404 page, pricing has no description.
- Hero picture alt is "image"; Maya's avatar has no alt and is squeezed (160×160 shown at 48×36).
- Typos: "recieve", "seperate", "garantee".
- Pricing comparison table scrolls the page sideways at 375 and 768px.
- `main.js` throws on every page (`#newsletter-form` missing); pricing loads `analytics.js`, which doesn't exist.

### Tweak mode and copy edit mode
Nothing planted: they're shown changing the hero (heading size, button corners, headline text).
