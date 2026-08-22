/**
 * slots.js
 * Equipment slot management — each SLOT_TYPES sub-type (constants.js) is its
 * own exclusive slot, one item at a time. Sub-types don't conflict with each
 * other by default (armor layers over clothing fine); only pairs in the
 * slotConflicts setting do. `ring` is excluded — paired-slots.js owns it.
 */

import { FLAG_NS, MODULE_ID, SLOT_KEYS, SLOT_TYPES, SLOT_LEGACY_MAP, DEFAULT_SLOT_CONFLICTS, ITEM_MARKERS } from "./constants.js";

// ─── Slot Queries ─────────────────────────────────────────────────────────

/**
 * Return the canonical slotType string for an item, or null. Checks the
 * legacy AWC flag first (old names remapped via SLOT_LEGACY_MAP), then the
 * native Equipment Type field.
 */
export function getItemSlot(item) {
  const raw = item.getFlag?.(FLAG_NS, "slotType") ?? item.system?.slotType ?? null;
  const normalised = raw ? (SLOT_LEGACY_MAP[raw] ?? raw) : null;
  if (normalised && SLOT_KEYS.includes(normalised)) return normalised;

  const nativeType = item.system?.type?.value ?? null;
  return SLOT_KEYS.includes(nativeType) ? nativeType : null;
}

/**
 * Return a map of { slotKey → item | null } for an actor, covering every
 * non-paired slot (everything except `ring`, which paired-slots.js owns).
 */
export function getSlotMap(actor) {
  const map = {};
  for (const key of SLOT_KEYS) {
    if (SLOT_TYPES[key]?.paired) continue;
    map[key] = null;
  }
  for (const item of actor.items) {
    if (!item.system?.equipped) continue;
    const slot = getItemSlot(item);
    if (slot && slot in map) map[slot] = item;
  }
  return map;
}

// ─── Slot Conflicts ─────────────────────────────────────────────────────────

/**
 * Read the GM-configured conflict pairs, falling back to the module default
 * if settings aren't registered yet (e.g. called very early during init).
 */
function getSlotConflicts() {
  try {
    return game.settings.get(MODULE_ID, "slotConflicts") ?? DEFAULT_SLOT_CONFLICTS;
  } catch {
    return DEFAULT_SLOT_CONFLICTS;
  }
}

/**
 * Return every slot key that conflicts with `slotType`, per the current
 * slotConflicts pair list. A slot with no listed pairs conflicts with
 * nothing but an exact match (today's original behaviour, preserved).
 */
export function getConflictingSlotKeys(slotType) {
  const out = new Set();
  for (const [a, b] of getSlotConflicts()) {
    if (a === slotType) out.add(b);
    else if (b === slotType) out.add(a);
  }
  return [...out];
}

/**
 * True if `item` carries the given AWC marker (coversFace, bypassFaceCover,
 * ignoresHandSlot). Checks the Equipment Properties checkbox (added by the
 * companion a-knights-dream-properties module) first, then falls back to
 * the older mechanism — a GM-authored Active Effect targeting
 * flags.armor-weight-class.<markerKey> — so existing Effect-based markers
 * keep working.
 */
export function itemHasMarker(item, markerKey) {
  const props = item?.system?.properties;
  if (props) {
    const hasProp = typeof props.has === "function" ? props.has(markerKey) : !!props[markerKey];
    if (hasProp) return true;
  }

  const targetKey = `flags.${FLAG_NS}.${markerKey}`;
  for (const effect of item?.effects ?? []) {
    if (effect.disabled || effect.isSuppressed) continue;
    for (const change of effect.changes ?? []) {
      if (change.key === targetKey) {
        return change.value === true || change.value === "true";
      }
    }
  }
  return false;
}

// ─── Equip Validation & Auto-Unequip ─────────────────────────────────────

/**
 * Called after an item's system.equipped is already true (from the
 * updateItem hook — see hooks.js). Unequips every other equipped item that
 * conflicts with `item` (exact slot match, a slotConflicts pair, or the
 * Helmet/Mask coversFace interaction) and returns what got unequipped.
 * Never touches paired slots (rings, hand-slots) — paired-slots.js owns those.
 */
export async function resolveSlotConflicts(actor, item) {
  const slotType = getItemSlot(item);
  if (!slotType || SLOT_TYPES[slotType]?.paired) return [];

  const conflictKeys = new Set([slotType, ...getConflictingSlotKeys(slotType)]);
  const unequipped = [];

  for (const other of actor.items) {
    if (other.id === item.id || !other.system?.equipped) continue;
    const otherSlot = getItemSlot(other);
    if (!otherSlot || SLOT_TYPES[otherSlot]?.paired) continue;

    let conflicts = conflictKeys.has(otherSlot);

    // Helmet ↔ Mask: a Helmet marked coversFace blocks Mask, unless the Mask
    // itself is marked bypassFaceCover (checked in both equip directions).
    if (!conflicts) {
      if (slotType === "helmet" && otherSlot === "mask"
        && itemHasMarker(item, ITEM_MARKERS.COVERS_FACE)
        && !itemHasMarker(other, ITEM_MARKERS.BYPASS_FACE_COVER)) {
        conflicts = true;
      }
      if (slotType === "mask" && otherSlot === "helmet"
        && itemHasMarker(other, ITEM_MARKERS.COVERS_FACE)
        && !itemHasMarker(item, ITEM_MARKERS.BYPASS_FACE_COVER)) {
        conflicts = true;
      }
    }

    if (!conflicts) continue;

    await other.update({ "system.equipped": false }, { render: false });
    unequipped.push(other);

    ui.notifications.info(
      game.i18n.format(otherSlot === slotType ? "AWC.Notify.SlotSwap" : "AWC.Notify.SlotConflict", {
        old:  other.name,
        slot: game.i18n.localize(`AWC.Slot.${slotType.charAt(0).toUpperCase() + slotType.slice(1)}`),
        new:  item.name,
      })
    );
  }

  return unequipped;
}

/**
 * @deprecated Kept for macro/backwards compatibility — delegates to
 * resolveSlotConflicts. The name is historical: actual conflict resolution
 * now happens post-commit from the updateItem hook (see hooks.js), not as a
 * pre-equip validation gate, because preUpdateItem handlers can't reliably
 * await async work before Foundry commits the change.
 */
export async function validateAndEquip(actor, item) {
  await resolveSlotConflicts(actor, item);
  return true;
}
