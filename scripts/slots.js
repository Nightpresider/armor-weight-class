/**
 * slots.js
 * Equipment slot management.
 *
 * - Every AWC-managed equipment sub-type (see constants.js SLOT_TYPES) is its
 *   own independent, exclusive slot — an actor can equip exactly one item of
 *   each sub-type at a time.
 * - By default, sub-types don't conflict with EACH OTHER: a gauntlet and a
 *   glove can both be equipped simultaneously (armor layered over clothing).
 *   Explicit conflicting pairs are read from the `slotConflicts` world setting
 *   (defaults to DEFAULT_SLOT_CONFLICTS) — e.g. a Helmet conflicts with a
 *   Crown or Hat, but not with Helm Padding.
 * - `ring` is excluded from this file's handling entirely — it's a paired
 *   slot (Main Ring / Secondary Ring) managed by paired-slots.js.
 * - Equipping an item into a conflicting slot auto-unequips the current
 *   occupant(s). Slot type is resolved primarily from the item's native
 *   Equipment Type field (system.type.value); a legacy AWC flag is checked
 *   first for backwards-compatibility with items tagged before the dropdown
 *   existed.
 */

import { FLAG_NS, MODULE_ID, SLOT_KEYS, SLOT_TYPES, SLOT_LEGACY_MAP, DEFAULT_SLOT_CONFLICTS, ITEM_MARKERS } from "./constants.js";

// ─── Slot Queries ─────────────────────────────────────────────────────────

/**
 * Return the item currently equipped in `slotType` for `actor`, or null.
 * Always returns null for `ring` — paired slots aren't tracked here (see
 * paired-slots.js).
 */
export function getSlotItem(actor, slotType) {
  if (SLOT_TYPES[slotType]?.paired) return null;
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
 *   2. Native equipment type field (system.type.value) — the Equipment Type
 *      dropdown, which lists every SLOT_TYPES sub-type across Armor/
 *      Clothing/Jewelry.
 *
 * Legacy flag names ("chest", "gloves") are mapped to their current
 * equivalents so items tagged before the rename continue to work.
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
 * ignoresHandSlot). Two independent mechanisms, checked in order:
 *   1. The native dnd5e `system.properties` Set — the checkbox in the
 *      Equipment Properties section registered by the companion
 *      a-knights-dream-properties module (armorPropMJS.mjs), using the same
 *      key names as ITEM_MARKERS's values so they line up 1:1.
 *   2. Legacy fallback: a GM-authored Active Effect on the item targeting
 *      flags.armor-weight-class.<markerKey> (Custom change, mode Override,
 *      value true) — the original, clunkier mechanism this markers system
 *      shipped with. Mirrors the pattern ac.js's getMiscAcBonuses() uses for
 *      actor-level Active Effect changes, scoped to a single item instead.
 * Kept working side by side so GMs who already set markers via Active
 * Effects don't need to redo anything after the checkbox was added.
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
 * Called after an item's `system.equipped` has already been set to true
 * (from the updateItem hook — see hooks.js for why this can't safely run
 * in preUpdateItem, where async handlers aren't awaited before the change
 * commits).
 *
 * Finds every other currently-equipped item that conflicts with `item` —
 * an exact slot match, a pair listed in slotConflicts, or the Helmet/Mask
 * coversFace interaction — and unequips it. Never touches paired slots
 * (rings, hand-slots); those are resolved by paired-slots.js.
 *
 * Returns the list of items that were unequipped, for notification/reporting.
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
