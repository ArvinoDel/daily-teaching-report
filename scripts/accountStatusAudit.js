/**
 * scripts/accountStatusAudit.js
 *
 * Read-only audit script for User account status lifecycle:
 *  - Validates MongoDB connection and safely prints host and DB name.
 *  - Counts user documents per accountStatus ('active', 'pending', 'suspended', 'rejected').
 *  - Inspects underlying documents missing the accountStatus field (treated as active by default).
 *
 * Usage:
 *   node scripts/accountStatusAudit.js
 *   node scripts/accountStatusAudit.js --uri=<MONGO_URI>
 */

'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');

const uriArg = process.argv.find(a => a.startsWith('--uri='));
let MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;

if (
  !MONGO_URI ||
  MONGO_URI === '[SENSITIVE]' ||
  (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))
) {
  console.error('Error: Valid MONGO_URI is required via .env or --uri=<URI> (must start with mongodb:// or mongodb+srv://).');
  process.exit(1);
}

function parseMaskedUri(uri) {
  try {
    const parsed = new URL(uri.replace('mongodb+srv://', 'http://').replace('mongodb://', 'http://'));
    return {
      host: parsed.host,
      database: parsed.pathname.replace(/^\//, '') || 'default',
    };
  } catch {
    return { host: 'unknown', database: 'unknown' };
  }
}

async function runAudit() {
  const { host, database } = parseMaskedUri(MONGO_URI);

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  User Account Status Audit (READ-ONLY)');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`Connecting to: ${host} (DB: ${database})`);

  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('Connected successfully.\n');
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }

  try {
    const rawCollection = mongoose.connection.collection('users');

    const [
      totalCount,
      activeExplicitCount,
      pendingCount,
      suspendedCount,
      rejectedCount,
      missingFieldCount,
    ] = await Promise.all([
      rawCollection.countDocuments({}),
      rawCollection.countDocuments({ accountStatus: 'active' }),
      rawCollection.countDocuments({ accountStatus: 'pending' }),
      rawCollection.countDocuments({ accountStatus: 'suspended' }),
      rawCollection.countDocuments({ accountStatus: 'rejected' }),
      rawCollection.countDocuments({ accountStatus: { $exists: false } }),
    ]);

    const effectiveActiveCount = await rawCollection.countDocuments({
      accountStatus: { $nin: ['pending', 'rejected', 'suspended'] },
    });

    console.log('Summary Breakdown:');
    console.log(`  Total User Documents:          ${totalCount}`);
    console.log(`  Active (explicit status):       ${activeExplicitCount}`);
    console.log(`  Missing accountStatus field:   ${missingFieldCount} (treated as ACTIVE by schema & queries)`);
    console.log(`  Total Effective Active:        ${effectiveActiveCount}`);
    console.log(`  Pending Approval:              ${pendingCount}`);
    console.log(`  Suspended:                     ${suspendedCount}`);
    console.log(`  Rejected:                      ${rejectedCount}`);
    console.log('───────────────────────────────────────────────────────────────────────────────');

    if (missingFieldCount > 0) {
      console.log(`\nDocuments missing 'accountStatus' field (${missingFieldCount} total):`);
      const legacyUsers = await rawCollection
        .find({ accountStatus: { $exists: false } })
        .project({ username: 1, displayName: 1, role: 1, createdAt: 1 })
        .limit(50)
        .toArray();

      legacyUsers.forEach((u, i) => {
        console.log(`  ${i + 1}. @${u.username} (${u.displayName || 'No Name'}) - Role: ${u.role || 'teacher'}`);
      });

      if (missingFieldCount > 50) {
        console.log(`  ... and ${missingFieldCount - 50} more.`);
      }
      console.log('Note: These accounts function as fully active with no database migration required.');
    } else {
      console.log('\nAll user documents contain an explicit accountStatus field.');
    }

    console.log('\nAudit completed successfully.');
  } catch (err) {
    console.error('Error during audit query:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  runAudit().catch(err => {
    console.error('Fatal audit error:', err);
    process.exit(1);
  });
}

module.exports = { runAudit };

