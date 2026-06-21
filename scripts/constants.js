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

export const SLOT_TYPES = {
  helmet:  { label: "Helmet",   icon: "fas fa-hard-hat"    },
  breast:  { label: "Breast",   icon: "fas fa-vest"        },
  gauntlet: { label: "Gauntlet", icon: "fas fa-mitten"     },
  boots:   { label: "Boots",    icon: "fas fa-shoe-prints" },
};

export const SLOT_KEYS = Object.keys(SLOT_TYPES); // ["helmet","breast","gauntlet","boots"]

// Legacy slot names from earlier versions — mapped to their new names for
// backwards-compatibility with items that still carry the old flag value.
export const SLOT_LEGACY_MAP = { chest: "breast", gloves: "gauntlet" };

// ─── Bracket Encumbrance Effects ─────────────────────────────────────────────
// Applied in-memory during derivedData. speedMod in feet, disadvantage flags.

export const BRACKET_EFFECTS = {
  unarmored:   { speedMod: 0,   disadvantageDex: false, disadvantageStr: false, disadvantageCon: false },
  light:       { speedMod: 0,   disadvantageDex: false, disadvantageStr: false, disadvantageCon: false },
  medium:      { speedMod: -5,  disadvantageDex: false, disadvantageStr: false, disadvantageCon: false },
  heavy:       { speedMod: -10, disadvantageDex: true,  disadvantageStr: false, disadvantageCon: true  },
  over:        { speedMod: -20, disadvantageDex: true,  disadvantageStr: true,  disadvantageCon: true  },
};
