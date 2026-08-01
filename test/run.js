'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const changelog = require('../src/changelog');
const labels = require('../src/labels');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const fixturePath = path.join(__dirname, 'fixtures', 'fields-sample.md');
const fixture = fs.readFileSync(fixturePath, 'utf8');

// ---------------------------------------------------------------------------
// parse / render round-trip
// ---------------------------------------------------------------------------

test('parse+render round-trips the fields-format fixture byte-for-byte', () => {
  const parsed = changelog.parse(fixture);
  assert.strictEqual(changelog.render(parsed), fixture);
});

test('parse extracts version headings, dates, categories and bullets', () => {
  const parsed = changelog.parse(fixture);
  assert.strictEqual(parsed.sections.length, 2);
  assert.strictEqual(parsed.sections[0].label, '1.24.2');
  assert.strictEqual(parsed.sections[0].date, '2026-06-30');
  assert.strictEqual(parsed.sections[0].categories[0].name, 'Fixed');
  assert.deepStrictEqual(parsed.sections[0].categories[0].bullets, [
    'Make "Associated item type" mandatory when creating a container.',
  ]);
});

// ---------------------------------------------------------------------------
// add-unreleased flow
// ---------------------------------------------------------------------------

test('addBullet creates [Unreleased] + category on an empty file with the fields preamble', () => {
  const parsed = changelog.parse('');
  const section = changelog.ensureUnreleased(parsed);
  changelog.addBullet(section, 'Added', 'New URL field type (#123)', labels.DEFAULT_CATEGORY_ORDER, '(#123)');

  const expected = `${changelog.DEFAULT_PREAMBLE}\n\n## [Unreleased]\n\n### Added\n\n- New URL field type (#123)\n`;

  assert.strictEqual(changelog.render(parsed), expected);
});

test('addBullet on an existing file inserts [Unreleased] above the newest version', () => {
  const parsed = changelog.parse(fixture);
  const section = changelog.ensureUnreleased(parsed);
  changelog.addBullet(section, 'Fixed', 'A brand new fix (#999)', labels.DEFAULT_CATEGORY_ORDER, '(#999)');

  const rendered = changelog.render(parsed);
  const unreleasedIdx = rendered.indexOf('## [Unreleased]');
  const firstVersionIdx = rendered.indexOf('## [1.24.2]');
  assert.ok(unreleasedIdx !== -1 && unreleasedIdx < firstVersionIdx, 'Unreleased must precede 1.24.2');
  assert.ok(rendered.includes('- A brand new fix (#999)'));
});

test('addBullet is idempotent for a duplicate PR ref', () => {
  const parsed = changelog.parse('');
  const section = changelog.ensureUnreleased(parsed);
  const first = changelog.addBullet(section, 'Added', 'Thing (#42)', labels.DEFAULT_CATEGORY_ORDER, '(#42)');
  const second = changelog.addBullet(section, 'Added', 'Thing (#42) — edited title', labels.DEFAULT_CATEGORY_ORDER, '(#42)');

  assert.strictEqual(first, true);
  assert.strictEqual(second, false);
  assert.strictEqual(section.categories[0].bullets.length, 1);
});

test('ensureCategory respects category-order when inserting among existing categories', () => {
  const parsed = changelog.parse('');
  const section = changelog.ensureUnreleased(parsed);
  changelog.addBullet(section, 'Fixed', 'A fix (#1)', labels.DEFAULT_CATEGORY_ORDER, '(#1)');
  changelog.addBullet(section, 'Added', 'A feature (#2)', labels.DEFAULT_CATEGORY_ORDER, '(#2)');

  assert.deepStrictEqual(
    section.categories.map((c) => c.name),
    ['Added', 'Fixed'],
  );
});

// ---------------------------------------------------------------------------
// promote-unreleased flow
// ---------------------------------------------------------------------------

test('promote restamps [Unreleased] to a dated version section and opens a fresh one', () => {
  const parsed = changelog.parse('');
  const section = changelog.ensureUnreleased(parsed);
  changelog.addBullet(section, 'Added', 'New URL field type (#123)', labels.DEFAULT_CATEGORY_ORDER, '(#123)');

  const result = changelog.promote(parsed, '1.25.0', '2026-07-31', true);
  assert.strictEqual(result.hadContent, true);

  const rendered = changelog.render(parsed);
  const expected =
    `${changelog.DEFAULT_PREAMBLE}\n\n## [Unreleased]\n\n` +
    '## [1.25.0] - 2026-07-31\n\n### Added\n\n- New URL field type (#123)\n';

  assert.strictEqual(rendered, expected);
});

test('promote without keep-unreleased drops the [Unreleased] heading entirely', () => {
  const parsed = changelog.parse('');
  const section = changelog.ensureUnreleased(parsed);
  changelog.addBullet(section, 'Fixed', 'Some fix (#7)', labels.DEFAULT_CATEGORY_ORDER, '(#7)');
  changelog.promote(parsed, '2.0.0', '2026-08-01', false);

  const rendered = changelog.render(parsed);
  assert.ok(!rendered.includes('[Unreleased]'));
  assert.ok(rendered.includes('## [2.0.0] - 2026-08-01'));
});

test('promote reports hadContent=false for an empty [Unreleased]', () => {
  const parsed = changelog.parse('');
  changelog.ensureUnreleased(parsed);
  const result = changelog.promote(parsed, '1.0.0', '2026-08-01', true);
  assert.strictEqual(result.hadContent, false);
});

test('promote returns null when there is no [Unreleased] section', () => {
  const parsed = changelog.parse(fixture);
  const result = changelog.promote(parsed, '1.25.0', '2026-07-31', true);
  assert.strictEqual(result, null);
});


// ---------------------------------------------------------------------------
// label categorization
// ---------------------------------------------------------------------------

test('categorize maps default labels to the expected categories', () => {
  const opts = {
    labelMapping: labels.DEFAULT_LABEL_MAPPING,
    categoryOrder: labels.DEFAULT_CATEGORY_ORDER,
    excludeLabels: labels.DEFAULT_EXCLUDE_LABELS,
    defaultCategory: 'Changed',
  };
  assert.strictEqual(labels.categorize([{ name: 'enhancement' }], opts), 'Added');
  assert.strictEqual(labels.categorize([{ name: 'fix' }], opts), 'Fixed');
  assert.strictEqual(labels.categorize([{ name: 'chore' }], opts), 'Changed');
  assert.strictEqual(labels.categorize([{ name: 'unknown-label' }], opts), 'Changed');
});

test('categorize excludes PRs carrying an exclude-label', () => {
  const opts = {
    labelMapping: labels.DEFAULT_LABEL_MAPPING,
    categoryOrder: labels.DEFAULT_CATEGORY_ORDER,
    excludeLabels: labels.DEFAULT_EXCLUDE_LABELS,
    defaultCategory: 'Changed',
  };
  assert.strictEqual(labels.categorize([{ name: 'enhancement' }, { name: 'ignore-for-release' }], opts), null);
});

test('categorize returns null for unlabeled PRs when default-category is empty', () => {
  const opts = {
    labelMapping: labels.DEFAULT_LABEL_MAPPING,
    categoryOrder: labels.DEFAULT_CATEGORY_ORDER,
    excludeLabels: labels.DEFAULT_EXCLUDE_LABELS,
    defaultCategory: '',
  };
  assert.strictEqual(labels.categorize([{ name: 'no-match' }], opts), null);
});

test('parseLabelMapping parses "Category=label1,label2" lines', () => {
  const mapping = labels.parseLabelMapping('Added=feat,feature\n# comment\nFixed=fix\n');
  assert.deepStrictEqual(mapping, { Added: ['feat', 'feature'], Fixed: ['fix'] });
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error('Some tests FAILED.');
} else {
  console.log('All tests passed.');
}
