'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const { openDb } = require('./db');
const { EATERS, SLOTS, UNITS, UNIT_LABELS } = require('./utils');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || './food.db';

const db = openDb(DB_PATH);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health probe — used by Fly.io and for local sanity checks.
app.get('/api/health', (req, res) => {
  const recipeCount = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  res.json({
    ok: true,
    recipes: recipeCount,
    eaters: EATERS,
    slots: SLOTS,
  });
});

// Config endpoint for the frontend — enums the UI needs to render dropdowns.
app.get('/api/config', (req, res) => {
  res.json({
    eaters: EATERS,
    slots: SLOTS,
    units: UNITS,
    unit_labels: UNIT_LABELS,
  });
});

app.listen(PORT, () => {
  console.log(`Food server listening on http://localhost:${PORT}`);
});
