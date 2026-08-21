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
import { reflowItemsList } from "./column-reflow.js";
import { TARGET_SHAPE_PATTERN, buildTargetShapeSVG, INDIVIDUAL_TARGET_PATTERNS, buildIndividualTargetSVG } from "./target-icons.js";

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
  stripFavoritesAttackText(el);
  try { stripConnectorWords(el); } catch (err) { console.error(`${LOG} stripConnectorWords failed`, err); }
  try { iconifyTargetColumn(el); } catch (err) { console.error(`${LOG} iconifyTargetColumn failed`, err); }
  try { overlaySchoolIconOnTime(el); } catch (err) { console.error(`${LOG} overlaySchoolIconOnTime failed`, err); }
  try { mergeUsesIntoPrepared(el); } catch (err) { console.error(`${LOG} mergeUsesIntoPrepared failed`, err); }
  relocateInventoryCurrency(el);
  try { relocateSearchAndAttunement(el); } catch (err) { console.error(`${LOG} relocateSearchAndAttunement failed`, err); }
  try { relocateToolsUnderSaves(el); } catch (err) { console.error(`${LOG} relocateToolsUnderSaves failed`, err); }
  try { wireSidebarCollapseReflow(el); } catch (err) { console.error(`${LOG} wireSidebarCollapseReflow failed`, err); }
  try { injectSidebarUncollapseButton(el, actor, app); } catch (err) { console.error(`${LOG} injectSidebarUncollapseButton failed`, err); }
  try { relocateConditionsIntoEffectsList(el); } catch (err) { console.error(`${LOG} relocateConditionsIntoEffectsList failed`, err); }
  try { wireHpHdFractionAlignment(el); } catch (err) { console.error(`${LOG} wireHpHdFractionAlignment failed`, err); }
  try {
    reflowItemsList(el, { listSelector: '.tab[data-tab="inventory"] .items-list' });
    reflowItemsList(el, { listSelector: '.tab[data-tab="features"] .items-list' });
    reflowItemsList(el, { listSelector: '.tab[data-tab="spells"] .items-list' });
    reflowItemsList(el, { listSelector: '.tab[data-tab="effects"] .items-list.effects-list' });
  } catch (err) {
    console.error(`${LOG} reflowItemsList failed`, err);
  }

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

/**
 * Drops the word "Attack" from Favorites subtitle text (e.g. "Ranged
 * Weapon Attack" → "Ranged Weapon"). subtitle is rendered via {{{ }}}
 * (raw/unescaped, character-sidebar.hbs) so this operates on innerHTML
 * rather than textContent — a plain-text word match won't disturb any
 * embedded markup. Safe to rerun every render: dnd5e regenerates
 * .favorites fresh from its template each time, so this always runs
 * against genuine unprocessed native content, never its own prior output.
 */
function stripFavoritesAttackText(el) {
  el.querySelectorAll(".favorites > ul .name-stacked .subtitle").forEach(node => {
    node.innerHTML = node.innerHTML.replace(/\s*\bAttack\b\s*/g, " ").trim();
  });
}

// Word-boundary matched, not a bare substring — "and"/"or" bare would also
// hit "Wand", "Handaxe", "Armor", "Corridor", "Mirror", etc. "/" has no
// such risk (never legitimately part of a word) so it's matched directly.
// Two separate regex objects (not one shared /g one reused for both a
// .test() check and a .replace() call) — a global regex's lastIndex is
// mutable/stateful across calls, and mixing .test() + .replace() usage on
// the SAME instance is a well-known source of skipped-match bugs.
const CONNECTOR_WORD_CHECK = /\s*\/\s*|\b(?:and|or)\b/i;
const CONNECTOR_WORD_REPLACE = /\s*\/\s*|\b(?:and|or)\b/gi;

// Short compact labels/tags this is meant for ("Two-Handed, Versatile",
// "Bludgeoning, Piercing, and Slashing") run well under this; genuine
// prose sentences in item/spell descriptions run well past it — a second,
// content-shape-based safety net alongside the container exclusions
// below, in case some as-yet-unknown short label elsewhere on the sheet
// isn't covered by that list.
const CONNECTOR_MAX_LENGTH = 100;

// Prose/freeform containers where "and"/"or" are grammatically load-
// bearing — never touch these regardless of length. .editor covers the
// Biography tab's rich-text field; .item-summary is dnd5e's own expanded
// item/spell description partial (inventory.hbs's "dnd5e.item-summary").
// .separator is dnd5e's own convention (used system-wide — HP/HD bars,
// Uses fractions, weapon short/long range, encumbrance, etc.) for a "/"
// that's a genuine value/max or short/long DATA separator, never a
// grammatical connector — critical to exclude, since replacing that "/"
// with a space wouldn't just look different, it'd change what the number
// means (e.g. "150/600 ft" -> "150 600 ft" reads as one wrong value).
const CONNECTOR_EXCLUDE_SELECTOR =
  ".editor, .item-summary, .separator, input, textarea, select, script, style";

/**
 * Replaces "and"/"or"/"/" with a single space anywhere in the sheet's
 * short compact text (item property tags, subtitle badges, resistance/
 * condition lists, etc.) to keep those visually tighter — deliberately
 * NOT applied to prose (item descriptions, the Biography editor), which
 * needs those words grammatically. Naturally idempotent: re-running this
 * against already-processed text (e.g. via _refreshActorSheet, which
 * doesn't trigger a fresh dnd5e render) is a no-op, since there's nothing
 * left to replace — unlike this file's DOM-restructuring helpers, no
 * explicit "already ran" guard is needed for a plain text substitution.
 */
function stripConnectorWords(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      if (!text || !CONNECTOR_WORD_CHECK.test(text)) return NodeFilter.FILTER_REJECT;
      if (text.length > CONNECTOR_MAX_LENGTH) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(CONNECTOR_EXCLUDE_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  nodes.forEach(n => { n.nodeValue = n.nodeValue.replace(CONNECTOR_WORD_REPLACE, " "); });
}

/**
 * Replaces the shape/type WORD in the items list's Target column with one
 * of target-icons.js's small SVGs, stamping whatever leading text dnd5e's
 * own label carried ("5 ft" -> "5", "Any", "Each", a bare count, or
 * nothing at all for "Self") on top of the icon (armor-weight-class.css
 * layers them via position:absolute) — saves the horizontal space the
 * spelled-out name was taking.
 *
 * Two label families, checked in order:
 *  - Area shapes ("5 ft sphere", "1 ft cube") — TARGET_SHAPE_PATTERN.
 *  - Individual target types ("Self", "Any", "3 creatures", "Each ally")
 *    — INDIVIDUAL_TARGET_PATTERNS, dnd5e's affects.labels.sheet text.
 * Both read the already-rendered label text (.item-target .condensed,
 * inventory/columns/target.hbs) rather than tracing back through each
 * row's item/activity documents — dnd5e's own TargetField.prepareData
 * (dnd5e.mjs) always ends the label with the exact lowercase config key
 * ("... sphere", "... creature", etc, see en.json's DND5E.TARGET.Type.*
 * strings), so matching the trailing word(s) is a reliable, much simpler
 * way to recover the type than resolving which Activity a row belongs to.
 *
 * Guards against re-processing its own output: an already-iconified span
 * carries .awc-target-iconified, and dnd5e regenerates .item-target fresh
 * from the template every render anyway (same reasoning as
 * stripFavoritesAttackText above), so this guard is mostly about not
 * double-running within a single render pass, not about surviving across
 * renders.
 */
function iconifyTargetColumn(el) {
  el.querySelectorAll(".item-target .condensed:not(.awc-target-iconified)").forEach(node => {
    const text = node.textContent.trim();

    const areaMatch = text.match(TARGET_SHAPE_PATTERN);
    if (areaMatch) {
      const [, leading, shape] = areaMatch;
      const svg = buildTargetShapeSVG(shape.toLowerCase());
      if (svg) applyTargetIcon(node, text, svg, stripTargetUnit(leading));
      return;
    }

    for (const { type, re } of INDIVIDUAL_TARGET_PATTERNS) {
      const match = text.match(re);
      if (!match) continue;
      const svg = buildIndividualTargetSVG(type);
      if (svg) applyTargetIcon(node, text, svg, match[1] ?? "");
      return;
    }
  });
}

/** Shared by both label families above — swaps node's text for the icon SVG plus an overlaid text span (empty for bare labels like "Self"/"Any"). */
function applyTargetIcon(node, fullText, svg, overlayText) {
  node.classList.add("awc-target-iconified");
  node.dataset.tooltip = fullText;
  node.textContent = "";
  node.insertAdjacentHTML("beforeend", svg);

  if (!overlayText) return;
  const label = document.createElement("span");
  label.className = "awc-target-number";
  label.textContent = overlayText;
  node.appendChild(label);
}

/**
 * "5 ft" -> "5", "2 × 5 ft" -> "2 × 5" — drops the trailing unit word
 * (whatever it is, not just "ft") by popping the last whitespace-
 * separated token when it isn't itself a bare number, rather than
 * matching "ft" literally (movementUnits has several: ft/mi/m/km/...).
 */
function stripTargetUnit(leading) {
  const parts = leading.trim().split(/\s+/);
  if (parts.length > 1 && !/^\d+(\.\d+)?$/.test(parts[parts.length - 1])) parts.pop();
  return parts.join(" ");
}

/**
 * Displays the spell school icon (native <dnd5e-icon>, .item-school
 * column, inventory/columns/school.hbs) behind the Time column's text
 * instead of in its own dedicated column (now hidden entirely,
 * armor-weight-class.css) — same icon-behind-number overlay pattern as
 * iconifyTargetColumn above.
 *
 * .item-school only ever renders on the item's OWN top-level row (school
 * is a property of the whole spell, not per-activity — school.hbs gates
 * on isItem) while .item-time renders on that row AND every activity
 * sub-row nested inside it (activity.hbs rows sit inside the same
 * li.item[data-item-id], per inventory.hbs's item-description/wrapper/
 * activities structure) — so the icon is CLONED into every matching Time
 * cell within the same item's subtree rather than moved once, since a
 * single DOM node can't occupy multiple Time cells at once.
 *
 * The clone needs its own --icon-fill/--icon-size — dnd5e-icon's shadow-
 * rendered <svg> reads those as inherited custom properties from an
 * ancestor (native gold/18px comes from .item-school itself, dnd5e.css:
 * 12958-12962), which the clone loses once it's no longer inside
 * .item-school.
 */
function overlaySchoolIconOnTime(el) {
  el.querySelectorAll("li.item[data-item-id]").forEach(itemEl => {
    const schoolIcon = itemEl.querySelector(":scope .item-school dnd5e-icon");
    if (!schoolIcon) return;

    itemEl.querySelectorAll(":scope .item-time .condensed:not(.awc-school-iconified)").forEach(node => {
      const text = node.textContent;
      node.classList.add("awc-school-iconified");
      node.textContent = "";

      const iconWrap = document.createElement("span");
      iconWrap.className = "awc-school-icon-wrap";
      iconWrap.appendChild(schoolIcon.cloneNode(true));
      node.appendChild(iconWrap);

      const textSpan = document.createElement("span");
      textSpan.className = "awc-school-time-text";
      textSpan.textContent = text;
      node.appendChild(textSpan);
    });
  });
}

/**
 * Spells tab only. Uses (.item-uses, inventory/columns/uses.hbs) and the
 * Prepared toggle (a data-action="prepare" button inside .item-controls,
 * NOT its own column — dnd5e.mjs builds ctx.preparation for
 * inventory/columns/controls.hbs to render, alongside attune/equip/
 * expand/context-menu) are usually mutually exclusive per the user
 * (a spell that can be prepared/unprepared doesn't typically also have
 * limited uses), so the whole Uses column is hidden outright
 * (armor-weight-class.css) on this tab. For the cases where a spell DOES
 * have both, the Uses fraction is moved (not rebuilt — keeps the live
 * input's data-name binding intact, same reasoning as
 * relocateInventoryCurrency below) into a new wrapper stacked above the
 * prepare button, so it's still visible even with the column gone.
 *
 * Idempotency: marks the drained .item-uses with .awc-uses-merged rather
 * than relying on it having become empty (moving zero child nodes on a
 * second pass would be harmless, but re-wrapping an ALREADY-wrapped
 * prepareBtn via replaceWith would nest .awc-prepared-cell inside itself
 * every time this runs against the same stale DOM — e.g. via
 * _refreshActorSheet's equip/unequip path, which doesn't trigger a
 * genuine dnd5e re-render that would otherwise hand back fresh nodes).
 */
function mergeUsesIntoPrepared(el) {
  el.querySelectorAll('.tab[data-tab="spells"] li.item[data-item-id]').forEach(itemEl => {
    const row = itemEl.querySelector(":scope > .item-row");
    if (!row) return;

    const prepareBtn = row.querySelector('.item-controls [data-action="prepare"]');
    const usesEl = row.querySelector(".item-uses:not(.empty):not(.awc-uses-merged)");
    if (!prepareBtn || !usesEl) return;

    usesEl.classList.add("awc-uses-merged");

    const usesFrag = document.createElement("span");
    usesFrag.className = "awc-prepared-uses";
    Array.from(usesEl.childNodes).forEach(node => usesFrag.appendChild(node));

    const wrap = document.createElement("span");
    wrap.className = "awc-prepared-cell";
    prepareBtn.replaceWith(wrap);
    wrap.append(usesFrag, prepareBtn);
  });
}

/**
 * Moves the Inventory tab's native currency row (section.currency — PP/GP/
 * EP/SP/CP + the Manage Currency button, inventory.hbs) out of
 * .inventory-element and into .top .containers' spot — a native "equipped
 * containers" icon strip (dnd5e.css:7822, flex:1) that sits empty/dead on
 * this module's sheets since the Paper Doll already handles bag/pouch
 * equipping. .containers itself is hidden rather than removed, matching
 * hideNativeLozenges' pattern of hiding rather than destroying native
 * elements this module supersedes.
 *
 * Moves the EXISTING .currency DOM node (not a rebuilt copy) so its
 * already-wired InventoryElement#connectedCallback listeners (dnd5e.mjs:
 * 64341-64387 — input change handlers, the manage-currency click handler)
 * and live <input name="system.currency.*"> bindings stay intact. Safe to
 * rerun every render: InventoryElement doesn't regenerate its own
 * innerHTML independently, dnd5e's normal outer sheet re-render does, so
 * .currency reappears fresh in its native spot on every relevant re-render
 * and needs re-moving each time — same pattern as every other injectXXX
 * helper in this file.
 */
function relocateInventoryCurrency(el) {
  const top = el.querySelector('.tab[data-tab="inventory"] .top');
  const containers = top?.querySelector(".containers");
  const currency = el.querySelector('.tab[data-tab="inventory"] section.currency');
  if (!top || !containers || !currency) return;

  containers.style.display = "none";
  top.appendChild(currency);
}

/**
 * Moves the Inventory tab's search bar (item-list-controls) and
 * attunement box (.attunement) — normally .middle's two children, in
 * their own row below .top — up into .top itself once the sidebar is in
 * Half mode, stacked into a new wrapper appended after .currency.
 * Reclaims the empty space .currency leaves behind once it stops
 * stretching to fill .top (armor-weight-class.css's Half-mode currency
 * rules).
 *
 * A CSS-only position:absolute version of this (tried first) had to guess
 * .currency's own rendered width to avoid overlapping it, and got that
 * guess wrong — confirmed live, the search bar visually covered part of
 * the currency row. Making these genuine flex children of .top instead
 * means flexbox's own shrink behavior keeps them clear of .currency
 * automatically, for any actual width, with no guessing involved.
 *
 * Reversible: moves everything back into .middle, in original order, once
 * NOT in Half mode — same idempotent-move pattern as
 * relocateToolsUnderSaves below (checking "is it already where it should
 * be" via .appendChild's no-op-if-already-there behavior, not a separate
 * has-this-already-run flag).
 */
function relocateSearchAndAttunement(el) {
  const sheetRoot = el.closest(".sheet.actor.character") ?? el;
  // Same relocated position/behavior in fully-Collapsed as Half — both
  // narrow the sidebar enough that .currency stops stretching (armor-
  // weight-class.css), leaving the same reclaimable space either way.
  const half = sheetRoot.classList.contains("awc-sidebar-half") || sheetRoot.classList.contains("sidebar-collapsed");

  const top = el.querySelector('.tab[data-tab="inventory"] .top');
  const middle = el.querySelector('.tab[data-tab="inventory"] .middle');
  // Searched across the whole tab, not just .middle — once relocated,
  // these live inside .top's wrapper instead, and a lookup scoped to
  // .middle would find nothing there and bail before ever moving them
  // back. Confirmed live: that's exactly what left search/attunement
  // stuck in their Half-mode DOM position even after switching back to
  // Full, since the move-back branch below never got a chance to run.
  const search = el.querySelector('.tab[data-tab="inventory"] item-list-controls');
  const attunement = el.querySelector('.tab[data-tab="inventory"] .attunement');
  if (!top || !middle || !search) return;

  if (half) {
    let wrapper = top.querySelector(":scope > .awc-inventory-search-attunement");
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.className = "awc-inventory-search-attunement";
      top.appendChild(wrapper);
    }
    wrapper.appendChild(search);
    if (attunement) wrapper.appendChild(attunement);
  } else {
    const wrapper = top.querySelector(":scope > .awc-inventory-search-attunement");
    if (wrapper) {
      middle.appendChild(search);
      if (attunement) middle.appendChild(attunement);
      wrapper.remove();
    }
  }
}

/**
 * Relocates Tools (currently under Skills in .col-2 .left) to render
 * under Saving Throws (.col-2 .right, right after the .top wrapper that
 * holds Saves + the class/race/background pill card) once the sidebar
 * is collapsed — freed width otherwise just stretches both columns
 * uniformly, still leaving .right comparatively short next to a taller
 * Skills+Tools .left column.
 *
 * Gated on the sheet root's own sidebar-collapsed class (toggled by
 * dnd5e's native _toggleSidebar, dnd5e.mjs) rather than a live width
 * measurement — Foundry keeps every tab's DOM present at once (only the
 * active one is visible), so .col-2's getBoundingClientRect() would
 * read zero/wrong on a currently-hidden tab. A class check works
 * correctly regardless of which tab happens to be active when this
 * runs. Cross-container CSS (order, grid-area) can't move an element
 * between .left and .right's separate flex contexts on its own, so this
 * has to be a real DOM move, not a CSS-only toggle — safe to rerun
 * every render since it just checks "is Tools already where it should
 * be" implicitly via .after() being a no-op when already in position.
 */
function relocateToolsUnderSaves(el) {
  const sheetRoot = el.closest(".sheet.actor.character") ?? el;
  const collapsed = sheetRoot.classList.contains("sidebar-collapsed");

  // .col-2 is a class on the SAME element as .tab[data-tab="details"]
  // (confirmed via DevTools: <section class="tab col-2" data-tab=
  // "details">), not a separate nested wrapper — no space between the
  // attribute selector and .col-2.
  const tools = el.querySelector('.tab[data-tab="details"].col-2 .left filigree-box.tools');
  if (!tools) return;

  if (collapsed) {
    const savesTop = el.querySelector('.tab[data-tab="details"].col-2 .right .top');
    if (savesTop) savesTop.after(tools);
  } else {
    const skills = el.querySelector('.tab[data-tab="details"].col-2 .left filigree-box.skills');
    if (skills) skills.after(tools);
  }
}

/**
 * Effects tab, Half/Collapsed only — zero change in Full. The Conditions
 * card doesn't live inside the same .items-list.effects-list <section>
 * as the other effect-type category cards (active-effects.hbs renders it
 * in its own separate, trailing <section class="items-list"> instead,
 * only present when hasConditions) — entirely outside reflowItemsList's
 * reach (that call is scoped to .items-list.effects-list specifically).
 *
 * Moved into that same <section> in Half/Collapsed (tagged data-effect-
 * type="awc-conditions" — it has no native effect-type of its own) so it
 * becomes one more section reflowItemsList/packIntoColumns (column-
 * reflow.js) can pack, pinned to column 2 there per an explicit request.
 * Moved back to its native wrapper <section> in Full — this needs to be
 * genuinely reversible (not one-way), since dnd5e's own _toggleSidebar
 * never calls render() (wireSidebarCollapseReflow below re-runs this on
 * click for exactly that reason), so a real render regenerating fresh,
 * unmoved markup isn't guaranteed to happen between states.
 *
 * Both the effects-list <section> and the conditions card are looked up
 * fresh via their OWN direct selectors every call — not via each other's
 * current DOM position — specifically so this stays correct regardless
 * of which state it was last left in. :has(.conditions-list) identifies
 * the conditions card directly (by what's actually inside it) rather
 * than by the wrapping <section>'s class NOT being .effects-list, which
 * turned out not to reliably resolve to the right element last attempt.
 * appendChild is a no-op when the section is already where it needs to
 * be, so this is safe/idempotent to call on every render regardless of
 * whether anything actually needs to move.
 */
function relocateConditionsIntoEffectsList(el) {
  const sheetRoot = el.closest(".sheet.actor.character") ?? el;
  const half = sheetRoot.classList.contains("awc-sidebar-half") || sheetRoot.classList.contains("sidebar-collapsed");

  const effectsList = el.querySelector('.tab[data-tab="effects"] .items-list.effects-list');
  const originalWrapper = el.querySelector('.tab[data-tab="effects"] .items-list:not(.effects-list)');
  const conditionsSection = el.querySelector('.tab[data-tab="effects"] .items-section:has(.conditions-list)');
  if (!effectsList || !originalWrapper || !conditionsSection) return;

  if (half) {
    conditionsSection.dataset.effectType = "awc-conditions";
    effectsList.appendChild(conditionsSection);
  } else {
    conditionsSection.removeAttribute("data-effect-type");
    originalWrapper.appendChild(conditionsSection);
  }
}

/**
 * dnd5e's own _toggleSidebar (dnd5e.mjs) only toggles the
 * sidebar-collapsed class directly — it never calls render(), so
 * nothing in this file's normal per-render pipeline (including
 * relocateToolsUnderSaves/relocateSearchAndAttunement above) re-runs when
 * the user actually clicks the collapse button. Wires a dedicated
 * listener on .sidebar-collapser itself so both relocate immediately on
 * click rather than waiting on some unrelated future re-render.
 * requestAnimationFrame defers past Foundry's own action-delegated
 * handler for this same click, so the class has definitely already been
 * toggled by the time this re-checks it. Freshly re-wired every render
 * since .sidebar-collapser itself is regenerated from the template each
 * time — no stale-listener risk.
 */
function wireSidebarCollapseReflow(el) {
  const collapser = el.querySelector(".sidebar-collapser");
  if (!collapser) return;
  collapser.addEventListener("click", () => {
    requestAnimationFrame(() => {
      relocateToolsUnderSaves(el);
      relocateSearchAndAttunement(el);
      relocateConditionsIntoEffectsList(el);
      reflowItemsList(el, { listSelector: '.tab[data-tab="effects"] .items-list.effects-list' });
    });
  });
}

/**
 * The step-up button for the two-step collapse (hooks.js's patched
 * _toggleSidebar handles the step-down direction: Full -> Half -> Collapsed,
 * plus repurposing .sidebar-collapser into a pop-out-and-hide button once
 * Collapsed). This button always steps back exactly one tier — Collapsed ->
 * Half, or Half -> Full — never jumping straight to Full. Visibility (hidden
 * in Full, shown in Half/Collapsed) is CSS-driven off the same
 * awc-sidebar-half/sidebar-collapsed classes on the sheet root, not
 * inline-styled here.
 *
 * Deliberately does NOT call the patched _toggleSidebar to step up — that
 * method treats any explicit argument as a "force" call bypassing the
 * half-state cycle entirely (so unrelated force-calls, like dnd5e restoring
 * persisted state on render, don't accidentally trigger it), which would
 * jump straight to Full instead of landing on Half. Manipulates the classes
 * directly instead, mirroring only the one piece of native behavior that
 * matters here — persisting the collapsed flag — so a reload doesn't
 * restore to fully collapsed after stepping up out of it.
 */
function injectSidebarUncollapseButton(el, actor, app) {
  el.querySelector(".awc-sidebar-uncollapse")?.remove();

  const collapser = el.querySelector(".sidebar-collapser");
  if (!collapser) return;
  if (!(actor?.hasPlayerOwner || !game.settings.get(MODULE_ID, "dollPlayerOwnedOnly"))) return;

  // .sidebar-collapser is regenerated fresh from dnd5e's own template on
  // every render (a new DOM node, not the one JS previously hid), so the
  // hidden state from a prior "open the pop-out" click doesn't survive an
  // unrelated re-render on its own — re-check and re-apply it here every
  // time, reusing the same open-instance lookup the header toggle button
  // (hooks.js) already uses, rather than a separately-tracked boolean that
  // could drift out of sync with the pop-out actually being open.
  const sheetRoot = el.closest(".sheet.actor.character") ?? el;
  const collapsed = sheetRoot.classList.contains("sidebar-collapsed");

  // Same staleness problem as the display:none above, for the icon: that
  // fresh template regeneration uses dnd5e's OWN native logic for this
  // icon (a plain caret-left/caret-right toggle), which has no idea about
  // the repurposed "open the pop-out" meaning this module gives it once
  // fully collapsed — it doesn't know to render fa-person. Any genuine
  // render that happens while already collapsed (not just the click that
  // got it there) silently resets the icon back to native's caret,
  // confirmed live: functionally still correct (click behavior is driven
  // by the sidebar-collapsed class, not by what icon happens to be
  // showing) but visibly wrong. Recomputed unconditionally here — this
  // runs on every render, not just the two click handlers that used to be
  // the only place this got set — so a stray native render can't leave
  // it stuck on the wrong icon anymore.
  const icon = collapser.querySelector("i");
  if (icon) {
    icon.classList.remove("fa-caret-left", "fa-caret-right", "fa-person");
    icon.classList.add(collapsed ? "fa-person" : "fa-caret-left");
  }
  collapser.dataset.tooltip = collapsed ? "AWC.App.PaperDoll.Title" : "JOURNAL.ViewCollapse";
  collapser.setAttribute("aria-label", game.i18n.localize(collapsed ? "AWC.App.PaperDoll.Title" : "JOURNAL.ViewCollapse"));

  if (collapsed) {
    import("./apps/paper-doll-app.js").then(({ AWCPaperDoll }) => {
      const open = [...foundry.applications.instances.values()].some(w => w instanceof AWCPaperDoll && w.actor === actor);
      if (open) {
        collapser.style.display = "none";
      }
    });
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "awc-sidebar-uncollapse unbutton always-interactive";
  btn.dataset.tooltip = "JOURNAL.ViewExpand";
  btn.setAttribute("aria-label", game.i18n.localize("JOURNAL.ViewExpand"));
  btn.innerHTML = `<i class="fas fa-caret-right" inert></i>`;

  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    const sheetRoot = el.closest(".sheet.actor.character") ?? el;

    if (sheetRoot.classList.contains("sidebar-collapsed")) {
      // Collapsed -> Half
      sheetRoot.classList.remove("sidebar-collapsed");
      sheetRoot.classList.add("awc-sidebar-half");
      if (app?._sidebarCollapsedKeyPath) {
        await game.user.setFlag("dnd5e", app._sidebarCollapsedKeyPath, false);
      }
      // .sidebar-collapser may still be hidden (from the pop-out-open click)
      // or showing the pop-out icon/tooltip — restore both to normal.
      collapser.style.display = "";
      const icon = collapser.querySelector("i");
      if (icon) {
        icon.classList.remove("fa-person");
        icon.classList.add("fa-caret-left");
      }
      collapser.dataset.tooltip = "JOURNAL.ViewCollapse";
      collapser.setAttribute("aria-label", game.i18n.localize("JOURNAL.ViewCollapse"));
    } else {
      // Half -> Full
      sheetRoot.classList.remove("awc-sidebar-half");
    }

    // Same reason wireSidebarCollapseReflow re-runs these on
    // .sidebar-collapser's own click: neither state change here calls
    // render(), so nothing in the normal per-render pipeline re-runs on
    // its own. Missing this is exactly what left the search bar stuck in
    // its Half-mode-relocated (or native) DOM position after stepping up
    // through THIS button specifically — .sidebar-collapser's click
    // handles the Full<->Half step directly, but Collapsed->Half only
    // ever goes through this one.
    requestAnimationFrame(() => {
      relocateToolsUnderSaves(el);
      relocateSearchAndAttunement(el);
      relocateConditionsIntoEffectsList(el);
      reflowItemsList(el, { listSelector: '.tab[data-tab="effects"] .items-list.effects-list' });
    });
  });

  collapser.insertAdjacentElement("afterend", btn);
}

// ─── HP/HD Fraction Alignment ───────────────────────────────────────────────

/**
 * Measures HP's and HD's value/max fraction ("32/32", "3/3") against
 * .death-tray's actual rendered center — always horizontally centered on
 * the sidebar card, confirmed live — and writes the pixel difference to
 * each fraction's own --awc-fraction-shift custom property, applied by a
 * translateX in paper-doll.css. Empirical rather than predicted: two
 * separate CSS-only attempts to compensate for HP's fraction sitting in a
 * narrower box than HD's (.progress.hit-points is narrower than the full
 * bar by .tmp's width, a flex sibling) both checked out algebraically but
 * didn't land correctly live, so this measures the actual rendered result
 * instead of re-deriving it from the box model a third time.
 *
 * Resets both fractions' shift to 0 before measuring — otherwise a
 * previous call's correction would still be applied while measuring the
 * "current" position, understating the delta needed and only converging
 * to the right value gradually (or not at all) across repeated calls
 * instead of landing correctly on this one.
 */
function alignHpHdFractionsToDeathTray(el) {
  const card = el.querySelector(".sheet-body .sidebar .card");
  const deathTray = card?.querySelector(":scope > .death-tray");
  const hpLabel = card?.querySelector(".meter-group .progress.hit-points > .label");
  const hdLabel = card?.querySelector(".meter-group .meter.hit-dice.progress > .label");
  if (!card || !deathTray || !hpLabel || !hdLabel) return;

  for (const label of [hpLabel, hdLabel]) label.style.setProperty("--awc-fraction-shift", "0px");

  const trayRect = deathTray.getBoundingClientRect();
  const targetCenter = trayRect.left + trayRect.width / 2;

  for (const label of [hpLabel, hdLabel]) {
    const rect = label.getBoundingClientRect();
    const shift = targetCenter - (rect.left + rect.width / 2);
    label.style.setProperty("--awc-fraction-shift", `${shift}px`);
  }
}

/**
 * Runs the alignment once immediately (so it's correct on first paint,
 * not just after the observer's first async callback) and wires a
 * ResizeObserver on .card to re-run it whenever the card's rendered width
 * changes — sidebar mode toggling (Full/Half/Collapsed, which doesn't
 * call render()) and plain window resizing both change the bar widths
 * this depends on. Safe to call every render: Foundry rebuilds the sheet
 * DOM fresh each render, so the old .card (and any observer still
 * attached to it) is simply discarded, not accumulated.
 */
function wireHpHdFractionAlignment(el) {
  const card = el.querySelector(".sheet-body .sidebar .card");
  if (!card) return;

  alignHpHdFractionsToDeathTray(el);

  const observer = new ResizeObserver(() => alignHpHdFractionsToDeathTray(el));
  observer.observe(card);
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
  //
  // In the Half sidebar state (paper-doll.css's .awc-sidebar-half) this
  // element is hidden entirely via display:none — the doll's own capacity
  // bar shows the same calculated AC total there instead (doll-embed.js's
  // buildCapacityBarHTML). Everything below still runs and still wires
  // this element's hover listeners every render regardless of state;
  // display:none is sufficient on its own to remove it from layout, hit-
  // testing, and focus, so there's no separate half-mode branch needed
  // here — a hidden element's listeners are simply never triggered.
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
