/**
 * apps/doll-layout-config.js
 * "Configure Paper Doll" — a standalone, actor-independent layout editor.
 * Reuses the exact same template as the live doll (templates/paper-doll.hbs,
 * with isConfig:true), but every slot is always shown "empty" (no actor, no
 * items) and left-clicking ANY slot opens a file picker to set/change its
 * world-shared empty-state image — matching the original fvtt-paper-doll-ui
 * module's GlobalConfig window line-for-line: left-click to set an image,
 * right-click to clear it, color/hue edited live in the center panel.
 */

import { MODULE_ID } from "../constants.js";
import {
  LEFT_COLUMN, RIGHT_COLUMN, CENTER_TOP_ROW, GROUPED_SLOTS, PAPER_DOLL_WIDTH,
  getDollLayout, buildSlotEntry, buildGroupedSlotEntry, buildRingEntry, buildExemptEntry, resolveHandEmptyImg, pickSlotImage, clearSlotImage,
} from "./paper-doll-app.js";
import { AWCApplication } from "./awc-application.js";

function buildColumnEntry(layout, key) {
  if (GROUPED_SLOTS[key]) return buildGroupedSlotEntry(layout, key);
  return buildSlotEntry(layout, key, null);
}

/**
 * Config mode shows all 4 hand positions unconditionally (Melee/Ranged ×
 * Main/Secondary) — no actor/equip state here to hide any, unlike the live
 * doll's getHandSlotState(). Render order matches buildHandGroup() in
 * paper-doll-app.js: Main in the doll's outer corner, Secondary toward the
 * center, reversed for ranged.
 */
function buildConfigHandGroup(layout, side) {
  const emptyImg = resolveHandEmptyImg(layout, side);
  const icon = "fas fa-hand-fist";
  const box = (pos, label) => ({ kind: "hand", side, box: `${side}${pos === "main" ? "Main" : "Secondary"}`, pos, label, icon, emptyImg, item: null, empty: "awc-doll-empty" });
  const main = box("main", "Main Hand");
  const secondary = box("secondary", "Secondary Hand");
  return { side, collapsed: false, slots: side === "ranged" ? [secondary, main] : [main, secondary] };
}

export class AWCDollLayoutConfig extends AWCApplication {
  get id() { return "awc-doll-layout-config"; }
  get title() { return game.i18n.localize("AWC.App.DollLayoutConfig.Title"); }

  static DEFAULT_OPTIONS = {
    tag: "div",
    classes: ["awc-paper-doll", "awc-doll-layout-config"],
    window: {
      resizable: false,
      icon: "fa-solid fa-cogs",
    },
    position: {
      width: PAPER_DOLL_WIDTH,
      height: 600,
    },
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/paper-doll.hbs`,
    },
  };

  async _prepareContext(_options) {
    const layout = getDollLayout();
    return {
      isConfig: true,
      portraitImage: "",
      objectFit: "cover",
      left: LEFT_COLUMN.map(key => buildColumnEntry(layout, key)),
      right: RIGHT_COLUMN.map(key => buildColumnEntry(layout, key)),
      centerTop: CENTER_TOP_ROW.map(key => buildColumnEntry(layout, key)),
      showExempt: true,
      exempt: buildExemptEntry(layout, null),
      centerBottom: [
        buildRingEntry(layout, "main", null),
        buildSlotEntry(layout, "necklace", null),
        buildRingEntry(layout, "secondary", null),
      ],
      melee: buildConfigHandGroup(layout, "melee"),
      ranged: buildConfigHandGroup(layout, "ranged"),
      dollMainColor: game.settings.get(MODULE_ID, "dollMainColor"),
      dollBrightness: game.settings.get(MODULE_ID, "dollBrightness"),
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const html = this.element;

    html.querySelectorAll(".awc-doll-slot").forEach(slot => {
      slot.addEventListener("click", (event) => {
        event.stopPropagation();
        pickSlotImage(this._slotFromElement(slot));
      });
      slot.addEventListener("contextmenu", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await clearSlotImage(this._slotFromElement(slot));
        this.render();
      });
    });

    html.querySelector('input[name="dollMainColor"]')?.addEventListener("change", async (ev) => {
      await game.settings.set(MODULE_ID, "dollMainColor", ev.target.value);
      document.documentElement.style.setProperty("--awc-doll-main-color", ev.target.value);
    });
    html.querySelector('input[name="dollBrightness"]')?.addEventListener("change", async (ev) => {
      await game.settings.set(MODULE_ID, "dollBrightness", Number(ev.target.value));
      document.documentElement.style.setProperty("--awc-doll-brightness", `${ev.target.value}%`);
    });
  }

  _slotFromElement(el) {
    return { kind: el.dataset.kind, key: el.dataset.key, pos: el.dataset.pos, side: el.dataset.side, box: el.dataset.box };
  }
}
