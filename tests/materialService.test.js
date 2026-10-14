'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findCanonicalMaterial,
  planMergeAliases,
  planRename,
  parseCheckbox,
  buildBackfillMaps,
  resolveForBackfill,
  planRecountUpdates,
} = require('../services/materialService');

test('Material Service - Pure Helper Tests', async (t) => {
  await t.test('1. findCanonicalMaterial: Material exact match returns Material', () => {
    const materials = [
      { _id: 'mat-1', nameNormalized: 'unit 1 animals', level: 'E4' },
      { _id: 'mat-2', nameNormalized: 'unit 2 plants', level: 'E4' },
    ];
    const aliases = [];

    const result = findCanonicalMaterial(materials, aliases, 'unit 1 animals', 'E4');
    assert.ok(result);
    assert.equal(String(result._id), 'mat-1');
  });

  await t.test('2. findCanonicalMaterial: Material wins over alias at same key', () => {
    const materials = [
      { _id: 'mat-canonical', nameNormalized: 'unit 1 animals', level: 'E4' },
      { _id: 'mat-other', nameNormalized: 'other material', level: 'E4' },
    ];
    // Alias points to mat-other, but mat-canonical has the exact key
    const aliases = [
      { _id: 'alias-1', nameNormalized: 'unit 1 animals', level: 'E4', material: 'mat-other' },
    ];

    const result = findCanonicalMaterial(materials, aliases, 'unit 1 animals', 'E4');
    assert.ok(result);
    // Material wins!
    assert.equal(String(result._id), 'mat-canonical');
  });

  await t.test('3. findCanonicalMaterial: Alias resolves to its canonical Material if Material key not present', () => {
    const materials = [
      { _id: 'mat-target', nameNormalized: 'unit 1 animals (revised)', level: 'E4' },
    ];
    const aliases = [
      { _id: 'alias-1', nameNormalized: 'unit 1 animals', level: 'E4', material: 'mat-target' },
    ];

    const result = findCanonicalMaterial(materials, aliases, 'unit 1 animals', 'E4');
    assert.ok(result);
    assert.equal(String(result._id), 'mat-target');
  });

  await t.test('4. findCanonicalMaterial: Respects level distinction (same name at different level does not match)', () => {
    const materials = [
      { _id: 'mat-e4', nameNormalized: 'animals', level: 'E4' },
      { _id: 'mat-e5', nameNormalized: 'animals', level: 'E5' },
    ];
    const aliases = [];

    const resultE4 = findCanonicalMaterial(materials, aliases, 'animals', 'E4');
    assert.equal(String(resultE4._id), 'mat-e4');

    const resultE5 = findCanonicalMaterial(materials, aliases, 'animals', 'E5');
    assert.equal(String(resultE5._id), 'mat-e5');

    const resultE6 = findCanonicalMaterial(materials, aliases, 'animals', 'E6');
    assert.equal(resultE6, null);
  });

  await t.test('5. findCanonicalMaterial: Empty or missing returns null', () => {
    const materials = [{ _id: 'mat-1', nameNormalized: 'animals', level: '' }];
    const aliases = [];

    assert.equal(findCanonicalMaterial(materials, aliases, '', ''), null);
    assert.equal(findCanonicalMaterial(materials, aliases, null, ''), null);
  });

  await t.test('6. planMergeAliases: Merging source into target plans source alias creation and repoints existing aliases', () => {
    const source = { _id: 'src-1', nameNormalized: 'old lesson 1', level: 'E4' };
    const target = { _id: 'tgt-1', nameNormalized: 'new lesson 1', level: 'E4' };

    const existingAliases = [
      // An older alias that previously pointed to source
      { _id: 'alias-ancient', nameNormalized: 'ancient lesson 1', level: 'E4', material: 'src-1' },
      // An unrelated alias pointing to someone else
      { _id: 'alias-other', nameNormalized: 'unrelated', level: 'E4', material: 'other-id' },
    ];

    const plan = planMergeAliases(source, target, existingAliases);

    // 1. Should create an alias for source's own key pointing to target
    assert.equal(plan.aliasesToCreate.length, 1);
    assert.equal(plan.aliasesToCreate[0].nameNormalized, 'old lesson 1');
    assert.equal(plan.aliasesToCreate[0].level, 'E4');
    assert.equal(String(plan.aliasesToCreate[0].material), 'tgt-1');

    // 2. Should re-point ancient alias to target
    assert.equal(plan.aliasesToRepoint.length, 1);
    assert.equal(String(plan.aliasesToRepoint[0]._id), 'alias-ancient');
    assert.equal(String(plan.aliasesToRepoint[0].material), 'tgt-1');

    // 3. Unrelated alias untouched
    assert.ok(!plan.aliasesToRepoint.some(a => String(a._id) === 'alias-other'));
  });

  await t.test('7. planMergeAliases: If source key matches target key, it is skipped without error', () => {
    const source = { _id: 'src-dup', nameNormalized: 'lesson 1', level: 'E4' };
    const target = { _id: 'tgt-dup', nameNormalized: 'lesson 1', level: 'E4' };
    const existingAliases = [];

    const plan = planMergeAliases(source, target, existingAliases);
    assert.equal(plan.aliasesToCreate.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].reason, 'matches_target_key');
  });

  await t.test('8. planMergeAliases: If an existing alias on source matches target key, it is deleted/skipped', () => {
    const source = { _id: 'src-1', nameNormalized: 'intro to coding', level: 'E4' };
    const target = { _id: 'tgt-1', nameNormalized: 'coding 101', level: 'E4' };

    const existingAliases = [
      // This alias happens to have the exact name that target now has!
      { _id: 'alias-colliding', nameNormalized: 'coding 101', level: 'E4', material: 'src-1' },
    ];

    const plan = planMergeAliases(source, target, existingAliases);
    // Colliding alias should be deleted from aliases (target is canonical)
    assert.equal(plan.aliasesToDelete.length, 1);
    assert.equal(String(plan.aliasesToDelete[0]._id), 'alias-colliding');
    assert.ok(!plan.aliasesToRepoint.some(a => String(a._id) === 'alias-colliding'));
  });

  await t.test('9. planRename: Valid rename plans alias for old normalized name and level', () => {
    const material = { _id: 'mat-1', nameNormalized: 'scratch basics', level: 'E4' };
    const existingMaterials = [material];
    const existingAliases = [];

    const plan = planRename(material, 'Scratch Programming Basics', 'E4', existingMaterials, existingAliases);
    assert.ok(plan.ok);
    assert.equal(plan.cleanName, 'Scratch Programming Basics');
    assert.equal(plan.newNorm, 'scratch programming basics');
    assert.ok(plan.aliasToCreate);
    assert.equal(plan.aliasToCreate.nameNormalized, 'scratch basics');
    assert.equal(plan.aliasToCreate.level, 'E4');
    assert.equal(String(plan.aliasToCreate.material), 'mat-1');
  });

  await t.test('10. planRename: Collision with another Material is blocked', () => {
    const material = { _id: 'mat-1', nameNormalized: 'scratch basics', level: 'E4' };
    const otherMaterial = { _id: 'mat-2', name: 'Scratch Advanced', nameNormalized: 'scratch advanced', level: 'E4' };
    const existingMaterials = [material, otherMaterial];
    const existingAliases = [];

    const plan = planRename(material, 'Scratch Advanced', 'E4', existingMaterials, existingAliases);
    assert.equal(plan.ok, false);
    assert.equal(plan.collisionType, 'material');
  });

  await t.test('11. planRename: Collision with an alias pointing to another Material is blocked', () => {
    const material = { _id: 'mat-1', nameNormalized: 'scratch basics', level: 'E4' };
    const existingMaterials = [material];
    const existingAliases = [
      { _id: 'alias-x', nameNormalized: 'scratch pro', level: 'E4', material: 'mat-other' },
    ];

    const plan = planRename(material, 'Scratch Pro', 'E4', existingMaterials, existingAliases);
    assert.equal(plan.ok, false);
    assert.equal(plan.collisionType, 'alias');
  });

  await t.test('12. planRename: Renaming to an existing alias of the SAME material deletes the alias', () => {
    const material = { _id: 'mat-1', nameNormalized: 'scratch basics', level: 'E4' };
    const existingMaterials = [material];
    const existingAliases = [
      { _id: 'alias-self', nameNormalized: 'scratch pro', level: 'E4', material: 'mat-1' },
    ];

    const plan = planRename(material, 'Scratch Pro', 'E4', existingMaterials, existingAliases);
    assert.ok(plan.ok);
    assert.ok(plan.aliasToDelete);
    assert.equal(String(plan.aliasToDelete._id), 'alias-self');
    assert.ok(plan.aliasToCreate);
    assert.equal(plan.aliasToCreate.nameNormalized, 'scratch basics');
  });

  await t.test('13. planMergeAliases: Multiple aliases in a merge chain are all repointed to the new target', () => {
    const sourceB = { _id: 'mat-B', nameNormalized: 'math b', level: 'E3' };
    const targetC = { _id: 'mat-C', nameNormalized: 'math c', level: 'E3' };
    const existingAliases = [
      { _id: 'alias-A', nameNormalized: 'math a', level: 'E3', material: 'mat-B' },
      { _id: 'alias-A1', nameNormalized: 'math a1', level: 'E3', material: 'mat-B' },
    ];

    const plan = planMergeAliases(sourceB, targetC, existingAliases);
    assert.equal(plan.aliasesToCreate.length, 1);
    assert.equal(plan.aliasesToCreate[0].nameNormalized, 'math b');
    assert.equal(String(plan.aliasesToCreate[0].material), 'mat-C');

    assert.equal(plan.aliasesToRepoint.length, 2);
    assert.ok(plan.aliasesToRepoint.every(a => String(a.material) === 'mat-C'));
  });

  await t.test('14. findCanonicalMaterial: Level comparison is case-insensitive and trimmed', () => {
    const materials = [
      { _id: 'mat-e4', nameNormalized: 'intro to science', level: 'E4' },
    ];
    const aliases = [
      { _id: 'alias-e5', nameNormalized: 'intro to biology', level: 'E5', material: 'mat-e4' },
    ];

    assert.equal(String(findCanonicalMaterial(materials, aliases, 'intro to science', 'e4')._id), 'mat-e4');
    assert.equal(String(findCanonicalMaterial(materials, aliases, 'intro to biology', ' e5 ')._id), 'mat-e4');
  });

  /* ─────────────────────────────────────────────────────────────────────
   *  PROBLEM 2: parseCheckbox Tests
   * ───────────────────────────────────────────────────────────────────── */
  await t.test('15. parseCheckbox: Truthy values return true', () => {
    assert.equal(parseCheckbox('true'), true);
    assert.equal(parseCheckbox('on'), true);
    assert.equal(parseCheckbox(true), true);
    assert.equal(parseCheckbox('1'), true);
  });

  await t.test('16. parseCheckbox: Falsy and missing values return false', () => {
    assert.equal(parseCheckbox(undefined), false);
    assert.equal(parseCheckbox(''), false);
    assert.equal(parseCheckbox('false'), false);
    assert.equal(parseCheckbox(false), false);
    assert.equal(parseCheckbox(null), false);
    assert.equal(parseCheckbox('0'), false);
    assert.equal(parseCheckbox(0), false);
    assert.equal(parseCheckbox('random'), false);
  });

  /* ─────────────────────────────────────────────────────────────────────
   *  PROBLEM 1: resolveForBackfill Tests
   * ───────────────────────────────────────────────────────────────────── */
  const bfMaterials = [
    { _id: 'm-e4', name: 'Scratch 1', nameNormalized: 'scratch 1', level: 'E4', usageCount: 10, lastUsedAt: new Date('2026-01-01') },
    { _id: 'm-e5', name: 'Scratch 1', nameNormalized: 'scratch 1', level: 'E5', usageCount: 25, lastUsedAt: new Date('2026-02-01') },
    { _id: 'm-e6', name: 'Scratch 1', nameNormalized: 'scratch 1', level: 'E6', usageCount: 25, lastUsedAt: new Date('2026-03-01') }, // tie-break date
    { _id: 'm-uniq', name: 'Robotics', nameNormalized: 'robotics', level: 'E3', usageCount: 5, lastUsedAt: new Date('2026-01-10') },
    { _id: 'm-canon', name: 'Python Basics', nameNormalized: 'python basics', level: 'E5', usageCount: 12, lastUsedAt: new Date('2026-01-15') },
  ];

  const bfAliases = [
    { _id: 'a-1', nameNormalized: 'python intro', level: 'E5', material: 'm-canon' },
    // Alias at E4 pointing to python basics
    { _id: 'a-2', nameNormalized: 'py intro', level: 'E4', material: 'm-canon' },
  ];

  const maps = buildBackfillMaps(bfMaterials, bfAliases);

  await t.test('17. resolveForBackfill: via "exact" when nameNormalized and level match', () => {
    const res = resolveForBackfill('scratch 1', 'E4', maps);
    assert.equal(res.via, 'exact');
    assert.equal(String(res.materialId), 'm-e4');
  });

  await t.test('18. resolveForBackfill: via "alias" when nameNormalized and level match an alias', () => {
    const res = resolveForBackfill('python intro', 'E5', maps);
    assert.equal(res.via, 'alias');
    assert.equal(String(res.materialId), 'm-canon');
  });

  await t.test('19. resolveForBackfill: via "name-unique" when name exists at only 1 level and report has different/no level', () => {
    // Robotics is only at E3; report comes with level E6 or no level
    const res = resolveForBackfill('robotics', 'E6', maps);
    assert.equal(res.via, 'name-unique');
    assert.equal(String(res.materialId), 'm-uniq');

    const resNoLvl = resolveForBackfill('robotics', '', maps);
    assert.equal(resNoLvl.via, 'name-unique');
    assert.equal(String(resNoLvl.materialId), 'm-uniq');
  });

  await t.test('20. resolveForBackfill: via "name-unique" when all name matches point to same canonical material', () => {
    // py intro only has an alias at E4 pointing to m-canon
    const res = resolveForBackfill('py intro', 'E6', maps);
    assert.equal(res.via, 'name-unique');
    assert.equal(String(res.materialId), 'm-canon');
  });

  await t.test('21. resolveForBackfill: via "name-ambiguous" without linkAmbiguous flag skips linking', () => {
    // scratch 1 exists at E4, E5, E6. Report comes with level '' or E2 (no exact match)
    const res = resolveForBackfill('scratch 1', 'E2', maps, { linkAmbiguous: false });
    assert.equal(res.via, 'name-ambiguous');
    assert.equal(res.materialId, null);
    assert.equal(res.ambiguousLinked, false);
    assert.equal(res.candidates.length, 3);
  });

  await t.test('22. resolveForBackfill: via "name-ambiguous" with linkAmbiguous links highest usageCount (breaks tie by lastUsedAt)', () => {
    // E4 has usage 10. E5 has usage 25, 2026-02-01. E6 has usage 25, 2026-03-01.
    // Winner should be E6 due to later lastUsedAt.
    const res = resolveForBackfill('scratch 1', 'E2', maps, { linkAmbiguous: true });
    assert.equal(res.via, 'name-ambiguous');
    assert.equal(res.ambiguousLinked, true);
    assert.equal(String(res.materialId), 'm-e6');
  });

  await t.test('23. resolveForBackfill: strict mode disables name-only fallback', () => {
    // Robotics is unique, but in strict mode no name-only fallback should happen
    const res = resolveForBackfill('robotics', 'E6', maps, { strict: true });
    assert.equal(res.via, null);
    assert.equal(res.materialId, null);

    // Scratch 1 ambiguous also returns null in strict mode
    const resAmb = resolveForBackfill('scratch 1', 'E2', maps, { strict: true });
    assert.equal(resAmb.via, null);
    assert.equal(resAmb.materialId, null);

    // Exact still matches in strict mode
    const resExact = resolveForBackfill('scratch 1', 'E4', maps, { strict: true });
    assert.equal(resExact.via, 'exact');
    assert.equal(String(resExact.materialId), 'm-e4');
  });

  await t.test('24. resolveForBackfill: returns null for completely unknown subject', () => {
    const res = resolveForBackfill('completely unknown', 'E4', maps);
    assert.equal(res.via, null);
    assert.equal(res.materialId, null);
  });

  /* ─────────────────────────────────────────────────────────────────────
   *  PROBLEM 1: planRecountUpdates Tests
   * ───────────────────────────────────────────────────────────────────── */
  await t.test('25. planRecountUpdates: Full recount by default ONLY updates materials with linked reports', () => {
    const aggRows = [
      { _id: 'mat-1', count: 15, lastUsedAt: new Date('2026-04-01') },
      { _id: 'mat-2', count: 3, lastUsedAt: new Date('2026-03-15') },
    ];
    const allMaterialIds = ['mat-1', 'mat-2', 'mat-3', 'mat-4'];

    const updates = planRecountUpdates(aggRows, allMaterialIds, { zeroUnused: false, isTargeted: false });

    // Only mat-1 and mat-2 should be in updates! mat-3 and mat-4 are UNTOUCHED!
    assert.equal(updates.length, 2);
    assert.ok(updates.some(u => String(u.id) === 'mat-1' && u.usageCount === 15));
    assert.ok(updates.some(u => String(u.id) === 'mat-2' && u.usageCount === 3));
    assert.ok(!updates.some(u => String(u.id) === 'mat-3'));
    assert.ok(!updates.some(u => String(u.id) === 'mat-4'));
  });

  await t.test('26. planRecountUpdates: Full recount with zeroUnused=true zeroes materials without reports', () => {
    const aggRows = [
      { _id: 'mat-1', count: 15, lastUsedAt: new Date('2026-04-01') },
    ];
    const allMaterialIds = ['mat-1', 'mat-2', 'mat-3'];

    const updates = planRecountUpdates(aggRows, allMaterialIds, { zeroUnused: true, isTargeted: false });

    assert.equal(updates.length, 3);
    const u1 = updates.find(u => String(u.id) === 'mat-1');
    assert.equal(u1.usageCount, 15);

    const u2 = updates.find(u => String(u.id) === 'mat-2');
    assert.equal(u2.usageCount, 0);
    assert.equal(u2.lastUsedAt, null);

    const u3 = updates.find(u => String(u.id) === 'mat-3');
    assert.equal(u3.usageCount, 0);
    assert.equal(u3.lastUsedAt, null);
  });

  await t.test('27. planRecountUpdates: Targeted recount zeroes targeted materials that have no reports', () => {
    // Targeted recount with ids ['mat-1', 'mat-target-empty']
    const aggRows = [
      { _id: 'mat-1', count: 10, lastUsedAt: new Date('2026-01-01') },
    ];
    const targetedIds = ['mat-1', 'mat-target-empty'];

    const updates = planRecountUpdates(aggRows, targetedIds, { isTargeted: true });

    assert.equal(updates.length, 2);
    const u1 = updates.find(u => String(u.id) === 'mat-1');
    assert.equal(u1.usageCount, 10);

    const uEmpty = updates.find(u => String(u.id) === 'mat-target-empty');
    assert.equal(uEmpty.usageCount, 0);
    assert.equal(uEmpty.lastUsedAt, null);
  });
});
