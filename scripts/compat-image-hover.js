/**
 * compat-image-hover.js
 * Renders the actual Paper Doll (every slot, empty ones included) as a read-only overlay
 * inside Image Hover's popup - reuses paper-doll-app.js's own context builders and the
 * shared paper-doll.hbs/paper-doll.css, same as doll-embed.js does for the sheet. No-ops
 * if Image Hover isn't active. Dynamic-imports paper-doll-app.js behind _hasApplicationV2()
 * (unsafe to import statically pre-v13 - see doll-embed.js). Hover-only, no drag/drop/click -
 * this is a transient preview popup, not an editable surface. Appended as a new sibling,
 * never touching Image Hover's own img/video.
 */

import { MODULE_ID, FLAG_NS } from "./constants.js";
import { getSlotMap } from "./slots.js";
import { getHandSlotState, getRingSlotState, getExemptItem, actorHasExemptCapableItem, describeHandBlocker } from "./paired-slots.js";

const LOG = `${MODULE_ID} |`;
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/paper-doll.hbs`;

// Foundry v13+ feature-detect - same as hooks.js's _hasApplicationV2(), duplicated
// locally since it isn't exported.
function _hasApplicationV2() {
  return !!(foundry.applications?.api?.ApplicationV2 && foundry.applications?.api?.HandlebarsApplicationMixin);
}

let _paperDollModule = null;
async function _getPaperDollModule() {
  if (!_paperDollModule) _paperDollModule = await import("./apps/paper-doll-app.js");
  return _paperDollModule;
}

// game.modules isn't reliably populated at raw top-level script-evaluation time - the
// active-check has to run from inside a hook callback (same as hooks.js's
// _injectDollHeaderButton), never at bare top-level.
Hooks.once("init", () => {
  if (!game.modules.get("image-hover")?.active) return;

  if (!_hasApplicationV2()) {
    console.log(`${LOG} Image Hover compatibility skipped (pre-v13 client, doll UI unavailable)`);
    return;
  }
  console.log(`${LOG} Image Hover compatibility active`);

  Hooks.on("renderImageHoverHUD", (app, html) => {
    const actor = app.object?.actor;
    const el = html instanceof HTMLElement ? html : html?.[0];
    if (!actor || !el) return;
    if (game.settings.get(MODULE_ID, "dollPlayerOwnedOnly") && !actor.hasPlayerOwner) return;

    renderDollOverlay(actor)
      .then(html => {
        el.querySelector(":scope > .awc-image-hover-doll")?.remove();
        el.insertAdjacentHTML("beforeend", html);
        const container = el.querySelector(":scope > .awc-image-hover-doll");
        if (!container) return;

        const objectFit = actor.getFlag(FLAG_NS, "dollObjectFit") || "cover";
        container.querySelectorAll(".awc-doll-portrait").forEach(img => { img.style.objectFit = objectFit; });

        if (game.settings.get(MODULE_ID, "showEquippedSlotTooltips")) wireHoverTooltips(container, actor);
      })
      .catch(err => console.error(`${LOG} compat-image-hover doll render failed`, err));
  });
});

async function renderDollOverlay(actor) {
  const mod = await _getPaperDollModule();
  const context = buildDollContext(mod, actor);
  const renderFn = foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  const inner = await renderFn(TEMPLATE_PATH, context);
  return `<div class="awc-image-hover-doll">${inner}</div>`;
}

/** Same shape as AWCPaperDoll._prepareContext() / doll-embed.js's buildDollContext(). */
function buildDollContext(mod, actor) {
  const { getDollLayout, buildSlotEntry, buildGroupedSlotEntry, buildRingEntry, buildExemptEntry, buildHandGroup, GROUPED_SLOTS, LEFT_COLUMN, RIGHT_COLUMN, CENTER_TOP_ROW } = mod;

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

/** doll-embed.js's onHoverIn/onHoverOut/setHoverTooltip, inlined - hover-only, no other interaction. */
function wireHoverTooltips(container, actor) {
  const panel = container.querySelector(".awc-doll-hover-tooltip");
  if (!panel) return;

  container.querySelectorAll(".awc-doll-slot").forEach(slotEl => {
    slotEl.addEventListener("pointerenter", async () => {
      const mod = await _getPaperDollModule();
      const slot = mod.slotFromElement(slotEl);
      const item = mod.itemForSlot(actor, slot);

      let content = null;
      if (item) {
        content = mod.buildTooltipHTML(actor, item);
      } else if (slot.kind === "hand") {
        const box = getHandSlotState(actor)[slot.box];
        if (box?.blocker) content = `<strong>${box.blocker.name}</strong><br>${describeHandBlocker(box.blocker)}`;
      }

      if (!content) { panel.classList.remove("active"); return; }
      panel.innerHTML = content;
      panel.classList.add("active");
    });
    slotEl.addEventListener("pointerleave", () => panel.classList.remove("active"));
  });
}
