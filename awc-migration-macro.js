/**
 * AWC Overhaul — Item Migration Macro
 *
 * Run this once as a GM to auto-assign slotType and acBonus
 * to existing armor items based on their dnd5e data.
 *
 * HOW TO USE:
 *   1. Open a Macro (create new, type: Script)
 *   2. Paste this entire file into the macro body
 *   3. Run it as GM
 *   4. Check the chat log for a migration report
 *
 * WHAT IT DOES:
 *   - Scans every item on every actor in the world
 *   - Also scans the Items compendium sidebar (world items)
 *   - For each equipment item with armor data:
 *       · Assigns a slot (chest / shield) where inferrable
 *       · Sets acBonus from system.armor.value
 *   - Skips items that already have AWC flags set
 *   - Reports skipped, updated, and unresolved items
 *
 * WHAT IT CANNOT AUTO-DETECT:
 *   - Boots, gloves, helmets — dnd5e has no separate subtypes for these.
 *     These will be listed in the report as "needs manual slot assignment".
 */

const MODULE_ID = "armor-weight-class";
const FLAG_NS   = MODULE_ID;

// ── Slot inference map ────────────────────────────────────────────────────────
// Keys are dnd5e armor subtypes; values are our slot keys.
// Subtypes not listed here cannot be auto-inferred.
const SUBTYPE_TO_SLOT = {
  light:   "chest",
  medium:  "chest",
  heavy:   "chest",
  natural: "chest",
  bonus:   "chest",
  shield:  "shield",
};

// ── Collect all items to migrate ──────────────────────────────────────────────
const actorItems   = [];
const worldItems   = [];

// Actor-owned items
for (const actor of game.actors) {
  if (actor.type !== "character" && actor.type !== "npc") continue;
  for (const item of actor.items) {
    if (item.type === "equipment") actorItems.push(item);
  }
}

// World (sidebar) items
for (const item of game.items) {
  if (item.type === "equipment") worldItems.push(item);
}

const allItems = [...actorItems, ...worldItems];

// ── Migration pass ────────────────────────────────────────────────────────────
const results = {
  updated:  [],
  skipped:  [],   // already has AWC flags
  manual:   [],   // armor but slot cannot be inferred
  ignored:  [],   // not armor / no armor data
};

for (const item of allItems) {
  const armorType = item.system?.armor?.type;

  // Not an armor piece at all
  if (!armorType || armorType === "trinket" || armorType === "clothing") {
    results.ignored.push(item.name);
    continue;
  }

  // Already migrated — skip
  const existingSlot  = item.getFlag?.(FLAG_NS, "slotType");
  const existingBonus = item.getFlag?.(FLAG_NS, "acBonus");
  if (existingSlot !== undefined || existingBonus !== undefined) {
    results.skipped.push(`${item.name} (actor: ${item.actor?.name ?? "world"})`);
    continue;
  }

  const inferredSlot = SUBTYPE_TO_SLOT[armorType] ?? null;
  const acValue      = item.system?.armor?.value ?? 0;

  if (!inferredSlot) {
    // Armor type exists but we can't infer the slot (e.g. a custom subtype)
    results.manual.push({
      name:  item.name,
      actor: item.actor?.name ?? "world items",
      type:  armorType,
      ac:    acValue,
    });
    // Still set the AC bonus even if we can't set the slot
    await item.setFlag(FLAG_NS, "acBonus", acValue);
    continue;
  }

  // Apply flags
  await item.setFlag(FLAG_NS, "slotType", inferredSlot);
  await item.setFlag(FLAG_NS, "acBonus",  acValue);

  results.updated.push({
    name:  item.name,
    actor: item.actor?.name ?? "world items",
    slot:  inferredSlot,
    ac:    acValue,
  });
}

// ── Build chat report ─────────────────────────────────────────────────────────
const lines = [
  `<h3>AWC Overhaul — Migration Report</h3>`,
  `<p><strong>${results.updated.length}</strong> items updated &nbsp;|&nbsp;
   <strong>${results.skipped.length}</strong> already set &nbsp;|&nbsp;
   <strong>${results.manual.length}</strong> need manual slot &nbsp;|&nbsp;
   <strong>${results.ignored.length}</strong> ignored (non-armor)</p>`,
];

if (results.updated.length) {
  lines.push(`<p><strong>✅ Updated:</strong></p><ul>`);
  for (const r of results.updated) {
    lines.push(`<li>${r.name} <em>(${r.actor})</em> → slot: <b>${r.slot}</b>, AC bonus: <b>+${r.ac}</b></li>`);
  }
  lines.push(`</ul>`);
}

if (results.manual.length) {
  lines.push(`<p><strong>⚠️ AC bonus set, but slot needs manual assignment:</strong></p><ul>`);
  for (const r of results.manual) {
    lines.push(`<li>${r.name} <em>(${r.actor})</em> — dnd5e type: <b>${r.type}</b>, AC: <b>+${r.ac}</b></li>`);
  }
  lines.push(`</ul><p><em>Open each item sheet and assign a slot under the AWC Overhaul fieldset.</em></p>`);
}

if (results.skipped.length) {
  lines.push(`<details><summary>Already migrated (${results.skipped.length})</summary><ul>`);
  for (const name of results.skipped) lines.push(`<li>${name}</li>`);
  lines.push(`</ul></details>`);
}

ChatMessage.create({
  content: lines.join("\n"),
  whisper: [game.user.id],
});

console.log(`${MODULE_ID} | Migration complete`, results);
