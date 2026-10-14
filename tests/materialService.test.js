'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findCanonicalMaterial,
  planMergeAliases,
  planRename,
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
    // A was merged into B previously, so alias(A -> B) exists.
    // Now B is merged into C.
    const sourceB = { _id: 'mat-B', nameNormalized: 'math b', level: 'E3' };
    const targetC = { _id: 'mat-C', nameNormalized: 'math c', level: 'E3' };
    const existingAliases = [
      { _id: 'alias-A', nameNormalized: 'math a', level: 'E3', material: 'mat-B' },
      { _id: 'alias-A1', nameNormalized: 'math a1', level: 'E3', material: 'mat-B' },
    ];

    const plan = planMergeAliases(sourceB, targetC, existingAliases);
    // B's own key becomes alias to C
    assert.equal(plan.aliasesToCreate.length, 1);
    assert.equal(plan.aliasesToCreate[0].nameNormalized, 'math b');
    assert.equal(String(plan.aliasesToCreate[0].material), 'mat-C');

    // Both old aliases pointing to B are repointed to C
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
});
