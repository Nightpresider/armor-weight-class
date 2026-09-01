/**
 * constants.js
 * Central source of truth for all static data in the Armor Weight Class module.
 */

export const MODULE_ID = "armor-weight-class";
export const FLAG_NS   = MODULE_ID; // namespace for all actor/item flags

// a-knights-dream-properties declares custom item properties/flags AWC reads (Equipment
// Properties checkboxes, pocket-carrier config) - AWC never hard-depends on it being active,
// every read through this ID degrades to "flag absent" defaults if it isn't.
export const AKDP_MODULE_ID = "a-knights-dream-properties";

// ─── Armor Brackets ──────────────────────────────────────────────────────────
// Thresholds are a fraction (0-1) of carry capacity. Defaults — GM-editable
// in settings.

export const DEFAULT_BRACKETS = {
  unarmored: { min: 0,    max: 0.25, label: "Unarmored", cssClass: "awc-unarmored" },
  light:     { min: 0.25, max: 0.50, label: "Light",     cssClass: "awc-light"    },
  medium:    { min: 0.50, max: 0.75, label: "Medium",     cssClass: "awc-medium"   },
  heavy:     { min: 0.75, max: 1.00, label: "Heavy",      cssClass: "awc-heavy"    },
  over:      { min: 1.00, max: Infinity, label: "Overburdened", cssClass: "awc-over" },
};

// ─── Equipment Slots ─────────────────────────────────────────────────────────
// Single source of truth for every slot: the Equipment Type dropdown
// (hooks.js), exclusivity logic (slots.js), and doll labels/icons
// (apps/paper-doll-app.js) all read from this table.
//
// Every sub-type is its own exclusive slot by default — only pairs in
// DEFAULT_SLOT_CONFLICTS below actually conflict. `ring` is paired: true,
// handled separately by paired-slots.js's Main/Secondary system.

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

// ─── Drag/Drop Highlight Classes ───────────────────────────────────────────────
// Shared between drag-highlight.js (applies them to the doll's own static slots) and
// paper-doll-app.js's renderPocketSlots (applies them directly to drag-revealed pocket-slot
// boxes, which exist only during a drag and aren't part of the doll's static slot set
// drag-highlight.js iterates) - centralized here since drag-highlight.js already imports FROM
// paper-doll-app.js, so paper-doll-app.js importing these back the other way would cycle.
export const DRAG_OCCUPIED_CLASS = "awc-doll-drop-occupied";
export const DRAG_EMPTY_CLASS = "awc-doll-drop-empty";
export const DRAG_TARGET_CLASS = "awc-doll-drop-target";

// ─── Container Sub-Types ──────────────────────────────────────────────────────
// dnd5e's native Container item has no subtype field at all — a-knights-dream-properties'
// containerTypeConfig.mjs adds one via a flag. Backpack/Belt Pouch/Purse map onto the regular
// slots above; Keg/Bobble are hand-slot items instead (see paired-slots.js).
export const CONTAINER_TYPE_FLAG = "containerType";
export const CONTAINER_TYPE_SLOT_MAP = { backpack: "backpack", beltPouch: "belt", purse: "purse" };
export const HAND_ELIGIBLE_CONTAINER_TYPES = ["keg", "bobble"];

// Legacy slot names from earlier versions — mapped to their new names for
// backwards-compatibility with items that still carry the old flag value.
export const SLOT_LEGACY_MAP = { chest: "breast", gloves: "gauntlet" };

// ─── Slot Conflicts ───────────────────────────────────────────────────────────
// Explicit conflicting pairs, not symmetric groups — a helmet layers over
// padding fine but conflicts with a crown or hat. Equipping either member of
// a pair auto-unequips the other. Default for the GM-editable slotConflicts
// world setting.

export const DEFAULT_SLOT_CONFLICTS = [
  ["padding", "crown"],
  ["padding", "hat"],
  ["crown",   "hat"],
  ["helmet",  "crown"],
  ["helmet",  "hat"],
  // helmet + padding is intentionally NOT listed — they're compatible/layered
];

// ─── Per-Item Override Markers ────────────────────────────────────────────────
// Set via a GM-authored Active Effect (OVERRIDE, value true) targeting
// flags.armor-weight-class.<key>. Read by slots.js (COVERS_FACE/
// BYPASS_FACE_COVER) and paired-slots.js (IGNORES_HAND_SLOT).

export const ITEM_MARKERS = {
  COVERS_FACE:       "coversFace",       // on a Helmet: blocks the Mask slot
  BYPASS_FACE_COVER: "bypassFaceCover",  // on a Mask: ignores a coversFace Helmet
  IGNORES_HAND_SLOT: "ignoresHandSlot",  // on a Shield/Weapon: doesn't consume a hand-slot
  POCKETED:          "pocketed",         // on any equipped item: a valid pocket carrier — see paired-slots.js's isPocketCarrier()
};

// ─── Paired Slots (hand-slots & ring-slots) ───────────────────────────────────
// Two positions each, auto-filled Main-then-Secondary, drag-to-swap between
// them. See paired-slots.js.

export const HAND_SLOT_POSITIONS = ["main", "secondary"];
export const RING_SLOT_POSITIONS = ["main", "secondary"];

// dnd5e's own system.properties key for a two-handed weapon.
export const WEAPON_TWO_HANDED_PROPERTY = "two";

// dnd5e's own system.properties key for a Light weapon (eligible for
// two-weapon fighting). See paired-slots.js's canTwoWeaponFight().
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
