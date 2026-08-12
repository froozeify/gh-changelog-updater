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
  return new Date().toISOString().slice(0, 10);
}

// Fixed constant, not an input: attributes a commit to this action in its body without needing
// a fake author identity. Never versioned (no "@ref") so there's nothing to maintain as tags move.
const TRAILER = 'Generated-by: froozeify/gh-changelog-updater';

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
// themselves instead of relying on the (often too-technical) PR title. HTML comments are
// stripped first: PR templates commonly show the marker as a commented-out usage example, which
// would otherwise be matched (as the *first* occurrence, ahead of anything the author wrote)
// instead of the real one below it.
function extractChangelogNote(body, marker) {
  if (!body || !marker) return null;
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, '');
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = withoutComments.match(new RegExp(`^\\s*${escapedMarker}\\s*(.+)$`, 'im'));
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

// Resolves everything that depends on the PR payload (async) but not on the changelog file's
// current content, so the actual mutation can be re-run as a pure function against whichever
// copy of the file (local checkout vs. freshly re-fetched remote) needs it — see applyAddUnreleased.
async function resolveAddUnreleased({ github, context, core, categoryOrder, labelMapping, excludeLabels, defaultCategory, entryTemplate, noteMarker, requireMerged }) {
  let pr = context.payload.pull_request;
  const prNumberInput = env('INPUT_PR_NUMBER');

  if (!pr && prNumberInput) {
    const { data } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(prNumberInput) });
    pr = data;
  }

  if (!pr) {
    core.setFailed('add-unreleased mode requires a pull_request(_target) event payload or the pr-number input.');
    return { ready: false, prNumber: null };
  }

  if (requireMerged && !(pr.merged_at || pr.merged)) {
    core.info(`PR #${pr.number} is not merged — skipping (require-merged is true).`);
    return { ready: false, prNumber: pr.number };
  }

  const category = labelsLib.categorize(pr.labels, { labelMapping, categoryOrder, excludeLabels, defaultCategory });
  if (!category) {
    core.info(`PR #${pr.number} has no matching/mapped label — skipping.`);
    return { ready: false, prNumber: pr.number };
  }

  const note = extractChangelogNote(pr.body, noteMarker);
  const bullet = renderBullet(entryTemplate, pr, note);

  // Dedup relies on the PR number appearing somewhere in the bullet's visible text (the
  // default entry-template includes it as "(#42)"). Custom templates must keep {number}
  // in some form, or re-runs of the same PR will add a duplicate entry — warn since this
  // otherwise fails silently.
  const refToken = `#${pr.number}`;
  if (!bullet.includes(refToken)) {
    core.warning(
      `entry-template doesn't include {number} — if this workflow run is ever re-triggered, PR #${pr.number}'s entry will be duplicated instead of recognized as already present.`,
    );
  }

  return { ready: true, prNumber: pr.number, category, bullet, refToken, categoryOrder, requireMerged };
}

// Pure: parses rawContent fresh each call so it can be re-run against a re-fetched remote copy
// on a commit conflict retry, not just the local checkout read at the top of run().
function applyAddUnreleased(rawContent, { category, bullet, refToken, categoryOrder, core, requireMerged }) {
  const parsed = changelogLib.parse(rawContent);
  const section = changelogLib.ensureUnreleased(parsed);
  const changed = changelogLib.upsertBullet(section, category, bullet, categoryOrder, refToken, !requireMerged);

  if (!changed && core) core.info(`Entry already present — skipping (idempotent).`);

  return { content: changelogLib.render(parsed), changed, entries: changed ? [bullet] : [] };
}

// Pure, same reasoning as applyAddUnreleased above.
function applyPromoteUnreleased(rawContent, { version, date, keepUnreleased, skipIfEmpty, core }) {
  const parsed = changelogLib.parse(rawContent);
  const result = changelogLib.promote(parsed, version, date, keepUnreleased);

  if (!result) {
    if (core) core.warning('No [Unreleased] section found — nothing to promote.');
    return { content: rawContent, changed: false, entries: [] };
  }
  if (!result.hadContent && skipIfEmpty) {
    if (core) core.warning('[Unreleased] section is empty — skipping promote.');
    return { content: rawContent, changed: false, entries: [] };
  }

  return { content: changelogLib.render(parsed), changed: true, entries: [`Promoted [Unreleased] to ${version} (${date})`] };
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
  const requireMerged = boolEnv('INPUT_REQUIRE_MERGED', true);
  const date = env('INPUT_DATE') || todayUTC();
  const actionRef = env('INPUT_ACTION_REF');
  const commitBranch = env('INPUT_COMMIT_BRANCH', 'main');
  const commitMethod = env('INPUT_COMMIT_METHOD', 'api');

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

  let entries = [];
  let version = '';
  let hasChanges = false;
  let commitMessage;
  let prNumber = null;
  let applyChange = null; // (rawContent) -> { content, changed, entries } — null when nothing to apply

  if (mode === 'add-unreleased') {
    const resolved = await resolveAddUnreleased({ github, context, core, categoryOrder, labelMapping, excludeLabels, defaultCategory, entryTemplate, noteMarker, requireMerged });
    prNumber = resolved.prNumber;
    commitMessage = renderTemplate(env('INPUT_COMMIT_MESSAGE', 'docs: add changelog entry for #{number}'), { number: prNumber, version });
    if (resolved.ready) applyChange = (raw) => applyAddUnreleased(raw, { ...resolved, core });
  } else if (mode === 'promote-unreleased') {
    version = stripV(env('INPUT_VERSION', releaseOrRefVersion(context)));
    commitMessage = renderTemplate(env('INPUT_COMMIT_MESSAGE', 'ci: update changelog for {version}'), { version });

    if (skipPrerelease && context.payload.release && context.payload.release.prerelease) {
      core.info(`Release ${version} is a pre-release — skipping promote (skip-prerelease: true).`);
    } else {
      applyChange = (raw) => applyPromoteUnreleased(raw, { version, date, keepUnreleased, skipIfEmpty, core });
    }
  } else {
    core.setFailed(`Unknown mode: ${mode}`);
    return;
  }

  let newContent = '';
  let committed = false;

  const localResult = applyChange ? applyChange(rawContent) : { content: rawContent, changed: false, entries: [] };
  hasChanges = localResult.changed;
  entries = localResult.entries;

  if (hasChanges) {
    newContent = localResult.content;
    fs.writeFileSync(file, newContent, 'utf8');
    core.info(`Wrote ${file}`);

    if (doCommit) {
      const commitBody = TRAILER;

      if (commitMethod === 'git') {
        const result = await commitLib.commitAndPush({
          exec,
          core,
          file,
          commitMessage,
          commitMessageBody: commitBody,
          commitBranch,
          authorName: env('INPUT_COMMIT_AUTHOR_NAME', 'github-actions[bot]'),
          authorEmail: env('INPUT_COMMIT_AUTHOR_EMAIL', '41898282+github-actions[bot]@users.noreply.github.com'),
          token,
        });
        committed = result.committed;
      } else {
        const result = await commitLib.commitViaApi({
          github,
          core,
          owner: context.repo.owner,
          repo: context.repo.repo,
          file,
          branch: commitBranch,
          headline: commitMessage,
          body: commitBody,
          applyChange,
        });
        committed = result.committed;
      }
    }
  } else {
    core.info('No changelog changes to write.');
  }

  await summaryLib.writeSummary({ core, mode, file, version, entries, committed, commitBranch, actionRef });

  core.setOutput('version', version);
  core.setOutput('changelog-file', file);
  core.setOutput('updated', String(hasChanges));
  core.setOutput('entries-count', String(entries.length));
  core.setOutput('section', newContent);
}

module.exports = run;
