/**
 * apps/movement-display-config.js
 * Small per-actor popup: edits flags.armor-weight-class.movementDisplay, the
 * AWC-owned, display-only mirror the Movement pills-group shows on the
 * Details tab. Deliberately never touches dnd5e's own system.attributes.movement
 * or its native Movement Configuration dialog — plain inputs and one explicit
 * Save action, so there's no custom-form-element or auto-re-render fragility to fight.
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
    // actor.update() round trip starts — closes the race documented in
    // resolveMovementDisplay(): a render triggered before the update
    // lands finds this cache already correct instead of stale data.
    if (movement) cacheMovementDisplay(this.object.id, movement);
    await this.object.update(data);
  }
}
