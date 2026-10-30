/**
 * services/studentIdentityService.js
 *
 * Student identity evaluation and safety helpers:
 *  - assessNameMatch: pure grade/school delta matcher
 *  - parseGradeAndSchool: parses grade number and cleaned school code
 *  - recordGradeChange: updates grade_school and grade_history (max 5)
 *  - audit pure helper functions for duplicates, conflicts, and group-type discrepancies
 */

const { normalizeName, extractGradeSchool } = require('../models/Student');

/**
 * Parses grade number and school from an annotation or full raw name.
 * e.g. "8 SMP" -> { grade: 8, school: 'SMP', cleanSchool: 'smp' }
 *      "12 KF*" -> { grade: 12, school: 'KF', cleanSchool: 'kf' }
 *      "Nico Edgina 9 CS+" -> { grade: 9, school: 'CS+', cleanSchool: 'cs' }
 *
 * @param {string} rawOrAnnotation
 * @returns {{ grade: number|null, school: string, cleanSchool: string }}
 */
function parseGradeAndSchool(rawOrAnnotation) {
  if (!rawOrAnnotation) return { grade: null, school: '', cleanSchool: '' };
  const trimmed = String(rawOrAnnotation).trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\*.*$/, '')
    .trim();
  if (!trimmed) return { grade: null, school: '', cleanSchool: '' };

  // Try extracting grade_school if it was a full raw name
  let annotation = extractGradeSchool(trimmed);
  if (!annotation) {
    // Check if trimmed itself starts with a digit (already an annotation like "8 SMP")
    const directMatch = trimmed.match(/^(\d{1,2})(?:\s+(.*))?$/);
    if (directMatch) {
      annotation = trimmed;
    }
  }

  if (!annotation) {
    return { grade: null, school: '', cleanSchool: '' };
  }

  const match = annotation.match(/^(\d{1,2})(?:\s+(.*))?$/);
  if (!match) {
    return { grade: null, school: '', cleanSchool: '' };
  }

  const grade = parseInt(match[1], 10);
  const school = (match[2] || '').trim().replace(/\*.*$/, '');
  const cleanSchool = school.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

  return { grade, school, cleanSchool };
}

/**
 * Compares an existing student with an incoming raw name annotation.
 *
 * Results:
 *  - { kind: 'same' } when either side has no grade or gradeDelta is between -1 and +2.
 *  - { kind: 'check_school' } when delta is 0 or +1 and school code differs (informational only).
 *  - { kind: 'likely_namesake' } when delta is below -1 or above +2, or status is 'graduated' with lower grade.
 *
 * @param {Object} existingStudent - Existing student doc or plain object
 * @param {string} incomingRaw - Incoming student raw name
 * @param {Date|number} [now] - Current timestamp
 * @returns {Object} { kind, existing, gradeDelta, ... }
 */
function assessNameMatch(existingStudent, incomingRaw, now) {
  const incomingParsed = parseGradeAndSchool(incomingRaw);
  const storedParsed = parseGradeAndSchool(
    (existingStudent && (existingStudent.grade_school || existingStudent.raw_name)) || ''
  );

  const existingInfo = {
    id: existingStudent && existingStudent._id ? String(existingStudent._id) : null,
    name: (existingStudent && (existingStudent.full_name || existingStudent.raw_name)) || '',
    grade_school: (existingStudent && existingStudent.grade_school) || (storedParsed.grade ? `${storedParsed.grade} ${storedParsed.school}`.trim() : storedParsed.school) || '',
    status: (existingStudent && existingStudent.status) || 'active',
    groupNames: Array.isArray(existingStudent && existingStudent.groupNames)
      ? existingStudent.groupNames
      : (Array.isArray(existingStudent && existingStudent.groups)
          ? existingStudent.groups.map(g => (typeof g === 'object' && g ? (g.group_name || g.name) : (typeof g === 'string' ? g : ''))).filter(Boolean)
          : []),
  };

  // Rule: Treat an existing student with status 'graduated' matched by a much lower incoming grade as likely_namesake
  if (existingInfo.status === 'graduated') {
    const baseline = storedParsed.grade !== null ? storedParsed.grade : 12;
    if (incomingParsed.grade !== null && (incomingParsed.grade - baseline < -1)) {
      const gradeDelta = incomingParsed.grade - baseline;
      return {
        kind: 'likely_namesake',
        existing: existingInfo,
        name: existingInfo.name,
        grade_school: existingInfo.grade_school,
        status: existingInfo.status,
        groupNames: existingInfo.groupNames,
        gradeDelta,
        storedGrade: storedParsed.grade,
        incomingGrade: incomingParsed.grade,
        reason: 'graduated_with_lower_grade',
      };
    }
  }

  // Either side has no grade -> same
  if (storedParsed.grade === null || incomingParsed.grade === null) {
    return {
      kind: 'same',
      existing: existingInfo,
      gradeDelta: null,
      storedGrade: storedParsed.grade,
      incomingGrade: incomingParsed.grade,
    };
  }

  const gradeDelta = incomingParsed.grade - storedParsed.grade;

  // Delta below -1 or above +2 -> likely_namesake
  if (gradeDelta < -1 || gradeDelta > 2) {
    return {
      kind: 'likely_namesake',
      existing: existingInfo,
      name: existingInfo.name,
      grade_school: existingInfo.grade_school,
      status: existingInfo.status,
      groupNames: existingInfo.groupNames,
      gradeDelta,
      storedGrade: storedParsed.grade,
      incomingGrade: incomingParsed.grade,
    };
  }

  // Delta is 0 or +1 and school code differs (informational only)
  const schoolDiffers = Boolean(
    storedParsed.cleanSchool &&
    incomingParsed.cleanSchool &&
    storedParsed.cleanSchool !== incomingParsed.cleanSchool
  );

  if ((gradeDelta === 0 || gradeDelta === 1) && schoolDiffers) {
    return {
      kind: 'check_school',
      existing: existingInfo,
      name: existingInfo.name,
      grade_school: existingInfo.grade_school,
      status: existingInfo.status,
      groupNames: existingInfo.groupNames,
      gradeDelta,
      storedGrade: storedParsed.grade,
      incomingGrade: incomingParsed.grade,
      storedSchool: storedParsed.school,
      incomingSchool: incomingParsed.school,
    };
  }

  // Otherwise, delta is between -1 and +2 -> same
  return {
    kind: 'same',
    existing: existingInfo,
    gradeDelta,
    storedGrade: storedParsed.grade,
    incomingGrade: incomingParsed.grade,
  };
}

/**
 * Appends grade change to student.grade_history and updates student.grade_school.
 * Caps grade_history at the last 5 entries.
 *
 * @param {Object} student - Mongoose Student doc or object with grade_school and grade_history
 * @param {string} newGradeSchool - New grade_school string
 * @param {'import'|'manual'} [source='manual']
 * @param {Date} [at=new Date()]
 * @returns {boolean} True if grade changed and recorded, false otherwise
 */
function recordGradeChange(student, newGradeSchool, source = 'manual', at = new Date()) {
  if (!student) return false;
  const trimmed = (newGradeSchool || '').trim();
  if (!trimmed || trimmed === (student.grade_school || '').trim()) {
    return false;
  }
  student.grade_school = trimmed;
  if (!Array.isArray(student.grade_history)) {
    student.grade_history = [];
  }
  student.grade_history.push({
    grade_school: trimmed,
    at,
    source,
  });
  if (student.grade_history.length > 5) {
    student.grade_history = student.grade_history.slice(-5);
  }
  return true;
}

/**
 * Audit Helper A: Find students sharing a normalized_name
 */
function auditFindDuplicates(students, groups = [], txCounts = new Map()) {
  const normMap = new Map();
  for (const s of (students || [])) {
    const norm = s.normalized_name || normalizeName(s.full_name || s.raw_name || '');
    if (!norm) continue;
    if (!normMap.has(norm)) normMap.set(norm, []);
    normMap.get(norm).push(s);
  }

  const groupsByStudentId = new Map();
  const groupsByNorm = new Map();
  for (const g of (groups || [])) {
    const gName = g.group_name || 'Unnamed Group';
    for (const sid of (g.student_ids || [])) {
      const sIdStr = String(sid);
      if (!groupsByStudentId.has(sIdStr)) groupsByStudentId.set(sIdStr, new Set());
      groupsByStudentId.get(sIdStr).add(gName);
    }
    for (const raw of (g.students || [])) {
      const n = normalizeName(raw);
      if (n) {
        if (!groupsByNorm.has(n)) groupsByNorm.set(n, new Set());
        groupsByNorm.get(n).add(gName);
      }
    }
  }

  const duplicates = [];
  for (const [norm, docs] of normMap.entries()) {
    if (docs.length > 1) {
      const rows = docs.map(doc => {
        const idStr = String(doc._id);
        const groupSet = new Set([
          ...(groupsByStudentId.get(idStr) || []),
          ...(groupsByNorm.get(norm) || []),
        ]);
        const txCount = typeof txCounts.get === 'function'
          ? (txCounts.get(idStr) || 0)
          : (txCounts[idStr] || 0);
        return {
          id: idStr,
          barcode: doc.barcode || 'N/A',
          createdAt: doc.createdAt || null,
          full_name: doc.full_name || doc.raw_name || '',
          grade_school: doc.grade_school || '',
          groupNames: Array.from(groupSet),
          acTransactionsCount: txCount,
        };
      });
      duplicates.push({
        normalized_name: norm,
        count: docs.length,
        students: rows,
      });
    }
  }

  return duplicates;
}

/**
 * Audit Helper B: Conflicting roster grades across groups (max - min >= 3)
 */
function auditFindConflictingRosterGrades(groups = []) {
  const normMap = new Map();

  for (const g of (groups || [])) {
    const gName = g.group_name || 'Unnamed Group';
    for (const raw of (g.students || [])) {
      const norm = normalizeName(raw);
      if (!norm) continue;
      const parsed = parseGradeAndSchool(raw);
      if (parsed.grade !== null) {
        if (!normMap.has(norm)) normMap.set(norm, []);
        normMap.get(norm).push({
          groupName: gName,
          grade: parsed.grade,
          raw,
        });
      }
    }
  }

  const conflicts = [];
  for (const [norm, entries] of normMap.entries()) {
    if (entries.length < 2) continue;
    const grades = entries.map(e => e.grade);
    const minGrade = Math.min(...grades);
    const maxGrade = Math.max(...grades);
    const delta = maxGrade - minGrade;
    if (delta >= 3) {
      conflicts.push({
        normalized_name: norm,
        minGrade,
        maxGrade,
        delta,
        entries,
      });
    }
  }

  return conflicts;
}

/**
 * Audit Helper C: Students in 2+ GROUP-type groups with different grades
 */
function auditFindDifferentGradesInGroupType(groups = []) {
  const groupTypeGroups = (groups || []).filter(g => g.type === 'GROUP');
  const normMap = new Map();

  for (const g of groupTypeGroups) {
    const gName = g.group_name || 'Unnamed Group';
    const gId = g._id ? String(g._id) : null;
    for (const raw of (g.students || [])) {
      const norm = normalizeName(raw);
      if (!norm) continue;
      const parsed = parseGradeAndSchool(raw);
      if (parsed.grade !== null) {
        if (!normMap.has(norm)) normMap.set(norm, []);
        normMap.get(norm).push({
          groupId: gId,
          groupName: gName,
          grade: parsed.grade,
          raw,
        });
      }
    }
  }

  const results = [];
  for (const [norm, entries] of normMap.entries()) {
    const distinctGroups = new Set(entries.map(e => e.groupName));
    if (distinctGroups.size >= 2) {
      const distinctGrades = Array.from(new Set(entries.map(e => e.grade)));
      if (distinctGrades.length > 1) {
        results.push({
          normalized_name: norm,
          distinctGrades: distinctGrades.sort((a, b) => a - b),
          groupCount: distinctGroups.size,
          entries,
        });
      }
    }
  }

  return results;
}

module.exports = {
  parseGradeAndSchool,
  assessNameMatch,
  recordGradeChange,
  auditFindDuplicates,
  auditFindConflictingRosterGrades,
  auditFindDifferentGradesInGroupType,
};

