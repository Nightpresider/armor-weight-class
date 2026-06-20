/**
 * Armor Weight Class — Foundry VTT Module for dnd5e
 *
 * Replaces static armor type (Light/Medium/Heavy) with a dynamic class
 * derived from: equippedArmorWeight / characterCarryCapacity * 100
 *
 * Thresholds are GM-configurable in Module Settings.
 */

const MODULE_ID = "armor-weight-class";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return the carry capacity (lbs) for an actor using the dnd5e rules.
 * Strength score × 15 (standard 5e rule).
 */
function getCarryCapacity(actor) {
  const str = actor.system?.abilities?.str?.value ?? 10;
  // dnd5e encumbrance variant: if enabled, max is STR * 15, else STR * 15 (same base)
  // We respect the system's own encumbrance calculation if available.
  if (actor.system?.attributes?.encumbrance?.max !== undefined) {
    return actor.system.attributes.encumbrance.max;
  }
  return str * 15;
}

/**
 * Return the total weight (lbs) of all equipped armor items on an actor.
 * Iterates items where type === "equipment" and system.armor exists and
 * the item is equipped (system.equipped === true).
 */
function getEquippedArmorWeight(actor) {
  let total = 0;
  for (const item of actor.items) {
    if (item.type !== "equipment") continue;
    const armorType = item.system?.armor?.type;
    if (!armorType || armorType === "trinket" || armorType === "vehicle") continue;
    // Only count if the item is equipped
    if (!item.system?.equipped) continue;
    total += item.system?.weight?.value ?? item.system?.weight ?? 0;
  }
  return total;
}

/**
 * Given a ratio (0–100), return "light", "medium", or "heavy".
 */
function classifyArmorWeight(ratioPercent) {
  const lightMax = game.settings.get(MODULE_ID, "lightThreshold");
  const mediumMax = game.settings.get(MODULE_ID, "mediumThreshold");

  if (ratioPercent < lightMax) return "light";
  if (ratioPercent < mediumMax) return "medium";
  return "heavy";
}

/**
 * Full calculation result for an actor.
 * Returns { armorWeight, carryCapacity, ratio, weightClass, label }
 */
function getArmorWeightData(actor) {
  const armorWeight = getEquippedArmorWeight(actor);
  const carryCapacity = getCarryCapacity(actor);
  const ratio = carryCapacity > 0 ? (armorWeight / carryCapacity) * 100 : 0;
  const hasArmor = armorWeight > 0;
  const weightClass = hasArmor ? classifyArmorWeight(ratio) : "none";

  const labelKey = `AWC.WeightClass.${weightClass.charAt(0).toUpperCase() + weightClass.slice(1)}`;
  const label = game.i18n.localize(labelKey);

  return { armorWeight, carryCapacity, ratio, weightClass, label, hasArmor };
}

// ─── Encumbrance / Speed Penalties ──────────────────────────────────────────

/**
 * The dnd5e system exposes `actor.system.attributes.movement` but doesn't
 * apply armor-type penalties automatically (that's handled by active effects
 * on the item). We override by injecting an active-effect-like speed
 * modification via a flag and re-evaluating on the prepareData hook.
 *
 * Strategy: store the calculated weight class on the actor as a flag, then
 * use the `dnd5e.computeArmorClass` / `dnd5e.prepareBaseArmorClass` hooks
 * to surface the class, and use `Actor5e#prepareEmbeddedDocuments` shim
 * for speed penalties.
 */
function applyEncumbrancePenalties(actor, weightClass) {
  if (!game.settings.get(MODULE_ID, "applyEncumbrance")) return;

  // We modify the derived speed value on the actor's system data in-memory
  // during the prepareData phase (see hook below). We store the penalty
  // as a flag so sheet renders can read it without re-computing.
  const penalties = {
    none: { speedMod: 0, disadvantage: false },
    light: { speedMod: 0, disadvantage: false },
    medium: { speedMod: 0, disadvantage: false },     // medium: no penalty by default
    heavy: { speedMod: -10, disadvantage: true },     // heavy: -10 ft speed, disadv on Str/Dex/Con
  };

  return penalties[weightClass] ?? penalties.none;
}

// ─── Settings Registration ───────────────────────────────────────────────────

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Armor Weight Class module`);

  game.settings.register(MODULE_ID, "lightThreshold", {
    name: "AWC.Settings.LightThreshold.Name",
    hint: "AWC.Settings.LightThreshold.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 5, max: 60, step: 1 },
    default: 33,
    onChange: () => refreshAllActorSheets(),
  });

  game.settings.register(MODULE_ID, "mediumThreshold", {
    name: "AWC.Settings.MediumThreshold.Name",
    hint: "AWC.Settings.MediumThreshold.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 10, max: 95, step: 1 },
    default: 66,
    onChange: () => refreshAllActorSheets(),
  });

  game.settings.register(MODULE_ID, "showIndicator", {
    name: "AWC.Settings.ShowIndicator.Name",
    hint: "AWC.Settings.ShowIndicator.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshAllActorSheets(),
  });

  game.settings.register(MODULE_ID, "applyEncumbrance", {
    name: "AWC.Settings.ApplyEncumbrance.Name",
    hint: "AWC.Settings.ApplyEncumbrance.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => refreshAllActorSheets(),
  });
});

// ─── Re-render open sheets when settings change ──────────────────────────────

function refreshAllActorSheets() {
  for (const app of Object.values(ui.windows)) {
    if (app instanceof ActorSheet) app.render(false);
  }
}

// ─── Inject weight class data into actor preparation ─────────────────────────

/**
 * After the actor's data is prepared, stash our weight class result
 * so other hooks and the sheet render can use it without recomputing.
 */
Hooks.on("dnd5e.prepareActorData", (actor) => {
  if (actor.type !== "character") return;
  try {
    const data = getArmorWeightData(actor);
    // Store on the actor object for this session (not persisted)
    actor._awc = data;

    // Optionally apply speed penalty in-memory
    if (game.settings.get(MODULE_ID, "applyEncumbrance") && data.weightClass === "heavy") {
      const movement = actor.system?.attributes?.movement;
      if (movement) {
        for (const [key, val] of Object.entries(movement)) {
          if (typeof val === "number" && val > 0) {
            movement[key] = Math.max(0, val - 10);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`${MODULE_ID} | Error preparing actor data:`, e);
  }
});

// ─── Character Sheet Injection ───────────────────────────────────────────────

/**
 * Inject the weight class badge + progress bar into the dnd5e character sheet.
 * Targets the default dnd5e v3 sheet (ActorSheet5eCharacter2) and the
 * legacy sheet (ActorSheet5eCharacter).
 */
Hooks.on("renderActorSheet", (app, html, data) => {
  if (!game.settings.get(MODULE_ID, "showIndicator")) return;
  if (app.actor?.type !== "character") return;

  const actor = app.actor;
  const awc = actor._awc ?? getArmorWeightData(actor);

  if (!awc.hasArmor) return;

  const pct = Math.min(100, Math.round(awc.ratio));
  const colorClass = `awc-${awc.weightClass}`;

  const badge = `
    <div class="awc-badge ${colorClass}" title="${game.i18n.localize("AWC.UI.ArmorRatio")}: ${pct}% of carry capacity">
      <span class="awc-label">${game.i18n.localize("AWC.UI.WeightClassLabel")}</span>
      <span class="awc-class-name">${awc.label}</span>
      <div class="awc-bar-track">
        <div class="awc-bar-fill ${colorClass}" style="width: ${pct}%"></div>
      </div>
      <span class="awc-pct">${pct}%</span>
    </div>
  `;

  // Try to inject near the equipment/encumbrance section
  // dnd5e v3 sheet uses .encumbrance, legacy uses .attributes
  const encumbranceEl = html.find(".encumbrance").first();
  if (encumbranceEl.length) {
    encumbranceEl.after(badge);
    return;
  }

  // Fallback: inject into the attributes tab near AC
  const acEl = html.find('[data-prop="system.attributes.ac.value"], .ac').first();
  if (acEl.length) {
    acEl.closest(".form-group, .attribute").after(badge);
    return;
  }

  // Last resort: append to the header
  html.find(".sheet-header .attributes").append(badge);
});

// ─── Tooltip on armor items in inventory ─────────────────────────────────────

/**
 * Annotate each equipped armor item in the sheet's item list with its
 * contribution to the weight class, shown as a small tag.
 */
Hooks.on("renderActorSheet", (app, html, _data) => {
  if (app.actor?.type !== "character") return;

  const actor = app.actor;
  const carryCapacity = getCarryCapacity(actor);
  if (carryCapacity <= 0) return;

  // Find all item rows and check if they're armor
  html.find(".item[data-item-id]").each((_i, el) => {
    const itemId = el.dataset.itemId;
    const item = actor.items.get(itemId);
    if (!item || item.type !== "equipment") return;

    const armorType = item.system?.armor?.type;
    if (!armorType || armorType === "trinket") return;
    if (!item.system?.equipped) return;

    const weight = item.system?.weight?.value ?? item.system?.weight ?? 0;
    if (weight <= 0) return;

    const itemPct = Math.round((weight / carryCapacity) * 100);
    const tag = `<span class="awc-item-tag">${itemPct}% load</span>`;

    // Inject after item name
    const nameEl = $(el).find(".item-name, .item-title").first();
    if (nameEl.length) nameEl.append(tag);
  });
});

// ─── Override armor weight class on item preparation ─────────────────────────

/**
 * When the system evaluates an armor item's properties (e.g. for AC calculation),
 * we want the effective "type" to reflect our calculated class.
 *
 * We hook into dnd5e's item sheet render to display the effective class,
 * and into the actor's AC preparation to use the computed class.
 */
Hooks.on("dnd5e.prepareArmorClass", (actor, rollData, hook, ac) => {
  if (actor.type !== "character") return;
  const awc = actor._awc ?? getArmorWeightData(actor);
  if (!awc.hasArmor) return;

  // Store effective class on the AC object for downstream use
  ac.equippedArmorWeightClass = awc.weightClass;
});

// ─── GM Macro helper exposed on game.awc ─────────────────────────────────────

Hooks.once("ready", () => {
  // Expose utility API for macros / other modules
  game.awc = {
    getArmorWeightData,
    getCarryCapacity,
    getEquippedArmorWeight,
    classifyArmorWeight,
  };

  console.log(`${MODULE_ID} | Ready. API available at game.awc`);
});
