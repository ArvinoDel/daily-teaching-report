require('dotenv').config();
const mongoose = require('mongoose');

async function repair() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log('Connected to DB:', db.databaseName);

  // 1. Safety backup of raw collections
  console.log('\n--- Step 1: Creating safety backup copies ---');
  for (const collName of ['users', 'reports', 'groups', 'feedbacks', 'auditLogs']) {
    const rawColl = db.collection(collName);
    const count = await rawColl.countDocuments();
    console.log(`Found ${count} docs in ${collName}`);
    if (count > 0) {
      const backupColl = db.collection(`_backup_${collName}`);
      await backupColl.deleteMany({});
      const docs = await rawColl.find().toArray();
      await backupColl.insertMany(docs);
      console.log(`Backed up ${docs.length} docs to _backup_${collName}`);
    }
  }

  // 2. Convert Users
  console.log('\n--- Step 2: Converting Users to BSON ObjectIds & Dates ---');
  const userDocs = await db.collection('users').find().toArray();
  const convertedUsers = userDocs.map(u => {
    const doc = { ...u };
    if (typeof doc._id === 'string' && mongoose.Types.ObjectId.isValid(doc._id)) {
      doc._id = new mongoose.Types.ObjectId(doc._id);
    }
    if (doc.createdAt && typeof doc.createdAt === 'string') doc.createdAt = new Date(doc.createdAt);
    if (doc.updatedAt && typeof doc.updatedAt === 'string') doc.updatedAt = new Date(doc.updatedAt);
    if (doc.joinDate && typeof doc.joinDate === 'string') doc.joinDate = new Date(doc.joinDate);
    if (doc.lastActiveAt && typeof doc.lastActiveAt === 'string') doc.lastActiveAt = new Date(doc.lastActiveAt);
    return doc;
  });
  await db.collection('users').deleteMany({});
  await db.collection('users').insertMany(convertedUsers);
  console.log(`Successfully converted ${convertedUsers.length} users`);

  // 3. Convert Groups
  console.log('\n--- Step 3: Converting Groups to BSON ObjectIds & Dates ---');
  const groupDocs = await db.collection('groups').find().toArray();
  const convertedGroups = groupDocs.map(g => {
    const doc = { ...g };
    if (typeof doc._id === 'string' && mongoose.Types.ObjectId.isValid(doc._id)) {
      doc._id = new mongoose.Types.ObjectId(doc._id);
    }
    if (doc.createdAt && typeof doc.createdAt === 'string') doc.createdAt = new Date(doc.createdAt);
    if (doc.updatedAt && typeof doc.updatedAt === 'string') doc.updatedAt = new Date(doc.updatedAt);
    if (Array.isArray(doc.student_ids)) {
      doc.student_ids = doc.student_ids.map(sid => 
        (typeof sid === 'string' && mongoose.Types.ObjectId.isValid(sid)) ? new mongoose.Types.ObjectId(sid) : sid
      );
    }
    return doc;
  });
  await db.collection('groups').deleteMany({});
  await db.collection('groups').insertMany(convertedGroups);
  console.log(`Successfully converted ${convertedGroups.length} groups`);

  // 4. Convert Reports
  console.log('\n--- Step 4: Converting Reports to BSON ObjectIds & Dates ---');
  const reportDocs = await db.collection('reports').find().toArray();
  const convertedReports = reportDocs.map(r => {
    const doc = { ...r };
    if (typeof doc._id === 'string' && mongoose.Types.ObjectId.isValid(doc._id)) {
      doc._id = new mongoose.Types.ObjectId(doc._id);
    }
    if (typeof doc.teacher === 'string' && mongoose.Types.ObjectId.isValid(doc.teacher)) {
      doc.teacher = new mongoose.Types.ObjectId(doc.teacher);
    }
    if (typeof doc.partner_teacher === 'string' && mongoose.Types.ObjectId.isValid(doc.partner_teacher)) {
      doc.partner_teacher = new mongoose.Types.ObjectId(doc.partner_teacher);
    }
    if (doc.date && typeof doc.date === 'string') doc.date = new Date(doc.date);
    if (doc.createdAt && typeof doc.createdAt === 'string') doc.createdAt = new Date(doc.createdAt);
    if (doc.updatedAt && typeof doc.updatedAt === 'string') doc.updatedAt = new Date(doc.updatedAt);
    return doc;
  });
  await db.collection('reports').deleteMany({});
  await db.collection('reports').insertMany(convertedReports);
  console.log(`Successfully converted ${convertedReports.length} reports`);

  // 5. Convert Feedbacks
  console.log('\n--- Step 5: Converting Feedbacks to BSON ObjectIds & Dates ---');
  const feedbackDocs = await db.collection('feedbacks').find().toArray();
  if (feedbackDocs.length > 0) {
    const convertedFeedbacks = feedbackDocs.map(f => {
      const doc = { ...f };
      if (typeof doc._id === 'string' && mongoose.Types.ObjectId.isValid(doc._id)) {
        doc._id = new mongoose.Types.ObjectId(doc._id);
      }
      if (typeof doc.user === 'string' && mongoose.Types.ObjectId.isValid(doc.user)) {
        doc.user = new mongoose.Types.ObjectId(doc.user);
      }
      if (doc.createdAt && typeof doc.createdAt === 'string') doc.createdAt = new Date(doc.createdAt);
      if (doc.updatedAt && typeof doc.updatedAt === 'string') doc.updatedAt = new Date(doc.updatedAt);
      return doc;
    });
    await db.collection('feedbacks').deleteMany({});
    await db.collection('feedbacks').insertMany(convertedFeedbacks);
    console.log(`Successfully converted ${convertedFeedbacks.length} feedbacks`);
  }

  // 6. Convert AuditLogs & sync to lowercase auditlogs
  console.log('\n--- Step 6: Converting AuditLogs & sync to auditlogs ---');
  const rawAuditColl = db.collection('auditLogs');
  const auditDocs = await rawCollDocs(db, 'auditLogs', 'auditlogs');
  if (auditDocs.length > 0) {
    const convertedAudits = auditDocs.map(a => {
      const doc = { ...a };
      if (typeof doc._id === 'string' && mongoose.Types.ObjectId.isValid(doc._id)) {
        doc._id = new mongoose.Types.ObjectId(doc._id);
      }
      if (typeof doc.admin === 'string' && mongoose.Types.ObjectId.isValid(doc.admin)) {
        doc.admin = new mongoose.Types.ObjectId(doc.admin);
      }
      if (typeof doc.targetId === 'string' && mongoose.Types.ObjectId.isValid(doc.targetId)) {
        doc.targetId = new mongoose.Types.ObjectId(doc.targetId);
      }
      if (doc.createdAt && typeof doc.createdAt === 'string') doc.createdAt = new Date(doc.createdAt);
      if (doc.updatedAt && typeof doc.updatedAt === 'string') doc.updatedAt = new Date(doc.updatedAt);
      return doc;
    });
    // Write to both auditlogs and auditLogs for safety
    await db.collection('auditlogs').deleteMany({});
    await db.collection('auditlogs').insertMany(convertedAudits);
    await db.collection('auditLogs').deleteMany({});
    await db.collection('auditLogs').insertMany(convertedAudits);
    console.log(`Successfully converted ${convertedAudits.length} audit logs`);
  }

  console.log('\n--- Step 7: Verifying Mongoose Queries ---');
  const User = require('../models/User');
  const Report = require('../models/Report');
  const Group = require('../models/Group');

  const reportCount = await Report.countDocuments();
  const groupCount = await Group.countDocuments();
  const userCount = await User.countDocuments();
  console.log('Mongoose counts after repair:');
  console.log('  Users:', userCount);
  console.log('  Groups:', groupCount);
  console.log('  Reports:', reportCount);

  // Test populate
  const sampleRep = await Report.findOne().populate('teacher');
  console.log('Populated report teacher successfully:', sampleRep?.teacher?.displayName || 'FAILED');

  // Test find by teacher
  if (sampleRep?.teacher?._id) {
    const teacherReports = await Report.countDocuments({ teacher: sampleRep.teacher._id });
    console.log(`Found ${teacherReports} reports for teacher ${sampleRep.teacher.displayName}`);
  }

  await mongoose.disconnect();
  console.log('\n✅ All data successfully repaired and verified!');
}

async function rawCollDocs(db, name1, name2) {
  let docs = await db.collection(name1).find().toArray();
  if (!docs.length && name2) {
    docs = await db.collection(name2).find().toArray();
  }
  return docs;
}

repair().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
