/**
 * doll-embed.js
 * Embeds the Paper Doll directly into the character sheet's own portrait
 * area (.sidebar .card .portrait), replacing the native portrait image.
 *
 * IMPORTANT: this file statically imports apps/paper-doll-app.js, whose
 * AWCPaperDoll class extends AWCApplication — a class-definition-time
 * reference to ApplicationV2/HandlebarsApplicationMixin, which don't exist
 * on pre-v13 clients. That makes evaluating THIS file itself unsafe to do
 * unconditionally. This file must only ever be reached via a dynamic
 * import() call already gated behind hooks.js's _hasApplicationV2() check —
 * never add a static `import` of this file from hooks.js or anywhere else
 * in module.json's unconditionally-loaded esmodules list.
 *
 * Unlike sheet-inject.js's mergeHeaderIntoTitleBar() (which only needs to
 * MOVE a native element once per genuine Foundry re-render), embedPaperDoll
 * always rebuilds .portrait's content from scratch on every call — there's
 * no "find fresh native content or bail" dependency here, since the doll's
 * markup is entirely data-driven from the actor's current equipment state,
 * which we always have fresh access to regardless of whether Foundry itself
 * re-rendered the sidebar part this cycle. This also means the doll stays
 * in sync on every equip/unequip (via hooks.js's _refreshActorSheet path),
 * not just on full sheet re-renders.
 */

import { MODULE_ID, FLAG_NS, DEFAULT_BRACKETS } from "./constants.js";
import { getItemSlot, getSlotMap } from "./slots.js";
import { getHandSlotState, getRingSlotState, getExemptItem, actorHasExemptCapableItem, swapHandSlot, swapRingSlot, describeHandBlocker } from "./paired-slots.js";
import { getCapacityData } from "./capacity.js";
import {
  getDollLayout, buildSlotEntry, buildGroupedSlotEntry, buildRingEntry, buildExemptEntry, buildHandGroup,
  GROUPED_SLOTS, LEFT_COLUMN, RIGHT_COLUMN, CENTER_TOP_ROW,
  slotFromElement, itemForSlot, eligibleItemsForSlot, equipItemToSlot, buildTooltipHTML, pickSlotImage,
} from "./apps/paper-doll-app.js";

const LOG = `${MODULE_ID} |`;
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/paper-doll.hbs`;

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Replaces the native portrait `<img>`/`<video>` inside `el`'s
 * `.sidebar .card .portrait` with the rendered doll, and wires all its
 * interactions. Called from hooks.js on every character-sheet render and
 * every equip/unequip refresh (see _refreshActorSheet in hooks.js).
 */
export async function embedPaperDoll(app, el, actor) {
  if (game.settings.get(MODULE_ID, "dollPlayerOwnedOnly") && !actor.hasPlayerOwner) return;

  const portrait = el.querySelector(".sidebar .card .portrait");
  if (!portrait) return;

  let dollHTML;
  try {
    dollHTML = await renderDollTemplate(buildDollContext(actor));
  } catch (err) {
    console.warn(`${LOG} embedPaperDoll: template render failed`, err);
    return;
  }

  portrait.innerHTML = buildCapacityBarHTML(actor) + dollHTML;
  portrait.classList.add("awc-doll-embedded");

  const portraitImg = portrait.querySelector(".awc-doll-portrait");
  if (portraitImg) applyPortraitClickAction(app, portraitImg);

  wireDollSlotInteractions(portrait, actor);
}

async function renderDollTemplate(context) {
  const renderFn = foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  return renderFn(TEMPLATE_PATH, context);
}

/**
 * Play mode mirrors dnd5e's own native portrait exactly (data-action=
 * "showArtwork", dispatched by Foundry's generic action-delegation system —
 * no manual click listener needed, same as every other data-action button
 * on the sheet). Edit mode mirrors the native file-picker edit action; the
 * exact attribute shape is inferred from dnd5e's character-sidebar.hbs
 * (data-edit="img" data-type="image") since the sheet doesn't expose that
 * partial's own `action` value directly to injected code — worth
 * confirming this opens the file picker correctly once live, adjusting if
 * dnd5e expects a different action name.
 */
function applyPortraitClickAction(app, portraitImg) {
  const editing = !!(app.isEditable && app.isEditMode);
  if (editing) {
    portraitImg.dataset.action = "editImage";
    portraitImg.dataset.edit = "img";
    portraitImg.dataset.type = "image";
  } else {
    portraitImg.dataset.action = "showArtwork";
  }
}

// ─── Context building ───────────────────────────────────────────────────────

function buildDollContext(actor) {
  const slotMap = getSlotMap(actor);
  const handState = getHandSlotState(actor);
  const ringState = getRingSlotState(actor);
  const exemptItem = getExemptItem(actor);
  const layout = getDollLayout();

  const buildColumnEntry = (key) => GROUPED_SLOTS[key]
    ? buildGroupedSlotEntry(layout, key, slotMap)
    : buildSlotEntry(layout, key, slotMap[key]);

  return {
    actor,
    portraitImage: actor.getFlag(FLAG_NS, "dollImg") || actor.img,
    objectFit: actor.getFlag(FLAG_NS, "dollObjectFit") || "cover",
    left: LEFT_COLUMN.map(buildColumnEntry),
    right: RIGHT_COLUMN.map(buildColumnEntry),
    centerTop: CENTER_TOP_ROW.map(buildColumnEntry),
    showExempt: actorHasExemptCapableItem(actor),
    exempt: buildExemptEntry(layout, exemptItem),
    centerBottom: [
      buildRingEntry(layout, "main", ringState.main),
      buildSlotEntry(layout, "necklace", slotMap.necklace),
      buildRingEntry(layout, "secondary", ringState.secondary),
    ],
    melee: buildHandGroup(layout, "melee", handState),
    ranged: buildHandGroup(layout, "ranged", handState),
  };
}

// ─── Capacity bar ───────────────────────────────────────────────────────────
// Same markup/logic as the bar sheet-inject.js's (parked) injectCapacityBar
// built for its Phase 1 placement — this is that logic's actual home now,
// rendered inline at the top of the embedded doll instead.

function buildCapacityBarHTML(actor) {
  const cap = getCapacityData(actor);

  let thresholds = DEFAULT_BRACKETS;
  try { thresholds = game.settings.get(MODULE_ID, "bracketThresholds") ?? DEFAULT_BRACKETS; }
  catch { /* settings not initialised yet */ }

  const markers = [
    { key: "light", pct: (thresholds.light?.min ?? 0.25) * 100 },
    { key: "medium", pct: (thresholds.medium?.min ?? 0.50) * 100 },
    { key: "heavy", pct: (thresholds.heavy?.min ?? 0.75) * 100 },
    { key: "over", pct: (thresholds.over?.min ?? 1.00) * 100 },
  ].filter(m => m.pct > 0 && m.pct <= 100);

  const indicatorPct = Math.min(103, Math.max(0, cap.ratio * 100));
  const tooltip = `${cap.equippedWeight} / ${cap.capacity} lbs · ${cap.bracket}`;

  return `
    <div class="awc-capacity-bar awc-${cap.bracket}" data-tooltip="${tooltip}">
      ${markers.map(m =>
    `<div class="awc-threshold awc-threshold-${m.key}"
              style="left:${m.pct.toFixed(1)}%"
              data-tooltip="${m.key.charAt(0).toUpperCase() + m.key.slice(1)} threshold (${Math.round(m.pct)}%)"></div>`
  ).join("")}
      <div class="awc-weight-indicator awc-${cap.bracket}"
           style="left:${indicatorPct.toFixed(1)}%"
           data-tooltip="${tooltip}"></div>
    </div>
  `;
}

// ─── Interaction wiring ─────────────────────────────────────────────────────

function wireDollSlotInteractions(rootEl, actor) {
  rootEl.querySelectorAll(".awc-doll-slot").forEach(slotEl => {
    slotEl.addEventListener("dragstart", (event) => onDragStart(event, actor));
    slotEl.addEventListener("dragover", (event) => event.preventDefault());
    slotEl.addEventListener("drop", (event) => onDrop(event, actor));
    slotEl.addEventListener("click", (event) => onClick(event, actor, rootEl));
    slotEl.addEventListener("contextmenu", (event) => onContextMenu(event, actor));
    slotEl.addEventListener("pointerenter", (event) => onHoverIn(event, actor, rootEl));
    slotEl.addEventListener("pointerleave", () => onHoverOut(rootEl));
  });
}

function onDragStart(event, actor) {
  event.stopPropagation();
  const slot = slotFromElement(event.currentTarget);
  const item = itemForSlot(actor, slot);
  if (!item) { event.preventDefault(); return; }
  event.dataTransfer.setData("text/plain", JSON.stringify({ type: "AWCDollItem", uuid: item.uuid, ...slot }));
}

async function onDrop(event, actor) {
  event.preventDefault();
  event.stopPropagation();
  let data;
  try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
  catch { return; }
  if (!data?.uuid) return;

  const targetSlot = slotFromElement(event.currentTarget);
  let item = await fromUuid(data.uuid);
  if (!item) return;

  if (data.type === "AWCDollItem" && data.kind === "hand" && targetSlot.kind === "hand" && data.side === targetSlot.side) {
    await swapHandSlot(actor, item, targetSlot.pos);
    return;
  }
  if (data.type === "AWCDollItem" && data.kind === "ring" && targetSlot.kind === "ring") {
    await swapRingSlot(actor, item, targetSlot.pos);
    return;
  }

  if (item.parent?.id !== actor.id) {
    if (!game.settings.get(MODULE_ID, "dollAllowNonOwned")) return;
    const [created] = await actor.createEmbeddedDocuments("Item", [item.toObject()]);
    item = created;
  }

  const eligible = eligibleItemsForSlot(actor, targetSlot).some(i => i.id === item.id) || itemForSlot(actor, targetSlot)?.id === item.id;
  if (!eligible && targetSlot.kind === "slot" && getItemSlot(item) !== targetSlot.key) return;
  await equipItemToSlot(item, targetSlot);
}

async function onClick(event, actor, rootEl) {
  event.stopPropagation();
  const slotEl = event.currentTarget;
  const slot = slotFromElement(slotEl);
  const item = itemForSlot(actor, slot);

  if (item) { item.sheet?.render(true); return; }

  const eligible = eligibleItemsForSlot(actor, slot);
  showPicker(rootEl, slot, eligible);
}

function showPicker(rootEl, slot, items) {
  const center = rootEl.querySelector(".awc-doll-center");
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
      await equipItemToSlot(item, slot);
      center.innerHTML = "";
    });
  }

  const dismiss = ev => {
    if (!center.contains(ev.target)) { center.innerHTML = ""; document.removeEventListener("click", dismiss, true); }
  };
  setTimeout(() => document.addEventListener("click", dismiss, true), 0);
}

async function onContextMenu(event, actor) {
  event.preventDefault();
  event.stopPropagation();
  const slot = slotFromElement(event.currentTarget);
  const item = itemForSlot(actor, slot);
  if (item) {
    await item.update({ "system.equipped": false });
    return;
  }
  if (!game.user.isGM) return;
  pickSlotImage(slot);
}

function onHoverIn(event, actor, rootEl) {
  const slot = slotFromElement(event.currentTarget);
  const item = itemForSlot(actor, slot);
  let content = null;
  if (item) {
    content = buildTooltipHTML(actor, item);
  } else if (slot.kind === "hand") {
    const box = getHandSlotState(actor)[slot.box];
    if (box?.blocker) content = `<strong>${box.blocker.name}</strong><br>${describeHandBlocker(box.blocker)}`;
  }
  setHoverTooltip(rootEl, content);
}

function onHoverOut(rootEl) {
  setHoverTooltip(rootEl, null);
}

function setHoverTooltip(rootEl, html) {
  const panel = rootEl.querySelector(".awc-doll-hover-tooltip");
  if (!panel) return;
  if (!html) { panel.classList.remove("active"); return; }
  panel.innerHTML = html;
  panel.classList.add("active");
}
