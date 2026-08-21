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
import { getACBreakdown, buildACFormulaHTML } from "./ac.js";
import {
  getDollLayout, buildSlotEntry, buildGroupedSlotEntry, buildRingEntry, buildExemptEntry, buildHandGroup,
  GROUPED_SLOTS, LEFT_COLUMN, RIGHT_COLUMN, CENTER_TOP_ROW,
  slotFromElement, itemForSlot, eligibleItemsForSlot, equipItemToSlot, buildTooltipHTML, pickSlotImage,
} from "./apps/paper-doll-app.js";

const LOG = `${MODULE_ID} |`;
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/paper-doll.hbs`;

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Last successfully-rendered doll HTML per actor, keyed by actor.id, so a
 * render triggered by something the doll doesn't actually care about (HP,
 * exhaustion, spell slots — anything that isn't equipment/ability-score/
 * portrait-flag related) can skip the async rebuild entirely. See the
 * fingerprint comment below for why this is safe, and the flash this fixes.
 */
const _lastEmbed = new Map();

/**
 * Replaces the native portrait `<img>`/`<video>` inside `el`'s
 * `.sidebar .card .portrait` with the rendered doll, and wires all its
 * interactions. Called from hooks.js on every character-sheet render and
 * every equip/unequip refresh (see _refreshActorSheet in hooks.js).
 *
 * dnd5e's OWN native re-render runs first on every actor update (it owns
 * .portrait, not us) and briefly puts its own plain portrait `<img>` back
 * in .portrait's place before this function gets a chance to re-embed the
 * doll — visible as the doll "disappearing and reappearing" on things like
 * an exhaustion-pip click. buildDollContext/getCapacityData/getACBreakdown
 * only ever read equipped items, ability scores, active-effect bonuses,
 * and the doll's own portrait-image flags — none of which an exhaustion
 * (or HP, or spell-slot) update touches, so the doll's own HTML is
 * GUARANTEED identical to last time in that case. Skipping the rebuild and
 * reapplying the cached HTML synchronously (no awaited renderTemplate call
 * in between) means this whole function resolves inside the same
 * synchronous stretch as the native re-render that triggered it, before
 * the browser gets a chance to paint the intermediate native-portrait
 * frame at all — that's what actually removes the visible flash, not just
 * making the rebuild itself faster.
 */
export async function embedPaperDoll(app, el, actor) {
  if (game.settings.get(MODULE_ID, "dollPlayerOwnedOnly") && !actor.hasPlayerOwner) return;

  const portrait = el.querySelector(".sidebar .card .portrait");
  if (!portrait) return;

  const dollContext = buildDollContext(actor);
  const cap = getCapacityData(actor);
  const ac = getACBreakdown(actor);

  // Fingerprinting is a pure optimization — if it ever throws on an
  // unexpected data shape, falling through to a full rebuild (fingerprint
  // stays null, so the cache lookup below naturally misses) is the safe
  // failure mode, not letting the whole embed abort over it.
  let fingerprint = null;
  try {
    fingerprint = _fingerprintFor(dollContext, cap, ac);
  } catch (err) {
    console.error(`${LOG} embedPaperDoll: fingerprint failed, skipping cache`, err);
  }

  const cached = fingerprint && _lastEmbed.get(actor.id);
  if (cached && cached.fingerprint === fingerprint) {
    _applyEmbed(app, portrait, actor, ac, cached.capacityBarHTML, cached.dollHTML);
    return;
  }

  let dollHTML;
  try {
    dollHTML = await renderDollTemplate(dollContext);
  } catch (err) {
    console.warn(`${LOG} embedPaperDoll: template render failed`, err);
    return;
  }

  // Isolated from the dollHTML render above: this builds fresh markup from
  // live actor data rather than a template, so a bug here is a different
  // failure mode (JS throw, not a rejected promise) — guarded the same way
  // regardless, since an unguarded throw anywhere in this function's body
  // aborts the whole embed (established earlier this session).
  let capacityBarHTML = "";
  try {
    capacityBarHTML = buildCapacityBarHTML(cap, ac);
  } catch (err) {
    console.error(`${LOG} embedPaperDoll: capacity bar build failed`, err);
  }

  _applyEmbed(app, portrait, actor, ac, capacityBarHTML, dollHTML);
  _lastEmbed.set(actor.id, { fingerprint, capacityBarHTML, dollHTML });
}

/**
 * The context object's own `actor` key is a full Document (circular,
 * unserializable) — dropped before stringifying. Every slot/ring/exempt/
 * hand-box entry also carries its own `item` field, which is a raw Item
 * Document too (buildSlotEntry etc., apps/paper-doll-app.js) — stringifying
 * one of THOSE directly risks either throwing on circular Document
 * references (item.parent, its actor's own item collection, etc.) or, best
 * case, dragging in the item's entire system/flags/effects data just to
 * detect a change. The replacer below intercepts every "item" key (however
 * deeply nested — melee/ranged wrap their entries in a `slots` array) and
 * substitutes only the fields the doll's own template actually renders per
 * item: icon image and name. cap/ac are folded in separately since they
 * come from a different pipeline (capacity.js/ac.js) than buildDollContext.
 */
function _fingerprintFor(dollContext, cap, ac) {
  const { actor: _actor, ...rest } = dollContext;
  const json = JSON.stringify(rest, (key, value) => {
    if (key === "item" && value && typeof value === "object") {
      return { id: value.id, img: value.img, name: value.name };
    }
    return value;
  });
  return JSON.stringify([json, cap.bracket, cap.ratio, ac?.total ?? null]);
}

/** DOM insertion + listener (re)wiring shared by both the cached-HTML fast path and the freshly-rendered path — new DOM nodes need fresh listeners either way. */
function _applyEmbed(app, portrait, actor, ac, capacityBarHTML, dollHTML) {
  portrait.innerHTML = capacityBarHTML + dollHTML;
  portrait.classList.add("awc-doll-embedded");

  const portraitImg = portrait.querySelector(".awc-doll-portrait");
  if (portraitImg) applyPortraitClickAction(app, portraitImg);

  wireDollSlotInteractions(portrait, actor);
  try {
    wireCapacityBarHoverTooltip(portrait, ac);
  } catch (err) {
    console.error(`${LOG} embedPaperDoll: capacity bar hover wiring failed`, err);
  }
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

function buildCapacityBarHTML(cap, ac) {
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

  // Unarmored is the one bracket without a shield tier (armor-weight-
  // class.css draws the other three/four as clip-path shapes on the
  // indicator's own ::before) — a real Font Awesome glyph reads better
  // for "no shield" than an empty box. ac may be null on the very first
  // prepareDerivedData pass before applyCustomAC has run once; the
  // indicator still renders (blank number) rather than the whole doll
  // embed failing.
  const iconHTML = cap.bracket === "unarmored"
    ? `<i class="fa-solid fa-hand-fist" aria-hidden="true"></i>`
    : "";

  return `
    <div class="awc-capacity-bar awc-${cap.bracket}" data-tooltip="${tooltip}">
      ${markers.map(m =>
    `<div class="awc-threshold awc-threshold-${m.key}"
              style="left:${m.pct.toFixed(1)}%"
              data-tooltip="${m.key.charAt(0).toUpperCase() + m.key.slice(1)} threshold (${Math.round(m.pct)}%)"></div>`
  ).join("")}
      <div class="awc-ac-indicator awc-${cap.bracket}" style="left:${indicatorPct.toFixed(1)}%">
        <span class="awc-ac-indicator-icon">${iconHTML}</span>
        <span class="awc-ac-indicator-value">${ac?.total ?? ""}</span>
      </div>
    </div>
  `;
}

/**
 * Hovering the AC indicator shows the same base/mod/items/misc=total
 * breakdown as the native AC badge's own tooltip (shared via ac.js's
 * buildACFormulaHTML), but centered on the doll via the existing
 * .awc-doll-hover-tooltip panel (paper-doll.hbs) instead of a floating
 * cursor tooltip — this indicator only ever exists inside the embedded
 * doll, so unlike sheet-inject.js's AC badge wiring there's no "doll not
 * present" fallback branch to handle here.
 */
function wireCapacityBarHoverTooltip(portrait, ac) {
  const indicator = portrait.querySelector(".awc-ac-indicator");
  if (!indicator || !ac) return;

  const html = buildACFormulaHTML(ac);
  indicator.addEventListener("pointerenter", () => {
    const panel = portrait.querySelector(".awc-doll-hover-tooltip");
    if (!panel) return;
    panel.innerHTML = html;
    panel.classList.add("active");
  });
  indicator.addEventListener("pointerleave", () => {
    portrait.querySelector(".awc-doll-hover-tooltip")?.classList.remove("active");
  });
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
