const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const BASE_DIR = path.dirname(require.main.filename || process.cwd());
const INPUT_XLSX = path.resolve(BASE_DIR, 'Crafting Chart.xlsx');
const MATERIAL_SOURCE = path.resolve(BASE_DIR, 'material-data-source.json');
const OUTPUT_XLSX = path.resolve(BASE_DIR, 'AKD_Material_Variants_Preview.xlsx');

if (!fs.existsSync(INPUT_XLSX)) {
  console.error(`Missing input workbook: ${INPUT_XLSX}`);
  process.exit(1);
}
if (!fs.existsSync(MATERIAL_SOURCE)) {
  console.error(`Missing material data source: ${MATERIAL_SOURCE}`);
  process.exit(1);
}

const materialSource = JSON.parse(fs.readFileSync(MATERIAL_SOURCE, 'utf8'));
const workbook = XLSX.readFile(INPUT_XLSX, { cellStyles: false });

function normalizeMaterialName(value) {
  if (typeof value !== 'string') return value;
  if (value.toLowerCase() === "dar'ether") return "Dar'ether";
  return value.trim();
}

function materialToken(materialName) {
  return normalizeMaterialName(materialName)
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getMaterialEntry(materialName) {
  return materialSource.materials.find(m => m.name === normalizeMaterialName(materialName));
}

function getMaterialWeightFactor(materialName) {
  const entry = getMaterialEntry(materialName);
  if (!entry) return 1.0;
  if (typeof entry.overrideFactor === 'number') return entry.overrideFactor;
  return materialSource.categories[entry.category]?.weightFactor ?? 1.0;
}

function getIngotWeightFactor(materialName) {
  const entry = getMaterialEntry(materialName);
  if (!entry) return 1.0;
  if (typeof entry.ingotWeightFactor === 'number') return entry.ingotWeightFactor;
  return materialSource.categories[entry.category]?.ingotWeightFactor ?? 1.0;
}

function buildVariantName(sourceName, material) {
  const normalizedMaterial = normalizeMaterialName(material);
  const normalizedSource = /^Iron\s+/i.test(sourceName) ? sourceName : `Iron ${sourceName}`;
  return normalizedSource.replace(/^Iron\s+/i, `${normalizedMaterial} `);
}

function buildVariantImage(sourceImage, material) {
  if (!sourceImage || typeof sourceImage !== 'string') return '';
  return sourceImage.replace(/_iron(\.[a-zA-Z0-9]+)$/i, `_${materialToken(material)}$1`);
}

function formatWeight(weight) {
  if (weight == null || weight === '') return '';
  const numeric = Number(weight);
  return Number.isFinite(numeric) ? numeric : weight;
}

function loadSheetRows(sheetName, defaultType) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    console.warn(`Sheet not found: ${sheetName}`);
    return [];
  }
  return XLSX.utils.sheet_to_json(sheet, { defval: null }).map(row => {
    const name = row.Name || row.name || row['Item Name'] || row['Item'] || row['Weapon Name'] || row['Armor Name'];
    const weight = formatWeight(row.Weight || row.weight || row['Item Weight'] || row['Weight (lb)']);
    const type = row.type || row.Type || row.Category || row['Item Category'] || defaultType;
    const image = row.Image || row.Img || row.ImagePath || row['Image Path'] || '';
    return { ...row, name, weight, type, image };
  }).filter(row => row.name && /^Iron\b/i.test(row.name));
}

const weapons = loadSheetRows('Weapons', 'Weapon');
const armor = loadSheetRows('Armor', 'Armor');
const materialRows = XLSX.utils.sheet_to_json(workbook.Sheets['Material List'] || {}, { defval: null });
let materialNames = materialSource.materials.map(m => m.name);

if (materialRows.length > 0) {
  const extracted = materialRows
    .map(row => row.Material || row.Name || row['Material Name'])
    .filter(v => typeof v === 'string' && v.trim())
    .map(normalizeMaterialName);
  if (extracted.length > 0) {
    materialNames = [...new Set(extracted)];
  }
}

const variantRows = [];
const sourceItems = [...weapons, ...armor];

for (const item of sourceItems) {
  const sourceImage = item.image || '';
  const sourceWeight = item.weight;
  for (const material of materialNames) {
    const variantName = buildVariantName(item.name, material);
    const variantImage = sourceImage ? buildVariantImage(sourceImage, material) : '';
    const factor = getMaterialWeightFactor(material);
    const variantWeight = sourceWeight ? Number((sourceWeight * factor).toFixed(2)) : '';
    variantRows.push({
      SourceType: item.type,
      SourceName: item.name,
      Material: material,
      MaterialCategory: getMaterialEntry(material)?.category || '',
      MaterialWeightFactor: factor,
      SourceWeight: sourceWeight,
      VariantWeight: variantWeight,
      VariantName: variantName,
      VariantImagePath: variantImage,
      Notes: ''
    });
  }
}

const ingotRows = materialSource.materials.map(material => ({
  Material: material.name,
  Category: material.category,
  WeightFactor: material.overrideFactor ?? materialSource.categories[material.category]?.weightFactor ?? 1.0,
  IngotWeightFactor: material.ingotWeightFactor ?? materialSource.categories[material.category]?.ingotWeightFactor ?? 1.0,
  Notes: ''
}));

if (variantRows.length === 0) {
  console.error('No Iron source items were found in the Weapons/Armor sheets.');
  process.exit(1);
}

const outputWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(outputWorkbook, XLSX.utils.json_to_sheet(variantRows), 'Material Variants');
XLSX.utils.book_append_sheet(outputWorkbook, XLSX.utils.json_to_sheet(armor), 'Armor Source Items');
XLSX.utils.book_append_sheet(outputWorkbook, XLSX.utils.json_to_sheet(ingotRows), 'Ingot Weight');
XLSX.writeFile(outputWorkbook, OUTPUT_XLSX);
console.log(`Generated preview workbook: ${OUTPUT_XLSX}`);
console.log(`Weapons: ${weapons.length}, Armor: ${armor.length}, Materials: ${materialNames.length}, Variant rows: ${variantRows.length}`);
