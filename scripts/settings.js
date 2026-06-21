/**
 * settings.js
 * Register all GM-configurable module settings.
 */

import { MODULE_ID, DEFAULT_BRACKETS } from "./constants.js";

export function registerSettings() {

  // ── Bracket Thresholds (stored as JSON object) ────────────────────────────
  // We register the raw thresholds object so it can be patched by a settings
  // configurator or future UI. GM edits these via the AWC Settings dialog.
  game.settings.register(MODULE_ID, "bracketThresholds", {
    name: "AWC.Settings.BracketThresholds.Name",
    hint: "AWC.Settings.BracketThresholds.Hint",
    scope: "world",
    config: false, // managed via custom dialog, not the default settings menu
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

  // ── Show slot panel on character sheet ────────────────────────────────────
  game.settings.register(MODULE_ID, "showSlotPanel", {
    name: "AWC.Settings.ShowSlotPanel.Name",
    hint: "AWC.Settings.ShowSlotPanel.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshAllSheets(),
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
