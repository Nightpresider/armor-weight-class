/**
 * paired-slots.js
 * Main/Secondary hand-slots, ring-slots, and the single-capacity Exempt slot.
 */

import { FLAG_NS, MODULE_ID, AKDP_MODULE_ID, HAND_SLOT_POSITIONS, RING_SLOT_POSITIONS, WEAPON_TWO_HANDED_PROPERTY, WEAPON_LIGHT_PROPERTY, ITEM_MARKERS, HAND_ELIGIBLE_CONTAINER_TYPES } from "./constants.js";
import { getItemSlot, itemHasMarker, getContainerType } from "./slots.js";

const LOG = `${MODULE_ID} |`;

// ─── Weapon/Shield Helpers ─────────────────────────────────────────────────────

/**
 * True if `item` is a weapon with the given dnd5e `system.properties` Set
 * member. Defensively handles both the modern Set-based properties model
 * and a legacy plain-object shape, mirroring getItemSlot()'s tolerance for
 * old data formats.
 */
function weaponHasProperty(item, propertyKey) {
  if (item?.type !== "weapon" && item?.type !== "consumable") return false;
  const props = item.system?.properties;
  if (!props) return false;
  if (typeof props.has === "function") return props.has(propertyKey);
  return !!props[propertyKey];
}

/** True if `item` is a Container configured (via AKDP's Container Type dropdown) as a hand-slot item (Keg or Bobble/Vial). */
export function isHandEligibleContainer(item) {
  return item?.type === "container" && HAND_ELIGIBLE_CONTAINER_TYPES.includes(getContainerType(item));
}

/**
 * A Keg's handedness is dynamic rather than a fixed property: too heavy for one hand once its
 * weight exceeds a GM-configured fraction (kegOneHandedFraction setting) of the actor's own
 * effective carry capacity — dnd5e's own attributes.encumbrance.max, which already factors in
 * Strength, creature size, and Powerful Build, and is explicitly built to be targeted by active
 * effects (a Bear Totem feature, a Belt of Giant Strength), so those flow in automatically
 * without this needing to know about any of them by name. No capacity data available (e.g. a
 * non-Actor parent) defaults to two-handed, the safe assumption.
 */
function isKegTwoHanded(item) {
  if (getContainerType(item) !== "keg") return false;
  const max = item.parent?.system?.attributes?.encumbrance?.max;
  if (!Number.isFinite(max) || max <= 0) return true;
  let fraction;
  try { fraction = game.settings.get(MODULE_ID, "kegOneHandedFraction"); }
  catch { fraction = 1 / 3; }
  const weight = item.system?.weight?.value ?? 0;
  return weight > max * (fraction ?? (1 / 3));
}

/** True for a two-handed weapon, or a Container item dynamically classified as two-handed (see isKegTwoHanded()). */
export function isTwoHanded(item) {
  if (item?.type === "container") return isKegTwoHanded(item);
  return weaponHasProperty(item, WEAPON_TWO_HANDED_PROPERTY);
}

/** True for a Light weapon. */
export function isLightWeapon(item) {
  return weaponHasProperty(item, WEAPON_LIGHT_PROPERTY);
}

/**
 * True for a ranged weapon. Prefers dnd5e's own CONFIG.DND5E.weaponTypeMap;
 * falls back to the "…R" naming convention (simpleR/martialR) if that
 * config isn't available.
 */
export function isRangedWeapon(item) {
  if (item?.type !== "weapon") return false;
  const typeValue = item.system?.type?.value ?? "";
  const mapped = CONFIG.DND5E?.weaponTypeMap?.[typeValue];
  if (mapped) return mapped === "ranged";
  return /R$/.test(typeValue);
}

/** True for a shield (an "equipment" item resolving to the `shield` slot). */
export function isShield(item) {
  return item?.type === "equipment" && getItemSlot(item) === "shield";
}

/** A shield, weapon, consumable, or hand-eligible Container (Keg/Bobble) can occupy a hand-slot. Everything else is ignored here. */
function isHandSlotEligible(item) {
  return item?.type === "weapon" || item?.type === "consumable" || isShield(item) || isHandEligibleContainer(item);
}

/** True for an item type with no inherent melee/ranged side — remembers one via the heldSide flag instead (see resolveOccupantSide()). */
function hasNoInherentHandSide(item) {
  return item?.type === "consumable" || isHandEligibleContainer(item);
}

/**
 * True if `item` individually qualifies for two-weapon fighting: it has the
 * Light property, or the actor has dnd5e's own "Enhanced Dual Wielding"
 * flag (granted by a Dual Wielder-style feat) and this weapon is melee and
 * not two-handed. Used by validateAndEquipHandItem() to decide whether a
 * second weapon is a valid dual-wield or displaces the opposite hand.
 */
function canTwoWeaponFight(item, actor) {
  if (isLightWeapon(item)) return true;
  return !!actor?.getFlag("dnd5e", "enhancedDualWielding") && item?.type === "weapon" && !isRangedWeapon(item) && !isTwoHanded(item);
}

/** Short human-readable reason a hand-slot box is faded/blocked, for the doll's hover tooltip. */
export function describeHandBlocker(item) {
  if (isTwoHanded(item)) return "Two-Handed — uses both hands";
  if (isShield(item)) return "Shield — occupies a hand without freeing a matching slot";
  return "Hand already in use";
}

function isExempt(item) {
  return isHandSlotEligible(item) && itemHasMarker(item, ITEM_MARKERS.IGNORES_HAND_SLOT);
}

/** melee | ranged | shield | null (empty hand), for the render algorithm below. */
function classifyOccupant(item) {
  if (!item) return null;
  if (isShield(item)) return "shield";
  if (item.type === "weapon" || hasNoInherentHandSide(item)) return resolveOccupantSide(item);
  return null;
}

// ─── Physical Hand-Slot State (the 2 real hands) ──────────────────────────────

function getItemHandSlot(item) {
  const pos = item?.getFlag?.(FLAG_NS, "handSlot");
  return HAND_SLOT_POSITIONS.includes(pos) ? pos : null;
}

function getItemHeldSide(item) {
  const side = item?.getFlag?.(FLAG_NS, "heldSide");
  return side === "melee" || side === "ranged" ? side : null;
}

/**
 * A weapon derives its melee/ranged side from its own weapon type; a consumable or hand-
 * eligible Container (Keg/Bobble) has no inherent side, so it remembers one via a heldSide
 * flag — set once at placement (see validateAndEquipHandItem()'s no-inherent-side branch) or
 * by an explicit drop onto a specific box (equipItemToSlot()) — defaulting to "ranged" absent
 * a flag.
 */
function resolveOccupantSide(item) {
  if (item.type === "weapon") return isRangedWeapon(item) ? "ranged" : "melee";
  return getItemHeldSide(item) === "melee" ? "melee" : "ranged";
}

/**
 * Weapons/shields currently occupying a hand-slot (excludes exempt items —
 * they get their own single slot, see below). `excludeId` — see
 * getPhysicalHandOccupants()'s docblock.
 */
function getHandSlotOccupants(actor, excludeId = null) {
  const occupants = [];
  for (const item of actor.items) {
    if (item.id === excludeId) continue;
    if (!item.system?.equipped || !isHandSlotEligible(item)) continue;
    if (isExempt(item)) continue;
    if (isAmmoItem(item)) continue; // ammo is Quiver-only, never a hand-slot occupant
    occupants.push(item);
  }
  return occupants;
}

/**
 * The 2 real hand-slots (Main/Secondary) and whether a two-handed weapon has
 * collapsed them into one. This is the physical truth that
 * validateAndEquipHandItem()/swapHandSlot() operate on; getHandSlotState()
 * (below) derives the doll's 4-box render view from it.
 *
 * `excludeId`: the updateItem hook fires *after* the item's own equip is
 * already committed, so an un-excluded "before" snapshot would count a
 * two-handed weapon as already occupying both hands by itself, hiding what
 * was actually there and skipping its displacement. Exclude it so "before"
 * genuinely means before.
 */
export function getPhysicalHandOccupants(actor, excludeId = null) {
  const occupants = getHandSlotOccupants(actor, excludeId);
  const twoHanded = occupants.find(isTwoHanded);

  if (twoHanded) {
    return { main: twoHanded, secondary: twoHanded, collapsed: true, collapsedItem: twoHanded };
  }

  const state = { main: null, secondary: null, collapsed: false, collapsedItem: null };
  const unplaced = [];
  for (const item of occupants) {
    const pos = getItemHandSlot(item);
    if (pos && !state[pos]) state[pos] = item;
    else unplaced.push(item);
  }
  // Anything without a valid/free remembered position auto-fills Main then
  // Secondary (covers items equipped outside the doll, e.g. the inventory
  // list's own equip checkbox, which never sets the handSlot flag).
  for (const item of unplaced) {
    if (!state.main) state.main = item;
    else if (!state.secondary) state.secondary = item;
    // If both are already full this item has no visible slot — shouldn't
    // normally happen since validateAndEquipHandItem() enforces capacity.
  }
  return state;
}

/**
 * Resolve the doll's 4 visual hand positions (Melee-Main/-Secondary,
 * Ranged-Main/-Secondary) from the 2 real hands. All 4 boxes always render;
 * an empty box is either open or faded/blocked.
 *
 *   - Weapons keep strict hand-identity: Main always renders as "-Main" of
 *     its matching side, Secondary as "-Secondary" of its matching side.
 *   - A two-handed weapon collapses both hands into one box on its side;
 *     both boxes on the opposite side are faded, blocked by that weapon.
 *   - A shield has no hand-identity: it renders as the "-Main" box of
 *     whichever side is opposite the other hand's weapon type (defaults to
 *     Ranged if the other hand is empty or also a shield). Two shields is
 *     the one case both Mains fill at once.
 *   - An empty box fades only once both physical hands are committed — with
 *     any hand still free, nothing fades, since that hand could still reach
 *     any remaining box. The blocker is whatever occupies the physical hand
 *     that box addresses (Main box → physical Main's item, Secondary box →
 *     physical Secondary's item).
 *
 * Returns `{ collapsedSide, collapsedItem, meleeMain, meleeSecondary,
 * rangedMain, rangedSecondary }`. Each box is shaped `{ item, pos, faded,
 * blocker }` — `pos` is the physical hand this box addresses (used to
 * target the right hand on click/drag), `blocker` is set only when faded.
 */
export function getHandSlotState(actor) {
  const physical = getPhysicalHandOccupants(actor);

  if (physical.collapsed) {
    const side = resolveOccupantSide(physical.collapsedItem);
    const otherSide = side === "melee" ? "ranged" : "melee";
    return {
      collapsedSide: side,
      collapsedItem: physical.collapsedItem,
      [`${side}Main`]: { item: physical.collapsedItem, pos: "main", faded: false, blocker: null },
      [`${side}Secondary`]: { item: null, pos: "secondary", faded: false, blocker: null },
      [`${otherSide}Main`]: { item: null, pos: "main", faded: true, blocker: physical.collapsedItem },
      [`${otherSide}Secondary`]: { item: null, pos: "secondary", faded: true, blocker: physical.collapsedItem },
    };
  }

  const mainType = classifyOccupant(physical.main);
  const secType = classifyOccupant(physical.secondary);

  const boxes = {
    meleeMain: { item: null, pos: "main", faded: false, blocker: null },
    meleeSecondary: { item: null, pos: "secondary", faded: false, blocker: null },
    rangedMain: { item: null, pos: "main", faded: false, blocker: null },
    rangedSecondary: { item: null, pos: "secondary", faded: false, blocker: null },
  };

  const shieldSide = (otherType) => (otherType === "melee" ? "ranged" : otherType === "ranged" ? "melee" : "ranged");

  if (mainType === "shield" && secType === "shield") {
    // Both hands are shields — the one exception where both Mains fill at
    // once. Deterministic split: Main hand → Ranged-Main, Secondary hand →
    // Melee-Main (arbitrary but consistent; render is symmetric either way).
    boxes.rangedMain = { item: physical.main, pos: "main", faded: false, blocker: null };
    boxes.meleeMain = { item: physical.secondary, pos: "secondary", faded: false, blocker: null };
  } else {
    if (mainType === "melee") boxes.meleeMain = { item: physical.main, pos: "main", faded: false, blocker: null };
    else if (mainType === "ranged") boxes.rangedMain = { item: physical.main, pos: "main", faded: false, blocker: null };
    else if (mainType === "shield") {
      const side = shieldSide(secType);
      boxes[`${side}Main`] = { item: physical.main, pos: "main", faded: false, blocker: null };
    }

    if (secType === "melee") boxes.meleeSecondary = { item: physical.secondary, pos: "secondary", faded: false, blocker: null };
    else if (secType === "ranged") boxes.rangedSecondary = { item: physical.secondary, pos: "secondary", faded: false, blocker: null };
    else if (secType === "shield") {
      const side = shieldSide(mainType);
      boxes[`${side}Main`] = { item: physical.secondary, pos: "secondary", faded: false, blocker: null };
    }
  }

  if (physical.main && physical.secondary) {
    for (const key of ["meleeMain", "meleeSecondary", "rangedMain", "rangedSecondary"]) {
      const box = boxes[key];
      if (box.item) continue;
      box.faded = true;
      box.blocker = box.pos === "main" ? physical.main : physical.secondary;
    }
  }

  return { collapsedSide: null, collapsedItem: null, ...boxes };
}

/**
 * Called from the updateItem hook after a weapon/shield's system.equipped
 * is set to true. Enforces the 2-real-hand capacity:
 *   - a two-handed weapon unequips both current occupants (also how it
 *     displaces a shield);
 *   - a one-handed item first unequips a collapsing two-handed weapon (if
 *     merged), then takes over whichever hand it resolves to, unequipping
 *     whatever's displaced there;
 *   - two weapons occupying both hands must form a valid two-weapon pair
 *     (canTwoWeaponFight()) or the opposite hand's item gets displaced too.
 * Which visual box a shield renders in is handled by getHandSlotState()
 * above — this function only reasons about the 2 physical hands. Exempt
 * items (IGNORES_HAND_SLOT) never reach here — see validateAndEquipExempt().
 * Returns the items that were unequipped.
 */
export async function validateAndEquipHandItem(actor, item) {
  if (!isHandSlotEligible(item) || isExempt(item)) return [];

  const unequipped = [];
  const before = getPhysicalHandOccupants(actor, item.id);

  if (isTwoHanded(item)) {
    for (const occupant of [before.main, before.secondary]) {
      if (occupant && occupant.id !== item.id && !unequipped.some(u => u.id === occupant.id)) {
        await occupant.update({ "system.equipped": false }, { render: false });
        unequipped.push(occupant);
      }
    }
    const update = { [`flags.${FLAG_NS}.handSlot`]: "main" };
    if (hasNoInherentHandSide(item)) update[`flags.${FLAG_NS}.heldSide`] = getItemHeldSide(item) ?? "ranged";
    await item.update(update, { render: false });
    if (isRangedWeapon(item)) await syncQuiverAmmoFlag(actor, getQuiverItem(actor));
    return unequipped;
  }

  // One-handed item (weapon, shield, or consumable): if the pair is
  // currently collapsed by a 2H weapon, that weapon must be displaced first.
  if (before.collapsed && before.collapsedItem.id !== item.id) {
    await before.collapsedItem.update({ "system.equipped": false }, { render: false });
    unequipped.push(before.collapsedItem);
  }

  const requestedPos = getItemHandSlot(item);
  const after = before.collapsed ? { main: null, secondary: null } : before;

  // A consumable or hand-eligible Container has no inherent melee/ranged side, so a freshly-
  // placed one (no explicit doll-box drop) prefers whichever hand is open, defaulting to
  // "ranged" - an explicit drop (equipItemToSlot() sets both handSlot and heldSide together)
  // is honored as-is instead.
  let targetPos, targetSide;
  if (hasNoInherentHandSide(item)) {
    const requestedSide = getItemHeldSide(item);
    if (requestedPos && requestedSide) {
      targetPos = requestedPos;
      targetSide = requestedSide;
    } else {
      targetPos = !after.main ? "main" : !after.secondary ? "secondary" : "main";
      targetSide = "ranged";
    }
  } else {
    targetPos = requestedPos ?? (!after.main ? "main" : !after.secondary ? "secondary" : "main");
  }

  const currentOccupant = after[targetPos];
  if (currentOccupant && currentOccupant.id !== item.id) {
    await currentOccupant.update({ "system.equipped": false }, { render: false });
    unequipped.push(currentOccupant);
  }

  const oppositePos = targetPos === "main" ? "secondary" : "main";
  const oppositeOccupant = after[oppositePos];
  if (item.type === "weapon" && oppositeOccupant?.type === "weapon" && oppositeOccupant.id !== item.id
      && !(canTwoWeaponFight(item, actor) && canTwoWeaponFight(oppositeOccupant, actor))) {
    await oppositeOccupant.update({ "system.equipped": false }, { render: false });
    unequipped.push(oppositeOccupant);
  }

  const finalUpdate = { [`flags.${FLAG_NS}.handSlot`]: targetPos };
  if (hasNoInherentHandSide(item)) finalUpdate[`flags.${FLAG_NS}.heldSide`] = targetSide;
  await item.update(finalUpdate, { render: false });
  if (isRangedWeapon(item)) await syncQuiverAmmoFlag(actor, getQuiverItem(actor));
  return unequipped;
}

/**
 * Drag-and-drop swap within a physical pair: moves `item` into `targetPos`,
 * swapping with whatever's already there. Only changes the position flag —
 * both items stay equipped throughout.
 */
export async function swapHandSlot(actor, item, targetPos) {
  if (!HAND_SLOT_POSITIONS.includes(targetPos)) return;
  const state = getPhysicalHandOccupants(actor);
  const occupant = state[targetPos];

  if (occupant && occupant.id !== item.id) {
    const itemPos = getItemHandSlot(item) ?? (targetPos === "main" ? "secondary" : "main");
    await occupant.update({ [`flags.${FLAG_NS}.handSlot`]: itemPos }, { render: false });
  }
  await item.update({ [`flags.${FLAG_NS}.handSlot`]: targetPos }, { render: false });
}

// ─── Exempt Slot (single capacity) ─────────────────────────────────────────────

/** The one currently-equipped exempt item, or null. At most one is ever tracked — see validateAndEquipExempt(). */
export function getExemptItem(actor) {
  for (const item of actor.items) {
    if (item.system?.equipped && isExempt(item)) return item;
  }
  return null;
}

/**
 * True if the actor owns ANY item that could occupy the Exempt slot,
 * equipped or not. Used by the live doll to hide the Exempt position
 * entirely for an actor with nothing that would ever use it.
 */
export function actorHasExemptCapableItem(actor) {
  return actor.items.some(isExempt);
}

/** Every currently-equipped exempt item (there should be at most 1 — used by migration.js to detect and resolve pre-existing overflow). */
export function getAllExemptItems(actor) {
  return actor.items.filter(item => item.system?.equipped && isExempt(item));
}

/**
 * Called from the updateItem hook after an IGNORES_HAND_SLOT item's
 * `system.equipped` is set to true. Single capacity: unequips any other
 * currently-equipped exempt item, same displacement pattern used everywhere
 * else in this module (new equip wins).
 */
export async function validateAndEquipExempt(actor, item) {
  if (!isExempt(item)) return [];

  const unequipped = [];
  for (const other of actor.items) {
    if (other.id === item.id || !other.system?.equipped || !isExempt(other)) continue;
    await other.update({ "system.equipped": false }, { render: false });
    unequipped.push(other);
  }
  return unequipped;
}

// ─── Ring-Slot State ───────────────────────────────────────────────────────────

function getItemRingSlot(item) {
  const pos = item?.getFlag?.(FLAG_NS, "ringSlot");
  return RING_SLOT_POSITIONS.includes(pos) ? pos : null;
}

function getRingOccupants(actor, excludeId = null) {
  return actor.items.filter(item => item.id !== excludeId && item.system?.equipped && getItemSlot(item) === "ring");
}

/**
 * Returns { main: item|null, secondary: item|null }. `excludeId` — same
 * reason as getPhysicalHandOccupants(): without it, a ring being newly
 * equipped counts as already occupying a slot, wrongly displacing the other.
 */
export function getRingSlotState(actor, excludeId = null) {
  const occupants = getRingOccupants(actor, excludeId);
  const state = { main: null, secondary: null };
  const unplaced = [];
  for (const item of occupants) {
    const pos = getItemRingSlot(item);
    if (pos && !state[pos]) state[pos] = item;
    else unplaced.push(item);
  }
  for (const item of unplaced) {
    if (!state.main) state.main = item;
    else if (!state.secondary) state.secondary = item;
  }
  return state;
}

/**
 * Called from the updateItem hook after a ring's `system.equipped` is set to
 * true. Auto-fills Main then Secondary, unequipping whatever currently
 * occupies the resolved slot (capping rings at 2 simultaneously equipped).
 *
 * Returns the list of items that were unequipped, for notification/reporting.
 */
export async function validateAndEquipRing(actor, item) {
  if (getItemSlot(item) !== "ring") return [];

  const before = getRingSlotState(actor, item.id);
  const requestedPos = getItemRingSlot(item);
  const targetPos = requestedPos ?? (!before.main ? "main" : !before.secondary ? "secondary" : "main");

  const unequipped = [];
  const currentOccupant = before[targetPos];
  if (currentOccupant && currentOccupant.id !== item.id) {
    await currentOccupant.update({ "system.equipped": false }, { render: false });
    unequipped.push(currentOccupant);
  }

  await item.update({ [`flags.${FLAG_NS}.ringSlot`]: targetPos }, { render: false });
  return unequipped;
}

/** Drag-and-drop swap within the ring pair — same semantics as swapHandSlot(). */
export async function swapRingSlot(actor, item, targetPos) {
  if (!RING_SLOT_POSITIONS.includes(targetPos)) return;
  const state = getRingSlotState(actor);
  const occupant = state[targetPos];

  if (occupant && occupant.id !== item.id) {
    const itemPos = getItemRingSlot(item) ?? (targetPos === "main" ? "secondary" : "main");
    await occupant.update({ [`flags.${FLAG_NS}.ringSlot`]: itemPos }, { render: false });
  }
  await item.update({ [`flags.${FLAG_NS}.ringSlot`]: targetPos }, { render: false });
}

// ─── Quiver Slot (single-capacity ranged ammo) ─────────────────────────────
// The Quiver holds one real dnd5e ammunition item and keeps every equipped
// ranged weapon that fires it pointed at it via dnd5e's own "last used ammo"
// flag (AttackActivity#rollAttack() reads flags.dnd5e.last.<activityId>.ammunition
// as its default) — AWC doesn't track ammo consumption itself, dnd5e's own
// roll pipeline already does that.

/** True for a real dnd5e ammunition item — quiver-eligible. */
export function isAmmoItem(item) {
  return item?.type === "consumable" && item.system?.type?.value === "ammo";
}

/** The one currently-quivered ammo item, or null. At most one is ever tracked — see validateAndEquipQuiver(). */
export function getQuiverItem(actor) {
  for (const item of actor.items) {
    if (item.system?.equipped && isAmmoItem(item)) return item;
  }
  return null;
}

/**
 * True once a ranged weapon occupies either physical hand — the Quiver only
 * appears once there's something to load it into (mirrors
 * actorHasExemptCapableItem()'s "hide when irrelevant" gate for Exempt, but
 * keyed on equip state rather than ownership).
 */
export function actorHasEquippedRangedWeapon(actor) {
  // Checks the physical hands directly rather than getHandSlotState()'s rendered boxes -
  // that view's shieldSide() defaults a lone shield (nothing in the other hand) into the
  // rangedMain box purely for layout purposes, which this function would otherwise mistake
  // for an actual ranged weapon.
  const physical = getPhysicalHandOccupants(actor);
  return isRangedWeapon(physical.main) || isRangedWeapon(physical.secondary);
}

/** Every equipped ranged weapon whose system.ammunition.type matches the given ammo subtype (dnd5e's own WeaponData#ammunitionOptions getter does the same subtype match). */
function matchingRangedWeapons(actor, subtype) {
  if (!subtype) return [];
  return actor.items.filter(i => i.system?.equipped && isRangedWeapon(i) && i.system?.ammunition?.type === subtype);
}

/** Points every ranged weapon matching `ammoItem`'s subtype's "last used ammo" flag (read by dnd5e's own AttackActivity#rollAttack()) at it, or clears it if `ammoItem` is null. */
async function syncQuiverAmmoFlag(actor, ammoItem) {
  for (const weapon of matchingRangedWeapons(actor, ammoItem?.system?.type?.subtype)) {
    const activity = weapon.system.activities?.getByType?.("attack")?.[0];
    if (!activity) continue;
    await weapon.update({ [`flags.dnd5e.last.${activity.id}.ammunition`]: ammoItem?.id ?? "" }, { render: false });
  }
}

/**
 * Called from the updateItem hook after a real ammunition item's
 * system.equipped is set to true. Single capacity, same displacement
 * pattern as validateAndEquipExempt() — unequips whatever ammo previously
 * occupied the Quiver, then points every currently-equipped ranged weapon
 * that fires this ammo's subtype at it.
 */
export async function validateAndEquipQuiver(actor, item) {
  if (!isAmmoItem(item)) return [];

  const unequipped = [];
  for (const other of actor.items) {
    if (other.id === item.id || !other.system?.equipped || !isAmmoItem(other)) continue;
    await other.update({ "system.equipped": false }, { render: false });
    unequipped.push(other);
  }

  await syncQuiverAmmoFlag(actor, item);
  return unequipped;
}

/** Called from the updateItem hook after a quivered ammo item's system.equipped is set to false — clears the "last used ammo" flag on any ranged weapon still pointing at it. */
export async function clearQuiverAmmoFlag(actor, item) {
  if (!isAmmoItem(item)) return;
  for (const weapon of matchingRangedWeapons(actor, item.system?.type?.subtype)) {
    const activity = weapon.system.activities?.getByType?.("attack")?.[0];
    if (!activity) continue;
    await weapon.update({ [`flags.dnd5e.last.${activity.id}.ammunition`]: "" }, { render: false });
  }
}

/**
 * Called from the updateItem hook after a ranged weapon's system.equipped is set to false.
 * A quivered ammo item with no ranged weapon left to feed is a dangling equip state (the
 * Quiver slot itself already hides once actorHasEquippedRangedWeapon() goes false, but the
 * ammo item's own equipped flag doesn't clear on its own) - unequip it too rather than leave
 * it silently equipped with nothing using it.
 */
export async function autoUnequipQuiverIfNoRangedWeapon(actor) {
  if (actorHasEquippedRangedWeapon(actor)) return;
  const quiverItem = getQuiverItem(actor);
  if (quiverItem) await quiverItem.update({ "system.equipped": false });
}

// ─── Pocketed Carriers (variable-capacity consumable storage) ─────────────────
// A pocketed carrier (any equipped item with AKDP's "pocketed" property checked — e.g. a
// belt or shield) holds 0..N consumables that don't occupy a hand-slot at all — tracked via
// a flag on the CONSUMABLE ITSELF pointing at its carrier (mirrors handSlot/ringSlot's own
// "position flag lives on the occupant" convention), not on the carrier. Capacity/allowed-
// types config (pocketCapacity/pocketTypes) is authored on the carrier's own sheet by the
// companion a-knights-dream-properties module — read-only from here.

/** True if `item` carries AKDP's "pocketed" property — a candidate carrier (capacity may still be 0 if unconfigured). */
export function isPocketCarrier(item) {
  return itemHasMarker(item, ITEM_MARKERS.POCKETED);
}

/**
 * Item ids of pocket carriers just equipped, awaiting an auto-opened pocket viewer the next
 * time their doll slot renders — populated by the updateItem dispatcher below, consumed (and
 * cleared per-id) by the doll apps' own render wiring (paper-doll-app.js / doll-embed.js), so
 * the viewer opens exactly once per equip rather than on every subsequent re-render.
 */
export const pendingPocketReveals = new Set();

/**
 * Item ids of pocket carriers just unequipped (and so already emptied of everything they held
 * - see the updateItem dispatcher below), awaiting a popup close the next time their doll slot
 * renders — a currently-open picker/viewer for that carrier lives outside the doll's own
 * re-rendered DOM (appended to document.body), so an unequip's render wouldn't otherwise touch
 * it. Consumed by paper-doll-app.js's consumePendingPocketCloses().
 */
export const pendingPocketCloses = new Set();

/**
 * carrierId → itemId for a carrier whose pocket window should auto-open (like
 * pendingPocketReveals) AND highlight the specific slot an item just landed in green - set by
 * pocketOnEquipIfEligible() when equipping an item auto-redirects it into a pocket instead of a
 * hand, so it's clear where it actually went. Consumed by paper-doll-app.js's
 * consumePendingPocketHighlights().
 */
export const pendingPocketHighlights = new Map();

/** The GM-configured pocket capacity (AKDP flag) for a carrier item, or 0 if unset/not a carrier. */
export function getPocketCapacity(item) {
  if (!isPocketCarrier(item)) return 0;
  // AKDP's own flag first; falls back to the same field name under AWC's own namespace so a
  // GM without AKDP installed can still configure a carrier by hand (a manually-authored
  // Active Effect targeting flags.armor-weight-class.pocketCapacity) — the same "companion
  // module's checkbox first, GM-authored fallback second" pattern itemHasMarker() already
  // uses for the Pocketed marker itself.
  const cap = Number(item.getFlag?.(AKDP_MODULE_ID, "pocketCapacity") ?? item.getFlag?.(FLAG_NS, "pocketCapacity"));
  return Number.isFinite(cap) ? Math.max(0, cap) : 0;
}

function pocketAcceptsType(carrier, subtype) {
  if (!subtype) return false;
  const types = carrier.getFlag?.(AKDP_MODULE_ID, "pocketTypes") ?? carrier.getFlag?.(FLAG_NS, "pocketTypes");
  return types?.[subtype] === true;
}

/**
 * Real ammo stays Quiver-only — never pocketable, matching AKDP's own pocketTypes choices (no
 * "ammo" option there). A Container is only pocketable as its "Bobble/Vial" sub-type — a small
 * enough thing to tuck into another item's pockets, unlike a Backpack/Belt Pouch/Purse/Keg.
 */
function isPocketableItem(item) {
  if (item?.type === "consumable") return !isAmmoItem(item);
  return item?.type === "container" && getContainerType(item) === "bobble";
}

/** The pocketTypes key an item is matched against — a consumable's own dnd5e subtype, or a Container's AKDP-configured sub-type (has no dnd5e subtype field of its own). */
function pocketSubtype(item) {
  return item.type === "container" ? getContainerType(item) : item.system?.type?.value;
}

/** True if `item` could be pocketed in `carrier` right now — doesn't check capacity, see pocketHasRoom(). */
export function isPocketEligible(item, carrier) {
  if (!isPocketableItem(item) || !carrier?.system?.equipped || !isPocketCarrier(carrier)) return false;
  return pocketAcceptsType(carrier, pocketSubtype(item));
}

/** Every item currently pocketed in `carrier` — actor.items iteration order (creation order), used as "oldest first" for displacement. */
export function getPocketedItems(actor, carrier) {
  return actor.items.filter(i => i.getFlag(FLAG_NS, "pocketedIn") === carrier.id);
}

/** True if `carrier` has room for one more pocketed item. */
export function pocketHasRoom(actor, carrier) {
  return getPocketedItems(actor, carrier).length < getPocketCapacity(carrier);
}

/** Every equipped item on `actor` that's a currently-eligible pocket carrier for `item` (ignores capacity/fullness — callers distinguish open vs. full themselves). */
export function eligiblePocketCarriers(actor, item) {
  return actor.items.filter(carrier => carrier.system?.equipped && isPocketEligible(item, carrier));
}

/** Every currently-unplaced item on `actor` (not equipped, not already pocketed anywhere) eligible to be clicked/dropped into `carrier`'s pockets - the pocket-window equivalent of eligibleItemsForSlot() for a regular doll slot. */
export function eligiblePocketableItems(actor, carrier) {
  return actor.items.filter(i => !i.system?.equipped && !i.getFlag(FLAG_NS, "pocketedIn") && isPocketEligible(i, carrier));
}

/**
 * Places `item` into `carrier`'s pockets: clears any hand-slot placement it currently holds
 * (unequips it, clears handSlot/heldSide) and points its pocketedIn flag at the carrier —
 * never goes through equipItemToSlot()/the normal hand-slot equip path, and never sets
 * system.equipped=true on the pocketed item (it's carried by its carrier, not separately
 * "worn"). Capacity/displacement is the CALLER's responsibility — see paper-doll-app.js's
 * handlePocketDrop(), which also needs dropItemViaItemPiles() for the mid-combat disposal
 * case and is kept there specifically to avoid a circular import (paper-doll-app.js already
 * imports FROM this file).
 */
export async function pocketItem(item, carrier) {
  const updates = { [`flags.${FLAG_NS}.pocketedIn`]: carrier.id };
  if (item.system?.equipped) {
    updates["system.equipped"] = false;
    updates[`flags.${FLAG_NS}.-=handSlot`] = null;
    updates[`flags.${FLAG_NS}.-=heldSide`] = null;
  }
  await item.update(updates);
}

/** Removes `item` from whatever carrier's pockets it's in — a normal loose inventory item again. */
export async function unpocketItem(item) {
  await item.update({ [`flags.${FLAG_NS}.-=pocketedIn`]: null });
}

/**
 * Called from the updateItem hook after a hand-slot-eligible item's system.equipped is set to
 * true, before validateAndEquipHandItem() runs — if a currently-equipped pocket carrier can
 * take this item, it goes there instead of into a hand, even if that means displacing whatever
 * else that carrier already holds (oldest first, back to loose inventory - not a ground drop;
 * this is an incidental side effect of equipping, not an explicit "get rid of this" gesture
 * like the carrier's own right-click). Prefers a carrier with open room over one that would
 * need to displace something. Returns true if it pocketed the item (caller should skip the
 * normal hand-slot equip path entirely), false if there's no eligible carrier at all.
 */
export async function pocketOnEquipIfEligible(actor, item) {
  const carriers = eligiblePocketCarriers(actor, item);
  if (!carriers.length) return false;

  const carrier = carriers.find(c => pocketHasRoom(actor, c)) ?? carriers[0];
  if (!pocketHasRoom(actor, carrier)) {
    const [oldest] = getPocketedItems(actor, carrier);
    if (oldest) await unpocketItem(oldest);
  }
  await pocketItem(item, carrier);
  pendingPocketHighlights.set(carrier.id, item.id);
  return true;
}

/**
 * Mid-combat right-click/auto-drop: creates ONE ground pile with all of `items` under the
 * actor's own token via the Item Piles module, then deletes every one of them from the actor -
 * a real drop, not a duplicate. Item Piles' own createItemPile() relays through a GM client
 * internally, so no extra permission handling is needed here. Returns false (nothing dropped,
 * caller should fall back to a plain unequip/no-op) if there's no active token to drop under.
 * Lives here rather than paper-doll-app.js (which already imports FROM this file) specifically
 * so the updateItem dispatcher below can call it too, for the auto-unpocket-on-unequip case.
 */
export async function dropItemsViaItemPiles(actor, items) {
  const token = actor.getActiveTokens(false, false)[0];
  if (!token) return false;

  await game.itempiles.API.createItemPile({
    position: { x: token.center.x, y: token.center.y },
    sceneId: token.scene?.id ?? game.user.viewedScene,
    items: items.map(i => i.toObject()),
  });
  for (const i of items) await i.delete();
  return true;
}

/** Single-item convenience wrapper around dropItemsViaItemPiles(). */
export async function dropItemViaItemPiles(actor, item) {
  return dropItemsViaItemPiles(actor, [item]);
}

/**
 * A pocket carrier's own ground-drop bundles whatever's currently pocketed in it into the SAME
 * pile, rather than dropping the carrier alone and leaving its contents orphaned (pointing at a
 * now-deleted carrier id) or silently un-pocketed. A non-carrier (or an unstocked carrier) just
 * drops itself, same as dropItemViaItemPiles().
 */
export async function dropCarrierAndPocketsViaItemPiles(actor, item) {
  const pocketed = isPocketCarrier(item) ? getPocketedItems(actor, item) : [];
  return dropItemsViaItemPiles(actor, [item, ...pocketed]);
}

// ─── updateItem registration ───────────────────────────────────────────────────

Hooks.on("updateItem", async (item, changes, _options, _userId) => {
  const equippedChanged = changes?.system?.equipped !== undefined || "system.equipped" in (changes ?? {});
  if (!equippedChanged) return;

  const actor = item.actor;
  if (!actor || actor.type !== "character") return;

  const beingEquipped = changes?.system?.equipped === true || changes?.["system.equipped"] === true;

  if (beingEquipped && isPocketCarrier(item)) pendingPocketReveals.add(item.id);

  if (!beingEquipped) {
    if (isPocketCarrier(item)) {
      // Mid-combat with Item Piles active, a pocket carrier coming off is dropped for real -
      // itself AND everything in its pockets, together in one pile - rather than left sitting
      // unequipped in inventory with its contents quietly returned to loose inventory. Matches
      // the same "combat = no time to carefully repack, it just hits the ground" reasoning
      // _onContextMenu's own item-piles right-click drop already uses.
      if (game.combat && game.modules.get("item-piles")?.active) {
        console.debug(`${LOG} pocket-carrier unequip on "${actor.name}" mid-combat — dropping it and its contents together`);
        await dropCarrierAndPocketsViaItemPiles(actor, item);
      } else {
        console.debug(`${LOG} pocket-carrier unequip on "${actor.name}" — emptying its pockets`);
        for (const pocketed of getPocketedItems(actor, item)) await unpocketItem(pocketed);
      }
      pendingPocketCloses.add(item.id);
    }
    if (isAmmoItem(item)) {
      console.debug(`${LOG} quiver-slot unequip on "${actor.name}"`);
      await clearQuiverAmmoFlag(actor, item);
    } else if (isRangedWeapon(item)) {
      console.debug(`${LOG} ranged weapon unequip on "${actor.name}" — checking Quiver`);
      await autoUnequipQuiverIfNoRangedWeapon(actor);
    }
    return;
  }

  if (isExempt(item)) {
    console.debug(`${LOG} exempt-slot equip change on "${actor.name}"`);
    await validateAndEquipExempt(actor, item);
  } else if (isHandSlotEligible(item) && (await pocketOnEquipIfEligible(actor, item))) {
    console.debug(`${LOG} equip-triggered auto-pocket on "${actor.name}" (preferred over hand-slot)`);
  } else if (isHandSlotEligible(item)) {
    console.debug(`${LOG} hand-slot equip change on "${actor.name}"`);
    await validateAndEquipHandItem(actor, item);
  } else if (getItemSlot(item) === "ring") {
    console.debug(`${LOG} ring-slot equip change on "${actor.name}"`);
    await validateAndEquipRing(actor, item);
  } else if (isAmmoItem(item)) {
    console.debug(`${LOG} quiver-slot equip change on "${actor.name}"`);
    await validateAndEquipQuiver(actor, item);
  }
});
