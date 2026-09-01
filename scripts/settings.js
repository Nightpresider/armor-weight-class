/**
 * settings.js
 * Register all GM-configurable module settings.
 *
 * Almost every setting is `config:true` — they render directly on the
 * "Armor Weight Class" category page of Foundry's own Configure Settings
 * window (no extra click through a custom settings-menu popup needed). The
 * three things that genuinely can't be a simple typed field — the Slot
 * Conflict Pairs JSON editor and the Item Markers/Hand & Ring reference text
 * — use a custom `input` renderer on a StringField (registerAdvancedSettings(),
 * below), which Foundry's settings form fully supports; they still appear
 * inline on the same category page, not in a separate window. Only
 * "Configure Paper Doll" stays a real popup (registerSettingsMenus(), below)
 * since it's a genuine per-slot image editor, not a settings field.
 */

import { MODULE_ID, FLAG_NS, DEFAULT_BRACKETS, DEFAULT_SLOT_CONFLICTS } from "./constants.js";

export function registerSettings() {

  // ── Bracket Thresholds (stored as JSON object, driven by the 4 sliders below) ─
  game.settings.register(MODULE_ID, "bracketThresholds", {
    name: "AWC.Settings.BracketThresholds.Name",
    hint: "AWC.Settings.BracketThresholds.Hint",
    scope: "world",
    config: false,
    type: Object,
    default: DEFAULT_BRACKETS,
    onChange: () => refreshAllSheets(),
  });

  // ── Unarmored → Light threshold ────────────────────────────────────────────
  game.settings.register(MODULE_ID, "thresholdLight", {
    name: "AWC.Settings.ThresholdLight.Name",
    hint: "AWC.Settings.ThresholdLight.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 5, max: 50, step: 1 },
    default: 25,
    onChange: (val) => updateBracketThreshold("light", val / 100),
  });

  // ── Light → Medium threshold ───────────────────────────────────────────────
  game.settings.register(MODULE_ID, "thresholdMedium", {
    name: "AWC.Settings.ThresholdMedium.Name",
    hint: "AWC.Settings.ThresholdMedium.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 10, max: 75, step: 1 },
    default: 50,
    onChange: (val) => updateBracketThreshold("medium", val / 100),
  });

  // ── Medium → Heavy threshold ───────────────────────────────────────────────
  game.settings.register(MODULE_ID, "thresholdHeavy", {
    name: "AWC.Settings.ThresholdHeavy.Name",
    hint: "AWC.Settings.ThresholdHeavy.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 25, max: 95, step: 1 },
    default: 75,
    onChange: (val) => updateBracketThreshold("heavy", val / 100),
  });

  // ── Heavy → Overburdened threshold ─────────────────────────────────────────
  game.settings.register(MODULE_ID, "thresholdOver", {
    name: "AWC.Settings.ThresholdOver.Name",
    hint: "AWC.Settings.ThresholdOver.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 50, max: 100, step: 1 },
    default: 100,
    onChange: (val) => updateBracketThreshold("over", val / 100),
  });

  // ── Apply bracket movement penalties ─────────────────────────────────────
  game.settings.register(MODULE_ID, "applyBracketPenalties", {
    name: "AWC.Settings.ApplyPenalties.Name",
    hint: "AWC.Settings.ApplyPenalties.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshAllSheets(),
  });

  // ── Show AC breakdown tooltip ─────────────────────────────────────────────
  game.settings.register(MODULE_ID, "showACBreakdown", {
    name: "AWC.Settings.ShowACBreakdown.Name",
    hint: "AWC.Settings.ShowACBreakdown.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshAllSheets(),
  });

  // ── Keg-type Container one-handed cutoff ──────────────────────────────────
  // A Keg's handedness is dynamic (see paired-slots.js's isKegTwoHanded()) - one-handed once
  // its weight is under this fraction of the actor's own effective carry capacity
  // (system.attributes.encumbrance.max), two-handed above it.
  game.settings.register(MODULE_ID, "kegOneHandedFraction", {
    name: "AWC.Settings.KegOneHandedFraction.Name",
    hint: "AWC.Settings.KegOneHandedFraction.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0.1, max: 1, step: 0.05 },
    default: 1 / 3,
    onChange: () => refreshAllSheets(),
  });

  // ── Hide doll-equipped items from the Inventory list ─────────────────────
  game.settings.register(MODULE_ID, "hideEquippedFromInventory", {
    name: "AWC.Settings.HideEquippedFromInventory.Name",
    hint: "AWC.Settings.HideEquippedFromInventory.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshAllSheets(),
  });

  // ── Slot conflict pairs ────────────────────────────────────────────────────
  // The real array logic reads (slots.js). Always registered (config:false,
  // a plain Array type — safe on any client); its GM-facing JSON editor is a
  // config:true DataField-typed setting instead, registered by
  // registerAdvancedSettings() below since that pattern needs a v13+ client.
  game.settings.register(MODULE_ID, "slotConflicts", {
    scope: "world",
    config: false,
    type: Array,
    default: DEFAULT_SLOT_CONFLICTS,
  });

  // ── Paper Doll appearance/behaviour ───────────────────────────────────────
  game.settings.register(MODULE_ID, "dollLayout", {
    scope: "world",
    config: false,
    type: Object,
    default: {}, // {} = use the built-in default layout from apps/paper-doll-app.js
  });

  // Edited live via the doll windows' own color-swatch/brightness-slider
  // controls (doll-layout-config.js's _onRender), not this settings list.
  game.settings.register(MODULE_ID, "dollMainColor", {
    scope: "world",
    config: false,
    type: String,
    default: "#191005",
  });

  game.settings.register(MODULE_ID, "dollBrightness", {
    scope: "world",
    config: false,
    type: Number,
    default: 55,
  });

  game.settings.register(MODULE_ID, "dollPosition", {
    name: "AWC.Settings.DollPosition.Label",
    hint: "AWC.Settings.DollPosition.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "left",
    choices: { left: "Left", right: "Right", center: "Center" },
  });

  game.settings.register(MODULE_ID, "dollHideHeaderText", {
    name: "AWC.Settings.DollHideHeaderText.Label",
    hint: "AWC.Settings.DollHideHeaderText.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "dollAllowNonOwned", {
    name: "AWC.Settings.DollAllowNonOwned.Label",
    hint: "AWC.Settings.DollAllowNonOwned.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "dollPlayerOwnedOnly", {
    name: "AWC.Settings.DollPlayerOwnedOnly.Label",
    hint: "AWC.Settings.DollPlayerOwnedOnly.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => refreshAllSheets(),
  });

  // ── Migration schema version (internal bookkeeping, never user-facing) ────
  game.settings.register(MODULE_ID, "dataSchemaVersion", {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
  });

  // ── Equipped-slot icon tooltips (Image Hover / Carousel Combat Tracker) ───
  // Client-scoped, not world - purely a per-viewer display preference, unlike
  // everything else in this file.
  game.settings.register(MODULE_ID, "showEquippedSlotTooltips", {
    name: "AWC.Settings.ShowEquippedSlotTooltips.Name",
    hint: "AWC.Settings.ShowEquippedSlotTooltips.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });
}

/**
 * Settings that render a custom widget via a DataField `type` + an `input:`
 * function — not guaranteed on a v12 client, so only called behind hooks.js's
 * ApplicationV2 feature-detect.
 *
 * slotConflictsText is the GM-facing JSON editor for the real slotConflicts
 * array (registered unconditionally in registerSettings() above) — a plain
 * StringField so the raw text round-trips safely mid-edit, committing to
 * the real array only once it parses.
 *
 * itemMarkersReference and handRingSlotsReference are pure documentation —
 * blank StringField "settings" whose only purpose is a custom `input` that
 * renders static reference text instead of an actual form field.
 */
export function registerAdvancedSettings() {
  game.settings.register(MODULE_ID, "slotConflictsText", {
    name: "AWC.Settings.SlotConflicts.Name",
    hint: "AWC.Settings.SlotConflicts.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.StringField({ required: true, blank: true }),
    default: JSON.stringify(DEFAULT_SLOT_CONFLICTS, null, 2),
    input: (_field, config) => foundry.applications.fields.createTextareaInput({ ...config, rows: 8, classes: "awc-json-editor" }),
    onChange: (value) => {
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        game.settings.set(MODULE_ID, "slotConflicts", parsed);
        refreshAllSheets();
      } catch (err) {
        ui.notifications.error(game.i18n.localize("AWC.Settings.SlotConflicts.ParseError"));
        console.warn(`${MODULE_ID} | slotConflicts JSON parse failed:`, err);
      }
    },
  });

  game.settings.register(MODULE_ID, "itemMarkersReference", {
    name: "AWC.Settings.ItemMarkers.Name",
    hint: "AWC.Settings.ItemMarkers.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.StringField({ required: false, blank: true }),
    default: "",
    input: () => {
      const ul = document.createElement("ul");
      ul.className = "awc-marker-reference";
      for (const [flagKey, locKey] of [
        ["coversFace", "AWC.Settings.ItemMarkers.CoversFace"],
        ["bypassFaceCover", "AWC.Settings.ItemMarkers.BypassFaceCover"],
        ["ignoresHandSlot", "AWC.Settings.ItemMarkers.IgnoresHandSlot"],
      ]) {
        const li = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = `flags.${FLAG_NS}.${flagKey}`;
        li.append(code, ` — ${game.i18n.localize(locKey)}`);
        ul.appendChild(li);
      }
      return ul;
    },
  });

  game.settings.register(MODULE_ID, "handRingSlotsReference", {
    name: "AWC.Settings.HandRingSlots.Name",
    scope: "world",
    config: true,
    type: new foundry.data.fields.StringField({ required: false, blank: true }),
    default: "",
    input: () => {
      const div = document.createElement("div");
      for (const locKey of ["AWC.Settings.HandRingSlots.Reference", "AWC.Settings.HandRingSlots.ShieldReference"]) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = game.i18n.localize(locKey);
        div.appendChild(p);
      }
      return div;
    },
  });
}

/**
 * Registers the one remaining settings-menu button: the Paper Doll's
 * per-slot image editor (a genuine visual editor, not a settings field, so
 * it stays its own popup — everything else lives directly on the module's
 * Configure Settings category page). Called from hooks.js's init hook, only
 * when the ApplicationV2 feature-detect passes — the app class itself is
 * dynamically imported so it's never evaluated on a v12 client (see
 * scripts/apps/doll-layout-config.js for why that matters).
 */
export async function registerSettingsMenus() {
  const { AWCDollLayoutConfig } = await import("./apps/doll-layout-config.js");
  game.settings.registerMenu(MODULE_ID, "configureDoll", {
    name: "AWC.Settings.ConfigureDoll.Label",
    label: "AWC.Settings.ConfigureDoll.Label",
    hint: "AWC.Settings.ConfigureDoll.Hint",
    icon: "fas fa-cogs",
    type: AWCDollLayoutConfig,
    restricted: true,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function updateBracketThreshold(bracketKey, fraction) {
  const thresholds = game.settings.get(MODULE_ID, "bracketThresholds");
  thresholds[bracketKey].min = fraction;
  game.settings.set(MODULE_ID, "bracketThresholds", thresholds);
  refreshAllSheets();
}

function refreshAllSheets() {
  // Foundry v14 tracks ApplicationV2 windows in foundry.applications.instances;
  // v12 uses ui.windows. Collect from whichever is available.
  const apps = foundry.applications?.instances
    ? [...foundry.applications.instances.values()]
    : Object.values(ui.windows);

  for (const app of apps) {
    // In v14, the document is at app.document; in v12, actor/item sheets expose
    // app.actor and app.item. Accept either pattern.
    const doc = app.document ?? app.actor ?? app.item ?? null;
    if (doc instanceof Actor || doc instanceof Item) {
      app.render();
    }
  }
}
