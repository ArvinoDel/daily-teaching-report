/**
 * scripts/backfillReportMaterials.js
 *
 * Backfills Report.material ObjectId references for historical reports.
 *
 * Matching priority (resolveForBackfill):
 *   1. Exact (name, level)
 *   2. Alias (name, level)
 *   3. Name-only fallback:
 *      - name-unique: exactly 1 candidate Material -> link it
 *      - name-ambiguous: multiple candidate Materials at different levels
 *         * default: skip linking (materialId: null)
 *         * with --link-ambiguous: link material with highest usageCount (ties broken by latest lastUsedAt)
 *
 * Flags:
 *   --apply           Commit changes to MongoDB (default is DRY RUN)
 *   --strict          Disable name-only fallback entirely (exact and alias only)
 *   --link-ambiguous  Link ambiguous matches to highest usageCount
 *   --zero-unused     Zero out usageCount/lastUsedAt for materials with zero linked reports
 *
 * Usage:
 *   node scripts/backfillReportMaterials.js                          <- DRY RUN
 *   node scripts/backfillReportMaterials.js --apply                  <- LIVE RUN
 *   node scripts/backfillReportMaterials.js --strict                 <- Dry run without name fallback
 *   node scripts/backfillReportMaterials.js --link-ambiguous         <- Dry run resolving ambiguous cases
 *   node scripts/backfillReportMaterials.js --apply --zero-unused    <- Live run with zeroing of unused
 */

'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const Report   = require('../models/Report');
const Group    = require('../models/Group');
const Material = require('../models/Material');
const MaterialAlias = require('../models/MaterialAlias');
const { normalizeMaterialName, formatMaterialDisplayName } = require('../models/Material');
const {
  buildBackfillMaps,
  resolveForBackfill,
  countUnlinkedReports,
  recountMaterialUsage,
} = require('../services/materialService');

const uriArg = process.argv.find(a => a.startsWith('--uri='));
let MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;
if (!MONGO_URI || MONGO_URI === '[SENSITIVE]' || (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))) {
  MONGO_URI = 'mongodb://localhost:27017/daily_teaching_report';
}

const APPLY          = process.argv.includes('--apply');
const STRICT         = process.argv.includes('--strict');
const LINK_AMBIGUOUS = process.argv.includes('--link-ambiguous');
const ZERO_UNUSED    = process.argv.includes('--zero-unused');

async function main() {
  console.log('');
  console.log('═════════════════════════════════════════════════════════════════');
  console.log('  Backfill Report Materials Script');
  console.log(`  Mode:           ${APPLY ? 'LIVE RUN (--apply)' : 'DRY RUN (preview only, no DB writes)'}`);
  console.log(`  Strict:         ${STRICT ? 'ON (name-only fallback disabled)' : 'OFF (name-only fallback enabled)'}`);
  console.log(`  Link Ambiguous: ${LINK_AMBIGUOUS ? 'ON (link candidate with highest usage)' : 'OFF (skip ambiguous)'}`);
  console.log(`  Zero Unused:    ${ZERO_UNUSED ? 'ON (materials with 0 reports will be zeroed)' : 'OFF (preserve unused materials)'}`);
  console.log('═════════════════════════════════════════════════════════════════');

  await mongoose.connect(MONGO_URI);

  const connHost = mongoose.connection.host;
  const connDb   = mongoose.connection.db.databaseName;
  console.log(`✓ Connected to MongoDB  host=${connHost}  db=${connDb}\n`);

  // Print unlinked reports count first
  const initialUnlinked = await countUnlinkedReports();
  console.log(`Unlinked reports count: ${initialUnlinked} reports are not linked to a material yet.\n`);

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

  // 2. Load all Materials and MaterialAliases & build lookup maps
  console.log('\n[2/4] Indexing Materials and Aliases...');
  const [allMaterials, allAliases] = await Promise.all([
    Material.find().select('_id name nameNormalized level usageCount lastUsedAt').lean(),
    MaterialAlias.find().select('_id nameNormalized level material').lean(),
  ]);

  const maps = buildBackfillMaps(allMaterials, allAliases);
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
  let exactCount = 0;
  let aliasCount = 0;
  let nameUniqueCount = 0;
  let ambiguousLinkedCount = 0;
  let ambiguousSkippedCount = 0;
  let unmatchedCount = 0;

  const unmatchedSubjectMap = new Map();
  const ambiguousSubjectMap = new Map();

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

    const res = resolveForBackfill(nameNorm, level, maps, {
      strict: STRICT,
      linkAmbiguous: LINK_AMBIGUOUS,
    });

    if (res.via === 'exact') {
      exactCount++;
      if (res.materialId) {
        bulkOps.push({
          updateOne: {
            filter: { _id: r._id },
            update: { $set: { material: res.materialId } },
          },
        });
      }
    } else if (res.via === 'alias') {
      aliasCount++;
      if (res.materialId) {
        bulkOps.push({
          updateOne: {
            filter: { _id: r._id },
            update: { $set: { material: res.materialId } },
          },
        });
      }
    } else if (res.via === 'name-unique') {
      nameUniqueCount++;
      if (res.materialId) {
        bulkOps.push({
          updateOne: {
            filter: { _id: r._id },
            update: { $set: { material: res.materialId } },
          },
        });
      }
    } else if (res.via === 'name-ambiguous') {
      if (res.ambiguousLinked && res.materialId) {
        ambiguousLinkedCount++;
        bulkOps.push({
          updateOne: {
            filter: { _id: r._id },
            update: { $set: { material: res.materialId } },
          },
        });
      } else {
        ambiguousSkippedCount++;
      }

      // Track ambiguous subjects and their candidate levels
      if (!ambiguousSubjectMap.has(nameNorm)) {
        const candidateLevels = (res.candidates || []).map(c => c.level || '(no level)');
        ambiguousSubjectMap.set(nameNorm, {
          name: displayName,
          count: 0,
          levels: candidateLevels,
        });
      }
      ambiguousSubjectMap.get(nameNorm).count++;
    } else {
      unmatchedCount++;
      const trackKey = `${rawSubj}${level ? ' [' + level + ']' : ' [No level]'}`;
      unmatchedSubjectMap.set(trackKey, (unmatchedSubjectMap.get(trackKey) || 0) + 1);
    }
  }

  const totalToLink = bulkOps.length;
  console.log(`  Reports to link: ${totalToLink}`);
  console.log(`    - Exact matches:       ${exactCount}`);
  console.log(`    - Alias matches:       ${aliasCount}`);
  console.log(`    - Name-unique matches: ${nameUniqueCount}`);
  console.log(`    - Name-ambiguous:      linked=${ambiguousLinkedCount}, skipped=${ambiguousSkippedCount}`);
  console.log(`  Reports unmatched:       ${unmatchedCount}`);

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

    console.log(`  Recalculating material usage counts (zeroUnused=${ZERO_UNUSED})...`);
    await recountMaterialUsage(undefined, { zeroUnused: ZERO_UNUSED });
    console.log('  ✓ Usage counts and lastUsedAt dates recalculated.');
  } else {
    console.log(`  [DRY RUN] Would link ${bulkOps.length} reports.`);
    console.log(`  [DRY RUN] Would recount usage (zeroUnused=${ZERO_UNUSED}).`);
    console.log('  Run with `--apply` to commit these changes to the database.');
  }

  // Summary & Information output
  console.log('\n═════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═════════════════════════════════════════════════════════════════');
  console.log(`  Initial unlinked reports:        ${initialUnlinked}`);
  console.log(`  Total unlinked reports scanned:  ${unlinkedReports.length}`);
  console.log(`  Reports ${APPLY ? 'linked' : 'ready to link'}:       ${totalToLink}`);
  console.log(`    • Exact (name + level):        ${exactCount}`);
  console.log(`    • Alias (name + level):        ${aliasCount}`);
  console.log(`    • Name-unique (fallback):      ${nameUniqueCount}`);
  console.log(`    • Name-ambiguous (linked):     ${ambiguousLinkedCount}`);
  console.log(`    • Name-ambiguous (skipped):    ${ambiguousSkippedCount}`);
  console.log(`  Reports unmatched:               ${unmatchedCount}`);

  if (ambiguousSubjectMap.size > 0) {
    console.log('\n  Top 20 Distinct Ambiguous Subjects & Candidate Levels:');
    const sortedAmbiguous = [...ambiguousSubjectMap.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    sortedAmbiguous.forEach((item, idx) => {
      console.log(`    ${String(idx + 1).padStart(2, ' ')}. ${item.name} (${item.count} reports) -> Levels: [${item.levels.join(', ')}]`);
    });
  }

  if (unmatchedSubjectMap.size > 0) {
    console.log('\n  Top 20 Distinct Unmatched Subjects:');
    const sortedUnmatched = [...unmatchedSubjectMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    sortedUnmatched.forEach(([subj, count], idx) => {
      console.log(`    ${String(idx + 1).padStart(2, ' ')}. ${subj} (${count} reports)`);
    });
  }

  console.log('\n═════════════════════════════════════════════════════════════════\n');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\nFatal error in backfillReportMaterials:', err);
  process.exit(1);
});
