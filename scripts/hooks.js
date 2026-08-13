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
 * Foundry v13+ feature-detect. All ApplicationV2 UI (the doll, its per-actor
 * config popup, the Configure Paper Doll menu) is gated behind this — v12
 * users keep every other AWC feature (AC/capacity math, sheet injection,
 * slot exclusivity, migration) unmodified, they just don't get the visual
 * doll (and the settings that only affect it stay hidden, since config:true
 * fields render regardless of this gate — see settings.js).
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
  _registerV14SheetHooks();

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

// ── Equipment type definitions ────────────────────────────────────────────────
// Derived from constants.js's SLOT_TYPES (the single source of truth for every
// AWC-managed sub-type) — no longer a separately hand-maintained list, so this
// can't drift out of sync with the slot-exclusivity logic in slots.js the way
// the old standalone _AWC_EQUIP_GROUPS/SLOT_TYPES pair could.

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

/**
 * Directly rewrite the Equipment Type <select> on every item sheet render.
 * This is the reliable path for dnd5e v4, where SelectField choices are baked
 * in at data-model definition time before our init hook runs. Lists every
 * AWC sub-type directly (grouped into Armor/Clothing/Jewelry optgroups) —
 * choosing e.g. "Helmet" sets system.type.value = "helmet" directly, which
 * is what getItemSlot() (slots.js), capacity.js, and the doll all key off.
 *
 * (A cascading generic Type + separate Subtype dropdown was tried and
 * reverted — dnd5e's own form submission was overwriting the Type value
 * whenever a different field changed afterward, in a way that couldn't be
 * reliably chased down without live debugging access. Flat list only.)
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
 * window, via direct DOM injection into the existing render hook — the same
 * proven mechanism sheet-inject.js already uses for the capacity bar, rather
 * than a speculative `getHeaderControls<Name>` hook name (the original
 * fvtt-paper-doll-ui module relied on exactly such a hook — "getHeaderControlsActorSheetV2"
 * — that doesn't fire for this installation's actual sheet class name).
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

  const header = el.querySelector(".window-header");
  if (!header) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-control awc-doll-toggle";
  btn.dataset.tooltip = game.i18n.localize("AWC.App.PaperDoll.Title");
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
      const actor = app.actor ?? app.document;
      if (actor?.type !== "character") return;
      injectCharacterSheetUI(app, html);
      const el = html instanceof HTMLElement ? html : html?.[0];
      if (el) _injectDollHeaderButton(app, el, actor);
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
      const item = app.item ?? app.document;
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
  // Helmet/Mask coversFace) — weapons, shields, and rings are handled by
  // their own updateItem registration in paired-slots.js, since they use a
  // different (paired-slot) resolution model. resolveSlotConflicts() itself
  // is a no-op for anything it doesn't recognise (a paired slot, or an item
  // with no resolvable AWC slot at all), so calling it unconditionally here
  // is safe and avoids re-duplicating the "which subsystem owns this item"
  // check that paired-slots.js's own updateItem handler already makes.
  if (beingEquipped) {
    await resolveSlotConflicts(actor, item);
  }

  console.debug(`${LOG} equip change on "${actor.name}" — refreshing AWC panels`);
  requestAnimationFrame(() => _refreshActorSheet(actor));
});

function _refreshActorSheet(actor) {
  const sheet = actor.sheet;
  if (!sheet) {
    console.debug(`${LOG} _refreshActorSheet: no sheet for "${actor.name}"`);
    return;
  }

  // Normalise element: ApplicationV2 → HTMLElement, legacy → jQuery wrapper
  const raw = sheet.element;
  const el  = raw instanceof HTMLElement ? raw : raw?.[0];

  if (!el?.isConnected) {
    // Sheet exists but is not currently rendered in the DOM
    console.debug(`${LOG} _refreshActorSheet: sheet not in DOM for "${actor.name}"`);
    return;
  }

  console.debug(`${LOG} _refreshActorSheet: directly refreshing panels for "${actor.name}"`);
  injectCharacterSheetUI(sheet, el);
}

// ── Sheet renders (legacy hook — fires in v12 and via dnd5e compat shim) ──────

Hooks.on("renderActorSheet", (app, html, _data) => {
  console.debug(`${LOG} renderActorSheet fired`);
  const actor = app.actor ?? app.document;
  if (actor?.type !== "character") return;
  injectCharacterSheetUI(app, html);
});

// ── Item sheet: rewrite Equipment Type dropdown ───────────────────────────────

Hooks.on("renderItemSheet", (app, html, _data) => {
  const item = app.item ?? app.document;
  if (item?.type !== "equipment") return;
  const el = html instanceof HTMLElement ? html : html[0];
  if (el) _patchEquipmentTypeSelect(el, item);
});

