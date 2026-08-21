/**
 * target-icons.js
 * Small inline-SVG line-art icons for the 9 area-effect shapes dnd5e
 * defines (CONFIG.DND5E.areaTargetTypes) — sphere/cone/cube/cylinder/
 * line/wall/emanation("radius")/circle/square. Used by sheet-inject.js's
 * iconifyTargetColumn to replace the shape WORD in the Target column with
 * one of these, keeping the leading size/unit text ("5 ft") in front of
 * it.
 *
 * Deliberately simple stroke-only line art (no fill, currentColor) rather
 * than a pixel-accurate copy of any reference image — one of the user's
 * own reference images carried a stock-photo watermark, so these are
 * original icons in the same spirit (thick outline, dashed lines for the
 * shape's hidden/back edges), not a trace of that art.
 */

const ICON_BODY = {
  sphere: `
    <circle cx="8" cy="8" r="6.5"/>
    <ellipse cx="8" cy="8" rx="6.5" ry="2.2"/>
    <line x1="8" y1="1.5" x2="8" y2="14.5" stroke-dasharray="1.5 1.5"/>
  `,
  cone: `
    <path d="M8 1 L2.5 12.5 L13.5 12.5 Z"/>
    <ellipse cx="8" cy="12.5" rx="5.5" ry="1.6" stroke-dasharray="1.4 1.4"/>
  `,
  cube: `
    <path d="M8 1.5 L2 5 L2 11.5 L8 15 L14 11.5 L14 5 Z"/>
    <path d="M8 1.5 L8 8.5 M8 8.5 L2 11.5 M8 8.5 L14 11.5" stroke-dasharray="1.3 1.3"/>
  `,
  cylinder: `
    <ellipse cx="8" cy="4.2" rx="5.5" ry="2.2"/>
    <line x1="2.5" y1="4.2" x2="2.5" y2="11.5"/>
    <line x1="13.5" y1="4.2" x2="13.5" y2="11.5"/>
    <path d="M2.5 11.5 A5.5 2.2 0 0 0 13.5 11.5"/>
    <path d="M2.5 11.5 A5.5 2.2 0 0 1 13.5 11.5" stroke-dasharray="1.3 1.3"/>
  `,
  line: `
    <line x1="2" y1="8" x2="14" y2="8"/>
  `,
  wall: `
    <rect x="1.5" y="3.5" width="6" height="3.5"/>
    <rect x="7.5" y="3.5" width="6" height="3.5"/>
    <rect x="1.5" y="7.5" width="3" height="3.5"/>
    <rect x="4.5" y="7.5" width="6" height="3.5"/>
    <rect x="10.5" y="7.5" width="3" height="3.5"/>
  `,
  emanation: `
    <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/>
    <circle cx="8" cy="8" r="4" stroke-dasharray="1.2 1.2"/>
    <circle cx="8" cy="8" r="7" stroke-dasharray="1.4 1.4"/>
  `,
  circle: `
    <circle cx="8" cy="8" r="6.5"/>
  `,
  square: `
    <rect x="2" y="2" width="12" height="12"/>
  `,
};

/** Matches the LAST word of dnd5e's own "{number} {shape}" area-target label (en.json's *.Counted strings) — case-insensitive since capitalize() only touches the leading character. */
export const TARGET_SHAPE_PATTERN =
  /^(.*?)\s+(circle|cone|cube|cylinder|emanation|line|sphere|square|wall)$/i;

export function buildTargetShapeSVG(shape) {
  const body = ICON_BODY[shape];
  if (!body) return null;
  return `<svg class="awc-target-shape-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// ─── Individual target types (CONFIG.DND5E.individualTargetTypes) ──────────
//
// 9 types total: self, ally, enemy, creature, object, space,
// creatureOrObject, any, willing. self/ally/enemy/creature/willing all
// reuse the same person silhouette (colored per type via CSS, applied by
// the caller) — self additionally fills it solid rather than outline
// only. creatureOrObject and any had no user-supplied reference; built
// in the same spirit (person + a small object badge; a target reticle)
// rather than left without an icon.

const PERSON_OUTLINE = `
  <circle cx="8" cy="5" r="3"/>
  <path d="M2.5 14.5 A5.5 5.5 0 0 1 13.5 14.5"/>
`;

const INDIVIDUAL_ICON_BODY = {
  creature: PERSON_OUTLINE,
  ally: PERSON_OUTLINE,
  enemy: PERSON_OUTLINE,
  willing: PERSON_OUTLINE,
  // Same silhouette, filled solid instead of outlined — the shoulders
  // need a closed bottom edge to be fillable as a shape at all (the
  // outline version is just an open arc).
  self: `
    <circle cx="8" cy="5" r="3" fill="currentColor" stroke="none"/>
    <path d="M2.5 14.5 A5.5 5.5 0 0 1 13.5 14.5 L13.5 15.5 L2.5 15.5 Z" fill="currentColor" stroke="none"/>
  `,
  space: `
    <rect x="2.5" y="2.5" width="11" height="11" rx="3"/>
  `,
  // Small cube + cone + arc cluster, matching the user's own reference
  // image for "object" (simplified for a 16x16 icon).
  object: `
    <path d="M8.5 9 L5.5 7.3 L5.5 10.7 L8.5 12.4 L11.5 10.7 L11.5 7.3 Z"/>
    <path d="M8.5 9 L8.5 12.4 M8.5 9 L5.5 7.3 M8.5 9 L11.5 7.3"/>
    <path d="M3 6.5 L1 2.3 L5 2.3 Z"/>
    <path d="M12 3.3 A2.4 2.4 0 0 1 14.4 5.7"/>
  `,
};

// "any" deliberately has no icon — that text stays plain font
// (buildIndividualTargetSVG returns null for it, so iconifyTargetColumn's
// caller leaves the label untouched).

/**
 * creatureOrObject: the creature (person) icon and the cube shape, each
 * clipped to one half of the icon along a 45-degree cut — person in the
 * top-left triangle, cube in the bottom-right — rather than a standalone
 * hybrid glyph. Unique clip-path ids per call: multiple rows can render
 * this same type at once, and duplicate SVG ids are invalid even though
 * the clip shape itself is identical every time.
 */
let _creatureOrObjectClipId = 0;

function buildCreatureOrObjectSVG() {
  const id = `awc-coo-clip-${_creatureOrObjectClipId++}`;
  return `<svg class="awc-target-shape-icon awc-target-icon-creatureOrObject" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <defs>
      <clipPath id="${id}-tl"><polygon points="0,0 16,0 0,16"/></clipPath>
      <clipPath id="${id}-br"><polygon points="16,0 16,16 0,16"/></clipPath>
    </defs>
    <g clip-path="url(#${id}-tl)">${PERSON_OUTLINE}</g>
    <g clip-path="url(#${id}-br)">${ICON_BODY.cube}</g>
    <line x1="16" y1="0" x2="0" y2="16" stroke-dasharray="1.2 1.2" opacity="0.6"/>
  </svg>`;
}

/**
 * Matches dnd5e's own individual-target sheet labels (TargetField.
 * prepareData's this.target.affects.labels.sheet — see en.json's
 * DND5E.TARGET.Type.*.Counted/Label strings): "Self", "Any", "1 ally",
 * "Any creatures", "Each object", "3 willing creatures", etc. Checked in
 * this exact order — creatureOrObject/willing BEFORE creature (both
 * contain the substring "creature"), and the bare "Any" exact-match
 * LAST (it's also the {number} filler word inside e.g. "Any objects",
 * which the object/space/etc. patterns above it already claim first).
 */
export const INDIVIDUAL_TARGET_PATTERNS = [
  { type: "self", re: /^self$/i },
  { type: "creatureOrObject", re: /^(.*?)\s+creatures?\s+or\s+objects?$/i },
  { type: "willing", re: /^(.*?)\s+willing\s+creatures?$/i },
  { type: "ally", re: /^(.*?)\s+(?:ally|allies)$/i },
  { type: "enemy", re: /^(.*?)\s+enem(?:y|ies)$/i },
  { type: "creature", re: /^(.*?)\s+creatures?$/i },
  { type: "object", re: /^(.*?)\s+objects?$/i },
  { type: "space", re: /^(.*?)\s+spaces?$/i },
  { type: "any", re: /^any$/i },
];

export function buildIndividualTargetSVG(type) {
  if (type === "creatureOrObject") return buildCreatureOrObjectSVG();

  const body = INDIVIDUAL_ICON_BODY[type];
  if (!body) return null;
  return `<svg class="awc-target-shape-icon awc-target-icon-${type}" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
