/**
 * apps/awc-application.js
 * Small shared ApplicationV2 base class for AWC's UI: adds client-scoped
 * window-position save/restore, the one piece of boilerplate genuinely
 * common to all three of AWC's new windows (the doll, its per-actor config
 * popup, and the settings menu). Not a copy of any third-party module's
 * base class — independently implemented, and much smaller, since AWC has
 * no need for e.g. a generic easing-function library or color-picker helper.
 *
 * Dynamic-import-only: never statically imported from module.json's
 * esmodules, since ApplicationV2/HandlebarsApplicationMixin don't exist on
 * Foundry v12. See hooks.js's _hasApplicationV2() gate — nothing in this
 * file is evaluated unless that gate already passed.
 */

import { MODULE_ID } from "../constants.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class AWCApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(...args) {
    super(...args);
    this.constructor._registerPositionSetting();
    this._savePosition = foundry.utils.debounce(this._savePosition.bind(this), 100);
  }

  /** Storage key for this class's saved position — stable, doesn't need to be pretty. */
  static get _positionSettingKey() {
    return `${this.name}-position`;
  }

  static _registerPositionSetting() {
    if (this._positionSettingRegistered) return;
    this._positionSettingRegistered = true;
    game.settings.register(MODULE_ID, this._positionSettingKey, {
      scope: "client",
      config: false,
      type: Object,
      default: {},
    });
  }

  _savePosition(position) {
    const toSave = { left: position.left, top: position.top, width: position.width, height: position.height };
    if (toSave.width === "auto") delete toSave.width;
    if (toSave.height === "auto") delete toSave.height;
    // A non-resizable window has no UI path to change width/height, so those
    // are never meaningful "user state" to restore — only where they dragged
    // it to (top/left). Restoring a stale saved size would otherwise silently
    // override DEFAULT_OPTIONS.position forever, masking any future change to it.
    if (this.options.window?.resizable === false) {
      delete toSave.width;
      delete toSave.height;
    }
    game.settings.set(MODULE_ID, this.constructor._positionSettingKey, toSave);
  }

  setPosition(...args) {
    const result = super.setPosition(...args);
    if (this.constructor._positionSettingRegistered) this._savePosition(this.position);
    return result;
  }

  async render(options1 = {}, options2 = {}) {
    const activeOptions = typeof options1 === "boolean" ? options2 : options1;
    if (activeOptions && !activeOptions.position && this.constructor._positionSettingRegistered) {
      const saved = game.settings.get(MODULE_ID, this.constructor._positionSettingKey);
      if (saved && Object.keys(saved).length) {
        // Discard any width/height a stale pre-fix save might still carry —
        // see the matching guard in _savePosition().
        const restored = this.options.window?.resizable === false
          ? { left: saved.left, top: saved.top }
          : saved;
        activeOptions.position = restored;
      }
    }
    return super.render(options1, options2);
  }
}
