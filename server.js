'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const { openDb } = require('./db');
const {
  EATERS,
  SLOTS,
  UNITS,
  UNIT_LABELS,
  isSlot,
  isUnit,
  formatDate,
} = require('./utils');
const {
  buildDigestHtml,
  buildDigestText,
  sendDigest,
  buildSubject,
  countMeals,
  formatFriendlyDate,
  sendShoppingList,
} = require('./email');

const DIGEST_TZ = process.env.DIGEST_TZ || 'America/Chicago';

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || './food.db';

const db = openDb(DB_PATH);

const app = express();

// HTTP Basic Auth. Enabled when BASIC_AUTH_USER and BASIC_AUTH_PASS are set
// (production via Fly secrets). No-op in local dev when env vars are absent,
// so `npm start` just works. /api/health is always exempt so Fly's health
// check can reach it without credentials.
function basicAuth(req, res, next) {
  if (req.path === '/api/health') return next();
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next();
  const header = req.headers.authorization || '';
  const match = header.match(/^Basic (.+)$/);
  if (match) {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx !== -1 && decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Food"');
  res.status(401).send('Authentication required');
}

app.use(basicAuth);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Prepared statements ──────────────────────────────────────────────────

const stmts = {
  listRecipes: db.prepare(`
    SELECT
      r.id, r.title, r.tried, r.source,
      r.photo_path, r.steps, r.notes, r.active, r.created_at, r.updated_at,
      (SELECT GROUP_CONCAT(slot, ',') FROM recipe_slots WHERE recipe_id = r.id) AS slots_csv,
      (SELECT COUNT(*) FROM recipe_ingredients WHERE recipe_id = r.id) AS ingredient_count
    FROM recipes r
    WHERE (@include_inactive = 1 OR r.active = 1)
      AND (
        @slot_filter = ''
        OR EXISTS (SELECT 1 FROM recipe_slots s WHERE s.recipe_id = r.id AND s.slot = @slot_filter)
      )
    ORDER BY r.title COLLATE NOCASE
  `),
  getRecipe: db.prepare(`
    SELECT
      r.id, r.title, r.tried, r.source, r.photo_path, r.steps, r.notes,
      r.active, r.created_at, r.updated_at,
      (SELECT GROUP_CONCAT(slot, ',') FROM recipe_slots WHERE recipe_id = r.id) AS slots_csv
    FROM recipes r
    WHERE r.id = ?
  `),
  getIngredients: db.prepare(`
    SELECT id, name, quantity, unit, sort_order
    FROM recipe_ingredients
    WHERE recipe_id = ?
    ORDER BY sort_order, id
  `),
  insertRecipe: db.prepare(`
    INSERT INTO recipes (title, slot_categories, tried, source, steps, notes, updated_at)
    VALUES (@title, @slot_categories, @tried, @source, @steps, @notes, datetime('now'))
  `),
  updateRecipe: db.prepare(`
    UPDATE recipes
    SET title = @title,
        slot_categories = @slot_categories,
        tried = @tried,
        source = @source,
        steps = @steps,
        notes = @notes,
        updated_at = datetime('now')
    WHERE id = @id
  `),
  deleteRecipeSlots: db.prepare(`DELETE FROM recipe_slots WHERE recipe_id = ?`),
  insertRecipeSlot: db.prepare(`INSERT OR IGNORE INTO recipe_slots (recipe_id, slot) VALUES (?, ?)`),
  deleteIngredients: db.prepare(`DELETE FROM recipe_ingredients WHERE recipe_id = ?`),
  insertIngredient: db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit, sort_order)
    VALUES (@recipe_id, @name, @quantity, @unit, @sort_order)
  `),
  setTried: db.prepare(
    `UPDATE recipes SET tried = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  setActive: db.prepare(
    `UPDATE recipes SET active = ?, updated_at = datetime('now') WHERE id = ?`
  ),

  // Planned meals
  listPlannedMealsInRange: db.prepare(`
    SELECT
      p.id, p.date, p.slot, p.eater, p.recipe_id, p.free_text,
      p.status, p.notes, p.cooking_session_id, p.created_at,
      r.title AS recipe_title, r.source AS recipe_source, r.steps AS recipe_steps
    FROM planned_meals p
    LEFT JOIN recipes r ON r.id = p.recipe_id
    WHERE p.date >= @start AND p.date <= @end
    ORDER BY p.date, p.slot, p.eater
  `),
  getPlannedMeal: db.prepare(`
    SELECT
      p.id, p.date, p.slot, p.eater, p.recipe_id, p.free_text,
      p.status, p.notes, p.cooking_session_id, p.created_at,
      r.title AS recipe_title
    FROM planned_meals p
    LEFT JOIN recipes r ON r.id = p.recipe_id
    WHERE p.id = ?
  `),
  insertPlannedMeal: db.prepare(`
    INSERT INTO planned_meals (date, slot, eater, recipe_id, free_text, status, notes, cooking_session_id)
    VALUES (@date, @slot, @eater, @recipe_id, @free_text, @status, @notes, @cooking_session_id)
  `),
  updatePlannedMeal: db.prepare(`
    UPDATE planned_meals
    SET date = COALESCE(@date, date),
        slot = COALESCE(@slot, slot),
        eater = COALESCE(@eater, eater),
        recipe_id = CASE WHEN @clear_recipe = 1 THEN NULL ELSE COALESCE(@recipe_id, recipe_id) END,
        free_text = CASE WHEN @clear_free_text = 1 THEN NULL ELSE COALESCE(@free_text, free_text) END,
        status = COALESCE(@status, status),
        notes = CASE WHEN @notes_provided = 1 THEN @notes ELSE notes END
    WHERE id = @id
  `),
  deletePlannedMeal: db.prepare(`DELETE FROM planned_meals WHERE id = ?`),

  // Cooking sessions
  insertCookingSession: db.prepare(`
    INSERT INTO cooking_sessions (cook_date, cook_slot, recipe_id, free_text, notes)
    VALUES (@cook_date, @cook_slot, @recipe_id, @free_text, @notes)
  `),
  getCookingSession: db.prepare(`
    SELECT id, cook_date, cook_slot, recipe_id, free_text, notes, created_at
    FROM cooking_sessions WHERE id = ?
  `),
  unlinkSessionMeals: db.prepare(`
    UPDATE planned_meals SET cooking_session_id = NULL WHERE cooking_session_id = ?
  `),
  deleteCookingSession: db.prepare(`DELETE FROM cooking_sessions WHERE id = ?`),

  // Digest dedupe
  getDigestSent: db.prepare(`SELECT date, sent_at, resend_id FROM digests_sent WHERE date = ?`),
  recordDigestSent: db.prepare(`
    INSERT OR REPLACE INTO digests_sent (date, sent_at, resend_id)
    VALUES (?, datetime('now'), ?)
  `),

  // Shopping lists
  listShoppingLists: db.prepare(`
    SELECT
      l.id, l.name, l.created_at, l.emailed_at,
      (SELECT COUNT(*) FROM shopping_list_items WHERE list_id = l.id) AS item_count,
      (SELECT COUNT(*) FROM shopping_list_items WHERE list_id = l.id AND checked = 1) AS checked_count
    FROM shopping_lists l
    ORDER BY l.created_at DESC
  `),
  getShoppingList: db.prepare(`
    SELECT id, name, created_at, emailed_at FROM shopping_lists WHERE id = ?
  `),
  getShoppingListItems: db.prepare(`
    SELECT id, list_id, name, quantity, unit, recipe_ids, checked, sort_order
    FROM shopping_list_items
    WHERE list_id = ?
    ORDER BY name COLLATE NOCASE, unit
  `),
  insertShoppingList: db.prepare(`
    INSERT INTO shopping_lists (name) VALUES (@name)
  `),
  renameShoppingList: db.prepare(`
    UPDATE shopping_lists SET name = @name WHERE id = @id
  `),
  deleteShoppingList: db.prepare(`DELETE FROM shopping_lists WHERE id = ?`),
  deleteShoppingListItems: db.prepare(`DELETE FROM shopping_list_items WHERE list_id = ?`),
  insertShoppingListItem: db.prepare(`
    INSERT INTO shopping_list_items (list_id, name, quantity, unit, recipe_ids, checked, sort_order)
    VALUES (@list_id, @name, @quantity, @unit, @recipe_ids, @checked, @sort_order)
  `),
  setItemChecked: db.prepare(`
    UPDATE shopping_list_items SET checked = ? WHERE id = ? AND list_id = ?
  `),
  removeCheckedItems: db.prepare(`
    DELETE FROM shopping_list_items WHERE list_id = ? AND checked = 1
  `),
  recordShoppingListEmailed: db.prepare(`
    UPDATE shopping_lists SET emailed_at = datetime('now') WHERE id = ?
  `),

  // Helpers for aggregation
  getRecipeTitle: db.prepare(`SELECT title FROM recipes WHERE id = ?`),
  getRecipeIngredientsByIds: null,  // constructed per query, see aggregateIngredientsFromRecipes
};

function toBool01(v) {
  return v === 1 || v === true ? 1 : 0;
}

function parseRecipeId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ── Validation ────────────────────────────────────────────────────────────

const MAX_STEPS_LENGTH = 20000;
const MAX_NOTES_LENGTH = 10000;
const MAX_INGREDIENTS = 100;
const MAX_QUANTITY = 1_000_000;

function validateRecipeBody(body) {
  const errors = [];
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) errors.push('title is required');
  if (title.length > 200) errors.push('title must be 200 characters or fewer');

  const slots = Array.isArray(body.slot_categories) ? body.slot_categories : [];
  if (slots.length === 0) errors.push('at least one slot_category is required');
  for (const s of slots) {
    if (!isSlot(s)) errors.push(`invalid slot: ${s}`);
  }

  const tried = toBool01(body.tried);
  const source = body.source == null ? null : String(body.source).slice(0, 500);
  const steps = body.steps == null ? null : String(body.steps).slice(0, MAX_STEPS_LENGTH);
  const notes = body.notes == null ? null : String(body.notes).slice(0, MAX_NOTES_LENGTH);

  const rawIngredients = Array.isArray(body.ingredients) ? body.ingredients : [];
  if (rawIngredients.length > MAX_INGREDIENTS) {
    errors.push(`too many ingredients (max ${MAX_INGREDIENTS})`);
  }
  const cleanIngredients = [];
  rawIngredients.slice(0, MAX_INGREDIENTS).forEach((ing, i) => {
    if (!ing || typeof ing !== 'object') {
      errors.push(`ingredient ${i}: must be an object`);
      return;
    }
    const name = typeof ing.name === 'string' ? ing.name.trim().slice(0, 200) : '';
    if (!name) {
      errors.push(`ingredient ${i}: name is required`);
      return;
    }
    let quantity = null;
    if (ing.quantity != null && ing.quantity !== '') {
      // Reject non-numeric types before coercion — Number(true)===1, Number([5])===5.
      if (typeof ing.quantity !== 'number' && typeof ing.quantity !== 'string') {
        errors.push(`ingredient ${i}: quantity must be a number or numeric string`);
        return;
      }
      const q = Number(ing.quantity);
      if (!Number.isFinite(q) || q < 0 || q > MAX_QUANTITY) {
        errors.push(`ingredient ${i}: quantity out of range`);
        return;
      }
      quantity = q;
    }
    const unit = ing.unit == null || ing.unit === '' ? null : String(ing.unit);
    if (!isUnit(unit)) {
      errors.push(`ingredient ${i}: invalid unit "${unit}"`);
      return;
    }
    cleanIngredients.push({ name, quantity, unit });
  });

  const dedupedSlots = Array.from(new Set(slots));

  return {
    errors,
    clean: {
      title,
      slots: dedupedSlots,
      tried,
      source,
      steps,
      notes,
      ingredients: cleanIngredients,
    },
  };
}

function hydrate(recipe) {
  const slots = recipe.slots_csv ? recipe.slots_csv.split(',').filter(Boolean) : [];
  const { slots_csv, ...rest } = recipe;
  return {
    ...rest,
    slot_categories: slots,
    tried: recipe.tried === 1,
    active: recipe.active === 1,
  };
}

function hydrateMeal(row) {
  return {
    ...row,
    status: row.status || 'planned',
  };
}

// ── Endpoints ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const active = db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE active = 1').get().n;
  const total = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  res.json({ ok: true, recipes: { active, total }, eaters: EATERS, slots: SLOTS });
});

app.get('/api/config', (req, res) => {
  res.json({ eaters: EATERS, slots: SLOTS, units: UNITS, unit_labels: UNIT_LABELS });
});

app.get('/api/recipes', (req, res) => {
  const include_inactive = req.query.include_inactive === '1' ? 1 : 0;
  const slotParam = typeof req.query.slot === 'string' ? req.query.slot : '';
  if (slotParam && !isSlot(slotParam)) {
    return res.status(400).json({ error: `invalid slot: ${slotParam}` });
  }
  const rows = stmts.listRecipes.all({ include_inactive, slot_filter: slotParam });
  res.json(rows.map(hydrate));
});

app.get('/api/recipes/:id', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const recipe = stmts.getRecipe.get(id);
  if (!recipe) return res.status(404).json({ error: 'recipe not found' });
  const ingredients = stmts.getIngredients.all(id);
  res.json({ ...hydrate(recipe), ingredients });
});

app.post('/api/recipes', (req, res) => {
  const { errors, clean } = validateRecipeBody(req.body || {});
  if (errors.length) return res.status(400).json({ errors });

  const create = db.transaction(() => {
    const { lastInsertRowid } = stmts.insertRecipe.run({
      title: clean.title,
      slot_categories: JSON.stringify(clean.slots), // legacy column, kept dual-written for one phase
      tried: clean.tried,
      source: clean.source,
      steps: clean.steps,
      notes: clean.notes,
    });
    for (const slot of clean.slots) stmts.insertRecipeSlot.run(lastInsertRowid, slot);
    clean.ingredients.forEach((ing, i) => {
      stmts.insertIngredient.run({
        recipe_id: lastInsertRowid,
        name: ing.name,
        quantity: ing.quantity,
        unit: ing.unit,
        sort_order: i,
      });
    });
    return lastInsertRowid;
  });

  const id = create();
  const recipe = stmts.getRecipe.get(id);
  const ingredients = stmts.getIngredients.all(id);
  res.status(201).json({ ...hydrate(recipe), ingredients });
});

app.put('/api/recipes/:id', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });

  const { errors, clean } = validateRecipeBody(req.body || {});
  if (errors.length) return res.status(400).json({ errors });

  const update = db.transaction(() => {
    const result = stmts.updateRecipe.run({
      id,
      title: clean.title,
      slot_categories: JSON.stringify(clean.slots), // legacy column, kept dual-written for one phase
      tried: clean.tried,
      source: clean.source,
      steps: clean.steps,
      notes: clean.notes,
    });
    if (result.changes === 0) return false;
    stmts.deleteRecipeSlots.run(id);
    for (const slot of clean.slots) stmts.insertRecipeSlot.run(id, slot);
    stmts.deleteIngredients.run(id);
    clean.ingredients.forEach((ing, i) => {
      stmts.insertIngredient.run({
        recipe_id: id,
        name: ing.name,
        quantity: ing.quantity,
        unit: ing.unit,
        sort_order: i,
      });
    });
    return true;
  });

  if (!update()) return res.status(404).json({ error: 'recipe not found' });
  const recipe = stmts.getRecipe.get(id);
  const ingredients = stmts.getIngredients.all(id);
  res.json({ ...hydrate(recipe), ingredients });
});

app.patch('/api/recipes/:id/tried', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const tried = toBool01(req.body && req.body.tried);
  const result = stmts.setTried.run(tried, id);
  if (result.changes === 0) return res.status(404).json({ error: 'recipe not found' });
  res.json({ id, tried: tried === 1 });
});

app.patch('/api/recipes/:id/active', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const active = toBool01(req.body && req.body.active);
  const result = stmts.setActive.run(active, id);
  if (result.changes === 0) return res.status(404).json({ error: 'recipe not found' });
  res.json({ id, active: active === 1 });
});

// ── Planned meals ─────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EATERS_SET = new Set(EATERS);
const SLOTS_SET = new Set(SLOTS);

function validateMealBody(body, { forCreate }) {
  const errors = [];
  const clean = {};

  if (forCreate || body.date !== undefined) {
    if (typeof body.date !== 'string' || !DATE_RE.test(body.date)) {
      errors.push('date must be YYYY-MM-DD');
    } else {
      clean.date = body.date;
    }
  }
  if (forCreate || body.slot !== undefined) {
    if (!SLOTS_SET.has(body.slot)) errors.push(`invalid slot: ${body.slot}`);
    else clean.slot = body.slot;
  }
  if (forCreate || body.eater !== undefined) {
    if (!EATERS_SET.has(body.eater)) errors.push(`invalid eater: ${body.eater}`);
    else clean.eater = body.eater;
  }

  // Exactly one of recipe_id / free_text must be set for a new meal.
  // For updates, we allow clearing one by setting the other.
  const hasRecipe = body.recipe_id != null && body.recipe_id !== '';
  const hasFreeText = typeof body.free_text === 'string' && body.free_text.trim().length > 0;

  if (forCreate) {
    if (hasRecipe === hasFreeText) {
      errors.push('set exactly one of recipe_id or free_text');
    } else if (hasRecipe) {
      const rid = Number(body.recipe_id);
      if (!Number.isInteger(rid) || rid <= 0) errors.push('invalid recipe_id');
      else clean.recipe_id = rid;
      clean.free_text = null;
    } else {
      clean.free_text = body.free_text.trim().slice(0, 200);
      clean.recipe_id = null;
    }
  } else {
    if (hasRecipe) {
      const rid = Number(body.recipe_id);
      if (!Number.isInteger(rid) || rid <= 0) errors.push('invalid recipe_id');
      else {
        clean.recipe_id = rid;
        clean.clear_free_text = 1;
      }
    }
    if (hasFreeText) {
      clean.free_text = body.free_text.trim().slice(0, 200);
      clean.clear_recipe = 1;
    }
  }

  if (body.status !== undefined) {
    if (body.status !== 'planned' && body.status !== 'eaten') {
      errors.push(`invalid status: ${body.status}`);
    } else {
      clean.status = body.status;
    }
  } else if (forCreate) {
    clean.status = 'planned';
  }

  if (body.notes !== undefined) {
    clean.notes = body.notes == null ? null : String(body.notes).slice(0, 1000);
    clean.notes_provided = 1;
  } else if (forCreate) {
    clean.notes = null;
    clean.notes_provided = 1;
  }

  return { errors, clean };
}

app.get('/api/planned-meals', (req, res) => {
  const start = typeof req.query.start === 'string' ? req.query.start : '';
  const end = typeof req.query.end === 'string' ? req.query.end : '';
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return res.status(400).json({ error: 'start and end must be YYYY-MM-DD' });
  }
  if (start > end) return res.status(400).json({ error: 'start must be <= end' });
  const rows = stmts.listPlannedMealsInRange.all({ start, end });
  res.json(rows.map(hydrateMeal));
});

function isUniqueCollision(err) {
  return err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || /UNIQUE constraint/i.test(String(err.message)));
}

app.post('/api/planned-meals', (req, res) => {
  const { errors, clean } = validateMealBody(req.body || {}, { forCreate: true });
  if (errors.length) return res.status(400).json({ errors });
  try {
    const result = stmts.insertPlannedMeal.run({
      date: clean.date,
      slot: clean.slot,
      eater: clean.eater,
      recipe_id: clean.recipe_id,
      free_text: clean.free_text,
      status: clean.status,
      notes: clean.notes,
      cooking_session_id: null,
    });
    const row = stmts.getPlannedMeal.get(result.lastInsertRowid);
    res.status(201).json(hydrateMeal(row));
  } catch (err) {
    if (isUniqueCollision(err)) {
      return res.status(409).json({ error: 'A meal already exists for that date, slot, and eater.' });
    }
    throw err;
  }
});

app.patch('/api/planned-meals/:id', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const { errors, clean } = validateMealBody(req.body || {}, { forCreate: false });
  if (errors.length) return res.status(400).json({ errors });
  const params = {
    id,
    date: clean.date ?? null,
    slot: clean.slot ?? null,
    eater: clean.eater ?? null,
    recipe_id: clean.recipe_id ?? null,
    free_text: clean.free_text ?? null,
    status: clean.status ?? null,
    notes: clean.notes ?? null,
    notes_provided: clean.notes_provided ?? 0,
    clear_recipe: clean.clear_recipe ?? 0,
    clear_free_text: clean.clear_free_text ?? 0,
  };
  try {
    const result = stmts.updatePlannedMeal.run(params);
    if (result.changes === 0) return res.status(404).json({ error: 'meal not found' });
  } catch (err) {
    if (isUniqueCollision(err)) {
      return res.status(409).json({ error: 'A meal already exists for that date, slot, and eater.' });
    }
    throw err;
  }
  const row = stmts.getPlannedMeal.get(id);
  res.json(hydrateMeal(row));
});

app.delete('/api/planned-meals/:id', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const result = stmts.deletePlannedMeal.run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'meal not found' });
  res.status(204).end();
});

// ── Cooking sessions ──────────────────────────────────────────────────────
// One cook event feeds N planned meals. Delete-with-unlink: the meals stay,
// but lose their cooking_session_id so they're independent planned meals.

app.post('/api/cooking-sessions', (req, res) => {
  const body = req.body || {};
  const errors = [];

  if (typeof body.cook_date !== 'string' || !DATE_RE.test(body.cook_date)) {
    errors.push('cook_date must be YYYY-MM-DD');
  }
  if (!SLOTS_SET.has(body.cook_slot)) {
    errors.push(`invalid cook_slot: ${body.cook_slot}`);
  }

  const hasRecipe = body.recipe_id != null && body.recipe_id !== '';
  const hasFreeText = typeof body.free_text === 'string' && body.free_text.trim().length > 0;
  if (hasRecipe === hasFreeText) {
    errors.push('set exactly one of recipe_id or free_text');
  }
  let recipe_id = null;
  let free_text = null;
  if (hasRecipe) {
    const rid = Number(body.recipe_id);
    if (!Number.isInteger(rid) || rid <= 0) errors.push('invalid recipe_id');
    else recipe_id = rid;
  } else if (hasFreeText) {
    free_text = body.free_text.trim().slice(0, 200);
  }

  const serves = Array.isArray(body.serves) ? body.serves : [];
  if (serves.length === 0) errors.push('serves must have at least one meal');
  if (serves.length > 30) errors.push('serves too many (max 30)');
  const cleanServes = [];
  serves.forEach((s, i) => {
    if (!s || typeof s !== 'object') { errors.push(`serves[${i}]: invalid`); return; }
    if (typeof s.date !== 'string' || !DATE_RE.test(s.date)) { errors.push(`serves[${i}]: bad date`); return; }
    if (!SLOTS_SET.has(s.slot)) { errors.push(`serves[${i}]: bad slot`); return; }
    if (!EATERS_SET.has(s.eater)) { errors.push(`serves[${i}]: bad eater`); return; }
    cleanServes.push({ date: s.date, slot: s.slot, eater: s.eater });
  });

  const notes = body.notes == null ? null : String(body.notes).slice(0, 1000);

  if (errors.length) return res.status(400).json({ errors });

  const create = db.transaction(() => {
    const sessionResult = stmts.insertCookingSession.run({
      cook_date: body.cook_date,
      cook_slot: body.cook_slot,
      recipe_id,
      free_text,
      notes,
    });
    const sessionId = sessionResult.lastInsertRowid;
    const createdMealIds = [];
    for (const s of cleanServes) {
      const r = stmts.insertPlannedMeal.run({
        date: s.date,
        slot: s.slot,
        eater: s.eater,
        recipe_id,
        free_text,
        status: 'planned',
        notes: null,
        cooking_session_id: sessionId,
      });
      createdMealIds.push(r.lastInsertRowid);
    }
    return { sessionId, createdMealIds };
  });

  try {
    const { sessionId, createdMealIds } = create();
    const session = stmts.getCookingSession.get(sessionId);
    const meals = createdMealIds.map((id) => hydrateMeal(stmts.getPlannedMeal.get(id)));
    res.status(201).json({ session, meals });
  } catch (err) {
    if (isUniqueCollision(err)) {
      return res.status(409).json({
        error: 'One of the serves rows conflicts with an existing meal. Remove it or clear the existing meal first.',
      });
    }
    throw err;
  }
});

app.delete('/api/cooking-sessions/:id', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const existing = stmts.getCookingSession.get(id);
  if (!existing) return res.status(404).json({ error: 'session not found' });
  const run = db.transaction(() => {
    stmts.unlinkSessionMeals.run(id);
    stmts.deleteCookingSession.run(id);
  });
  run();
  res.status(204).end();
});

// ── Shopping lists ────────────────────────────────────────────────────────
// Aggregate ingredients by (name trimmed+lowercased, unit). Exact-match on
// name — "onion" and "yellow onion" stay separate by design because those
// distinctions matter in cooking. Null-quantity items ("salt, to_taste")
// carry through without summing.

const MAX_LIST_NAME = 200;
const MAX_ITEM_NAME = 200;
const MAX_ITEMS_PER_LIST = 300;
const MAX_RECIPES_PER_LIST = 50;

function aggregateIngredientsFromRecipeIds(recipeIds) {
  if (!recipeIds.length) return [];
  const placeholders = recipeIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT recipe_id, name, quantity, unit
     FROM recipe_ingredients
     WHERE recipe_id IN (${placeholders})`
  ).all(...recipeIds);

  const map = new Map();
  for (const row of rows) {
    const trimmedName = row.name.trim();
    const key = `${trimmedName.toLowerCase()}|${row.unit || ''}`;
    if (map.has(key)) {
      const ex = map.get(key);
      // If both have quantities, sum them. If either is null, result is null
      // (can't sum a number with "to taste" — leave it unquantified).
      if (ex.quantity != null && row.quantity != null) {
        ex.quantity += row.quantity;
      } else {
        ex.quantity = null;
      }
      if (!ex.recipe_ids.includes(row.recipe_id)) ex.recipe_ids.push(row.recipe_id);
    } else {
      map.set(key, {
        name: trimmedName,
        quantity: row.quantity,
        unit: row.unit,
        recipe_ids: [row.recipe_id],
      });
    }
  }
  return Array.from(map.values());
}

function validateShoppingItem(raw, i) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    errors.push(`item ${i}: must be an object`);
    return { errors };
  }
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_ITEM_NAME) : '';
  if (!name) { errors.push(`item ${i}: name is required`); return { errors }; }

  let quantity = null;
  if (raw.quantity != null && raw.quantity !== '') {
    if (typeof raw.quantity !== 'number' && typeof raw.quantity !== 'string') {
      errors.push(`item ${i}: quantity must be a number or numeric string`);
      return { errors };
    }
    const q = Number(raw.quantity);
    if (!Number.isFinite(q) || q < 0 || q > 1_000_000) {
      errors.push(`item ${i}: quantity out of range`);
      return { errors };
    }
    quantity = q;
  }
  const unit = raw.unit == null || raw.unit === '' ? null : String(raw.unit);
  if (!isUnit(unit)) { errors.push(`item ${i}: invalid unit "${unit}"`); return { errors }; }

  const recipeIds = Array.isArray(raw.recipe_ids) ? raw.recipe_ids.filter((x) => Number.isInteger(x) && x > 0) : [];
  const checked = raw.checked === 1 || raw.checked === true ? 1 : 0;

  return { errors: [], clean: { name, quantity, unit, recipe_ids: recipeIds, checked } };
}

function hydrateShoppingListItem(row) {
  let recipe_ids = [];
  try { recipe_ids = JSON.parse(row.recipe_ids || '[]'); if (!Array.isArray(recipe_ids)) recipe_ids = []; }
  catch (_) { recipe_ids = []; }
  return {
    ...row,
    recipe_ids,
    checked: row.checked === 1,
  };
}

function defaultListName() {
  const date = formatDate(new Date(), DIGEST_TZ);
  const [y, m, d] = date.split('-').map(Number);
  const friendly = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
  return `Shopping list — ${friendly}`;
}

app.get('/api/shopping-lists', (req, res) => {
  const rows = stmts.listShoppingLists.all();
  res.json(rows);
});

app.get('/api/shopping-lists/:id', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const list = stmts.getShoppingList.get(id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  const items = stmts.getShoppingListItems.all(id).map(hydrateShoppingListItem);
  res.json({ ...list, items });
});

app.post('/api/shopping-lists', (req, res) => {
  const body = req.body || {};
  const name = (typeof body.name === 'string' && body.name.trim())
    ? body.name.trim().slice(0, MAX_LIST_NAME)
    : defaultListName();

  const recipeIds = Array.isArray(body.recipe_ids)
    ? body.recipe_ids.filter((x) => Number.isInteger(x) && x > 0).slice(0, MAX_RECIPES_PER_LIST)
    : [];

  // If items provided, use them verbatim (after validation). Otherwise,
  // aggregate from recipe_ids.
  let cleanItems = [];
  if (Array.isArray(body.items)) {
    if (body.items.length > MAX_ITEMS_PER_LIST) {
      return res.status(400).json({ errors: [`too many items (max ${MAX_ITEMS_PER_LIST})`] });
    }
    const allErrors = [];
    body.items.forEach((raw, i) => {
      const v = validateShoppingItem(raw, i);
      if (v.errors.length) allErrors.push(...v.errors);
      else cleanItems.push(v.clean);
    });
    if (allErrors.length) return res.status(400).json({ errors: allErrors });
  } else {
    cleanItems = aggregateIngredientsFromRecipeIds(recipeIds).map((item) => ({
      ...item,
      checked: 0,
    }));
  }

  const create = db.transaction(() => {
    const { lastInsertRowid } = stmts.insertShoppingList.run({ name });
    cleanItems.forEach((item, i) => {
      stmts.insertShoppingListItem.run({
        list_id: lastInsertRowid,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        recipe_ids: JSON.stringify(item.recipe_ids || []),
        checked: item.checked,
        sort_order: i,
      });
    });
    return lastInsertRowid;
  });

  const id = create();
  const list = stmts.getShoppingList.get(id);
  const items = stmts.getShoppingListItems.all(id).map(hydrateShoppingListItem);
  res.status(201).json({ ...list, items });
});

app.patch('/api/shopping-lists/:id', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const body = req.body || {};
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  const result = stmts.renameShoppingList.run({
    id,
    name: body.name.trim().slice(0, MAX_LIST_NAME),
  });
  if (result.changes === 0) return res.status(404).json({ error: 'list not found' });
  const list = stmts.getShoppingList.get(id);
  res.json(list);
});

app.put('/api/shopping-lists/:id/items', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const list = stmts.getShoppingList.get(id);
  if (!list) return res.status(404).json({ error: 'list not found' });

  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (items.length > MAX_ITEMS_PER_LIST) {
    return res.status(400).json({ errors: [`too many items (max ${MAX_ITEMS_PER_LIST})`] });
  }

  const allErrors = [];
  const cleanItems = [];
  items.forEach((raw, i) => {
    const v = validateShoppingItem(raw, i);
    if (v.errors.length) allErrors.push(...v.errors);
    else cleanItems.push(v.clean);
  });
  if (allErrors.length) return res.status(400).json({ errors: allErrors });

  const replace = db.transaction(() => {
    stmts.deleteShoppingListItems.run(id);
    cleanItems.forEach((item, i) => {
      stmts.insertShoppingListItem.run({
        list_id: id,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        recipe_ids: JSON.stringify(item.recipe_ids || []),
        checked: item.checked,
        sort_order: i,
      });
    });
  });
  replace();
  const out = stmts.getShoppingListItems.all(id).map(hydrateShoppingListItem);
  res.json({ id, items: out });
});

app.patch('/api/shopping-lists/:id/items/:itemId', (req, res) => {
  const listId = parseRecipeId(req.params.id);
  const itemId = parseRecipeId(req.params.itemId);
  if (listId == null || itemId == null) return res.status(400).json({ error: 'invalid id' });
  const checked = toBool01(req.body && req.body.checked);
  const result = stmts.setItemChecked.run(checked, itemId, listId);
  if (result.changes === 0) return res.status(404).json({ error: 'item not found' });
  res.json({ id: itemId, list_id: listId, checked: checked === 1 });
});

app.post('/api/shopping-lists/:id/remove-checked', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const list = stmts.getShoppingList.get(id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  const result = stmts.removeCheckedItems.run(id);
  res.json({ id, removed: result.changes });
});

app.delete('/api/shopping-lists/:id', (req, res) => {
  const id = parseRecipeId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const result = stmts.deleteShoppingList.run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'list not found' });
  res.status(204).end();
});

app.post('/api/shopping-lists/:id/email', async (req, res, next) => {
  try {
    const id = parseRecipeId(req.params.id);
    if (id == null) return res.status(400).json({ error: 'invalid id' });
    const list = stmts.getShoppingList.get(id);
    if (!list) return res.status(404).json({ error: 'list not found' });
    const items = stmts.getShoppingListItems.all(id).map(hydrateShoppingListItem);

    const { RESEND_API_KEY, DIGEST_FROM, DIGEST_TO } = process.env;
    const result = await sendShoppingList({
      list,
      items,
      from: DIGEST_FROM,
      to: DIGEST_TO,
      apiKey: RESEND_API_KEY,
    });
    stmts.recordShoppingListEmailed.run(id);
    const updated = stmts.getShoppingList.get(id);
    res.json({ ok: true, resend_id: result.resendId, list: updated });
  } catch (err) {
    next(err);
  }
});

// ── Morning digest ────────────────────────────────────────────────────────
// Cron (GitHub Actions) POSTs here daily. Dedupe per date so the two workflow
// triggers (one for CST, one for CDT) are naturally idempotent across DST.
// preview=1 returns the HTML without sending (for eyeballing). force=1 resends
// even if the date already sent. Otherwise a second send on the same date is
// a no-op returning {skipped: true}.

app.post('/api/send-digest', async (req, res, next) => {
  try {
    const preview = req.query.preview === '1';
    const force = req.query.force === '1';
    const date = formatDate(new Date(), DIGEST_TZ);

    if (!preview && !force) {
      const existing = stmts.getDigestSent.get(date);
      if (existing) {
        return res.json({
          ok: true,
          skipped: true,
          reason: 'already sent today',
          date,
          sent_at: existing.sent_at,
          resend_id: existing.resend_id,
        });
      }
    }

    const meals = stmts.listPlannedMealsInRange.all({ start: date, end: date }).map(hydrateMeal);

    if (preview) {
      const html = buildDigestHtml({ date, meals });
      const text = buildDigestText({ date, meals });
      const subject = buildSubject(formatFriendlyDate(date), countMeals(meals));
      return res.type('html').send(html
        + `<!-- PREVIEW: subject=${subject.replace(/-->/g, '—')} -->`
        + `<!-- PLAIN TEXT:\n${text.replace(/-->/g, '—')}\n-->`);
    }

    const { RESEND_API_KEY, DIGEST_FROM, DIGEST_TO } = process.env;
    const result = await sendDigest({
      date,
      meals,
      from: DIGEST_FROM,
      to: DIGEST_TO,
      apiKey: RESEND_API_KEY,
    });

    stmts.recordDigestSent.run(date, result.resendId || null);

    res.json({
      ok: true,
      skipped: false,
      date,
      subject: result.subject,
      meal_count: meals.length,
      resend_id: result.resendId,
      forced: force,
    });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: String(err && err.message || err) });
});

app.listen(PORT, () => {
  console.log(`Food server listening on http://localhost:${PORT}`);
});
