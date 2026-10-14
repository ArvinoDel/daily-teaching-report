/**
 * scripts/backfillReportMaterials.js
 *
 * Backfills Report.material ObjectId references for historical reports.
 *
 * - DRY RUN by default (preview only, no DB writes).
 * - Pass `--apply` to write changes to MongoDB and recount usage.
 * - Loads all groups once into a map (group_name case-insensitive -> level).
 * - Resolves canonical material (Material first, then MaterialAlias).
 * - Never creates Materials, never modifies Report.subject text.
 * - Batch writes via bulkWrite.
 * - Runs full usage recount on --apply.
 * - Prints linked reports, unmatched subjects (top 20), and cross-level duplicates info.
 *
 * Usage:
 *   node scripts/backfillReportMaterials.js          <- DRY RUN
 *   node scripts/backfillReportMaterials.js --apply  <- LIVE RUN
 */

'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const Report   = require('../models/Report');
const Group    = require('../models/Group');
const Material = require('../models/Material');
const MaterialAlias = require('../models/MaterialAlias');
const { normalizeMaterialName, formatMaterialDisplayName } = require('../models/Material');
const { recountMaterialUsage } = require('../services/materialService');

const uriArg = process.argv.find(a => a.startsWith('--uri='));
let MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;
if (!MONGO_URI || MONGO_URI === '[SENSITIVE]' || (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))) {
  MONGO_URI = 'mongodb://localhost:27017/daily_teaching_report';
}

const APPLY   = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

async function main() {
  console.log('');
  console.log('═════════════════════════════════════════════════════════════════');
  console.log('  Backfill Report Materials Script');
  console.log(`  Mode: ${APPLY ? 'LIVE RUN (--apply)' : 'DRY RUN (preview only, no DB writes)'}`);
  console.log('═════════════════════════════════════════════════════════════════');

  await mongoose.connect(MONGO_URI);

  const connHost = mongoose.connection.host;
  const connDb   = mongoose.connection.db.databaseName;
  console.log(`✓ Connected to MongoDB  host=${connHost}  db=${connDb}\n`);

  if (APPLY) {
    console.log(`⚠️  LIVE RUN: changes will be written to ${connDb} on ${connHost}\n`);
  }

  // 1. Load all groups once into a map (group_name case-insensitive -> level)
  console.log('[1/4] Loading groups and mapping levels...');
  const groups = await Group.find().select('group_name level').lean();
  const groupLevelMap = new Map();
  for (const g of groups) {
    if (g.group_name) {
      const lvl = (g.level || '').trim().toUpperCase();
      groupLevelMap.set(g.group_name.trim().toLowerCase(), lvl);
    }
  }
  console.log(`  Loaded ${groupLevelMap.size} unique group name entries into level map.`);

  // 2. Load all Materials and MaterialAliases
  console.log('\n[2/4] Indexing Materials and Aliases...');
  const [allMaterials, allAliases] = await Promise.all([
    Material.find().select('_id name nameNormalized level').lean(),
    MaterialAlias.find().select('_id nameNormalized level material').lean(),
  ]);

  const materialMap = new Map(); // `${nameNormalized}|||${level}` -> _id
  const normLevelMultiMap = new Map(); // `${nameNormalized}` -> Set of levels

  for (const m of allMaterials) {
    const lvl = (m.level || '').trim().toUpperCase();
    const key = `${m.nameNormalized}|||${lvl}`;
    materialMap.set(key, m._id);

    if (!normLevelMultiMap.has(m.nameNormalized)) {
      normLevelMultiMap.set(m.nameNormalized, { name: m.name, levels: new Set() });
    }
    normLevelMultiMap.get(m.nameNormalized).levels.add(lvl || '(no level)');
  }

  const aliasMap = new Map(); // `${nameNormalized}|||${level}` -> target material _id
  for (const a of allAliases) {
    const lvl = (a.level || '').trim().toUpperCase();
    const key = `${a.nameNormalized}|||${lvl}`;
    aliasMap.set(key, a.material);
  }

  console.log(`  Indexed ${allMaterials.length} materials and ${allAliases.length} aliases.`);

  // 3. Scan reports with non-empty subject without material
  console.log('\n[3/4] Scanning reports without material reference...');
  const unlinkedReports = await Report.find({
    subject: { $exists: true, $ne: '' },
    $or: [{ material: null }, { material: { $exists: false } }],
  })
    .select('_id subject class_name session_type')
    .lean();

  console.log(`  Found ${unlinkedReports.length} reports with non-empty subject and no material link.`);

  const bulkOps = [];
  let linkedCount = 0;
  let unmatchedCount = 0;
  const unmatchedSubjectCounts = new Map();

  for (const r of unlinkedReports) {
    const rawSubj = (r.subject || '').trim();
    if (!rawSubj) continue;

    const displayName = formatMaterialDisplayName(rawSubj);
    const nameNorm    = normalizeMaterialName(displayName);
    if (!nameNorm) continue;

    // Resolve level: competition sessions have no level
    let level = '';
    if (r.session_type !== 'competition' && r.class_name) {
      level = groupLevelMap.get(r.class_name.trim().toLowerCase()) || '';
    }

    const key = `${nameNorm}|||${level}`;

    // Resolution priority: Material first, then MaterialAlias
    let resolvedId = materialMap.get(key);
    if (!resolvedId) {
      resolvedId = aliasMap.get(key);
    }

    if (resolvedId) {
      linkedCount++;
      bulkOps.push({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { material: resolvedId } },
        },
      });
    } else {
      unmatchedCount++;
      const trackKey = `${rawSubj}${level ? ' [' + level + ']' : ' [No level]'}`;
      unmatchedSubjectCounts.set(trackKey, (unmatchedSubjectCounts.get(trackKey) || 0) + 1);
    }
  }

  console.log(`  Reports to link: ${linkedCount}`);
  console.log(`  Reports with unmatched subject: ${unmatchedCount}`);

  // 4. Commit or Preview
  console.log('\n[4/4] Writing changes...');
  if (APPLY) {
    if (bulkOps.length > 0) {
      const BATCH_SIZE = 500;
      let written = 0;
      for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
        const chunk = bulkOps.slice(i, i + BATCH_SIZE);
        await Report.bulkWrite(chunk);
        written += chunk.length;
        process.stdout.write(`  Writing reports batch: ${written}/${bulkOps.length}\r`);
      }
      console.log(`\n  ✓ Successfully linked ${bulkOps.length} reports.`);
    } else {
      console.log('  No reports required linking.');
    }

    console.log('  Recalculating material usage counts from actual reports...');
    await recountMaterialUsage();
    console.log('  ✓ Usage counts and lastUsedAt dates recalculated.');
  } else {
    console.log(`  [DRY RUN] Would link ${bulkOps.length} reports and recount all material usage counts.`);
    console.log('  Run with `--apply` to commit these changes to the database.');
  }

  // Summary & Information output
  console.log('\n═════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═════════════════════════════════════════════════════════════════');
  console.log(`  Total unlinked reports scanned: ${unlinkedReports.length}`);
  console.log(`  Reports ${APPLY ? 'linked' : 'ready to link'}: ${linkedCount}`);
  console.log(`  Reports unmatched: ${unmatchedCount}`);

  if (unmatchedSubjectCounts.size > 0) {
    console.log('\n  Top 20 Distinct Unmatched Subjects:');
    const sortedUnmatched = [...unmatchedSubjectCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    sortedUnmatched.forEach(([subj, count], idx) => {
      console.log(`    ${String(idx + 1).padStart(2, ' ')}. ${subj} (${count} reports)`);
    });
  }

  // Informational list of materials that share the same normalized name across different levels
  const multiLevelMaterials = [...normLevelMultiMap.entries()]
    .filter(([_, info]) => info.levels.size > 1);

  if (multiLevelMaterials.length > 0) {
    console.log('\n  ℹ️  Informational: Materials sharing the same name across multiple levels:');
    console.log('     (These are valid level-specific materials; do not modify unless intentional)');
    multiLevelMaterials.forEach(([norm, info]) => {
      console.log(`    - "${info.name}" (norm: "${norm}"): levels [${[...info.levels].join(', ')}]`);
    });
  }

  console.log('\n═════════════════════════════════════════════════════════════════\n');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\nFatal error in backfillReportMaterials:', err);
  process.exit(1);
});
