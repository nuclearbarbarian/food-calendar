'use strict';

// Morning digest email. Renders today's planned meals grouped by eater, with
// dinner prep steps inlined. HTML uses inline styles and hardcoded hex colors
// because email clients don't support CSS variables or external stylesheets.

const { Resend } = require('resend');
const { escapeHtml } = require('./utils');

// Hardcoded from the illuminated manuscript × kawaii design system. Keep in
// sync with public/styles.css :root tokens. Email can't read CSS variables.
const COLORS = {
  cream: '#FFF8EE',
  warmWhite: '#FFFDF8',
  cocoa: '#5B4A3F',
  softBrown: '#8B7B6B',
  latte: '#D4C5B2',
  parkeTint: '#FDEDF0',
  parke: '#F2A0B0',
  emmetTint: '#E8F1F8',
  emmet: '#8CBCE0',
  sharedTint: '#F0EBF6',
  shared: '#B8A0D4',
};

const EATER_ORDER = ['parke', 'emmet', 'shared'];
const EATER_LABELS = { parke: 'Parke', emmet: 'Emmet', shared: 'Shared' };
const SLOT_ORDER = ['breakfast', 'lunch', 'dinner'];
const SLOT_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };

function mealTitle(meal) {
  if (meal.recipe_id) return meal.recipe_title || '(recipe missing)';
  return meal.free_text || '(untitled)';
}

function countMeals(meals) {
  return meals.length;
}

function buildSubject(dateLabel, mealCount) {
  if (mealCount === 0) return `${dateLabel} — nothing planned yet`;
  if (mealCount === 1) return `${dateLabel} — 1 meal planned`;
  return `${dateLabel} — ${mealCount} meals planned`;
}

// The ISO date is already in DIGEST_TZ when it reaches us (computed upstream
// via formatDate(new Date(), DIGEST_TZ)), so we format it as UTC here to avoid
// a second timezone shift. No tz arg — don't pass one, it would be ignored.
function formatFriendlyDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function groupByEater(meals) {
  const buckets = { parke: [], emmet: [], shared: [] };
  for (const meal of meals) {
    if (buckets[meal.eater]) buckets[meal.eater].push(meal);
  }
  for (const list of Object.values(buckets)) {
    list.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  }
  return buckets;
}

function buildDigestHtml({ date, meals }) {
  const friendly = formatFriendlyDate(date);
  const buckets = groupByEater(meals);

  const eaterSections = EATER_ORDER.map((eater) => {
    const list = buckets[eater];
    if (list.length === 0) return '';
    const tint = COLORS[`${eater}Tint`];
    const accent = COLORS[eater];
    const rows = list.map((meal) => renderMealRow(meal, accent)).join('');
    return `
      <tr><td style="padding-bottom: 28px;">
        <div style="
          font-family: Georgia, 'EB Garamond', serif;
          font-size: 18px;
          font-weight: 600;
          color: ${COLORS.cocoa};
          background: ${tint};
          border-left: 4px solid ${accent};
          padding: 8px 14px;
          margin: 0 0 12px 0;
          border-radius: 4px;
        ">${escapeHtml(EATER_LABELS[eater])}</div>
        ${rows}
      </td></tr>
    `;
  }).join('');

  const allEmpty = EATER_ORDER.every((e) => buckets[e].length === 0);
  const body = allEmpty
    ? `<tr><td style="color: ${COLORS.softBrown}; font-style: italic; padding: 24px 0;">
         Nothing planned yet. Open the calendar to add meals.
       </td></tr>`
    : eaterSections;

  // Wrap ornament in a symbol-friendly font stack so Outlook Desktop doesn't
  // substitute a box or Wingdings glyph. Keeps the illuminated-manuscript vibe.
  const ornamentStyle = `font-family: 'Apple Symbols','Segoe UI Symbol','Symbola',Georgia,serif; color: ${COLORS.parke}; letter-spacing: 8px;`;
  const ornament = `<span style="${ornamentStyle}">✿ ❀ ✵ ❧ ✦</span>`;

  // Table-based layout: Outlook for Windows ignores max-width on <div>.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Today's menu — ${escapeHtml(friendly)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.cream};font-family:Georgia,'EB Garamond',serif;color:${COLORS.cocoa};line-height:1.5;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.cream};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td style="padding-bottom:16px;border-bottom:1px solid ${COLORS.latte};text-align:center;">
          <div style="font-size:16px;">${ornament}</div>
          <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:28px;margin:8px 0 4px 0;color:${COLORS.cocoa};">Today's Menu</h1>
          <p style="margin:0;color:${COLORS.softBrown};font-size:14px;letter-spacing:0.5px;">
            ${escapeHtml(friendly)}
          </p>
        </td></tr>
        <tr><td style="padding-top:20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${body}
          </table>
        </td></tr>
        <tr><td style="padding-top:16px;border-top:1px solid ${COLORS.latte};color:${COLORS.softBrown};font-size:12px;text-align:center;">
          <div style="font-size:14px;padding-bottom:6px;">${ornament}</div>
          From the Food calendar
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderMealRow(meal, accent) {
  const title = mealTitle(meal);
  const isEaten = meal.status === 'eaten';
  const titleStyle = isEaten
    ? `color: ${COLORS.softBrown}; text-decoration: line-through;`
    : `color: ${COLORS.cocoa};`;

  const sessionGlyph = meal.cooking_session_id
    ? `<span title="From a cooking session" style="margin-right: 4px;">🍳</span>`
    : '';

  const byline = meal.recipe_source
    ? `<div style="color: ${COLORS.softBrown}; font-style: italic; font-size: 13px; margin-top: 2px;">
         via ${escapeHtml(meal.recipe_source)}
       </div>`
    : '';

  // Inline dinner prep steps only; breakfast/lunch are usually self-evident.
  // Split on newlines and emit <br>: pre-wrap is unreliable across Outlook/Gmail.
  const steps = meal.slot === 'dinner' && meal.recipe_steps && meal.recipe_steps.trim()
    ? `<div style="margin-top:6px;padding:8px 12px;background:${COLORS.warmWhite};border-left:2px solid ${COLORS.latte};font-size:13px;color:${COLORS.cocoa};line-height:1.5;">${
         meal.recipe_steps.split(/\r?\n/).map((line) => escapeHtml(line)).join('<br>')
       }</div>`
    : '';

  const notes = meal.notes && meal.notes.trim()
    ? `<div style="color: ${COLORS.softBrown}; font-style: italic; font-size: 13px; margin-top: 4px;">
         Note: ${escapeHtml(meal.notes)}
       </div>`
    : '';

  return `
    <div style="padding: 8px 0 10px 0; border-bottom: 1px dashed ${COLORS.latte};">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: ${COLORS.softBrown}; margin-bottom: 2px;">
        ${escapeHtml(SLOT_LABELS[meal.slot])}
      </div>
      <div style="font-size: 16px; font-weight: 600; ${titleStyle}">
        ${sessionGlyph}${escapeHtml(title)}
      </div>
      ${byline}
      ${notes}
      ${steps}
    </div>
  `;
}

function buildDigestText({ date, meals }) {
  const friendly = formatFriendlyDate(date);
  const buckets = groupByEater(meals);
  const lines = [`Today's menu — ${friendly}`, ''];

  if (meals.length === 0) {
    lines.push('Nothing planned yet. Open the calendar to add meals.');
    return lines.join('\n');
  }

  for (const eater of EATER_ORDER) {
    const list = buckets[eater];
    if (list.length === 0) continue;
    lines.push(`— ${EATER_LABELS[eater]} —`);
    for (const meal of list) {
      const prefix = meal.status === 'eaten' ? '[eaten] ' : '';
      const glyph = meal.cooking_session_id ? '(from cook session) ' : '';
      const title = mealTitle(meal);
      lines.push(`  ${SLOT_LABELS[meal.slot]}: ${prefix}${glyph}${title}`);
      if (meal.recipe_source) lines.push(`    via ${meal.recipe_source}`);
      if (meal.slot === 'dinner' && meal.recipe_steps && meal.recipe_steps.trim()) {
        lines.push(`    Prep: ${meal.recipe_steps.replace(/\s+/g, ' ').trim()}`);
      }
      if (meal.notes && meal.notes.trim()) lines.push(`    Note: ${meal.notes}`);
    }
    lines.push('');
  }
  lines.push('From the Food calendar');
  return lines.join('\n');
}

async function sendDigest({ date, meals, from, to, apiKey }) {
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  if (!from || !to) throw new Error('DIGEST_FROM / DIGEST_TO not set');

  const html = buildDigestHtml({ date, meals });
  const text = buildDigestText({ date, meals });
  const subject = buildSubject(formatFriendlyDate(date), countMeals(meals));

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to,
    subject,
    html,
    text,
  });
  if (error) throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
  return { resendId: data && data.id, subject, html, text };
}

// ── Shopping list email ───────────────────────────────────────────────────

const UNIT_LABELS_INLINE = {
  count: 'count',
  pinch: 'pinch',
  dash: 'dash',
  tsp: 'tsp',
  tbsp: 'tbsp',
  cup: 'cup',
  fl_oz: 'fl oz',
  pint: 'pint',
  quart: 'quart',
  gallon: 'gallon',
  ml: 'ml',
  l: 'L',
  oz: 'oz',
  lb: 'lb',
  g: 'g',
  kg: 'kg',
  to_taste: 'to taste',
};

function formatQuantityForEmail(q) {
  if (q == null || q === 0) return '';
  const rounded = Math.round(q * 1000) / 1000;
  return String(rounded);
}

function formatShoppingItem(item) {
  const qty = formatQuantityForEmail(item.quantity);
  const unit = item.unit || null;
  const unitLabel = unit ? UNIT_LABELS_INLINE[unit] || unit : '';
  if (unit === 'to_taste' || unit === 'pinch' || unit === 'dash') {
    const qualifier = qty ? `${qty} ${unitLabel}` : unitLabel;
    return `${item.name} (${qualifier})`;
  }
  if (unit === 'count') {
    return qty ? `${qty} ${item.name}` : item.name;
  }
  const prefix = [qty, unitLabel].filter(Boolean).join(' ');
  return prefix ? `${prefix} ${item.name}` : item.name;
}

function buildShoppingListHtml({ list, items }) {
  // Items already sorted alphabetically by the query, but enforce in case the
  // caller pre-filtered or reordered.
  const sorted = [...items].sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });

  const rows = sorted.map((item) => {
    const display = formatShoppingItem(item);
    const style = item.checked
      ? `color: ${COLORS.softBrown}; text-decoration: line-through;`
      : `color: ${COLORS.cocoa};`;
    const marker = item.checked ? '☒' : '☐';
    return `
      <tr><td style="padding: 6px 0; border-bottom: 1px dashed ${COLORS.latte}; font-size: 15px; ${style}">
        <span style="font-family: 'Apple Symbols','Segoe UI Symbol',Georgia,serif; margin-right: 8px; color: ${COLORS.softBrown};">${marker}</span>
        ${escapeHtml(display)}
      </td></tr>
    `;
  }).join('');

  const total = items.length;
  const remaining = items.filter((i) => !i.checked).length;
  const subtitle = total === 0
    ? 'No items on this list.'
    : total === remaining
      ? `${total} item${total === 1 ? '' : 's'}`
      : `${remaining} of ${total} remaining`;

  const ornamentStyle = `font-family: 'Apple Symbols','Segoe UI Symbol','Symbola',Georgia,serif; color: ${COLORS.parke}; letter-spacing: 8px;`;
  const ornament = `<span style="${ornamentStyle}">✿ ❀ ✵ ❧ ✦</span>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(list.name)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.cream};font-family:Georgia,'EB Garamond',serif;color:${COLORS.cocoa};line-height:1.5;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.cream};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td style="padding-bottom:16px;border-bottom:1px solid ${COLORS.latte};text-align:center;">
          <div style="font-size:16px;">${ornament}</div>
          <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:26px;margin:8px 0 4px 0;color:${COLORS.cocoa};">
            ${escapeHtml(list.name)}
          </h1>
          <p style="margin:0;color:${COLORS.softBrown};font-size:14px;letter-spacing:0.5px;">
            ${escapeHtml(subtitle)}
          </p>
        </td></tr>
        <tr><td style="padding-top:12px;">
          ${total === 0
            ? `<p style="color:${COLORS.softBrown};font-style:italic;padding:24px 0;">No items yet.</p>`
            : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`}
        </td></tr>
        <tr><td style="padding-top:16px;border-top:1px solid ${COLORS.latte};color:${COLORS.softBrown};font-size:12px;text-align:center;">
          <div style="font-size:14px;padding-bottom:6px;">${ornament}</div>
          From the Food calendar
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildShoppingListText({ list, items }) {
  const sorted = [...items].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const lines = [list.name, ''];
  if (items.length === 0) {
    lines.push('No items.');
  } else {
    for (const item of sorted) {
      const marker = item.checked ? '[x]' : '[ ]';
      lines.push(`  ${marker} ${formatShoppingItem(item)}`);
    }
  }
  lines.push('');
  lines.push('From the Food calendar');
  return lines.join('\n');
}

async function sendShoppingList({ list, items, from, to, apiKey }) {
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  if (!from || !to) throw new Error('DIGEST_FROM / DIGEST_TO not set');

  const html = buildShoppingListHtml({ list, items });
  const text = buildShoppingListText({ list, items });
  const total = items.length;
  const subject = total === 0
    ? `${list.name} — empty`
    : `${list.name} — ${total} item${total === 1 ? '' : 's'}`;

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({ from, to, subject, html, text });
  if (error) throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
  return { resendId: data && data.id, subject, html, text };
}

module.exports = {
  buildDigestHtml,
  buildDigestText,
  sendDigest,
  formatFriendlyDate,
  groupByEater,
  countMeals,
  buildSubject,
  buildShoppingListHtml,
  buildShoppingListText,
  sendShoppingList,
  formatShoppingItem,
};
