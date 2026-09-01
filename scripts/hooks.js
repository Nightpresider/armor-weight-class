/**
 * hooks.js
 * Registers all Foundry / dnd5e hooks that power the overhaul.
 */

import { MODULE_ID, FLAG_NS, BRACKET_EFFECTS, SLOT_TYPES } from "./constants.js";
import { getCapacityData, persistCapacityFlags } from "./capacity.js";
import { applyCustomAC } from "./ac.js";
import { getItemSlot, getSlotMap, resolveSlotConflicts } from "./slots.js";
import { getHandSlotState, getRingSlotState } from "./paired-slots.js";
import { registerSettings, registerAdvancedSettings, registerSettingsMenus } from "./settings.js";
import { injectCharacterSheetUI } from "./sheet-inject.js";
import { runMigration } from "./migration.js";

const LOG = `${MODULE_ID} |`;

/**
 * Foundry v13+ feature-detect. All ApplicationV2 UI (the doll, its config
 * popup, the Configure Paper Doll menu) is gated behind this — v12 users
 * keep every other AWC feature unmodified, they just don't get the visual
 * doll.
 */
function _hasApplicationV2() {
  return !!(foundry.applications?.api?.ApplicationV2 && foundry.applications?.api?.HandlebarsApplicationMixin);
}

// ── init ─────────────────────────────────────────────────────────────────────

Hooks.once("init", async () => {
  console.log(`${LOG} Initializing Armor & Weight Overhaul`);
  registerSettings();
  // Patch before any actor documents are prepared (actors load between init
  // and ready, so patching here guarantees the override runs on first load).
  _patchArmorClass();
  _patchEquipmentTypes();
  _patchFavorites();

  if (_hasApplicationV2()) {
    registerAdvancedSettings();
    await registerSettingsMenus();
  } else {
    console.log(`${LOG} ApplicationV2 unavailable (pre-v13 client) — Configure Paper Doll menu, Slot Conflict Pairs editor, and doll UI disabled, all other features unaffected`);
  }
});

// ── ready ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", async () => {
  game.awc = {
    getCapacityData,
    applyCustomAC,
    getSlotMap,
    getHandSlotState,
    getRingSlotState,
    FLAG_NS,
    openPaperDoll: _hasApplicationV2() ? _openPaperDoll : undefined,
  };
  console.log(`${LOG} Ready. API at game.awc`);

  _patchArmorClass();
  try { _patchSidebarToggle(); } catch (err) { console.error(`${LOG} _patchSidebarToggle failed`, err); }
  _registerV14SheetHooks();

  // Dynamic import (not a static one, not added to module.json's esmodules) -
  // drag-highlight.js statically imports apps/paper-doll-app.js, which is only ever
  // touched from post-ready entry points elsewhere in this file (sheet renders, header
  // button clicks) - registering this at "init" left that whole import chain unproven
  // this early, with no .catch() to surface a failure if one occurred.
  if (_hasApplicationV2()) {
    import("./drag-highlight.js")
      .then(mod => mod.registerDragHighlight())
      .catch(err => console.error(`${LOG} drag-highlight registration failed`, err));
  }

  if (game.user.isGM) {
    await runMigration();
  }
});

async function _openPaperDoll(actor) {
  if (!_hasApplicationV2()) return null;
  const { AWCPaperDoll } = await import("./apps/paper-doll-app.js");
  const openWindow = [...foundry.applications.instances.values()].find(w => w instanceof AWCPaperDoll && w.actor === actor);
  if (openWindow) { openWindow.close(); return null; }
  const app = new AWCPaperDoll(actor);
  app.render(true);
  return app;
}

// ── AC override: patch _computeArmorClass ────────────────────────────────────

/**
 * In dnd5e v4, Hooks.on("dnd5e.prepareActorData") fires BEFORE
 * _computeArmorClass runs, so any AC value we set there gets overwritten.
 * Patching the method directly guarantees we run last, after dnd5e's formula.
 *
 * We try the known method names for dnd5e v3 (_computeArmorClass) and v4
 * (in case it was renamed). Falls back to the hook if no method is found.
 */
function _patchArmorClass() {
  // CONFIG.Actor.documentClass is set during system init (available at our
  // init hook); game.actors?.documentClass is the same reference but only
  // reliably populated after ready. Prefer the CONFIG lookup so this function
  // works correctly when called from the init hook.
  const ActorCls = CONFIG.Actor?.documentClass ?? game.actors?.documentClass;
  if (!ActorCls) {
    console.warn(`${LOG} _patchArmorClass: no actor document class found`);
    return;
  }

  const proto = ActorCls.prototype;

  // Guard against double-patching — _patchArmorClass is called from both
  // init (so the patch is in place before actors first prepare) and ready
  // (safety call). Without this guard the prepareDerivedData wrapper would
  // be nested inside itself, causing applyCustomAC to run twice per prepare.
  if (proto._awcArmorPatched) {
    console.debug(`${LOG} _patchArmorClass: already patched, skipping`);
    return;
  }

  // Prefer patching the dedicated AC method (dnd5e v3).
  const acMethod = ["_computeArmorClass", "_prepareArmorClass", "_prepareDefenses"]
    .find(m => typeof proto[m] === "function");

  if (acMethod) {
    const _orig = proto[acMethod];
    proto[acMethod] = function (rollData) {
      _orig.call(this, rollData);
      if (this.type === "character") applyCustomAC(this);
    };
    proto._awcArmorPatched = true;
    console.log(`${LOG} Patched ${acMethod} for AC override`);
    return;
  }

  // dnd5e v4 renamed / inlined the AC method.
  // Patch prepareDerivedData so we always run after ALL of dnd5e's own
  // calculations have finished — the most reliable position possible.
  if (typeof proto.prepareDerivedData === "function") {
    const _orig = proto.prepareDerivedData;
    proto.prepareDerivedData = function () {
      _orig.call(this);
      if (this.type === "character") applyCustomAC(this);
    };
    proto._awcArmorPatched = true;
    console.log(`${LOG} Patched prepareDerivedData for AC override (dnd5e v4)`);
    return;
  }

  console.warn(`${LOG} _patchArmorClass: no patchable method found — AC override disabled`);
}

// ── Sidebar two-step collapse ─────────────────────────────────────────────────

/**
 * Whether the embedded doll (and the half-collapse tier that depends on
 * it) applies to this actor. Mirrors doll-embed.js's own gate exactly —
 * negated here since this asks "does it apply" rather than "should it be
 * skipped".
 */
function _dollAppliesTo(actor) {
  return actor?.hasPlayerOwner || !game.settings.get(MODULE_ID, "dollPlayerOwnedOnly");
}

/**
 * Opens the standalone Paper Doll pop-out (one-way, not a toggle — the
 * collapser button that triggers this hides itself right after, so it can't
 * be re-clicked to close what it just opened) and hides the collapser.
 */
async function _openSidebarPopoutFromCollapser(app) {
  if (!_hasApplicationV2()) return;
  const actor = app.actor ?? app.document;
  const { AWCPaperDoll } = await import("./apps/paper-doll-app.js");
  const alreadyOpen = [...foundry.applications.instances.values()].some(w => w instanceof AWCPaperDoll && w.actor === actor);
  if (!alreadyOpen) new AWCPaperDoll(actor).render(true);
  const collapser = app.form?.querySelector(".sidebar-collapser");
  if (collapser) collapser.style.display = "none";
}

/**
 * Patches _toggleSidebar (dnd5e.mjs, shared actor-sheet base class) to cycle
 * Full → Half → Collapsed instead of the native binary Full ↔ Collapsed
 * toggle. Same find-class/guard-flag/wrap shape as _patchArmorClass above,
 * but walks CONFIG.Actor.sheetClasses since this is a sheet-side method.
 * Only intercepts plain (no-argument) calls — an explicit force-call (e.g.
 * dnd5e restoring persisted collapse state) passes straight through.
 */
function _patchSidebarToggle() {
  if (!_hasApplicationV2()) return;

  const seen = new Set();
  let target = null;

  for (const sheets of Object.values(CONFIG.Actor?.sheetClasses ?? {})) {
    for (const entry of Object.values(sheets)) {
      let cls = entry.cls;
      while (cls && cls.prototype && !seen.has(cls)) {
        seen.add(cls);
        if (!target && Object.prototype.hasOwnProperty.call(cls.prototype, "_toggleSidebar")) {
          target = cls;
        }
        cls = cls.prototype.__proto__?.constructor;
      }
    }
  }

  if (!target) {
    console.warn(`${LOG} _patchSidebarToggle: no class with own _toggleSidebar found — two-step collapse disabled`);
    return;
  }

  const proto = target.prototype;
  if (proto._awcSidebarPatched) {
    console.debug(`${LOG} _patchSidebarToggle: already patched, skipping`);
    return;
  }

  const _orig = proto._toggleSidebar;
  proto._toggleSidebar = function (collapsed) {
    try {
      const actor = this.actor ?? this.document;
      if (collapsed !== undefined || !_dollAppliesTo(actor)) {
        this.element.classList.remove("awc-sidebar-half");
        return _orig.call(this, collapsed);
      }

      const el = this.element;
      if (el.classList.contains("sidebar-collapsed")) {
        _openSidebarPopoutFromCollapser(this);
        return true;
      }

      if (el.classList.contains("awc-sidebar-half")) {
        el.classList.remove("awc-sidebar-half");
        const result = _orig.call(this, true);
        // Native icon logic only knows caret-left/right — overwrite with the
        // pop-out meaning this button now has while fully collapsed. Reset
        // back to a plain caret by the step-up button when leaving Collapsed.
        const collapser = this.form?.querySelector(".sidebar-collapser");
        const icon = collapser?.querySelector("i");
        if (icon) {
          // Native icon is already "fas fa-caret-left/right" — just swap the
          // direction class, "fas" (Font Awesome's solid-style prefix) stays.
          icon.classList.remove("fa-caret-left", "fa-caret-right");
          icon.classList.add("fa-person");
        }
        if (collapser) {
          collapser.dataset.tooltip = "AWC.App.PaperDoll.Title";
          collapser.setAttribute("aria-label", game.i18n.localize("AWC.App.PaperDoll.Title"));
        }
        return result;
      }

      el.classList.add("awc-sidebar-half");
      return false;
    } catch (err) {
      console.error(`${LOG} patched _toggleSidebar failed — falling back to native toggle`, err);
      return _orig.call(this, collapsed);
    }
  };
  proto._awcSidebarPatched = true;
  console.log(`${LOG} Patched ${target.name}._toggleSidebar for two-step collapse`);

  // Reapplies Half/Collapsed right after the native tab switch, which otherwise resets it back
  // to Full. Remembered per tab, per sheet instance only - reopening the sheet starts at Full.
  const _origChangeTab = proto.changeTab;
  proto.changeTab = function (tab, group, options) {
    const actor = this.actor ?? this.document;
    if (group !== "primary" || !_dollAppliesTo(actor)) {
      return _origChangeTab.call(this, tab, group, options);
    }

    this._awcTabSidebarMode ??= {};
    const outgoingTab = this.element.className.match(/tab-(\w+)/)?.[1];
    if (outgoingTab) this._awcTabSidebarMode[outgoingTab] = _readSidebarMode(this.element);

    const result = _origChangeTab.call(this, tab, group, options);
    _applySidebarMode(this.element, this._awcTabSidebarMode[tab] ?? "full");
    return result;
  };
  console.log(`${LOG} Patched ${target.name}.changeTab to remember sidebar mode per tab`);
}

function _readSidebarMode(el) {
  if (el.classList.contains("sidebar-collapsed")) return "collapsed";
  if (el.classList.contains("awc-sidebar-half")) return "half";
  return "full";
}

function _applySidebarMode(el, mode) {
  el.classList.remove("awc-sidebar-half", "sidebar-collapsed");
  if (mode === "half") el.classList.add("awc-sidebar-half");
  else if (mode === "collapsed") el.classList.add("sidebar-collapsed");
}

// ── Equipment type definitions ────────────────────────────────────────────────
// Derived from constants.js's SLOT_TYPES (the single source of truth for
// every AWC-managed sub-type), so this can't drift out of sync with the
// slot-exclusivity logic in slots.js.

function _buildEquipGroups() {
  const groups = {};
  for (const [key, def] of Object.entries(SLOT_TYPES)) {
    (groups[def.group] ??= {})[key] = def.label;
  }
  return groups;
}

const _AWC_EQUIP_GROUPS = _buildEquipGroups();

// Flat set of all our sub-type keys — used for the isArmor patch
const _AWC_ARMOR_TYPES = new Set(Object.keys(SLOT_TYPES));

// Keys to strip out of the native select so they don't appear alongside ours
const _AWC_REMOVE_KEYS = new Set([
  ..._AWC_ARMOR_TYPES,
  // Native armor sub-types we're replacing
  "light", "medium", "heavy", "natural", "shield",
  // Native top-level types we're absorbing into groups
  "clothing", "ring",
]);

/**
 * Patch CONFIG.DND5E so dnd5e-version that read the config lazily pick up our
 * types. Also patches EquipmentData.isArmor so all AWC types show the AC field.
 * For dnd5e v4 (SelectField baked at class-definition time) the DOM patch below
 * is the effective mechanism for the dropdown.
 */
function _patchEquipmentTypes() {
  if (!CONFIG.DND5E) return;

  const armorSlots = _AWC_EQUIP_GROUPS.Armor;

  if (CONFIG.DND5E.equipmentTypes?.armor) {
    CONFIG.DND5E.equipmentTypes.armor.children = armorSlots;
    console.log(`${LOG} Patched equipmentTypes.armor.children`);
  }
  if (CONFIG.DND5E.armorTypes) {
    Object.keys(CONFIG.DND5E.armorTypes).forEach(k => delete CONFIG.DND5E.armorTypes[k]);
    Object.assign(CONFIG.DND5E.armorTypes, armorSlots);
    console.log(`${LOG} Patched armorTypes (v3)`);
  }

  delete CONFIG.DND5E.equipmentTypes?.clothing;
  if (CONFIG.DND5E.equipmentTypes) {
    CONFIG.DND5E.equipmentTypes.clothing = { label: "Clothing", children: _AWC_EQUIP_GROUPS.Clothing };
    CONFIG.DND5E.equipmentTypes.jewelry  = { label: "Jewelry",  children: _AWC_EQUIP_GROUPS.Jewelry  };
    console.log(`${LOG} Added equipmentTypes.clothing / .jewelry`);
  }

  _patchIsArmor();
}

function _patchIsArmor() {
  const model =
    globalThis.dnd5e?.dataModels?.item?.EquipmentData ??
    CONFIG.Item?.dataModels?.["equipment"] ??
    null;
  if (model) {
    _applyIsArmorPatch(model);
  } else {
    Hooks.once("ready", () => {
      const m =
        globalThis.dnd5e?.dataModels?.item?.EquipmentData ??
        CONFIG.Item?.dataModels?.["equipment"] ??
        null;
      if (m) _applyIsArmorPatch(m);
      else console.warn(`${LOG} EquipmentData not found — AC field patch skipped`);
    });
  }
}

function _applyIsArmorPatch(EquipmentData) {
  if (EquipmentData.prototype._awcIsArmorPatched) return;
  let origIsArmor = () => false;
  let proto = EquipmentData.prototype;
  while (proto && proto !== Object.prototype) {
    const d = Object.getOwnPropertyDescriptor(proto, "isArmor");
    if (d) { origIsArmor = d.get ?? (typeof d.value === "function" ? d.value : () => false); break; }
    proto = Object.getPrototypeOf(proto);
  }
  Object.defineProperty(EquipmentData.prototype, "isArmor", {
    get() { return _AWC_ARMOR_TYPES.has(this.type?.value) || origIsArmor.call(this); },
    configurable: true,
  });
  EquipmentData.prototype._awcIsArmorPatched = true;
  console.log(`${LOG} Patched EquipmentData.isArmor`);
}

// ── Favorites: weapons and armor already have quick access from the paper doll ──────────────
// (the attack popup, the equip slots) - offering them in the sheet's Favorites list too is
// redundant, so they're excluded from being favorited at all.

/** True if `item` shouldn't be favoritable anymore - a weapon, or armor per AWC's own
 *  isArmor patch (_applyIsArmorPatch below), not just dnd5e's native narrower definition. */
function _isFavoriteExcluded(item) {
  return item?.type === "weapon" || item?.system?.isArmor === true;
}

/**
 * Blocks addFavorite() at the data level - every favoriting path (the inventory list's
 * context menu, an activity's own context menu, or a direct drag into the Favorites panel)
 * ultimately calls this, so nothing sneaks through even without patching each menu separately.
 */
function _applyFavoritePatch(CharacterData) {
  if (CharacterData.prototype._awcFavoritePatched) return;
  const _origAddFavorite = CharacterData.prototype.addFavorite;
  CharacterData.prototype.addFavorite = function (favorite) {
    if (favorite?.type === "item" || favorite?.type === "activity") {
      let doc;
      try { doc = fromUuidSync(favorite.id, { relative: this.parent }); } catch { doc = null; }
      const item = doc?.documentName === "Item" ? doc : doc?.item;
      if (_isFavoriteExcluded(item)) return Promise.resolve(this.parent);
    }
    return _origAddFavorite.call(this, favorite);
  };
  CharacterData.prototype._awcFavoritePatched = true;
  console.log(`${LOG} Patched CharacterData.addFavorite to exclude weapons/armor`);
}

/** Hides the Favorite/Unfavorite entry from the inventory list's own context menu for
 *  weapons/armor - the data-level block above still applies regardless, this just keeps the
 *  menu from offering an action that would silently do nothing. */
function _applyInventoryContextMenuPatch(InventoryElement) {
  if (InventoryElement.prototype._awcFavoritePatched) return;
  const _origGetContextOptions = InventoryElement.prototype._getContextOptions;
  InventoryElement.prototype._getContextOptions = function (item, element) {
    const options = _origGetContextOptions.call(this, item, element);
    if (!_isFavoriteExcluded(item)) return options;
    return options.filter(o => o.name !== "DND5E.Favorite" && o.name !== "DND5E.FavoriteRemove");
  };
  InventoryElement.prototype._awcFavoritePatched = true;
  console.log(`${LOG} Patched InventoryElement to hide Favorite for weapons/armor`);
}

function _patchFavorites() {
  const CharacterData = globalThis.dnd5e?.dataModels?.actor?.CharacterData ?? CONFIG.Actor?.dataModels?.["character"];
  if (CharacterData) _applyFavoritePatch(CharacterData);
  else Hooks.once("ready", () => {
    const cls = globalThis.dnd5e?.dataModels?.actor?.CharacterData ?? CONFIG.Actor?.dataModels?.["character"];
    if (cls) _applyFavoritePatch(cls);
    else console.warn(`${LOG} CharacterData not found — addFavorite patch skipped`);
  });

  const InventoryElement = customElements.get("dnd5e-inventory");
  if (InventoryElement) _applyInventoryContextMenuPatch(InventoryElement);
  else Hooks.once("ready", () => {
    const cls = customElements.get("dnd5e-inventory");
    if (cls) _applyInventoryContextMenuPatch(cls);
    else console.warn(`${LOG} dnd5e-inventory custom element not found — Favorite menu patch skipped`);
  });
}

/**
 * Directly rewrite the Equipment Type <select> on every item sheet render.
 * This is the reliable path for dnd5e v4, where SelectField choices are baked
 * in at data-model definition time before our init hook runs. Lists every
 * AWC sub-type directly (grouped into Armor/Clothing/Jewelry optgroups) —
 * choosing e.g. "Helmet" sets system.type.value = "helmet" directly, which
 * is what getItemSlot() (slots.js), capacity.js, and the doll all key off.
 *
 * A cascading generic Type + separate Subtype dropdown isn't safe here — dnd5e's own form
 * submission overwrites the Type value whenever a different field changes afterward. Flat
 * list only.
 */
function _findEquipmentTypeSelect(el) {
  return (
    el.querySelector('select[data-field="system.type.value"]') ??
    el.querySelector('select[name="system.type.value"]')       ??
    el.querySelector('select[name="system.armor.type"]')       ??
    null
  );
}

function _patchEquipmentTypeSelect(el, item) {
  const sel = _findEquipmentTypeSelect(el);
  if (!sel) return;

  const currentVal = sel.value;

  // Collect native flat options that are NOT managed by AWC
  const preserved = [];
  for (const child of [...sel.children]) {
    if (child.tagName === "OPTGROUP") continue;
    if (child.tagName === "OPTION") {
      const v = child.value;
      if (v && !_AWC_REMOVE_KEYS.has(v)) {
        preserved.push({ value: v, label: child.textContent.trim() });
      }
    }
  }

  sel.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "—";
  if (!currentVal) blank.selected = true;
  sel.appendChild(blank);

  for (const { value, label } of preserved) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === currentVal) opt.selected = true;
    sel.appendChild(opt);
  }

  for (const [groupLabel, children] of Object.entries(_AWC_EQUIP_GROUPS)) {
    const grp = document.createElement("optgroup");
    grp.label = groupLabel;
    for (const [val, label] of Object.entries(children)) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      if (val === currentVal) opt.selected = true;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }

  console.debug(`${LOG} equipment type select rebuilt (current: "${currentVal}")`);
}

let _warnedPaperDollCoexistence = false;

/**
 * Inserts the "open Paper Doll" header icon into a rendered actor-sheet
 * window via direct DOM injection into the render hook — the same
 * mechanism sheet-inject.js uses for the calc bar, rather than a
 * speculative `getHeaderControls<Name>` hook name (the original
 * fvtt-paper-doll-ui module relied on one that doesn't fire for this
 * installation's actual sheet class name).
 */
function _injectDollHeaderButton(app, el, actor) {
  if (!_hasApplicationV2()) return;

  if (game.modules.get("fvtt-paper-doll-ui")?.active) {
    if (!_warnedPaperDollCoexistence && game.user.isGM) {
      _warnedPaperDollCoexistence = true;
      ui.notifications.warn(game.i18n.localize("AWC.Notify.OldModuleActive"));
      console.warn(`${LOG} fvtt-paper-doll-ui is still active — AWC is deferring its own doll-toggle button to avoid a duplicate. Disable the old module once you've verified AWC's replacement works.`);
    }
    return; // don't add a duplicate button while the old module is still handling it
  }

  el.querySelector(".awc-doll-toggle")?.remove();

  // dollPlayerOwnedOnly gates the doll feature globally, not just the
  // embed — removing above (in case it was previously injected, then the
  // setting got toggled on for this actor) and bailing here keeps the
  // pop-out toggle in sync with that.
  if (game.settings.get(MODULE_ID, "dollPlayerOwnedOnly") && !actor.hasPlayerOwner) return;

  const header = el.querySelector(".window-header");
  if (!header) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-control awc-doll-toggle";
  // dollHideHeaderText: the button is already icon-only with no visible
  // text label, so the closest honest effect this setting can have is
  // suppressing even the hover tooltip text.
  if (!game.settings.get(MODULE_ID, "dollHideHeaderText")) {
    btn.dataset.tooltip = game.i18n.localize("AWC.App.PaperDoll.Title");
  }
  btn.innerHTML = `<i class="fa-solid fa-person"></i>`;
  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const { AWCPaperDoll } = await import("./apps/paper-doll-app.js");
    const openWindow = [...foundry.applications.instances.values()].find(w => w instanceof AWCPaperDoll && w.actor === actor);
    if (openWindow) openWindow.close();
    else new AWCPaperDoll(actor).render(true);
  });

  const closeBtn = header.querySelector('[data-action="close"], .header-control.close, .close');
  if (closeBtn) closeBtn.insertAdjacentElement("beforebegin", btn);
  else header.appendChild(btn);
}

// Cached after the first successful dynamic import — a dynamic import()
// of an already-loaded specifier still costs a microtask hop every call,
// which matters here since embedPaperDoll has its own synchronous fast
// path (a per-actor HTML cache) that this indirection would otherwise sit
// in front of.
let _dollEmbedModule = null;

/**
 * Dynamically imports and runs doll-embed.js's embedPaperDoll — gated
 * behind _hasApplicationV2() at the call site so a pre-v13 client never
 * even attempts the import (see doll-embed.js's own docblock for why that
 * matters: it statically imports apps/paper-doll-app.js, which is unsafe
 * to evaluate unconditionally).
 */
function _embedDollIfAvailable(app, el, actor) {
  if (!_hasApplicationV2()) return;
  if (_dollEmbedModule) {
    _dollEmbedModule.embedPaperDoll(app, el, actor);
    return;
  }
  import("./doll-embed.js").then((mod) => {
    _dollEmbedModule = mod;
    mod.embedPaperDoll(app, el, actor);
  });
}

function _registerV14SheetHooks() {
  // Introspect CONFIG to find the *actual* registered sheet class names
  // rather than hard-coding guesses. Works for dnd5e v3, v4, and any
  // third-party sheet modules that replace the defaults.
  const seen = new Set();

  function registerActorSheetHook(cls) {
    const name = cls?.name;
    if (!name || seen.has(name)) return;
    seen.add(name);
    console.debug(`${LOG} registering render hook for actor sheet: ${name}`);
    Hooks.on(`render${name}`, (app, html, _data) => {
      // The prototype-chain walk below also registers hooks for generic
      // ancestor classes — Foundry fires render<ClassName> for every class
      // up an app's chain, so any app sharing an ancestor with an actor sheet
      // (a Rest dialog, dnd5e's CreatureTypeConfig, etc.) triggers the same
      // hook name too. Some of those apps define their own `.actor` getter
      // that assumes it's only ever called on a real actor sheet (e.g.
      // CreatureTypeConfig's getter dereferences `this.object`, which doesn't
      // exist on that class) and throws instead of returning undefined — so
      // this access must be guarded, not just optionally-chained.
      let actor;
      try {
        actor = app.actor ?? app.document;
      } catch {
        return;
      }
      if (actor?.type !== "character") return;
      // actor.sheet === app filters out other apps (Rest dialogs, etc.)
      // sharing this same actor but not actually being its sheet.
      if (actor.sheet !== app) return;
      injectCharacterSheetUI(app, html);
      const el = html instanceof HTMLElement ? html : html?.[0];
      if (!el) return;
      _injectDollHeaderButton(app, el, actor);
      _embedDollIfAvailable(app, el, actor);
    });
  }

  // Walk the entire sheet class registry
  for (const [type, sheets] of Object.entries(CONFIG.Actor?.sheetClasses ?? {})) {
    for (const entry of Object.values(sheets)) {
      registerActorSheetHook(entry.cls);
      // Also walk the prototype chain so abstract base classes are covered
      let proto = entry.cls?.prototype?.__proto__?.constructor;
      while (proto && proto !== Function.prototype) {
        registerActorSheetHook(proto);
        proto = proto.prototype?.__proto__?.constructor;
      }
    }
  }

  // Walk item sheet registry — register the equipment type select patch
  function registerItemSheetHook(cls) {
    const name = cls?.name;
    if (!name || seen.has(name)) return;
    seen.add(name);
    console.debug(`${LOG} registering render hook for item sheet: ${name}`);
    Hooks.on(`render${name}`, (app, html, _data) => {
      // Same reasoning as registerActorSheetHook above — an app sharing an ancestor class
      // name with an item sheet may define its own `.item` getter that throws rather than
      // returning undefined when called on an unrelated app instance.
      let item;
      try {
        item = app.item ?? app.document;
      } catch {
        return;
      }
      if (item?.type !== "equipment") return;
      const el = html instanceof HTMLElement ? html : html[0];
      if (el) _patchEquipmentTypeSelect(el, item);
    });
  }

  for (const [_type, sheets] of Object.entries(CONFIG.Item?.sheetClasses ?? {})) {
    for (const entry of Object.values(sheets)) {
      registerItemSheetHook(entry.cls);
      let proto = entry.cls?.prototype?.__proto__?.constructor;
      while (proto && proto !== Function.prototype) {
        registerItemSheetHook(proto);
        proto = proto.prototype?.__proto__?.constructor;
      }
    }
  }
}

// ── Actor: derivedData ────────────────────────────────────────────────────────

function onPrepareActorData(actor) {
  if (actor.type !== "character") return;

  // Guard against double-processing when both v3 and v4 hooks fire
  if (actor._awcPrepared) return;
  actor._awcPrepared = true;
  Promise.resolve().then(() => { delete actor._awcPrepared; });

  // 1. Compute capacity / bracket
  const capacityData = getCapacityData(actor);
  actor._awcCapacity = capacityData;

  // 2. Apply bracket movement penalties (in-memory; not persisted to DB)
  if (game.settings.get(MODULE_ID, "applyBracketPenalties")) {
    const fx = BRACKET_EFFECTS[capacityData.bracket];
    if (fx && fx.speedMod !== 0) {
      const movement = actor.system?.attributes?.movement;
      if (movement) {
        for (const [key, val] of Object.entries(movement)) {
          if (typeof val === "number" && val > 0) {
            movement[key] = Math.max(0, val + fx.speedMod);
          }
        }
      }
    }
  }

  // 3. Persist capacity flags (fire-and-forget; render:false prevents re-render loops)
  if (actor.id && game.user?.isGM) {
    persistCapacityFlags(actor, capacityData).catch(console.warn);
  }
}

// dnd5e v3 hook name
Hooks.on("dnd5e.prepareActorData", onPrepareActorData);
// dnd5e v4 may use a different name — register both; guard prevents double-fire
Hooks.on("dnd5e.prepareDerivedData", onPrepareActorData);

// ── Item: slot-swap + panel refresh on equip / unequip ───────────────────────

// preUpdateItem is called synchronously by Foundry — async handlers are NOT
// awaited, so unequipping there races the incoming equip and loses. Doing
// everything in updateItem (after the equip is committed) is reliable.
Hooks.on("updateItem", async (item, changes, _options, _userId) => {
  // Handle both expanded { system: { equipped } } and flat { "system.equipped" } forms
  const equippedChanged =
    changes?.system?.equipped !== undefined ||
    "system.equipped" in (changes ?? {});
  if (!equippedChanged) return;

  const actor = item.actor;
  if (!actor || actor.type !== "character") return;

  // Auto-unequip any other item occupying the same slot when this item
  // was just equipped. Runs after the equip is committed so the DB is
  // consistent; render:false on the unequip prevents a redundant re-render.
  const beingEquipped =
    changes?.system?.equipped === true || changes?.["system.equipped"] === true;
  // Armor/Clothing/Jewelry conflict resolution (SLOT_CONFLICTS pairs +
  // Helmet/Mask coversFace) — weapons, shields, and rings go through their
  // own updateItem registration in paired-slots.js instead (a different,
  // paired-slot resolution model). resolveSlotConflicts() no-ops for
  // anything it doesn't recognise, so calling it unconditionally here is
  // safe.
  if (beingEquipped) {
    await resolveSlotConflicts(actor, item);
  }

  console.debug(`${LOG} equip change on "${actor.name}" — refreshing AWC panels`);
  requestAnimationFrame(() => _refreshActorSheet(actor));
});

// AWC's Movement pills-group reads flags.armor-weight-class.movementDisplay
// (see resolveMovementDisplay in sheet-inject.js) — this refreshes that
// display the instant the flag changes, same pattern as the equip/unequip
// refresh above.
Hooks.on("updateActor", (actor, changes, _options, _userId) => {
  if (actor.type !== "character") return;
  if (!foundry.utils.hasProperty(changes, `flags.${FLAG_NS}.movementDisplay`)) return;

  console.debug(`${LOG} movementDisplay flag change on "${actor.name}" — refreshing AWC panels`, foundry.utils.getProperty(changes, `flags.${FLAG_NS}.movementDisplay`));
  requestAnimationFrame(() => _refreshActorSheet(actor));
});

function _refreshActorSheet(actor) {
  const el = _sheetElementFor(actor);
  if (!el) {
    console.debug(`${LOG} _refreshActorSheet: no rendered sheet for "${actor.name}"`);
    return;
  }

  console.debug(`${LOG} _refreshActorSheet: directly refreshing panels for "${actor.name}"`);
  injectCharacterSheetUI(actor.sheet, el);
  // Keeps the embedded doll in sync with equip/unequip changes — this path
  // (unlike a genuine Foundry re-render) doesn't regenerate .portrait's
  // native content, but embedPaperDoll rebuilds from live actor data
  // unconditionally regardless, so it's always safe to call here too.
  _embedDollIfAvailable(actor.sheet, el, actor);
}

// ── Sheet renders (legacy hook — fires in v12 and via dnd5e compat shim) ──────

Hooks.on("renderActorSheet", (app, html, _data) => {
  console.debug(`${LOG} renderActorSheet fired`);
  const actor = app.actor ?? app.document;
  if (actor?.type !== "character") return;
  // Same reasoning as the v14 hook above — confirm app IS the actor's
  // actual registered sheet, not some other actor-adjacent application.
  if (actor.sheet !== app) return;
  injectCharacterSheetUI(app, html);
});

// ── Item sheet: rewrite Equipment Type dropdown ───────────────────────────────

Hooks.on("renderItemSheet", (app, html, _data) => {
  const item = app.item ?? app.document;
  if (item?.type !== "equipment") return;
  const el = html instanceof HTMLElement ? html : html[0];
  if (el) _patchEquipmentTypeSelect(el, item);
});

/** Normalised, connected-DOM-checked root element for actor's own open sheet, or null. */
function _sheetElementFor(actor) {
  const sheet = actor.sheet;
  if (!sheet) return null;
  const raw = sheet.element;
  const el = raw instanceof HTMLElement ? raw : raw?.[0];
  return el?.isConnected ? el : null;
}

