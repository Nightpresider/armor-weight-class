/**
 * apps/actor-doll-config.js
 * Small per-actor popup: portrait override, portrait fit, and an auto-open
 * override for the doll. Actor-scoped, not world-scoped — deliberately kept
 * separate from the world-level settings registered in settings.js.
 */

import { MODULE_ID, FLAG_NS } from "../constants.js";
import { AWCApplication } from "./awc-application.js";

export class AWCActorDollConfig extends AWCApplication {
  constructor(actor) {
    super();
    this.object = actor;
  }

  get id() { return `awc-actor-doll-config-${this.object.uuid}`; }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["awc-actor-doll-config", "standard-form"],
    window: {
      title: "AWC.App.ActorDollConfig.Title",
      contentClasses: ["standard-form"],
    },
    position: { width: 420, height: "auto" },
    form: {
      handler: AWCActorDollConfig.#onSubmit,
      closeOnSubmit: true,
    },
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/actor-doll-config.hbs`,
    },
    footer: {
      template: "templates/generic/form-footer.hbs",
    },
  };

  async _prepareContext(_options) {
    return {
      actor: this.object,
      dollImg: this.object.getFlag(FLAG_NS, "dollImg") ?? "",
      dollObjectFit: this.object.getFlag(FLAG_NS, "dollObjectFit") ?? "cover",
      dollAutoOpen: this.object.getFlag(FLAG_NS, "dollAutoOpen") ?? "useDefault",
      buttons: [{ type: "submit", icon: "fas fa-save", label: "SETTINGS.Save" }],
    };
  }

  static async #onSubmit(_event, _form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    await this.object.update(data);
  }
}
