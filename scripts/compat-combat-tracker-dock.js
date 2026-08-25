/**
 * compat-combat-tracker-dock.js
 * Overlays two things onto each combatant portrait in Carousel Combat Tracker, entirely
 * from AWC's side - CCT's own code/templates are never touched: an always-visible stat
 * readout (HP/AC/Speed/Spell DC), and a rebuilt hover tooltip (actor name + equipped
 * items) replacing CCT's own. No-ops if CCT isn't active.
 *
 * CombatantPortrait's own async renderInner() writes innerHTML then data-tooltip
 * together, unawaited by its callers - a MutationObserver per portrait re-injects right
 * after that childList change lands, guaranteed after CCT's own write, never before.
 *
 * Discovering new portraits has no single native event worth trusting (renderCombatTracker/
 * updateCombatant/a MutationObserver on #ui-top were all tried, none reliable) - a 1s poll
 * sidesteps the question entirely; watchPortrait()/watchAllPortraits() are idempotent so
 * re-scanning is cheap.
 */

import { MODULE_ID } from "./constants.js";
import { getEquippedSlotItems } from "./equipped-slots.js";

const LOG = `${MODULE_ID} |`;

// game.modules isn't reliably populated at raw top-level script-evaluation time - the
// active-check has to run from inside a hook callback (same as hooks.js's
// _injectDollHeaderButton), never at bare top-level.
Hooks.once("init", () => {
  if (!game.modules.get("combat-tracker-dock")?.active) return;
  console.log(`${LOG} Combat Tracker Dock compatibility active`);

  const observed = new WeakSet();

  function buildStatsHtml(actor) {
    const hp = actor.system.attributes?.hp;
    const ac = actor.system.attributes?.ac?.value;
    const speed = actor.system.attributes?.movement?.walk;
    const dc = actor.system.attributes?.spell?.dc;

    const rows = [
      hp ? `<div><i class="fas fa-heart"></i>${hp.value}/${hp.max}</div>` : "",
      ac ? `<div><i class="fas fa-shield-halved"></i>${ac}</div>` : "",
      speed ? `<div><i class="fas fa-person-running"></i>${speed} ft.</div>` : "",
      dc ? `<div><i class="fas fa-hand-sparkles"></i>${dc}</div>` : ""
    ].join("");
    return `<div class="awc-combatant-stats">${rows}</div>`;
  }

  function buildTooltipHtml(actor) {
    const items = getEquippedSlotItems(actor);
    const list = items.length
      ? items.map(item => `<li>${item.name}</li>`).join("")
      : `<li class="awc-equipped-tooltip-empty">${game.i18n.localize("AWC.UI.NothingEquipped")}</li>`;
    return `<div class="awc-equipped-tooltip"><h3>${actor.name}</h3><ul>${list}</ul></div>`;
  }

  function inject(portraitEl) {
    const combatant = game.combat?.combatants.get(portraitEl.dataset.combatantId);
    const actor = combatant?.actor;
    if (!actor) return;

    try {
      portraitEl.querySelector(":scope > .awc-combatant-stats")?.remove();
      portraitEl.insertAdjacentHTML("beforeend", buildStatsHtml(actor));
      portraitEl.setAttribute("data-tooltip", buildTooltipHtml(actor));
    } catch (err) {
      console.error(`${LOG} compat-combat-tracker-dock overlay failed`, err);
    }
  }

  // inject() itself adds a child (the stats row), which would re-trigger this same
  // observer forever - disconnect around our own write, reconnect after.
  function watchPortrait(portraitEl) {
    if (observed.has(portraitEl)) return;
    observed.add(portraitEl);

    const observer = new MutationObserver(() => {
      observer.disconnect();
      inject(portraitEl);
      observer.observe(portraitEl, { childList: true });
    });

    inject(portraitEl);
    observer.observe(portraitEl, { childList: true });
  }

  function watchAllPortraits() {
    document
      .querySelectorAll("#combat-dock #combatants .combatant-portrait[data-combatant-id]")
      .forEach(watchPortrait);
  }

  // Keep these too - free, and shaves the worst case down from "up to 1s late" to
  // "immediate" whenever one of them does happen to fire.
  Hooks.on("renderCombatTracker", watchAllPortraits);
  Hooks.on("updateCombatant", watchAllPortraits);

  Hooks.once("ready", () => {
    watchAllPortraits();
    setInterval(watchAllPortraits, 1000);
  });
});
