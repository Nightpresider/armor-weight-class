# Armor Weight Class

Foundry VTT module for the dnd5e system. Replaces the static armor type (Light/Medium/Heavy) with a dynamic weight class computed as `equipped armor weight ÷ carry capacity × 100`, with GM-configurable thresholds.

Not a git repository — there is no version control in this directory.

## Files

- [scripts/armor-weight-class.js](scripts/armor-weight-class.js) — entire module logic, single file, no build step
- [styles/armor-weight-class.css](styles/armor-weight-class.css) — badge/progress-bar styling, uses CSS vars per weight class (`--awc-light-*`, `--awc-medium-*`, `--awc-heavy-*`, `--awc-none-*`)
- [lang/en.json](lang/en.json) — all user-facing strings, keyed `AWC.*`; add new strings here, never hardcode text in the JS
- [module.json](module.json) — Foundry manifest: id `armor-weight-class`, compatible with Foundry v11–12 and dnd5e system v3.0–3.3
- [README.md](README.md) — user-facing docs (installation, settings table, macro API examples); keep in sync with actual settings/API when either changes

## Architecture

Plain ESM, no bundler/npm/package.json — Foundry loads `scripts/armor-weight-class.js` directly as declared in `module.json`'s `esmodules`.

Key pieces in the script, top to bottom:
- `getCarryCapacity` / `getEquippedArmorWeight` / `classifyArmorWeight` / `getArmorWeightData` — pure-ish calculation helpers, exposed on `game.awc` for macro use
- Settings registered on `Hooks.once("init")`: `lightThreshold`, `mediumThreshold`, `showIndicator`, `applyEncumbrance` (all world-scope, all trigger `refreshAllActorSheets()` on change)
- `Hooks.on("dnd5e.prepareActorData")` — computes weight class per character actor each data prep cycle, stashes it on `actor._awc` (in-memory only, not persisted), optionally mutates `actor.system.attributes.movement` for the heavy-armor speed penalty
- Two `Hooks.on("renderActorSheet")` handlers — one injects the badge/progress-bar near `.encumbrance` (falls back to AC area, then sheet header), the other tags individual equipped armor item rows with their `% load` contribution
- `Hooks.on("dnd5e.prepareArmorClass")` — stamps the computed weight class onto the AC object for downstream consumers
- `Hooks.once("ready")` — exposes `game.awc` API

`actor._awc` is recomputed every `prepareActorData` cycle and is never written to actor flags/persisted data — don't assume it survives a reload before that hook fires, and don't add code that persists it without explicit reason (the module is intentionally non-destructive to actor data).

## Conventions

- Module ID constant `MODULE_ID = "armor-weight-class"` — use it for all `game.settings`/`game.i18n` calls, don't hardcode the string
- i18n keys follow `AWC.<Category>.<Name>` (e.g. `AWC.Settings.LightThreshold.Hint`, `AWC.WeightClass.Heavy`) — add corresponding entries to [lang/en.json](lang/en.json) for any new string
- CSS classes follow `awc-<element>` with weight-class modifiers `awc-light`/`awc-medium`/`awc-heavy`/`awc-none`
- Sheet injection always checks `game.settings.get(MODULE_ID, "showIndicator")` and actor type (`"character"`) before doing DOM work, and degrades gracefully through fallback selectors since dnd5e sheet markup varies by version

## Testing

No automated test suite. Verify changes by loading the module in an actual Foundry world (v11 or v12) with the dnd5e system (v3.0–3.3) enabled, equipping armor on a character, and checking the sheet badge, item tags, and Module Settings panel.
