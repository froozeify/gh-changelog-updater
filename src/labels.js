'use strict';

const DEFAULT_CATEGORY_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

const DEFAULT_LABEL_MAPPING = {
  Added: ['enhancement', 'feature'],
  Fixed: ['fix', 'bug'],
  Changed: [
    'refactor',
    'performance',
    'style',
    'documentation',
    'test',
    'ci',
    'build',
    'chore',
    'github-actions',
    'dependencies',
  ],
  Deprecated: ['deprecated'],
  Removed: ['removed'],
  Security: ['security'],
};

const DEFAULT_EXCLUDE_LABELS = ['ignore-for-release'];

// Parse the `label-mapping` input: one "Category=label1,label2" pair per line.
// Blank lines and lines starting with '#' are ignored.
function parseLabelMapping(raw) {
  if (!raw || !raw.trim()) return DEFAULT_LABEL_MAPPING;

  const mapping = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const category = line.slice(0, eqIndex).trim();
    const labels = line
      .slice(eqIndex + 1)
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);

    if (category && labels.length) mapping[category] = labels;
  }

  return Object.keys(mapping).length ? mapping : DEFAULT_LABEL_MAPPING;
}

// Parse a comma-separated list input (used for exclude-labels and category-order).
function parseList(raw, fallback) {
  if (!raw || !raw.trim()) return fallback;
  const list = raw
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

// Resolve the Keep-a-Changelog category for a PR given its labels.
// Returns null when the PR should be skipped (excluded, or unlabeled with no default-category).
function categorize(prLabels, { labelMapping, categoryOrder, excludeLabels, defaultCategory }) {
  const names = (prLabels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);

  if (names.some((n) => excludeLabels.includes(n))) return null;

  for (const category of categoryOrder) {
    const mapped = labelMapping[category] || [];
    if (names.some((n) => mapped.includes(n))) return category;
  }

  return defaultCategory || null;
}

module.exports = {
  DEFAULT_CATEGORY_ORDER,
  DEFAULT_LABEL_MAPPING,
  DEFAULT_EXCLUDE_LABELS,
  parseLabelMapping,
  parseList,
  categorize,
};
