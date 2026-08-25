/**
 * paired-slots.js
 * Main/Secondary hand-slots (weapons + shields), Main/Secondary ring-slots,
 * and the single-capacity Exempt slot (ignoresHandSlot-marked items).
 *
 * Hand-slots and ring-slots are "paired slots": two real positions,
 * auto-filled Main then Secondary, placement remembered via a per-item flag
 * (weapons/shields/rings have no native field for hand/finger position,
 * unlike armor sub-types), and swappable via drag-and-drop.
 *
 * The doll shows hand-slot occupants across 4 visual boxes (Melee-Main/
 * -Secondary, Ranged-Main/-Secondary) even though there are only 2 real
 * hands — see getHandSlotState() for the placement algorithm.
 * getPhysicalHandOccupants() is the underlying 2-hand truth; getHandSlotState()
 * derives the 4-box render view from it.
 */

import { FLAG_NS, MODULE_ID, HAND_SLOT_POSITIONS, RING_SLOT_POSITIONS, WEAPON_TWO_HANDED_PROPERTY, WEAPON_LIGHT_PROPERTY, ITEM_MARKERS } from "./constants.js";
import { getItemSlot, itemHasMarker } from "./slots.js";

const LOG = `${MODULE_ID} |`;

// ─── Weapon/Shield Helpers ─────────────────────────────────────────────────────

/**
 * True if `item` is a weapon with the given dnd5e `system.properties` Set
 * member. Defensively handles both the modern Set-based properties model
 * and a legacy plain-object shape, mirroring getItemSlot()'s tolerance for
 * old data formats.
 */
function weaponHasProperty(item, propertyKey) {
  if (item?.type !== "weapon") return false;
  const props = item.system?.properties;
  if (!props) return false;
  if (typeof props.has === "function") return props.has(propertyKey);
  return !!props[propertyKey];
}

/** True for a two-handed weapon. */
export function isTwoHanded(item) {
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

/** A shield or weapon can occupy a hand-slot. Everything else is ignored here. */
function isHandSlotEligible(item) {
  return item?.type === "weapon" || isShield(item);
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
  if (item.type === "weapon") return isRangedWeapon(item) ? "ranged" : "melee";
  return null;
}

// ─── Physical Hand-Slot State (the 2 real hands) ──────────────────────────────

function getItemHandSlot(item) {
  const pos = item?.getFlag?.(FLAG_NS, "handSlot");
  return HAND_SLOT_POSITIONS.includes(pos) ? pos : null;
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
function getPhysicalHandOccupants(actor, excludeId = null) {
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
    const side = isRangedWeapon(physical.collapsedItem) ? "ranged" : "melee";
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
    await item.update({ [`flags.${FLAG_NS}.handSlot`]: "main" }, { render: false });
    return unequipped;
  }

  // One-handed item (weapon or shield): if the pair is currently collapsed
  // by a 2H weapon, that weapon must be displaced first.
  if (before.collapsed && before.collapsedItem.id !== item.id) {
    await before.collapsedItem.update({ "system.equipped": false }, { render: false });
    unequipped.push(before.collapsedItem);
  }

  const requestedPos = getItemHandSlot(item);
  const after = before.collapsed ? { main: null, secondary: null } : before;
  const targetPos = requestedPos ?? (!after.main ? "main" : !after.secondary ? "secondary" : "main");

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

  await item.update({ [`flags.${FLAG_NS}.handSlot`]: targetPos }, { render: false });
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
// Items marked IGNORES_HAND_SLOT render in their own dedicated single doll
// position (bottom-center, above Necklace) instead of a Main/Secondary hand.

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
// Identical mechanism to hand-slots, but for `ring`-typed items (which
// slots.js deliberately skips — see SLOT_TYPES.ring.paired in constants.js).

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

// ─── updateItem registration ───────────────────────────────────────────────────
// Registered here (co-located with the logic it guards) rather than in
// hooks.js, matching this module's convention that `Hooks.on` calls live
// alongside the handler they trigger when the handler is subsystem-specific.

Hooks.on("updateItem", async (item, changes, _options, _userId) => {
  const equippedChanged = changes?.system?.equipped !== undefined || "system.equipped" in (changes ?? {});
  if (!equippedChanged) return;

  const actor = item.actor;
  if (!actor || actor.type !== "character") return;

  const beingEquipped = changes?.system?.equipped === true || changes?.["system.equipped"] === true;
  if (!beingEquipped) return;

  if (isExempt(item)) {
    console.debug(`${LOG} exempt-slot equip change on "${actor.name}"`);
    await validateAndEquipExempt(actor, item);
  } else if (isHandSlotEligible(item)) {
    console.debug(`${LOG} hand-slot equip change on "${actor.name}"`);
    await validateAndEquipHandItem(actor, item);
  } else if (getItemSlot(item) === "ring") {
    console.debug(`${LOG} ring-slot equip change on "${actor.name}"`);
    await validateAndEquipRing(actor, item);
  }
});
