/**
 * equipped-slots.js
 * Shared data helper for surfacing Paper Doll equipment outside the actor sheet - used by
 * Carousel Combat Tracker's rebuilt tooltip (compat-combat-tracker-dock.js).
 */

import { getSlotMap } from "./slots.js";
import { getHandSlotState, getRingSlotState, getExemptItem } from "./paired-slots.js";

/**
 * Every currently-equipped item across all Paper Doll slot types, deduplicated (a
 * two-handed weapon legitimately occupies more than one hand-slot box).
 */
export function getEquippedSlotItems(actor) {
  const items = new Set();

  for (const item of Object.values(getSlotMap(actor))) {
    if (item) items.add(item);
  }

  for (const box of Object.values(getHandSlotState(actor))) {
    if (box?.item) items.add(box.item);
  }

  const rings = getRingSlotState(actor);
  if (rings.main) items.add(rings.main);
  if (rings.secondary) items.add(rings.secondary);

  const exempt = getExemptItem(actor);
  if (exempt) items.add(exempt);

  return [...items];
}
