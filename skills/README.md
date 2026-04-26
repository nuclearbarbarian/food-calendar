# Food skills

Claude Code skills that work with the Food calendar.

## recipe-shelve

Read a recipe from a photo (cookbook page, recipe card, screenshot) and shelve it into Parke's recipe library.

### Install

Symlink the skill into Claude Code's skills directory:

```bash
mkdir -p ~/.claude/skills
ln -s /Users/emmetpenney/Food/skills/recipe-shelve.md ~/.claude/skills/recipe-shelve.md
```

The symlink means edits to the in-repo file are picked up immediately — no need to copy on every change.

### Set credentials once

Add to `~/.zshrc` (or `~/.bashrc`):

```bash
export FOOD_BASE_URL="https://parkes-food.fly.dev"
export FOOD_AUTH_USER="Parke"
export FOOD_AUTH_PASS="<the password from Fly secrets>"
```

Reload your shell. The skill checks for these and refuses to run without them.

For local dev against `npm start` on port 3000, set `FOOD_BASE_URL=http://localhost:3000`.

### Use

In any Claude Code session:

```
/recipe-shelve ~/Desktop/cookbook-page.jpg
/recipe-shelve --slot dinner --source "NYT Cooking" ./photo.png
/recipe-shelve --tried --slot lunch /tmp/sandwich.heic
```

The skill walks you through:

1. Reads the photo and proposes a parsed recipe (title, ingredients with canonical units, steps, source).
2. Asks for any corrections — "change the title", "the butter is 3 tbsp not 2", "remove the salt line".
3. Asks for slot categories (breakfast / lunch / dinner) if you didn't pass `--slot`.
4. POSTs to the Food API and reports the new recipe ID.

Photos aren't uploaded to the server in this version — `photo_path` stays null. Add that in Phase 7 if useful.
