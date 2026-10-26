'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const crypto = require('crypto');
const BSON = require('bson');
const { createBackupStream } = require('../services/backupService');

/**
 * Helper to collect all buffers from a stream.
 */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test('Backup Stream - Streaming Serializer and SHA-256 Hashing', async (t) => {
  const sampleUsers = [
    { _id: 'u1', username: 'teacher1', email: 't1@example.com' },
    { _id: 'u2', username: 'teacher2', email: 't2@example.com' },
  ];
  const sampleReports = [
    { _id: 'r1', title: 'Math Class', grade: 'Grade 5' },
  ];

  // Mock registry: support both arrays and cursor-like model mocks
  const mockRegistry = [
    {
      key: 'users',
      model: {
        find: () => ({
          lean: () => ({
            cursor: async function* () {
              for (const u of sampleUsers) yield u;
            },
          }),
        }),
      },
    },
    {
      key: 'reports',
      model: sampleReports, // tests array branch
    },
  ];

  const recordCounts = { users: 2, reports: 1 };
  const exportedAt = '2026-10-26T10:00:00.000Z';

  await t.test('1. Plain JSON stream yields valid parseable payload', async () => {
    const { stream, getChecksum, getTotalBytes } = createBackupStream({
      format: 'json',
      recordCounts,
      registry: mockRegistry,
      exportedAt,
    });

    const buffer = await streamToBuffer(stream);
    const text = buffer.toString('utf8');
    const parsed = JSON.parse(text);

    assert.equal(parsed.appName, 'daily-teaching-report');
    assert.equal(parsed.format, 'json');
    assert.equal(parsed.exportedAt, exportedAt);
    assert.deepEqual(parsed.recordCounts, recordCounts);
    assert.deepEqual(parsed.collections.users, sampleUsers);
    assert.deepEqual(parsed.collections.reports, sampleReports);

    // Verify SHA-256
    const expectedChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
    assert.equal(getChecksum(), expectedChecksum);
    assert.equal(getTotalBytes(), buffer.length);
  });

  await t.test('2. JSON Gzip stream decompresses to valid JSON with matching checksum', async () => {
    const { stream, getChecksum, getTotalBytes } = createBackupStream({
      format: 'json_gz',
      recordCounts,
      registry: mockRegistry,
      exportedAt,
    });

    const gzBuffer = await streamToBuffer(stream);
    const unzipped = zlib.gunzipSync(gzBuffer);
    const parsed = JSON.parse(unzipped.toString('utf8'));

    assert.equal(parsed.appName, 'daily-teaching-report');
    assert.equal(parsed.format, 'json_gz');
    assert.deepEqual(parsed.recordCounts, recordCounts);
    assert.deepEqual(parsed.collections.users, sampleUsers);
    assert.deepEqual(parsed.collections.reports, sampleReports);

    const expectedChecksum = crypto.createHash('sha256').update(gzBuffer).digest('hex');
    assert.equal(getChecksum(), expectedChecksum);
    assert.equal(getTotalBytes(), gzBuffer.length);
  });

  await t.test('3. BSON Gzip stream decompresses and decodes correctly', async () => {
    const { stream, getChecksum, getTotalBytes } = createBackupStream({
      format: 'bson_gz',
      recordCounts,
      registry: mockRegistry,
      exportedAt,
    });

    const gzBuffer = await streamToBuffer(stream);
    const unzipped = zlib.gunzipSync(gzBuffer);

    // Read BSON documents sequentially from decompressed buffer
    const deserializedDocs = [];
    let offset = 0;
    while (offset < unzipped.length) {
      // First 4 bytes of BSON doc is the 32-bit little endian size
      const size = unzipped.readInt32LE(offset);
      const docBuf = unzipped.subarray(offset, offset + size);
      deserializedDocs.push(BSON.deserialize(docBuf));
      offset += size;
    }

    // First document should be metadata header
    assert.equal(deserializedDocs[0].appName, 'daily-teaching-report');
    assert.equal(deserializedDocs[0].format, 'bson_gz');
    assert.deepEqual(deserializedDocs[0].recordCounts, recordCounts);

    // Next is users separator
    assert.equal(deserializedDocs[1]._collectionName, 'users');
    assert.equal(deserializedDocs[1]._docCount, 2);

    // Followed by 2 user docs
    assert.equal(deserializedDocs[2]._id, 'u1');
    assert.equal(deserializedDocs[3]._id, 'u2');

    // Next is reports separator
    assert.equal(deserializedDocs[4]._collectionName, 'reports');
    assert.equal(deserializedDocs[4]._docCount, 1);

    // Followed by 1 report doc
    assert.equal(deserializedDocs[5]._id, 'r1');

    const expectedChecksum = crypto.createHash('sha256').update(gzBuffer).digest('hex');
    assert.equal(getChecksum(), expectedChecksum);
    assert.equal(getTotalBytes(), gzBuffer.length);
  });
});
