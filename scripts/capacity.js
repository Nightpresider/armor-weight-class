/**
 * capacity.js
 * Nonlinear carry capacity: floor(STR² / 2)
 * Bracket classification based on equippedWeight / capacity ratio.
 */

import { MODULE_ID, DEFAULT_BRACKETS } from "./constants.js";
import { getItemSlot } from "./slots.js";

// ─── Core Formula ─────────────────────────────────────────────────────────────

/**
 * Calculate carry capacity from Strength score.
 * Formula: floor(STR² / 2)
 *
 * STR 8  →  32 lbs
 * STR 10 →  50 lbs
 * STR 14 →  98 lbs
 * STR 18 → 162 lbs
 * STR 20 → 200 lbs
 * STR 24 → 288 lbs (some races/features)
 */
export function calcCarryCapacity(strScore) {
  const str = Math.max(1, strScore ?? 10);
  return Math.floor((str * str) / 2);
}

// ─── Equipped Armor Weight ─────────────────────────────────────────────────

/**
 * Sum the weight of all equipped slot items on an actor.
 * Only counts items that have a slotType defined (our custom field).
 * Non-slot items (regular weapons, consumables, etc.) are excluded.
 */
export function calcEquippedArmorWeight(actor) {
  let total = 0;
  for (const item of actor.items) {
    if (!item.system?.equipped) continue;
    if (!getItemSlot(item)) continue;
    const w = item.system?.weight?.value ?? item.system?.weight ?? 0;
    total += Number(w) || 0;
  }
  return total;
}

// ─── Bracket Classification ───────────────────────────────────────────────

/**
 * Return the bracket key ("unarmored" | "light" | "medium" | "heavy" | "over")
 * for a given ratio (equippedWeight / capacity).
 */
export function classifyBracket(ratio) {
  // Allow GM-overridden thresholds stored in settings
  let brackets;
  try {
    brackets = game.settings.get(MODULE_ID, "bracketThresholds");
  } catch {
    brackets = null;
  }
  const thresholds = brackets ?? DEFAULT_BRACKETS;

  if (ratio >= (thresholds.over?.min   ?? 1.00)) return "over";
  if (ratio >= (thresholds.heavy?.min  ?? 0.75)) return "heavy";
  if (ratio >= (thresholds.medium?.min ?? 0.50)) return "medium";
  if (ratio >= (thresholds.light?.min  ?? 0.25)) return "light";
  return "unarmored";
}

// ─── Full Payload ─────────────────────────────────────────────────────────

/**
 * Return a complete capacity snapshot for an actor.
 *
 * {
 *   strScore,       // raw STR score used
 *   capacity,       // total lbs the actor can carry (armor-relevant)
 *   equippedWeight, // sum of slot-item weights currently equipped
 *   ratio,          // 0–∞ fraction of capacity used
 *   pct,            // 0–∞ percentage (capped at 999 for display)
 *   bracket,        // "unarmored" | "light" | "medium" | "heavy" | "over"
 * }
 */
export function getCapacityData(actor) {
  const strScore = actor.system?.abilities?.str?.value ?? 10;
  // Use the native carry capacity the sheet already displays so the AWC bar
  // denominator matches the native encumbrance bar exactly.
  // Falls back to our custom formula if the system value is unavailable.
  const capacity =
    actor.system?.attributes?.encumbrance?.max ?? calcCarryCapacity(strScore);
  const equippedWeight = calcEquippedArmorWeight(actor);
  const ratio   = capacity > 0 ? equippedWeight / capacity : 0;
  const pct     = Math.min(999, Math.round(ratio * 100));
  const bracket = classifyBracket(ratio);

  return { strScore, capacity, equippedWeight, ratio, pct, bracket };
}

// ─── Persist Flags ────────────────────────────────────────────────────────

/**
 * Write computed capacity data into actor flags so other systems/macros
 * can read them without recomputing.
 * Called at the end of prepareDerivedData (via hook).
 */
export async function persistCapacityFlags(actor, data) {
  // Only update if values changed (avoid unnecessary DB writes)
  const current = actor.flags?.[FLAG_NS];
  if (
    current?.capacity      === data.capacity      &&
    current?.equippedWeight === data.equippedWeight &&
    current?.armorBracket  === data.bracket
  ) return;

  await actor.update({
    [`flags.${FLAG_NS}.capacity`]:       data.capacity,
    [`flags.${FLAG_NS}.equippedWeight`]: data.equippedWeight,
    [`flags.${FLAG_NS}.armorBracket`]:   data.bracket,
  }, { render: false });
}
