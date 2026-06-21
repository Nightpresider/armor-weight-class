/**
 * slots.js
 * Equipment slot management.
 *
 * - Each actor has exactly one item per slot (boots/chest/gloves/helmet/shield).
 * - Equipping an item into an occupied slot auto-unequips the current occupant.
 * - Slot type is stored as a flag on the item: flags.awc-overhaul.slotType
 */

import { FLAG_NS, SLOT_KEYS, SLOT_LEGACY_MAP } from "./constants.js";

// ─── Slot Queries ─────────────────────────────────────────────────────────

/**
 * Return the item currently equipped in `slotType` for `actor`, or null.
 */
export function getSlotItem(actor, slotType) {
  for (const item of actor.items) {
    if (!item.system?.equipped) continue;
    const slot = getItemSlot(item);
    if (slot === slotType) return item;
  }
  return null;
}

/**
 * Return the canonical slotType string for an item, or null.
 *
 * Resolution order:
 *   1. AWC flag (legacy — set by the old Slot Type dropdown)
 *   2. Native equipment type field (system.type.value) — now the primary method:
 *      the Equipment Type dropdown under "Armor" lists Helmet / Breast / Gauntlet / Boots
 *
 * Legacy flag names ("chest", "gloves") are mapped to their current equivalents
 * so items tagged before the rename continue to work without re-tagging.
 */
export function getItemSlot(item) {
  const raw = item.getFlag?.(FLAG_NS, "slotType") ?? item.system?.slotType ?? null;
  const normalised = raw ? (SLOT_LEGACY_MAP[raw] ?? raw) : null;
  if (normalised && SLOT_KEYS.includes(normalised)) return normalised;

  const nativeType = item.system?.type?.value ?? null;
  return SLOT_KEYS.includes(nativeType) ? nativeType : null;
}

/**
 * Return a map of { slotKey → item | null } for an actor covering all slots.
 */
export function getSlotMap(actor) {
  const map = Object.fromEntries(SLOT_KEYS.map(k => [k, null]));
  for (const item of actor.items) {
    if (!item.system?.equipped) continue;
    const slot = getItemSlot(item);
    if (slot) map[slot] = item;
  }
  return map;
}

// ─── Equip Validation & Auto-Unequip ─────────────────────────────────────

/**
 * Called before an item is equipped.
 * If the item has a slotType and the slot is already occupied,
 * unequip the current occupant first (no confirmation — seamless swap).
 *
 * Returns true if the equip should proceed, false to cancel.
 */
export async function validateAndEquip(actor, item) {
  const slotType = getItemSlot(item);
  if (!slotType) return true; // not a slot item — no intervention needed

  const occupant = getSlotItem(actor, slotType);
  if (!occupant || occupant.id === item.id) return true; // slot free or same item

  // Auto-unequip occupant
  await occupant.update({ "system.equipped": false }, { render: false });

  // Notify the user
  ui.notifications.info(
    game.i18n.format("AWC.Notify.SlotSwap", {
      old: occupant.name,
      slot: game.i18n.localize(`AWC.Slot.${slotType.charAt(0).toUpperCase() + slotType.slice(1)}`),
      new: item.name,
    })
  );

  return true; // proceed with equipping the new item
}

