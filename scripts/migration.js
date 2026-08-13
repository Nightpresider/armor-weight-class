/**
 * migration.js
 * One-time, automatic, GM-only migration that runs on `ready`:
 *   (a) copies fvtt-paper-doll-ui's world-level appearance/behaviour settings
 *       into AWC's own namespaced settings;
 *   (b) copies its per-actor doll-config flags (portrait override, object
 *       fit, auto-open) into AWC's flag namespace;
 *   (c) resolves any equipped-item states that were valid under the old,
 *       far-looser exclusivity rules but are no longer valid under AWC's
 *       widened slot system (e.g. two rings, or a Crown and a Hat both
 *       equipped at once), reporting every change to the GM.
 *
 * Never touches fvtt-paper-doll-ui's own files/data — only reads its world
 * settings (via the raw Setting-document storage, which works even after
 * that module has been disabled and its own game.settings.register() calls
 * no longer run this session) and actor flags (plain document data, always
 * readable regardless of the old module's active state).
 */

import { MODULE_ID, FLAG_NS, SLOT_TYPES, SLOT_KEYS } from "./constants.js";
import { getItemSlot, getConflictingSlotKeys } from "./slots.js";
import { getHandSlotState, getRingSlotState, getAllExemptItems, isTwoHanded } from "./paired-slots.js";

const LOG = `${MODULE_ID} |`;
const OLD_MODULE_ID = "fvtt-paper-doll-ui";

export async function runMigration() {
  if (!game.user.isGM) return;
  // Only one GM should run this if several are connected simultaneously.
  if (game.users.activeGM?.id !== game.user.id) return;

  const schemaVersion = game.settings.get(MODULE_ID, "dataSchemaVersion");
  if (schemaVersion >= 1) return;

  console.log(`${LOG} Running one-time migration from ${OLD_MODULE_ID}…`);

  const worldConfigChanged = await migrateWorldConfig();
  const actorFlagCount = await migrateActorFlags();
  const capacityReport = await resolveOverCapacity();

  await game.settings.set(MODULE_ID, "dataSchemaVersion", 1);

  if (worldConfigChanged || actorFlagCount > 0 || capacityReport.length > 0) {
    await postMigrationReport(worldConfigChanged, actorFlagCount, capacityReport);
  }

  console.log(`${LOG} Migration complete (worldConfig: ${worldConfigChanged}, actorFlags: ${actorFlagCount}, capacityFixes: ${capacityReport.length})`);
}

// ─── (a) World config copy ────────────────────────────────────────────────────

function readOldWorldSetting(key) {
  const entry = game.settings.storage.get("world")?.find(s => s.key === `${OLD_MODULE_ID}.${key}`);
  return entry?.value;
}

// Best-effort mapping from the old module's hardcoded default slot
// categories to AWC's own slot keys. Only the FIRST image in each category
// is migrated — a GM who used "+Add" to build extra custom slots (with
// bespoke filters) will have made judgment calls that can't be reverse-
// engineered automatically; those need to be re-picked by hand using the
// new right-click-an-empty-slot image picker in AWCPaperDoll. This is a
// starting point, not a guaranteed 1:1 recreation of a heavily customized
// old layout.
const LEGACY_SLOT_IMAGE_MAP = [
  { path: ["LEFT", "HEAD"], target: ["slotImages", "helmet"] },
  { path: ["LEFT", "CAPE"], target: ["slotImages", "cape"] },
  { path: ["LEFT", "BODY"], target: ["slotImages", "breast"] },
  { path: ["LEFT", "GLOVES"], target: ["slotImages", "gauntlet"] },
  { path: ["LEFT", "BOOTS"], target: ["slotImages", "boots"] },
  { path: ["RIGHT", "PENDANT"], target: ["slotImages", "necklace"] },
  { path: ["RIGHT", "RING"], target: ["ringImage", null] },
  // The old module had no melee/ranged distinction, only left/right — maps
  // reasonably onto AWC's melee (left group) / ranged (right group) split.
  { path: ["BOTTOM_LEFT_MAIN", "MAIN_LEFT"], target: ["handImage", "melee"] },
  { path: ["BOTTOM_RIGHT_MAIN", "MAIN_RIGHT"], target: ["handImage", "ranged"] },
];

async function migrateSlotImages(globalConfig) {
  const slots = globalConfig?.SLOTS;
  if (!slots || typeof slots !== "object") return false;

  const dollLayout = game.settings.get(MODULE_ID, "dollLayout") ?? {};
  let changed = false;

  for (const { path, target } of LEGACY_SLOT_IMAGE_MAP) {
    const img = slots?.[path[0]]?.[path[1]]?.[0]?.img;
    if (!img) continue;
    const [topKey, subKey] = target;
    if (subKey) {
      dollLayout[topKey] ??= {};
      if (dollLayout[topKey][subKey]) continue; // don't clobber an already-set value (e.g. a second MAIN_* pass)
      dollLayout[topKey][subKey] = img;
    } else {
      if (dollLayout[topKey]) continue;
      dollLayout[topKey] = img;
    }
    changed = true;
  }

  if (changed) await game.settings.set(MODULE_ID, "dollLayout", dollLayout);
  return changed;
}

async function migrateWorldConfig() {
  let changed = false;

  const globalConfig = readOldWorldSetting("globalConfig");
  if (globalConfig && typeof globalConfig === "object") {
    if (globalConfig.MAIN_COLOR) { await game.settings.set(MODULE_ID, "dollMainColor", globalConfig.MAIN_COLOR); changed = true; }
    if (await migrateSlotImages(globalConfig)) changed = true;
  }

  const position = readOldWorldSetting("paperDollPosition");
  if (position) { await game.settings.set(MODULE_ID, "dollPosition", position); changed = true; }

  const hideText = readOldWorldSetting("hideActorHeaderText");
  if (hideText !== undefined) { await game.settings.set(MODULE_ID, "dollHideHeaderText", hideText); changed = true; }

  const allowNonOwned = readOldWorldSetting("allowNonOwned");
  if (allowNonOwned !== undefined) { await game.settings.set(MODULE_ID, "dollAllowNonOwned", allowNonOwned); changed = true; }

  const playerOwnedOnly = readOldWorldSetting("playerOwnedOnly");
  if (playerOwnedOnly !== undefined) { await game.settings.set(MODULE_ID, "dollPlayerOwnedOnly", playerOwnedOnly); changed = true; }

  // `autoOpen` on the old module is client-scoped, so it isn't present in
  // world storage at all — there's nothing to migrate per-client from here.
  // Users can re-toggle AWC's own dollAutoOpen from the settings menu.

  return changed;
}

// ─── (b) Per-actor config flag copy ──────────────────────────────────────────

async function migrateActorFlags() {
  let count = 0;
  for (const actor of game.actors) {
    const old = actor.flags?.[OLD_MODULE_ID];
    if (!old) continue;

    const update = {};
    if (old.img) update[`flags.${FLAG_NS}.dollImg`] = old.img;
    if (old.objectFit) update[`flags.${FLAG_NS}.dollObjectFit`] = old.objectFit;
    if (old.autoOpen) update[`flags.${FLAG_NS}.dollAutoOpen`] = old.autoOpen;

    if (Object.keys(update).length) {
      await actor.update(update, { render: false });
      count++;
    }
  }
  return count;
}

// ─── (c) Over-capacity resolution ────────────────────────────────────────────

function acContribution(item) {
  const v = Number(item.system?.armor?.value ?? 0);
  return isNaN(v) ? 0 : v;
}

/** Keep the best (highest AC, then earliest-created) item; unequip the rest. */
async function keepBestUnequipRest(items, report, actorName, slotLabel) {
  if (items.length <= 1) return;
  const sorted = [...items].sort((a, b) => {
    const acDiff = acContribution(b) - acContribution(a);
    if (acDiff !== 0) return acDiff;
    return (a.sort ?? 0) - (b.sort ?? 0);
  });
  const [keep, ...drop] = sorted;
  for (const item of drop) {
    await item.update({ "system.equipped": false }, { render: false });
    report.push({ actor: actorName, kept: keep.name, unequipped: item.name, slot: slotLabel });
  }
}

async function resolveOverCapacity() {
  const report = [];

  for (const actor of game.actors) {
    if (actor.type !== "character") continue;

    // 1. Same exact slot equipped more than once (e.g. two Necklaces) — every
    //    non-paired sub-type is now exclusive, which wasn't enforced before
    //    this merge for anything except the original 4 armor slots.
    const bySlot = {};
    for (const item of actor.items) {
      if (!item.system?.equipped) continue;
      const slot = getItemSlot(item);
      if (!slot || SLOT_TYPES[slot]?.paired) continue;
      (bySlot[slot] ??= []).push(item);
    }
    for (const [slot, items] of Object.entries(bySlot)) {
      await keepBestUnequipRest(items, report, actor.name, SLOT_TYPES[slot]?.label ?? slot);
    }

    // 2. Cross-slot conflict pairs both occupied at once (e.g. Crown + Hat).
    //    Re-read bySlot's survivors so we don't double-report an item that
    //    step 1 already removed.
    const stillEquipped = (slot) => actor.items.find(i => i.system?.equipped && getItemSlot(i) === slot);
    const seenPairs = new Set();
    for (const slot of SLOT_KEYS) {
      if (SLOT_TYPES[slot]?.paired) continue;
      for (const other of getConflictingSlotKeys(slot)) {
        const pairKey = [slot, other].sort().join("|");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const a = stillEquipped(slot);
        const b = stillEquipped(other);
        if (a && b) {
          await keepBestUnequipRest([a, b], report, actor.name, `${SLOT_TYPES[slot]?.label ?? slot} / ${SLOT_TYPES[other]?.label ?? other}`);
        }
      }
    }

    // 3. Hand-slot overflow: more equipped weapons/non-exempt-shields than
    //    the 2 real hands (Main/Secondary, accounting for two-handed
    //    collapse) can physically hold. getHandSlotState() resolves which
    //    items actually occupy a hand across its 4 render boxes — anything
    //    hand-eligible but not among them has nowhere to go.
    const handState = getHandSlotState(actor);
    const handOccupants = new Set(
      [handState.meleeMain, handState.meleeSecondary, handState.rangedMain, handState.rangedSecondary]
        .map(box => box.item).filter(Boolean).map(i => i.id)
    );
    const eligibleWeapons = actor.items.filter(i => i.system?.equipped && (i.type === "weapon" || (i.type === "equipment" && getItemSlot(i) === "shield")));
    const overflow = eligibleWeapons.filter(i => !handOccupants.has(i.id) && !isTwoHanded(i));
    for (const item of overflow) {
      await item.update({ "system.equipped": false }, { render: false });
      report.push({ actor: actor.name, kept: null, unequipped: item.name, slot: "Hand Slot (capacity)" });
    }

    // 4. Ring overflow: more than 2 equipped rings.
    const ringState = getRingSlotState(actor);
    const ringOccupants = new Set([ringState.main, ringState.secondary].filter(Boolean).map(i => i.id));
    const allRings = actor.items.filter(i => i.system?.equipped && getItemSlot(i) === "ring");
    const ringOverflow = allRings.filter(i => !ringOccupants.has(i.id));
    for (const item of ringOverflow) {
      await item.update({ "system.equipped": false }, { render: false });
      report.push({ actor: actor.name, kept: null, unequipped: item.name, slot: "Ring Slot (capacity)" });
    }

    // 5. Exempt-slot overflow: more than 1 equipped ignoresHandSlot item
    //    (the Exempt position is single-capacity — see paired-slots.js).
    const exemptItems = getAllExemptItems(actor);
    if (exemptItems.length > 1) {
      await keepBestUnequipRest(exemptItems, report, actor.name, "Exempt Slot (capacity)");
    }
  }

  return report;
}

// ─── GM Report ────────────────────────────────────────────────────────────────

async function postMigrationReport(worldConfigChanged, actorFlagCount, capacityReport) {
  const rows = capacityReport.map(r =>
    `<li><strong>${r.actor}</strong> — unequipped <em>${r.unequipped}</em> (${r.slot})${r.kept ? ` in favor of <em>${r.kept}</em>` : ""}</li>`
  ).join("");

  const content = `
    <div class="awc-migration-report">
      <h3>${game.i18n.localize("AWC.Notify.MigrationReport.Title")}</h3>
      <p>${game.i18n.format("AWC.Notify.MigrationReport.Summary", {
        world: worldConfigChanged ? game.i18n.localize("AWC.Notify.MigrationReport.Yes") : game.i18n.localize("AWC.Notify.MigrationReport.No"),
        actors: actorFlagCount,
      })}</p>
      ${rows ? `<p>${game.i18n.localize("AWC.Notify.MigrationReport.CapacityHeading")}</p><ul>${rows}</ul>` : ""}
    </div>
  `;

  await ChatMessage.create({
    content,
    whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
  });
}
