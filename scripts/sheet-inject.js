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

  mergeHeaderIntoTitleBar(el, actor);
  injectSkillsProficiency(el, actor);
  injectMovementPillsGroup(el, actor);
  hideNativeLozenges(el);

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
function mergeHeaderIntoTitleBar(el, actor) {
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

  if (levelBadge) repurposeLevelBadgeAsInitiative(levelBadge, actor, el.classList.contains("editable"));
}

/**
 * Level badge repurposed to display + roll Initiative instead of the
 * actor's level (which the compact header has no other room for anyway).
 * Replicates dnd5e's own Initiative lozenge exactly (character-sidebar.hbs
 * ~84-100 / dnd5e.mjs's BaseActorSheet.#roll, case "initiative" →
 * actor.rollInitiativeDialog()): same data-action/data-type pair, the
 * same "rollable" class the native #roll action handler specifically
 * requires before it does anything (dnd5e.mjs ~57055), and the same plain
 * data-tooltip mechanism (a localization key, auto-localized by Foundry's
 * native tooltip — no custom styling needed, same as .inspiration's own
 * tooltip) rather than anything AWC-specific.
 *
 * In edit mode, mirrors the native lozenge's own swap (character-sidebar
 * .hbs ~88-93): the rollable number is replaced by a config-button gear
 * that opens the actual Initiative Configuration dialog instead. The
 * outer element keeps data-action="roll" either way (native does too) —
 * the gear button's own, more specific data-action="showConfiguration"
 * is the actual click target and wins via Foundry's closest-ancestor
 * action delegation, so it always intercepts before "roll" ever fires.
 */
function repurposeLevelBadgeAsInitiative(levelBadge, actor, editable) {
  levelBadge.dataset.action = "roll";
  levelBadge.dataset.type = "initiative";
  levelBadge.dataset.tooltip = "DND5E.Initiative";
  levelBadge.setAttribute("aria-label", game.i18n.localize("DND5E.Initiative"));
  // Living inside .window-header means it inherits that region's own grab
  // cursor (Foundry's window-drag handle) rather than .rollable's usual
  // pointer — .inspiration avoids this by being a <button>, which gets a
  // pointer cursor by default regardless of its container. Inline style
  // beats that unconditionally, no CSS specificity fight needed.
  levelBadge.style.cursor = "pointer";

  if (editable) {
    levelBadge.classList.remove("rollable");
    levelBadge.innerHTML = `
      <button type="button" class="config-button unbutton" data-action="showConfiguration"
              data-config="initiative" data-tooltip="DND5E.InitiativeConfig"
              aria-label="${game.i18n.localize("DND5E.InitiativeConfig")}">
        <i class="fas fa-cog" inert></i>
      </button>
    `;
    return;
  }

  const total = actor.system?.attributes?.init?.total ?? 0;
  levelBadge.textContent = (total >= 0 ? "+" : "") + total;
  levelBadge.classList.add("rollable");
}

// ─── Skills Header Proficiency ─────────────────────────────────────────────

/**
 * Appends "Proficiency: +2" to the Skills box's own heading
 * (<filigree-box class="skills"><h3><i>...</i><span>SKILLS</span></h3>...,
 * character-details.hbs:7-11) — native h3 is
 * `display:flex; justify-content:center` (dnd5e.css:3820-3824), so the
 * icon+"SKILLS" span already cluster together on their own; margin-left:
 * auto on this new span consumes all remaining space itself rather than
 * fighting that justify-content, landing it at the far right regardless
 * of the parent's own alignment setting.
 */
function injectSkillsProficiency(el, actor) {
  el.querySelector(".awc-skills-proficiency")?.remove();

  const heading = el.querySelector("filigree-box.skills > h3, .skills > h3");
  if (!heading) return;

  const prof = actor.system?.attributes?.prof ?? 0;
  const span = document.createElement("span");
  span.className = "awc-skills-proficiency";
  span.textContent = `${game.i18n.localize("DND5E.Proficiency")}: ${prof >= 0 ? "+" : ""}${prof}`;
  heading.appendChild(span);
}

// ─── Movement Pills Group ─────────────────────────────────────────────────

export const AWC_MOVEMENT_TYPE_ICONS = {
  walk: "fas fa-shoe-prints",
  burrow: "fas fa-worm",
  climb: "fas fa-mountain",
  fly: "fas fa-feather",
  swim: "fas fa-water",
};

// Per-client, in-memory last-known-good movement snapshot, keyed by actor
// id — see the cache-preference logic in resolveMovementDisplay below for
// why this exists: a fresh flag/_source read immediately after
// AWCMovementDisplayConfig saves has been observed to lag behind what was
// just submitted — actor.update() is an async round trip, and if the
// user's very next action (e.g. toggling edit mode off) triggers another
// render before that round trip lands, the render reads pre-update data.
// cacheMovementDisplay() is the one write path into this map — called by
// AWCMovementDisplayConfig's submit handler with the just-saved values,
// so the cache is never behind what the user actually just entered.
const _awcLastGoodMovement = new Map();

function _awcNormalizeMovement(m) {
  const norm = {};
  for (const key of Object.keys(AWC_MOVEMENT_TYPE_ICONS)) norm[key] = Number(m?.[key]) || 0;
  norm.units = m?.units || "ft";
  norm.hover = !!m?.hover;
  return norm;
}

/** Records movement as the latest known-good value for actorId — see _awcLastGoodMovement above. */
export function cacheMovementDisplay(actorId, movement) {
  _awcLastGoodMovement.set(actorId, movement);
}

/**
 * Resolves the movement values AWC's UI (the pills-group and
 * AWCMovementDisplayConfig) should currently display, in priority order:
 *   1. The in-memory cache — preferred over any fresh persisted-data read
 *      once it holds a value for this actor, because setFlag()/
 *      actor.update() is an async round trip: if AWCMovementDisplayConfig
 *      saves and the very next render (e.g. toggling edit mode off) fires
 *      before that round trip lands, a fresh read of the flag or actor
 *      data can still reflect pre-save state. Self-heals the flag on the
 *      spot if it disagrees with the cache.
 *   2. flags.armor-weight-class.movementDisplay — an AWC-owned snapshot,
 *      written only by AWCMovementDisplayConfig's own Save action, read
 *      only once no in-memory cache exists yet this client session (e.g.
 *      right after a page reload).
 *   3. actor.system._source.attributes.movement — the actor's raw,
 *      currently-saved data, read the same way dnd5e's own
 *      MovementSensesConfig itself builds its display
 *      (dnd5e.mjs's MovementSensesConfig#_preparePartContext reads
 *      `this.document.system._source`, NOT the derived
 *      actor.system.attributes.movement) — this is what a freshly-opened
 *      sheet uses before the flag has ever been set, so the section is
 *      correct on first render without ever needing AWCMovementDisplayConfig
 *      to have been opened first. Reading _source rather than the derived
 *      value also sidesteps whatever's behind the stale-derived-data
 *      pattern documented in the dnd5e-stale-form-submission project note.
 *   4. actor.system.attributes.movement — last-resort fallback if _source
 *      is somehow unavailable.
 * @returns {{movement: object, source: string}}
 */
export function resolveMovementDisplay(actor) {
  const flagValue = actor.getFlag(FLAG_NS, "movementDisplay");
  const sourceMovement = actor.system?._source?.attributes?.movement;
  const cached = _awcLastGoodMovement.get(actor.id);

  if (cached) {
    // Self-heal, but only on an actual mismatch — otherwise this would
    // fire a setFlag() on every single render once healed once.
    if (JSON.stringify(_awcNormalizeMovement(flagValue)) !== JSON.stringify(_awcNormalizeMovement(cached))) {
      actor.setFlag(FLAG_NS, "movementDisplay", cached)
        .then(() => console.debug(`${LOG} resolveMovementDisplay: self-healed movementDisplay flag from cache for "${actor.name}"`, cached))
        .catch(err => console.error(`${LOG} resolveMovementDisplay: self-heal flag write failed`, err));
    }
    return { movement: cached, source: "cached last-good (this client session)" };
  }

  const movement = flagValue ?? sourceMovement ?? actor.system?.attributes?.movement ?? {};
  const source = flagValue ? "movementDisplay flag" : sourceMovement ? "actor._source" : "derived fallback";
  return { movement, source };
}

/**
 * Builds a "Movement" pills-group on the Details tab's right column, above
 * Senses — one pill per movement type, always all five (blank inputs on
 * the dialog display as 0, never hidden), plus a checkbox-state icon next
 * to Fly mirroring the dialog's own Hover checkbox. Reuses the exact
 * native markup shape templates/actors/parts/actor-trait-pills.hbs
 * produces, so it picks up matching dnd5e styling for free.
 *
 * Data comes from resolveMovementDisplay() above — never directly from
 * dnd5e's own derived system.attributes.movement (confirmed unreliable,
 * see the dnd5e-stale-form-submission project note). The gear button
 * opens AWCMovementDisplayConfig, an AWC-owned editor — display-only,
 * never touches dnd5e's own movement-save pipeline.
 */
export function injectMovementPillsGroup(el, actor) {
  el.querySelectorAll(".awc-movement-pills-group").forEach(node => node.remove());

  const sensesGroup = el
    .querySelector('.tab[data-tab="details"] .right .pills-group h3 i.fa-eye')
    ?.closest(".pills-group");
  if (!sensesGroup) return;

  const { movement, source } = resolveMovementDisplay(actor);
  console.debug(`${LOG} injectMovementPillsGroup — source: ${source}`, movement);
  const units = movement.units || "ft";
  const hover = !!movement.hover;

  const pills = Object.keys(AWC_MOVEMENT_TYPE_ICONS)
    .map(key => {
      const label = game.i18n.localize(CONFIG.DND5E.movementTypes?.[key]?.label ?? key);
      const value = Number(movement[key]) || 0;
      const hoverIcon = key === "fly" ? `
        <i class="far ${hover ? "fa-square-check" : "fa-square"} awc-movement-hover-icon"
           data-tooltip="${game.i18n.localize("DND5E.MOVEMENT.Hover")}"></i>
      ` : "";
      return `
        <li class="pill">
          <i class="${AWC_MOVEMENT_TYPE_ICONS[key]}"></i>
          <span class="label">${label}</span>
          <span class="separator">&vert;</span>
          <span class="value">${value} ${units}</span>
          ${hoverIcon}
        </li>
      `;
    }).join("");

  // The native partial's config button is gated on @root.editable (sheet
  // edit mode), not hover — Foundry itself toggles an "editable" class on
  // the sheet root exactly for this, so checking it here needs no access
  // to `app`. Deliberately NOT dnd5e's own data-action="showConfiguration"
  // data-config="movement" (which would free-ride dnd5e's native
  // action-delegation straight to the REAL Movement Configuration dialog)
  // — this opens AWC's own editor instead, wired below.
  const configButton = el.classList.contains("editable") ? `
    <button type="button" class="config-button unbutton awc-movement-config-button"
            data-tooltip aria-label="${game.i18n.format("DND5E.TraitConfig", { trait: game.i18n.localize("DND5E.Movement") })}">
      <i class="fas fa-cog" inert></i>
    </button>
  ` : "";

  const group = document.createElement("div");
  group.className = "pills-group awc-movement-pills-group";
  group.innerHTML = `
    <h3 class="icon">
      <i class="fas fa-person-running"></i>
      <span class="roboto-upper">${game.i18n.localize("DND5E.Movement")}</span>
      ${configButton}
    </h3>
    <ul class="pills">${pills}</ul>
  `;

  // Safe to attach fresh every call — this whole node is torn down and
  // rebuilt on every injectMovementPillsGroup call, never left stale.
  group.querySelector(".awc-movement-config-button")?.addEventListener("click", async () => {
    const { AWCMovementDisplayConfig } = await import("./apps/movement-display-config.js");
    new AWCMovementDisplayConfig(actor).render(true);
  });

  sensesGroup.before(group);
}

/**
 * Hides dnd5e's native Initiative/Speed/Proficiency lozenges row
 * (character-sidebar.hbs .stats .lozenges, ~82-101) — redundant now that
 * AWC has its own replacement for all three: the repurposed level-badge
 * (Initiative — repurposeLevelBadgeAsInitiative above), the Movement
 * pills-group (Speed — injectMovementPillsGroup above), and the Skills
 * header (Proficiency — injectSkillsProficiency above). Re-applied every
 * render since dnd5e regenerates .stats fresh along with the rest of the
 * sidebar.
 */
function hideNativeLozenges(el) {
  const lozenges = el.querySelector(".stats .lozenges");
  if (lozenges) lozenges.style.display = "none";
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

// "+" / "-" as its own separator, magnitude alone after it — never combine
// a literal "+ " separator with a number that also carries its own sign
// (that's how "+ +3"/"+ -1" bugs happen).
const acOp = (n) => (n < 0 ? "-" : "+");

function injectACBreakdown(el, ac) {
  const abilityUsed = ac.usedAbility.toUpperCase();
  const breakdownHTML = `
    <div class="awc-ac-breakdown" data-tooltip-direction="UP">
      <div class="awc-ac-formula">
        <span class="awc-ac-base" title="Base">10</span>
        <span class="awc-ac-op">${acOp(ac.baseMod)}</span>
        <span class="awc-ac-mod ${ac.usedAbility}" title="max(DEX, CON) = max(${ac.dexMod}, ${ac.conMod})">
          ${Math.abs(ac.baseMod)}
          <small>${abilityUsed}</small>
        </span>
        ${ac.itemBonus !== 0 ? `
        <span class="awc-ac-op">${acOp(ac.itemBonus)}</span>
        <span class="awc-ac-items" title="Sum of item AC bonuses">${Math.abs(ac.itemBonus)}<small>equip</small></span>` : ""}
        ${ac.miscBonus !== 0 ? `
        <span class="awc-ac-op">${acOp(ac.miscBonus)}</span>
        <span class="awc-ac-misc" title="Active Effects &amp; other bonuses">${Math.abs(ac.miscBonus)}<small>misc</small></span>` : ""}
        <span class="awc-ac-op">=</span>
        <span class="awc-ac-total">${ac.total}</span>
      </div>
    </div>
  `;

  // .ac-badge is dnd5e v4's actual character-sheet AC element (confirmed
  // directly against the sidebar template/CSS) — none of the other
  // selectors here ever matched it, which is why this had been silently a
  // no-op the whole time. Kept as the first alternative (highest priority)
  // with the older generic patterns still checked after, for dnd5e v3 /
  // other sheet layouts.
  const acEl = el.querySelector(
    '.ac-badge, [data-prop="system.attributes.ac.value"], [data-field="system.attributes.ac.value"], ' +
    '.ac .value, .attribute.ac, .stat.ac, .defense.ac, [data-stat="ac"]'
  );

  if (!acEl) {
    console.debug(`${LOG} AC breakdown → no AC element found, skipping`);
    return;
  }

  // .ac-badge sits in a tightly-packed row (exhaustion pips either side,
  // now also crowded by the embedded doll above it) with no room for an
  // inserted visible block — the breakdown becomes a plain-text tooltip
  // directly on the badge instead. Simpler than the block-insertion path
  // below, and no separate cleanup-before-reinsert needed since setting
  // the attribute again just overwrites the previous value.
  if (acEl.matches(".ac-badge")) {
    let tooltip = `10 ${acOp(ac.baseMod)} ${Math.abs(ac.baseMod)} (${abilityUsed})`;
    if (ac.itemBonus !== 0) tooltip += ` ${acOp(ac.itemBonus)} ${Math.abs(ac.itemBonus)} (equip)`;
    if (ac.miscBonus !== 0) tooltip += ` ${acOp(ac.miscBonus)} ${Math.abs(ac.miscBonus)} (misc)`;
    tooltip += ` = ${ac.total}`;

    // dnd5e's own inner div (character-sidebar.hbs: the one actually
    // displaying the AC number, nested inside .ac-badge) carries
    // data-attribution="attributes.ac". dnd5e's own _onRender
    // (BaseActorSheet#_applyTooltips) bakes a permanent loading-spinner
    // placeholder into THAT element's own data-tooltip and relies on an
    // async hover handler (#_onHoverActor → actor.getAttributionData →
    // _prepareArmorClassAttribution) to swap in real content on every
    // hover. That native calculator reads dnd5e's own AC attribution
    // data, which AWC's full-replacement AC formula (ac.js,
    // system.attributes.ac.calc = "awc-overhaul") never populates — so
    // the swap silently never happens and the spinner just sits there
    // for as long as the mouse hovers. Setting data-tooltip on the outer
    // .ac-badge alone (below) doesn't fix this: the inner div is what's
    // actually under the cursor for most of the badge's area, and its
    // own competing tooltip trigger wins. Removing data-attribution here
    // is what actually stops it — #_onHoverActor bails out immediately
    // when that attribute is absent, leaving whatever data-tooltip
    // content is already there (ours) alone.
    // Matches either a freshly-native-rendered element (still carrying
    // data-attribution, not yet processed) OR one we've already processed
    // on an earlier call against this same persistent node (identified by
    // our own .awc-ac-badge-value class, added below) — this second half
    // is what makes the lookup idempotent across repeated calls. Without
    // it, a later call (e.g. via _refreshActorSheet, which patches the
    // existing DOM rather than triggering a fresh dnd5e render) fails to
    // re-find this element — because data-attribution was already deleted
    // last time — and wrongly falls into the "no inner div" fallback
    // below, setting a second, competing tooltip on the outer .ac-badge
    // while this element's already-wired listeners are still active.
    // Confirmed live: both tooltips fired on the same hover.
    const innerAcValue = acEl.querySelector("[data-attribution], .awc-ac-badge-value");
    if (innerAcValue) {
      // Clears whatever the outer badge's own fallback branch (below) may
      // have wrongly set here during the stale-lookup bug described
      // above — without this, a tooltip already sitting on the outer
      // .ac-badge from before this fix landed would keep firing alongside
      // the inner element's correct one until a full dnd5e re-render
      // happened to wipe .ac-badge clean on its own.
      delete acEl.dataset.tooltip;
      delete acEl.dataset.tooltipDirection;
      delete innerAcValue.dataset.attribution;
      delete innerAcValue.dataset.attributionCaption;
      // dnd5e's _applyTooltips() (dnd5e.mjs) also set data-tooltip-class=
      // "property-attribution" on this element back when data-attribution
      // was still present ("if (element.dataset.attribution)
      // element.dataset.tooltipClass = ...") — deleting attribution above
      // never touched this leftover. property-attribution tooltips render
      // as interactive tables (dnd5e.css) and are the kind of tooltip
      // Foundry supports locking open instead of dismissing on
      // mouseleave — a plausible explanation for a stuck/stale tooltip
      // that keeps showing regardless of what's hovered next, and (being
      // a real positioned element rather than a transient hint) sitting
      // on top of and blocking clicks to whatever's underneath it.
      // Deleting it reverts this to a completely plain data-tooltip
      // element with none of that special handling.
      delete innerAcValue.dataset.tooltipClass;
      // Own class so armor-weight-class.css can shrink this element's own
      // hover hit-box to just the number instead of the whole 68px badge
      // square — see AC BADGE TOOLTIP TRIGGER SIZE.
      innerAcValue.classList.add("awc-ac-badge-value");

      // Never use the declarative data-tooltip path for this element —
      // whether the doll is embedded is decided fresh at HOVER time
      // (below), not here at render time. injectACBreakdown runs
      // synchronously on every genuine sheet render, but dnd5e regenerates
      // .portrait's native <img> fresh on every one of those renders
      // BEFORE our own doll embed (an async dynamic import in doll-embed.js)
      // gets a chance to rebuild it — so checking for .awc-doll-hover-
      // tooltip here, at render time, finds nothing on almost every
      // render, not just a rare first-load edge case (confirmed live: the
      // doll-centered branch never activated). By hover time the doll has
      // had plenty of time to finish embedding, so that's the reliable
      // point to check instead.
      delete innerAcValue.dataset.tooltip;
      delete innerAcValue.dataset.tooltipDirection;

      // Always refresh the stored text, even when the listeners below are
      // already wired from an earlier call against this same node (e.g.
      // via _refreshActorSheet, which doesn't always regenerate .stats
      // fresh) — keeps the tooltip's content current after equipment
      // changes without needing to re-wire anything.
      innerAcValue.dataset.awcAcTooltip = tooltip;

      if (!innerAcValue._awcHoverWired) {
        innerAcValue._awcHoverWired = true;
        innerAcValue.addEventListener("pointerenter", (event) => {
          const text = event.currentTarget.dataset.awcAcTooltip ?? "";
          const panel = el.querySelector(".awc-doll-hover-tooltip");
          if (panel) {
            // Doll is embedded — match its own item-hover tooltips
            // instead of dnd5e's native one: the same shared panel
            // (paper-doll.css's .awc-doll-hover-tooltip), always centered
            // on the doll, rather than popping up near the badge/cursor.
            panel.innerHTML = text;
            panel.classList.add("active");
          } else {
            // No doll on this sheet (dollPlayerOwnedOnly gating, or
            // pre-v13 Foundry where doll-embed.js never loads) — Foundry's
            // own imperative tooltip API (game.tooltip.activate(), the
            // same one dnd5e itself uses, e.g. dnd5e.mjs's copy-to-
            // clipboard handler) instead of the declarative data-tooltip
            // attribute, since the whole point here is deciding which
            // mechanism to use fresh at hover time rather than baking it
            // in at render time.
            game.tooltip.activate(event.currentTarget, { text, direction: "UP" });
          }
        });
        innerAcValue.addEventListener("pointerleave", () => {
          const panel = el.querySelector(".awc-doll-hover-tooltip");
          if (panel) panel.classList.remove("active");
          else game.tooltip.deactivate();
        });
      }
    } else if (!el.classList.contains("editable")) {
      // Genuine fallback: no inner div found and we're NOT in edit mode
      // (where its absence is expected, see below) — some other dnd5e
      // layout that doesn't nest one. Nothing to dedupe against here, so
      // the outer badge is the only reasonable place left for the tooltip.
      acEl.dataset.tooltip = tooltip;
      acEl.dataset.tooltipDirection = "UP";
    }
    // In edit mode the inner div is never rendered at all — dnd5e's own
    // hbs swaps it for a config-button (data-action="showConfiguration"
    // data-config="armorClass"), which carries its own distinct
    // "DND5E.ArmorConfig" tooltip. Never fall back to setting ours on the
    // outer .ac-badge in that case — it would sit directly behind that
    // button, recreating the exact overlapping dual-trigger problem the
    // dedupe above exists to prevent, just relocated to edit mode instead
    // of eliminated. Net result across both modes: exactly one AC-related
    // tooltip trigger, ever — never dnd5e's broken native attribution one,
    // never two of AWC's own layered on top of each other.
    return;
  }

  const container = acEl.closest(".attribute, .form-group, .defense, .stat");
  if (container) {
    // Same accumulation risk as the capacity bar — clear any previous
    // injection before adding a fresh one.
    el.querySelectorAll(".awc-ac-breakdown").forEach(node => node.remove());
    console.debug(`${LOG} AC breakdown → inserting after AC container`);
    container.insertAdjacentHTML("afterend", breakdownHTML);
  }
}
