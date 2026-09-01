/**
 * apps/paper-doll-app.js
 * The visual equipment doll. Every slot is derived fresh, on every render,
 * from AWC's own slot system (slots.js / paired-slots.js) — an item's own
 * Equipment Type (or, for weapons/rings, its hand/ring-slot position flag)
 * IS the doll's source of truth; no separate flag-based bookkeeping like
 * the original fvtt-paper-doll-ui module had.
 *
 * Layout: each non-paired SLOT_TYPES sub-type gets its own doll position,
 * except the head "base layer" (Padding/Crown/Hat) — mutually exclusive,
 * so grouped into one shared box (GROUPED_SLOTS).
 *
 * Armor column (left, under Helmet) mirrors a clothing column (right,
 * under the head-base group), each row pairing an armor piece with the
 * clothing layer worn underneath (Breast/Tunic, Greaves/Trouser,
 * Gauntlet/Glove, Sabaton/Shoe). Top-center row: carried goods
 * (Backpack/Belt/Pouch). Bottom-center row: Exempt above the two Ring
 * positions flanking Necklace. Bottom itself: two fixed areas, Melee
 * (left) and Ranged (right), each showing 0-2 hand-slot boxes — see
 * paired-slots.js's getHandSlotState() for the placement algorithm. Rings
 * and hand items are the paired-slot exceptions to "derive placement from
 * the item itself".
 */

import { MODULE_ID, FLAG_NS, SLOT_TYPES, ITEM_MARKERS, DRAG_OCCUPIED_CLASS, DRAG_EMPTY_CLASS, DRAG_TARGET_CLASS } from "../constants.js";
import { getSlotMap, getItemSlot, itemHasMarker } from "../slots.js";
import {
  getHandSlotState, getRingSlotState, getExemptItem, actorHasExemptCapableItem, swapHandSlot, swapRingSlot, describeHandBlocker,
  getQuiverItem, actorHasEquippedRangedWeapon, isAmmoItem, getPhysicalHandOccupants, isTwoHanded, isRangedWeapon,
  isPocketCarrier, isPocketEligible, pocketHasRoom, getPocketedItems, pocketItem, unpocketItem, isHandEligibleContainer,
  pendingPocketReveals, getPocketCapacity, pendingPocketCloses, dropItemViaItemPiles, dropCarrierAndPocketsViaItemPiles,
  eligiblePocketableItems, pendingPocketHighlights,
} from "../paired-slots.js";
import { applyDropHighlights } from "../drag-highlight.js";
import { AWCApplication } from "./awc-application.js";

// A "grouped slot" shares one visual doll position across several mutually-
// exclusive SLOT_TYPES keys. Exported so AWCDollLayoutConfig (the standalone
// layout editor) resolves the same groupings.
export const GROUPED_SLOTS = {
  headBase: { keys: ["padding", "crown", "hat"], label: "Head Covering", icon: "fas fa-hat-wizard" },
};

// Exported so AWCDollLayoutConfig (the standalone, actor-independent layout
// editor) renders the exact same set of positions without duplicating the list.
// "headBase" is a GROUPED_SLOTS key, not a SLOT_TYPES key — see buildGroupedSlotEntry().
export const LEFT_COLUMN = ["helmet", "mask", "breast", "gauntlet", "greaves", "boots"];
export const RIGHT_COLUMN = ["headBase", "cape", "shirt", "glove", "trouser", "shoes"];
export const CENTER_TOP_ROW = ["backpack", "belt", "purse"];

export const PAPER_DOLL_WIDTH = 420;

// ─── Doll layout building (shared by the live doll and the standalone layout editor) ───

/** GM-configurable empty-slot images (world-shared), keyed by slot key / "hand" / "ring" / "exempt". */
export function getDollLayout() {
  return game.settings.get(MODULE_ID, "dollLayout") ?? {};
}

/** Shared by AWCPaperDoll (live, per-actor) and AWCDollLayoutConfig (standalone editor). */
export function buildSlotEntry(dollLayout, key, item) {
  const def = SLOT_TYPES[key];
  const emptyImg = dollLayout.slotImages?.[key] ?? "";
  return { kind: "slot", key, label: def.label, icon: def.icon, item, emptyImg, empty: item ? "" : "awc-doll-empty" };
}

/**
 * Builds the merged entry for a GROUPED_SLOTS position. `slotMap` is
 * `getSlotMap(actor)` for the live doll, or `{}` for the actor-independent
 * config window (where every position is always shown empty). At most one
 * member key will ever have an item, since the group's members are kept
 * mutually exclusive by slots.js's SLOT_CONFLICTS.
 */
export function buildGroupedSlotEntry(dollLayout, groupKey, slotMap = {}) {
  const group = GROUPED_SLOTS[groupKey];
  const item = group.keys.map(k => slotMap[k]).find(Boolean) ?? null;
  const emptyImg = dollLayout.slotImages?.[groupKey] ?? "";
  return { kind: "slot", key: groupKey, label: group.label, icon: group.icon, item, emptyImg, empty: item ? "" : "awc-doll-empty" };
}

export function buildRingEntry(dollLayout, pos, item) {
  const emptyImg = dollLayout.ringImage ?? "";
  return { kind: "ring", pos, label: pos === "main" ? "Main Ring" : "Secondary Ring", icon: "fas fa-ring", item, emptyImg, empty: item ? "" : "awc-doll-empty" };
}

/** The single Exempt position (ignoresHandSlot-marked items) — see paired-slots.js's getExemptItem(). */
export function buildExemptEntry(dollLayout, item) {
  const emptyImg = dollLayout.exemptImage ?? "";
  return { kind: "exempt", label: "Exempt", icon: "fas fa-star", item, emptyImg, empty: item ? "" : "awc-doll-empty" };
}

/** The single Quiver position (real dnd5e ammo) — see paired-slots.js's getQuiverItem(). Rendered above just the Ranged hand-pair, conditionally (actorHasEquippedRangedWeapon()). */
export function buildQuiverEntry(dollLayout, item) {
  const emptyImg = dollLayout.quiverImage ?? "";
  return {
    kind: "quiver", label: "Quiver", icon: "fas fa-bullseye", item, emptyImg, empty: item ? "" : "awc-doll-empty",
    quantity: item?.system?.quantity ?? null,
  };
}

/**
 * Empty-state image for a hand-slot side (Melee/Ranged share one image
 * across Main/Secondary — dollLayout.handImage's `{melee, ranged}` shape).
 * Tolerates a pre-4.x dollLayout where handImage was a single flat string
 * shared by every hand box — that legacy value applies to both sides until
 * explicitly overridden, rather than discarding a GM's prior setup.
 */
export function resolveHandEmptyImg(dollLayout, side) {
  const val = dollLayout.handImage;
  if (typeof val === "string") return val;
  return val?.[side] ?? "";
}

/**
 * One hand-slot box (Melee/Ranged × Main/Secondary), built from a
 * getHandSlotState() box (`{item, pos, faded, blocker}`). Wraps it into the
 * same `{kind, item, emptyImg, empty}` shape every other slot entry uses,
 * plus `side`/`box`/`pos` for click/drag routing and
 * `faded`/`blockerName`/`blockerReason` for the "can't be used right now"
 * hover state. label/collapsed-ness are the caller's concern (buildHandGroup).
 */
function buildHandBoxEntry(dollLayout, side, boxKey, box, label) {
  const emptyImg = resolveHandEmptyImg(dollLayout, side);
  return {
    kind: "hand", side, box: boxKey, pos: box.pos, label, icon: "fas fa-hand-fist", emptyImg,
    item: box.item,
    empty: box.item ? "" : "awc-doll-empty",
    faded: box.faded ? "awc-doll-faded" : "",
    blockerName: box.blocker?.name ?? "",
    blockerReason: box.blocker ? describeHandBlocker(box.blocker) : "",
  };
}

/**
 * Builds one side's (melee or ranged) hand boxes from the full
 * getHandSlotState() result. An empty box is either open (reachable by a
 * free hand) or faded (blocked by what's equipped elsewhere — see
 * getHandSlotState()'s docblock). A collapsed 2H weapon renders as a single
 * merged box (the side's Main box); the Secondary box isn't rendered
 * alongside it.
 *
 * Render order: Main in the doll's outer corner, Secondary toward the
 * center. Bottom row reads left-to-right: Melee-Main, Melee-Secondary,
 * [rings], Ranged-Secondary, Ranged-Main — Ranged's DOM order is reversed
 * since it's the rightmost group, so Main still lands in the corner.
 */
export function buildHandGroup(dollLayout, side, handState) {
  const mainKey = `${side}Main`;
  const secKey = `${side}Secondary`;
  const mainBox = handState[mainKey];
  const secBox = handState[secKey];
  const collapsed = handState.collapsedSide === side;

  const mainEntry = buildHandBoxEntry(dollLayout, side, mainKey, mainBox, collapsed ? "Hand" : "Main Hand");
  if (collapsed) return { side, collapsed, slots: [mainEntry] };

  const secEntry = buildHandBoxEntry(dollLayout, side, secKey, secBox, "Secondary Hand");
  const slots = side === "ranged" ? [secEntry, mainEntry] : [mainEntry, secEntry];
  return { side, collapsed, slots };
}

/** Resolves which dollLayout key(s) a slot's empty-state image lives under. Returns [topKey, subKey|null]. */
export function resolveDollLayoutKey(slot) {
  if (slot.kind === "slot") return ["slotImages", slot.key];
  if (slot.kind === "hand") return ["handImage", slot.side];
  if (slot.kind === "ring") return ["ringImage", null];
  if (slot.kind === "exempt") return ["exemptImage", null];
  if (slot.kind === "quiver") return ["quiverImage", null];
  return [null, null];
}

/**
 * Opens a FilePicker to set/change a slot's world-shared empty-state image
 * (dollLayout setting). Shared by AWCPaperDoll (right-click an empty slot)
 * and AWCDollLayoutConfig (left-click any slot, matching the original
 * module's dedicated layout-editor UX).
 */
export function pickSlotImage(slot) {
  const [topKey, subKey] = resolveDollLayoutKey(slot);
  if (!topKey) return;

  const layout = getDollLayout();
  const current = subKey ? (layout[topKey]?.[subKey] ?? "") : (layout[topKey] ?? "");

  const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
  new FP({
    type: "image",
    current,
    callback: async (path) => {
      const updated = foundry.utils.deepClone(layout);
      if (subKey) {
        // ??= alone would leave a pre-existing legacy string (e.g. an old
        // flat handImage value) in place, and assigning a property onto a
        // string primitive throws under ES module strict mode.
        if (typeof updated[topKey] !== "object" || updated[topKey] === null) updated[topKey] = {};
        updated[topKey][subKey] = path;
      } else {
        updated[topKey] = path;
      }
      await game.settings.set(MODULE_ID, "dollLayout", updated);
    },
  }).render(true);
}

/** Clears a slot's custom empty-state image, reverting it to the default icon. */
export async function clearSlotImage(slot) {
  const [topKey, subKey] = resolveDollLayoutKey(slot);
  if (!topKey) return;
  const layout = foundry.utils.deepClone(getDollLayout());
  if (subKey) { if (layout[topKey]) delete layout[topKey][subKey]; }
  else delete layout[topKey];
  await game.settings.set(MODULE_ID, "dollLayout", layout);
}

// ─── Slot addressing / interaction primitives ─────────────────────────────
// Extracted as free functions (parameterized on an explicit `actor` rather
// than `this.actor`) so scripts/doll-embed.js can reuse the exact same
// logic for the sheet-embedded doll — AWCPaperDoll's own methods below are
// now thin wrappers delegating to these, so the pop-out's behavior is
// unchanged.

/** Reads a doll slot descriptor back off its DOM element's data-* attributes. */
export function slotFromElement(el) {
  return { kind: el.dataset.kind, key: el.dataset.key, pos: el.dataset.pos, side: el.dataset.side, box: el.dataset.box };
}

/**
 * Consumes any pending auto-reveal (paired-slots.js's pendingPocketReveals, populated when a
 * pocket carrier is equipped) for the doll slots just rendered — calls
 * showViewer(slotEl, carrier, pocketedItems) once per matching slot, then forgets it, so it
 * fires exactly once regardless of how many times the doll re-renders afterward. Out of combat
 * only, matching the click-triggered viewer's own scoping (mid-combat, a click opens the
 * picker instead) — a reveal that happens to land mid-combat is simply dropped, not deferred.
 */
export function consumePendingPocketReveals(actor, slotEls, showViewer) {
  for (const slotEl of slotEls) {
    const item = itemForSlot(actor, slotFromElement(slotEl));
    if (!item || !pendingPocketReveals.has(item.id)) continue;
    pendingPocketReveals.delete(item.id);
    if (!game.combat) showViewer(slotEl, item, getPocketedItems(actor, item));
  }
}

/**
 * Closes any open pocket picker/viewer for a carrier that just got unequipped (paired-slots.js's
 * pendingPocketCloses, populated by the updateItem hook when unequipping also unpockets
 * everything the carrier held) - popups are tagged with data-carrier-id (see _showPocketPicker/
 * _showPocketViewer) at creation, since they live outside the doll's own re-rendered DOM
 * (appended to document.body) and wouldn't otherwise be touched by an unequip's re-render.
 */
export function consumePendingPocketCloses() {
  for (const id of pendingPocketCloses) {
    document.querySelectorAll(`.awc-doll-picker[data-carrier-id="${id}"]`).forEach(el => el.remove());
  }
  pendingPocketCloses.clear();
}

/**
 * Consumes any pending "item just got auto-pocketed via equip" signal (paired-slots.js's
 * pendingPocketHighlights, populated by pocketOnEquipIfEligible() when equipping something
 * redirects it into a pocket instead of a hand) for the doll slots just rendered — calls
 * showViewer(slotEl, carrier, pocketedItems, itemId) once per matching carrier, then forgets
 * it, same one-shot lifecycle as consumePendingPocketReveals(). Out of combat only, matching
 * that same scoping (mid-combat, a click opens the activity picker instead of the plain viewer).
 */
export function consumePendingPocketHighlights(actor, slotEls, showViewer) {
  for (const slotEl of slotEls) {
    const item = itemForSlot(actor, slotFromElement(slotEl));
    if (!item || !pendingPocketHighlights.has(item.id)) continue;
    const highlightItemId = pendingPocketHighlights.get(item.id);
    pendingPocketHighlights.delete(item.id);
    if (!game.combat) showViewer(slotEl, item, getPocketedItems(actor, item), highlightItemId);
  }
}

/** Resolves the item currently occupying `slot` for `actor` — re-derived fresh every call, never cached. */
// ─── Item ↔ slot eligibility ───────────────────────────────────────────────
export function itemForSlot(actor, slot) {
  if (slot.kind === "slot") {
    const map = getSlotMap(actor);
    const group = GROUPED_SLOTS[slot.key];
    if (group) return group.keys.map(k => map[k]).find(Boolean) ?? null;
    return map[slot.key] ?? null;
  }
  if (slot.kind === "hand") {
    const state = getHandSlotState(actor);
    return state[slot.box]?.item ?? null;
  }
  if (slot.kind === "ring") {
    const state = getRingSlotState(actor);
    return state[slot.pos] ?? null;
  }
  if (slot.kind === "exempt") {
    return getExemptItem(actor);
  }
  if (slot.kind === "quiver") {
    return getQuiverItem(actor);
  }
  return null;
}

/** True if `item` (any item, not necessarily this actor's own) matches what `slot` accepts. */
export function isItemEligibleForSlot(item, slot) {
  if (slot.kind === "slot") {
    const group = GROUPED_SLOTS[slot.key];
    if (group) return group.keys.includes(getItemSlot(item));
    return getItemSlot(item) === slot.key;
  }
  if (slot.kind === "hand") {
    if (!(item.type === "weapon" || item.type === "consumable" || isHandEligibleContainer(item) || (item.type === "equipment" && getItemSlot(item) === "shield"))) return false;
    if (itemHasMarker(item, ITEM_MARKERS.IGNORES_HAND_SLOT) || isAmmoItem(item)) return false;
    // A weapon only fits a hand box matching its own melee/ranged side - both boxes on that
    // side (Main and Secondary) count, since a two-handed weapon can be dropped on either one
    // to trigger the same collapse-both-hands placement. A shield/consumable/hand-eligible
    // Container has no inherent side (its actual side is resolved at equip time - see
    // resolveOccupantSide() in paired-slots.js), so either side stays eligible for those.
    if (item.type === "weapon" && slot.side) {
      return (isRangedWeapon(item) ? "ranged" : "melee") === slot.side;
    }
    return true;
  }
  if (slot.kind === "ring") return getItemSlot(item) === "ring";
  if (slot.kind === "exempt") {
    return (item.type === "weapon" || (item.type === "equipment" && getItemSlot(item) === "shield"))
      && itemHasMarker(item, ITEM_MARKERS.IGNORES_HAND_SLOT);
  }
  if (slot.kind === "quiver") return isAmmoItem(item);
  return false;
}

/**
 * Resolves where `item` should go for a "drop anywhere on the doll" gesture - the doll's
 * portrait background, or any gap between boxes, rather than a specific .awc-doll-slot.
 * Checked in the same priority order the updateItem hook dispatcher already uses (exempt →
 * hand → ring → quiver) via bare, position-less slot descriptors - isItemEligibleForSlot's
 * "hand" branch already treats a missing `side` as "any side is fine", so this deliberately
 * doesn't pick a specific box: equipItemToSlot()/validateAndEquipHandItem() already treat a
 * missing position as "use the smart default" (prefer Main if free, else Secondary), which is
 * exactly the wanted behavior for a genuinely ambiguous item (e.g. a Light weapon) dropped
 * imprecisely - no new placement logic needed. Falls back to a regular armor/clothing/jewelry
 * slot via getItemSlot(), routing through GROUPED_SLOTS the same way every other slot-key
 * resolution in this file already does. Returns null if the item isn't equippable at all.
 */
export function resolveGenericEquipTarget(item) {
  for (const candidate of [{ kind: "exempt" }, { kind: "hand" }, { kind: "ring" }, { kind: "quiver" }]) {
    if (isItemEligibleForSlot(item, candidate)) return candidate;
  }
  const slotKey = getItemSlot(item);
  if (!slotKey) return null;
  const groupKey = Object.keys(GROUPED_SLOTS).find(g => GROUPED_SLOTS[g].keys.includes(slotKey));
  const candidate = { kind: "slot", key: groupKey ?? slotKey };
  return isItemEligibleForSlot(item, candidate) ? candidate : null;
}

/** Every currently-unequipped item on `actor` eligible to be dropped/clicked into `slot`. */
export function eligibleItemsForSlot(actor, slot) {
  return actor.items.filter(i => !i.system?.equipped && isItemEligibleForSlot(i, slot));
}

/** Equips `item` into `slot`, remembering the specific hand/ring position when the box addresses one. Conflict/capacity resolution runs from the resulting updateItem hook — never duplicated here. */
// ─── Equip / pocket-drop actions ───────────────────────────────────────────
export async function equipItemToSlot(item, slot) {
  const update = { "system.equipped": true };
  if (slot.kind === "hand" && slot.pos) update[`flags.${FLAG_NS}.handSlot`] = slot.pos;
  if (slot.kind === "hand" && slot.side && (item.type === "consumable" || isHandEligibleContainer(item))) update[`flags.${FLAG_NS}.heldSide`] = slot.side;
  if (slot.kind === "ring" && slot.pos) update[`flags.${FLAG_NS}.ringSlot`] = slot.pos;
  if (item.getFlag(FLAG_NS, "pocketedIn")) update[`flags.${FLAG_NS}.-=pocketedIn`] = null;
  await item.update(update);
}

/**
 * Drop-onto-carrier orchestration shared by AWCPaperDoll._onDrop and doll-embed.js's onDrop —
 * stashes `item` in `carrier`'s pockets, displacing its oldest occupant first if full. A
 * displaced item is dropped to the ground (mid-combat, Item Piles active) or simply
 * unpocketed back to loose inventory otherwise — never automatically re-equipped anywhere.
 */
export async function handlePocketDrop(actor, item, carrier) {
  const [oldest] = pocketHasRoom(actor, carrier) ? [] : getPocketedItems(actor, carrier);
  await handleTargetedPocketDrop(actor, item, carrier, oldest);
}

/**
 * Displaces `existingItem` (a SPECIFIC pocketed item, or null/undefined if the target slot was
 * already empty) before pocketing `item` in its place - handlePocketDrop() above is the
 * "displace whatever's oldest" case (dropping on the carrier's own doll slot); dropping
 * directly on one of the carrier's individually revealed pocket-slot boxes (drag-highlight.js's
 * openDragPocketWindow) targets that exact slot's occupant instead.
 */
export async function handleTargetedPocketDrop(actor, item, carrier, existingItem) {
  if (existingItem) {
    if (game.combat && game.modules.get("item-piles")?.active) await dropItemViaItemPiles(actor, existingItem);
    else await unpocketItem(existingItem);
  }
  await pocketItem(item, carrier);
}

/**
 * Resolves the item from a native drop event's dataTransfer payload, adopting a foreign item
 * onto `actor` first if dollAllowNonOwned allows it - the same resolution _onDrop/_onDropAnywhere
 * perform, factored out for drag-highlight.js's drag-revealed pocket-slot drop targets, which
 * have no equivalent of those methods' own `this.actor`.
 */
export async function resolveDroppedItem(event, actor) {
  let data;
  try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
  catch { return null; }
  if (!data?.uuid) return null;

  let item = await fromUuid(data.uuid);
  if (!item) return null;

  if (item.parent?.id !== actor.id) {
    if (!game.settings.get(MODULE_ID, "dollAllowNonOwned")) return null;
    const [created] = await actor.createEmbeddedDocuments("Item", [item.toObject()]);
    item = created;
  }
  return item;
}

/**
 * A versatile weapon dropped directly onto a hand box already holding a
 * DIFFERENT versatile weapon redirects to the opposite physical hand
 * instead of displacing it. Only rewrites the target slot descriptor —
 * whatever's actually in the opposite hand is still resolved by
 * validateAndEquipHandItem()'s own displacement/two-weapon-fighting rules
 * once equipped, same as any other drop.
 */
export function redirectVersatileDrop(actor, item, targetSlot) {
  if (targetSlot.kind !== "hand" || isTwoHanded(item) || !item.system?.isVersatile) return targetSlot;

  const occupant = itemForSlot(actor, targetSlot);
  if (!occupant || occupant.id === item.id || !occupant.system?.isVersatile) return targetSlot;

  const oppositePos = targetSlot.pos === "main" ? "secondary" : "main";
  const box = `${targetSlot.side}${oppositePos === "main" ? "Main" : "Secondary"}`;
  return { kind: "hand", side: targetSlot.side, box, pos: oppositePos };
}

/** Hover-tooltip HTML for an equipped item's doll slot: name, AC/damage, resistances, value. */
// ─── Tooltip / label builders ──────────────────────────────────────────────
export function buildTooltipHTML(actor, item) {
  const lines = [`<strong>${item.name}</strong>`];

  const acValue = Number(item.system?.armor?.value ?? 0);
  if (acValue) lines.push(`AC: +${acValue}`);

  if (item.type === "weapon") {
    const dmgParts = item.system?.damage?.base ?? item.system?.damage?.parts?.[0];
    const formula = dmgParts?.formula ?? dmgParts?.[0] ?? null;
    if (formula) lines.push(`Damage: ${formula}`);
  }

  const resistances = Array.from(item.effects ?? []).flatMap(e => (e.changes ?? [])
    .filter(c => c.key?.includes("traits.dr") || c.key?.includes("traits.di") || c.key?.includes("traits.dv"))
    .map(c => c.value));
  if (resistances.length) lines.push(`Resistances: ${resistances.join(", ")}`);

  const price = item.system?.price?.value;
  if (price !== undefined) lines.push(`Value: ${price} ${item.system?.price?.denomination ?? "gp"}`);

  if (isPocketCarrier(item)) {
    const pocketed = getPocketedItems(actor, item);
    if (pocketed.length) lines.push(`Pocketed: ${pocketed.map(i => i.name).join(", ")}`);
  }

  return lines.join("<br>");
}

/** "Read Scroll of Fireball (2/3)" for a scroll/wand with limited uses, otherwise just the
 *  activity's own name — a plain charge-count DISPLAY only; nothing about 0-charge behavior
 *  (deletion/recharge/transformation) is implemented here, deliberately out of scope. */
export function buildPocketedItemLabel(item, activity) {
  const name = activity.name || item.name;
  const subtype = item.system?.type?.value;
  const uses = item.system?.uses;
  if ((subtype === "scroll" || subtype === "wand") && uses?.max) {
    return `${name} (${uses.value ?? 0}/${uses.max})`;
  }
  return name;
}

/** Non-interactive placeholder row shown in the pocket picker/viewer when nothing's pocketed
 *  yet (or, via `message`, showPocketFillPicker's own "nothing eligible" case) - the window
 *  still opens (see _onClick's isPocketCarrier branch) so a click gives visible feedback
 *  instead of silently doing nothing. */
// ─── Pocket-slot DOM rendering ─────────────────────────────────────────────
export function addPocketEmptyState(inner, message = "Nothing pocketed") {
  const empty = document.createElement("div");
  empty.classList.add("awc-doll-attack-option", "awc-doll-pocket-empty");
  empty.textContent = message;
  inner.appendChild(empty);
}

/**
 * Renders one small icon slot (matching _showPicker's own awc-doll-slot/awc-doll-picker-item
 * look, sized down via CSS) per configured Pocket Capacity slot - not just however many items
 * happen to be pocketed right now, so "3 slots" reads as 3 boxes (some possibly empty), the
 * same mental model as the doll's own hand/ring/armor slots. Filled slots always open their
 * item's sheet on double-click. Extra pocketed items beyond a lowered capacity still get a box,
 * so nothing already stored silently disappears from view.
 *
 * `onUse(item, activity)` (click picker/combined picker only) wires a plain click for whichever
 * filled slots carry a usable Activity - the out-of-combat viewer omits it (single-click
 * intentionally does nothing there).
 *
 * `onDropTarget(event, existingItemOrNull)` (drag-highlight.js's drag-revealed pocket window
 * only) turns every slot - filled or empty - into its own real drop target, colored the same
 * red/yellow drag-highlight.js uses everywhere else so its proximity tracking (which queries
 * any .awc-doll-slot carrying those classes) picks these up automatically even though they
 * only exist for the duration of a drag.
 *
 * `onEmptyClick(entryEl)` (click viewer/picker only, not the drag-revealed window) makes an
 * EMPTY slot clickable too, same as clicking an empty doll slot opens its own equip-picker -
 * see showPocketFillPicker().
 *
 * `highlightItemId` (auto-reveal only - consumePendingPocketHighlights()) gives the one filled
 * slot matching that item id a persistent green "landed here" pulse (the same class drag-time
 * proximity tracking uses), so equipping something that got auto-redirected into a pocket
 * instead of a hand makes it obvious exactly which slot it ended up in.
 */
export function renderPocketSlots(inner, carrier, pocketedItems, { onUse, onDropTarget, onEmptyClick, highlightItemId } = {}) {
  const capacity = Math.max(getPocketCapacity(carrier), pocketedItems.length);
  if (!capacity) { addPocketEmptyState(inner); return; }

  // Right-click un-pockets in place (below) without closing the popup, unlike every other
  // interaction here (click/onUse and onEmptyClick both close it first, and onDropTarget's
  // popup is torn down on dragend regardless) - without this, the vacated slot keeps showing a
  // stale "ghost" icon until the popup is closed and reopened.
  const refresh = () => {
    inner.innerHTML = "";
    renderPocketSlots(inner, carrier, getPocketedItems(carrier.actor, carrier), { onUse, onDropTarget, onEmptyClick });
  };

  for (let i = 0; i < capacity; i++) {
    const pocketedItem = pocketedItems[i] ?? null;
    const entry = document.createElement("div");
    entry.classList.add("awc-doll-slot", "awc-doll-picker-item");
    // The green pulse keyframe only actually fires when paired with occupied/empty (matching
    // the drag-time compound selectors, .awc-doll-drop-occupied.awc-doll-drop-target) - the
    // more specific 3-class rule then wins over the plain 2-class red "occupied" pulse alone.
    if (pocketedItem && pocketedItem.id === highlightItemId) entry.classList.add(DRAG_OCCUPIED_CLASS, DRAG_TARGET_CLASS);
    inner.appendChild(entry);

    if (onDropTarget) {
      entry.classList.add(pocketedItem ? DRAG_OCCUPIED_CLASS : DRAG_EMPTY_CLASS);
      entry.addEventListener("dragover", ev => ev.preventDefault());
      entry.addEventListener("drop", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        onDropTarget(ev, pocketedItem);
      });
    }

    if (!pocketedItem) {
      entry.classList.add("awc-doll-picker-item-empty");
      if (onEmptyClick) {
        entry.classList.add("awc-doll-picker-item-clickable");
        entry.addEventListener("click", ev => {
          ev.stopPropagation();
          onEmptyClick(entry);
        });
      }
      continue;
    }

    const activity = pocketedItem.system.activities?.contents?.[0];
    entry.style.backgroundImage = `url('${pocketedItem.img}')`;
    entry.dataset.tooltip = activity ? buildPocketedItemLabel(pocketedItem, activity) : pocketedItem.name;
    entry.addEventListener("dblclick", async ev => {
      ev.stopPropagation();
      await pocketedItem.sheet?.render(true);
      // The popup's own z-index (positionPickerAboveSlot) is a snapshot of "above every
      // .application at the moment THIS popup was created" - it has no idea about a sheet
      // opened AFTERWARD from one of its own entries, which can otherwise render underneath a
      // popup that's still open (the pocket viewer deliberately stays open across this).
      if (pocketedItem.sheet?.element) pocketedItem.sheet.element.style.zIndex = String(Number(inner.style.zIndex || 0) + 1);
    });

    // Right-click un-pockets, mirroring the carrier's own right-click-to-unequip - in combat
    // with Item Piles active it drops the item for real instead, same reasoning as the
    // carrier's own right-click and the auto-unpocket-on-unequip hook (paired-slots.js).
    entry.addEventListener("contextmenu", async ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const actor = pocketedItem.actor;
      if (actor && game.combat && game.modules.get("item-piles")?.active) {
        if (await dropItemViaItemPiles(actor, pocketedItem)) { refresh(); return; }
      }
      await unpocketItem(pocketedItem);
      refresh();
    });

    if (onUse && activity) {
      entry.addEventListener("click", async ev => {
        ev.stopPropagation();
        await onUse(pocketedItem, activity);
      });
    }
  }
}

/**
 * Clicking an empty pocket slot (renderPocketSlots' onEmptyClick) opens this - the pocket-
 * window equivalent of _showPicker's own equip-candidate icon grid, listing
 * eligiblePocketableItems(actor, carrier) instead of eligibleItemsForSlot(). Picking one
 * pockets it (pocketItem()). Pocketing doesn't reliably flip system.equipped, so it won't
 * always trigger AWC's own equip-change refresh hook - `onFilled` lets the caller force one
 * directly instead of relying on it.
 */
export function showPocketFillPicker(slotEl, actor, carrier, onFilled) {
  const items = eligiblePocketableItems(actor, carrier);

  const inner = document.createElement("div");
  inner.classList.add("awc-doll-picker");
  document.body.appendChild(inner);
  positionPickerAboveSlot(inner, slotEl);
  const close = wirePickerDismiss(inner);

  if (!items.length) { addPocketEmptyState(inner, "No eligible items"); return; }

  for (const item of items) {
    const entry = document.createElement("div");
    entry.classList.add("awc-doll-slot", "awc-doll-picker-item");
    entry.style.backgroundImage = `url('${item.img}')`;
    entry.dataset.tooltip = item.name;
    inner.appendChild(entry);
    entry.addEventListener("click", async ev => {
      ev.stopPropagation();
      close();
      await pocketItem(item, carrier);
      onFilled?.();
    });
  }
}

/**
 * Rolls an attack, restoring midi-qol automation (auto damage roll, auto-apply) that a plain
 * activity.rollAttack() call skips - midi only automates once a Workflow exists, and that's
 * created by activity.use(), not rollAttack() itself.
 *
 * If "Auto Roll Attack" is on, the Workflow rolls itself the instant it's created; if off,
 * nothing rolls until told to. Rather than read that setting directly, this polls the
 * Workflow's own `attackRoll` for a moment and only rolls manually if nothing showed up -
 * correct either way, and a clean fallback when midi isn't installed at all.
 *
 * attackMode is also pre-written to the item's "last used" flag, so an auto-triggered roll
 * (which doesn't take an explicit attackMode) still picks up what was chosen here. Fast-forward
 * is forced on this specific workflow so the popup stays dialog-free regardless of the world's
 * own fast-forward setting.
 */
// ─── Attack-mode automation ─────────────────────────────────────────────────
export async function rollAttackWithAutomation(activity, attackMode) {
  if (attackMode !== undefined) {
    await activity.item.setFlag("dnd5e", `last.${activity.id}`, { attackMode });
  }

  const usage = { midiOptions: { workflowOptions: { autoFastAttack: true, fastForwardDamage: true } } };
  await activity.use(usage, { configure: false }, {});

  const workflow = usage.workflow;
  if (!workflow) {
    await activity.rollAttack({ attackMode }, { configure: false }, {});
    return;
  }

  for (let i = 0; i < 10 && !workflow.attackRoll; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!workflow.attackRoll) {
    await activity.rollAttack({ attackMode, workflow }, { configure: false }, {});
  }
}

/** Hides "offhand" when clicked from the physical Main hand; hides "oneHanded"/"twoHanded"
 *  when clicked from Secondary (only "offhand" and any hand-independent mode remain there).
 *  For a versatile weapon in Main, "oneHanded" and "twoHanded" are mutually exclusive rather
 *  than both offered: two-handed is attempted automatically whenever the opposite hand is
 *  free, and it automatically falls back to one-handed the moment a second weapon or shield
 *  occupies that hand — the player never has to choose between them by hand-occupancy alone.
 *  A plain two-handed-only weapon is unaffected (dnd5e never lists "oneHanded" for one, and
 *  its own equip logic already forces both physical hands empty of anything else). */
export function filterAttackModesForSlot(modes, slot, actor) {
  if (slot?.kind !== "hand" || !slot.pos) return modes;
  const occupants = getPhysicalHandOccupants(actor);
  const oppositeOccupied = !!occupants[slot.pos === "main" ? "secondary" : "main"];
  const isVersatileWeapon = modes.some(m => m.value === "oneHanded") && modes.some(m => m.value === "twoHanded");

  return modes.filter(mode => {
    if (slot.pos === "main" && mode.value === "offhand") return false;
    if (slot.pos === "secondary" && (mode.value === "oneHanded" || mode.value === "twoHanded")) return false;
    if (mode.value === "twoHanded" && oppositeOccupied) return false;
    if (isVersatileWeapon && slot.pos === "main" && mode.value === "oneHanded" && !oppositeOccupied) return false;
    return true;
  });
}

/** Anchors a floating popup just above slotEl, in viewport coordinates — appended to
 *  document.body (not a doll-local container) so a transformed ancestor (.stats'
 *  translateZ(3px) on the embedded sheet) can't hijack position:fixed's containing block. */
/** Highest z-index among currently-rendered Foundry windows, plus a margin - a fixed
 *  guess (e.g. 100) loses to any actor sheet, since Foundry bumps a focused window's
 *  z-index well past that as windows are opened/focused during a session. */
// ─── Popup positioning / dismiss helpers ───────────────────────────────────
function _aboveAllWindows() {
  let max = 0;
  document.querySelectorAll(".application").forEach(el => {
    const z = parseInt(el.style.zIndex || getComputedStyle(el).zIndex, 10);
    if (!Number.isNaN(z)) max = Math.max(max, z);
  });
  return max + 10;
}

/** True if `slotEl` belongs to the character-sheet-embedded doll while it's in Half sidebar
 *  mode specifically (vs. Full) - used to give Full mode's own popups a couple pixels more
 *  than Half's, on top of the size they otherwise share (see .awc-doll-picker-full in CSS). */
export function isHalfModeEmbedded(slotEl) {
  return !!slotEl.closest(".awc-sidebar-half");
}

export function positionPickerAboveSlot(el, slotEl) {
  const rect = slotEl.getBoundingClientRect();
  // Half the usual gap for the character-sheet-embedded doll (Full and Half modes alike) -
  // matches its own tighter, smaller-scale look; the pop-out window's popups keep the wider gap.
  const gap = slotEl.closest(".awc-doll-embedded") ? 3 : 6;
  el.style.position = "fixed";
  el.style.left = `${rect.left + rect.width / 2}px`;
  el.style.top = `${rect.top - gap}px`;
  el.style.transform = "translate(-50%, -100%)";
  el.style.zIndex = String(_aboveAllWindows());
}

/**
 * Wires a picker popup's dismissal: a click OR right-click anywhere outside it removes it
 * and cleans up both listeners. A right-click on the doll itself (e.g. unequipping the very
 * item the popup is for) fires "contextmenu", not "click" - without listening for both, that
 * kind of dismiss-by-side-effect never reached a "click"-only listener, leaving the popup
 * orphaned on screen. Returns a close() function callers should invoke themselves after
 * successfully picking an option, so the listeners don't linger.
 */
export function wirePickerDismiss(inner) {
  const dismiss = ev => {
    if (!inner.contains(ev.target)) close();
  };
  const close = () => {
    inner.remove();
    document.removeEventListener("click", dismiss, true);
    document.removeEventListener("contextmenu", dismiss, true);
  };
  setTimeout(() => {
    document.addEventListener("click", dismiss, true);
    document.addEventListener("contextmenu", dismiss, true);
  }, 0);
  return close;
}

// ═══ AWCPaperDoll: the pop-out doll application ═══════════════════════════
// Methods below are mostly thin wrappers delegating to the free functions above (so
// doll-embed.js's sheet-embedded doll can reuse the exact same logic) - grouped here by what a
// reader touching this class would actually be doing: render, slot lookups, click/interaction,
// drag & drop, hover tooltip, sheet embedding.
export class AWCPaperDoll extends AWCApplication {
  constructor(actor) {
    super();
    this.#actor = actor;
    this._wrapSheet();

    document.documentElement.style.setProperty("--awc-doll-main-color", game.settings.get(MODULE_ID, "dollMainColor"));
    document.documentElement.style.setProperty("--awc-doll-brightness", `${game.settings.get(MODULE_ID, "dollBrightness")}%`);

    const rerenderIfMine = (doc) => { if ((doc.actor ?? doc)?.id === this.actor.id) this.render(); };
    this._hooks = [
      Hooks.on("updateActor", rerenderIfMine),
      Hooks.on("updateItem", rerenderIfMine),
      Hooks.on("createItem", rerenderIfMine),
      Hooks.on("deleteItem", rerenderIfMine),
    ];
  }

  #actor;
  get actor() { return this.#actor; }
  get title() { return this.actor.name; }
  get id() { return `awc-paper-doll-${this.actor.uuid}`; }

  static DEFAULT_OPTIONS = {
    tag: "div",
    classes: ["awc-paper-doll"],
    window: {
      resizable: false,
      icon: "fa-solid fa-person",
    },
    position: {
      width: PAPER_DOLL_WIDTH,
      height: 600,
    },
    actions: {
      configure: AWCPaperDoll.#onConfigure,
      close: AWCPaperDoll.#onCloseAction,
    },
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/paper-doll.hbs`,
    },
  };

  // ─── Data ─────────────────────────────────────────────────────────────────

  async _prepareContext(_options) {
    const actor = this.actor;
    const slotMap = getSlotMap(actor);
    const handState = getHandSlotState(actor);
    const ringState = getRingSlotState(actor);
    const exemptItem = getExemptItem(actor);
    const layout = this._dollLayout();

    return {
      actor,
      portraitImage: actor.getFlag(FLAG_NS, "dollImg") || actor.img,
      objectFit: actor.getFlag(FLAG_NS, "dollObjectFit") || "cover",
      left: LEFT_COLUMN.map(key => this._buildColumnEntry(key, slotMap)),
      right: RIGHT_COLUMN.map(key => this._buildColumnEntry(key, slotMap)),
      centerTop: CENTER_TOP_ROW.map(key => this._buildColumnEntry(key, slotMap)),
      showExempt: actorHasExemptCapableItem(actor),
      exempt: buildExemptEntry(layout, exemptItem),
      centerBottom: [
        this._buildRingEntry("main", ringState.main),
        this._buildSlotEntry("necklace", slotMap.necklace),
        this._buildRingEntry("secondary", ringState.secondary),
      ],
      melee: buildHandGroup(layout, "melee", handState),
      ranged: buildHandGroup(layout, "ranged", handState),
      showQuiver: actorHasEquippedRangedWeapon(actor),
      quiver: buildQuiverEntry(layout, getQuiverItem(actor)),
    };
  }

  /** GM-configurable empty-slot images, keyed by slot key / "hand" / "ring" / "exempt". Set via right-click on an empty slot, or the standalone Configure Doll window. */
  _dollLayout() {
    return getDollLayout();
  }

  _buildSlotEntry(key, item) {
    return buildSlotEntry(this._dollLayout(), key, item);
  }

  /** Resolves a LEFT_COLUMN/RIGHT_COLUMN entry, routing GROUPED_SLOTS keys (e.g. "headBase") through the merged-box builder. */
  _buildColumnEntry(key, slotMap) {
    if (GROUPED_SLOTS[key]) return buildGroupedSlotEntry(this._dollLayout(), key, slotMap);
    return this._buildSlotEntry(key, slotMap[key]);
  }

  _buildRingEntry(pos, item) {
    return buildRingEntry(this._dollLayout(), pos, item);
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  _onRender(context, options) {
    super._onRender(context, options);
    const html = this.element;

    this._attachToSheet();

    html.querySelectorAll(".awc-doll-portrait").forEach(img => { img.style.objectFit = context.objectFit; });

    html.querySelectorAll(".awc-doll-slot").forEach(slot => {
      slot.addEventListener("dragstart", this._onDragStart.bind(this));
      slot.addEventListener("dragover", ev => ev.preventDefault());
      slot.addEventListener("drop", this._onDrop.bind(this));
      slot.addEventListener("click", this._onClick.bind(this));
      slot.addEventListener("dblclick", this._onDoubleClick.bind(this));
      slot.addEventListener("contextmenu", this._onContextMenu.bind(this));
      slot.addEventListener("pointerenter", this._onHoverIn.bind(this));
      slot.addEventListener("pointerleave", this._onHoverOut.bind(this));
    });

    // Catch-all for a drop that lands anywhere else in the doll (the portrait background, a
    // gap between boxes) - every per-slot drop handler above already calls
    // event.stopPropagation(), so this never fires for a drop that landed precisely on a slot.
    const content = html.querySelector(".awc-doll-content");
    if (content) {
      content.addEventListener("dragover", ev => ev.preventDefault());
      content.addEventListener("drop", this._onDropAnywhere.bind(this));
    }

    consumePendingPocketReveals(this.actor, html.querySelectorAll(".awc-doll-slot"), (slotEl, carrier, pocketed) => this._showPocketViewer(slotEl, carrier, pocketed));
    consumePendingPocketHighlights(this.actor, html.querySelectorAll(".awc-doll-slot"), (slotEl, carrier, pocketed, highlightItemId) => this._showPocketViewer(slotEl, carrier, pocketed, highlightItemId));
    consumePendingPocketCloses();
  }

  // ─── Slot addressing helpers ──────────────────────────────────────────────
  // Thin delegates to the free functions above (shared with doll-embed.js) —
  // kept as instance methods so the rest of this class's code (and any
  // outside caller still expecting these names) is unaffected by the
  // extraction.

  _slotFromElement(el) {
    return slotFromElement(el);
  }

  _itemForSlot(slot) {
    return itemForSlot(this.actor, slot);
  }

  _eligibleItemsForSlot(slot) {
    return eligibleItemsForSlot(this.actor, slot);
  }

  // ─── Interaction: click ───────────────────────────────────────────────────

  async _onClick(event) {
    event.stopPropagation();
    const slotEl = event.currentTarget;
    const slot = this._slotFromElement(slotEl);
    const item = this._itemForSlot(slot);

    if (item) {
      const isCarrier = isPocketCarrier(item);
      const pocketed = isCarrier ? getPocketedItems(this.actor, item) : [];

      // Mid-combat, an equipped item that can attack gets a quick attack-mode popup instead of
      // the full sheet - opening the sheet to dig for the Attack button is too slow at the
      // table. A pocket carrier's own pocketed items' action options are folded into the same
      // popup, alongside its own attack (if it has one) - see _showPocketPicker().
      if (game.combat) {
        const activity = item.system.activities?.getByType?.("attack")?.[0];
        if (activity || isCarrier) { this._showPocketPicker(slotEl, item, activity, pocketed); return; }
        item.sheet?.render(true);
        return;
      }

      // Out of combat, a pocket carrier always opens its pocket window on click, even if
      // nothing's pocketed yet (shows an empty-state message instead of silently doing
      // nothing) - double-click an entry to open its sheet (see _showPocketViewer()). Anything
      // else does nothing on a plain single-click - double-click opens the sheet instead
      // (_onDoubleClick).
      if (isCarrier) this._showPocketViewer(slotEl, item, pocketed);
      return;
    }

    const eligible = this._eligibleItemsForSlot(slot);
    this._showPicker(slotEl, slot, eligible);
  }

  /** Opens an item's sheet regardless of combat state - the universal way to get to an
   *  equipped item's sheet now that a plain single-click no longer does that out of combat
   *  (see _onClick). Works identically for a carrier's own slot and, via the pocket viewer's
   *  own dblclick wiring, for a revealed pocketed item too. */
  _onDoubleClick(event) {
    event.stopPropagation();
    const slot = this._slotFromElement(event.currentTarget);
    const item = this._itemForSlot(slot);
    item?.sheet?.render(true);
  }

  /** Appends `item`'s own attack-mode options (item.system.attackModes - One-Handed/Two-
   *  Handed/Thrown/etc., whatever applies to this specific weapon, filtered by hand position -
   *  see filterAttackModesForSlot()) as text rows into an already-open popup, rolling the
   *  attack against the current target(s) on click. Shared by _showPocketPicker below for both
   *  a plain weapon's attack (no pockets involved) and a carrier's own attack alongside its
   *  pocketed items' options. */
  _appendAttackModeOptions(inner, slotEl, item, activity, close) {
    const slot = this._slotFromElement(slotEl);
    const rawModes = (item.system.attackModes ?? []).filter(m => !m.rule);
    const modes = filterAttackModesForSlot(rawModes, slot, this.actor);
    // Weapons expose distinct modes (versatile/thrown/offhand/etc.); anything
    // else with an Attack activity (a wand, a magic item) just gets one
    // generic option - rollAttack() below works identically either way.
    const options = modes.length ? modes : [{ value: undefined, label: "DND5E.ATTACK.Title.one" }];

    for (const mode of options) {
      const entry = document.createElement("div");
      entry.classList.add("awc-doll-attack-option");
      // A single remaining option isn't really a choice between attack modes - show the
      // activity's own name (e.g. "Slash") instead of a mechanical label like "One-Handed".
      entry.textContent = options.length === 1 ? (activity.name || game.i18n.localize(mode.label)) : game.i18n.localize(mode.label);
      inner.appendChild(entry);
      entry.addEventListener("click", async ev => {
        ev.stopPropagation();
        close();
        await rollAttackWithAutomation(activity, mode.value);
      });
    }
  }

  /** Positioned above the clicked slot, same as _showPocketPicker - previously injected into
   *  the doll's fixed .awc-doll-center container, which also holds the centerTop row
   *  (backpack/belt/purse) and the gear/close controls as siblings - wiping that container's
   *  innerHTML on open, and again on dismiss without picking anything, left it permanently
   *  blank until an unrelated render happened to rebuild it. */
  _showPicker(slotEl, slot, items) {
    if (!items.length) return;

    const inner = document.createElement("div");
    inner.classList.add("awc-doll-picker");
    document.body.appendChild(inner);
    positionPickerAboveSlot(inner, slotEl);
    const close = wirePickerDismiss(inner);

    for (const item of items) {
      const entry = document.createElement("div");
      entry.classList.add("awc-doll-slot", "awc-doll-picker-item");
      entry.style.backgroundImage = `url('${item.img}')`;
      entry.dataset.tooltip = item.name;
      inner.appendChild(entry);
      entry.addEventListener("click", async ev => {
        ev.stopPropagation();
        await this._equip(item, slot);
        close();
      });
    }
  }

  async _equip(item, slot) {
    await equipItemToSlot(item, slot);
  }

  /** In-combat popup for an item with an attack activity, pocketed contents, or both - `item`'s
   *  own attack-mode options (text rows, _appendAttackModeOptions) come first when it has an
   *  activity, followed by a pocket icon-grid (renderPocketSlots) for whatever's pocketed (if
   *  any); either section is skipped when it has nothing to show. A filled pocket slot with a
   *  usable Activity is clickable the same way: attack activities reuse
   *  rollAttackWithAutomation(), every other type's plain .use() already performs the whole
   *  action, same as dnd5e's own "Use" button (its midi-qol automation hooks aren't scoped to
   *  Attack, so no extra workaround is needed for those). Tagged with the carrier's id so an
   *  unequip that auto-empties its pockets can find and close this popup again
   *  (consumePendingPocketCloses). */
  _showPocketPicker(slotEl, item, activity, pocketedItems, highlightItemId) {
    const inner = document.createElement("div");
    inner.classList.add("awc-doll-picker", "awc-doll-attack-picker");
    inner.dataset.carrierId = item.id;
    document.body.appendChild(inner);
    positionPickerAboveSlot(inner, slotEl);
    const close = wirePickerDismiss(inner);

    if (activity) this._appendAttackModeOptions(inner, slotEl, item, activity, close);

    if (getPocketCapacity(item)) {
      const pocketRow = document.createElement("div");
      pocketRow.classList.add("awc-doll-pocket-row");
      inner.appendChild(pocketRow);
      renderPocketSlots(pocketRow, item, pocketedItems, {
        onUse: async (pocketedItem, pocketActivity) => {
          close();
          if (pocketActivity.type === "attack") await rollAttackWithAutomation(pocketActivity, undefined);
          else await pocketActivity.use();
        },
        onEmptyClick: () => {
          close();
          showPocketFillPicker(slotEl, this.actor, item, () => this.render());
        },
        highlightItemId,
      });
    }
  }

  /** Out-of-combat counterpart to _showPocketPicker - no onUse callback, so a single click on
   *  a filled slot does nothing (matching the same "single-click does nothing out of combat"
   *  rule _onClick now applies to every other slot); double-click still opens that pocketed
   *  item's own sheet regardless. Dismisses only on an outside click (wirePickerDismiss), so
   *  it stays open across a double-click on one of its own entries. */
  _showPocketViewer(slotEl, carrier, pocketedItems, highlightItemId) {
    const inner = document.createElement("div");
    inner.classList.add("awc-doll-picker");
    inner.dataset.carrierId = carrier.id;
    document.body.appendChild(inner);
    positionPickerAboveSlot(inner, slotEl);
    const close = wirePickerDismiss(inner);

    renderPocketSlots(inner, carrier, pocketedItems, {
      onEmptyClick: () => {
        close();
        showPocketFillPicker(slotEl, this.actor, carrier, () => this.render());
      },
      highlightItemId,
    });
  }

  // ─── Interaction: right-click (unequip, or set a custom empty-slot image) ──

  async _onContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    const slot = this._slotFromElement(event.currentTarget);
    const item = this._itemForSlot(slot);
    if (!item) {
      // An empty slot's custom background image is set only from Configure Paper Doll now,
      // not from the live doll - right-clicking an empty slot here does nothing.
      return;
    }

    // Mid-combat, right-clicking a real drop (Item Piles active, a token to drop under)
    // removes the item entirely instead of just unequipping it - a plain unequip is the
    // fallback whenever either condition isn't met, in or out of combat. A pocket carrier's
    // own pocketed contents come along in the same pile (dropCarrierAndPocketsViaItemPiles),
    // rather than being orphaned or silently returned to loose inventory.
    if (game.combat && game.modules.get("item-piles")?.active) {
      if (await dropCarrierAndPocketsViaItemPiles(this.actor, item)) return;
    }
    await item.update({ "system.equipped": false });
  }

  // ─── Interaction: drag/drop ───────────────────────────────────────────────

  _onDragStart(event) {
    event.stopPropagation();
    const slot = this._slotFromElement(event.currentTarget);
    const item = this._itemForSlot(slot);
    if (!item) { event.preventDefault(); return; }
    event.dataTransfer.setData("text/plain", JSON.stringify({ type: "AWCDollItem", uuid: item.uuid, ...slot }));
    applyDropHighlights(item);
  }

  async _onDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (!data?.uuid) return;

    let targetSlot = this._slotFromElement(event.currentTarget);
    let item = await fromUuid(data.uuid);
    if (!item) return;

    // Same-pair drag (hand ↔ hand within the SAME side, ring ↔ ring) swaps
    // two items the actor already owns and has equipped — never a foreign
    // item, so the ownership check below doesn't apply. A cross-side hand
    // drag (melee → ranged) falls through to a normal equip instead, since
    // render position comes from the item's own rules, not the drop target.
    if (data.type === "AWCDollItem" && data.kind === "hand" && targetSlot.kind === "hand" && data.side === targetSlot.side) {
      await swapHandSlot(this.actor, item, targetSlot.pos);
      return;
    }
    if (data.type === "AWCDollItem" && data.kind === "ring" && targetSlot.kind === "ring") {
      await swapRingSlot(this.actor, item, targetSlot.pos);
      return;
    }

    // Equipping a foreign item (dragged from the sidebar/compendium/another
    // actor): only allowed if dollAllowNonOwned is set, in which case a copy
    // is created on this actor first — mirrors Foundry's normal drag-a-new-
    // item-onto-a-sheet behavior rather than mutating someone else's item.
    if (item.parent?.id !== this.actor.id) {
      if (!game.settings.get(MODULE_ID, "dollAllowNonOwned")) return;
      const [created] = await this.actor.createEmbeddedDocuments("Item", [item.toObject()]);
      item = created;
    }

    const dropCarrier = this._itemForSlot(targetSlot);
    if (dropCarrier && dropCarrier.id !== item.id && isPocketEligible(item, dropCarrier)) {
      await handlePocketDrop(this.actor, item, dropCarrier);
      return;
    }

    targetSlot = redirectVersatileDrop(this.actor, item, targetSlot);

    const eligible = this._eligibleItemsForSlot(targetSlot).some(i => i.id === item.id) || this._itemForSlot(targetSlot)?.id === item.id;
    if (!eligible && targetSlot.kind === "slot" && getItemSlot(item) !== targetSlot.key) return;
    await this._equip(item, targetSlot);
  }

  /**
   * Catch-all for a drop that missed every specific slot - resolves the same generic target a
   * precise drop would eventually land on (see resolveGenericEquipTarget()) and equips there
   * directly. Deliberately skips everything _onDrop() needs a REAL target slot for: same-pair
   * swap detection, pocket-drop detection, and the versatile-weapon redirect all require
   * knowing exactly which box was targeted, which this path doesn't have.
   */
  async _onDropAnywhere(event) {
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (!data?.uuid) return;

    let item = await fromUuid(data.uuid);
    if (!item) return;

    if (item.parent?.id !== this.actor.id) {
      if (!game.settings.get(MODULE_ID, "dollAllowNonOwned")) return;
      const [created] = await this.actor.createEmbeddedDocuments("Item", [item.toObject()]);
      item = created;
    }

    const target = resolveGenericEquipTarget(item);
    if (target) await this._equip(item, target);
  }

  // ─── Interaction: hover tooltip ────────────────────────────────────────────

  /**
   * Item-hover tooltip: a small panel of our own, centered in the doll's
   * content area (.awc-doll-hover-tooltip in paper-doll.css) — not
   * Foundry's game.tooltip singleton, which positions relative to the
   * hovered element with no way to pin to a fixed spot in a window.
   */
  _onHoverIn(event) {
    const slot = this._slotFromElement(event.currentTarget);
    const item = this._itemForSlot(slot);
    let content = null;
    if (item) {
      content = this._buildTooltipHTML(item);
    } else if (slot.kind === "hand") {
      // A faded hand box has no item of its own, but names what's blocking it.
      const box = getHandSlotState(this.actor)[slot.box];
      if (box?.blocker) content = `<strong>${box.blocker.name}</strong><br>${describeHandBlocker(box.blocker)}`;
    }
    this._setHoverTooltip(content);
  }

  _onHoverOut() {
    this._setHoverTooltip(null);
  }

  _setHoverTooltip(html) {
    const panel = this.element.querySelector(".awc-doll-hover-tooltip");
    if (!panel) return;
    if (!html) { panel.classList.remove("active"); return; }
    panel.innerHTML = html;
    panel.classList.add("active");
  }

  _buildTooltipHTML(item) {
    return buildTooltipHTML(this.actor, item);
  }

  // ─── Header controls ──────────────────────────────────────────────────────

  static #onConfigure() {
    (async () => {
      const { AWCActorDollConfig } = await import("./actor-doll-config.js");
      new AWCActorDollConfig(this.actor).render(true);
    })();
  }

  static #onCloseAction() {
    this.close();
  }

  // ─── Sheet docking ────────────────────────────────────────────────────────

  _wrapSheet() {
    const sheet = this.actor.sheet;
    if (!sheet) return;
    this._originalSetPosition = sheet.setPosition;
    sheet.setPosition = (...args) => {
      const res = this._originalSetPosition.call(sheet, ...args);
      this._attachToSheet();
      return res;
    };
    this._originalClose = sheet.close;
    sheet.close = async (...args) => {
      this._unwrapSheet();
      await this.close();
      return this._originalClose.call(sheet, ...args);
    };
  }

  _unwrapSheet() {
    const sheet = this.actor.sheet;
    for (const hookId of this._hooks ?? []) Hooks.off("updateActor", hookId);
    if (!sheet || !this._originalSetPosition) return;
    sheet.setPosition = this._originalSetPosition;
    sheet.close = this._originalClose;
  }

  _attachToSheet() {
    if (!this.element) return;
    const sheet = this.actor.sheet;
    if (!sheet?.rendered) return;

    const { top, left, width } = sheet.position;
    const dollPosition = game.settings.get(MODULE_ID, "dollPosition");

    if (dollPosition === "center") return;
    if (dollPosition === "left" && left < PAPER_DOLL_WIDTH) return;
    if (dollPosition === "right" && left > window.innerWidth - PAPER_DOLL_WIDTH) return;

    this.setPosition({
      top,
      left: dollPosition === "left" ? left - PAPER_DOLL_WIDTH : left + width,
      width: PAPER_DOLL_WIDTH,
    });
  }

  async close(...args) {
    this._unwrapSheet();
    return super.close(...args);
  }
}
