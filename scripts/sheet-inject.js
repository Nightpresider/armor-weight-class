/**
 * sheet-inject.js
 * Builds and injects all character-sheet UI elements.
 *
 * Uses vanilla DOM throughout for Foundry v14 (ApplicationV2) compatibility.
 * In v14 render hooks, html is an HTMLElement; in v12 it is a jQuery object.
 * Both are normalised to HTMLElement at the entry point.
 */

import { MODULE_ID, FLAG_NS, DEFAULT_BRACKETS } from "./constants.js";
import { getCapacityData } from "./capacity.js";
import { getACBreakdown } from "./ac.js";

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

  // Always remove existing AWC panels before re-injecting.
  el.querySelector(".awc-capacity-bar")?.remove();
  el.querySelector(".awc-ac-breakdown")?.remove();

  const cap = getCapacityData(actor);
  const ac = getACBreakdown(actor);

  injectCapacityBar(el, cap);

  if (game.settings.get(MODULE_ID, "showACBreakdown") && ac) {
    injectACBreakdown(el, ac);
  }
}

// ─── 1. Capacity Bar ──────────────────────────────────────────────────────────

function injectCapacityBar(el, cap) {
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

  const encSel = ".encumbrance, .meter.encumbrance, " +
    "[data-prop='system.attributes.encumbrance'], " +
    "[data-field='system.attributes.encumbrance']";

  const encEl = el.querySelector(encSel);
  if (encEl) {
    const namedTrack = encEl.querySelector(
      ".bar, .bar-container, progress, meter, .meter-bar, .encumbrance-bar"
    );
    const fillTrack = !namedTrack
      ? encEl.querySelector('[style*="%"]')?.parentElement ?? null
      : null;
    const barTrack    = namedTrack ?? fillTrack;
    const injectTarget = barTrack ?? encEl;

    // ── DEBUG: dump the full encumbrance DOM so we can see what we're working with
    console.log(
      `${LOG} [AWC-DBG] encEl: <${encEl.tagName} class="${encEl.className}"> ` +
      `namedTrack: ${namedTrack ? `<${namedTrack.tagName} class="${namedTrack.className}">` : "null"} ` +
      `fillTrack: ${fillTrack ? `<${fillTrack.tagName} class="${fillTrack.className}">` : "null"} ` +
      `injectTarget: <${injectTarget.tagName} class="${injectTarget.className}">`
    );
    console.log(`${LOG} [AWC-DBG] encEl innerHTML:\n${encEl.innerHTML}`);

    const containerH =
      injectTarget.getBoundingClientRect().height ||
      injectTarget.clientHeight                   ||
      injectTarget.offsetHeight                   || 0;

    let nativeH   = containerH;
    let topOffset = 0;

    const visualEl =
      ( injectTarget.matches?.("progress, meter") ? injectTarget : null )  ??
      injectTarget.querySelector("progress, meter")                         ??
      injectTarget.querySelector('[style*="--pct"]')                        ??
      injectTarget.querySelector('[style*="width:"]')                       ??
      (() => {
        let best = null, bestH = Infinity;
        for (const child of injectTarget.children) {
          if (child.classList.contains("awc-capacity-bar")) continue;
          const h = child.getBoundingClientRect().height || child.offsetHeight || 0;
          if (h > 0 && h < bestH) { best = child; bestH = h; }
        }
        return bestH <= 12 ? best : null;
      })();

    console.log(
      `${LOG} [AWC-DBG] containerH=${containerH} ` +
      `visualEl: ${visualEl ? `<${visualEl.tagName} class="${visualEl.className}" style="${visualEl.getAttribute("style")}">` : "null"}`
    );

    if (visualEl && visualEl !== injectTarget) {
      const vH = visualEl.getBoundingClientRect().height || visualEl.offsetHeight || 0;
      const ctop = injectTarget.getBoundingClientRect().top;
      const vtop = visualEl.getBoundingClientRect().top;
      console.log(`${LOG} [AWC-DBG] vH=${vH} containerH-2=${containerH - 2} vtop-ctop=${vtop - ctop}`);
      if (vH > 0 && vH < containerH - 2) {
        nativeH   = vH;
        topOffset = Math.max(0, vtop - ctop);
      }
    }

    injectTarget.style.position = "relative";
    injectTarget.style.overflow = "visible";
    injectTarget.insertAdjacentHTML("afterbegin", barHTML);

    const awcBar = injectTarget.querySelector(":scope > .awc-capacity-bar");
    if (awcBar) {
      awcBar.classList.add("awc-enc-overlay");
      if (nativeH   > 0) awcBar.style.height = `${nativeH}px`;
      if (topOffset > 0) awcBar.style.top    = `${topOffset}px`;
    }

    const label = encEl.querySelector(".label, label, header");
    if (label) label.style.cssText += ";display:flex;justify-content:flex-end;gap:0.25em;";

    console.debug(`${LOG} capacity bar → overlaid (h=${nativeH}px, topOffset=${topOffset}px)`);
    return;
  }

  // Fallback: no encumbrance element found — insert as a standalone bar
  const targets = [
    { sel: ".sheet-header .attributes, .stats-block, .top-part, .main-top, .stats .attributes", pos: "afterend" },
    { sel: ".meter, .resource", pos: "afterend" },
    { sel: '.tab[data-tab="main"], .tab[data-tab="features"], .tab[data-tab="details"]', pos: "afterbegin" },
  ];

  for (const { sel, pos } of targets) {
    const target = el.querySelector(sel);
    if (target) {
      console.debug(`${LOG} capacity bar → inserting ${pos} "${sel}"`);
      target.insertAdjacentHTML(pos, barHTML);
      return;
    }
  }

  const inner = el.querySelector(".window-content, .sheet-body, form") ?? el;
  console.debug(`${LOG} capacity bar → nuclear fallback into ${inner.tagName}.${[...inner.classList].join(".")}`);
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
      console.debug(`${LOG} AC breakdown → inserting after AC container`);
      container.insertAdjacentHTML("afterend", breakdownHTML);
    }
  } else {
    console.debug(`${LOG} AC breakdown → no AC element found, skipping`);
  }
}
