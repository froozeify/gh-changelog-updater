// test/integration.js — exercises src/index.js end-to-end (env parsing, mode resolution,
// file I/O) against mocked GitHub Actions primitives. commit is disabled (no real git repo
// here) so this focuses on everything up to "what would be written to disk".
//
// Run with: node test/integration.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function makeCore() {
  const core = {
    info: () => {},
    warning: () => {},
    setFailed: (msg) => {
      throw new Error(`core.setFailed: ${msg}`);
    },
    setSecret: () => {},
    outputs: {},
    setOutput(name, value) {
      core.outputs[name] = value;
    },
  };
  core.summary = {
    addHeading: () => core.summary,
    addTable: () => core.summary,
    addList: () => core.summary,
    write: async () => {},
  };
  return core;
}

// Runs fn() with process.cwd() pointed at a fresh temp dir, awaiting it before restoring cwd.
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-test-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await fn(dir);
  } finally {
    process.chdir(cwd);
  }
}

function setEnv(vars) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) delete process.env[key];
  }
  Object.assign(process.env, vars);
}

function freshIndex() {
  delete require.cache[require.resolve('../src/index.js')];
  return require('../src/index.js');
}

// A pull_request_target context for a PR against acme/widget. `pr` fields are merged over
// sensible defaults (merged, no labels/body) — pass only what a given test cares about.
function makePrContext(pr) {
  return {
    eventName: 'pull_request_target',
    repo: { owner: 'acme', repo: 'widget' },
    payload: {
      pull_request: {
        merged_at: '2026-07-31T00:00:00Z',
        labels: [],
        html_url: `https://github.com/acme/widget/pull/${pr.number}`,
        ...pr,
      },
    },
  };
}

function makeReleaseContext(release) {
  return { eventName: 'release', repo: { owner: 'acme', repo: 'widget' }, payload: { release } };
}

// Writes CHANGELOG.md with the standard preamble followed by `body` (already-joined lines).
function seedChangelog(body) {
  fs.writeFileSync(
    'CHANGELOG.md',
    ['# Change Log', '', 'All notable changes to this project will be documented in this file.', '', body].join('\n'),
  );
}

test('add-unreleased: merged PR with an "enhancement" label is filed under Added', () =>
  withTempDir(async () => {
    setEnv({ INPUT_COMMIT: 'false' });
    const run = freshIndex();
    const core = makeCore();
    const context = makePrContext({ number: 42, title: 'Add URL field type', labels: [{ name: 'enhancement' }] });

    await run({ github: {}, context, core, exec: {} });

    const content = fs.readFileSync('CHANGELOG.md', 'utf8');
    assert.ok(content.includes('## [Unreleased]'));
    assert.ok(content.includes('### Added'));
    assert.ok(content.includes('- Add URL field type (#42)'));
    assert.strictEqual(core.outputs.updated, 'true');
    assert.strictEqual(core.outputs['entries-count'], '1');
  }));

test('add-unreleased: unmerged PR is a no-op', () =>
  withTempDir(async () => {
    setEnv({ INPUT_COMMIT: 'false' });
    const run = freshIndex();
    const core = makeCore();
    const context = makePrContext({
      number: 7,
      title: 'Some closed-not-merged PR',
      merged_at: null,
      labels: [{ name: 'enhancement' }],
    });

    await run({ github: {}, context, core, exec: {} });

    assert.strictEqual(fs.existsSync('CHANGELOG.md'), false);
    assert.strictEqual(core.outputs.updated, 'false');
  }));

test('add-unreleased: re-running the same merged PR is idempotent', () =>
  withTempDir(async () => {
    setEnv({ INPUT_COMMIT: 'false' });
    const context = makePrContext({ number: 42, title: 'Add URL field type', labels: [{ name: 'enhancement' }] });

    await freshIndex()({ github: {}, context, core: makeCore(), exec: {} });
    const core2 = makeCore();
    await freshIndex()({ github: {}, context, core: core2, exec: {} });

    const content = fs.readFileSync('CHANGELOG.md', 'utf8');
    const occurrences = content.split('- Add URL field type (#42)').length - 1;
    assert.strictEqual(occurrences, 1);
    assert.strictEqual(core2.outputs.updated, 'false');
  }));

test('add-unreleased: "Changelog: ..." line in the PR body overrides the title', () =>
  withTempDir(async () => {
    setEnv({ INPUT_COMMIT: 'false' });
    const run = freshIndex();
    const core = makeCore();
    const context = makePrContext({
      number: 55,
      title: 'PR-123: refactor internal thingamajig for the frobnicator',
      body: 'Some PR description.\n\nChangelog: Fix crash when opening the settings page\n\nMore notes below.',
      labels: [{ name: 'fix' }],
    });

    await run({ github: {}, context, core, exec: {} });

    const content = fs.readFileSync('CHANGELOG.md', 'utf8');
    assert.ok(content.includes('- Fix crash when opening the settings page (#55)'));
    assert.ok(!content.includes('frobnicator'));
  }));

test('add-unreleased: no "Changelog:" line in the PR body falls back to the title', () =>
  withTempDir(async () => {
    setEnv({ INPUT_COMMIT: 'false' });
    const run = freshIndex();
    const core = makeCore();
    const context = makePrContext({
      number: 56,
      title: 'Fix the login bug',
      body: 'Just a plain description with no marker.',
      labels: [{ name: 'fix' }],
    });

    await run({ github: {}, context, core, exec: {} });

    const content = fs.readFileSync('CHANGELOG.md', 'utf8');
    assert.ok(content.includes('- Fix the login bug (#56)'));
  }));

test('add-unreleased: a manually edited entry is preserved on re-run (PR number kept)', () =>
  withTempDir(async () => {
    setEnv({ INPUT_COMMIT: 'false' });
    const context = makePrContext({ number: 42, title: 'Add URL field type', labels: [{ name: 'enhancement' }] });

    await freshIndex()({ github: {}, context, core: makeCore(), exec: {} });

    // A maintainer hand-edits the auto-generated wording, keeping the "(#42)" reference intact.
    let content = fs.readFileSync('CHANGELOG.md', 'utf8');
    content = content.replace(
      '- Add URL field type (#42)',
      '- Added a brand-new custom field type for URLs (#42)',
    );
    fs.writeFileSync('CHANGELOG.md', content, 'utf8');

    const core2 = makeCore();
    await freshIndex()({ github: {}, context, core: core2, exec: {} });

    const finalContent = fs.readFileSync('CHANGELOG.md', 'utf8');
    assert.ok(finalContent.includes('- Added a brand-new custom field type for URLs (#42)'));
    assert.ok(!finalContent.includes('- Add URL field type (#42)'));
    assert.strictEqual(core2.outputs.updated, 'false'); // recognized as already-present, not re-added
  }));

test('add-unreleased: a fully hand-written line (no PR marker at all) is left untouched', () =>
  withTempDir(async () => {
    // A maintainer writes their own line directly into CHANGELOG.md — not tied to any PR.
    seedChangelog(
      ['## [Unreleased]', '', '### Changed', '', '- Bumped internal infra, nothing user-facing but worth a note.', ''].join('\n'),
    );

    setEnv({ INPUT_COMMIT: 'false' });
    const run = freshIndex();
    const core = makeCore();
    const context = makePrContext({ number: 90, title: 'Add dark mode toggle', labels: [{ name: 'enhancement' }] });

    await run({ github: {}, context, core, exec: {} });

    const content = fs.readFileSync('CHANGELOG.md', 'utf8');
    // The hand-written line survives, byte-for-byte, alongside the new auto-added one.
    assert.ok(content.includes('- Bumped internal infra, nothing user-facing but worth a note.'));
    assert.ok(content.includes('- Add dark mode toggle (#90)'));
    assert.strictEqual(core.outputs.updated, 'true');
  }));

test('promote-unreleased: cuts [Unreleased] into a dated version on a release event', () =>
  withTempDir(async () => {
    seedChangelog(
      ['## [Unreleased]', '', '### Added', '', '- Add URL field type (#42)', ''].join('\n'),
    );

    setEnv({ INPUT_COMMIT: 'false', INPUT_DATE: '2026-07-31' });
    const run = freshIndex();
    const core = makeCore();
    const context = makeReleaseContext({ tag_name: 'v1.25.0' });

    await run({ github: {}, context, core, exec: {} });

    const content = fs.readFileSync('CHANGELOG.md', 'utf8');
    assert.ok(content.includes('## [1.25.0] - 2026-07-31'));
    assert.ok(content.includes('## [Unreleased]')); // fresh empty one re-opened
    assert.ok(content.includes('- Add URL field type (#42)'));
    assert.strictEqual(core.outputs.version, '1.25.0');
    assert.strictEqual(core.outputs.updated, 'true');
  }));

test('promote-unreleased: skips when [Unreleased] is empty (skip-if-empty default true)', () =>
  withTempDir(async () => {
    seedChangelog('## [Unreleased]\n');

    setEnv({ INPUT_COMMIT: 'false' });
    const run = freshIndex();
    const core = makeCore();
    const context = makeReleaseContext({ tag_name: 'v1.0.0' });

    await run({ github: {}, context, core, exec: {} });

    assert.strictEqual(core.outputs.updated, 'false');
  }));

test('promote-unreleased: skips a pre-release by default (skip-prerelease default true)', () =>
  withTempDir(async () => {
    seedChangelog(
      ['## [Unreleased]', '', '### Added', '', '- Add URL field type (#42)', ''].join('\n'),
    );

    setEnv({ INPUT_COMMIT: 'false', INPUT_DATE: '2026-07-31' });
    const run = freshIndex();
    const core = makeCore();
    const context = makeReleaseContext({ tag_name: 'v1.25.0-beta.1', prerelease: true });

    await run({ github: {}, context, core, exec: {} });

    assert.strictEqual(core.outputs.updated, 'false');
    const content = fs.readFileSync('CHANGELOG.md', 'utf8');
    assert.ok(content.includes('## [Unreleased]'));
    assert.ok(!content.includes('1.25.0-beta.1'));
  }));

test('promote-unreleased: skip-prerelease=false still promotes a pre-release', () =>
  withTempDir(async () => {
    seedChangelog(
      ['## [Unreleased]', '', '### Added', '', '- Add URL field type (#42)', ''].join('\n'),
    );

    setEnv({ INPUT_COMMIT: 'false', INPUT_DATE: '2026-07-31', INPUT_SKIP_PRERELEASE: 'false' });
    const run = freshIndex();
    const core = makeCore();
    const context = makeReleaseContext({ tag_name: 'v1.25.0-beta.1', prerelease: true });

    await run({ github: {}, context, core, exec: {} });

    assert.strictEqual(core.outputs.updated, 'true');
    const content = fs.readFileSync('CHANGELOG.md', 'utf8');
    assert.ok(content.includes('## [1.25.0-beta.1] - 2026-07-31'));
  }));

async function main() {
  let passed = 0;
  let failed = false;

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`ok   - ${name}`);
    } catch (err) {
      failed = true;
      console.error(`FAIL - ${name}`);
      console.error(err);
    }
  }

  console.log(`\n${passed}/${tests.length} test(s) passed.`);
  if (failed) {
    console.error('Some tests FAILED.');
    process.exitCode = 1;
  } else {
    console.log('All tests passed.');
  }
}

main();
