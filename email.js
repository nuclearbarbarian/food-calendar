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

function formatFriendlyDate(isoDate, tz) {
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

function buildDigestHtml({ date, meals, tz }) {
  const friendly = formatFriendlyDate(date, tz);
  const buckets = groupByEater(meals);

  const eaterSections = EATER_ORDER.map((eater) => {
    const list = buckets[eater];
    if (list.length === 0) {
      return ''; // Skip eaters with no meals today.
    }
    const tint = COLORS[`${eater}Tint`];
    const accent = COLORS[eater];
    const rows = list.map((meal) => renderMealRow(meal, accent)).join('');
    return `
      <section style="margin-bottom: 28px;">
        <h2 style="
          font-family: Georgia, 'EB Garamond', serif;
          font-size: 18px;
          font-weight: 600;
          color: ${COLORS.cocoa};
          background: ${tint};
          border-left: 4px solid ${accent};
          padding: 8px 14px;
          margin: 0 0 12px 0;
          border-radius: 4px;
        ">
          ${escapeHtml(EATER_LABELS[eater])}
        </h2>
        ${rows}
      </section>
    `;
  }).join('');

  const allEmpty = EATER_ORDER.every((e) => buckets[e].length === 0);
  const body = allEmpty
    ? `<p style="color: ${COLORS.softBrown}; font-style: italic; margin: 24px 0;">
         Nothing planned yet. Open the calendar to add meals.
       </p>`
    : eaterSections;

  const ornament = '✿ ❀ ✵ ❧ ✦';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Today's menu — ${escapeHtml(friendly)}</title>
</head>
<body style="
  margin: 0;
  padding: 24px;
  background: ${COLORS.cream};
  font-family: Georgia, 'EB Garamond', serif;
  color: ${COLORS.cocoa};
  line-height: 1.5;
">
  <div style="max-width: 560px; margin: 0 auto;">
    <header style="text-align: center; padding-bottom: 16px; border-bottom: 1px solid ${COLORS.latte};">
      <div style="color: ${COLORS.parke}; letter-spacing: 8px; font-size: 16px;">${ornament}</div>
      <h1 style="
        font-family: 'Times New Roman', serif;
        font-weight: 400;
        font-size: 28px;
        margin: 8px 0 4px 0;
        color: ${COLORS.cocoa};
      ">
        Today's Menu
      </h1>
      <p style="margin: 0; color: ${COLORS.softBrown}; font-size: 14px; letter-spacing: 0.5px;">
        ${escapeHtml(friendly)}
      </p>
    </header>

    <main style="padding-top: 20px;">
      ${body}
    </main>

    <footer style="text-align: center; padding-top: 16px; border-top: 1px solid ${COLORS.latte}; color: ${COLORS.softBrown}; font-size: 12px;">
      <div style="color: ${COLORS.parke}; letter-spacing: 8px; padding-bottom: 8px;">${ornament}</div>
      From the Food calendar
    </footer>
  </div>
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
  const steps = meal.slot === 'dinner' && meal.recipe_steps && meal.recipe_steps.trim()
    ? `<div style="
         margin-top: 6px;
         padding: 8px 12px;
         background: ${COLORS.warmWhite};
         border-left: 2px solid ${COLORS.latte};
         font-size: 13px;
         color: ${COLORS.cocoa};
         white-space: pre-wrap;
         line-height: 1.5;
       ">${escapeHtml(meal.recipe_steps)}</div>`
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

async function sendDigest({ date, meals, tz, from, to, apiKey }) {
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  if (!from || !to) throw new Error('DIGEST_FROM / DIGEST_TO not set');

  const html = buildDigestHtml({ date, meals, tz });
  const text = buildDigestText({ date, meals });
  const subject = buildSubject(formatFriendlyDate(date, tz), countMeals(meals));

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

module.exports = {
  buildDigestHtml,
  buildDigestText,
  sendDigest,
  formatFriendlyDate,
  groupByEater,
  countMeals,
  buildSubject,
};
