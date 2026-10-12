/**
 * services/groupImportDiffService.js
 *
 * Core diffing and classification engine for Groups CSV Import.
 * Computes student-level roster differences, moves, new students,
 * missing students, and possible group rename candidates.
 */

const { normalizeName } = require('../models/Student');

/**
 * Resolves students from a DB Group document into normalized student descriptors.
 *
 * @param {Object} group - DB Group doc { _id, group_name, type, level, students, student_ids }
 * @param {Map} studentById - Map of studentId string -> Student doc
 * @param {Map} studentByNorm - Map of normalized_name string -> Student doc
 * @returns {Array} Array of { rawName, normKey, studentId, key }
 */
function resolveDbGroupStudents(group, studentById, studentByNorm) {
  const list = [];
  const seenKeys = new Set();
  const rawList = Array.isArray(group.students) ? group.students : [];
  const idList  = Array.isArray(group.student_ids) ? group.student_ids : [];

  for (let i = 0; i < rawList.length; i++) {
    const raw = (rawList[i] || '').trim();
    if (!raw) continue;
    const norm = normalizeName(raw);
    let sDoc = null;
    if (idList[i] && studentById.has(String(idList[i]))) {
      sDoc = studentById.get(String(idList[i]));
    } else if (norm && studentByNorm.has(norm)) {
      sDoc = studentByNorm.get(norm);
    }

    const studentId = sDoc ? String(sDoc._id) : (idList[i] ? String(idList[i]) : null);
    const key = studentId ? `id:${studentId}` : `norm:${norm}`;

    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      list.push({
        rawName: raw,
        normKey: norm,
        studentId,
        key,
      });
    }
  }

  // Include any student_ids in idList not indexed in rawList
  for (const id of idList) {
    if (!id) continue;
    const sId = String(id);
    const key = `id:${sId}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      const sDoc = studentById.get(sId);
      list.push({
        rawName: (sDoc && (sDoc.raw_name || sDoc.full_name)) || 'Student',
        normKey: (sDoc && sDoc.normalized_name) || '',
        studentId: sId,
        key,
      });
    }
  }

  return list;
}

/**
 * Resolves students from a parsed CSV doc into normalized student descriptors.
 *
 * @param {Object} doc - Parsed CSV record { group_name, type, level, students }
 * @param {Map} studentByNorm - Map of normalized_name string -> Student doc
 * @returns {Array} Array of { rawName, normKey, studentId, key }
 */
function resolveCsvGroupStudents(doc, studentByNorm) {
  const list = [];
  const seenKeys = new Set();
  const rawList = Array.isArray(doc.students) ? doc.students : [];

  for (const raw of rawList) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    const norm = normalizeName(trimmed);
    const sDoc = norm ? studentByNorm.get(norm) : null;
    const studentId = sDoc ? String(sDoc._id) : null;
    const key = studentId ? `id:${studentId}` : `norm:${norm}`;

    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      list.push({
        rawName: trimmed,
        normKey: norm,
        studentId,
        key,
      });
    }
  }

  return list;
}

/**
 * Computes group-based roster diff between CSV docs and DB records.
 *
 * @param {Array} docs - [{ group_name, type, level, students: [string, ...] }]
 * @param {Array} existingGroups - Array of DB Group docs
 * @param {Array} existingStudents - Array of DB Student docs
 * @returns {Object} { changedGroups, summaryChips, authoritativeRenames, allowedRemovalsByGroup, untouchedDbGroupsCount }
 */
function computeRosterDiff(docs, existingGroups, existingStudents) {
  // 1. Build lookup maps for students
  const studentById = new Map();
  const studentByNorm = new Map();
  for (const s of existingStudents) {
    studentById.set(String(s._id), s);
    if (s.normalized_name) {
      studentByNorm.set(s.normalized_name, s);
    }
  }

  // 2. Pre-resolve DB groups and CSV records
  const dbGroupMap = new Map();
  const dbGroupsByType = { GROUP: [], PRIVATE: [] };

  for (const g of existingGroups) {
    const resolved = {
      group: g,
      students: resolveDbGroupStudents(g, studentById, studentByNorm),
    };
    dbGroupMap.set(String(g._id), resolved);
    const type = g.type === 'PRIVATE' ? 'PRIVATE' : 'GROUP';
    dbGroupsByType[type].push(resolved);
  }

  const csvGroupResolved = docs.map(doc => ({
    doc,
    students: resolveCsvGroupStudents(doc, studentByNorm),
    type: doc.type === 'PRIVATE' ? 'PRIVATE' : 'GROUP',
  }));

  // 3. Rename detection (type-scoped, 1-to-1, >= 50% overlap)
  const exactMatchDbIds = new Set();
  const renameCandidatesByCsvName = new Map();
  const claimedDbIds = new Set();

  for (const type of ['GROUP', 'PRIVATE']) {
    const csvList = csvGroupResolved.filter(c => c.type === type);
    const dbList  = dbGroupsByType[type];

    const dbByName = new Map();
    for (const item of dbList) {
      dbByName.set(item.group.group_name, item);
    }

    const csvNamesInThisType = new Set(csvList.map(c => c.doc.group_name));

    for (const c of csvList) {
      if (dbByName.has(c.doc.group_name)) {
        const match = dbByName.get(c.doc.group_name);
        exactMatchDbIds.add(String(match.group._id));
      }
    }

    const unmatchedCsv = csvList.filter(c => !dbByName.has(c.doc.group_name));

    // Eligible unmatched DB groups:
    // Name is not matched by exact name AND is not anywhere in CSV groups of this type
    const eligibleDb = dbList.filter(d =>
      !exactMatchDbIds.has(String(d.group._id)) &&
      !csvNamesInThisType.has(d.group.group_name)
    );

    const candidatePairs = [];

    for (const c of unmatchedCsv) {
      const cStudentKeys = new Set(c.students.map(s => s.key));
      const totalCsv = c.students.length;
      if (totalCsv === 0) continue;

      for (const d of eligibleDb) {
        // If CSV group has level and DB has level, must match
        if (c.doc.level && d.group.level && c.doc.level.trim().toLowerCase() !== d.group.level.trim().toLowerCase()) {
          continue;
        }

        let matchCount = 0;
        for (const dStudent of d.students) {
          if (cStudentKeys.has(dStudent.key)) {
            matchCount++;
          }
        }

        const overlapRatio = matchCount / totalCsv;
        if (overlapRatio >= 0.5 && matchCount > 0) {
          candidatePairs.push({
            csv: c,
            db: d,
            matchCount,
            totalCsv,
            overlapRatio,
          });
        }
      }
    }

    // Sort by overlapRatio descending, then matchCount descending
    candidatePairs.sort((a, b) => {
      if (b.overlapRatio !== a.overlapRatio) return b.overlapRatio - a.overlapRatio;
      return b.matchCount - a.matchCount;
    });

    const claimedCsv = new Set();
    for (const pair of candidatePairs) {
      const csvName = pair.csv.doc.group_name;
      const dbId = String(pair.db.group._id);

      if (!claimedCsv.has(csvName) && !claimedDbIds.has(dbId)) {
        claimedCsv.add(csvName);
        claimedDbIds.add(dbId);
        renameCandidatesByCsvName.set(csvName, {
          dbGroupId: dbId,
          oldName: pair.db.group.group_name,
          matchCount: pair.matchCount,
          totalCsvStudents: pair.totalCsv,
          overlapRatio: pair.overlapRatio,
          overlapPercent: Math.round(pair.overlapRatio * 100),
          dbItem: pair.db,
        });
      }
    }
  }

  // 4. Compute student memberships across all groups of the same type
  const dbMembershipsByType = { GROUP: new Map(), PRIVATE: new Map() };
  const csvMembershipsByType = { GROUP: new Map(), PRIVATE: new Map() };

  for (const type of ['GROUP', 'PRIVATE']) {
    const dbList  = dbGroupsByType[type];
    const csvList = csvGroupResolved.filter(c => c.type === type);

    const dbMap = dbMembershipsByType[type];
    for (const item of dbList) {
      for (const s of item.students) {
        if (!dbMap.has(s.key)) dbMap.set(s.key, []);
        dbMap.get(s.key).push({
          groupId: String(item.group._id),
          groupName: item.group.group_name,
        });
      }
    }

    const csvMap = csvMembershipsByType[type];
    for (const item of csvList) {
      for (const s of item.students) {
        if (!csvMap.has(s.key)) csvMap.set(s.key, []);
        csvMap.get(s.key).push({
          groupName: item.doc.group_name,
        });
      }
    }
  }

  // Helper to compute additions & removals between a CSV group and an optional DB group
  function computeDiffBetween(cItem, dItem) {
    const cKeys = new Set(cItem.students.map(s => s.key));
    const dKeys = dItem ? new Set(dItem.students.map(s => s.key)) : new Set();
    const type = cItem.type;

    const additions = [];
    const removals = [];

    // Additions: in C, not in D
    for (const s of cItem.students) {
      if (!dKeys.has(s.key)) {
        const inStudentColl = Boolean(s.studentId || (s.normKey && studentByNorm.has(s.normKey)));
        if (!inStudentColl) {
          additions.push({
            ...s,
            status: 'NEW',
            label: 'New student',
          });
        } else {
          // Check if student belonged to another DB group of the same type that is missing them in CSV
          const otherDbGroups = (dbMembershipsByType[type].get(s.key) || [])
            .filter(g => !dItem || g.groupId !== String(dItem.group._id));

          let movedFrom = null;
          for (const og of otherDbGroups) {
            const inCsvGroups = (csvMembershipsByType[type].get(s.key) || [])
              .map(x => x.groupName);
            if (!inCsvGroups.includes(og.groupName)) {
              movedFrom = og.groupName;
              break;
            }
          }

          if (movedFrom) {
            additions.push({
              ...s,
              status: 'MOVED_IN',
              fromGroup: movedFrom,
              label: `Moved from ${movedFrom}`,
            });
          } else {
            additions.push({
              ...s,
              status: 'EXISTING',
              label: 'Existing student',
            });
          }
        }
      }
    }

    // Removals: in D, not in C
    if (dItem) {
      for (const s of dItem.students) {
        if (!cKeys.has(s.key)) {
          const inCsvGroups = (csvMembershipsByType[type].get(s.key) || []);
          const targetCsvGroups = [];

          for (const cg of inCsvGroups) {
            if (cg.groupName !== cItem.doc.group_name) {
              const dbListForStudent = (dbMembershipsByType[type].get(s.key) || [])
                .map(x => x.groupName);
              if (!dbListForStudent.includes(cg.groupName)) {
                targetCsvGroups.push(cg.groupName);
              }
            }
          }

          if (targetCsvGroups.length > 0) {
            const toName = targetCsvGroups.join(', ');
            removals.push({
              ...s,
              status: 'MOVED_OUT',
              toGroup: toName,
              label: `Moved to ${toName}`,
              defaultChecked: true,
            });
          } else if (inCsvGroups.length === 0) {
            removals.push({
              ...s,
              status: 'NOT_IN_CSV',
              label: 'Not in CSV',
              defaultChecked: false,
            });
          } else {
            removals.push({
              ...s,
              status: 'NOT_IN_CSV',
              label: 'Not in CSV for this group',
              defaultChecked: false,
            });
          }
        }
      }
    }

    return { additions, removals };
  }

  // 5. Build group diff cards and collect metrics
  const changedGroups = [];
  const authoritativeRenames = new Map(); // csvGroupName -> dbGroupId
  const allowedRemovalsByGroup = new Map(); // dbGroupId -> Map<key, student>

  let newStudentsCount = 0;
  let movedStudentsCount = 0;
  let notInCsvStudentsCount = 0;

  for (const cItem of csvGroupResolved) {
    const csvName = cItem.doc.group_name;
    const type = cItem.type;

    // Check exact DB match
    const exactMatch = dbGroupsByType[type].find(d => d.group.group_name === csvName);
    const renameCand = renameCandidatesByCsvName.get(csvName);

    if (exactMatch) {
      const diff = computeDiffBetween(cItem, exactMatch);
      const levelChanged = Boolean(cItem.doc.level && cItem.doc.level !== exactMatch.group.level);
      const typeChanged  = Boolean(cItem.doc.type && cItem.doc.type !== exactMatch.group.type);

      const hasStudentDiff = diff.additions.length > 0 || diff.removals.length > 0;
      if (hasStudentDiff || levelChanged || typeChanged) {
        const dbId = String(exactMatch.group._id);

        // Record allowed removals for this group
        if (!allowedRemovalsByGroup.has(dbId)) {
          allowedRemovalsByGroup.set(dbId, new Map());
        }
        for (const rem of diff.removals) {
          allowedRemovalsByGroup.get(dbId).set(rem.key, rem);
        }

        // Tally chips counts
        for (const add of diff.additions) {
          if (add.status === 'NEW') newStudentsCount++;
          if (add.status === 'MOVED_IN') movedStudentsCount++;
        }
        for (const rem of diff.removals) {
          if (rem.status === 'NOT_IN_CSV') notInCsvStudentsCount++;
          if (rem.status === 'MOVED_OUT') movedStudentsCount++;
        }

        changedGroups.push({
          name: csvName,
          type: cItem.doc.type,
          level: cItem.doc.level || exactMatch.group.level || '—',
          dbGroupId: dbId,
          isNew: false,
          renameCandidate: null,
          additions: diff.additions,
          removals: diff.removals,
          levelChanged,
          oldLevel: exactMatch.group.level || '',
          typeChanged,
          oldType: exactMatch.group.type || '',
        });
      }
    } else if (renameCand) {
      // Has rename candidate: provide diffAsNew and diffAsRename
      const diffAsNew = computeDiffBetween(cItem, null);
      const diffAsRename = computeDiffBetween(cItem, renameCand.dbItem);

      const candDbId = renameCand.dbGroupId;
      authoritativeRenames.set(csvName, candDbId);

      // Record allowed removals if renamed
      if (!allowedRemovalsByGroup.has(candDbId)) {
        allowedRemovalsByGroup.set(candDbId, new Map());
      }
      for (const rem of diffAsRename.removals) {
        allowedRemovalsByGroup.get(candDbId).set(rem.key, rem);
      }

      // Default tally uses diffAsNew (since default is unchecked)
      for (const add of diffAsNew.additions) {
        if (add.status === 'NEW') newStudentsCount++;
        if (add.status === 'MOVED_IN') movedStudentsCount++;
      }

      changedGroups.push({
        name: csvName,
        type: cItem.doc.type,
        level: cItem.doc.level || '—',
        dbGroupId: null, // becomes candDbId if rename is checked
        isNew: true,
        renameCandidate: {
          dbGroupId: candDbId,
          oldName: renameCand.oldName,
          matchCount: renameCand.matchCount,
          totalCsvStudents: renameCand.totalCsvStudents,
          overlapPercent: renameCand.overlapPercent,
        },
        additions: diffAsNew.additions,
        removals: diffAsNew.removals,
        diffAsNew,
        diffAsRename,
      });
    } else {
      // Brand-new group
      const diff = computeDiffBetween(cItem, null);

      for (const add of diff.additions) {
        if (add.status === 'NEW') newStudentsCount++;
        if (add.status === 'MOVED_IN') movedStudentsCount++;
      }

      changedGroups.push({
        name: csvName,
        type: cItem.doc.type,
        level: cItem.doc.level || '—',
        dbGroupId: null,
        isNew: true,
        renameCandidate: null,
        additions: diff.additions,
        removals: [],
      });
    }
  }

  // Count DB groups that do not appear in CSV at all and are not claimed as renames
  const untouchedDbGroupsCount = existingGroups.filter(g => {
    const id = String(g._id);
    return !exactMatchDbIds.has(id) && !claimedDbIds.has(id);
  }).length;

  return {
    changedGroups,
    summaryChips: {
      groupsWithChanges: changedGroups.length,
      newStudents: newStudentsCount,
      movedStudents: movedStudentsCount,
      notInCsvStudents: notInCsvStudentsCount,
      possibleRenames: renameCandidatesByCsvName.size,
      untouchedDbGroups: untouchedDbGroupsCount,
    },
    authoritativeRenames,
    allowedRemovalsByGroup,
    untouchedDbGroupsCount,
  };
}

module.exports = {
  resolveDbGroupStudents,
  resolveCsvGroupStudents,
  computeRosterDiff,
};
