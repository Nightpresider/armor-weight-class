/**
 * column-reflow.js
 * Packs .items-section category cards (Weapons/Equipment/... on
 * Inventory, feature groups on Features, spell-level sections on
 * Spells, effect-type groups on Effects) into two balanced columns.
 *
 * The JS always builds the two-column wrapper structure eagerly, on
 * every render, regardless of whether the tab is currently visible or
 * how wide it currently is — CSS (.awc-columns' @container rules in
 * armor-weight-class.css) decides whether that structure actually
 * RENDERS as two columns or collapses back to one. This sidesteps a
 * real problem with a JS-side width check instead: Foundry keeps every
 * tab's DOM present at once (only the active one is visible), so a
 * hidden tab's getBoundingClientRect() would read zero/wrong — nothing
 * here needs to measure anything, so that failure mode doesn't apply.
 */

import { MODULE_ID } from "./constants.js";

const LOG = `${MODULE_ID} |`;

/**
 * Greedy "longest processing time first" bin-packing: sort sections by
 * item count descending, seed column 1 with the largest, then add each
 * remaining section to whichever column currently has the smaller
 * running total. A well-known good approximation for balancing two
 * bins — not pixel-perfect optimal, doesn't need to be.
 *
 * Conditions (Effects tab, marked with data-effect-type="awc-conditions"
 * by sheet-inject.js's relocateConditionsIntoEffectsList — it isn't one
 * of dnd5e's own native effect-type sections) is special-cased: pinned
 * as column 2's first entry rather than joining the by-count sort, per
 * an explicit priority request. Its own count still seeds column 2's
 * running total before the remaining sections bin-pack normally around
 * it, so "whichever column stays most dense" for those still accounts
 * for the space Conditions itself is already taking up — HALVED
 * (rounded up) rather than used raw, since Conditions renders as a
 * 2-per-row grid (armor-weight-class.css, Half/Collapsed-only) while
 * every other section here is a single-column list; its true rendered
 * height is ~half its item count, not one line per item. Seeding with
 * the raw count overstated column 2's height enough that it pushed
 * MULTIPLE subsequent sections into column 1 before column 2 was ever
 * considered short enough to receive one — confirmed live.
 */
export function packIntoColumns(sections) {
  const pinned = sections.find(s => s.element.dataset.effectType === "awc-conditions");
  const rest = pinned ? sections.filter(s => s !== pinned) : sections;

  const sorted = [...rest].sort((a, b) => b.count - a.count);
  const column1 = [];
  const column2 = pinned ? [pinned.element] : [];
  let total1 = 0;
  let total2 = pinned ? Math.ceil(pinned.count / 2) : 0;

  for (const section of sorted) {
    if (total1 <= total2) {
      column1.push(section.element);
      total1 += section.count;
    } else {
      column2.push(section.element);
      total2 += section.count;
    }
  }

  return { column1, column2 };
}

/**
 * Finds the .items-list matching listSelector inside el, un-wraps any
 * previous run's column structure (item counts can change between
 * renders — a stale pack must never linger), re-measures each
 * .items-section's item count, and re-packs into fresh .awc-columns /
 * .awc-column wrapper divs. Safe/idempotent to call every render.
 */
export function reflowItemsList(el, { listSelector, sectionSelector = ".items-section" }) {
  const list = el.querySelector(listSelector);
  if (!list) return;

  const existingWrapper = list.querySelector(":scope > .awc-columns");
  if (existingWrapper) {
    existingWrapper.querySelectorAll(sectionSelector).forEach(section => list.appendChild(section));
    existingWrapper.remove();
  }

  const sections = [...list.querySelectorAll(`:scope > ${sectionSelector}`)];
  if (sections.length < 2) return; // nothing meaningful to balance across two columns

  // Conditions (see packIntoColumns' pinning above) uses a completely
  // different internal structure — .conditions-list > li.condition, not
  // .item-list > li.item — so it needs its own count selector too, or
  // it'd always measure as 0 items and understate how much of column 2
  // it's already occupying.
  const withCounts = sections.map(element => ({
    element,
    count: element.querySelectorAll(".item-list > li.item, .conditions-list > li.condition").length,
  }));

  const { column1, column2 } = packIntoColumns(withCounts);
  if (!column1.length || !column2.length) return; // one column would be empty — leave it single-column

  console.debug(`${LOG} reflowItemsList — ${listSelector}: ${column1.length}/${column2.length} sections`);

  const wrapper = document.createElement("div");
  wrapper.className = "awc-columns";

  const col1El = document.createElement("div");
  col1El.className = "awc-column";
  column1.forEach(section => col1El.appendChild(section));

  const col2El = document.createElement("div");
  col2El.className = "awc-column";
  column2.forEach(section => col2El.appendChild(section));

  wrapper.append(col1El, col2El);
  list.appendChild(wrapper);
}
