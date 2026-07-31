// src/index.js — entrypoint for the changelog-updater GitHub Action.

'use strict';

const fs = require('fs');

const changelogLib = require('./changelog');
const labelsLib = require('./labels');
const commitLib = require('./commit');
const summaryLib = require('./summary');

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

// Like env(), but only falls back when the variable is truly unset. An explicit empty string
// is a meaningful value of its own for some inputs (e.g. "no default category" / "no PR-note
// marker"), unlike most inputs where empty just means "not specified, use the default".
function envStrict(name, fallback = '') {
  const v = process.env[name];
  return v === undefined ? fallback : v;
}

function boolEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true';
}

function stripV(v) {
  return String(v || '').replace(/^v/, '');
}

function todayUTC() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? String(vars[key]) : `{${key}}`));
}

// Build a Keep-a-Changelog bullet (without the leading "- ", changelog.js adds that on render).
// `titleOverride` (see extractChangelogNote) replaces {title} when the PR author/maintainer
// wrote a custom changelog line in the PR description.
function renderBullet(entryTemplate, pr, titleOverride) {
  const rendered = renderTemplate(entryTemplate, {
    title: titleOverride || pr.title,
    number: pr.number,
    author: pr.user ? pr.user.login : '',
    url: pr.html_url,
  });
  return rendered.replace(/^-\s*/, '');
}

// Look for a "Changelog: <custom text>" line (case-insensitive) in the PR description and use
// that instead of the PR title — lets a PR author/maintainer write the user-facing wording
// themselves instead of relying on the (often too-technical) PR title.
function extractChangelogNote(body, marker) {
  if (!body || !marker) return null;
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`^\\s*${escapedMarker}\\s*(.+)$`, 'im'));
  return match ? match[1].trim() || null : null;
}

// Fallback used only when the "version" input is left empty and the action.yml default
// expression (github.event.release.tag_name || github.ref_name) didn't apply — e.g.
// src/index.js invoked directly, outside a release event. context.ref is the *full* ref
// (refs/tags/v1.2.3), unlike the YAML-level github.ref_name, so strip the prefix to match.
function releaseOrRefVersion(context) {
  if (context.payload.release) return context.payload.release.tag_name;
  return String(context.ref || '').replace(/^refs\/(tags|heads)\//, '');
}

async function runAddUnreleased({ github, context, core, parsed, categoryOrder, labelMapping, excludeLabels, defaultCategory, entryTemplate, noteMarker }) {
  let pr = context.payload.pull_request;
  const prNumberInput = env('INPUT_PR_NUMBER');

  if (!pr && prNumberInput) {
    const { data } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(prNumberInput) });
    pr = data;
  }

  if (!pr) {
    core.setFailed('add-unreleased mode requires a pull_request(_target) event payload or the pr-number input.');
    return { entries: [], added: false, prNumber: null };
  }

  if (!(pr.merged_at || pr.merged)) {
    core.info(`PR #${pr.number} is not merged — skipping.`);
    return { entries: [], added: false, prNumber: pr.number };
  }

  const category = labelsLib.categorize(pr.labels, { labelMapping, categoryOrder, excludeLabels, defaultCategory });
  if (!category) {
    core.info(`PR #${pr.number} has no matching/mapped label — skipping.`);
    return { entries: [], added: false, prNumber: pr.number };
  }

  const note = extractChangelogNote(pr.body, noteMarker);
  const bullet = renderBullet(entryTemplate, pr, note);

  // Dedup relies on the PR number appearing somewhere in the bullet's visible text (the
  // default entry-template includes it as "(#42)"). Custom templates must keep {number}
  // in some form, or re-runs of the same PR will add a duplicate entry.
  const section = changelogLib.ensureUnreleased(parsed);
  const added = changelogLib.addBullet(section, category, bullet, categoryOrder, `#${pr.number}`);

  if (!added) core.info(`Entry for #${pr.number} already present — skipping (idempotent).`);

  return { entries: added ? [bullet] : [], added, prNumber: pr.number };
}

async function run({ github, context, core, exec }) {
  const token = env('INPUT_TOKEN');
  if (token) core.setSecret(token);

  const file = env('INPUT_CHANGELOG_FILE', 'CHANGELOG.md');
  const categoryOrder = labelsLib.parseList(env('INPUT_CATEGORY_ORDER'), labelsLib.DEFAULT_CATEGORY_ORDER);
  const labelMapping = labelsLib.parseLabelMapping(env('INPUT_LABEL_MAPPING'));
  const excludeLabels = labelsLib.parseList(env('INPUT_EXCLUDE_LABELS'), labelsLib.DEFAULT_EXCLUDE_LABELS);
  const defaultCategory = envStrict('INPUT_DEFAULT_CATEGORY', 'Changed');
  const entryTemplate = env('INPUT_ENTRY_TEMPLATE', '- {title} (#{number})');
  const noteMarker = envStrict('INPUT_NOTE_MARKER', 'Changelog:');
  const keepUnreleased = boolEnv('INPUT_KEEP_UNRELEASED', true);
  const skipPrerelease = boolEnv('INPUT_SKIP_PRERELEASE', true);
  const skipIfEmpty = boolEnv('INPUT_SKIP_IF_EMPTY', true);
  const doCommit = boolEnv('INPUT_COMMIT', true);
  const date = env('INPUT_DATE') || todayUTC();
  const actionRef = env('INPUT_ACTION_REF');
  const commitBranch = env('INPUT_COMMIT_BRANCH', 'main');

  let mode = env('INPUT_MODE', 'auto');
  if (mode === 'auto') {
    if (context.eventName === 'release') mode = 'promote-unreleased';
    else if (context.eventName === 'pull_request' || context.eventName === 'pull_request_target') mode = 'add-unreleased';
    else {
      core.setFailed(`Cannot auto-resolve mode for event "${context.eventName}" — set the "mode" input explicitly.`);
      return;
    }
  }
  core.info(`Mode: ${mode}`);

  const rawContent = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const parsed = changelogLib.parseOrCreate(rawContent);

  let entries = [];
  let version = '';
  let hasChanges = false;
  let commitMessage;
  let prNumber = null;

  if (mode === 'add-unreleased') {
    const result = await runAddUnreleased({ github, context, core, parsed, categoryOrder, labelMapping, excludeLabels, defaultCategory, entryTemplate, noteMarker });
    entries = result.entries;
    hasChanges = result.added;
    prNumber = result.prNumber;
    commitMessage = renderTemplate(env('INPUT_COMMIT_MESSAGE', 'docs: add changelog entry for #{number}'), { number: prNumber, version });
  } else if (mode === 'promote-unreleased') {
    version = stripV(env('INPUT_VERSION', releaseOrRefVersion(context)));
    commitMessage = renderTemplate(env('INPUT_COMMIT_MESSAGE', 'ci: update changelog for {version}'), { version });

    if (skipPrerelease && context.payload.release && context.payload.release.prerelease) {
      core.info(`Release ${version} is a pre-release — skipping promote (skip-prerelease: true).`);
    } else {
      const result = changelogLib.promote(parsed, version, date, keepUnreleased);
      if (!result) {
        core.warning('No [Unreleased] section found — nothing to promote.');
      } else if (!result.hadContent && skipIfEmpty) {
        core.warning('[Unreleased] section is empty — skipping promote.');
      } else {
        hasChanges = true;
        entries = [`Promoted [Unreleased] to ${version} (${date})`];
      }
    }
  } else {
    core.setFailed(`Unknown mode: ${mode}`);
    return;
  }

  if (!hasChanges) {
    core.info('No changelog changes to write.');
    await summaryLib.writeSummary({ core, mode, file, version, entries: [], committed: false, commitBranch, actionRef });
    core.setOutput('version', version);
    core.setOutput('changelog-file', file);
    core.setOutput('updated', 'false');
    core.setOutput('entries-count', '0');
    return;
  }

  const newContent = changelogLib.render(parsed);
  fs.writeFileSync(file, newContent, 'utf8');
  core.info(`Wrote ${file}`);

  let committed = false;
  if (doCommit) {
    const result = await commitLib.commitAndPush({
      exec,
      core,
      file,
      commitMessage,
      commitBranch,
      authorName: env('INPUT_COMMIT_AUTHOR_NAME', 'froozeify-gh-changelog-updater'),
      authorEmail: env('INPUT_COMMIT_AUTHOR_EMAIL', 'froozeify-gh-changelog-updater[bot]@users.noreply.github.com'),
      token,
    });
    committed = result.committed;
  }

  await summaryLib.writeSummary({ core, mode, file, version, entries, committed, commitBranch, actionRef });

  core.setOutput('version', version);
  core.setOutput('changelog-file', file);
  core.setOutput('updated', 'true');
  core.setOutput('entries-count', String(entries.length));
  core.setOutput('section', newContent);
}

module.exports = run;
