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
    initModalDismiss();
    renderLibrary();
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
