/**
 * doll-embed.js
 * Embeds the Paper Doll into the character sheet's portrait area, replacing
 * the native portrait image. Dynamic-import only — see hooks.js's
 * _hasApplicationV2() gate.
 */

import { MODULE_ID, FLAG_NS, DEFAULT_BRACKETS } from "./constants.js";
import { getItemSlot, getSlotMap } from "./slots.js";
import {
  getHandSlotState, getRingSlotState, getExemptItem, actorHasExemptCapableItem, swapHandSlot, swapRingSlot, describeHandBlocker,
  getQuiverItem, actorHasEquippedRangedWeapon, isPocketCarrier, isPocketEligible, getPocketedItems, getPocketCapacity,
  dropCarrierAndPocketsViaItemPiles,
} from "./paired-slots.js";
import { getCapacityData } from "./capacity.js";
import { getACBreakdown, buildACFormulaHTML } from "./ac.js";
import { applyDropHighlights } from "./drag-highlight.js";
import {
  getDollLayout, buildSlotEntry, buildGroupedSlotEntry, buildRingEntry, buildExemptEntry, buildHandGroup, buildQuiverEntry,
  GROUPED_SLOTS, LEFT_COLUMN, RIGHT_COLUMN, CENTER_TOP_ROW,
  slotFromElement, itemForSlot, eligibleItemsForSlot, equipItemToSlot, buildTooltipHTML,
  rollAttackWithAutomation, filterAttackModesForSlot, positionPickerAboveSlot, wirePickerDismiss, redirectVersatileDrop, handlePocketDrop,
  resolveGenericEquipTarget, consumePendingPocketReveals, consumePendingPocketCloses, consumePendingPocketHighlights, renderPocketSlots, showPocketFillPicker, isHalfModeEmbedded,
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
 * Replaces the native portrait with the rendered doll and wires its
 * interactions. Cached per-actor fingerprint avoids an unnecessary rebuild
 * flash on unrelated updates (HP, exhaustion, etc).
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
    showQuiver: actorHasEquippedRangedWeapon(actor),
    quiver: buildQuiverEntry(layout, getQuiverItem(actor)),
  };
}

// ─── Calc bar ───────────────────────────────────────────────────────────────

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
    slotEl.addEventListener("dblclick", (event) => onDoubleClick(event, actor));
    slotEl.addEventListener("contextmenu", (event) => onContextMenu(event, actor));
    slotEl.addEventListener("pointerenter", (event) => onHoverIn(event, actor, rootEl));
    slotEl.addEventListener("pointerleave", () => onHoverOut(rootEl));
  });

  // Catch-all for a drop that lands anywhere else in the doll (the portrait background, a
  // gap between boxes) - every per-slot drop handler above already calls
  // event.stopPropagation(), so this never fires for a drop that landed precisely on a slot.
  const content = rootEl.querySelector(".awc-doll-content");
  if (content) {
    content.addEventListener("dragover", (event) => event.preventDefault());
    content.addEventListener("drop", (event) => onDropAnywhere(event, actor));
  }

  consumePendingPocketReveals(actor, rootEl.querySelectorAll(".awc-doll-slot"), (slotEl, carrier, pocketed) => showPocketViewer(slotEl, carrier, pocketed, actor));
  consumePendingPocketHighlights(actor, rootEl.querySelectorAll(".awc-doll-slot"), (slotEl, carrier, pocketed, highlightItemId) => showPocketViewer(slotEl, carrier, pocketed, actor, highlightItemId));
  consumePendingPocketCloses();
}

function onDragStart(event, actor) {
  event.stopPropagation();
  const slot = slotFromElement(event.currentTarget);
  const item = itemForSlot(actor, slot);
  if (!item) { event.preventDefault(); return; }
  event.dataTransfer.setData("text/plain", JSON.stringify({ type: "AWCDollItem", uuid: item.uuid, ...slot }));
  applyDropHighlights(item);
}

async function onDrop(event, actor) {
  event.preventDefault();
  event.stopPropagation();
  let data;
  try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
  catch { return; }
  if (!data?.uuid) return;

  let targetSlot = slotFromElement(event.currentTarget);
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

  const dropCarrier = itemForSlot(actor, targetSlot);
  if (dropCarrier && dropCarrier.id !== item.id && isPocketEligible(item, dropCarrier)) {
    await handlePocketDrop(actor, item, dropCarrier);
    return;
  }

  targetSlot = redirectVersatileDrop(actor, item, targetSlot);

  const eligible = eligibleItemsForSlot(actor, targetSlot).some(i => i.id === item.id) || itemForSlot(actor, targetSlot)?.id === item.id;
  if (!eligible && targetSlot.kind === "slot" && getItemSlot(item) !== targetSlot.key) return;
  await equipItemToSlot(item, targetSlot);
}

/** Mirrors paper-doll-app.js's AWCPaperDoll._onDropAnywhere - see there for the full explanation. */
async function onDropAnywhere(event, actor) {
  event.preventDefault();
  let data;
  try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
  catch { return; }
  if (!data?.uuid) return;

  let item = await fromUuid(data.uuid);
  if (!item) return;

  if (item.parent?.id !== actor.id) {
    if (!game.settings.get(MODULE_ID, "dollAllowNonOwned")) return;
    const [created] = await actor.createEmbeddedDocuments("Item", [item.toObject()]);
    item = created;
  }

  const target = resolveGenericEquipTarget(item);
  if (target) await equipItemToSlot(item, target);
}

async function onClick(event, actor, rootEl) {
  event.stopPropagation();
  const slotEl = event.currentTarget;
  const slot = slotFromElement(slotEl);
  const item = itemForSlot(actor, slot);

  if (item) {
    // Mirrors paper-doll-app.js's AWCPaperDoll._onClick - this embedded doll (the one shown
    // directly on the character sheet) has its own separate click handler, so the same combat-
    // only attack/pocket-popup logic has to be applied here too, not just on the standalone
    // popped-out doll app.
    const isCarrier = isPocketCarrier(item);
    const pocketed = isCarrier ? getPocketedItems(actor, item) : [];

    // Mid-combat, an equipped item that can attack gets a quick attack-mode popup instead of
    // the full sheet; a pocket carrier's own pocketed items' action options are folded into
    // the same popup, alongside its own attack (if it has one) - see showPocketPicker().
    if (game.combat) {
      const activity = item.system.activities?.getByType?.("attack")?.[0];
      if (activity || isCarrier) { showPocketPicker(slotEl, item, activity, pocketed, slot, actor); return; }
      item.sheet?.render(true);
      return;
    }

    // Out of combat, a pocket carrier always opens its pocket window on click, even if
    // nothing's pocketed yet (shows an empty-state message instead of silently doing nothing)
    // - double-click an entry to open its sheet (see showPocketViewer()). Anything else does
    // nothing on a plain single-click - double-click opens the sheet instead (onDoubleClick).
    if (isCarrier) showPocketViewer(slotEl, item, pocketed, actor);
    return;
  }

  const eligible = eligibleItemsForSlot(actor, slot);
  showPicker(slotEl, slot, eligible);
}

/** Mirrors paper-doll-app.js's AWCPaperDoll._onDoubleClick - see there for the full
 *  explanation. */
function onDoubleClick(event, actor) {
  event.stopPropagation();
  const slot = slotFromElement(event.currentTarget);
  const item = itemForSlot(actor, slot);
  item?.sheet?.render(true);
}

/** Appends `item`'s own attack-mode options as text rows into an already-open popup - mirrors
 *  paper-doll-app.js's AWCPaperDoll#_appendAttackModeOptions, see there for the full
 *  explanation. Shared by showPocketPicker below for both a plain weapon's attack (no pockets
 *  involved) and a carrier's own attack alongside its pocketed items' options. */
function appendAttackModeOptions(inner, item, activity, slot, actor, close) {
  const rawModes = (item.system.attackModes ?? []).filter(m => !m.rule);
  const modes = filterAttackModesForSlot(rawModes, slot, actor);
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

/** Mirrors paper-doll-app.js's AWCPaperDoll._showPocketPicker - see there for the full
 *  explanation (item's own attack options, then a pocket icon-grid via renderPocketSlots, one
 *  box per Pocket Capacity slot, either section skipped when it has nothing to show). */
function showPocketPicker(slotEl, item, activity, pocketedItems, slot, actor, highlightItemId) {
  const inner = document.createElement("div");
  inner.classList.add("awc-doll-picker", "awc-doll-attack-picker", "awc-doll-picker-embedded",
    ...(isHalfModeEmbedded(slotEl) ? [] : ["awc-doll-picker-full"]));
  inner.dataset.carrierId = item.id;
  document.body.appendChild(inner);
  positionPickerAboveSlot(inner, slotEl);
  const close = wirePickerDismiss(inner);

  if (activity) appendAttackModeOptions(inner, item, activity, slot, actor, close);

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
        showPocketFillPicker(slotEl, actor, item, () => actor.sheet?.render());
      },
      highlightItemId,
    });
  }
}

/** Mirrors paper-doll-app.js's AWCPaperDoll._showPocketViewer - see there for the full
 *  explanation. */
function showPocketViewer(slotEl, carrier, pocketedItems, actor, highlightItemId) {
  const inner = document.createElement("div");
  inner.classList.add("awc-doll-picker", "awc-doll-picker-embedded",
    ...(isHalfModeEmbedded(slotEl) ? [] : ["awc-doll-picker-full"]));
  inner.dataset.carrierId = carrier.id;
  document.body.appendChild(inner);
  positionPickerAboveSlot(inner, slotEl);
  const close = wirePickerDismiss(inner);

  renderPocketSlots(inner, carrier, pocketedItems, {
    onEmptyClick: () => {
      close();
      showPocketFillPicker(slotEl, actor, carrier, () => actor.sheet?.render());
    },
    highlightItemId,
  });
}

/** Positioned above the clicked slot, same as showPocketPicker - see paper-doll-app.js's
 *  AWCPaperDoll._showPicker for why this no longer touches .awc-doll-center directly. */
function showPicker(slotEl, slot, items) {
  if (!items.length) return;

  const inner = document.createElement("div");
  inner.classList.add("awc-doll-picker", "awc-doll-picker-embedded",
    ...(isHalfModeEmbedded(slotEl) ? [] : ["awc-doll-picker-full"]));
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
      await equipItemToSlot(item, slot);
      close();
    });
  }
}

async function onContextMenu(event, actor) {
  event.preventDefault();
  event.stopPropagation();
  const slot = slotFromElement(event.currentTarget);
  const item = itemForSlot(actor, slot);
  if (!item) {
    // An empty slot's custom background image is set only from Configure Paper Doll now,
    // not from the live doll - right-clicking an empty slot here does nothing.
    return;
  }

  if (game.combat && game.modules.get("item-piles")?.active) {
    if (await dropCarrierAndPocketsViaItemPiles(actor, item)) return;
  }
  await item.update({ "system.equipped": false });
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
