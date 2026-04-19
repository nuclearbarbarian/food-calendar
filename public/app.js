'use strict';

(function () {
  // ── State ────────────────────────────────────────────────────────────────

  const state = {
    config: null,
    recipes: [],
    filters: {
      slots: new Set(),
      tried: 'all',
      q: '',
      includeInactive: false,
    },
    editing: null,   // { isNew: true } | { isNew: false, id }
    detail: null,    // full recipe currently displayed in detail modal
  };

  const EMPTY_RECIPE = Object.freeze({
    title: '',
    slot_categories: [],
    tried: false,
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

  function formatQuantity(q) {
    if (q == null || q === 0) return '';
    const rounded = Math.round(q * 1000) / 1000;
    return String(rounded);
  }

  function slotLabel(slot) {
    return slot.charAt(0).toUpperCase() + slot.slice(1);
  }

  function formatIngredient(ing) {
    const qty = formatQuantity(ing.quantity);
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
    listRecipes: (includeInactive) =>
      api('GET', `/api/recipes${includeInactive ? '?include_inactive=1' : ''}`),
    getRecipe: (id) => api('GET', `/api/recipes/${id}`),
    createRecipe: (payload) => api('POST', '/api/recipes', payload),
    updateRecipe: (id, payload) => api('PUT', `/api/recipes/${id}`, payload),
    setTried: (id, tried) => api('PATCH', `/api/recipes/${id}/tried`, { tried: tried ? 1 : 0 }),
    setActive: (id, active) => api('PATCH', `/api/recipes/${id}/active`, { active: active ? 1 : 0 }),
  };

  // ── Tabs ─────────────────────────────────────────────────────────────────

  function initTabs() {
    const tabs = $$('.tab');
    const panels = {
      calendar: $('panel-calendar'),
      recipes: $('panel-recipes'),
      menus: $('panel-menus'),
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
    for (const btn of $$('.filter-pill[data-filter="tried"]')) {
      btn.addEventListener('click', () => {
        state.filters.tried = btn.dataset.value;
        for (const t of $$('.filter-pill[data-filter="tried"]')) {
          t.classList.toggle('active', t === btn);
        }
        renderLibrary();
      });
    }
    $('recipe-search').addEventListener('input', (e) => {
      state.filters.q = e.target.value.trim().toLowerCase();
      renderLibrary();
    });
    $('show-inactive').addEventListener('change', async (e) => {
      state.filters.includeInactive = e.target.checked;
      await loadRecipes();
      renderLibrary();
    });
  }

  function filteredRecipes() {
    const { slots, tried, q } = state.filters;
    return state.recipes.filter((r) => {
      if (slots.size > 0) {
        const overlap = r.slot_categories.some((s) => slots.has(s));
        if (!overlap) return false;
      }
      if (tried === 'tried' && !r.tried) return false;
      if (tried === 'untried' && r.tried) return false;
      if (q && !r.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // ── Library rendering ────────────────────────────────────────────────────

  async function loadRecipes() {
    state.recipes = await API.listRecipes(state.filters.includeInactive);
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
      class: `recipe-card${recipe.active ? '' : ' recipe-card-inactive'}`,
      dataset: { recipeId: String(recipe.id) },
      onclick: () => openDetailModal(recipe.id),
    });

    const titleBar = el(
      'header',
      { class: 'recipe-card-header' },
      el('h3', { class: 'recipe-card-title' }, recipe.title),
      el(
        'button',
        {
          class: `tried-toggle${recipe.tried ? ' tried-toggle-on' : ''}`,
          title: recipe.tried ? 'Marked as tried — click to unmark' : 'Mark as tried',
          'aria-label': recipe.tried ? 'Mark as not yet tried' : 'Mark as tried',
          onclick: (e) => {
            e.stopPropagation();
            handleToggleTried(recipe);
          },
        },
        recipe.tried ? '✓' : '○'
      )
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
    if (!recipe.active) {
      card.appendChild(el('div', { class: 'recipe-inactive-badge' }, 'Deactivated'));
    }
    return card;
  }

  async function handleToggleTried(recipe) {
    const nextTried = !recipe.tried;
    try {
      await API.setTried(recipe.id, nextTried);
      recipe.tried = nextTried;
      renderLibrary();
    } catch (err) {
      console.error('Tried toggle failed', err);
      alert('Could not update tried status. Try again?');
    }
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
      meta.appendChild(
        el(
          'span',
          { class: `status-badge${recipe.tried ? ' status-tried' : ' status-untried'}` },
          recipe.tried ? '✓ Tried' : '○ Want to make'
        )
      );
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

      $('detail-deactivate').hidden = !recipe.active;
      $('detail-reactivate').hidden = recipe.active;

      showModal('detail-modal');
    } catch (err) {
      console.error('Open detail failed', err);
      alert('Could not load recipe. Try again?');
    }
  }

  function initDetailModal() {
    $('detail-edit').addEventListener('click', () => {
      if (!state.detail) return;
      const recipe = state.detail;
      hideModal('detail-modal');
      openEditModal(recipe);
    });
    $('detail-deactivate').addEventListener('click', async () => {
      if (!state.detail) return;
      const btn = $('detail-deactivate');
      if (btn.disabled) return;
      if (!confirm('Deactivate this recipe? It will be hidden from the library but past planned meals will keep their reference.')) return;
      btn.disabled = true;
      try {
        await API.setActive(state.detail.id, false);
        hideModal('detail-modal');
        state.detail = null;
        await loadRecipes();
        renderLibrary();
      } finally {
        btn.disabled = false;
      }
    });
    $('detail-reactivate').addEventListener('click', async () => {
      if (!state.detail) return;
      const btn = $('detail-reactivate');
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await API.setActive(state.detail.id, true);
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
    $('field-tried').checked = !!recipe.tried;

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

    const tried = $('field-tried').checked ? 1 : 0;
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

    const payload = { title, slot_categories: slots, tried, source, steps, notes, ingredients };

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

  const SLOT_LETTERS = { breakfast: 'B', lunch: 'L', dinner: 'D' };
  const SLOT_ORDER = { breakfast: 0, lunch: 1, dinner: 2 };
  const EATER_LABELS = { parke: 'Parke', emmet: 'Emmet', shared: 'Shared' };

  const cal = {
    view: 'month',
    focusDate: isoToday(),
    meals: [],
    selectedDate: null,
    loadedRange: { start: '', end: '' },
    today: isoToday(),
  };

  async function loadMealsForRange(start, end) {
    const res = await fetch(`/api/planned-meals?start=${start}&end=${end}`);
    if (!res.ok) throw new Error(`listMeals ${res.status}`);
    cal.meals = await res.json();
    cal.loadedRange = { start, end };
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
        if (cal.view === view) return;
        cal.view = view;
        cal.selectedDate = null;
        for (const b of $$('.view-pill')) b.classList.toggle('active', b === btn);
        renderCalendar();
      });
    }
    $('cal-cook').addEventListener('click', () => openCookModal());

    initMealModal();
    initCookModal();
  }

  function shiftFocus(direction) {
    if (cal.view === 'month') {
      const d = isoParse(cal.focusDate);
      // Snap day to 1 before shifting month, otherwise Jan 31 + 1 rolls to Mar 3
      // because JS setUTCMonth overflows rather than clamping.
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + direction);
      cal.focusDate = isoFormat(d);
    } else if (cal.view === 'week') {
      cal.focusDate = addDays(cal.focusDate, direction * 7);
    } else {
      cal.focusDate = addDays(cal.focusDate, direction);
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
    } else if (cal.view === 'week') {
      const weekStart = addDays(cal.focusDate, -dayOfWeek(cal.focusDate));
      const weekEnd = addDays(weekStart, 6);
      title.textContent = `${prettyDateLabel(weekStart)} — ${prettyDateLabel(weekEnd)}`;
      await loadMealsForRange(weekStart, weekEnd);
      renderWeekView(main, weekStart);
    } else {
      title.textContent = prettyDateLabel(cal.focusDate);
      await loadMealsForRange(cal.focusDate, cal.focusDate);
      renderDayView(main, cal.focusDate);
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
    if (meal.recipe_id) cls.push(`eater-${meal.eater}`);
    else cls.push('free-text', `eater-${meal.eater}`);
    if (meal.status === 'eaten') cls.push('eaten');

    const chip = el(
      'div',
      {
        class: cls.join(' '),
        draggable: 'true',
        title: `${EATER_LABELS[meal.eater]} · ${meal.slot} · ${mealTitle(meal)}`,
      },
      el('span', { class: 'slot-letter' }, SLOT_LETTERS[meal.slot]),
      meal.cooking_session_id ? el('span', { class: 'session-glyph', 'aria-hidden': 'true' }, '🍳') : null,
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
        alert('That day already has a meal for this slot and eater. Delete or move the existing one first.');
      } else {
        console.error('Reschedule failed', err);
        alert('Could not move that meal. Try again?');
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

  // ── Day view ─────────────────────────────────────────────────────────────

  function renderDayView(main, date) {
    const meals = mealsOnDate(date);
    const grid = el('div', { class: 'day-view-grid' });
    grid.appendChild(el('div', { class: 'day-view-header' }, ''));
    for (const eater of ['parke', 'emmet', 'shared']) {
      grid.appendChild(el('div', { class: 'day-view-header' }, EATER_LABELS[eater]));
    }
    for (const slot of ['breakfast', 'lunch', 'dinner']) {
      grid.appendChild(
        el('div', { class: 'day-view-slot-label' }, slot[0].toUpperCase() + slot.slice(1))
      );
      for (const eater of ['parke', 'emmet', 'shared']) {
        const cell = el('div', { class: 'day-view-cell' });
        const found = meals.find((m) => m.slot === slot && m.eater === eater);
        if (found) {
          cell.appendChild(renderMealSummary(found));
        } else {
          cell.appendChild(
            el(
              'button',
              {
                class: 'add-meal-btn',
                onclick: () => openMealModal({ mode: 'create', date, slot, eater }),
              },
              '+ add'
            )
          );
        }
        grid.appendChild(cell);
      }
    }
    main.appendChild(grid);
  }

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
      const group = el(
        'div',
        { class: 'slot-group' },
        el('div', { class: 'slot-group-title' }, slot[0].toUpperCase() + slot.slice(1))
      );
      for (const eater of ['parke', 'emmet', 'shared']) {
        const found = meals.find((m) => m.slot === slot && m.eater === eater);
        const row = el(
          'div',
          { class: 'eater-row' },
          el('span', { class: `eater-label eater-${eater}-label` }, EATER_LABELS[eater]),
          el(
            'div',
            { class: 'eater-slot-content' },
            found
              ? renderMealSummary(found)
              : el(
                  'button',
                  {
                    class: 'add-meal-btn',
                    onclick: () => openMealModal({ mode: 'create', date, slot, eater }),
                  },
                  '+ add'
                )
          ),
          found ? renderEatenToggle(found) : el('span', {})
        );
        group.appendChild(row);
      }
      side.appendChild(group);
    }
  }

  function renderMealSummary(meal) {
    return el(
      'div',
      {
        class: `meal-summary${meal.status === 'eaten' ? ' eaten' : ''}`,
        onclick: () => openMealModal({ mode: 'edit', meal }),
      },
      meal.cooking_session_id ? el('span', { 'aria-hidden': 'true' }, '🍳 ') : null,
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
            alert('Could not update meal status.');
          }
        },
      },
      meal.status === 'eaten' ? '✓' : '○'
    );
  }

  // ── Meal picker modal ────────────────────────────────────────────────────

  let mealModalState = null; // { mode, date, slot, eater, mealId? }

  function initMealModal() {
    $('meal-save').addEventListener('click', handleMealSave);
    $('meal-delete').addEventListener('click', handleMealDelete);
    $('meal-recipe').addEventListener('change', () => {
      if ($('meal-recipe').value) {
        $('meal-free-text').value = '';
      }
    });
    $('meal-free-text').addEventListener('input', () => {
      if ($('meal-free-text').value.trim()) $('meal-recipe').value = '';
    });
    for (const btn of $$('#meal-free-row .quick-pill')) {
      btn.addEventListener('click', () => {
        $('meal-recipe').value = '';
        $('meal-free-text').value = btn.dataset.quick;
      });
    }
  }

  async function openMealModal({ mode, date, slot, eater, meal }) {
    let actual = { date, slot, eater };
    let mealId = null;
    let current = { recipeId: '', freeText: '', notes: '', status: 'planned' };
    if (mode === 'edit' && meal) {
      actual = { date: meal.date, slot: meal.slot, eater: meal.eater };
      mealId = meal.id;
      current = {
        recipeId: meal.recipe_id ? String(meal.recipe_id) : '',
        freeText: meal.free_text || '',
        notes: meal.notes || '',
        status: meal.status,
      };
    }
    mealModalState = { mode, ...actual, mealId, originalStatus: current.status };

    $('meal-title').textContent = mode === 'edit' ? 'Edit meal' : 'Plan a meal';
    $('meal-delete').hidden = mode !== 'edit';

    // Context badge — what are we planning?
    const ctx = $('meal-context');
    ctx.innerHTML = '';
    ctx.appendChild(el('span', { class: `meal-context-badge eater-${actual.eater}-label` }, EATER_LABELS[actual.eater]));
    ctx.appendChild(el('span', {}, `· ${actual.slot} · ${prettyDateLabel(actual.date)}`));

    // Populate recipe dropdown (filtered to this slot).
    const sel = $('meal-recipe');
    sel.innerHTML = '<option value="">— Free text / leftovers / eating out —</option>';
    try {
      // Include inactive in edit mode so a deactivated recipe the meal still
      // references stays selectable. In create mode only show active recipes.
      const params = new URLSearchParams({ slot: actual.slot });
      if (mode === 'edit') params.set('include_inactive', '1');
      const recipes = await api('GET', `/api/recipes?${params.toString()}`);
      recipes.sort((a, b) => a.title.localeCompare(b.title));
      let foundCurrent = false;
      for (const r of recipes) {
        const opt = el('option', { value: String(r.id) }, r.title + (r.active ? '' : ' (deactivated)'));
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
    $('meal-notes').value = current.notes;
    $('meal-errors').hidden = true;
    $('meal-errors').textContent = '';

    showModal('meal-modal');
    sel.focus();
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
          eater: mealModalState.eater,
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
    if (!confirm('Delete this meal from the calendar?')) return;
    const btn = $('meal-delete');
    btn.disabled = true;
    try {
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

  // ── Cooking session modal ────────────────────────────────────────────────

  function initCookModal() {
    $('cook-add-serves').addEventListener('click', () => addServesRow());
    $('cook-save').addEventListener('click', handleCookSave);
    $('cook-recipe').addEventListener('change', () => {
      if ($('cook-recipe').value) $('cook-free-text').value = '';
    });
    $('cook-free-text').addEventListener('input', () => {
      if ($('cook-free-text').value.trim()) $('cook-recipe').value = '';
    });
  }

  async function openCookModal() {
    const today = isoToday();
    $('cook-date').value = today;
    $('cook-slot').value = 'dinner';
    $('cook-free-text').value = '';
    $('cook-notes').value = '';
    $('cook-errors').hidden = true;
    $('cook-errors').textContent = '';

    const sel = $('cook-recipe');
    sel.innerHTML = '<option value="">— Free text / leftovers —</option>';
    try {
      const recipes = await api('GET', '/api/recipes');
      recipes.sort((a, b) => a.title.localeCompare(b.title));
      for (const r of recipes) {
        sel.appendChild(el('option', { value: String(r.id) }, r.title));
      }
    } catch (err) {
      console.error('Load recipes failed', err);
    }

    $('cook-serves-rows').innerHTML = '';
    // Default: two serve rows for shared dinner on cook date and the next day.
    addServesRow({ date: today, slot: 'dinner', eater: 'shared' });
    addServesRow({ date: addDays(today, 1), slot: 'dinner', eater: 'shared' });

    showModal('cook-modal');
    sel.focus();
  }

  function addServesRow(prefill) {
    const rows = $('cook-serves-rows');
    const dateInput = el('input', {
      type: 'date',
      value: prefill ? prefill.date : $('cook-date').value,
    });
    const slotSel = el('select', {});
    for (const s of ['breakfast', 'lunch', 'dinner']) {
      const opt = el('option', { value: s }, s[0].toUpperCase() + s.slice(1));
      if (prefill && prefill.slot === s) opt.selected = true;
      else if (!prefill && s === 'dinner') opt.selected = true;
      slotSel.appendChild(opt);
    }
    const eaterSel = el('select', {});
    for (const e of ['parke', 'emmet', 'shared']) {
      const opt = el('option', { value: e }, EATER_LABELS[e]);
      if (prefill && prefill.eater === e) opt.selected = true;
      else if (!prefill && e === 'shared') opt.selected = true;
      eaterSel.appendChild(opt);
    }
    const row = el(
      'div',
      { class: 'serves-row' },
      dateInput,
      slotSel,
      eaterSel,
      el(
        'button',
        {
          type: 'button',
          class: 'serves-remove',
          'aria-label': 'Remove meal',
          onclick: () => row.remove(),
        },
        '✕'
      )
    );
    rows.appendChild(row);
  }

  async function handleCookSave() {
    const btn = $('cook-save');
    if (btn.disabled) return;
    const errors = [];
    const recipeId = $('cook-recipe').value;
    const freeText = $('cook-free-text').value.trim();
    if (!recipeId && !freeText) errors.push('Pick a recipe or type free text.');
    if (recipeId && freeText) errors.push('Choose either a recipe or free text.');
    const cookDate = $('cook-date').value;
    if (!cookDate) errors.push('Pick a cook date.');
    const cookSlot = $('cook-slot').value;

    const serves = $$('.serves-row', $('cook-serves-rows'))
      .map((row) => {
        const [dateInput, slotSel, eaterSel] = row.querySelectorAll('input, select');
        return { date: dateInput.value, slot: slotSel.value, eater: eaterSel.value };
      })
      .filter((s) => s.date);
    if (serves.length === 0) errors.push('Add at least one meal the cooking feeds.');

    if (errors.length) return showCookError(errors);

    const body = {
      cook_date: cookDate,
      cook_slot: cookSlot,
      notes: $('cook-notes').value.trim() || null,
      serves,
    };
    if (recipeId) body.recipe_id = Number(recipeId);
    else body.free_text = freeText;

    btn.disabled = true;
    try {
      await api('POST', '/api/cooking-sessions', body);
      hideModal('cook-modal');
      await renderCalendar();
    } catch (err) {
      showCookError(extractErrorMessages(err));
    } finally {
      btn.disabled = false;
    }
  }

  function showCookError(msgs) {
    const box = $('cook-errors');
    box.innerHTML = '';
    for (const m of msgs) box.appendChild(el('div', {}, m));
    box.hidden = false;
  }

  // ── Modal controller ─────────────────────────────────────────────────────

  function showModal(id) {
    $(id).hidden = false;
    document.body.classList.add('modal-open');
  }
  function hideModal(id) {
    $(id).hidden = true;
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
    initModalDismiss();
    renderLibrary();
    // Render calendar lazily on first visit.
    let calendarRendered = false;
    const calTab = document.querySelector('.tab[data-panel="calendar"]');
    calTab.addEventListener('click', () => {
      if (!calendarRendered) {
        calendarRendered = true;
        renderCalendar().catch((err) => console.error('Calendar render failed:', err));
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
