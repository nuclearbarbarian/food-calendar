'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slot_categories TEXT NOT NULL DEFAULT '[]',
  tried INTEGER NOT NULL DEFAULT 0 CHECK (tried IN (0, 1)),
  source TEXT,
  photo_path TEXT,
  steps TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  eater TEXT NOT NULL CHECK (eater IN ('parke', 'emmet', 'shared')),
  recipe_id INTEGER,
  free_text TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'eaten')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (recipe_id IS NOT NULL AND free_text IS NULL)
    OR (recipe_id IS NULL AND free_text IS NOT NULL)
  ),
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_planned_meals_date ON planned_meals(date);

CREATE TABLE IF NOT EXISTS menus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS menu_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_id INTEGER NOT NULL,
  day_of_cycle INTEGER NOT NULL CHECK (day_of_cycle BETWEEN 0 AND 13),
  slot TEXT NOT NULL CHECK (slot IN ('breakfast', 'lunch', 'dinner')),
  eater TEXT NOT NULL CHECK (eater IN ('parke', 'emmet', 'shared')),
  recipe_id INTEGER,
  free_text TEXT,
  CHECK (
    (recipe_id IS NOT NULL AND free_text IS NULL)
    OR (recipe_id IS NULL AND free_text IS NOT NULL)
    OR (recipe_id IS NULL AND free_text IS NULL)
  ),
  FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_menu_slots_menu ON menu_slots(menu_id);

CREATE TABLE IF NOT EXISTS shopping_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  emailed_at TEXT
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
  return db;
}

module.exports = { openDb };
