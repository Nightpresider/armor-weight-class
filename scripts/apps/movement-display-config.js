/**
 * apps/movement-display-config.js
 * Small per-actor popup: edits flags.armor-weight-class.movementDisplay, the
 * AWC-owned, display-only mirror the Movement pills-group (sheet-inject.js's
 * injectMovementPillsGroup) shows on the Details tab. Deliberately does NOT
 * read or write dnd5e's own system.attributes.movement, and does NOT touch
 * dnd5e's native Movement Configuration dialog at all — a prior design that
 * mirrored that dialog's live DOM ran into three stacked fragility sources
 * (its fields are Foundry/dnd5e custom form elements, it's a DocumentSheet
 * that auto-re-renders on any actor update, and setFlag() is an async round
 * trip that could race the next sheet render) documented in the
 * dnd5e-stale-form-submission project note. Plain inputs, current value
 * shown alongside each one, one explicit Save action — nothing to fight.
 */

import { MODULE_ID, FLAG_NS } from "../constants.js";
import { AWCApplication } from "./awc-application.js";
import { AWC_MOVEMENT_TYPE_ICONS, resolveMovementDisplay, cacheMovementDisplay } from "../sheet-inject.js";

export class AWCMovementDisplayConfig extends AWCApplication {
  constructor(actor) {
    super();
    this.object = actor;
  }

  get id() { return `awc-movement-display-config-${this.object.uuid}`; }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["awc-movement-display-config", "standard-form"],
    window: {
      title: "AWC.App.MovementDisplayConfig.Title",
      contentClasses: ["standard-form"],
    },
    position: { width: 420, height: "auto" },
    form: {
      handler: AWCMovementDisplayConfig.#onSubmit,
      closeOnSubmit: true,
    },
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/movement-display-config.hbs`,
    },
    footer: {
      template: "templates/generic/form-footer.hbs",
    },
  };

  async _prepareContext(_options) {
    const { movement } = resolveMovementDisplay(this.object);
    const unitsOptions = Object.entries(CONFIG.DND5E.movementUnits ?? {})
      .map(([value, { label }]) => ({ value, label, selected: value === (movement.units || "ft") }));

    const types = Object.keys(AWC_MOVEMENT_TYPE_ICONS).map(key => ({
      key,
      icon: AWC_MOVEMENT_TYPE_ICONS[key],
      label: game.i18n.localize(CONFIG.DND5E.movementTypes?.[key]?.label ?? key),
      value: Number(movement[key]) || 0,
    }));

    return {
      actor: this.object,
      types,
      units: movement.units || "ft",
      unitsOptions,
      hover: !!movement.hover,
      buttons: [{ type: "submit", icon: "fas fa-save", label: "SETTINGS.Save" }],
    };
  }

  static async #onSubmit(_event, _form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const movement = data.flags?.[FLAG_NS]?.movementDisplay;
    // Cache immediately with what was just submitted, before the
    // actor.update() round trip even starts — this is what closes the
    // race documented in resolveMovementDisplay(): if the user's very
    // next action triggers a sheet render before that round trip lands,
    // it'll find this cache already correct rather than reading
    // pre-save persisted data.
    if (movement) cacheMovementDisplay(this.object.id, movement);
    await this.object.update(data);
  }
}
