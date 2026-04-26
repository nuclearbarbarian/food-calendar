---
name: recipe-shelve
description: Read a recipe from a photo (cookbook page, recipe card, screenshot) and shelve it into the Food calendar's recipe library. Uses vision OCR, maps units to the canonical list, asks the user to confirm each parsed field, and POSTs to the Food API.
user-invocable: true
disable-model-invocation: true
argument-hint: [--slot breakfast|lunch|dinner] [--source "Cookbook name"] [--tried] <path-to-photo>
---

# Recipe Shelve

Take a recipe Parke has photographed (cookbook page, magazine clip, handwritten card) and shelve it into the Food app's recipe library. The skill is interactive — it proposes a parsed recipe, asks for corrections, and only POSTs when the user confirms.

## When to use

The user invokes this skill explicitly with `/recipe-shelve <photo>`. Don't trigger automatically. Examples:

- `/recipe-shelve ~/Desktop/lasagna.jpg`
- `/recipe-shelve --slot dinner --source "NYT Cooking" ./photo.png`
- `/recipe-shelve --tried --slot lunch /tmp/sandwich.heic`

## Required environment

Before doing anything else, check that these env vars are set:

- `FOOD_BASE_URL` — defaults to `https://parkes-food.fly.dev` if unset. Set to `http://localhost:3000` for local dev.
- `FOOD_AUTH_USER` — HTTP Basic Auth username
- `FOOD_AUTH_PASS` — HTTP Basic Auth password

If `FOOD_AUTH_USER` or `FOOD_AUTH_PASS` is missing, stop immediately and tell the user:

> The Food skill needs `FOOD_AUTH_USER` and `FOOD_AUTH_PASS` set in your shell environment. Add them to `~/.zshrc` (or whatever you use) and reload, then re-run.

Do not proceed without credentials. Never paste credentials into prompts or files.

## Argument parsing

Parse `$ARGUMENTS` for these flags (order-independent, all optional):

- `--slot <breakfast|lunch|dinner>` — single slot. Can be repeated for multi-slot recipes (`--slot breakfast --slot lunch`).
- `--slots <slot1,slot2>` — comma-separated equivalent of repeated `--slot`.
- `--source "<text>"` — recipe source (cookbook name, URL, etc.). Quote if it has spaces.
- `--tried` — mark the recipe as already-tried. Default is "want to make" (`tried=false`).

Everything else is the **photo path** (one path per invocation). Resolve `~` to `$HOME`.

## Workflow

### 1. Verify the photo

Read the image at the given path. If it doesn't exist, report and stop. If multiple paths were supplied, report that the skill takes one photo at a time and stop.

### 2. Extract the recipe

Look at the photo and extract:

- **Title** — the recipe name. If multiple recipes are on the page, pick the most prominent one and note that there are others ("I see 'Pumpkin Soup' and 'Cornbread' on this page — I'll shelve Pumpkin Soup. Run again for the other.").
- **Source** — if visible (cookbook chapter, magazine name, byline), capture it. Otherwise leave null and use the `--source` flag if provided.
- **Ingredients** — every ingredient line with its quantity and unit, in the order shown. See unit mapping below.
- **Steps** — the cooking instructions, preserving the order. Newline-separated. If the source uses numbered steps, keep the numbers in the text.

### 3. Map units to the canonical list

The Food database uses this exact unit set — anything else gets rejected:

```
count, pinch, dash, tsp, tbsp, cup, fl_oz, pint, quart, gallon,
ml, l, oz, lb, g, kg, to_taste
```

Map common phrasings:

| What the recipe says | Canonical unit |
| --- | --- |
| `cup`, `cups`, `c.` | `cup` |
| `tablespoon(s)`, `Tbsp`, `tbsp`, `T.` | `tbsp` |
| `teaspoon(s)`, `tsp`, `t.` | `tsp` |
| `pound(s)`, `lb`, `lbs`, `#` | `lb` |
| `ounce(s)`, `oz` (weight) | `oz` |
| `fluid ounce(s)`, `fl oz`, `fl. oz.` | `fl_oz` |
| `gram(s)`, `g` | `g` |
| `kilogram(s)`, `kg` | `kg` |
| `milliliter(s)`, `ml`, `mL` | `ml` |
| `liter(s)`, `l`, `L` | `l` |
| `pint`, `quart`, `gallon` | `pint` / `quart` / `gallon` |
| `pinch of`, `dash of`, `splash of` | `pinch` / `dash` / `dash` |
| `to taste`, `as needed` | `to_taste` |
| Bare numbers ("2 eggs", "1 onion", "3 cloves garlic") | `count` |

**Ambiguous cases — ask the user:**
- Bare `oz` could be weight (`oz`) or fluid (`fl_oz`). For dry/solid ingredients assume weight; for liquids ask. ("Is `8 oz milk` weight ounces or fluid ounces?")
- `cup` is almost always volume `cup`, but if context suggests weight (uncommon), ask.

If you can't map an ingredient unit cleanly, leave it null and put the unit name in the ingredient text — Parke can fix in the UI.

### 4. Parse quantities (fractions and decimals)

Accept these forms and convert to decimal:

- `1/2` → `0.5`
- `1 1/2` → `1.5`
- `½` → `0.5`, `¼` → `0.25`, `¾` → `0.75`, `⅓` → `0.333`, `⅔` → `0.667`
- `0.5`, `.5`, `1.` — all valid decimals
- `2-3` (range) → use the lower bound (2) and add a note in the ingredient text ("2 to 3 onions")
- "a few", "some", "to taste" → quantity null, unit `to_taste`

### 5. Determine slot categories

Required: at least one of `breakfast`, `lunch`, `dinner`.

If the user passed `--slot` / `--slots` flags, use those (validate each is one of the three).

Otherwise **ask**:

> Which meal slots? (breakfast / lunch / dinner — pick one or more, comma-separated)

Don't guess from recipe content (pancakes don't always = breakfast). Always ask if no flag was provided.

### 6. Propose the parsed recipe

Show the user a clean structured proposal. Format:

```
Title: <title>
Slots: <comma-separated>
Source: <source or "(none)">
Tried: <yes/no>

Ingredients:
  <qty> <unit> <name>
  ...

Steps:
<steps as text>

Does this look right? Tell me any corrections (edit any field freely), or "confirm" to shelve.
```

### 7. Iterate on corrections

If the user replies with corrections like:
- "change the title to X"
- "the butter should be 3 tbsp"
- "remove the salt line"
- "add 1 tsp vanilla after the eggs"
- "the steps are wrong, here's what they should be: …"

Apply the change in your local representation and re-show the updated proposal. Repeat until they say "confirm" / "looks good" / "save it" / similar.

### 8. POST to the Food API

Once confirmed, build the request body:

```json
{
  "title": "<title>",
  "slot_categories": ["<slot1>", ...],
  "tried": 0|1,
  "source": "<source>" | null,
  "steps": "<steps>" | null,
  "notes": null,
  "ingredients": [
    { "name": "<name>", "quantity": <number|null>, "unit": "<canonical>" | null },
    ...
  ]
}
```

Then call:

```bash
curl -sS -X POST "${FOOD_BASE_URL:-https://parkes-food.fly.dev}/api/recipes" \
  -u "$FOOD_AUTH_USER:$FOOD_AUTH_PASS" \
  -H "Content-Type: application/json" \
  -d @/tmp/recipe-payload.json
```

(Write the JSON to a temp file rather than passing inline to avoid shell-escaping headaches with quotes/newlines in steps.)

### 9. Report the result

On HTTP 201, print:

> Shelved! Recipe #<id> "<title>" is in the library.
> View at <FOOD_BASE_URL>/

On HTTP 401: tell the user their credentials are wrong; don't retry.
On HTTP 400: print the validation errors verbatim (the API returns `{errors: [...]}`); offer to let the user correct and re-confirm.
On HTTP 5xx: print the status and body; suggest they retry.
On any other failure: print the full curl output. Don't silently swallow.

After shelving, clean up the temp file.

## What NOT to do

- Don't upload the photo to the server — `photo_path` stays null in this version.
- Don't shelve without explicit confirmation, even if everything looks right.
- Don't write credentials to any file or echo them.
- Don't try to batch-shelve from a directory in this version (one photo per invocation).
- Don't re-read the photo on every iteration — keep your parsed structure in working memory and edit it as the user requests.
- Don't invent slot categories. If the user didn't pass `--slot` and didn't answer when asked, stop and ask again.
- Don't normalize ingredient names ("yellow onion" stays "yellow onion" — those distinctions matter for cooking and for the Food shopping-list aggregation).

## Notes for future iterations (don't act on these now)

- Phase 7 polish: photo upload to a server-side `/api/recipes/:id/photo` endpoint so the recipe card can show the original photo
- Batch mode: `recipe-shelve dir/*.jpg` walking each
- A "redo last shelve" command for when Parke notices a mistake in her library
