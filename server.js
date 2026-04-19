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
} = require('./utils');

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
      r.id, r.title, r.slot_categories, r.tried, r.source,
      r.photo_path, r.steps, r.notes, r.active, r.created_at, r.updated_at,
      (SELECT COUNT(*) FROM recipe_ingredients WHERE recipe_id = r.id) AS ingredient_count
    FROM recipes r
    WHERE (@include_inactive = 1 OR r.active = 1)
    ORDER BY r.title COLLATE NOCASE
  `),
  getRecipe: db.prepare(`
    SELECT id, title, slot_categories, tried, source, photo_path, steps, notes,
           active, created_at, updated_at
    FROM recipes
    WHERE id = ?
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
  let slots = [];
  try {
    slots = JSON.parse(recipe.slot_categories || '[]');
    if (!Array.isArray(slots)) slots = [];
  } catch (_) {
    slots = [];
  }
  return {
    ...recipe,
    slot_categories: slots,
    tried: recipe.tried === 1,
    active: recipe.active === 1,
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
  const rows = stmts.listRecipes.all({ include_inactive });
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
      slot_categories: JSON.stringify(clean.slots),
      tried: clean.tried,
      source: clean.source,
      steps: clean.steps,
      notes: clean.notes,
    });
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
      slot_categories: JSON.stringify(clean.slots),
      tried: clean.tried,
      source: clean.source,
      steps: clean.steps,
      notes: clean.notes,
    });
    if (result.changes === 0) return false;
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

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`Food server listening on http://localhost:${PORT}`);
});
