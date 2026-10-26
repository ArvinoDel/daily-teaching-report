/**
 * scripts/makeBackupsPrivate.js
 *
 * Migration script to transition legacy public Cloudinary backups (type: 'upload')
 * to private authenticated assets (type: 'authenticated') with unpredictable random suffixes.
 *
 * Flags:
 *   --apply                 Commit migrations to Cloudinary and MongoDB (default is DRY RUN)
 *   --uri=<MONGO_URI>       Target custom MongoDB URI
 *
 * Usage:
 *   node scripts/makeBackupsPrivate.js          <- DRY RUN
 *   node scripts/makeBackupsPrivate.js --apply  <- LIVE RUN
 */

'use strict';

require('dotenv').config();

const https      = require('https');
const crypto     = require('crypto');
const mongoose   = require('mongoose');
const cloudinary = require('cloudinary').v2;
const Backup     = require('../models/Backup');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uriArg = process.argv.find(a => a.startsWith('--uri='));
let MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;
if (!MONGO_URI || MONGO_URI === '[SENSITIVE]' || (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))) {
  console.error('❌ Error: Valid MONGO_URI is required via .env or --uri=<URI> (must start with mongodb:// or mongodb+srv://).');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const YES   = process.argv.includes('--yes');

async function migrateViaReupload(backup, newPublicId) {
  const parsed = new URL(backup.fileUrl);

  return new Promise((resolve, reject) => {
    https.get(parsed, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        return reject(new Error(`Failed to fetch legacy backup file (HTTP ${upstream.statusCode})`));
      }

      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          type:          'authenticated',
          public_id:     newPublicId,
          use_filename:  false,
        },
        async (err, result) => {
          if (err) return reject(err);

          try {
            const oldCloudinaryId = backup.cloudinaryId;
            backup.cloudinaryId   = result.public_id;
            backup.cloudinaryType = 'authenticated';
            backup.fileUrl        = result.secure_url;
            await backup.save();

            // Destroy old public asset
            await cloudinary.uploader.destroy(oldCloudinaryId, {
              resource_type: 'raw',
              type:          'upload',
              invalidate:    true,
            }).catch(() => {});

            resolve(result);
          } catch (dbErr) {
            reject(dbErr);
          }
        }
      );

      upstream.pipe(uploadStream);
    }).on('error', reject);
  });
}

async function main() {
  console.log('');
  console.log('═════════════════════════════════════════════════════════════════');
  console.log('  Migrate Cloudinary Backups to Authenticated (Private) Storage');
  console.log(`  Mode:           ${APPLY ? 'LIVE RUN (--apply) - WILL UPDATE ASSETS' : 'DRY RUN (preview only, no modifications)'}`);
  console.log('═════════════════════════════════════════════════════════════════');

  await mongoose.connect(MONGO_URI);

  const connHost = mongoose.connection.host;
  const connDb   = mongoose.connection.db.databaseName;
  console.log(`✓ Connected to MongoDB  host=${connHost}  db=${connDb}\n`);

  if (APPLY && !YES) {
    console.log('⚠ LIVE RUN (--apply): Waiting 5 seconds before making any changes. Press Ctrl+C to abort (or use --yes to skip)...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('Proceeding with migration...\n');
  }

  const candidates = await Backup.find({
    cloudinaryId: { $ne: null },
    cloudinaryType: { $ne: 'authenticated' },
  }).sort({ createdAt: -1 });

  console.log(`Found ${candidates.length} backup record(s) needing migration to authenticated storage.\n`);

  if (candidates.length === 0) {
    console.log('All backups are already stored with type: "authenticated" or have no Cloudinary file.');
    await mongoose.disconnect();
    return;
  }

  let migrated = 0;
  let failed = 0;

  for (const backup of candidates) {
    const randomSuffix = crypto.randomBytes(8).toString('hex');
    const baseId = (backup.cloudinaryId || '').replace(/_[a-f0-9]{8,}$/, '');
    const newPublicId = `${baseId}-${randomSuffix}`;

    console.log(`- Backup ID: ${backup._id} (${new Date(backup.createdAt).toISOString().split('T')[0]})`);
    console.log(`  Current: [${backup.cloudinaryType || 'upload'}] ${backup.cloudinaryId}`);
    console.log(`  Target:  [authenticated] ${newPublicId}`);

    if (!APPLY) {
      continue;
    }

    try {
      // 1. Try rename with to_type
      let done = false;
      try {
        const res = await cloudinary.uploader.rename(backup.cloudinaryId, newPublicId, {
          resource_type: 'raw',
          type:          'upload',
          to_type:       'authenticated',
          overwrite:     true,
        });
        backup.cloudinaryId   = res.public_id;
        backup.cloudinaryType = 'authenticated';
        backup.fileUrl        = res.secure_url;
        await backup.save();
        done = true;
        console.log('  ✓ Successfully migrated via Cloudinary rename API');
      } catch (renameErr) {
        console.log(`  ℹ Rename API declined (${renameErr.message}), falling back to stream re-upload...`);
      }

      // 2. Fallback to stream re-upload if rename was unsupported
      if (!done) {
        await migrateViaReupload(backup, newPublicId);
        console.log('  ✓ Successfully migrated via stream re-upload');
      }

      migrated++;
    } catch (err) {
      console.error(`  ✖ Failed to migrate backup ${backup._id}:`, err.message);
      failed++;
    }
  }

  if (!APPLY) {
    console.log('\n[DRY RUN COMPLETE] To migrate assets in Cloudinary and update MongoDB records, run with --apply:');
    console.log('  node scripts/makeBackupsPrivate.js --apply\n');
  } else {
    console.log('\n═════════════════════════════════════════════════════════════════');
    console.log(`  Migration Complete: ${migrated} migrated, ${failed} failed`);
    console.log('═════════════════════════════════════════════════════════════════\n');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Fatal error during migration:', err);
  process.exit(1);
});
