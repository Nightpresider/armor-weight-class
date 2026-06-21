# Armor Weight Class

A Foundry VTT module for **D&D 5e** that replaces three core systems:

| Replaced | With |
|----------|------|
| Static armor type (Light/Medium/Heavy) | Weight-bracket system derived from equipped weight vs. capacity |
| `STR × 15` carry capacity | Nonlinear `floor(STR² / 2)` formula |
| dnd5e AC formula (armor type logic) | `10 + max(DexMod, ConMod) + Σ(item AC bonuses) + misc effects` |

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

## Carry Capacity Formula

```
capacity = floor(STR² / 2)
```

| STR | Capacity |
|-----|----------|
|  8  |  32 lbs  |
| 10  |  50 lbs  |
| 14  |  98 lbs  |
| 18  | 162 lbs  |
| 20  | 200 lbs  |

---

## Armor Brackets

Brackets are calculated from: `equippedArmorWeight / capacity × 100%`

| Bracket | Default Range | Speed Penalty | Disadvantage |
|---------|--------------|---------------|--------------|
| Unarmored | 0–25% | — | — |
| Light | 25–50% | — | — |
| Medium | 50–75% | −5 ft | — |
| Heavy | 75–100% | −10 ft | DEX & CON checks |
| Overburdened | >100% | −20 ft | STR, DEX & CON checks |

Thresholds are adjustable per-world in **Game Settings → Module Settings** (4 sliders: Unarmored→Light, Light→Medium, Medium→Heavy, Heavy→Overburdened).

---

## AC Formula

```
AC = 10 + max(DexMod, ConMod) + Σ(equippedItem.acBonus) + activeEffectBonuses
```

- The system's armor-type AC logic is fully bypassed.
- Active Effects targeting `system.attributes.ac.bonus` still apply (Shield spell, etc.).
- A visual formula breakdown is displayed on the character sheet.

---

## Equipment Slots

Every character has 4 equipment slots: **Helmet, Breast, Gauntlet, Boots**.

- Only one item per slot at a time.
- Equipping a new item into an occupied slot auto-unequips the previous one (with a chat notification).
- Slot is read from the item's native dnd5e **Equipment Type** dropdown (Helmet/Breast/Gauntlet/Boots), which this module adds alongside Clothing and Jewelry sub-types.
- AC bonus is read from the item's native **Armor Class** field — no separate AWC field needed.

### Setting up an item

1. Open the item sheet for any equipment piece.
2. Set **Equipment Type** to one of the armor slots (Helmet/Breast/Gauntlet/Boots).
3. Set the **Armor Class** value — this becomes the item's AC contribution.
4. Save. The item will now contribute to capacity, AC, and bracket calculations once equipped.

Existing items from before this module was installed can be bulk-migrated with `awc-migration-macro.js` — see the comment header in that file for instructions.

---

## GM Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Unarmored → Light Threshold | 25% | Lower bound of Light bracket |
| Light → Medium Threshold | 50% | Lower bound of Medium bracket |
| Medium → Heavy Threshold | 75% | Lower bound of Heavy bracket |
| Heavy → Overburdened Threshold | 100% | Lower bound of Overburdened bracket |
| Apply Bracket Penalties | On | Speed/disadvantage penalties per bracket |
| Show AC Breakdown | On | Formula display on character sheet |
| Show Slot Panel | On | 4-slot equipment panel on character sheet |

---

## Macro API

```js
// Full capacity snapshot for selected actor
const actor = canvas.tokens.controlled[0]?.actor;
const data = game.awc.getCapacityData(actor);
// { strScore, capacity, equippedWeight, ratio, pct, bracket }

// Force-recompute AC for an actor (returns breakdown object)
game.awc.applyCustomAC(actor);
// { base:10, dexMod, conMod, baseMod, usedAbility, itemBonus, miscBonus, total }

// Flag namespace for reading stored flags
actor.flags[game.awc.FLAG_NS]?.armorBracket   // "light"
actor.flags[game.awc.FLAG_NS]?.capacity        // 98
actor.flags[game.awc.FLAG_NS]?.equippedWeight  // 24
```

---

## Compatibility

| Software | Version |
|----------|---------|
| Foundry VTT | 12 – 14 |
| dnd5e system | 3.0 – 4.3 |

---

## License

MIT
