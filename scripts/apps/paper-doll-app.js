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

import { MODULE_ID, FLAG_NS, SLOT_TYPES, ITEM_MARKERS } from "../constants.js";
import { getSlotMap, getItemSlot, itemHasMarker } from "../slots.js";
import { getHandSlotState, getRingSlotState, getExemptItem, actorHasExemptCapableItem, swapHandSlot, swapRingSlot, describeHandBlocker } from "../paired-slots.js";
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

/** Resolves the item currently occupying `slot` for `actor` — re-derived fresh every call, never cached. */
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
  return null;
}

/** Every currently-unequipped item on `actor` eligible to be dropped/clicked into `slot`. */
export function eligibleItemsForSlot(actor, slot) {
  if (slot.kind === "slot") {
    const group = GROUPED_SLOTS[slot.key];
    if (group) return actor.items.filter(i => !i.system?.equipped && group.keys.includes(getItemSlot(i)));
    return actor.items.filter(i => !i.system?.equipped && getItemSlot(i) === slot.key);
  }
  if (slot.kind === "hand") {
    return actor.items.filter(i => !i.system?.equipped
      && (i.type === "weapon" || (i.type === "equipment" && getItemSlot(i) === "shield"))
      && !itemHasMarker(i, ITEM_MARKERS.IGNORES_HAND_SLOT));
  }
  if (slot.kind === "ring") {
    return actor.items.filter(i => !i.system?.equipped && getItemSlot(i) === "ring");
  }
  if (slot.kind === "exempt") {
    return actor.items.filter(i => !i.system?.equipped
      && (i.type === "weapon" || (i.type === "equipment" && getItemSlot(i) === "shield"))
      && itemHasMarker(i, ITEM_MARKERS.IGNORES_HAND_SLOT));
  }
  return [];
}

/** Equips `item` into `slot`, remembering the specific hand/ring position when the box addresses one. Conflict/capacity resolution runs from the resulting updateItem hook — never duplicated here. */
export async function equipItemToSlot(item, slot) {
  const update = { "system.equipped": true };
  if (slot.kind === "hand" && slot.pos) update[`flags.${FLAG_NS}.handSlot`] = slot.pos;
  if (slot.kind === "ring") update[`flags.${FLAG_NS}.ringSlot`] = slot.pos;
  await item.update(update);
}

/** Hover-tooltip HTML for an equipped item's doll slot: name, AC/damage, resistances, value. */
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

  return lines.join("<br>");
}

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
      slot.addEventListener("contextmenu", this._onContextMenu.bind(this));
      slot.addEventListener("pointerenter", this._onHoverIn.bind(this));
      slot.addEventListener("pointerleave", this._onHoverOut.bind(this));
    });
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

    if (item) { item.sheet?.render(true); return; }

    const eligible = this._eligibleItemsForSlot(slot);
    this._showPicker(slotEl, slot, eligible);
  }

  _showPicker(slotEl, slot, items) {
    const center = this.element.querySelector(".awc-doll-center");
    if (!center) return;
    center.innerHTML = "";
    if (!items.length) return;

    const inner = document.createElement("div");
    inner.classList.add("awc-doll-picker");
    center.appendChild(inner);

    for (const item of items) {
      const entry = document.createElement("div");
      entry.classList.add("awc-doll-slot", "awc-doll-picker-item");
      entry.style.backgroundImage = `url('${item.img}')`;
      entry.dataset.tooltip = item.name;
      inner.appendChild(entry);
      entry.addEventListener("click", async ev => {
        ev.stopPropagation();
        await this._equip(item, slot);
        center.innerHTML = "";
      });
    }

    const dismiss = ev => {
      if (!center.contains(ev.target)) { center.innerHTML = ""; document.removeEventListener("click", dismiss, true); }
    };
    setTimeout(() => document.addEventListener("click", dismiss, true), 0);
  }

  async _equip(item, slot) {
    await equipItemToSlot(item, slot);
  }

  // ─── Interaction: right-click (unequip, or set a custom empty-slot image) ──

  async _onContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    const slot = this._slotFromElement(event.currentTarget);
    const item = this._itemForSlot(slot);
    if (item) {
      await item.update({ "system.equipped": false });
      return;
    }
    // Empty slot: GM can assign a custom background image for it (matches
    // the original module's per-slot image picker), stored in the world-
    // level dollLayout setting so it's shared by every actor's doll.
    if (!game.user.isGM) return;
    pickSlotImage(slot);
  }

  // ─── Interaction: drag/drop ───────────────────────────────────────────────

  _onDragStart(event) {
    event.stopPropagation();
    const slot = this._slotFromElement(event.currentTarget);
    const item = this._itemForSlot(slot);
    if (!item) { event.preventDefault(); return; }
    event.dataTransfer.setData("text/plain", JSON.stringify({ type: "AWCDollItem", uuid: item.uuid, ...slot }));
  }

  async _onDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (!data?.uuid) return;

    const targetSlot = this._slotFromElement(event.currentTarget);
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

    const eligible = this._eligibleItemsForSlot(targetSlot).some(i => i.id === item.id) || this._itemForSlot(targetSlot)?.id === item.id;
    if (!eligible && targetSlot.kind === "slot" && getItemSlot(item) !== targetSlot.key) return;
    await this._equip(item, targetSlot);
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
