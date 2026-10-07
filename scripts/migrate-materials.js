/**
 * scripts/migrate-materials.js
 *
 * Imports existing distinct non-empty `subject` values from Report into the Material collection.
 *
 * Rules:
 *   1. Maps group_name -> level from the Group collection.
 *   2. Resolves each report's level via its class_name.
 *   3. Competition sessions and unknown groups resolve to level "" (no level).
 *   4. Groups by unique (nameNormalized, level) using the shared normalizeMaterialName helper.
 *   5. Display name is set to the earliest-used original text.
 *   6. usageCount excludes auto-generated partner reports (is_auto_generated).
 *   7. lastUsedAt is set to the latest report date.
 *   8. createdBy is set to the teacher of the earliest report.
 *   9. Idempotent: Uses $setOnInsert for ALL fields so re-running never double-counts.
 *  10. DEFAULT IS DRY RUN: prints what would be created. Requires `--apply` flag to commit to DB.
 *
 * Usage:
 *   node scripts/migrate-materials.js          # Dry run (safe, preview only)
 *   node scripts/migrate-materials.js --apply  # Writes to database
 */

'use strict';

require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const mongoose = require('mongoose');
const Report   = require('../models/Report');
const Group    = require('../models/Group');
const Material = require('../models/Material');
const { normalizeMaterialName, formatMaterialDisplayName } = require('../models/Material');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/daily_teaching_report';

const args  = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY_RUN = !APPLY;

async function run() {
  console.log('='.repeat(65));
  console.log('  MIGRATE HISTORICAL MATERIALS');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (Preview only, no DB writes)' : 'APPLY (Writing to database)'}`);
  console.log('='.repeat(65));

  try {
    console.log('\n[1/5] Connecting to database...');
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB successfully.');

    // 1. Build map of group_name -> level from Group collection
    console.log('\n[2/5] Loading groups and resolving levels...');
    const groups = await Group.find()
      .select('group_name level')
      .lean();

    const groupLevelMap = new Map();
    for (const g of groups) {
      if (g.group_name) {
        const lvl = (g.level || '').trim().toUpperCase();
        groupLevelMap.set(g.group_name.trim().toLowerCase(), lvl);
      }
    }
    console.log(`Loaded ${groups.length} groups into level lookup map.`);

    // 2. Fetch all historical reports with non-empty subject, excluding auto-generated partner reports
    console.log('\n[3/5] Scanning reports with material (subject)...');
    const reports = await Report.find({
      subject: { $exists: true, $ne: '' },
      is_auto_generated: { $ne: true },
    })
      .select('subject class_name session_type teacher date createdAt')
      .sort({ date: 1, createdAt: 1 })
      .lean();

    console.log(`Found ${reports.length} non-auto-generated reports with non-empty subject.`);

    // 3. Aggregate materials by (nameNormalized, level)
    console.log('\n[4/5] Normalizing and grouping materials...');
    const materialMap = new Map();
    let skippedEmpty = 0;

    for (const r of reports) {
      const rawSubject = (r.subject || '').trim();
      if (!rawSubject) {
        skippedEmpty++;
        continue;
      }

      const displayName = formatMaterialDisplayName(rawSubject);
      const nameNorm    = normalizeMaterialName(displayName);

      if (!nameNorm) {
        skippedEmpty++;
        continue;
      }

      // Resolve level server-side
      let level = '';
      if (r.session_type !== 'competition' && r.class_name) {
        const key = r.class_name.trim().toLowerCase();
        level = groupLevelMap.get(key) || '';
      }

      const compositeKey = `${nameNorm}|${level}`;
      const reportDate = r.date ? new Date(r.date) : (r.createdAt ? new Date(r.createdAt) : new Date());

      if (!materialMap.has(compositeKey)) {
        materialMap.set(compositeKey, {
          name:           displayName, // Earliest original casing/text (due to sort: date 1)
          nameNormalized: nameNorm,
          level:          level,
          createdBy:      r.teacher || null,
          usageCount:     1,
          lastUsedAt:     reportDate,
        });
      } else {
        const existing = materialMap.get(compositeKey);
        existing.usageCount += 1;
        if (!existing.lastUsedAt || reportDate > existing.lastUsedAt) {
          existing.lastUsedAt = reportDate;
        }
      }
    }

    const uniqueMaterials = Array.from(materialMap.values());
    const withLevelCount  = uniqueMaterials.filter(m => m.level).length;
    const noLevelCount    = uniqueMaterials.filter(m => !m.level).length;

    console.log(`\nAggregated Summary:`);
    console.log(`  - Unique materials identified: ${uniqueMaterials.length}`);
    console.log(`  - With assigned level:         ${withLevelCount}`);
    console.log(`  - With no level (universal):   ${noLevelCount}`);
    console.log(`  - Skipped (empty or symbols):  ${skippedEmpty}`);

    // Print sample table
    console.log('\nSample of aggregated materials (top 15 by usage):');
    const sortedSample = [...uniqueMaterials]
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 15);

    console.table(
      sortedSample.map(m => ({
        Name:        m.name,
        Level:       m.level || '(No level)',
        Usage:       m.usageCount,
        'Last Used': m.lastUsedAt ? m.lastUsedAt.toISOString().slice(0, 10) : '—',
      }))
    );

    // 4. Commit or Dry Run
    if (DRY_RUN) {
      console.log('\n' + '='.repeat(65));
      console.log('  [DRY RUN COMPLETE]');
      console.log('  No database modifications were performed.');
      console.log('  To apply these materials to the database, run:');
      console.log('    node scripts/migrate-materials.js --apply');
      console.log('='.repeat(65));
    } else {
      console.log('\n[5/5] Applying materials to database (idempotent upserts)...');
      let insertedCount = 0;
      let alreadyExisted = 0;

      for (const item of uniqueMaterials) {
        // Idempotent upsert: $setOnInsert for ALL fields
        const res = await Material.findOneAndUpdate(
          { nameNormalized: item.nameNormalized, level: item.level },
          {
            $setOnInsert: {
              name:           item.name,
              nameNormalized: item.nameNormalized,
              level:          item.level,
              createdBy:      item.createdBy,
              usageCount:     item.usageCount,
              lastUsedAt:     item.lastUsedAt,
            },
          },
          { upsert: true, new: false }
        );

        if (res) {
          alreadyExisted++;
        } else {
          insertedCount++;
        }
      }

      console.log('\n' + '='.repeat(65));
      console.log('  [MIGRATION APPLIED SUCCESSFULLY]');
      console.log(`  - Newly inserted:    ${insertedCount}`);
      console.log(`  - Already existed:   ${alreadyExisted} (preserved unchanged)`);
      console.log(`  - Total in catalog:  ${uniqueMaterials.length}`);
      console.log('='.repeat(65));
    }
  } catch (err) {
    console.error('\nMigration error:', err);
    process.exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
      console.log('\nDisconnected from MongoDB.');
    } catch (_) {}
  }
}

// Only execute when run directly from command line
if (require.main === module) {
  run();
}

module.exports = { run };
