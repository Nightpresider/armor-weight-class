/**
 * constants.js
 * Central source of truth for all static data in the Armor Weight Class module.
 */

export const MODULE_ID = "armor-weight-class";
export const FLAG_NS   = MODULE_ID; // namespace for all actor/item flags

// ─── Armor Brackets ──────────────────────────────────────────────────────────
// Thresholds are expressed as a fraction (0–1) of carry capacity.
// They are DEFAULTS; the GM can override them in settings.

export const DEFAULT_BRACKETS = {
  unarmored: { min: 0,    max: 0.25, label: "Unarmored", cssClass: "awc-unarmored" },
  light:     { min: 0.25, max: 0.50, label: "Light",     cssClass: "awc-light"    },
  medium:    { min: 0.50, max: 0.75, label: "Medium",     cssClass: "awc-medium"   },
  heavy:     { min: 0.75, max: 1.00, label: "Heavy",      cssClass: "awc-heavy"    },
  over:      { min: 1.00, max: Infinity, label: "Overburdened", cssClass: "awc-over" },
};

// ─── Equipment Slots ─────────────────────────────────────────────────────────
// Single source of truth for every AWC-managed equipment sub-type: the
// Equipment Type dropdown groups (hooks.js), the exclusivity/layering logic
// (slots.js), and the doll's slot labels/icons (scripts/apps/paper-doll-app.js)
// all read from this one table — it replaces the old, separately-maintained
// _AWC_EQUIP_GROUPS that used to live only in hooks.js.
//
// By default every sub-type is its own independent, exclusive (one-item) slot.
// Armor pieces and the clothing worn underneath them are NOT exclusive with
// each other (a gauntlet layers over a glove, a breastplate over a shirt, a
// helmet over padding, etc.) — only pairs listed in DEFAULT_SLOT_CONFLICTS
// below actually conflict.
//
// `ring` is flagged `paired: true` — it is NOT resolved through the normal
// one-item-per-slot logic in slots.js. It's handled by the Main/Secondary
// paired-slot subsystem in paired-slots.js instead (same mechanism as weapon
// hand-slots), since the doll needs 2 simultaneous ring slots.

export const SLOT_TYPES = {
  // Armor
  helmet:   { label: "Helmet",       icon: "fas fa-hard-hat",      group: "Armor" },
  breast:   { label: "Breast",       icon: "fas fa-vest",          group: "Armor" },
  greaves:  { label: "Greaves",      icon: "fas fa-socks",         group: "Armor" },
  gauntlet: { label: "Gauntlets",    icon: "fas fa-mitten",        group: "Armor" },
  boots:    { label: "Sabatons",     icon: "fas fa-shoe-prints",   group: "Armor" },
  shield:   { label: "Shield",       icon: "fas fa-shield-alt",    group: "Armor" },

  // Clothing
  hat:      { label: "Hat",          icon: "fas fa-hat-cowboy",    group: "Clothing" },
  cape:     { label: "Cape",         icon: "fas fa-mask",          group: "Clothing" },
  shirt:    { label: "Tunic",        icon: "fas fa-tshirt",        group: "Clothing" },
  glove:    { label: "Glove",        icon: "fas fa-hand-paper",    group: "Clothing" },
  trouser:  { label: "Trouser",      icon: "fas fa-socks",         group: "Clothing" },
  shoes:    { label: "Shoe",         icon: "fas fa-shoe-prints",   group: "Clothing" },
  belt:     { label: "Belt",         icon: "fas fa-ellipsis-h",    group: "Clothing" },
  purse:    { label: "Pouch",        icon: "fas fa-coins",         group: "Clothing" },
  backpack: { label: "Backpack",     icon: "fas fa-suitcase",      group: "Clothing" },
  padding:  { label: "Helm Padding", icon: "fas fa-circle",        group: "Clothing" },

  // Jewelry
  crown:    { label: "Crown",        icon: "fas fa-crown",         group: "Jewelry" },
  mask:     { label: "Mask",         icon: "fas fa-theater-masks", group: "Jewelry" },
  necklace: { label: "Necklace",     icon: "fas fa-gem",           group: "Jewelry" },
  ring:     { label: "Ring",         icon: "fas fa-ring",          group: "Jewelry", paired: true },
};

export const SLOT_KEYS = Object.keys(SLOT_TYPES);

// Legacy slot names from earlier versions — mapped to their new names for
// backwards-compatibility with items that still carry the old flag value.
export const SLOT_LEGACY_MAP = { chest: "breast", gloves: "gauntlet" };

// ─── Slot Conflicts ───────────────────────────────────────────────────────────
// Explicit conflicting PAIRS, not symmetric groups — the head region is
// asymmetric (a helmet layers over padding but conflicts with a crown or hat),
// which a flat "these slots all conflict with each other" group can't express.
// Equipping either member of a listed pair auto-unequips the other.
//
// This is the DEFAULT value for the `slotConflicts` world setting — GM-editable
// later via the settings menu's Equipment Rules tab, not a hardcoded rule.

export const DEFAULT_SLOT_CONFLICTS = [
  ["padding", "crown"],
  ["padding", "hat"],
  ["crown",   "hat"],
  ["helmet",  "crown"],
  ["helmet",  "hat"],
  // helmet + padding is intentionally NOT listed — they're compatible/layered
];

// ─── Per-Item Override Markers ────────────────────────────────────────────────
// Applied to a specific item via a GM-authored Active Effect targeting
// `flags.armor-weight-class.<key>` (change mode OVERRIDE, value `true`).
// Read via scripts/slots.js (COVERS_FACE / BYPASS_FACE_COVER) and
// scripts/paired-slots.js (IGNORES_HAND_SLOT).

export const ITEM_MARKERS = {
  COVERS_FACE:       "coversFace",       // on a Helmet: blocks the Mask slot
  BYPASS_FACE_COVER: "bypassFaceCover",  // on a Mask: ignores a coversFace Helmet
  IGNORES_HAND_SLOT: "ignoresHandSlot",  // on a Shield/Weapon: doesn't consume a hand-slot
};

// ─── Paired Slots (hand-slots & ring-slots) ───────────────────────────────────
// Two positions each, auto-filled Main-then-Secondary, drag-to-swap between
// them. See scripts/paired-slots.js.

export const HAND_SLOT_POSITIONS = ["main", "secondary"];
export const RING_SLOT_POSITIONS = ["main", "secondary"];

// dnd5e `system.properties` Set member marking a weapon as two-handed.
// Verified against the locally installed dnd5e system (DND5E.itemProperties.two
// = "Two-Handed"); this key has been stable since the 3.0 item-data-model
// overhaul, but spot-check against whichever dnd5e version is actually running
// if hand-slot pairing behaves oddly on an older 3.x install.
export const WEAPON_TWO_HANDED_PROPERTY = "two";

// dnd5e `system.properties` Set member marking a weapon as Light (eligible
// for two-weapon fighting). Verified directly against the installed
// dnd5e.mjs source (Weapon5e#attackModes: `this.properties.has("lgt")`),
// alongside that same getter's use of the system's own
// `flags.dnd5e.enhancedDualWielding` character flag — the mechanism a
// Dual Wielder-style feat grants via an Active Effect — as the melee-only
// exemption from needing Light. See paired-slots.js's canTwoWeaponFight().
export const WEAPON_LIGHT_PROPERTY = "lgt";

// ─── Bracket Encumbrance Effects ─────────────────────────────────────────────
// Applied in-memory during derivedData. speedMod in feet, disadvantage flags.

export const BRACKET_EFFECTS = {
  unarmored:   { speedMod: 0,   disadvantageDex: false, disadvantageStr: false, disadvantageCon: false },
  light:       { speedMod: 0,   disadvantageDex: false, disadvantageStr: false, disadvantageCon: false },
  medium:      { speedMod: -5,  disadvantageDex: false, disadvantageStr: false, disadvantageCon: false },
  heavy:       { speedMod: -10, disadvantageDex: true,  disadvantageStr: false, disadvantageCon: true  },
  over:        { speedMod: -20, disadvantageDex: true,  disadvantageStr: true,  disadvantageCon: true  },
};
