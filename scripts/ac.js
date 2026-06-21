/**
 * ac.js
 * Full replacement AC calculation.
 *
 * Formula:
 *   AC = 10 + max(DexMod, ConMod) + Σ(equippedItem.acBonus) + miscBonuses
 *
 * This completely bypasses the dnd5e system's armor-type logic.
 */

import { getItemSlot } from "./slots.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Safely retrieve an ability modifier from an actor.
 * dnd5e stores the final modifier at system.abilities.xxx.mod
 */
function getMod(actor, abilityKey) {
  return actor.system?.abilities?.[abilityKey]?.mod ?? 0;
}

/**
 * Sum AC contributions from all equipped slot items.
 * Reads system.armor.value — the standard dnd5e "Armor Class" field on the
 * item details sheet — so no separate AWC bonus field is needed.
 */
function sumEquippedAcBonuses(actor) {
  let total = 0;
  for (const item of actor.items) {
    if (!item.system?.equipped) continue;

    if (!getItemSlot(item)) continue;

    const bonus = Number(item.system?.armor?.value ?? 0);
    total += isNaN(bonus) ? 0 : bonus;
  }
  return total;
}

/**
 * Collect miscellaneous AC bonuses from Active Effects that target
 * "system.attributes.ac.bonus" — these survive our override (e.g. Shield spell).
 */
function getMiscAcBonuses(actor) {
  let total = 0;
  for (const effect of actor.allApplicableEffects?.() ?? []) {
    if (effect.disabled || effect.isSuppressed) continue;
    for (const change of effect.changes ?? []) {
      if (
        change.key === "system.attributes.ac.bonus" ||
        change.key === "system.attributes.ac.value"
      ) {
        const val = Number(change.value);
        if (!isNaN(val)) total += val;
      }
    }
  }
  return total;
}

// ─── Main AC Override ─────────────────────────────────────────────────────────

/**
 * Compute and apply the new AC value directly onto the actor's system data.
 *
 * Called from the `dnd5e.prepareActorData` hook (prepareDerivedData phase)
 * AFTER the system has done its own pass — we overwrite the result.
 *
 * Returns the full breakdown for UI display.
 */
export function applyCustomAC(actor) {
  if (actor.type !== "character") return null;

  const dexMod     = getMod(actor, "dex");
  const conMod     = getMod(actor, "con");
  const baseMod    = Math.max(dexMod, conMod);
  const itemBonus  = sumEquippedAcBonuses(actor);
  const miscBonus  = getMiscAcBonuses(actor);
  const total      = 10 + baseMod + itemBonus + miscBonus;

  // Directly write to the prepared (in-memory) data object
  if (actor.system?.attributes?.ac) {
    actor.system.attributes.ac.value = total;
    actor.system.attributes.ac.calc  = "awc-overhaul"; // mark as overridden
    actor.system.attributes.ac.flat  = total;
  }

  // Cache breakdown for sheet rendering
  actor._awcAC = {
    base: 10,
    dexMod,
    conMod,
    baseMod,
    usedAbility: dexMod >= conMod ? "dex" : "con",
    itemBonus,
    miscBonus,
    total,
  };

  return actor._awcAC;
}

/**
 * Get a cached or freshly computed AC breakdown for an actor.
 * Safe to call from sheet renders.
 */
export function getACBreakdown(actor) {
  return actor._awcAC ?? null;
}
