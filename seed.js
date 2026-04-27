'use strict';

require('dotenv').config();
const { openDb } = require('./db');

const DB_PATH = process.env.DB_PATH || './food.db';

const RECIPES = [
  {
    title: 'Overnight Oats with Berries',
    slots: ['breakfast'],
    tried: 1,
    steps: 'Combine oats, milk, yogurt, chia, and maple syrup in a jar. Refrigerate overnight. Top with berries.',
    ingredients: [
      { name: 'rolled oats', quantity: 0.5, unit: 'cup' },
      { name: 'milk', quantity: 0.75, unit: 'cup' },
      { name: 'greek yogurt', quantity: 0.25, unit: 'cup' },
      { name: 'chia seeds', quantity: 1, unit: 'tbsp' },
      { name: 'maple syrup', quantity: 1, unit: 'tsp' },
      { name: 'mixed berries', quantity: 0.5, unit: 'cup' },
    ],
  },
  {
    title: 'Scrambled Eggs & Toast',
    slots: ['breakfast'],
    tried: 1,
    steps: 'Whisk eggs with a splash of milk. Scramble in butter over low heat. Serve with buttered toast.',
    ingredients: [
      { name: 'eggs', quantity: 3, unit: 'count' },
      { name: 'butter', quantity: 1, unit: 'tbsp' },
      { name: 'milk', quantity: 1, unit: 'tbsp' },
      { name: 'sourdough bread', quantity: 2, unit: 'count' },
      { name: 'salt', quantity: null, unit: 'to_taste' },
    ],
  },
  {
    title: 'Yogurt Parfait',
    slots: ['breakfast'],
    tried: 0,
    steps: 'Layer yogurt, granola, and fruit in a glass. Drizzle with honey.',
    ingredients: [
      { name: 'greek yogurt', quantity: 1, unit: 'cup' },
      { name: 'granola', quantity: 0.5, unit: 'cup' },
      { name: 'strawberries', quantity: 0.5, unit: 'cup' },
      { name: 'honey', quantity: 1, unit: 'tsp' },
    ],
  },
  {
    title: 'Avocado Toast with Egg',
    slots: ['breakfast', 'lunch'],
    tried: 1,
    steps: 'Toast bread. Mash avocado with lemon and salt. Top with a fried egg and red pepper flakes.',
    ingredients: [
      { name: 'sourdough bread', quantity: 1, unit: 'count' },
      { name: 'avocado', quantity: 0.5, unit: 'count' },
      { name: 'eggs', quantity: 1, unit: 'count' },
      { name: 'lemon', quantity: 0.25, unit: 'count' },
      { name: 'red pepper flakes', quantity: null, unit: 'to_taste' },
    ],
  },
  {
    title: 'Banana Pancakes',
    slots: ['breakfast'],
    tried: 0,
    steps: 'Blend banana, eggs, flour, baking powder. Cook small pancakes in butter. Serve with maple syrup.',
    ingredients: [
      { name: 'banana', quantity: 1, unit: 'count' },
      { name: 'eggs', quantity: 2, unit: 'count' },
      { name: 'flour', quantity: 0.5, unit: 'cup' },
      { name: 'baking powder', quantity: 1, unit: 'tsp' },
      { name: 'butter', quantity: 1, unit: 'tbsp' },
      { name: 'maple syrup', quantity: 2, unit: 'tbsp' },
    ],
  },
  {
    title: 'Caprese Sandwich',
    slots: ['lunch'],
    tried: 1,
    steps: 'Layer mozzarella, tomato, and basil on ciabatta. Drizzle olive oil and balsamic. Salt and pepper.',
    ingredients: [
      { name: 'ciabatta roll', quantity: 1, unit: 'count' },
      { name: 'fresh mozzarella', quantity: 3, unit: 'oz' },
      { name: 'tomato', quantity: 1, unit: 'count' },
      { name: 'fresh basil', quantity: 0.25, unit: 'cup' },
      { name: 'olive oil', quantity: 1, unit: 'tbsp' },
      { name: 'balsamic vinegar', quantity: 1, unit: 'tsp' },
    ],
  },
  {
    title: 'Chicken Caesar Salad',
    slots: ['lunch', 'dinner'],
    tried: 1,
    steps: 'Grill chicken and slice. Toss romaine with Caesar dressing, parmesan, and croutons. Top with chicken.',
    ingredients: [
      { name: 'chicken breast', quantity: 8, unit: 'oz' },
      { name: 'romaine lettuce', quantity: 1, unit: 'count' },
      { name: 'parmesan', quantity: 0.25, unit: 'cup' },
      { name: 'croutons', quantity: 0.5, unit: 'cup' },
      { name: 'caesar dressing', quantity: 3, unit: 'tbsp' },
    ],
  },
  {
    title: 'Tomato Soup & Grilled Cheese',
    slots: ['lunch'],
    tried: 1,
    steps: 'Heat tomato soup. Butter bread, add cheddar, grill until golden. Serve together.',
    ingredients: [
      { name: 'tomato soup', quantity: 2, unit: 'cup' },
      { name: 'sourdough bread', quantity: 4, unit: 'count' },
      { name: 'cheddar cheese', quantity: 4, unit: 'oz' },
      { name: 'butter', quantity: 2, unit: 'tbsp' },
    ],
  },
  {
    title: 'Chickpea Salad Wrap',
    slots: ['lunch'],
    tried: 0,
    steps: 'Mash chickpeas with yogurt, lemon, celery, and herbs. Wrap in a tortilla with greens.',
    ingredients: [
      { name: 'chickpeas', quantity: 1, unit: 'cup' },
      { name: 'greek yogurt', quantity: 2, unit: 'tbsp' },
      { name: 'lemon', quantity: 0.5, unit: 'count' },
      { name: 'celery', quantity: 1, unit: 'count' },
      { name: 'tortilla', quantity: 1, unit: 'count' },
      { name: 'mixed greens', quantity: 0.5, unit: 'cup' },
    ],
  },
  {
    title: 'Turkey & Brie Baguette',
    slots: ['lunch'],
    tried: 0,
    steps: 'Spread fig jam on baguette. Layer turkey, brie, and arugula. Press gently.',
    ingredients: [
      { name: 'baguette', quantity: 1, unit: 'count' },
      { name: 'sliced turkey', quantity: 4, unit: 'oz' },
      { name: 'brie cheese', quantity: 2, unit: 'oz' },
      { name: 'fig jam', quantity: 1, unit: 'tbsp' },
      { name: 'arugula', quantity: 0.5, unit: 'cup' },
    ],
  },
  {
    title: 'Sheet Pan Chicken & Vegetables',
    slots: ['dinner'],
    tried: 1,
    steps: 'Toss chicken thighs and vegetables with olive oil and herbs. Roast at 425°F for 30–35 min.',
    ingredients: [
      { name: 'chicken thighs', quantity: 1.5, unit: 'lb' },
      { name: 'broccoli', quantity: 1, unit: 'count' },
      { name: 'carrots', quantity: 3, unit: 'count' },
      { name: 'olive oil', quantity: 2, unit: 'tbsp' },
      { name: 'garlic', quantity: 3, unit: 'count' },
      { name: 'dried oregano', quantity: 1, unit: 'tsp' },
    ],
  },
  {
    title: 'Spaghetti Bolognese',
    slots: ['dinner'],
    tried: 1,
    steps: 'Brown beef with onion and garlic. Add tomato and simmer 30 min. Toss with cooked spaghetti.',
    ingredients: [
      { name: 'spaghetti', quantity: 1, unit: 'lb' },
      { name: 'ground beef', quantity: 1, unit: 'lb' },
      { name: 'onion', quantity: 1, unit: 'count' },
      { name: 'garlic', quantity: 3, unit: 'count' },
      { name: 'crushed tomatoes', quantity: 28, unit: 'oz' },
      { name: 'parmesan', quantity: 0.25, unit: 'cup' },
    ],
  },
  {
    title: 'Salmon with Rice and Greens',
    slots: ['dinner'],
    tried: 1,
    steps: 'Bake salmon with lemon and olive oil at 400°F for 12 min. Serve over rice with sautéed spinach.',
    ingredients: [
      { name: 'salmon fillet', quantity: 1, unit: 'lb' },
      { name: 'jasmine rice', quantity: 1, unit: 'cup' },
      { name: 'spinach', quantity: 6, unit: 'oz' },
      { name: 'lemon', quantity: 1, unit: 'count' },
      { name: 'olive oil', quantity: 2, unit: 'tbsp' },
      { name: 'garlic', quantity: 2, unit: 'count' },
    ],
  },
  {
    title: 'Black Bean Tacos',
    slots: ['dinner'],
    tried: 0,
    steps: 'Warm tortillas. Simmer black beans with cumin and lime. Top with avocado, cheese, and salsa.',
    ingredients: [
      { name: 'corn tortillas', quantity: 8, unit: 'count' },
      { name: 'black beans', quantity: 2, unit: 'cup' },
      { name: 'cumin', quantity: 1, unit: 'tsp' },
      { name: 'lime', quantity: 1, unit: 'count' },
      { name: 'avocado', quantity: 1, unit: 'count' },
      { name: 'cheddar cheese', quantity: 3, unit: 'oz' },
      { name: 'salsa', quantity: 0.5, unit: 'cup' },
    ],
  },
  {
    title: 'Miso Glazed Tofu with Bok Choy',
    slots: ['dinner'],
    tried: 0,
    steps: 'Whisk miso, soy, honey, ginger. Brush on tofu and broil 8 min. Sauté bok choy in sesame oil.',
    ingredients: [
      { name: 'firm tofu', quantity: 14, unit: 'oz' },
      { name: 'white miso', quantity: 2, unit: 'tbsp' },
      { name: 'soy sauce', quantity: 1, unit: 'tbsp' },
      { name: 'honey', quantity: 1, unit: 'tbsp' },
      { name: 'fresh ginger', quantity: 1, unit: 'tsp' },
      { name: 'bok choy', quantity: 2, unit: 'count' },
      { name: 'sesame oil', quantity: 1, unit: 'tbsp' },
    ],
  },
];

function seed() {
  const db = openDb(DB_PATH);

  const existing = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  if (existing > 0) {
    console.log(`DB already has ${existing} recipes. Skipping seed.`);
    db.close();
    return;
  }

  const insertRecipe = db.prepare(`
    INSERT INTO recipes (title, tried, steps)
    VALUES (@title, @tried, @steps)
  `);
  const insertSlot = db.prepare(`
    INSERT OR IGNORE INTO recipe_slots (recipe_id, slot) VALUES (?, ?)
  `);
  const insertIngredient = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit, sort_order)
    VALUES (@recipe_id, @name, @quantity, @unit, @sort_order)
  `);

  const seedAll = db.transaction((recipes) => {
    for (const r of recipes) {
      const { lastInsertRowid } = insertRecipe.run({
        title: r.title,
        tried: r.tried,
        steps: r.steps,
      });
      for (const slot of r.slots) insertSlot.run(lastInsertRowid, slot);
      r.ingredients.forEach((ing, i) => {
        insertIngredient.run({
          recipe_id: lastInsertRowid,
          name: ing.name,
          quantity: ing.quantity,
          unit: ing.unit,
          sort_order: i,
        });
      });
    }
  });

  seedAll(RECIPES);
  console.log(`Seeded ${RECIPES.length} recipes.`);
  db.close();
}

seed();
