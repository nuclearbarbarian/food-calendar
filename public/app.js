'use strict';

// Phase 0 scaffold: tab switching + config fetch. Real views land in Phase 1+.

(function () {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const panels = {
    calendar: document.getElementById('panel-calendar'),
    recipes: document.getElementById('panel-recipes'),
    menus: document.getElementById('panel-menus'),
    shopping: document.getElementById('panel-shopping'),
  };

  function switchTo(name) {
    for (const tab of tabs) {
      const active = tab.dataset.panel === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const [key, el] of Object.entries(panels)) {
      el.hidden = key !== name;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => switchTo(tab.dataset.panel));
  }

  // Prefetch config so Phase 1 can rely on it being cached on window.
  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      window.__FOOD_CONFIG__ = cfg;
    })
    .catch(() => {});
})();
