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
import { isHandEligibleContainer } from "./paired-slots.js";
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
  try { injectContainersSection(el, actor, app); } catch (err) { console.error(`${LOG} injectContainersSection failed`, err); }
  try { restyleInventorySubtitles(el, actor); } catch (err) { console.error(`${LOG} restyleInventorySubtitles failed`, err); }
  try { injectActionBadgeColumn(el); } catch (err) { console.error(`${LOG} injectActionBadgeColumn failed`, err); }
  try { styleChargesColumn(el); } catch (err) { console.error(`${LOG} styleChargesColumn failed`, err); }
  try { renameQuantityColumnHeader(el); } catch (err) { console.error(`${LOG} renameQuantityColumnHeader failed`, err); }
  try { wireQuantityKeyboardControls(el); } catch (err) { console.error(`${LOG} wireQuantityKeyboardControls failed`, err); }
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
  // Deferred a frame: dnd5e's persisted sidebar-collapsed/awc-sidebar-half class isn't
  // guaranteed to have landed on `el` yet when this hook fires, so the mode-dependent
  // relocations below would read it stale if called synchronously. Must run before the
  // effects-tab reflow, which packs whatever .items-section cards are currently in the DOM.
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

/**
 * dnd5e's own Inventory row subtitle is "{Item Type} • {Activation}" (e.g. "Weapon • Action",
 * or just "Equipment" with no activation at all) - the type half always restates the section
 * heading the row is already listed under ("Weapons"), so it's redundant and dropped entirely.
 * The activation half becomes a small colored pulsing badge instead of spelling the word out -
 * a green dot for Action, an orange triangle for Bonus Action - far more compact and scannable
 * across a long list. Every row's own item.type drives the type-label match, so this works
 * uniformly across every section without needing to know the section headings themselves.
 *
 * Guarded against re-running on its own output: a re-render that doesn't fully regenerate this
 * row (dnd5e's Handlebars normally would, but a partial update might not) would otherwise feed
 * an already-badged subtitle back through the "Action" regex, which - operating on the raw
 * innerHTML string, not just visible text - matches inside the badge's own data-tooltip="Action"
 * attribute value too, corrupting it into malformed HTML that spills out as garbled visible text.
 */
function restyleInventorySubtitles(el, actor) {
  el.querySelectorAll('.tab[data-tab="inventory"] .items-list [data-item-id]').forEach(row => {
    const subtitle = row.querySelector(".name-stacked .subtitle");
    if (!subtitle || row.dataset.awcSubtitleCleaned) return;
    const item = actor.items.get(row.dataset.itemId);
    if (!item) return;

    let html = subtitle.innerHTML;

    const typeLabel = game.i18n.localize(CONFIG.Item.typeLabels[item.type] ?? "");
    if (typeLabel) {
      const escaped = typeLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      html = html.replace(new RegExp(`^\\s*${escaped}\\s*(?:•\\s*)?`, "i"), "");
    }

    // Detected here (from the raw subtitle text) and recorded on the row for
    // injectActionBadgeColumn() to use - no longer inserted as a badge inline in the subtitle
    // itself, which now just has the activation word stripped out entirely.
    if (/\bBonus Action\b/i.test(html)) row.dataset.awcActivation = "bonus";
    else if (/\bAction\b/i.test(html)) row.dataset.awcActivation = "action";
    html = html.replace(/\s*\bBonus Action\b\s*|\s*\bAction\b\s*/gi, " ");

    html = html.trim().replace(/^•\s*|\s*•$/g, "").trim();
    row.dataset.awcSubtitleCleaned = "true";
    if (!html) subtitle.remove();
    else subtitle.innerHTML = html;
  });
}

/**
 * Gives the Action/Bonus Action indicator (detected from the subtitle text by
 * restyleInventorySubtitles above, which strips it and records it as row.dataset.awcActivation)
 * its own column between Name and Quantity, matching every other Inventory column's own
 * convention (a fixed-width .item-header/.item-detail pair) instead of living inside the
 * name-stacked block. Must run after restyleInventorySubtitles - a row it hasn't cleaned yet
 * has nothing reliable recorded to read.
 */
function injectActionBadgeColumn(el) {
  const CLASS = "item-action-badge";
  const BADGE_HTML = {
    action: '<span class="awc-activation-badge awc-activation-action" data-tooltip="Action"></span>',
    bonus: '<span class="awc-activation-badge awc-activation-bonus" data-tooltip="Bonus Action"></span>',
  };

  el.querySelectorAll('.tab[data-tab="inventory"] .items-header').forEach(header => {
    if (header.querySelector(`.${CLASS}`)) return;
    const anchor = header.querySelector(".item-quantity");
    const cell = document.createElement("div");
    cell.classList.add("item-header", CLASS);
    if (anchor) anchor.before(cell);
    else header.appendChild(cell);
  });

  // Every row gets a cell (empty if no activation was detected, or the row never had a
  // subtitle at all - e.g. AWC's own Containers section rows) so columns stay aligned with
  // the header across every section, the same "empty but present" convention every other
  // Inventory column already uses.
  el.querySelectorAll('.tab[data-tab="inventory"] .items-list [data-item-id]').forEach(row => {
    if (row.querySelector(`.${CLASS}`)) return;
    const quantityCell = row.querySelector(".item-quantity");
    if (!quantityCell) return;

    const cell = document.createElement("div");
    cell.classList.add("item-detail", CLASS);
    cell.innerHTML = BADGE_HTML[row.dataset.awcActivation] ?? "";
    quantityCell.before(cell);
  });
}

/**
 * Hides the Charges/Uses column entirely for a section where none of its items actually have
 * charges (dnd5e still renders an empty placeholder cell in every row otherwise) and, when the
 * column IS shown for a section, swaps its "Charges"/"Uses" text header for a battery-bolt
 * glyph so it reads at a glance instead of needing to be spelled out. Row cells always use the
 * literal class .item-uses regardless of which column ("charges" or "uses") the section is
 * configured with - only the header cell's class reflects that (.item-charges/.item-uses) -
 * so both header variants are checked but only .item-uses is ever checked on rows.
 */
function styleChargesColumn(el) {
  const BATTERY_ICON = `<svg class="awc-charges-icon" viewBox="0 0 100 60" aria-hidden="true">
    <path d="M40 6 L16 6 Q6 6 6 16 L6 26" />
    <path d="M6 34 L6 44 Q6 54 16 54 L40 54" />
    <path d="M60 6 L84 6 Q94 6 94 16 L94 26" />
    <path d="M94 34 L94 44 Q94 54 84 54 L60 54" />
    <path class="awc-charges-bolt" d="M56 4 L34 32 L48 32 L44 56 L66 26 L52 26 Z" />
  </svg>`;

  el.querySelectorAll('.tab[data-tab="inventory"] .items-section').forEach(section => {
    const hasCharges = !!section.querySelector(".item-detail.item-uses:not(.empty)");
    section.classList.toggle("awc-hide-charges", !hasCharges);
    if (!hasCharges) return;

    const header = section.querySelector(".items-header .item-charges, .items-header .item-uses");
    if (header && !header.querySelector(".awc-charges-icon")) header.innerHTML = BATTERY_ICON;
  });
}

/** Renames the native "Quantity" column header to "Qty" across every Inventory section. */
function renameQuantityColumnHeader(el) {
  el.querySelectorAll('.tab[data-tab="inventory"] .items-header .item-quantity').forEach(header => {
    if (header.textContent.trim() !== "Qty") header.textContent = "Qty";
  });
}

/**
 * The Quantity column's +/- buttons are hidden everywhere on the Inventory tab (CSS,
 * .item-quantity .adjustment-button), replaced by Up/Down arrow keys while focused in the
 * number field - Up clicks the (still-functional, just invisible) increase button, Down the
 * decrease one, reusing whatever handler already exists for each rather than reimplementing
 * min-clamping/etc: dnd5e's own native wiring for native rows, this module's own hand-wired
 * listener for the Containers section. Focusing a field also selects its whole value, so any
 * typed digit overwrites it instead of inserting into it.
 *
 * Wired ONCE via event delegation on the sheet root (not per-row/per-render), so the only
 * idempotency concern is not double-attaching this same delegated listener.
 */
function wireQuantityKeyboardControls(el) {
  if (el._awcQuantityKeysWired) return;
  el._awcQuantityKeysWired = true;

  const QTY_SELECTOR = '.tab[data-tab="inventory"] .item-quantity input[data-name="system.quantity"]';

  let justFocused = null;
  el.addEventListener("focusin", event => {
    const input = event.target.closest(QTY_SELECTOR);
    if (!input) return;
    justFocused = input;
    input.select();
  });

  // A mouse click that both focuses the input AND positions the cursor would otherwise
  // collapse the selection .select() just made, on this same interaction's mouseup - skip the
  // browser's own default cursor-placement for that one mouseup so the selection sticks.
  el.addEventListener("mouseup", event => {
    if (justFocused && event.target === justFocused) event.preventDefault();
    justFocused = null;
  });

  el.addEventListener("keydown", event => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const input = event.target.closest(QTY_SELECTOR);
    if (!input) return;
    event.preventDefault();
    const action = event.key === "ArrowUp" ? "increase" : "decrease";
    input.closest(".item-quantity")?.querySelector(`.adjustment-button[data-action="${action}"]`)?.click();
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
 * True for any item the Paper Doll shows somewhere other than the inventory list: any
 * resolvable AWC slot sub-type (armor/clothing/jewelry, including ring), an equipped weapon
 * (hand-slot or Exempt), an equipped hand-eligible Container (Keg/Bobble - same hand-slot
 * system as weapons), or an item currently pocketed in some other equipped item's pockets
 * (revealed via the pocket viewer/picker instead, never equipped in the dnd5e sense at all -
 * see paired-slots.js's pocketItem()).
 */
function isDollManaged(item) {
  if (item.getFlag(FLAG_NS, "pocketedIn")) return true;
  if (!item.system?.equipped) return false;
  if (getItemSlot(item)) return true;
  if (item.type === "weapon") return true;
  if (isHandEligibleContainer(item)) return true;
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
 * scrolling the tab needs overall. Applies in every sidebar mode - the imbalance being fixed is
 * height, not width, so it isn't specific to a collapsed sidebar.
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
 * Moves the Inventory tab's currency row into .top .containers' spot — dnd5e's own tiny
 * icon-strip display for "container" type items (backpacks/pouches/vials with actual
 * Contents/capacity tracking — a wholly separate dnd5e concept from AWC's own equippable
 * backpack/belt/purse slots). Hidden here rather than removed (same pattern as
 * hideNativeLozenges) since injectContainersSection() below replaces its job with a proper
 * list-style section instead of this compact strip.
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

/** A container not currently shown on the doll (see isDollManaged above) — either it has no
 *  AWC slot association at all, or it does but isn't equipped right now. Either way it has
 *  no visible representation elsewhere, so it needs to show up here. */
function isUnmanagedContainer(item) {
  return item.type === "container" && !isDollManaged(item);
}

function itemWeightValue(item) {
  const weight = item.system?.weight;
  if (typeof weight === "number") return weight;
  return weight?.value ?? 0;
}

/**
 * Builds a proper "Containers" section — same items-section/items-header/item-list markup
 * and CSS classes dnd5e's own Equipment/Consumables sections use (read directly from
 * systems/dnd5e/templates/inventory/inventory.hbs), so it's visually identical. Despite
 * carrying the exact same data-action attributes dnd5e's own rendered rows do, none of them
 * are wired "for free": dnd5e's <dnd5e-inventory> custom element attaches its click listeners
 * with a one-time, non-delegated querySelectorAll() scan in its connectedCallback (dnd5e.mjs),
 * guarded to run only once per render - it already ran before this section is inserted, so it
 * never sees these buttons. Every interactive control below (view/edit/delete/quantity) is
 * wired by hand here instead. The context-menu ("...") button is left unwired - out of scope,
 * not a simple one-off action to replicate.
 *
 * Only lists containers isUnmanagedContainer() doesn't exclude — one already shown on the
 * doll (an AWC-slotted, equipped container) isn't duplicated here.
 */
function injectContainersSection(el, actor, app) {
  el.querySelector(".awc-containers-section")?.remove();

  const containers = actor.items.filter(isUnmanagedContainer);
  if (!containers.length) return;

  const list = el.querySelector('.tab[data-tab="inventory"] .items-list');
  if (!list) return;

  // Matches dnd5e's own controls.hbs: edit/delete only in Edit Mode, an Equip toggle in Play
  // Mode instead (containers, like any physical item, carry system.equipped).
  const editMode = !!app?.isEditMode;

  const rows = containers.map(item => `
    <li class="item" data-uuid="${item.uuid}" data-item-id="${item.id}"
        data-entry-id="${item.id}" data-item-name="${item.name}">
      <div class="item-row draggable">
        <div class="item-name item-action item-tooltip rollable" role="button" data-action="view"
             aria-label="${item.name}">
          <img class="item-image gold-icon" src="${item.img}" alt="${item.name}" draggable="false">
          <div class="name name-stacked">
            <span class="title">${item.name}</span>
          </div>
        </div>
        <div class="item-detail item-quantity" data-column-id="quantity">
          <a class="adjustment-button always-interactive" data-action="decrease" data-property="system.quantity">
            <i class="fa-solid fa-minus" inert></i>
          </a>
          <input type="text" class="always-interactive" value="${item.system.quantity ?? 1}" placeholder="0"
                 data-dtype="Number" data-name="system.quantity" inputmode="numeric" pattern="^[+=\\-]?\\d*"
                 min="0" aria-label="${game.i18n.localize("DND5E.Quantity")}">
          <a class="adjustment-button always-interactive" data-action="increase" data-property="system.quantity">
            <i class="fa-solid fa-plus" inert></i>
          </a>
        </div>
        <div class="item-detail item-weight" data-column-id="weight">
          <i class="fa-solid fa-weight-hanging" inert></i> ${itemWeightValue(item)}
        </div>
        <div class="item-detail item-controls always-visible" data-column-id="controls">
          ${editMode ? `
          <button type="button" class="unbutton config-button item-control item-action" data-action="edit"
                  data-tooltip aria-label="${game.i18n.localize("DND5E.ItemEdit")}">
            <i class="fa-solid fa-pen-to-square" inert></i>
          </button>
          <button type="button" class="unbutton config-button item-control item-action" data-action="delete"
                  data-tooltip aria-label="${game.i18n.localize("DND5E.ItemDelete")}">
            <i class="fa-solid fa-trash" inert></i>
          </button>
          ` : `
          <button type="button" class="unbutton config-button item-control item-action" data-action="equip"
                  data-tooltip aria-label="${item.system.equipped ? "Unequip" : "Equip"}">
            <i class="fa-solid fa-shield-halved" inert></i>
          </button>
          `}
          <button type="button" class="unbutton config-button item-control always-interactive" data-context-menu
                  aria-label="${game.i18n.localize("DND5E.AdditionalControls")}">
            <i class="fa-solid fa-ellipsis-vertical" inert></i>
          </button>
        </div>
      </div>
    </li>
  `).join("");

  const sectionHTML = `
    <div class="items-section card awc-containers-section">
      <div class="items-header header">
        <h3 class="item-name">Containers</h3>
        <div class="item-header item-quantity" data-column-id="quantity">${game.i18n.localize("DND5E.Quantity")}</div>
        <div class="item-header item-weight" data-column-id="weight">${game.i18n.localize("DND5E.Weight")}</div>
        <div class="item-header item-controls" data-column-id="controls"></div>
      </div>
      <ol class="item-list unlist">${rows}</ol>
    </div>
  `;

  list.insertAdjacentHTML("beforeend", sectionHTML);

  list.querySelectorAll(".awc-containers-section .item").forEach(row => {
    const item = actor.items.get(row.dataset.itemId);
    if (!item) return;

    // dnd5e's real rows get their draggable attribute + dragstart wiring from a DragDrop
    // instance bound once during the sheet's own _onRender (dragSelector: ".draggable"), which
    // already ran by the time this section is inserted - the "draggable" CLASS on .item-row
    // is just the selector it would have matched, it does nothing on its own here. Replicate
    // it manually: mark the row draggable and populate dataTransfer with the standard
    // {type, uuid} Document-drag payload every drop target (including AWC's own doll) expects.
    // registerAwcContainerDrag (below) additionally flags this specific drag so a drop that
    // misses every real target gets treated as a cancel rather than dnd5e's own inventory drop
    // handler mistaking it for a "copy this item onto the sheet" gesture - see its own comment.
    const dragRow = row.querySelector(".item-row.draggable");
    if (dragRow) {
      dragRow.setAttribute("draggable", "true");
      dragRow.addEventListener("dragstart", event => {
        registerAwcContainerDrag();
        event.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: item.uuid }));
      });
    }

    // Wired by hand - see this function's docblock for why dnd5e's own delegated handling
    // never reaches these (InventoryElement's one-time connectedCallback scan already ran).
    row.querySelector('[data-action="view"]')?.addEventListener("click", () => item.sheet?.render(true));
    row.querySelector('[data-action="edit"]')?.addEventListener("click", () => item.sheet?.render(true));
    row.querySelector('[data-action="delete"]')?.addEventListener("click", () => item.deleteDialog());
    row.querySelector('[data-action="equip"]')?.addEventListener("click", () =>
      item.update({ "system.equipped": !item.system.equipped }));
    row.querySelector('[data-action="decrease"]')?.addEventListener("click", () =>
      item.update({ "system.quantity": Math.max(0, (item.system.quantity ?? 1) - 1) }));
    row.querySelector('[data-action="increase"]')?.addEventListener("click", () =>
      item.update({ "system.quantity": (item.system.quantity ?? 1) + 1 }));
    const qtyInput = row.querySelector('input[data-name="system.quantity"]');
    qtyInput?.addEventListener("change", () => {
      const value = Number(qtyInput.value);
      if (Number.isFinite(value)) item.update({ "system.quantity": Math.max(0, value) });
    });
  });
}

// ─── AWC-injected-row drag safety net ──────────────────────────────────────
// dnd5e's own drop handler decides "reorder in place" vs. "create a new copy of this item"
// based on a drag-effect value ("move" vs "copy") it tracks internally per-drag, populated
// from a private cache only its OWN dragstart wiring writes to. A drag started from one of
// this module's own hand-wired rows (the Containers section above) never touches that cache,
// so dnd5e's calculation silently falls back to "copy" for the whole drag - dropping the item
// back anywhere on the actor sheet other than a real AWC target (the doll) then creates a
// duplicate instead of doing nothing, since dnd5e's own handler takes that as "user wants a
// new copy of this item here". There's no way to write into dnd5e's private cache from outside
// its class, so instead: track whether the CURRENT drag started on one of these rows, and if
// so, swallow a drop that lands anywhere but the doll in the capture phase - before dnd5e's own
// (later, non-capture) drop handler ever sees it - so it reads as a plain cancelled drag
// (nothing happens, matching every other drag-and-drop gesture in Foundry) instead of a copy.
let awcContainerDragActive = false;

function registerAwcContainerDrag() {
  awcContainerDragActive = true;
}

document.addEventListener("dragend", () => { awcContainerDragActive = false; }, true);

document.addEventListener("drop", event => {
  if (!awcContainerDragActive) return;
  awcContainerDragActive = false;
  // Real AWC targets: the doll itself, or any of its own popups (the equip-picker, a pocket
  // viewer/picker, or drag-highlight.js's own drag-revealed pocket window) - these last ones
  // are appended straight to document.body, not nested inside .awc-doll-content, so both have
  // to be checked or a drop onto an open pocket window would get wrongly swallowed here too.
  if (event.target.closest?.(".awc-doll-content, .awc-doll-picker")) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

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
