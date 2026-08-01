// All functions here are pure (string/object in, string/object out) so they can be
// unit-tested without touching the filesystem or the GitHub API.

'use strict';

const DEFAULT_PREAMBLE = [
  '# Changelog',
  '',
  'All notable changes to this project will be documented in this file.',
  '',
  'The format is based on [Keep a Changelog](http://keepachangelog.com/) and this project adheres to [Semantic Versioning](http://semver.org/).',
].join('\n');

const HEADING_RE = /^##\s+\[(.+?)\](?:\s*-\s*(.+))?\s*$/;
const CATEGORY_RE = /^###\s+(.+?)\s*$/;

// Parse CHANGELOG.md content into { preambleLines, sections }.
// Each section: { label: 'Unreleased' | '1.2.3', date: 'YYYY-MM-DD' | null, categories: [{name, bullets}] }
function parse(content) {
  const lines = (content || '').split(/\r?\n/);
  const preambleLines = [];
  const sections = [];
  let currentSection = null;
  let currentCategory = null;

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      currentSection = {
        label: headingMatch[1].trim(),
        date: headingMatch[2] ? headingMatch[2].trim() : null,
        categories: [],
      };
      sections.push(currentSection);
      currentCategory = null;
      continue;
    }

    if (!currentSection) {
      preambleLines.push(line);
      continue;
    }

    const categoryMatch = line.match(CATEGORY_RE);
    if (categoryMatch) {
      currentCategory = { name: categoryMatch[1].trim(), bullets: [] };
      currentSection.categories.push(currentCategory);
      continue;
    }

    const trimmed = line.trim();
    if (currentCategory && trimmed.startsWith('- ')) {
      currentCategory.bullets.push(trimmed.slice(2));
    }
    // Blank lines and any other stray content are not preserved — the file is always
    // re-rendered from the parsed model.
  }

  while (preambleLines.length && preambleLines[preambleLines.length - 1].trim() === '') {
    preambleLines.pop();
  }
  if (!preambleLines.length) preambleLines.push(...DEFAULT_PREAMBLE.split('\n'));

  return { preambleLines, sections };
}

function headingFor(section) {
  if (section.label === 'Unreleased') return '## [Unreleased]';
  return `## [${section.label}] - ${section.date}`;
}

// Serialize the parsed model back to a CHANGELOG.md string.
function render(parsed) {
  const lines = [...parsed.preambleLines];

  for (const section of parsed.sections) {
    lines.push('');
    lines.push(headingFor(section));

    for (const category of section.categories) {
      if (!category.bullets.length) continue; // never render an empty category
      lines.push('');
      lines.push(`### ${category.name}`);
      lines.push('');
      for (const bullet of category.bullets) lines.push(`- ${bullet}`);
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function findSectionIndex(parsed, label) {
  return parsed.sections.findIndex((s) => s.label === label);
}

// Get the [Unreleased] section, creating it at the top if missing.
function ensureUnreleased(parsed) {
  const idx = findSectionIndex(parsed, 'Unreleased');
  if (idx !== -1) return parsed.sections[idx];

  const section = { label: 'Unreleased', date: null, categories: [] };
  parsed.sections.unshift(section);
  return section;
}

// Get a `### Category` subsection within a section, creating it in categoryOrder
// position if missing.
function ensureCategory(section, categoryName, categoryOrder) {
  let category = section.categories.find((c) => c.name === categoryName);
  if (category) return category;

  category = { name: categoryName, bullets: [] };

  const targetOrderIdx = categoryOrder.indexOf(categoryName);
  if (targetOrderIdx === -1) {
    section.categories.push(category);
    return category;
  }

  let insertAt = section.categories.length;
  for (let i = 0; i < section.categories.length; i++) {
    const existingOrderIdx = categoryOrder.indexOf(section.categories[i].name);
    if (existingOrderIdx !== -1 && existingOrderIdx > targetOrderIdx) {
      insertAt = i;
      break;
    }
  }
  section.categories.splice(insertAt, 0, category);
  return category;
}

function hasBulletRef(category, refToken) {
  return refToken ? category.bullets.some((b) => b.includes(refToken)) : false;
}

// Append a bullet to section/category, creating the category as needed.
// Idempotent when refToken (e.g. "(#123)") is supplied and already present.
// Returns true if the bullet was added, false if skipped as a duplicate.
function addBullet(section, categoryName, bulletText, categoryOrder, refToken) {
  const category = ensureCategory(section, categoryName, categoryOrder);
  if (hasBulletRef(category, refToken)) return false;
  category.bullets.push(bulletText);
  return true;
}

// Promote [Unreleased] to a dated version section.
// Returns null if there is no [Unreleased] section at all.
// Returns { hadContent } describing whether it carried any bullets (an empty
// promote is usually a no-op the caller should skip/warn on).
function promote(parsed, version, date, keepUnreleased) {
  const idx = findSectionIndex(parsed, 'Unreleased');
  if (idx === -1) return null;

  const section = parsed.sections[idx];
  const hadContent = section.categories.some((c) => c.bullets.length > 0);

  section.label = version;
  section.date = date;

  if (keepUnreleased) {
    parsed.sections.splice(idx, 0, { label: 'Unreleased', date: null, categories: [] });
  }

  return { hadContent };
}

module.exports = {
  DEFAULT_PREAMBLE,
  parse,
  render,
  ensureUnreleased,
  ensureCategory,
  hasBulletRef,
  addBullet,
  promote,
};
