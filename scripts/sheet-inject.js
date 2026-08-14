/**
 * sheet-inject.js
 * Builds and injects all character-sheet UI elements.
 *
 * Uses vanilla DOM throughout for Foundry v14 (ApplicationV2) compatibility.
 * In v14 render hooks, html is an HTMLElement; in v12 it is a jQuery object.
 * Both are normalised to HTMLElement at the entry point.
 */

import { MODULE_ID, FLAG_NS, DEFAULT_BRACKETS } from "./constants.js";
import { getACBreakdown } from "./ac.js";
import { getItemSlot } from "./slots.js";

const LOG = `${MODULE_ID} |`;

// ─── Normalize html parameter ─────────────────────────────────────────────────

function root(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.jquery) return html[0];
  return html;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

export function injectCharacterSheetUI(app, html) {
  // app.document is an Item when this fires for an item sheet (e.g. when a
  // base-class hook name is shared). app.actor may still be a character in that
  // case, so checking actor.type alone is not sufficient.
  if (app.document instanceof Item || app.item) return;

  const el = root(html);
  const actor = app.actor ?? app.document;

  console.debug(`${LOG} injectCharacterSheetUI — actor: ${actor?.name}`);

  if (!el) {
    console.warn(`${LOG} html element is null/undefined — cannot inject`);
    return;
  }

  // Always remove existing AWC panels before re-injecting. (.awc-capacity-bar
  // cleanup stays even though nothing inserts one right now — see note below
  // injectCapacityBar — so a leftover from an older module version doesn't
  // linger on someone's sheet.)
  el.querySelector(".awc-capacity-bar")?.remove();
  el.querySelector(".awc-ac-breakdown")?.remove();

  const ac = getACBreakdown(actor);

  mergeHeaderIntoTitleBar(el);

  if (game.settings.get(MODULE_ID, "showACBreakdown") && ac) {
    injectACBreakdown(el, ac);
  }

  hideDollManagedItems(el, actor);
  wireDollDropUnequip(el, actor);
}

// ─── Header Embed ─────────────────────────────────────────────────────────

/**
 * Relocates .sheet-header (name/class/level-badge/rest-buttons — normally
 * a tall banner living inside .window-content) into Foundry's own native
 * .window-header, the actual title-bar row holding the window controls
 * (kebab menu, token-config, close, etc). Confirmed live at a fixed ~36px
 * tall, so once .sheet-header is a flex child of it (styles in
 * armor-weight-class.css's HEADER EMBED block), both end up on one
 * guaranteed single line — no more reasoning about overlap margins
 * between two independently-sized, stacked boxes.
 *
 * Also reorders .sheet-header's own children into a single left-aligned
 * identity strip — level badge, name, inspiration, class/level text, in
 * that order — and relocates the rest-buttons out to sit with the native
 * window controls on the right, per the target layout. Native markup
 * starts as .left (name, class) and .right (level-badge, inspiration,
 * boon-badge, rest-buttons) side by side; this interleaves them instead.
 *
 * Foundry regenerates .sheet-header fresh inside .window-content on every
 * render (from its own template, not by reading back current live DOM
 * state) — REGARDLESS of the fact that a previous render's copy already
 * sits inside .window-header from this same function. Left unhandled,
 * each render leaves last render's now-stale relocated copy in place
 * (never updated — e.g. an inspiration toggle click never visibly
 * updates) while the fresh, correctly-updated one piles up untouched
 * back in .window-content (a large, unstyled duplicate header, since it
 * never got the .awc-embedded-header class). So every render: purge any
 * stale relocated copy first, then grab THIS render's fresh one
 * specifically from .window-content — never one already relocated.
 */
function mergeHeaderIntoTitleBar(el) {
  const windowHeader = el.querySelector(".window-header");
  const windowContent = el.querySelector(".window-content");
  if (!windowHeader || !windowContent) return;

  // Not every render that fires this hook actually regenerates
  // .sheet-header — some are partial re-renders of other parts of the
  // sheet. Check for a genuine fresh copy FIRST and bail if there isn't
  // one, leaving the already-relocated header exactly as-is; purging it
  // unconditionally (as an earlier version of this function did) deletes
  // the only existing copy with nothing to replace it on those renders,
  // emptying the header entirely.
  const sheetHeader = windowContent.querySelector(".sheet-header");
  if (!sheetHeader) return;

  // A fresh copy exists this render — safe to purge last render's
  // relocated copies now. Rest-buttons get relocated to a spot OUTSIDE
  // .sheet-header (see below), so purging stale .sheet-header copies
  // alone wouldn't catch a stale rest-buttons row — needs its own
  // explicit cleanup here too, same reasoning.
  windowHeader.querySelectorAll(".sheet-header, .awc-relocated-rest-buttons").forEach(node => node.remove());

  sheetHeader.classList.add("awc-embedded-header");
  windowHeader.prepend(sheetHeader);

  const left = sheetHeader.querySelector(".left");
  const right = sheetHeader.querySelector(".right");
  const name = left?.querySelector(".document-name");
  const levelBadge = right?.querySelector(".level-badge");
  const inspiration = right?.querySelector(".inspiration");
  const boonBadge = right?.querySelector(".boon-badge");
  const restButtons = right?.querySelector(".sheet-header-buttons");

  if (left && name) {
    if (levelBadge) name.before(levelBadge);
    if (inspiration) name.after(inspiration);
    if (boonBadge) left.appendChild(boonBadge);
  }

  if (restButtons) {
    restButtons.classList.add("awc-relocated-rest-buttons");
    sheetHeader.after(restButtons);
  }
}

// ─── 0. Sheet ↔ Doll synchronization ─────────────────────────────────────────

/**
 * True for any item the Paper Doll shows on the actor's doll instead of the
 * inventory list: any resolvable AWC slot sub-type (armor/clothing/jewelry,
 * including ring), or an equipped weapon (hand-slot or Exempt position).
 */
function isDollManaged(item) {
  if (!item.system?.equipped) return false;
  if (getItemSlot(item)) return true;
  if (item.type === "weapon") return true;
  return false;
}

/**
 * Hides every inventory row for a currently doll-managed item, and un-hides
 * anything that no longer qualifies (e.g. was just unequipped). Runs on
 * every render so it stays in sync automatically — no separate "restore"
 * step is needed elsewhere.
 */
function hideDollManagedItems(el, actor) {
  for (const row of el.querySelectorAll("[data-item-id]")) {
    const item = actor.items.get(row.dataset.itemId);
    row.classList.toggle("awc-doll-managed-hidden", !!(item && isDollManaged(item)));
  }
}

/**
 * Recognizes a drag payload originating from an AWC doll slot (tagged
 * `type: "AWCDollItem"`, set by scripts/apps/paper-doll-app.js's dragstart
 * handler) dropped anywhere on the character sheet, and unequips the item
 * instead of falling through to Foundry's native item-drop handling (which
 * would otherwise try to re-parent/sort an item the actor already owns).
 * Registered on the capture phase so it runs before the sheet's own native
 * drop listener, which is bound to the same root element.
 */
function wireDollDropUnequip(el, actor) {
  if (el._awcDollDropWired) return;
  el._awcDollDropWired = true;

  el.addEventListener("drop", async (event) => {
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (data?.type !== "AWCDollItem") return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const item = await fromUuid(data.uuid);
    if (!item || item.parent?.id !== actor.id) return;
    await item.update({ "system.equipped": false });
  }, { capture: true });
}

// ─── 1. Capacity Bar ──────────────────────────────────────────────────────────

/**
 * NOT currently called — its call site in injectCharacterSheetUI was
 * removed once Phase 2 (embedding the bar atop the doll instead) became
 * the imminent next step, rather than polish an interim placement about
 * to be thrown away. Kept defined since the markup-building logic here
 * (thresholds, indicator position, tooltip) is exactly what Phase 2 needs
 * to reuse when it renders this at the top of the embedded doll instead —
 * re-enabling meant re-importing getCapacityData from ./capacity.js and
 * calling injectCapacityBar(el, getCapacityData(actor)) again, or lifting
 * this logic wholesale into wherever Phase 2's doll-embedding code lives.
 *
 * Original design note: built to insert directly into .encumbrance.card
 * (Inventory tab), taking over the exact slot the native weight meter
 * occupied — never an "overlay measured from JS" onto that meter. Its
 * fill is a stylesheet ::before sized off a --bar-percentage custom
 * property with no child bar/fill element at all (verified against the
 * actual dnd5e v4 template), so it could never be reliably found/measured
 * from here, and even if it could, its 2-breakpoint design can't
 * represent AWC's 4 brackets anyway.
 */
function injectCapacityBar(el, cap) {
  // Every previous injection must go first — this function runs on every
  // sheet render, and without clearing the prior bar first,
  // insertAdjacentHTML() below just keeps stacking a new one on top of the
  // old, growing without bound render after render.
  el.querySelectorAll(".awc-capacity-bar").forEach(bar => bar.remove());

  // Read live bracket thresholds; fall back to compile-time defaults.
  let thresholds = DEFAULT_BRACKETS;
  try { thresholds = game.settings.get(MODULE_ID, "bracketThresholds") ?? DEFAULT_BRACKETS; }
  catch { /* settings not initialised yet */ }

  // One vertical threshold marker per bracket boundary (skip 0 = unarmored start).
  const markers = [
    { key: "light", pct: (thresholds.light?.min ?? 0.25) * 100 },
    { key: "medium", pct: (thresholds.medium?.min ?? 0.50) * 100 },
    { key: "heavy", pct: (thresholds.heavy?.min ?? 0.75) * 100 },
    { key: "over", pct: (thresholds.over?.min ?? 1.00) * 100 },
  ].filter(m => m.pct > 0 && m.pct <= 100);

  // Circle indicator: clamp at 103% so it stays visible when overburdened.
  const indicatorPct = Math.min(103, Math.max(0, cap.ratio * 100));
  const tooltip = `${cap.equippedWeight} / ${cap.capacity} lbs · ${cap.bracket}`;

  const barHTML = `
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

  const encCard = el.querySelector(".encumbrance.card");
  if (encCard) {
    encCard.insertAdjacentHTML("afterbegin", barHTML);
    return;
  }

  // Fallback for sheet types without an .encumbrance.card (e.g. if the
  // Inventory tab's markup differs on a non-character actor type).
  const inner = el.querySelector(".window-content, .sheet-body, form") ?? el;
  inner.insertAdjacentHTML("afterbegin", barHTML);
}

// ─── 2. AC Breakdown ──────────────────────────────────────────────────────────

function injectACBreakdown(el, ac) {
  const abilityUsed = ac.usedAbility.toUpperCase();
  const breakdownHTML = `
    <div class="awc-ac-breakdown" data-tooltip-direction="UP">
      <div class="awc-ac-formula">
        <span class="awc-ac-base" title="Base">10</span>
        <span class="awc-ac-op">+</span>
        <span class="awc-ac-mod ${ac.usedAbility}" title="max(DEX, CON) = max(${ac.dexMod}, ${ac.conMod})">
          ${ac.baseMod >= 0 ? "+" : ""}${ac.baseMod}
          <small>${abilityUsed}</small>
        </span>
        ${ac.itemBonus !== 0 ? `
        <span class="awc-ac-op">+</span>
        <span class="awc-ac-items" title="Sum of item AC bonuses">${ac.itemBonus >= 0 ? "+" : ""}${ac.itemBonus}<small>items</small></span>` : ""}
        ${ac.miscBonus !== 0 ? `
        <span class="awc-ac-op">+</span>
        <span class="awc-ac-misc" title="Active Effects &amp; other bonuses">${ac.miscBonus >= 0 ? "+" : ""}${ac.miscBonus}<small>misc</small></span>` : ""}
        <span class="awc-ac-op">=</span>
        <span class="awc-ac-total">${ac.total}</span>
      </div>
    </div>
  `;

  // Selectors cover dnd5e v3 (data-prop) and v4 (data-field, .stat.ac)
  const acEl = el.querySelector(
    '[data-prop="system.attributes.ac.value"], [data-field="system.attributes.ac.value"], ' +
    '.ac .value, .attribute.ac, .stat.ac, .defense.ac, [data-stat="ac"]'
  );

  if (acEl) {
    const container = acEl.closest(".attribute, .form-group, .defense, .stat");
    if (container) {
      // Same accumulation risk as the capacity bar — clear any previous
      // injection before adding a fresh one.
      el.querySelectorAll(".awc-ac-breakdown").forEach(node => node.remove());
      console.debug(`${LOG} AC breakdown → inserting after AC container`);
      container.insertAdjacentHTML("afterend", breakdownHTML);
    }
  } else {
    console.debug(`${LOG} AC breakdown → no AC element found, skipping`);
  }
}
