'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGroupList,
  buildCompetitionClassName,
  validateCompetition,
  normalizeClassFields,
} = require('../services/reportInputService');

test('reportInputService - parseGroupList', async (t) => {
  await t.test('parses comma-separated string, trims, drops empties', () => {
    const raw = '  Group Alpha ,  , Group Beta  ,  Group Gamma  ';
    const result = parseGroupList(raw);
    assert.deepEqual(result, ['Group Alpha', 'Group Beta', 'Group Gamma']);
  });

  await t.test('de-duplicates case-insensitively while preserving first occurrence order and case', () => {
    const raw = ['Group A', 'group b', 'GROUP A', 'Group C', 'group c'];
    const result = parseGroupList(raw);
    assert.deepEqual(result, ['Group A', 'group b', 'Group C']);
  });

  await t.test('handles empty or missing input gracefully', () => {
    assert.deepEqual(parseGroupList(''), []);
    assert.deepEqual(parseGroupList(null), []);
    assert.deepEqual(parseGroupList(undefined), []);
    assert.deepEqual(parseGroupList([]), []);
  });
});

test('reportInputService - buildCompetitionClassName', async (t) => {
  await t.test('short join under max length (default 50)', () => {
    const groups = ['Group 1', 'Group 2'];
    const name = buildCompetitionClassName(groups);
    assert.equal(name, 'Group 1, Group 2');
    assert.ok(name.length <= 50);
  });

  await t.test('long label <= 50 with apostrophes and accents', () => {
    const groups = [
      "L'Académie des Élèves d'Élite Royale de France",
      'Groupe Bâtisseurs',
      'Groupe Lumière',
    ];
    const name = buildCompetitionClassName(groups);
    assert.ok(name.length <= 50, `Expected length <= 50, got ${name.length}: "${name}"`);
    assert.ok(name.endsWith(' +2 more'), `Expected suffix " +2 more", got "${name}"`);
    assert.ok(name.includes("L'Acad"), `Expected to contain start of first group, got "${name}"`);
  });

  await t.test('exactly 50 characters joined', () => {
    // 24 chars + 2 (", ") + 24 chars = 50 chars
    const g1 = '123456789012345678901234';
    const g2 = 'abcdefghijklmnopqrstuvwx';
    const name = buildCompetitionClassName([g1, g2]);
    assert.equal(name, `${g1}, ${g2}`);
    assert.equal(name.length, 50);
  });

  await t.test('single group exceeding max is truncated with ellipsis and never exceeds max', () => {
    const longName = 'A'.repeat(60);
    const name = buildCompetitionClassName([longName], 50);
    assert.ok(name.length <= 50);
    assert.ok(name.endsWith('...'));
  });

  await t.test('empty groups array returns empty string', () => {
    assert.equal(buildCompetitionClassName([]), '');
    assert.equal(buildCompetitionClassName(null), '');
  });
});

test('reportInputService - validateCompetition', async (t) => {
  await t.test('fewer than 2 groups returns error', () => {
    const errorsEmpty = validateCompetition({ session_type: 'competition', competition_groups: [] });
    assert.deepEqual(errorsEmpty, ['Select at least 2 groups for a competition.']);

    const errorsOne = validateCompetition({ session_type: 'competition', competition_groups: ['Only One'] });
    assert.deepEqual(errorsOne, ['Select at least 2 groups for a competition.']);
  });

  await t.test('valid competition with 2 to 10 groups returns no errors', () => {
    const errors = validateCompetition({
      session_type: 'competition',
      competition_groups: ['Team A', 'Team B', 'Team C'],
    });
    assert.deepEqual(errors, []);
  });

  await t.test('more than 10 groups returns error', () => {
    const groups = Array.from({ length: 11 }, (_, i) => `Group ${i + 1}`);
    const errors = validateCompetition({ session_type: 'competition', competition_groups: groups });
    assert.ok(errors.includes('A competition can have at most 10 groups.'));
  });

  await t.test('group name max 50 characters', () => {
    const errors = validateCompetition({
      session_type: 'competition',
      competition_groups: ['Normal Group', 'X'.repeat(51)],
    });
    assert.ok(errors.includes('Group name max 50 characters.'));
  });

  await t.test('non-competition returns empty array regardless of groups', () => {
    assert.deepEqual(validateCompetition({ session_type: 'group', competition_groups: [] }), []);
    assert.deepEqual(validateCompetition({ session_type: 'private', competition_groups: ['X'.repeat(60)] }), []);
    assert.deepEqual(validateCompetition({ session_type: undefined, competition_groups: [] }), []);
  });
});

test('reportInputService - normalizeClassFields', async (t) => {
  await t.test('competition derives class_name and ignores client-sent class_name', () => {
    const result = normalizeClassFields({
      session_type: 'competition',
      class_name: 'Client Injected Name',
      competition_groups: ['Alpha', 'Beta'],
    });
    assert.equal(result.class_name, 'Alpha, Beta');
    assert.deepEqual(result.competition_groups, ['Alpha', 'Beta']);
  });

  await t.test('competition handles raw string competition_groups and de-duplicates', () => {
    const result = normalizeClassFields({
      session_type: 'competition',
      competition_groups: 'Alpha, Beta, alpha, Gamma',
    });
    assert.equal(result.class_name, 'Alpha, Beta, Gamma');
    assert.deepEqual(result.competition_groups, ['Alpha', 'Beta', 'Gamma']);
  });

  await t.test('array class_name for group picks last non-empty string and resets competition_groups', () => {
    const result = normalizeClassFields({
      session_type: 'group',
      class_name: ['Old Stale Value', '', 'Real Group Name'],
      competition_groups: ['Team 1', 'Team 2'],
    });
    assert.equal(result.class_name, 'Real Group Name');
    assert.deepEqual(result.competition_groups, []);
  });

  await t.test('single string class_name for private returns trimmed class_name and resets competition_groups', () => {
    const result = normalizeClassFields({
      session_type: 'private',
      class_name: '  Student John Doe  ',
      competition_groups: ['Team 1'],
    });
    assert.equal(result.class_name, 'Student John Doe');
    assert.deepEqual(result.competition_groups, []);
  });
});
