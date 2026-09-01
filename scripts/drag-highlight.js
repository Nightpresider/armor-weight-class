/**
 * drag-highlight.js
 * While any item is being dragged (from a doll slot OR the sheet's own inventory list), every
 * doll slot that would accept a drop of that item pulses red (occupied - swaps out the current
 * occupant) or yellow (empty - a plain fill), and whichever is currently nearest the cursor
 * gets a green override on top, showing where an imprecise "drop anywhere" gesture would land.
 *
 * A drag starting on the doll itself calls applyDropHighlights() directly from its own
 * dragstart handler (paper-doll-app.js's _onDragStart, doll-embed.js's onDragStart).
 *
 * A drag starting OUTSIDE the doll (inventory list, Favorites, a compendium) is caught here
 * instead, via a CAPTURE-phase document listener reading data-uuid straight off event.target -
 * not via dataTransfer, whose payload is only reliably readable by a listener guaranteed to run
 * after the source's own dragstart handler calls setData(), an ordering Foundry/dnd5e's own
 * drag wiring doesn't guarantee here. Capture always reaches document before any bubble-phase
 * source handler runs (stopPropagation included), so this works regardless of what they do.
 */
import { isItemEligibleForSlot, slotFromElement, itemForSlot, renderPocketSlots, positionPickerAboveSlot, resolveDroppedItem, handleTargetedPocketDrop, isHalfModeEmbedded } from "./apps/paper-doll-app.js";
import { isPocketEligible, pocketHasRoom, getPocketedItems } from "./paired-slots.js";
import { DRAG_OCCUPIED_CLASS as OCCUPIED_CLASS, DRAG_EMPTY_CLASS as EMPTY_CLASS, DRAG_TARGET_CLASS as DROP_TARGET_CLASS } from "./constants.js";

export function applyDropHighlights(item) {
  if (!item) return;

  // Any picker/viewer already open (from a prior click - the equip-picker, or a pocket
  // viewer/picker) would otherwise sit exactly on top of / underneath the drag-revealed pocket
  // window this function is about to open for the same carrier, at the identical position -
  // two visually-indistinguishable popups competing for the same drop, only one of which is
  // actually wired for it. Starting a drag always closes them first.
  document.querySelectorAll(".awc-doll-picker").forEach(el => el.remove());

  // The dragged item's own actor stands in for "which doll to highlight" - matches the
  // common case (dragging from your own actor's inventory to your own actor's doll)
  // without needing every slot element to carry its own actor reference; multiple
  // simultaneously-open dolls for different actors aren't disambiguated by this.
  const actor = item.parent;

  document.querySelectorAll(".awc-doll-slot").forEach(el => {
    const slot = slotFromElement(el);
    if (!isItemEligibleForSlot(item, slot)) return;
    const occupant = actor ? itemForSlot(actor, slot) : null;
    el.classList.add(occupant ? OCCUPIED_CLASS : EMPTY_CLASS);
  });
  if (actor) applyPocketHighlights(actor, item);
  startProximityTracking();
}

/**
 * Layered on top of the pass above — a pocket carrier follows the exact same red/yellow
 * meaning as every other slot (full = occupied, would displace; has room = empty, would
 * just fill), not a separate color scheme, so the single proximity-tracked green "current
 * pick" override in startProximityTracking() applies to it uniformly too. Beyond just
 * recoloring the carrier's own slot, its pocket window is popped open right on the doll
 * (openDragPocketWindow) so each individual pocket slot becomes its own colored, droppable
 * target too - not just "drop on the carrier in general".
 */
function applyPocketHighlights(actor, item) {
  document.querySelectorAll(".awc-doll-slot").forEach(el => {
    const carrier = itemForSlot(actor, slotFromElement(el));
    if (!carrier || !isPocketEligible(item, carrier)) return;
    el.classList.remove(OCCUPIED_CLASS, EMPTY_CLASS);
    el.classList.add(pocketHasRoom(actor, carrier) ? EMPTY_CLASS : OCCUPIED_CLASS);
    openDragPocketWindow(el, actor, carrier);
  });
}

const openDragPocketWindows = [];

/**
 * Reveals `carrier`'s pocket-slot grid right on the doll for the duration of the current drag
 * - each slot box is itself a real drop target (renderPocketSlots' onDropTarget), colored the
 * same red/yellow as everything else here so proximity tracking below picks it up too (it
 * queries ANY .awc-doll-slot carrying these classes, wherever in the DOM it lives). Dropping on
 * an already-filled slot displaces exactly that item; dropping on an empty one just fills it -
 * distinct from dropping on the carrier's own doll slot, which still displaces the oldest
 * pocketed item (handlePocketDrop, unchanged). Torn down on dragend by clearDropHighlights().
 */
function openDragPocketWindow(carrierSlotEl, actor, carrier) {
  const inner = document.createElement("div");
  const embedded = carrierSlotEl.closest(".awc-doll-embedded");
  inner.classList.add("awc-doll-picker", ...(embedded
    ? ["awc-doll-picker-embedded", ...(isHalfModeEmbedded(carrierSlotEl) ? [] : ["awc-doll-picker-full"])]
    : []));
  document.body.appendChild(inner);
  positionPickerAboveSlot(inner, carrierSlotEl);

  renderPocketSlots(inner, carrier, getPocketedItems(actor, carrier), {
    onDropTarget: async (event, existingItem) => {
      const dropped = await resolveDroppedItem(event, actor);
      if (dropped && isPocketEligible(dropped, carrier)) await handleTargetedPocketDrop(actor, dropped, carrier, existingItem);
    },
  });

  openDragPocketWindows.push(inner);
}

export function clearDropHighlights() {
  stopProximityTracking();
  document.querySelectorAll(`.${OCCUPIED_CLASS}, .${EMPTY_CLASS}, .${DROP_TARGET_CLASS}`)
    .forEach(el => el.classList.remove(OCCUPIED_CLASS, EMPTY_CLASS, DROP_TARGET_CLASS));
  openDragPocketWindows.splice(0).forEach(el => el.remove());
}

let _trackingHandler = null;

/**
 * With two or more slots eligible at once (e.g. a Light weapon's Main and Secondary hand),
 * the red/yellow pulse alone can't tell a player which one they're actually about to land
 * in - especially once "drop anywhere" means they never need to be precisely over one at
 * all. A single document-level dragover listener continuously finds whichever eligible slot's
 * center is nearest the live cursor position and gives it the green override - a plain
 * nearest-neighbor "magnetic snap", so the intended slot gets selected earlier and more
 * confidently the more directly the cursor moves toward it, with no special weighting needed.
 * Passive: only reads cursor position and toggles classes, never calls preventDefault - that's
 * already handled by the existing per-slot and .awc-doll-content dragover listeners.
 */
function startProximityTracking() {
  stopProximityTracking();
  _trackingHandler = event => {
    const candidates = document.querySelectorAll(`.awc-doll-slot.${OCCUPIED_CLASS}, .awc-doll-slot.${EMPTY_CLASS}`);
    let nearest = null;
    let nearestDist = Infinity;
    candidates.forEach(el => {
      const rect = el.getBoundingClientRect();
      const dist = Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2));
      if (dist < nearestDist) { nearestDist = dist; nearest = el; }
    });
    candidates.forEach(el => el.classList.toggle(DROP_TARGET_CLASS, el === nearest));
  };
  document.addEventListener("dragover", _trackingHandler);
}

function stopProximityTracking() {
  if (_trackingHandler) document.removeEventListener("dragover", _trackingHandler);
  _trackingHandler = null;
}

async function onExternalDragStart(event) {
  const uuid = event.target.closest?.("[data-uuid]")?.dataset.uuid;
  if (!uuid) return;

  let item;
  try { item = await fromUuid(uuid); }
  catch { return; }
  if (item?.documentName === "Item") applyDropHighlights(item);
}

export function registerDragHighlight() {
  document.addEventListener("dragstart", onExternalDragStart, true);
  document.addEventListener("dragend", clearDropHighlights, true);
}
