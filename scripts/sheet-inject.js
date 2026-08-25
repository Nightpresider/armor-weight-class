/**
 * sheet-inject.js
 * Builds and injects all character-sheet UI elements.
 *
 * Vanilla DOM throughout for Foundry v14 (ApplicationV2) compatibility.
 * In v14 render hooks, html is an HTMLElement; in v12 it's jQuery. Both
 * normalised to HTMLElement at the entry point.
 *
 * Organized to match how the character sheet itself is structured:
 * overall/sheet-wide functions first, then each tab in dnd5e's own tab
 * order (CharacterActorSheet.TABS, dnd5e.mjs) — Details, Inventory,
 * Features, Spells, Effects. injectCharacterSheetUI's own call sequence
 * follows the same order.
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
  // app.document is an Item when this fires for an item sheet (shared hook
  // name) — app.actor may still be a character then, so actor.type alone
  // isn't sufficient.
  if (app.document instanceof Item || app.item) return;

  const el = root(html);
  const actor = app.actor ?? app.document;

  console.debug(`${LOG} injectCharacterSheetUI — actor: ${actor?.name}`);

  if (!el) {
    console.warn(`${LOG} html element is null/undefined — cannot inject`);
    return;
  }

  el.querySelector(".awc-calc-bar")?.remove();
  el.querySelector(".awc-ac-breakdown")?.remove();

  const ac = getACBreakdown(actor);

  // ─── Overall / sheet-wide / sidebar ───
  mergeHeaderIntoTitleBar(el, actor);
  hideNativeLozenges(el);
  stripFavoritesAttackText(el);
  try { stripConnectorWords(el); } catch (err) { console.error(`${LOG} stripConnectorWords failed`, err); }
  try { wireSidebarCollapseReflow(el); } catch (err) { console.error(`${LOG} wireSidebarCollapseReflow failed`, err); }
  try { injectSidebarUncollapseButton(el, actor, app); } catch (err) { console.error(`${LOG} injectSidebarUncollapseButton failed`, err); }
  try { wireHpHdFractionAlignment(el); } catch (err) { console.error(`${LOG} wireHpHdFractionAlignment failed`, err); }
  if (game.settings.get(MODULE_ID, "showACBreakdown") && ac) {
    injectACBreakdown(el, ac);
  }
  hideDollManagedItems(el, actor);
  wireDollDropUnequip(el, actor);

  // ─── Details tab ───
  injectSkillsProficiency(el, actor);
  injectMovementPillsGroup(el, actor);

  // ─── Inventory tab ───
  relocateInventoryCurrency(el);
  try { reflowItemsList(el, { listSelector: '.tab[data-tab="inventory"] .items-list' }); }
  catch (err) { console.error(`${LOG} reflowItemsList (inventory) failed`, err); }

  // ─── Features tab ───
  try { reflowItemsList(el, { listSelector: '.tab[data-tab="features"] .items-list' }); }
  catch (err) { console.error(`${LOG} reflowItemsList (features) failed`, err); }

  // ─── Spells tab ───
  try { iconifyTargetColumn(el); } catch (err) { console.error(`${LOG} iconifyTargetColumn failed`, err); }
  try { overlaySchoolIconOnTime(el); } catch (err) { console.error(`${LOG} overlaySchoolIconOnTime failed`, err); }
  try { mergeUsesIntoPrepared(el); } catch (err) { console.error(`${LOG} mergeUsesIntoPrepared failed`, err); }
  try { reflowItemsList(el, { listSelector: '.tab[data-tab="spells"] .items-list' }); }
  catch (err) { console.error(`${LOG} reflowItemsList (spells) failed`, err); }

  // ─── Sidebar-collapse-state-dependent relocations (Details/Inventory/Effects) ───
  // dnd5e restores a persisted sidebar-collapsed/awc-sidebar-half state via its own
  // force-call path (see hooks.js's _patchSidebarToggle comment) - that class update
  // isn't guaranteed to have landed on `el` yet by the time this render hook fires, so
  // relocateSearchAndAttunement/relocateConditionsIntoEffectsList (both mode-dependent)
  // read it stale if called synchronously here. Deferred a frame, exactly like the
  // click-triggered re-relocation already does elsewhere in this file
  // (wireSidebarCollapseReflow / injectSidebarUncollapseButton's own listeners,
  // same grouping) - by then the restored class is reliably in place.
  // relocateToolsUnderSaves no longer reads sidebar state at all (see its own comment) so
  // it isn't exposed to this race either way - left grouped here anyway, harmless.
  //
  // relocateConditionsIntoEffectsList must still run before the effects-tab reflow -
  // the reflow packs whatever .items-section cards are currently in the DOM, so
  // Conditions needs to already be moved in (Half/Collapsed) for it to be counted.
  requestAnimationFrame(() => {
    try { relocateToolsUnderSaves(el); } catch (err) { console.error(`${LOG} relocateToolsUnderSaves failed`, err); }
    try { relocateSearchAndAttunement(el); } catch (err) { console.error(`${LOG} relocateSearchAndAttunement failed`, err); }
    try { relocateConditionsIntoEffectsList(el); } catch (err) { console.error(`${LOG} relocateConditionsIntoEffectsList failed`, err); }
    try { reflowItemsList(el, { listSelector: '.tab[data-tab="effects"] .items-list.effects-list' }); }
    catch (err) { console.error(`${LOG} reflowItemsList (effects) failed`, err); }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  OVERALL / SHEET-WIDE / SIDEBAR
//  Applies regardless of which tab is active.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Header Embed ─────────────────────────────────────────────────────────

/**
 * Moves .sheet-header (name/class/level-badge/rest-buttons) out of
 * .window-content into Foundry's native .window-header title-bar row, so
 * it shares the line with the window controls instead of sitting below them.
 *
 * Reorders its children into one left-aligned strip — level badge, name,
 * inspiration, class — and relocates rest-buttons to sit with the native
 * window controls on the right.
 *
 * Runs every render: Foundry regenerates .sheet-header fresh in
 * .window-content each time, so a stale relocated copy must be purged
 * first or it piles up alongside the fresh one.
 */
function mergeHeaderIntoTitleBar(el, actor) {
  const windowHeader = el.querySelector(".window-header");
  const windowContent = el.querySelector(".window-content");
  if (!windowHeader || !windowContent) return;

  // Not every render regenerates .sheet-header (some are partial
  // re-renders) — bail if there's no fresh copy rather than purging
  // unconditionally, which would empty the header on those renders.
  const sheetHeader = windowContent.querySelector(".sheet-header");
  if (!sheetHeader) return;

  // Rest-buttons relocate outside .sheet-header (below), so they need
  // their own explicit stale-copy cleanup too.
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
 * Repurposes the level badge to display + roll Initiative (no other room
 * for the actor's level in the compact header). Mirrors dnd5e's native
 * Initiative lozenge exactly — same data-action/data-type, "rollable"
 * class, tooltip.
 *
 * In edit mode it swaps to a config-button gear (matching the native
 * lozenge's own behavior). The outer element keeps data-action="roll"
 * either way — the gear's more specific data-action wins via Foundry's
 * closest-ancestor delegation.
 */
function repurposeLevelBadgeAsInitiative(levelBadge, actor, editable) {
  levelBadge.dataset.action = "roll";
  levelBadge.dataset.type = "initiative";
  levelBadge.dataset.tooltip = "DND5E.Initiative";
  levelBadge.setAttribute("aria-label", game.i18n.localize("DND5E.Initiative"));
  // Living inside .window-header inherits that region's grab cursor
  // (window-drag handle) rather than .rollable's pointer — inline style
  // wins unconditionally, no specificity fight needed.
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

/**
 * Hides dnd5e's native Initiative/Speed/Proficiency lozenges row — AWC
 * replaces all three (level-badge, Movement pills-group, Skills header).
 * Re-applied every render since dnd5e regenerates .stats fresh each time.
 */
function hideNativeLozenges(el) {
  const lozenges = el.querySelector(".stats .lozenges");
  if (lozenges) lozenges.style.display = "none";
}

/**
 * Drops the word "Attack" from Favorites subtitle text ("Ranged Weapon
 * Attack" -> "Ranged Weapon"). subtitle renders via {{{ }}} (raw), so
 * this operates on innerHTML — a plain word match won't disturb embedded
 * markup. Safe every render: dnd5e regenerates .favorites fresh each time.
 */
function stripFavoritesAttackText(el) {
  el.querySelectorAll(".favorites > ul .name-stacked .subtitle").forEach(node => {
    node.innerHTML = node.innerHTML.replace(/\s*\bAttack\b\s*/g, " ").trim();
  });
}

// Word-boundary matched — bare "and"/"or" would also hit "Wand", "Armor",
// "Corridor", etc. Two separate regex objects since a shared /g's lastIndex
// is stateful across .test()/.replace() calls, a known skipped-match bug.
const CONNECTOR_WORD_CHECK = /\s*\/\s*|\b(?:and|or)\b/i;
const CONNECTOR_WORD_REPLACE = /\s*\/\s*|\b(?:and|or)\b/gi;

// Safety net alongside the container exclusions below, in case a short
// label elsewhere isn't covered by that list.
const CONNECTOR_MAX_LENGTH = 100;

// Prose containers where "and"/"or" are grammatically load-bearing, never
// touched. .separator is dnd5e's own value/max "/" (e.g. "150/600 ft") —
// critical to exclude, since stripping it changes what the number means.
const CONNECTOR_EXCLUDE_SELECTOR =
  ".editor, .item-summary, .separator, input, textarea, select, script, style";

/**
 * Replaces "and"/"or"/"/" with a single space in the sheet's short
 * compact text (item property tags, subtitle badges, resistance/
 * condition lists) to keep those visually tighter — never applied to
 * prose (item descriptions, the Biography editor). Naturally idempotent:
 * re-running against already-processed text is a no-op.
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

// ─── Sidebar collapse / step-up ─────────────────────────────────────────────

/**
 * dnd5e's own _toggleSidebar only toggles the sidebar-collapsed class and
 * never calls render(), so nothing re-runs on click otherwise. Wires a
 * listener that re-relocates immediately — requestAnimationFrame defers
 * past Foundry's own handler so the class is already toggled by the time
 * this checks it. Re-wired every render since .sidebar-collapser is
 * regenerated fresh each time.
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
 * Step-up button for the two-step collapse (hooks.js's patched
 * _toggleSidebar handles stepping down: Full -> Half -> Collapsed). Always
 * steps back exactly one tier, never straight to Full. Visibility is
 * CSS-driven off the sidebar-state classes.
 *
 * Manipulates the classes directly rather than calling the patched
 * _toggleSidebar — that function treats any explicit argument as a "force"
 * call bypassing the half-state cycle (used to restore persisted state on
 * render), which would jump straight to Full here instead.
 */
function injectSidebarUncollapseButton(el, actor, app) {
  el.querySelector(".awc-sidebar-uncollapse")?.remove();

  const collapser = el.querySelector(".sidebar-collapser");
  if (!collapser) return;
  if (!(actor?.hasPlayerOwner || !game.settings.get(MODULE_ID, "dollPlayerOwnedOnly"))) return;

  // .sidebar-collapser regenerates fresh every render, so a prior "open
  // the pop-out" click's hidden state doesn't survive on its own —
  // re-checked here every time.
  const sheetRoot = el.closest(".sheet.actor.character") ?? el;
  const collapsed = sheetRoot.classList.contains("sidebar-collapsed");

  // Same staleness issue for the icon: native template regeneration resets
  // it back to dnd5e's own caret, which doesn't know about this module's
  // pop-out meaning — recomputed unconditionally every render.
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
      // .sidebar-collapser may still be hidden or showing the pop-out
      // icon/tooltip from the earlier click — restore both to normal.
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

    // Same reason wireSidebarCollapseReflow re-runs these — neither state
    // change here calls render(). Collapsed->Half only ever goes through
    // this button; .sidebar-collapser's own click handles Full<->Half.
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
 * Measures HP's and HD's value/max fraction against .death-tray's actual
 * rendered center (always centered on the sidebar card), and writes the
 * pixel difference to each fraction's --awc-fraction-shift custom property
 * (applied via translateX in paper-doll.css). Empirical rather than
 * predicted — two CSS-only attempts checked out algebraically but didn't
 * land correctly live.
 *
 * Resets both shifts to 0 before measuring, or a previous call's
 * correction skews the "current" position being measured.
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
 * Runs the alignment once immediately (correct on first paint), then wires
 * a ResizeObserver on .card to re-run it whenever the card's width changes
 * — sidebar mode toggling and window resizing both affect it. Safe every
 * render: Foundry rebuilds the sheet DOM fresh each time, so the old
 * .card/observer pair is simply discarded, not accumulated.
 */
function wireHpHdFractionAlignment(el) {
  const card = el.querySelector(".sheet-body .sidebar .card");
  if (!card) return;

  alignHpHdFractionsToDeathTray(el);

  const observer = new ResizeObserver(() => alignHpHdFractionsToDeathTray(el));
  observer.observe(card);
}

// ─── AC Breakdown ──────────────────────────────────────────────────────────

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

  // .ac-badge is dnd5e v4's actual AC element; the generic patterns after
  // it are fallbacks for v3/other layouts. In Half sidebar state it's
  // display:none (the doll's calc bar shows AC instead) — hover listeners
  // still wire every render regardless, since a hidden element's listeners
  // simply never trigger.
  const acEl = el.querySelector(
    '.ac-badge, [data-prop="system.attributes.ac.value"], [data-field="system.attributes.ac.value"], ' +
    '.ac .value, .attribute.ac, .stat.ac, .defense.ac, [data-stat="ac"]'
  );

  if (!acEl) {
    console.debug(`${LOG} AC breakdown → no AC element found, skipping`);
    return;
  }

  // .ac-badge sits in a tightly-packed row with no room for an inserted
  // visible block — the breakdown becomes a plain-text tooltip directly
  // on the badge instead.
  if (acEl.matches(".ac-badge")) {
    let tooltip = `10 ${acOp(ac.baseMod)} ${Math.abs(ac.baseMod)} (${abilityUsed})`;
    if (ac.itemBonus !== 0) tooltip += ` ${acOp(ac.itemBonus)} ${Math.abs(ac.itemBonus)} (equip)`;
    if (ac.miscBonus !== 0) tooltip += ` ${acOp(ac.miscBonus)} ${Math.abs(ac.miscBonus)} (misc)`;
    tooltip += ` = ${ac.total}`;

    // dnd5e's inner div carries data-attribution="attributes.ac", which its
    // native hover handler uses to fill a tooltip — AWC's AC formula never
    // populates that data, so it'd show a permanent loading spinner unless
    // data-attribution is deleted (the native handler bails without it).
    //
    // Matches either a fresh element (still has data-attribution) or one
    // already processed (.awc-ac-badge-value) — idempotent across calls,
    // so a later patch-path call still finds it instead of falling into
    // the outer-badge fallback and double-firing tooltips.
    const innerAcValue = acEl.querySelector("[data-attribution], .awc-ac-badge-value");
    if (innerAcValue) {
      // Clears whatever the fallback branch below may have wrongly set
      // here during the stale-lookup case described above.
      delete acEl.dataset.tooltip;
      delete acEl.dataset.tooltipDirection;
      delete innerAcValue.dataset.attribution;
      delete innerAcValue.dataset.attributionCaption;
      // dnd5e's _applyTooltips() also leaves data-tooltip-class=
      // "property-attribution" here, which renders as an interactive table
      // that can lock open instead of dismissing — deleting it reverts to
      // a plain data-tooltip element.
      delete innerAcValue.dataset.tooltipClass;
      // Own class so CSS can shrink the hover hit-box to just the number,
      // not the whole 68px badge square.
      innerAcValue.classList.add("awc-ac-badge-value");

      // Never set data-tooltip declaratively here — whether the doll is
      // embedded is decided fresh at HOVER time, not render time. dnd5e
      // regenerates .portrait's native <img> before our async doll embed
      // finishes, so checking at render time finds nothing almost always.
      delete innerAcValue.dataset.tooltip;
      delete innerAcValue.dataset.tooltipDirection;

      // Always refresh the stored text, even when listeners are already
      // wired from an earlier call — keeps the tooltip current after
      // equipment changes without re-wiring anything.
      innerAcValue.dataset.awcAcTooltip = tooltip;

      if (!innerAcValue._awcHoverWired) {
        innerAcValue._awcHoverWired = true;
        innerAcValue.addEventListener("pointerenter", (event) => {
          const text = event.currentTarget.dataset.awcAcTooltip ?? "";
          const panel = el.querySelector(".awc-doll-hover-tooltip");
          if (panel) {
            // Doll is embedded — match its own item-hover tooltips
            // (always centered on the doll) instead of dnd5e's native one.
            panel.innerHTML = text;
            panel.classList.add("active");
          } else {
            // No doll on this sheet — Foundry's own imperative tooltip
            // API, decided fresh at hover time rather than baked in at render.
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
      // Genuine fallback: no inner div and not in edit mode (where its
      // absence is expected) — some other dnd5e layout without one.
      acEl.dataset.tooltip = tooltip;
      acEl.dataset.tooltipDirection = "UP";
    }
    // In edit mode the inner div never renders — dnd5e swaps it for a
    // config-button with its own "DND5E.ArmorConfig" tooltip. Never fall
    // back to the outer .ac-badge there — it would sit directly behind
    // that button, recreating the same overlapping-trigger problem.
    return;
  }

  const container = acEl.closest(".attribute, .form-group, .defense, .stat");
  if (container) {
    el.querySelectorAll(".awc-ac-breakdown").forEach(node => node.remove());
    console.debug(`${LOG} AC breakdown → inserting after AC container`);
    container.insertAdjacentHTML("afterend", breakdownHTML);
  }
}

// ─── Calc Bar (parked) ───────────────────────────────────────────────────────

/**
 * NOT currently called — kept because this markup-building logic
 * (thresholds, indicator position, tooltip) is what doll-embed.js's
 * buildCalcBarHTML reuses. Original design inserted directly into
 * .encumbrance.card, but that meter's fill is a stylesheet ::before with
 * no measurable child element, and its 2-breakpoint design can't
 * represent AWC's 4 brackets anyway.
 */
function injectCalcBar(el, cap) {
  // Clear every previous injection first — this runs on every render, and
  // without it insertAdjacentHTML() keeps stacking a new bar on top.
  el.querySelectorAll(".awc-calc-bar").forEach(bar => bar.remove());

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

  // Clamp at 103% so the indicator stays visible when overburdened.
  const indicatorPct = Math.min(103, Math.max(0, cap.ratio * 100));
  const tooltip = `${cap.equippedWeight} / ${cap.capacity} lbs · ${cap.bracket}`;

  const barHTML = `
    <div class="awc-calc-bar awc-${cap.bracket}" data-tooltip="${tooltip}">
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

  // Fallback for sheet types without .encumbrance.card.
  const inner = el.querySelector(".window-content, .sheet-body, form") ?? el;
  inner.insertAdjacentHTML("afterbegin", barHTML);
}

// ─── Sheet ↔ Doll synchronization ───────────────────────────────────────────

/**
 * True for any item the Paper Doll shows on the actor's doll instead of
 * the inventory list: any resolvable AWC slot sub-type (armor/clothing/
 * jewelry, including ring), or an equipped weapon (hand-slot or Exempt).
 */
function isDollManaged(item) {
  if (!item.system?.equipped) return false;
  if (getItemSlot(item)) return true;
  if (item.type === "weapon") return true;
  return false;
}

/**
 * Hides every inventory row for a currently doll-managed item, and
 * un-hides anything that no longer qualifies. Runs every render so it
 * stays in sync automatically — no separate "restore" step needed.
 *
 * Gated on the hideEquippedFromInventory setting (default on) — when off,
 * the loop still runs every render (so a row hidden from a prior render
 * with the setting on gets un-hidden), it just never applies the class.
 */
function hideDollManagedItems(el, actor) {
  const enabled = game.settings.get(MODULE_ID, "hideEquippedFromInventory");
  for (const row of el.querySelectorAll("[data-item-id]")) {
    const item = actor.items.get(row.dataset.itemId);
    row.classList.toggle("awc-doll-managed-hidden", enabled && !!(item && isDollManaged(item)));
  }
}

/**
 * Recognizes a drag payload from an AWC doll slot (tagged
 * `type: "AWCDollItem"`, set by paper-doll-app.js's dragstart handler)
 * dropped anywhere on the sheet, and unequips the item instead of falling
 * through to Foundry's native item-drop handling (which would try to
 * re-parent/sort an item the actor already owns). Registered on the
 * capture phase so it runs before the sheet's own native drop listener.
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

// ═══════════════════════════════════════════════════════════════════════════
//  DETAILS TAB (data-tab="details")
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Appends "Proficiency: +N" (the character's own proficiency bonus) to
 * the Skills box's heading. Native h3 is flex/justify-content:center, so
 * margin-left:auto on this span claims all remaining space for itself,
 * landing it at the far right regardless of the parent's own centering.
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
// id. A fresh flag/_source read right after AWCMovementDisplayConfig
// saves has been observed to lag behind what was just submitted —
// actor.update() is an async round trip, and a render triggered before it
// lands reads pre-update data. cacheMovementDisplay() is the one write
// path, called by the config's submit handler with the just-saved values.
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
 * Resolves the movement values AWC's UI should display, in priority order:
 *   1. In-memory cache — setFlag()/actor.update() is async, so a render
 *      firing before it lands can read pre-save state; self-heals the
 *      flag if it disagrees with the cache.
 *   2. flags.armor-weight-class.movementDisplay — written by
 *      AWCMovementDisplayConfig's Save action.
 *   3. actor.system._source.attributes.movement — same source dnd5e's own
 *      MovementSensesConfig reads from; correct before the flag is ever
 *      set, and avoids the stale-derived-data issue seen elsewhere in
 *      dnd5e's own dialogs.
 *   4. actor.system.attributes.movement — last-resort fallback.
 * @returns {{movement: object, source: string}}
 */
export function resolveMovementDisplay(actor) {
  const flagValue = actor.getFlag(FLAG_NS, "movementDisplay");
  const sourceMovement = actor.system?._source?.attributes?.movement;
  const cached = _awcLastGoodMovement.get(actor.id);

  if (cached) {
    // Self-heal only on an actual mismatch, or this fires a setFlag() on every render once healed once.
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
 * Builds a "Movement" pills-group on the Details tab, above Senses — one
 * pill per movement type plus a Fly checkbox-state icon mirroring the
 * dialog's Hover checkbox. Reuses the native pills-group markup shape.
 *
 * Data comes from resolveMovementDisplay() above, never directly from
 * dnd5e's derived system.attributes.movement (unreliable — see above).
 * The gear button opens AWCMovementDisplayConfig, display-only.
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

  // Gated on @root.editable (sheet edit mode) same as the native partial —
  // deliberately NOT dnd5e's own data-config="movement" (which would open
  // the real Movement Configuration dialog); opens AWC's own editor instead.
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

  group.querySelector(".awc-movement-config-button")?.addEventListener("click", async () => {
    const { AWCMovementDisplayConfig } = await import("./apps/movement-display-config.js");
    new AWCMovementDisplayConfig(actor).render(true);
  });

  sensesGroup.before(group);
}

/**
 * Relocates Tools (.col-2 .left) to render under Saving Throws (.col-2 .right) in every
 * sidebar mode — Skills' own list is just much taller than Saving Throws regardless of
 * column width, so moving Tools there keeps the shorter Saves column pulling its weight
 * instead of padding out the already-taller Skills column further, cutting how much
 * scrolling the tab needs overall. (Previously gated on sidebar-collapsed on the theory that
 * only a collapsed sidebar frees enough width to matter — but the imbalance being fixed here
 * is height, not width, so that gate excluded Full/Half mode for no real reason. Dropping it
 * also removes this function's own dependency on reading the collapse-state class at all, so
 * it's no longer exposed to that state's own restore-timing race either.)
 *
 * A real DOM move, since CSS can't cross .left/.right's separate flex contexts; safe to
 * rerun every render since .after() no-ops when already in position.
 */
function relocateToolsUnderSaves(el) {
  // .col-2 is a class on the same element as .tab[data-tab="details"],
  // not a separate nested wrapper.
  const tools = el.querySelector('.tab[data-tab="details"].col-2 .left filigree-box.tools');
  if (!tools) return;

  const savesTop = el.querySelector('.tab[data-tab="details"].col-2 .right .top');
  if (savesTop) savesTop.after(tools);
}

// ═══════════════════════════════════════════════════════════════════════════
//  INVENTORY TAB (data-tab="inventory")
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Moves the Inventory tab's currency row into .top .containers' spot — a
 * native "equipped containers" strip that's dead here since the Paper
 * Doll handles bag/pouch equipping. .containers is hidden, not removed
 * (same pattern as hideNativeLozenges).
 *
 * Moves the EXISTING .currency node, not a rebuilt copy, so its wired
 * input listeners stay intact. Safe every render since .currency
 * reappears fresh in its native spot each time.
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
 * Moves the search bar and attunement box (normally .middle's own row
 * below .top) up into .top once the sidebar is Half/Collapsed, stacked
 * in a wrapper after .currency — reclaiming the space .currency leaves
 * once it stops stretching to fill .top (Half-mode CSS).
 *
 * Genuine flex children, not position:absolute — an earlier absolute
 * version had to guess .currency's width and overlapped it; flex lets
 * shrink behavior keep them clear automatically.
 *
 * Reversible: moves back into .middle once not Half/Collapsed, same
 * idempotent pattern as relocateToolsUnderSaves above.
 */
function relocateSearchAndAttunement(el) {
  const sheetRoot = el.closest(".sheet.actor.character") ?? el;
  // Same treatment in fully-Collapsed as Half — both narrow the sidebar
  // enough that .currency stops stretching, leaving the same reclaimable
  // space either way.
  const half = sheetRoot.classList.contains("awc-sidebar-half") || sheetRoot.classList.contains("sidebar-collapsed");

  const top = el.querySelector('.tab[data-tab="inventory"] .top');
  const middle = el.querySelector('.tab[data-tab="inventory"] .middle');
  // Searched across the whole tab, not just .middle — once relocated these
  // live inside .top's wrapper, and a lookup scoped to .middle would find
  // nothing and bail before the move-back branch below ever ran, leaving
  // them stuck in Half-mode position after switching back to Full.
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

// ═══════════════════════════════════════════════════════════════════════════
//  SPELLS TAB (data-tab="spells")
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replaces the shape/type word in the Target column with a small SVG
 * (target-icons.js), stamping any leading text ("5 ft" -> "5", "Any",
 * nothing for "Self") on top of the icon via position:absolute in CSS.
 *
 * Two label families, checked in order:
 *  - Area shapes ("5 ft sphere") — TARGET_SHAPE_PATTERN.
 *  - Individual target types ("Self", "Any", "3 creatures") —
 *    INDIVIDUAL_TARGET_PATTERNS.
 * Both match the already-rendered label text (dnd5e always ends it with
 * the lowercase config key) rather than tracing back to the row's
 * item/activity.
 *
 * Guards re-processing via .awc-target-iconified; dnd5e regenerates
 * .item-target fresh every render anyway.
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
 * "5 ft" -> "5", "2 × 5 ft" -> "2 × 5" — drops the trailing unit word by
 * popping the last whitespace-separated token when it isn't itself a bare
 * number, rather than matching "ft" literally (movementUnits has several).
 */
function stripTargetUnit(leading) {
  const parts = leading.trim().split(/\s+/);
  if (parts.length > 1 && !/^\d+(\.\d+)?$/.test(parts[parts.length - 1])) parts.pop();
  return parts.join(" ");
}

/**
 * Displays the spell school icon behind the Time column's text (now
 * hidden) — same icon-behind-number overlay as iconifyTargetColumn above.
 *
 * .item-school only renders on the item's top-level row, but .item-time
 * also renders on every nested activity sub-row — so the icon is CLONED
 * into every matching Time cell rather than moved once.
 *
 * The clone needs its own --icon-fill/--icon-size: dnd5e-icon's shadow
 * svg inherits those from an ancestor (.item-school itself), lost once
 * the clone leaves it.
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
 * Spells tab only. Uses and the Prepared toggle are usually mutually
 * exclusive, so the whole Uses column is hidden via CSS. For spells with
 * both, the Uses fraction is moved (not rebuilt, keeping its live input
 * binding intact) into a wrapper stacked above the prepare button.
 *
 * Marks the drained .item-uses with .awc-uses-merged for idempotency —
 * without it, re-running against stale DOM would nest .awc-prepared-cell
 * inside itself.
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

// ═══════════════════════════════════════════════════════════════════════════
//  EFFECTS TAB (data-tab="effects")
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Effects tab, Half/Collapsed only. The Conditions card normally lives
 * outside .items-list.effects-list (its own trailing section), entirely
 * outside reflowItemsList's reach.
 *
 * Moved into that shared section in Half/Collapsed (tagged
 * data-effect-type="awc-conditions" so column-reflow.js can pin it to
 * column 2), moved back to its native wrapper in Full. Must be reversible
 * since dnd5e's _toggleSidebar never calls render() —
 * wireSidebarCollapseReflow re-runs this on click for that reason.
 *
 * Both sides are looked up fresh via their own selectors each time, so
 * this stays correct regardless of prior state. :has(.conditions-list)
 * identifies the card by content, not by class exclusion, which didn't
 * reliably resolve. appendChild no-ops when already positioned correctly.
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
