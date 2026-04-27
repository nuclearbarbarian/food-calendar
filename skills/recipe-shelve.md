---
name: recipe-shelve
description: Read a recipe from a photo (cookbook page, recipe card, screenshot) and shelve it into the Food calendar's recipe library. Uses vision OCR, maps units to the canonical list, asks the user to confirm each parsed field, and POSTs to the Food API.
user-invocable: true
disable-model-invocation: true
argument-hint: [--slot breakfast|lunch|dinner | --slots b,l,d] [--source "Cookbook name"] [--tried] <path-to-photo>
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

- `FOOD_AUTH_USER` — HTTP Basic Auth username (**required**)
- `FOOD_AUTH_PASS` — HTTP Basic Auth password (**required**)
- `FOOD_BASE_URL` — **optional**. Defaults to `https://parkes-food.fly.dev` if unset. Set to `http://localhost:3000` for local dev.

If either of the required vars is missing, stop immediately and tell the user:

> The Food skill needs `FOOD_AUTH_USER` and `FOOD_AUTH_PASS` set in your shell environment. Find your shell with `echo $SHELL`, add the exports to the matching rc file (`~/.zshrc` for zsh, `~/.bashrc` for bash), `source` it, then re-run.

Do not proceed without credentials. **Never echo, log, or write credentials to any file** — see §8 for how to invoke curl without leaking them.

## Argument parsing

Parse `$ARGUMENTS` for these flags (order-independent, all optional):

- `--slot <breakfast|lunch|dinner>` — single slot. Can be repeated for multi-slot recipes (`--slot breakfast --slot lunch`).
- `--slots <slot1,slot2>` — comma-separated equivalent of repeated `--slot`.
- `--source "<text>"` — recipe source (cookbook name, URL, etc.). Quote if it has spaces.
- `--tried` — mark the recipe as already-tried. Default is "want to make" (`tried=false`).
- `--` — end-of-flags sentinel. Anything after `--` is the photo path, even if it starts with `-`.

**Photo path handling:** everything not matching the above is the photo path, joined with single spaces. Mac filenames like `Screen Shot 2026-04-25 at 9.31.12 AM.png` work — treat all bare-word tokens after the last flag as one path. If two clearly distinct paths appear (both end in `.jpg`/`.png`/etc.), ask which one.

Resolve `~` to `$HOME`. Quote when invoking shell commands so spaces don't split.

## Workflow

### 1. Verify the photo

Try to read the image at the given path with the Read tool. If it doesn't exist, report and stop. If multiple paths were clearly supplied, report that the skill takes one photo at a time and stop.

**HEIC handling:** iPhones default to HEIC (`.heic` / `.HEIC`). The Read tool can sometimes process them and sometimes errors out depending on the Claude Code version. If Read fails on a HEIC, suggest the macOS one-liner:

```bash
sips -s format jpeg "<path>.heic" --out "<path>.jpg"
```

Then re-run the skill on the resulting `.jpg`. (Don't auto-execute `sips` — let the user run it so they choose where the converted file lives.)

If Read fails on any other format, ask the user to paste the photo into the chat directly or convert to JPEG/PNG manually.

### 2. Extract the recipe

Look at the photo and extract:

- **Title** — the recipe name. If multiple recipes are visible on the page, list them and **ask** which one to shelve. Don't pick automatically. ("I see 'Pumpkin Soup' and 'Cornbread' on this page. Which should I shelve? You can re-run for the other.")
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
| `liter(s)`, `l`, `L`, `lt` | `l` |
| `pint(s)`, `pt` | `pint` |
| `quart(s)`, `qt` | `quart` |
| `gallon(s)`, `gal` | `gallon` |
| `pinch of`, `dash of`, `splash of` | `pinch` / `dash` / `dash` |
| `to taste`, `as needed` | `to_taste` |
| `stick(s)` of butter (US) | `tbsp` × 8 per stick (1 stick = 8 tbsp = 1/2 cup). Convert and note the original in the ingredient name ("butter (1 stick)") so Parke can verify. |
| `clove(s)`, `head(s)`, `bunch(es)`, `can(s)`, `package(s)`/`pkg`, `bottle(s)` | `count`. Keep the noun in the ingredient name ("3 cloves garlic", "1 can crushed tomatoes"). |
| Vague: `knob`, `drizzle`, `handful`, `splash` (without "of X"), `glug` | quantity null, unit `to_taste`, original word preserved in name ("butter (knob)"). |
| Bare numbers ("2 eggs", "1 onion", "3 cloves garlic") | `count` |

**Ambiguous cases — ask the user:**
- Bare `oz` could be weight (`oz`) or fluid (`fl_oz`). For dry/solid ingredients assume weight; for liquids ask. ("Is `8 oz milk` weight ounces or fluid ounces?")
- `cup` is almost always volume `cup`, but if context suggests weight (uncommon), ask.

If you can't map an ingredient unit cleanly, leave it null and put the unit name in the ingredient text — Parke can fix in the UI.

### 4. Parse quantities (fractions and decimals)

Accept these forms and convert to decimal:

- `1/2` → `0.5`
- `1 1/2` → `1.5`
- `½` → `0.5`, `¼` → `0.25`, `¾` → `0.75`, `⅓` → `0.3333`, `⅔` → `0.6667` (extra precision so three thirds sum close to 1)
- `0.5`, `.5`, `1.` — all valid decimals
- `2-3` (range) → use the lower bound (2) and add a note in the ingredient text ("2 to 3 onions")
- "a few", "some", "to taste" → quantity null, unit `to_taste`

### 5. Determine slot categories

Required: at least one of `breakfast`, `lunch`, `dinner`.

If the user passed `--slot` / `--slots` flags, use those (validate each is one of the three).

Otherwise **ask**:

> Which meal slots? (breakfast / lunch / dinner — pick one or more, comma-separated)

**Parsing the answer:** accept any reply containing one or more of the three slot words (case-insensitive substring match on `breakfast`, `lunch`, `dinner`). "Lunch and dinner" → `["lunch","dinner"]`. "B" / "L" / "D" alone are NOT accepted — require the full word. Confirm the parsed set back: "Got it: lunch, dinner. Continuing." If zero slot words match after two tries, abort and tell the user to re-run with `--slot`.

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

**Confirmation guard:** if the reply contains an imperative correction verb (`change`, `remove`, `add`, `swap`, `fix`, `replace`, `delete`, `update`) treat the WHOLE message as corrections, even if it also contains "looks good" or "confirm". Re-display, don't shelve. Only shelve when the reply is purely affirmative ("looks good", "confirm", "save it", "yes", "ship it", etc.) with no correction verbs.

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

**Credential safety rules — non-negotiable:**
- Never put `$FOOD_AUTH_PASS` on a curl `-u` argv (it shows up in `ps`, in shell history with `set -x`, and in Claude Code's tool-invocation transcript).
- Never write the password to any file — not even briefly.
- Never echo the password.

The safe pattern: pipe a curl config into curl on stdin. Curl reads `user = "USER:PASS"` from the config without ever exposing it to argv:

```bash
PAYLOAD=$(mktemp -t recipe-payload.XXXXXX.json) || exit 1
trap 'rm -f "$PAYLOAD"' EXIT

cat > "$PAYLOAD" <<'JSON'
{ ...the recipe JSON... }
JSON

# Write the curl config to stdin via a here-doc — never to disk.
RESPONSE=$(mktemp -t recipe-response.XXXXXX) || exit 1
trap 'rm -f "$PAYLOAD" "$RESPONSE"' EXIT

STATUS=$(curl -sS -o "$RESPONSE" -w "%{http_code}" \
  -X POST "${FOOD_BASE_URL:-https://parkes-food.fly.dev}/api/recipes" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD" \
  -K - <<CURL_CONFIG
user = "${FOOD_AUTH_USER}:${FOOD_AUTH_PASS}"
CURL_CONFIG
)
```

The `-K -` reads curl options from stdin, the `<<CURL_CONFIG` heredoc supplies them inline. The password never appears in the command line, in environment-dump tools (`ps -E`), or in any persisted file.

**On the temp files:** both `mktemp` invocations create unique files in `$TMPDIR` (typically `/var/folders/...` on macOS, owned by the user, 0600 by default). The `trap 'rm ... EXIT'` ensures deletion on every exit path including failure. Don't add the `set -x` flag — it would echo the heredoc contents.

### 9. Report the result

Read `$RESPONSE` for the body and `$STATUS` for the code.

On HTTP 201, print:

> Shelved! Recipe #<id> "<title>" is in the library.
> Edit or delete at <FOOD_BASE_URL>/ if you spot a mistake.

On HTTP 401: tell the user their credentials are wrong; don't retry. Suggest they re-check `FOOD_AUTH_USER` / `FOOD_AUTH_PASS`.
On HTTP 400: print the validation errors verbatim (the API returns `{errors: [...]}`); offer to let the user correct and re-confirm. Keep the parsed structure in memory so re-confirm doesn't require re-reading the photo.
On HTTP 5xx: print the status and body; suggest they retry in a moment.
On any other failure: print the full response. Don't silently swallow.

The trap from §8 cleans up the temp files automatically on any exit path.

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
