# Food

Meal-prep calendar for Parke. Sibling app to ChoreCal.

## Stack
- Node.js + Express
- SQLite (`better-sqlite3`, WAL mode, foreign keys, prepared statements)
- Vanilla HTML/CSS/JS — no framework, no build step
- Resend for email
- Fly.io (Chicago region, persistent volume at `/data`)
- GitHub Actions cron for the morning digest

## Design system
Illuminated manuscript × kawaii. See `/Users/emmetpenney/Chorezoi/CHORECAL-DESIGN-SYSTEM.md` — tokens are copied into `public/styles.css`. Do not invent new colors, fonts, or radii without updating the design system doc.

## Data model
- **recipes** — templates. `slot_categories` JSON, `tried` bool.
- **recipe_ingredients** — structured `{name, quantity, unit}` rows. `unit` must be in the canonical list in `utils.js`.
- **planned_meals** — instances. `(date, slot, eater)` triple. Exactly one of `recipe_id` or `free_text` is set (DB check constraint). `free_text` supports "leftovers" and "eating out."
- **menus / menu_slots** — bi-weekly 14-day templates. Materialize onto the calendar; not live-linked.
- **shopping_lists / shopping_list_items** — persisted list history; merged ingredients from selected recipes.

## Eaters
Three fixed: `parke`, `emmet`, `shared`. No plans to add more.

## Slots
Three fixed: `breakfast`, `lunch`, `dinner`.

## Conventions
- Asset cache-bust: `?v=N` on every script/stylesheet tag. Increment on any change.
- Server date computation uses `Intl.DateTimeFormat` with `DIGEST_TZ`. Never `toISOString().slice(0,10)`.
- Prepared statements for all DB access. Transactions for multi-row writes.
- One git commit at end of each phase.
- Run Inquisitor + Simplify after each phase.

## Phase tracker
- [x] Phase 0 — Foundation
- [x] Phase 1 — Recipe cards
- [x] Phase 2 — Calendar + meal planning (+ cooking session model)
- [x] Phase 3 — Morning email digest
- [ ] Phase 4 — Shopping list generator
- [ ] Phase 5 — Bi-weekly menu scheduler
- [ ] Phase 6 — Photo→recipe Claude Code skill
- [ ] Phase 7 — Polish + deploy

## Deployment
- Fly.io app: `parkes-food`
- GitHub repo: `nuclearbarbarian/food-calendar` (public)
- Resend key: `food-prod` (separate from ChoreCal's and Shippingport's keys)
- HTTP Basic Auth guards the production URL. Credentials in Fly secrets
  (`BASIC_AUTH_USER`, `BASIC_AUTH_PASS`). Local dev runs without auth when
  these env vars are absent. `/api/health` is exempt so Fly health checks work.
