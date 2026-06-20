# Armor Weight Class

A Foundry VTT module for **D&D 5e** that replaces the static armor type system
(Light / Medium / Heavy) with a dynamic weight class derived from:

> **Armor Weight Class = Equipped Armor Weight ÷ Carry Capacity × 100%**

The thresholds that define each class are fully adjustable by the GM in
**Game Settings → Module Settings → Armor Weight Class**.

---

## Installation

### From the Foundry module browser
1. Open Foundry VTT → **Add-on Modules** → **Install Module**
2. Paste the manifest URL or search for `armor-weight-class`
3. Click Install, then enable the module in your world

### Manual install
1. Download or clone this repository
2. Copy the `armor-weight-class/` folder into your Foundry `Data/modules/` directory
3. Restart Foundry and enable the module in your world

---

## How it works

| Step | Detail |
|------|--------|
| **Armor weight** | Sum of `weight` on all equipped items with an armor subtype (light/medium/heavy/natural/shield) |
| **Carry capacity** | Uses the system's computed encumbrance max (`STR × 15` by default, respects variant encumbrance if enabled) |
| **Ratio** | `armorWeight / carryCapacity × 100` — capped at 100% for display |
| **Class** | Compared against the GM-set Light and Medium thresholds; anything above the Medium threshold is Heavy |

---

## GM Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Light Armor Threshold (%)** | 33 | Ratio below this = Light |
| **Medium Armor Threshold (%)** | 66 | Ratio below this = Medium; above = Heavy |
| **Show Weight Class Indicator** | On | Displays the badge + progress bar on character sheets |
| **Apply Encumbrance Penalties** | Off | If enabled, Heavy armor class imposes −10 ft speed and disadvantage on Str/Dex/Con checks (in-memory, not saved as Active Effects) |

---

## Macro / API

The module exposes a small API at `game.awc` for use in macros:

```js
// Get full weight data for the selected token's actor
const actor = canvas.tokens.controlled[0]?.actor;
const data = game.awc.getArmorWeightData(actor);
console.log(data);
// {
//   armorWeight: 15,       // lbs
//   carryCapacity: 150,    // lbs
//   ratio: 10,             // percent
//   weightClass: "light",
//   label: "Light",
//   hasArmor: true
// }

// Just get the carry capacity
game.awc.getCarryCapacity(actor); // → 150

// Classify a raw ratio manually
game.awc.classifyArmorWeight(40); // → "medium"
```

---

## Compatibility

| Software | Version |
|----------|---------|
| Foundry VTT | 11 – 12 |
| dnd5e system | 3.0 – 3.3 |

---

## License

MIT — free to use, modify, and redistribute.
