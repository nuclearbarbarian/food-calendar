'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  tried INTEGER NOT NULL DEFAULT 0 CHECK (tried IN (0, 1)),
  source TEXT,
  photo_path TEXT,
  steps TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);

CREATE TABLE IF NOT EXISTS planned_meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('breakfast', 'lunch', 'dinner')),
  recipe_id INTEGER,
  free_text TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'eaten')),
  notes TEXT,
  cooking_session_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (recipe_id IS NOT NULL AND free_text IS NULL)
    OR (recipe_id IS NULL AND free_text IS NOT NULL)
  ),
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL,
  FOREIGN KEY (cooking_session_id) REFERENCES cooking_sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_planned_meals_date ON planned_meals(date);
-- One meal per (date, slot). Phase 8 collapsed away the eater dimension.
CREATE UNIQUE INDEX IF NOT EXISTS idx_planned_meals_pair
  ON planned_meals(date, slot);
-- idx_planned_meals_session is created in openDb() after the ALTER TABLE
-- migration adds cooking_session_id to pre-existing databases.

CREATE TABLE IF NOT EXISTS recipe_slots (
  recipe_id INTEGER NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('breakfast', 'lunch', 'dinner')),
  PRIMARY KEY (recipe_id, slot),
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recipe_slots_slot ON recipe_slots(slot);

CREATE TABLE IF NOT EXISTS cooking_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cook_date TEXT NOT NULL,
  cook_slot TEXT NOT NULL CHECK (cook_slot IN ('breakfast', 'lunch', 'dinner')),
  recipe_id INTEGER,
  free_text TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (recipe_id IS NOT NULL AND free_text IS NULL)
    OR (recipe_id IS NULL AND free_text IS NOT NULL)
  ),
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cooking_sessions_cook_date ON cooking_sessions(cook_date);

CREATE TABLE IF NOT EXISTS shopping_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  emailed_at TEXT
);

CREATE TABLE IF NOT EXISTS digests_sent (
  date TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  resend_id TEXT
);

CREATE TABLE IF NOT EXISTS shopping_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  recipe_ids TEXT NOT NULL DEFAULT '[]',
  checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (list_id) REFERENCES shopping_lists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shopping_list_items_list ON shopping_list_items(list_id);
`;

function openDb(dbPath) {
  const resolved = path.resolve(dbPath);
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Additive migrations. ALTER TABLE ADD COLUMN is the only safe operation
  // against SQLite without a full rebuild — keep these idempotent.
  try {
    db.exec(`ALTER TABLE recipes ADD COLUMN updated_at TEXT`);
  } catch (_) { /* column exists */ }
  db.exec(`UPDATE recipes SET updated_at = created_at WHERE updated_at IS NULL`);

  try {
    db.exec(`ALTER TABLE planned_meals ADD COLUMN cooking_session_id INTEGER REFERENCES cooking_sessions(id) ON DELETE SET NULL`);
  } catch (_) { /* column exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_planned_meals_session ON planned_meals(cooking_session_id)`);

  // Phase 8: drop the `eater` column from planned_meals if it still exists.
  // Where multiple rows shared the same (date, slot) — one per eater —
  // collapse to one with priority shared > parke > emmet.
  const plannedCols = db.prepare(`PRAGMA table_info(planned_meals)`).all();
  if (plannedCols.some((c) => c.name === 'eater')) {
    const collapse = db.transaction(() => {
      // Drop the old triple unique index first so dedupe deletes don't fail.
      db.exec(`DROP INDEX IF EXISTS idx_planned_meals_triple`);
      // Mark which row to keep per (date, slot) using window functions.
      db.exec(`
        DELETE FROM planned_meals WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY date, slot
              ORDER BY CASE eater
                WHEN 'shared' THEN 0
                WHEN 'parke'  THEN 1
                WHEN 'emmet'  THEN 2
                ELSE 3
              END, id
            ) AS rn
            FROM planned_meals
          ) WHERE rn > 1
        )
      `);
      try {
        db.exec(`ALTER TABLE planned_meals DROP COLUMN eater`);
      } catch (err) {
        console.warn('planned_meals.eater drop failed (SQLite < 3.35?):', err.message);
        throw err; // bubble so the transaction rolls back cleanly
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_planned_meals_pair ON planned_meals(date, slot)`);
    });
    collapse();
  }
  // menu_slots dropped before menus to satisfy the FK.
  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS menu_slots`);
    db.exec(`DROP TABLE IF EXISTS menus`);
  })();

  // One-time backfill: copy legacy recipes.slot_categories JSON into the
  // recipe_slots join table for any rows that haven't been migrated. Wrapped
  // in a column-exists check so it's a no-op on fresh databases (Phase 7+).
  const cols = db.prepare(`PRAGMA table_info(recipes)`).all();
  const hasLegacySlotCategories = cols.some((c) => c.name === 'slot_categories');
  if (hasLegacySlotCategories) {
    const backfill = db.transaction(() => {
      const rows = db.prepare(`
        SELECT r.id, r.slot_categories
        FROM recipes r
        WHERE NOT EXISTS (SELECT 1 FROM recipe_slots s WHERE s.recipe_id = r.id)
      `).all();
      const insert = db.prepare(`INSERT OR IGNORE INTO recipe_slots (recipe_id, slot) VALUES (?, ?)`);
      for (const row of rows) {
        let slots = [];
        try {
          slots = JSON.parse(row.slot_categories || '[]');
        } catch (err) {
          console.warn(`Recipe ${row.id}: malformed slot_categories JSON; recipe will have no slots after migration. Add them manually in the UI.`);
          continue;
        }
        if (!Array.isArray(slots)) {
          console.warn(`Recipe ${row.id}: slot_categories was not an array; skipping.`);
          continue;
        }
        for (const slot of slots) {
          if (slot === 'breakfast' || slot === 'lunch' || slot === 'dinner') {
            insert.run(row.id, slot);
          }
        }
      }
    });
    backfill();
    // Now retire the legacy column. Phase 5 stopped reading it; Phase 7 stops
    // writing it. SQLite ≥ 3.35 supports DROP COLUMN. Ignore if unsupported.
    try {
      db.exec(`ALTER TABLE recipes DROP COLUMN slot_categories`);
    } catch (err) {
      console.warn('Could not drop legacy slot_categories column:', err.message);
    }
  }

  return db;
}

module.exports = { openDb };
