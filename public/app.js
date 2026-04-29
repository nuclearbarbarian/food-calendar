'use strict';

(function () {
  // ── State ────────────────────────────────────────────────────────────────

  const state = {
    config: null,
    recipes: [],
    filters: {
      slots: new Set(),
      q: '',
    },
    editing: null,   // { isNew: true } | { isNew: false, id }
    detail: null,    // full recipe currently displayed in detail modal
  };

  const EMPTY_RECIPE = Object.freeze({
    title: '',
    slot_categories: [],
    source: '',
    steps: '',
    notes: '',
    ingredients: [],
  });

  // ── DOM helpers ──────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  // ── Quantity parsing ────────────────────────────────────────────────────
  // Accepts: "1/2", "1 1/2", "0.5", ".5", "1.", "2".
  function parseQuantity(raw) {
    if (raw == null) return { ok: true, value: null };
    const s = String(raw).trim();
    if (s === '') return { ok: true, value: null };
    const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    if (mixed) {
      const [, whole, num, den] = mixed;
      if (Number(den) === 0) return { ok: false };
      return { ok: true, value: Number(whole) + Number(num) / Number(den) };
    }
    const frac = s.match(/^(\d+)\/(\d+)$/);
    if (frac) {
      const [, num, den] = frac;
      if (Number(den) === 0) return { ok: false };
      return { ok: true, value: Number(num) / Number(den) };
    }
    if (/^(\d+(\.\d*)?|\.\d+)$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n) || n < 0) return { ok: false };
      return { ok: true, value: n };
    }
    return { ok: false };
  }

  // Decimal — used to populate input fields so the user can edit the value.
  function formatQuantity(q) {
    if (q == null) return '';
    const rounded = Math.round(q * 1000) / 1000;
    return String(rounded);
  }

  // Display variant — renders common cooking fractions as Unicode glyphs.
  // Use ONLY in display contexts (recipe detail, shopping list, email),
  // never to populate <input> values.
  const FRACTION_GLYPHS = {
    0.125: '⅛', 0.25: '¼', 0.375: '⅜', 0.5: '½',
    0.625: '⅝', 0.75: '¾', 0.875: '⅞',
  };

  function formatQuantityDisplay(q) {
    if (q == null) return '';
    const rounded = Math.round(q * 1000) / 1000;
    const whole = Math.floor(rounded);
    const fracPart = Math.round((rounded - whole) * 1000) / 1000;
    let glyph = FRACTION_GLYPHS[fracPart];
    if (!glyph) {
      if (Math.abs(fracPart - 0.333) < 0.005 || Math.abs(fracPart - 0.334) < 0.005) glyph = '⅓';
      else if (Math.abs(fracPart - 0.667) < 0.005 || Math.abs(fracPart - 0.666) < 0.005) glyph = '⅔';
    }
    if (glyph) return whole > 0 ? `${whole}${glyph}` : glyph;
    return String(rounded);
  }

  function slotLabel(slot) {
    return slot.charAt(0).toUpperCase() + slot.slice(1);
  }

  function formatIngredient(ing) {
    const qty = formatQuantityDisplay(ing.quantity);
    const unit = ing.unit || null;
    const unitLabel = unit ? state.config.unit_labels[unit] || unit : '';
    if (unit === 'to_taste' || unit === 'pinch' || unit === 'dash') {
      const qualifier = qty ? `${qty} ${unitLabel}` : unitLabel;
      return `${ing.name} (${qualifier})`;
    }
    if (unit === 'count') {
      return qty ? `${qty} ${ing.name}` : ing.name;
    }
    const prefix = [qty, unitLabel].filter(Boolean).join(' ');
    return prefix ? `${prefix} ${ing.name}` : ing.name;
  }

  // ── API ──────────────────────────────────────────────────────────────────

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = { error: text }; }
    }
    if (!res.ok) {
      const err = new Error(`${res.status} ${path}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const API = {
    config: () => api('GET', '/api/config'),
    listRecipes: () => api('GET', '/api/recipes'),
    getRecipe: (id) => api('GET', `/api/recipes/${id}`),
    createRecipe: (payload) => api('POST', '/api/recipes', payload),
    updateRecipe: (id, payload) => api('PUT', `/api/recipes/${id}`, payload),
    deleteRecipe: (id) => api('DELETE', `/api/recipes/${id}`),
  };

  // ── Tabs ─────────────────────────────────────────────────────────────────

  function initTabs() {
    const tabs = $$('.tab');
    const panels = {
      calendar: $('panel-calendar'),
      recipes: $('panel-recipes'),
      shopping: $('panel-shopping'),
    };
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        if (tab.classList.contains('active')) return;
        const name = tab.dataset.panel;
        for (const t of tabs) {
          const active = t === tab;
          t.classList.toggle('active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        }
        for (const [key, elNode] of Object.entries(panels)) {
          elNode.hidden = key !== name;
        }
      });
    }
  }

  // ── Filters ──────────────────────────────────────────────────────────────

  function initFilters() {
    for (const btn of $$('.filter-pill[data-filter="slot"]')) {
      btn.addEventListener('click', () => {
        const slot = btn.dataset.value;
        if (state.filters.slots.has(slot)) {
          state.filters.slots.delete(slot);
          btn.classList.remove('active');
        } else {
          state.filters.slots.add(slot);
          btn.classList.add('active');
        }
        renderLibrary();
      });
    }
    $('recipe-search').addEventListener('input', (e) => {
      state.filters.q = e.target.value.trim().toLowerCase();
      renderLibrary();
    });
  }

  function filteredRecipes() {
    const { slots, q } = state.filters;
    return state.recipes.filter((r) => {
      if (slots.size > 0) {
        const overlap = r.slot_categories.some((s) => slots.has(s));
        if (!overlap) return false;
      }
      if (q && !r.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // ── Library rendering ────────────────────────────────────────────────────

  async function loadRecipes() {
    state.recipes = await API.listRecipes();
  }

  function renderLibrary() {
    const grid = $('recipe-grid');
    grid.innerHTML = '';
    const recipes = filteredRecipes();
    $('recipe-count').textContent =
      recipes.length === 1 ? '1 recipe' : `${recipes.length} recipes`;

    if (recipes.length === 0) {
      grid.appendChild(
        el(
          'div',
          { class: 'empty-state' },
          el('div', { class: 'empty-state-ornament', 'aria-hidden': 'true' }, '✿ ❀ ✵ ❧ ✦'),
          el(
            'div',
            { class: 'empty-state-text' },
            state.recipes.length === 0 ? 'No recipes yet.' : 'No recipes match these filters.'
          ),
          el(
            'div',
            { class: 'empty-state-sub' },
            state.recipes.length === 0
              ? 'Click "+ New Recipe" to add your first.'
              : 'Try clearing a filter.'
          )
        )
      );
      return;
    }

    for (const recipe of recipes) {
      grid.appendChild(renderCard(recipe));
    }
  }

  function renderSlotBadges(slots) {
    return slots.map((slot) =>
      el('span', { class: `slot-badge slot-${slot}` }, slotLabel(slot))
    );
  }

  function renderCard(recipe) {
    const card = el('article', {
      class: 'recipe-card',
      dataset: { recipeId: String(recipe.id) },
      onclick: () => openDetailModal(recipe.id),
    });

    const titleBar = el(
      'header',
      { class: 'recipe-card-header' },
      el('h3', { class: 'recipe-card-title' }, recipe.title)
    );

    const meta = el('div', { class: 'recipe-card-meta' }, ...renderSlotBadges(recipe.slot_categories));
    meta.appendChild(
      el(
        'span',
        { class: 'recipe-card-ingredient-count' },
        recipe.ingredient_count === 1
          ? '1 ingredient'
          : `${recipe.ingredient_count} ingredients`
      )
    );

    card.appendChild(titleBar);
    card.appendChild(meta);
    if (recipe.source) {
      card.appendChild(
        el(
          'footer',
          { class: 'recipe-card-footer' },
          el('span', { class: 'recipe-source' }, recipe.source)
        )
      );
    }
    return card;
  }

  // ── Detail modal ─────────────────────────────────────────────────────────

  async function openDetailModal(id) {
    try {
      const recipe = await API.getRecipe(id);
      state.detail = recipe;
      $('detail-title').textContent = recipe.title;

      const body = $('detail-body');
      body.innerHTML = '';

      const meta = el('div', { class: 'detail-meta' }, ...renderSlotBadges(recipe.slot_categories));
      if (recipe.source) {
        meta.appendChild(el('span', { class: 'detail-source' }, recipe.source));
      }
      body.appendChild(meta);

      body.appendChild(el('h3', { class: 'detail-section-header' }, 'Ingredients'));
      if (recipe.ingredients.length === 0) {
        body.appendChild(el('p', { class: 'detail-empty' }, 'No ingredients recorded.'));
      } else {
        const ul = el('ul', { class: 'detail-ingredients' });
        for (const ing of recipe.ingredients) {
          ul.appendChild(el('li', {}, formatIngredient(ing)));
        }
        body.appendChild(ul);
      }

      if (recipe.steps && recipe.steps.trim()) {
        body.appendChild(el('h3', { class: 'detail-section-header' }, 'Steps'));
        body.appendChild(el('div', { class: 'detail-steps' }, recipe.steps));
      }

      if (recipe.notes && recipe.notes.trim()) {
        body.appendChild(el('h3', { class: 'detail-section-header' }, 'Notes'));
        body.appendChild(el('div', { class: 'detail-notes' }, recipe.notes));
      }

      showModal('detail-modal');
    } catch (err) {
      console.error('Open detail failed', err);
      alertDialog({ title: 'Couldn\'t load', body: 'Could not load recipe. Try again?' });
    }
  }

  function initDetailModal() {
    $('detail-edit').addEventListener('click', () => {
      if (!state.detail) return;
      const recipe = state.detail;
      hideModal('detail-modal');
      openEditModal(recipe);
    });
    $('detail-delete').addEventListener('click', async () => {
      if (!state.detail) return;
      const btn = $('detail-delete');
      if (btn.disabled) return;
      const recipe = state.detail;
      const count = recipe.planned_meal_count || 0;
      const body = count === 0
        ? 'This recipe will be permanently deleted.'
        : `This recipe will be permanently deleted. ${count} planned meal${count === 1 ? '' : 's'} on the calendar will be relabeled “(deleted: ${recipe.title}).”`;
      if (!await confirmDialog({
        title: 'Delete recipe?',
        body,
        confirmLabel: 'Delete',
        danger: true,
      })) return;
      btn.disabled = true;
      try {
        await API.deleteRecipe(recipe.id);
        hideModal('detail-modal');
        state.detail = null;
        await loadRecipes();
        renderLibrary();
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── Edit modal ───────────────────────────────────────────────────────────

  function openEditModal(recipe = EMPTY_RECIPE) {
    const isNew = recipe === EMPTY_RECIPE || recipe.id == null;
    state.editing = isNew ? { isNew: true } : { isNew: false, id: recipe.id };
    $('edit-title').textContent = isNew ? 'New Recipe' : 'Edit Recipe';
    $('edit-errors').hidden = true;
    $('edit-errors').textContent = '';

    const form = $('edit-form');
    $('field-title').value = recipe.title || '';
    $('field-source').value = recipe.source || '';
    $('field-steps').value = recipe.steps || '';
    $('field-notes').value = recipe.notes || '';

    for (const cb of $$('input[name="slot"]', form)) {
      cb.checked = recipe.slot_categories.includes(cb.value);
    }

    const rows = $('ingredient-rows');
    rows.innerHTML = '';
    const ingredients = recipe.ingredients || [];
    if (ingredients.length === 0) {
      addIngredientRow();
    } else {
      for (const ing of ingredients) addIngredientRow(ing);
    }

    showModal('edit-modal');
    $('field-title').focus();
  }

  function initEditModal() {
    $('new-recipe-btn').addEventListener('click', () => openEditModal());
    $('add-ingredient').addEventListener('click', () => addIngredientRow());
    $('edit-save').addEventListener('click', handleSave);
    // Prevent native form submission from Enter key — delegate to handleSave.
    $('edit-form').addEventListener('submit', (e) => {
      e.preventDefault();
      handleSave();
    });
  }

  function addIngredientRow(ing) {
    const rows = $('ingredient-rows');
    const row = el(
      'div',
      { class: 'ingredient-row' },
      el('input', {
        type: 'text',
        class: 'ingredient-qty',
        placeholder: 'Qty',
        value: ing && ing.quantity != null ? formatQuantity(ing.quantity) : '',
      }),
      buildUnitSelect(ing && ing.unit),
      el('input', {
        type: 'text',
        class: 'ingredient-name',
        placeholder: 'Ingredient name',
        value: ing ? ing.name : '',
      }),
      el(
        'button',
        {
          type: 'button',
          class: 'ingredient-remove',
          'aria-label': 'Remove ingredient',
          onclick: () => row.remove(),
        },
        '✕'
      )
    );
    rows.appendChild(row);
  }

  function buildUnitSelect(current) {
    const sel = el('select', { class: 'ingredient-unit' });
    sel.appendChild(el('option', { value: '' }, '—'));
    for (const unit of state.config.units) {
      const opt = el('option', { value: unit }, state.config.unit_labels[unit] || unit);
      if (unit === current) opt.selected = true;
      sel.appendChild(opt);
    }
    return sel;
  }

  async function handleSave() {
    const saveBtn = $('edit-save');
    if (saveBtn.disabled) return;

    const form = $('edit-form');
    const errors = [];

    const title = $('field-title').value.trim();
    if (!title) errors.push('Title is required.');

    const slots = $$('input[name="slot"]:checked', form).map((cb) => cb.value);
    if (slots.length === 0) errors.push('Pick at least one meal slot.');

    const source = $('field-source').value.trim() || null;
    const steps = $('field-steps').value.trim() || null;
    const notes = $('field-notes').value.trim() || null;

    const ingredients = [];
    const rowNodes = $$('.ingredient-row', $('ingredient-rows'));
    rowNodes.forEach((row, i) => {
      const name = row.querySelector('.ingredient-name').value.trim();
      const qtyRaw = row.querySelector('.ingredient-qty').value.trim();
      const unit = row.querySelector('.ingredient-unit').value || null;
      if (!name && !qtyRaw && !unit) return;
      if (!name) {
        errors.push(`Ingredient row ${i + 1}: name is required.`);
        return;
      }
      const parsed = parseQuantity(qtyRaw);
      if (!parsed.ok) {
        errors.push(`Ingredient row ${i + 1}: quantity "${qtyRaw}" is not a number or fraction.`);
        return;
      }
      ingredients.push({ name, quantity: parsed.value, unit });
    });

    if (errors.length) {
      showErrors(errors);
      return;
    }

    const payload = { title, slot_categories: slots, source, steps, notes, ingredients };

    saveBtn.disabled = true;
    try {
      if (state.editing.isNew) {
        await API.createRecipe(payload);
      } else {
        await API.updateRecipe(state.editing.id, payload);
      }
      hideModal('edit-modal');
      await loadRecipes();
      renderLibrary();
    } catch (err) {
      const msgs = err.data && err.data.errors ? err.data.errors : ['Save failed. Try again?'];
      showErrors(msgs);
    } finally {
      saveBtn.disabled = false;
    }
  }

  function showErrors(messages) {
    const box = $('edit-errors');
    box.innerHTML = '';
    for (const m of messages) box.appendChild(el('div', {}, m));
    box.hidden = false;
  }

  // ── Calendar ─────────────────────────────────────────────────────────────

  // Date helpers. All dates are ISO strings (YYYY-MM-DD) in state; Date objects
  // only exist inside helpers. Timezone bleed is avoided by constructing dates
  // in UTC and computing with UTC accessors.

  function isoToday() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function isoParse(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function isoFormat(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function addDays(s, n) {
    const d = isoParse(s);
    d.setUTCDate(d.getUTCDate() + n);
    return isoFormat(d);
  }

  function firstOfMonth(s) {
    return s.slice(0, 8) + '01';
  }

  function monthLabel(s) {
    const d = isoParse(s);
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function dayNumber(s) {
    return Number(s.slice(8, 10));
  }

  function dayOfWeek(s) {
    return isoParse(s).getUTCDay(); // 0 = Sun
  }

  function prettyDateLabel(s) {
    const d = isoParse(s);
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }

  // Format a SQLite UTC timestamp ("2026-04-26 17:04:32") in the user's local
  // time. SQLite returns space-separated; convert to "T" and append "Z" so
  // browsers parse as UTC. Falls back to the raw string if parsing fails.
  function prettyTimestamp(sqlUtc) {
    if (!sqlUtc) return '';
    const iso = sqlUtc.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return sqlUtc;
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  }

  const SLOT_LETTERS = { breakfast: 'B', lunch: 'L', dinner: 'D' };
  const SLOT_ORDER = { breakfast: 0, lunch: 1, dinner: 2 };

  const cal = {
    view: 'month',
    focusDate: isoToday(),
    meals: [],
    selectedDate: null,
    today: isoToday(),
  };

  let calendarRendered = false;

  async function loadMealsForRange(start, end) {
    const res = await fetch(`/api/planned-meals?start=${start}&end=${end}`);
    if (!res.ok) throw new Error(`listMeals ${res.status}`);
    cal.meals = await res.json();
  }

  function mealsOnDate(date) {
    const meals = cal.meals.filter((m) => m.date === date);
    meals.sort((a, b) => SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot] || a.id - b.id);
    return meals;
  }

  function mealTitle(m) {
    return m.recipe_id ? m.recipe_title || '(missing recipe)' : m.free_text || '(untitled)';
  }

  // ── Calendar header ──────────────────────────────────────────────────────

  function initCalendar() {
    $('cal-prev').addEventListener('click', () => shiftFocus(-1));
    $('cal-next').addEventListener('click', () => shiftFocus(+1));
    $('cal-today').addEventListener('click', () => {
      cal.focusDate = isoToday();
      cal.selectedDate = null;
      renderCalendar();
    });
    for (const btn of $$('.view-pill')) {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view !== 'month' && view !== 'week') return; // ignore stray attrs
        if (cal.view === view) return;
        cal.view = view;
        cal.selectedDate = null;
        for (const b of $$('.view-pill')) b.classList.toggle('active', b === btn);
        renderCalendar();
      });
    }
    $('cal-send-digest').addEventListener('click', handleSendDigest);

    initMealModal();
  }

  async function handleSendDigest() {
    const btn = $('cal-send-digest');
    if (btn.disabled) return;
    if (!await confirmDialog({
      title: "Send today's menu?",
      body: "Email Parke's inbox now.",
      confirmLabel: 'Send',
    })) return;
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      const result = await api('POST', '/api/send-digest?force=1');
      if (result.skipped) {
        await alertDialog({ title: 'Already sent', body: `The digest was sent earlier today at ${result.sent_at} UTC.` });
      } else {
        await alertDialog({ title: 'Sent', body: `${result.meal_count} meals. Subject: ${result.subject}` });
      }
    } catch (err) {
      console.error('Send digest failed', err);
      const msg = err && err.data && err.data.error
        ? err.data.error
        : 'Could not send. Check the server logs.';
      await alertDialog({ title: 'Send failed', body: msg });
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  function shiftFocus(direction) {
    if (cal.view === 'month') {
      const d = isoParse(cal.focusDate);
      // Snap day to 1 before shifting month, otherwise Jan 31 + 1 rolls to Mar 3
      // because JS setUTCMonth overflows rather than clamping.
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + direction);
      cal.focusDate = isoFormat(d);
    } else {
      cal.focusDate = addDays(cal.focusDate, direction * 7);
    }
    cal.selectedDate = null;
    renderCalendar();
  }

  async function renderCalendar() {
    cal.today = isoToday();

    const title = $('cal-title');
    const main = $('cal-main');
    const side = $('cal-side');
    const body = document.querySelector('.calendar-body');

    main.innerHTML = '';

    if (cal.view === 'month') {
      const first = firstOfMonth(cal.focusDate);
      const gridStart = addDays(first, -dayOfWeek(first));
      const gridEnd = addDays(gridStart, 41);
      title.textContent = monthLabel(cal.focusDate);
      await loadMealsForRange(gridStart, gridEnd);
      renderMonthView(main, first, gridStart);
    } else {
      // Week view (only non-month view in Phase 8+)
      const weekStart = addDays(cal.focusDate, -dayOfWeek(cal.focusDate));
      const weekEnd = addDays(weekStart, 6);
      title.textContent = `${prettyDateLabel(weekStart)} — ${prettyDateLabel(weekEnd)}`;
      await loadMealsForRange(weekStart, weekEnd);
      renderWeekView(main, weekStart);
    }

    if (cal.selectedDate) {
      body.classList.add('with-side');
      side.hidden = false;
      renderDayPanel(side, cal.selectedDate);
    } else {
      body.classList.remove('with-side');
      side.hidden = true;
    }
  }

  // ── Month view ───────────────────────────────────────────────────────────

  function renderMonthView(main, monthStart, gridStart) {
    const grid = el('div', { class: 'month-grid' });
    const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const dow of dows) {
      grid.appendChild(el('div', { class: 'month-dow' }, dow));
    }
    const currentMonth = monthStart.slice(0, 7);
    for (let i = 0; i < 42; i++) {
      const date = addDays(gridStart, i);
      const outOfMonth = date.slice(0, 7) !== currentMonth;
      grid.appendChild(renderDayCell(date, { outOfMonth }));
    }
    main.appendChild(grid);
  }

  function renderDayCell(date, { outOfMonth } = {}) {
    const classes = ['day-cell'];
    if (outOfMonth) classes.push('out-of-month');
    if (date === cal.today) classes.push('today');
    if (date === cal.selectedDate) classes.push('selected');

    const cell = el('div', {
      class: classes.join(' '),
      dataset: { date },
      onclick: () => selectDate(date),
    });

    cell.appendChild(el('div', { class: 'day-number' }, String(dayNumber(date))));

    const meals = mealsOnDate(date);
    const chipsWrap = el('div', { class: 'day-chips' });
    const visible = meals.slice(0, 3);
    for (const meal of visible) {
      chipsWrap.appendChild(renderChip(meal));
    }
    if (meals.length > visible.length) {
      chipsWrap.appendChild(
        el('div', { class: 'day-overflow' }, `+${meals.length - visible.length} more`)
      );
    }
    cell.appendChild(chipsWrap);

    // Drop target wiring for drag-to-reschedule.
    cell.addEventListener('dragover', (e) => {
      e.preventDefault();
      cell.classList.add('drop-target');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drop-target');
      const mealId = Number(e.dataTransfer.getData('text/plain'));
      if (mealId) rescheduleMeal(mealId, date);
    });

    return cell;
  }

  function renderChip(meal) {
    const cls = ['meal-chip'];
    cls.push(`slot-chip-${meal.slot}`);
    if (!meal.recipe_id) cls.push('free-text');
    if (meal.status === 'eaten') cls.push('eaten');

    const chip = el(
      'div',
      {
        class: cls.join(' '),
        draggable: 'true',
        tabindex: '0',
        role: 'button',
        'aria-label': `Edit ${meal.slot}: ${mealTitle(meal)}${meal.status === 'eaten' ? ' (eaten)' : ''}`,
        title: `${meal.slot.charAt(0).toUpperCase() + meal.slot.slice(1)} · ${mealTitle(meal)}`,
      },
      el('span', { class: 'slot-letter', 'aria-hidden': 'true' }, SLOT_LETTERS[meal.slot]),
      el('span', { class: 'chip-body' }, mealTitle(meal))
    );

    // Rely on native drag/click semantics: a bare click opens edit; a drag
    // suppresses the subsequent click. Chrome fires dragstart ~3-5px of movement
    // and fires click only on a pure up-without-drag gesture.
    let draggedFlag = false;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (draggedFlag) { draggedFlag = false; return; }
      openMealModal({ mode: 'edit', meal });
    });
    // Keyboard: Enter or Space opens the editor (drag stays mouse-only — drop
    // targets aren't keyboard-reachable; the editor lets you change date).
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        openMealModal({ mode: 'edit', meal });
      }
    });
    chip.addEventListener('dragstart', (e) => {
      draggedFlag = true;
      chip.classList.add('dragging');
      e.dataTransfer.setData('text/plain', String(meal.id));
      e.dataTransfer.effectAllowed = 'move';
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('dragging');
    });

    return chip;
  }

  async function rescheduleMeal(mealId, newDate) {
    const meal = cal.meals.find((m) => m.id === mealId);
    if (!meal || meal.date === newDate) return;
    try {
      await api('PATCH', `/api/planned-meals/${mealId}`, { date: newDate });
      await renderCalendar();
    } catch (err) {
      if (err.status === 409) {
        alertDialog({
          title: 'Slot taken',
          body: 'That day already has a meal for this slot. Delete or move the existing one first.',
        });
      } else {
        console.error('Reschedule failed', err);
        alertDialog({ title: 'Couldn\'t move', body: 'Could not move that meal. Try again?' });
      }
    }
  }

  // ── Week view ────────────────────────────────────────────────────────────

  function renderWeekView(main, weekStart) {
    const grid = el('div', { class: 'week-grid' });
    const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const cls = ['week-day'];
      if (date === cal.today) cls.push('today');
      if (date === cal.selectedDate) cls.push('selected');
      const day = el(
        'div',
        { class: cls.join(' '), onclick: () => selectDate(date) },
        el(
          'header',
          { class: 'week-day-header' },
          el('div', {}, dows[i]),
          el('div', { class: 'week-day-number' }, String(dayNumber(date)))
        )
      );
      const chipsWrap = el('div', { class: 'day-chips' });
      for (const meal of mealsOnDate(date)) {
        chipsWrap.appendChild(renderChip(meal));
      }
      day.appendChild(chipsWrap);
      grid.appendChild(day);
    }
    main.appendChild(grid);
  }

  // (Day view dropped in Phase 8 — once eater is gone, the 3×3 grid collapses
  // to 3 rows, which is exactly what the day side panel already shows.)

  // ── Day side panel (month / week view sidebar) ──────────────────────────

  function selectDate(date) {
    cal.selectedDate = date;
    renderCalendar();
  }

  function renderDayPanel(side, date) {
    side.innerHTML = '';
    side.appendChild(
      el(
        'header',
        { class: 'side-header' },
        el('h3', { class: 'side-date' }, prettyDateLabel(date)),
        el(
          'button',
          {
            class: 'side-close',
            'aria-label': 'Close day panel',
            onclick: () => { cal.selectedDate = null; renderCalendar(); },
          },
          '✕'
        )
      )
    );

    const meals = mealsOnDate(date);
    for (const slot of ['breakfast', 'lunch', 'dinner']) {
      const found = meals.find((m) => m.slot === slot);
      const row = el(
        'div',
        { class: `slot-row slot-row-${slot}` },
        el('div', { class: 'slot-row-label' }, slot[0].toUpperCase() + slot.slice(1)),
        el(
          'div',
          { class: 'slot-row-content' },
          found
            ? renderMealSummary(found)
            : el(
                'button',
                {
                  class: 'add-meal-btn',
                  onclick: () => openMealModal({ mode: 'create', date, slot }),
                },
                '+ add'
              )
        ),
        found ? renderEatenToggle(found) : el('span', {})
      );
      side.appendChild(row);
    }
  }

  function renderMealSummary(meal) {
    return el(
      'div',
      {
        class: `meal-summary${meal.status === 'eaten' ? ' eaten' : ''}`,
        onclick: () => openMealModal({ mode: 'edit', meal }),
      },
      el('span', { class: 'meal-summary-title' }, mealTitle(meal))
    );
  }

  function renderEatenToggle(meal) {
    return el(
      'button',
      {
        class: `eaten-toggle${meal.status === 'eaten' ? ' on' : ''}`,
        title: meal.status === 'eaten' ? 'Marked eaten — click to unmark' : 'Mark as eaten',
        'aria-label': meal.status === 'eaten' ? 'Mark not eaten' : 'Mark eaten',
        onclick: async (e) => {
          e.stopPropagation();
          const next = meal.status === 'eaten' ? 'planned' : 'eaten';
          try {
            await api('PATCH', `/api/planned-meals/${meal.id}`, { status: next });
            await renderCalendar();
          } catch (err) {
            console.error(err);
            alertDialog({ title: 'Couldn\'t update', body: 'Could not update meal status.' });
          }
        },
      },
      meal.status === 'eaten' ? '✓' : '○'
    );
  }

  // ── Meal picker modal ────────────────────────────────────────────────────

  let mealModalState = null;

  function initMealModal() {
    $('meal-save').addEventListener('click', handleMealSave);
    $('meal-delete').addEventListener('click', handleMealDelete);
    $('meal-recipe').addEventListener('change', () => {
      if ($('meal-recipe').value) {
        $('meal-free-text').value = '';
      }
      syncViewRecipeLink();
    });
    $('meal-view-recipe').addEventListener('click', () => {
      const id = $('meal-recipe').value;
      if (!id) return;
      hideModal('meal-modal');
      openDetailModal(Number(id));
    });
    $('meal-free-text').addEventListener('input', () => {
      if ($('meal-free-text').value.trim()) {
        $('meal-recipe').value = '';
        syncViewRecipeLink();
      }
    });
    for (const btn of $$('#meal-free-row .quick-pill')) {
      btn.addEventListener('click', () => {
        $('meal-recipe').value = '';
        syncViewRecipeLink();
        $('meal-free-text').value = btn.dataset.quick;
      });
    }
  }

  async function openMealModal({ mode, date, slot, meal }) {
    let actual = { date, slot };
    let mealId = null;
    let current = { recipeId: '', freeText: '', notes: '' };
    if (mode === 'edit' && meal) {
      actual = { date: meal.date || date, slot: meal.slot };
      mealId = meal.id;
      current = {
        recipeId: meal.recipe_id ? String(meal.recipe_id) : '',
        freeText: meal.free_text || '',
        notes: meal.notes || '',
      };
    }
    mealModalState = { mode, ...actual, mealId };

    $('meal-title').textContent = mode === 'edit' ? 'Edit meal' : 'Plan a meal';
    $('meal-delete').hidden = mode !== 'edit';

    const ctx = $('meal-context');
    ctx.innerHTML = '';
    ctx.appendChild(el('span', { class: `meal-context-badge slot-badge slot-${actual.slot}` }, actual.slot.charAt(0).toUpperCase() + actual.slot.slice(1)));
    ctx.appendChild(el('span', {}, ` · ${prettyDateLabel(actual.date)}`));

    // Populate recipe dropdown (filtered to this slot).
    const sel = $('meal-recipe');
    sel.innerHTML = '<option value="">— Free text / leftovers / eating out —</option>';
    try {
      const recipes = await api('GET', `/api/recipes?slot=${encodeURIComponent(actual.slot)}`);
      recipes.sort((a, b) => a.title.localeCompare(b.title));
      let foundCurrent = false;
      for (const r of recipes) {
        const opt = el('option', { value: String(r.id) }, r.title);
        if (String(r.id) === current.recipeId) { opt.selected = true; foundCurrent = true; }
        sel.appendChild(opt);
      }
      // If the meal's recipe exists but was filtered out (e.g. slot tag changed),
      // fetch it standalone and pin it so we don't silently clear the selection.
      if (current.recipeId && !foundCurrent) {
        try {
          const r = await api('GET', `/api/recipes/${current.recipeId}`);
          const opt = el('option', { value: String(r.id) }, `${r.title} (not in ${actual.slot} anymore)`);
          opt.selected = true;
          sel.appendChild(opt);
        } catch (_) { /* recipe hard-deleted — leave unselected */ }
      }
    } catch (err) {
      console.error('Load recipes failed', err);
    }

    $('meal-free-text').value = current.freeText;
    $('meal-notes').value = current.notes || '';
    $('meal-errors').hidden = true;
    $('meal-errors').textContent = '';
    syncViewRecipeLink();

    showModal('meal-modal');
    sel.focus();
  }

  function syncViewRecipeLink() {
    $('meal-view-recipe').hidden = !$('meal-recipe').value;
  }

  async function handleMealSave() {
    if (!mealModalState) return;
    const btn = $('meal-save');
    if (btn.disabled) return;

    const recipeId = $('meal-recipe').value;
    const freeText = $('meal-free-text').value.trim();
    const notes = $('meal-notes').value.trim() || null;

    if (!recipeId && !freeText) {
      return showMealError(['Pick a recipe or type a free-text meal.']);
    }
    if (recipeId && freeText) {
      return showMealError(['Choose either a recipe or free text — not both.']);
    }

    btn.disabled = true;
    try {
      if (mealModalState.mode === 'create') {
        const body = {
          date: mealModalState.date,
          slot: mealModalState.slot,
          notes,
        };
        if (recipeId) body.recipe_id = Number(recipeId);
        else body.free_text = freeText;
        await api('POST', '/api/planned-meals', body);
      } else {
        const body = { notes };
        if (recipeId) body.recipe_id = Number(recipeId);
        else body.free_text = freeText;
        await api('PATCH', `/api/planned-meals/${mealModalState.mealId}`, body);
      }
      hideModal('meal-modal');
      await renderCalendar();
    } catch (err) {
      showMealError(extractErrorMessages(err));
    } finally {
      btn.disabled = false;
    }
  }

  function extractErrorMessages(err) {
    if (err && err.data) {
      if (Array.isArray(err.data.errors)) return err.data.errors;
      if (err.data.error) return [err.data.error];
    }
    return ['Save failed. Try again?'];
  }

  async function handleMealDelete() {
    if (!mealModalState || mealModalState.mode !== 'edit') return;
    const btn = $('meal-delete');
    btn.disabled = true;
    try {
      const ok = await confirmDialog({
        title: 'Delete this meal?',
        body: 'The meal is removed from the calendar.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) { btn.disabled = false; return; }
      await api('DELETE', `/api/planned-meals/${mealModalState.mealId}`);
      hideModal('meal-modal');
      await renderCalendar();
    } catch (err) {
      console.error(err);
      showMealError(['Delete failed.']);
    } finally {
      btn.disabled = false;
    }
  }

  function showMealError(msgs) {
    const box = $('meal-errors');
    box.innerHTML = '';
    for (const m of msgs) box.appendChild(el('div', {}, m));
    box.hidden = false;
  }

  // ── Shopping lists ───────────────────────────────────────────────────────

  const shop = {
    lists: [],           // list summaries
    activeListId: null,  // currently-open list detail
    builder: {           // modal state
      recipes: [],       // all active recipes for the picker
      selected: new Set(),
      search: '',
      preview: [],       // items to save — editable before save
    },
  };

  async function loadShoppingLists() {
    shop.lists = await api('GET', '/api/shopping-lists');
  }

  function renderShoppingPanel() {
    const listsWrap = $('shopping-lists');
    const detailWrap = $('shopping-detail');

    if (shop.activeListId != null) {
      listsWrap.hidden = true;
      detailWrap.hidden = false;
      return;
    }
    listsWrap.hidden = false;
    detailWrap.hidden = true;

    listsWrap.innerHTML = '';
    if (shop.lists.length === 0) {
      listsWrap.appendChild(
        el(
          'div',
          { class: 'empty-state' },
          el('div', { class: 'empty-state-ornament', 'aria-hidden': 'true' }, '✿ ❀ ✵ ❧ ✦'),
          el('div', { class: 'empty-state-text' }, 'No shopping lists yet.'),
          el('div', { class: 'empty-state-sub' }, 'Click "+ New shopping list" to pick recipes and generate one.')
        )
      );
      return;
    }
    for (const list of shop.lists) {
      listsWrap.appendChild(renderListCard(list));
    }
  }

  function renderListCard(list) {
    const itemLabel = list.item_count === 1 ? '1 item' : `${list.item_count} items`;
    const checkedLabel = list.checked_count > 0 ? ` · ${list.checked_count} checked` : '';
    const card = el(
      'article',
      { class: 'list-card', onclick: () => openListDetail(list.id) },
      el('h3', { class: 'list-card-name' }, list.name),
      el(
        'div',
        { class: 'list-card-meta' },
        el('span', {}, itemLabel + checkedLabel),
        list.emailed_at ? el('span', { class: 'list-emailed-badge' }, 'emailed') : null
      )
    );
    return card;
  }

  async function openListDetail(id) {
    shop.activeListId = id;
    const list = await api('GET', `/api/shopping-lists/${id}`);
    renderListDetail(list);
  }

  function closeListDetail() {
    shop.activeListId = null;
    renderShoppingPanel();
  }

  function renderListDetail(list) {
    renderShoppingPanel();
    const wrap = $('shopping-detail');
    wrap.innerHTML = '';

    const nameInput = el('input', {
      type: 'text',
      class: 'detail-name-input',
      value: list.name,
      maxlength: 200,
    });
    nameInput.addEventListener('change', async () => {
      const name = nameInput.value.trim();
      if (!name || name === list.name) { nameInput.value = list.name; return; }
      try {
        await api('PATCH', `/api/shopping-lists/${list.id}`, { name });
        list.name = name;
      } catch (err) { alertDialog({ title: 'Rename failed', body: 'Could not save the new name.' }); nameInput.value = list.name; }
    });

    const actions = el(
      'div',
      { class: 'detail-actions' },
      el(
        'button',
        { class: 'btn-ghost', onclick: () => handleEmailList(list.id) },
        '📧 Email me this list'
      ),
      el(
        'button',
        {
          class: 'btn-ghost',
          onclick: () => handleRemoveChecked(list.id),
        },
        'Remove checked'
      ),
      el(
        'button',
        { class: 'btn-ghost btn-danger', onclick: () => handleDeleteList(list.id) },
        'Delete'
      ),
      el(
        'button',
        { class: 'btn-ghost', onclick: closeListDetail },
        '← Back'
      )
    );

    wrap.appendChild(el('header', { class: 'detail-header' }, nameInput, actions));

    const metaBits = [];
    const total = list.items.length;
    const remaining = list.items.filter((i) => !i.checked).length;
    if (total === 0) metaBits.push('No items');
    else if (total === remaining) metaBits.push(`${total} item${total === 1 ? '' : 's'}`);
    else metaBits.push(`${remaining} of ${total} remaining`);
    if (list.emailed_at) metaBits.push(`Last emailed ${prettyTimestamp(list.emailed_at)}`);
    wrap.appendChild(el('div', { class: 'detail-meta-row' }, metaBits.join(' · ')));

    const itemList = el('div', { class: 'item-list' });
    for (const item of list.items) itemList.appendChild(renderItemRow(list.id, item));
    wrap.appendChild(itemList);

    wrap.appendChild(
      el(
        'button',
        { class: 'btn-ghost-sm', onclick: () => addItemToList(list) },
        '+ Add item'
      )
    );
  }

  function renderItemRow(listId, item) {
    const row = el('div', {
      class: `item-row${item.checked ? ' checked' : ''}`,
      dataset: {
        itemId: String(item.id || ''),
        checked: item.checked ? '1' : '0',
        recipeIds: JSON.stringify(item.recipe_ids || []),
      },
    });
    const checkBtn = el(
      'button',
      {
        class: `item-checkbox${item.checked ? ' checked' : ''}`,
        'aria-label': item.checked ? 'Uncheck' : 'Check',
        onclick: async () => {
          // Update the DOM synchronously so any in-flight persistItems read
          // reflects the new state immediately.
          const isChecked = row.dataset.checked === '1';
          const nextChecked = !isChecked;
          row.dataset.checked = nextChecked ? '1' : '0';
          row.classList.toggle('checked', nextChecked);
          checkBtn.classList.toggle('checked', nextChecked);
          checkBtn.textContent = nextChecked ? '✓' : '';
          try {
            await api('PATCH', `/api/shopping-lists/${listId}/items/${item.id}`, { checked: nextChecked ? 1 : 0 });
          } catch (err) {
            // Revert on failure.
            row.dataset.checked = isChecked ? '1' : '0';
            row.classList.toggle('checked', isChecked);
            checkBtn.classList.toggle('checked', isChecked);
            checkBtn.textContent = isChecked ? '✓' : '';
            alertDialog({ title: 'Couldn\'t toggle', body: 'Could not update item.' });
          }
        },
      },
      item.checked ? '✓' : ''
    );
    const qtyInput = el('input', {
      type: 'text',
      class: 'item-qty',
      placeholder: 'Qty',
      value: item.quantity != null ? formatQuantity(item.quantity) : '',
    });
    const unitSelect = buildUnitSelect(item.unit);
    unitSelect.classList.add('item-unit');
    const nameInput = el('input', {
      type: 'text',
      class: 'item-name',
      value: item.name,
      maxlength: 200,
    });
    const removeBtn = el(
      'button',
      {
        class: 'ingredient-remove',
        'aria-label': 'Remove',
        onclick: () => { row.remove(); persistItems(listId); },
      },
      '✕'
    );
    // Debounced persistence on change
    for (const input of [qtyInput, unitSelect, nameInput]) {
      input.addEventListener('change', () => persistItems(listId));
    }

    row.appendChild(checkBtn);
    row.appendChild(qtyInput);
    row.appendChild(unitSelect);
    row.appendChild(nameInput);
    row.appendChild(removeBtn);
    return row;
  }

  function readItemRowsFromDetail() {
    const rows = $$('.item-row', $('shopping-detail'));
    const items = [];
    const errors = [];
    rows.forEach((row, i) => {
      row.classList.remove('row-error');
      const name = row.querySelector('.item-name').value.trim();
      if (!name) return; // silently skip fully-empty rows
      const qtyRaw = row.querySelector('.item-qty').value.trim();
      const unit = row.querySelector('.item-unit').value || null;
      const parsed = parseQuantity(qtyRaw);
      if (!parsed.ok) {
        errors.push(`Row ${i + 1}: "${qtyRaw}" isn't a number or fraction`);
        row.classList.add('row-error');
        return;
      }
      let recipeIds = [];
      try { recipeIds = JSON.parse(row.dataset.recipeIds || '[]'); } catch (_) {}
      items.push({
        name,
        quantity: parsed.value,
        unit,
        checked: row.dataset.checked === '1' ? 1 : 0,
        recipe_ids: recipeIds,
      });
    });
    return { items, errors };
  }

  // Debounce the heavy PUT-replaces-everything save so rapid typing doesn't
  // fire one delete+reinsert per keystroke. In-store toggles still land
  // immediately via their own PATCH endpoint.
  let persistTimer = null;
  function persistItems(listId) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      const { items, errors } = readItemRowsFromDetail();
      if (errors.length) {
        // Leave the bad row marked; don't persist until resolved.
        console.warn('Persist skipped due to row errors:', errors);
        return;
      }
      try {
        await api('PUT', `/api/shopping-lists/${listId}/items`, { items });
      } catch (err) {
        console.error('Persist failed', err);
      }
    }, 500);
  }

  function addItemToList(list) {
    list.items.push({ id: null, name: '', quantity: null, unit: null, checked: false, recipe_ids: [] });
    renderListDetail(list);
  }

  let emailSendInFlight = false;
  async function handleEmailList(id) {
    if (emailSendInFlight) return;
    if (!await confirmDialog({
      title: 'Email this list?',
      body: "Send to Parke's inbox.",
      confirmLabel: 'Send',
    })) return;
    emailSendInFlight = true;
    try {
      const result = await api('POST', `/api/shopping-lists/${id}/email`);
      await alertDialog({ title: 'Sent', body: `Resend id: ${result.resend_id || 'n/a'}` });
      await openListDetail(id);
    } catch (err) {
      await alertDialog({ title: 'Email failed', body: (err.data && err.data.error) || 'unknown error' });
    } finally {
      emailSendInFlight = false;
    }
  }

  async function handleRemoveChecked(id) {
    if (!await confirmDialog({
      title: 'Remove checked items?',
      body: 'They\'ll be deleted from the list.',
      confirmLabel: 'Remove',
      danger: true,
    })) return;
    try {
      const result = await api('POST', `/api/shopping-lists/${id}/remove-checked`);
      if (result.removed === 0) {
        await alertDialog({ title: 'Nothing to remove', body: 'No checked items on this list.' });
        return;
      }
      await openListDetail(id);
    } catch (err) { alertDialog({ title: 'Remove failed', body: 'Try again.' }); }
  }

  async function handleDeleteList(id) {
    if (!await confirmDialog({
      title: 'Delete this shopping list?',
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })) return;
    try {
      await api('DELETE', `/api/shopping-lists/${id}`);
      closeListDetail();
      await loadShoppingLists();
      renderShoppingPanel();
    } catch (err) { alertDialog({ title: 'Delete failed', body: 'Try again.' }); }
  }

  // ── List builder modal ───────────────────────────────────────────────────

  async function openListBuilder() {
    shop.builder.selected = new Set();
    shop.builder.search = '';
    shop.builder.preview = [];
    $('list-name').value = '';
    $('picker-search').value = '';
    $('picker-count').textContent = '0 selected';
    $('preview-row').hidden = true;
    $('preview-items').innerHTML = '';
    $('list-builder-errors').hidden = true;
    $('list-builder-errors').textContent = '';

    // Always load a fresh copy of active recipes.
    shop.builder.recipes = await api('GET', '/api/recipes');
    renderRecipePicker();
    showModal('list-builder-modal');
    $('list-name').focus();
  }

  function renderRecipePicker() {
    const list = $('recipe-picker-list');
    list.innerHTML = '';
    const q = shop.builder.search.toLowerCase();
    const filtered = shop.builder.recipes.filter((r) => !q || r.title.toLowerCase().includes(q));
    filtered.sort((a, b) => a.title.localeCompare(b.title));
    for (const r of filtered) {
      const checked = shop.builder.selected.has(r.id);
      const row = el(
        'label',
        { class: `picker-row${checked ? ' selected' : ''}` },
        el('input', {
          type: 'checkbox',
          onchange: (e) => {
            if (e.target.checked) shop.builder.selected.add(r.id);
            else shop.builder.selected.delete(r.id);
            row.classList.toggle('selected', e.target.checked);
            updatePickerCount();
          },
        }),
        el('span', { class: 'picker-title' }, r.title),
        el('span', { class: 'picker-slots' }, r.slot_categories.join(' · '))
      );
      row.querySelector('input').checked = checked;
      list.appendChild(row);
    }
    updatePickerCount();
  }

  function updatePickerCount() {
    const n = shop.builder.selected.size;
    $('picker-count').textContent = `${n} selected`;
  }

  function initListBuilder() {
    $('new-list-btn').addEventListener('click', () => openListBuilder());
    $('picker-search').addEventListener('input', (e) => {
      shop.builder.search = e.target.value.trim();
      renderRecipePicker();
    });
    $('generate-list-btn').addEventListener('click', handleGenerateFromPicks);
    $('add-preview-item').addEventListener('click', () => addPreviewRow());
    $('list-save-btn').addEventListener('click', handleSaveList);
  }

  async function handleGenerateFromPicks() {
    if (shop.builder.selected.size === 0) {
      return showListBuilderError(['Pick at least one recipe first.']);
    }
    // Build a preview by creating a temp list via POST, then show items —
    // but we don't want to save yet. Simpler: let the server aggregate
    // without persisting. We'll replicate the aggregation client-side
    // by fetching each recipe detail and summing.
    try {
      const recipeIds = Array.from(shop.builder.selected);
      const recipes = await Promise.all(recipeIds.map((id) => api('GET', `/api/recipes/${id}`)));
      shop.builder.preview = aggregateClientSide(recipes);
      renderPreview();
      $('preview-row').hidden = false;
    } catch (err) {
      showListBuilderError(['Could not load recipes.']);
    }
  }

  function aggregateClientSide(recipes) {
    const map = new Map();
    for (const r of recipes) {
      for (const ing of (r.ingredients || [])) {
        const trimmedName = (ing.name || '').trim();
        if (!trimmedName) continue;
        const key = `${trimmedName.toLowerCase()}|${ing.unit || ''}`;
        if (map.has(key)) {
          const ex = map.get(key);
          if (ex.quantity != null && ing.quantity != null) ex.quantity += ing.quantity;
          else ex.quantity = null;
          if (!ex.recipe_ids.includes(r.id)) ex.recipe_ids.push(r.id);
        } else {
          map.set(key, {
            name: trimmedName,
            quantity: ing.quantity,
            unit: ing.unit,
            recipe_ids: [r.id],
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  function renderPreview() {
    const wrap = $('preview-items');
    wrap.innerHTML = '';
    if (shop.builder.preview.length === 0) {
      wrap.appendChild(el('div', { class: 'detail-empty' }, 'No ingredients in selected recipes.'));
      return;
    }
    for (const item of shop.builder.preview) wrap.appendChild(buildPreviewRow(item));
  }

  function buildPreviewRow(item) {
    const row = el('div', { class: 'ingredient-row' });
    row.appendChild(
      el('input', {
        type: 'text',
        class: 'ingredient-qty',
        placeholder: 'Qty',
        value: item.quantity != null ? formatQuantity(item.quantity) : '',
      })
    );
    const sel = buildUnitSelect(item.unit);
    sel.classList.add('ingredient-unit');
    row.appendChild(sel);
    row.appendChild(
      el('input', {
        type: 'text',
        class: 'ingredient-name',
        placeholder: 'Ingredient',
        value: item.name,
      })
    );
    row.appendChild(
      el(
        'button',
        {
          type: 'button',
          class: 'ingredient-remove',
          'aria-label': 'Remove',
          onclick: () => row.remove(),
        },
        '✕'
      )
    );
    return row;
  }

  function addPreviewRow() {
    $('preview-items').appendChild(buildPreviewRow({ name: '', quantity: null, unit: null }));
    $('preview-row').hidden = false;
  }

  function readPreviewItems() {
    const rows = $$('.ingredient-row', $('preview-items'));
    const errors = [];
    const items = [];
    rows.forEach((row, i) => {
      const name = row.querySelector('.ingredient-name').value.trim();
      const qtyRaw = row.querySelector('.ingredient-qty').value.trim();
      const unit = row.querySelector('.ingredient-unit').value || null;
      if (!name && !qtyRaw && !unit) return;
      if (!name) { errors.push(`Preview row ${i + 1}: name required`); return; }
      const parsed = parseQuantity(qtyRaw);
      if (!parsed.ok) { errors.push(`Preview row ${i + 1}: bad quantity`); return; }
      items.push({ name, quantity: parsed.value, unit, checked: 0 });
    });
    return { items, errors };
  }

  async function handleSaveList() {
    const btn = $('list-save-btn');
    if (btn.disabled) return;
    const name = $('list-name').value.trim();
    const recipeIds = Array.from(shop.builder.selected);

    let items = [];
    if (!$('preview-row').hidden) {
      const { items: parsedItems, errors } = readPreviewItems();
      if (errors.length) return showListBuilderError(errors);
      items = parsedItems;
    }

    if (!recipeIds.length && !items.length) {
      return showListBuilderError(['Pick at least one recipe, or add items to the preview.']);
    }

    const body = { name: name || undefined, recipe_ids: recipeIds };
    // Only pass `items` when the user actually edited the preview to a non-empty
    // set. If they cleared all preview rows, fall through to server aggregation
    // from recipe_ids so we don't save an empty list unexpectedly.
    if (items.length) body.items = items;

    btn.disabled = true;
    try {
      const saved = await api('POST', '/api/shopping-lists', body);
      hideModal('list-builder-modal');
      await loadShoppingLists();
      shop.activeListId = saved.id;
      await openListDetail(saved.id);
    } catch (err) {
      showListBuilderError(extractErrorMessages(err));
    } finally {
      btn.disabled = false;
    }
  }

  function showListBuilderError(msgs) {
    const box = $('list-builder-errors');
    box.innerHTML = '';
    for (const m of msgs) box.appendChild(el('div', {}, m));
    box.hidden = false;
  }

  // ── Dialog primitives ────────────────────────────────────────────────────
  // Replacements for native alert / confirm / prompt that match the
  // illuminated-manuscript aesthetic. Promise-based; callers await them.
  // Markup is created dynamically and removed on close — no index.html
  // changes needed. Focus is trapped inside while open and restored on close.

  function trapFocus(panel) {
    const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    function focusable() {
      return Array.from(panel.querySelectorAll(selector)).filter((n) => !n.disabled && n.offsetParent !== null);
    }
    function onKey(e) {
      if (e.key !== 'Tab') return;
      const list = focusable();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    panel.addEventListener('keydown', onKey);
    return () => panel.removeEventListener('keydown', onKey);
  }

  // Generic dialog. buttons: [{label, value, primary?, danger?, autofocus?}]
  function dialog({ title, body, buttons }) {
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;
      const root = el('div', { class: 'modal' });
      const backdrop = el('div', { class: 'modal-backdrop' });
      const panel = el('div', {
        class: 'modal-panel ui-dialog-panel',
        role: 'dialog',
        'aria-modal': 'true',
      });
      const titleEl = title
        ? el('header', { class: 'modal-header' },
            el('h2', { class: 'modal-title' }, title))
        : null;
      const bodyEl = el(
        'div',
        { class: 'modal-body ui-dialog-body' },
        typeof body === 'string' ? el('p', {}, body) : body
      );
      const footer = el('footer', { class: 'modal-footer' });
      const buttonNodes = [];
      buttons.forEach((b, i) => {
        const cls = ['btn-ghost'];
        if (b.primary) cls[0] = 'btn-primary';
        if (b.danger) cls.push('btn-danger');
        if (i === buttons.length - 1 && buttons.length > 1) cls.push('footer-end');
        const node = el(
          'button',
          {
            type: 'button',
            class: cls.join(' '),
            onclick: () => close(b.value),
          },
          b.label
        );
        buttonNodes.push({ node, def: b });
        footer.appendChild(node);
      });

      if (titleEl) panel.appendChild(titleEl);
      panel.appendChild(bodyEl);
      panel.appendChild(footer);
      root.appendChild(backdrop);
      root.appendChild(panel);
      document.body.appendChild(root);
      document.body.classList.add('modal-open');

      const releaseTrap = trapFocus(panel);

      function close(value) {
        releaseTrap();
        root.remove();
        if ($$('.modal:not([hidden])').length === 0) {
          document.body.classList.remove('modal-open');
        }
        document.removeEventListener('keydown', onEscape, { capture: true });
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
          previouslyFocused.focus();
        }
        resolve(value);
      }

      function onEscape(e) {
        if (e.key !== 'Escape') return;
        // Stop propagation so the global modal-Escape handler doesn't also
        // dismiss an underlying modal when this is a stacked dialog.
        e.stopPropagation();
        const cancelBtn = buttons.find((b) => b.value === false || b.value === null);
        close(cancelBtn ? cancelBtn.value : null);
      }
      document.addEventListener('keydown', onEscape, { capture: true });
      backdrop.addEventListener('click', () => close(buttons.find((b) => !b.primary) ? (buttons.find((b) => !b.primary)).value : null));

      // Initial focus: prefer autofocus, else first input, else primary, else first button.
      setTimeout(() => {
        const auto = buttonNodes.find((b) => b.def.autofocus);
        const inputs = panel.querySelectorAll('input, textarea, select');
        if (inputs.length > 0) inputs[0].focus();
        else if (auto) auto.node.focus();
        else {
          const primary = buttonNodes.find((b) => b.def.primary);
          (primary || buttonNodes[0]).node.focus();
        }
      }, 0);
    });
  }

  function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    return dialog({
      title,
      body,
      buttons: [
        { label: cancelLabel, value: false },
        { label: confirmLabel, value: true, primary: !danger, danger },
      ],
    });
  }

  function alertDialog({ title, body, okLabel = 'OK' }) {
    return dialog({
      title,
      body,
      buttons: [{ label: okLabel, value: true, primary: true }],
    });
  }

  // ── Modal controller ─────────────────────────────────────────────────────

  // Track focus trap teardown + previously-focused element per modal so we can
  // release on hide and restore focus.
  const modalFocusState = {};

  function showModal(id) {
    const modal = $(id);
    modal.hidden = false;
    document.body.classList.add('modal-open');
    const panel = modal.querySelector('.modal-panel');
    if (panel) {
      modalFocusState[id] = {
        previouslyFocused: document.activeElement,
        release: trapFocus(panel),
      };
      // Initial focus: first input/textarea/select, else first button.
      setTimeout(() => {
        const first = panel.querySelector('input, textarea, select, button');
        if (first) first.focus();
      }, 0);
    }
  }
  function hideModal(id) {
    $(id).hidden = true;
    const state = modalFocusState[id];
    if (state) {
      state.release();
      if (state.previouslyFocused && typeof state.previouslyFocused.focus === 'function') {
        state.previouslyFocused.focus();
      }
      delete modalFocusState[id];
    }
    if ($$('.modal:not([hidden])').length === 0) {
      document.body.classList.remove('modal-open');
    }
  }
  function initModalDismiss() {
    for (const btn of $$('[data-close-modal]')) {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal');
        if (modal) hideModal(modal.id);
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = $$('.modal:not([hidden])').pop();
      if (open) hideModal(open.id);
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  async function init() {
    const [config, recipes] = await Promise.all([
      API.config(),
      API.listRecipes(false),
    ]);
    state.config = config;
    state.recipes = recipes;
    initTabs();
    initFilters();
    initEditModal();
    initDetailModal();
    initCalendar();
    initListBuilder();
    initModalDismiss();
    renderLibrary();
    // Lazy render on first visit so we don't network on boot.
    document.querySelector('.tab[data-panel="calendar"]').addEventListener('click', () => {
      if (!calendarRendered) {
        calendarRendered = true;
        renderCalendar().catch((err) => console.error('Calendar render failed:', err));
      }
    });
    let shoppingRendered = false;
    document.querySelector('.tab[data-panel="shopping"]').addEventListener('click', async () => {
      if (!shoppingRendered) {
        shoppingRendered = true;
        try { await loadShoppingLists(); renderShoppingPanel(); }
        catch (err) { console.error('Shopping load failed:', err); }
      }
    });
  }

  init().catch((err) => {
    console.error('Food init failed:', err);
    const main = document.querySelector('main');
    if (main) {
      main.innerHTML = '';
      main.appendChild(
        el(
          'div',
          { class: 'panel' },
          el(
            'div',
            { class: 'empty-state' },
            el('div', { class: 'empty-state-text' }, 'Food could not start.'),
            el('div', { class: 'empty-state-sub' }, 'Reload the page. If it persists, the server may be down.')
          )
        )
      );
    }
  });
})();
