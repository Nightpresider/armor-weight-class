/**
 * doll-embed.js
 * Embeds the Paper Doll directly into the character sheet's own portrait
 * area (.sidebar .card .portrait), replacing the native portrait image.
 *
 * IMPORTANT: statically imports apps/paper-doll-app.js, whose AWCPaperDoll
 * class extends AWCApplication — a class-definition-time reference to
 * ApplicationV2/HandlebarsApplicationMixin, which don't exist on pre-v13
 * clients. This file must only ever be reached via a dynamic import()
 * already gated behind hooks.js's _hasApplicationV2() check — never add a
 * static `import` of this file anywhere unconditionally loaded.
 *
 * Unlike mergeHeaderIntoTitleBar() (sheet-inject.js, which only MOVEs a
 * native element per render), embedPaperDoll always rebuilds .portrait's
 * content from scratch every call — the doll's markup is entirely
 * data-driven from the actor's current equipment state, always freshly
 * available regardless of whether Foundry re-rendered the sidebar this
 * cycle. Keeps the doll in sync on every equip/unequip too (hooks.js's
 * _refreshActorSheet path), not just full sheet re-renders.
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
 * render triggered by something the doll doesn't care about (HP,
 * exhaustion, spell slots) can skip the async rebuild entirely — see the
 * fingerprint comment below.
 */
const _lastEmbed = new Map();

/**
 * Replaces the native portrait `<img>`/`<video>` with the rendered doll
 * and wires its interactions. Called on every character-sheet render and
 * every equip/unequip refresh (hooks.js's _refreshActorSheet).
 *
 * dnd5e's own native re-render runs first on every actor update (it owns
 * .portrait) and briefly puts its plain portrait `<img>` back before this
 * function re-embeds the doll — visible as the doll flashing on things
 * like an exhaustion-pip click. buildDollContext/getCapacityData/
 * getACBreakdown only read equipped items, ability scores, effect bonuses,
 * and the doll's own portrait flags — none of which an exhaustion/HP/
 * spell-slot update touches, so the doll's HTML is guaranteed identical in
 * that case. Skipping the rebuild and reapplying cached HTML synchronously
 * (no awaited renderTemplate in between) resolves this function inside the
 * same synchronous stretch as the native re-render that triggered it,
 * before the browser paints the intermediate native-portrait frame at all
 * — that's what removes the flash, not just speed.
 */
export async function embedPaperDoll(app, el, actor) {
  if (game.settings.get(MODULE_ID, "dollPlayerOwnedOnly") && !actor.hasPlayerOwner) return;

  const portrait = el.querySelector(".sidebar .card .portrait");
  if (!portrait) return;

  const dollContext = buildDollContext(actor);
  const cap = getCapacityData(actor);
  const ac = getACBreakdown(actor);

  // Pure optimization — if this throws on an unexpected data shape,
  // falling through to a full rebuild (fingerprint stays null, cache miss)
  // is the safe failure mode.
  let fingerprint = null;
  try {
    fingerprint = _fingerprintFor(dollContext, cap, ac);
  } catch (err) {
    console.error(`${LOG} embedPaperDoll: fingerprint failed, skipping cache`, err);
  }

  const cached = fingerprint && _lastEmbed.get(actor.id);
  if (cached && cached.fingerprint === fingerprint) {
    _applyEmbed(app, portrait, actor, ac, cached.calcBarHTML, cached.dollHTML);
    return;
  }

  let dollHTML;
  try {
    dollHTML = await renderDollTemplate(dollContext);
  } catch (err) {
    console.warn(`${LOG} embedPaperDoll: template render failed`, err);
    return;
  }

  // Builds fresh markup from live actor data rather than a template, so a
  // bug here throws (not a rejected promise) — guarded the same way
  // regardless, since an unguarded throw anywhere in this function aborts
  // the whole embed.
  let calcBarHTML = "";
  try {
    calcBarHTML = buildCalcBarHTML(cap, ac);
  } catch (err) {
    console.error(`${LOG} embedPaperDoll: calc bar build failed`, err);
  }

  _applyEmbed(app, portrait, actor, ac, calcBarHTML, dollHTML);
  _lastEmbed.set(actor.id, { fingerprint, calcBarHTML, dollHTML });
}

/**
 * The context's own `actor` key is a full Document (circular,
 * unserializable) — dropped before stringifying. Every slot/ring/exempt/
 * hand-box entry also carries a raw Item Document under `item`, which
 * risks throwing on circular references or dragging in the item's entire
 * system/flags/effects data just to detect a change. The replacer below
 * intercepts every "item" key (however nested) and substitutes only the
 * fields the doll's template actually renders: image and name. cap/ac are
 * folded in separately — a different pipeline than buildDollContext.
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
function _applyEmbed(app, portrait, actor, ac, calcBarHTML, dollHTML) {
  portrait.innerHTML = calcBarHTML + dollHTML;
  portrait.classList.add("awc-doll-embedded");

  const editing = !!(app.isEditable && app.isEditMode);
  const portraitImg = portrait.querySelector(".awc-doll-portrait");
  if (portraitImg) applyPortraitClickAction(portraitImg, editing);
  if (editing) addEditPortraitButton(portrait, app, actor);
  else wireJumpToToken(portrait, app, actor);

  wireDollSlotInteractions(portrait, actor);
  try {
    wireCalcBarHoverTooltip(portrait, ac);
  } catch (err) {
    console.error(`${LOG} embedPaperDoll: calc bar hover wiring failed`, err);
  }
}

async function renderDollTemplate(context) {
  const renderFn = foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  return renderFn(TEMPLATE_PATH, context);
}

/**
 * Edit mode mirrors dnd5e's native editImage action (data-edit/data-type) on the
 * portrait — mostly superseded by addEditPortraitButton() below, since
 * .awc-doll-foreground usually covers this element anyway; harmless to leave.
 * Play mode gets no click action — a single click should do nothing (double-click
 * jumps to the token instead, see wireJumpToToken()).
 */
function applyPortraitClickAction(portraitImg, editing) {
  if (editing) {
    portraitImg.dataset.action = "editImage";
    portraitImg.dataset.edit = "img";
    portraitImg.dataset.type = "image";
  }
}

/**
 * Play mode only: double-clicking the doll selects the actor's token, pans the
 * canvas to it, and minimizes the sheet. getActiveTokens() only sees the
 * current scene's placeables — no token there means nothing to jump to.
 */
function wireJumpToToken(portrait, app, actor) {
  const content = portrait.querySelector(".awc-doll-content");
  if (!content) return;

  content.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const token = actor.getActiveTokens(false, false)[0];
      if (!token) {
        ui.notifications.warn(game.i18n.format("AWC.Notify.ActorNotOnScene", { actor: actor.name }));
        return;
      }
      token.control({ releaseOthers: true });
      canvas.animatePan({ x: token.center.x, y: token.center.y });
      app.minimize();
    } catch (err) {
      console.error(`${LOG} wireJumpToToken failed`, err);
    }
  });
}

/**
 * Edit mode only: a dedicated button that opens a FilePicker for actor.img
 * directly, rather than relying on a click reaching .awc-doll-portrait. The
 * doll's own portrait override (dollImg flag) has its own picker via Configure,
 * hidden while embedded.
 */
function addEditPortraitButton(portrait, app, actor) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "awc-doll-control awc-doll-edit-portrait unbutton";
  button.dataset.tooltip = game.i18n.localize("AWC.App.EditPortrait.Tooltip");
  button.innerHTML = `<i class="fas fa-image" inert></i>`;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
    new FP({
      current: actor.img,
      type: "image",
      callback: path => actor.update({ img: path }),
      position: { top: (app.position?.top ?? 0) + 40, left: (app.position?.left ?? 0) + 10 },
    }).render(true);
  });

  portrait.querySelector(".awc-doll-content")?.appendChild(button);
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

// ─── Calc bar ───────────────────────────────────────────────────────────────
// Same markup/logic as sheet-inject.js's parked injectCalcBar (Phase 1
// placement) — this is that logic's actual home now, rendered inline atop
// the embedded doll instead.

function buildCalcBarHTML(cap, ac) {
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

  // Unarmored is the one bracket without a shield tier (CSS draws the
  // others as clip-path shapes on the indicator's ::before) — a real FA
  // glyph reads better for "no shield" than an empty box. ac may be null
  // on the very first prepareDerivedData pass before applyCustomAC has run
  // once; the indicator still renders (blank number) rather than failing.
  const iconHTML = cap.bracket === "unarmored"
    ? `<i class="fa-solid fa-hand-fist" aria-hidden="true"></i>`
    : "";

  return `
    <div class="awc-calc-bar awc-${cap.bracket}" data-tooltip="${tooltip}">
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
 * Hovering the AC indicator shows the same breakdown as the native AC
 * badge's tooltip (ac.js's buildACFormulaHTML), centered on the doll via
 * .awc-doll-hover-tooltip instead of a floating cursor tooltip — this
 * indicator only exists inside the embedded doll, so no "doll not
 * present" fallback is needed here (unlike sheet-inject.js's AC wiring).
 */
function wireCalcBarHoverTooltip(portrait, ac) {
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
