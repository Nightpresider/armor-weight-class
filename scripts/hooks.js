/**
 * hooks.js
 * Registers all Foundry / dnd5e hooks that power the overhaul.
 */

import { MODULE_ID, FLAG_NS, BRACKET_EFFECTS } from "./constants.js";
import { getCapacityData, persistCapacityFlags } from "./capacity.js";
import { applyCustomAC } from "./ac.js";
import { getItemSlot } from "./slots.js";
import { registerSettings } from "./settings.js";
import { injectCharacterSheetUI } from "./sheet-inject.js";

const LOG = `${MODULE_ID} |`;

// ── init ─────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  console.log(`${LOG} Initializing Armor & Weight Overhaul`);
  registerSettings();
  // Patch before any actor documents are prepared (actors load between init
  // and ready, so patching here guarantees the override runs on first load).
  _patchArmorClass();
  _patchEquipmentTypes();
});

// ── ready ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  game.awc = { getCapacityData, applyCustomAC, FLAG_NS };
  console.log(`${LOG} Ready. API at game.awc`);

  _patchArmorClass();
  _registerV14SheetHooks();
});

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
// Single source of truth for all AWC-managed equipment groups and their labels.

const _AWC_EQUIP_GROUPS = {
  Armor:   { helmet: "Helmet", breast: "Breast", gauntlet: "Gauntlet", boots: "Boots" },
  Clothing: {
    hat: "Hat", cape: "Cape", shirt: "Shirt", glove: "Glove", trouser: "Trouser",
    shoes: "Shoes", belt: "Belt", purse: "Purse", backpack: "Backpack",
  },
  Jewelry: { crown: "Crown", mask: "Mask", necklace: "Necklace", ring: "Ring" },
};

// Flat set of all our sub-type keys — used for the isArmor patch
const _AWC_ARMOR_TYPES = new Set(
  Object.values(_AWC_EQUIP_GROUPS).flatMap(g => Object.keys(g))
);

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
 * in at data-model definition time before our init hook runs.
 */
function _patchEquipmentTypeSelect(el, item) {
  const sel =
    el.querySelector('select[data-field="system.type.value"]') ??
    el.querySelector('select[name="system.type.value"]')       ??
    el.querySelector('select[name="system.armor.type"]')       ??
    null;
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

  // ── Shared option-builder ──
  function buildOptions(selectEl, activeVal) {
    selectEl.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "—";
    if (!activeVal) blank.selected = true;
    selectEl.appendChild(blank);

    for (const { value, label } of preserved) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      if (value === activeVal) opt.selected = true;
      selectEl.appendChild(opt);
    }

    for (const [groupLabel, children] of Object.entries(_AWC_EQUIP_GROUPS)) {
      const grp = document.createElement("optgroup");
      grp.label = groupLabel;
      for (const [val, label] of Object.entries(children)) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = label;
        if (val === activeVal) opt.selected = true;
        grp.appendChild(opt);
      }
      selectEl.appendChild(grp);
    }
  }

  buildOptions(sel, currentVal);
  console.debug(`${LOG} equipment type select rebuilt (current: "${currentVal}")`);

  // ── Equipment Subtype ──────────────────────────────────────────────────────
  // Remove any previously injected subtype row (handles re-renders)
  el.querySelector(".awc-subtype-row")?.remove();

  const typeContainer = sel.closest(".label-top, .form-group, .stacked") ?? sel.parentElement;
  if (!typeContainer) return;

  const currentSubtype = item?.getFlag?.(FLAG_NS, "subType") ?? "";

  const subtypeSel = document.createElement("select");
  buildOptions(subtypeSel, currentSubtype);

  subtypeSel.addEventListener("change", (ev) => {
    item?.setFlag?.(FLAG_NS, "subType", ev.target.value);
  });

  // Wrap in a container that mirrors dnd5e's .label-top layout
  const row = document.createElement("div");
  row.className = `awc-subtype-row ${typeContainer.className}`;

  const lbl = document.createElement("label");
  lbl.textContent = "Equipment Subtype";

  row.appendChild(lbl);
  row.appendChild(subtypeSel);

  typeContainer.insertAdjacentElement("afterend", row);
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
  if (beingEquipped) {
    const slotType = getItemSlot(item);
    if (slotType) {
      for (const other of actor.items) {
        if (other.id === item.id || !other.system?.equipped) continue;
        if (getItemSlot(other) !== slotType) continue;
        await other.update({ "system.equipped": false }, { render: false });
        ui.notifications.info(
          game.i18n.format("AWC.Notify.SlotSwap", {
            old:  other.name,
            slot: game.i18n.localize(`AWC.Slot.${slotType.charAt(0).toUpperCase() + slotType.slice(1)}`),
            new:  item.name,
          })
        );
      }
    }
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

