'use strict';

// Skipped silently when there is no job summary target (e.g. running outside GitHub Actions).
async function writeSummary({ core, mode, file, version, entries, committed, commitBranch, actionRef }) {
  if (!core.summary) return;

  const title = version ? `Update changelog v${version}` : 'Update changelog';
  core.summary.addHeading(title, 2);
  core.summary.addEOL();

  const lines = [
    '| | |',
    '|---|---|',
    `| **Mode** | ${mode} |`,
    `| **File** | \`${file}\` |`,
  ];
  if (version) lines.push(`| **Version** | \`${version}\` |`);
  lines.push(`| **Entries** | ${entries.length} |`);
  lines.push(committed ? `| **Committed to** | \`${commitBranch}\` |` : '| **Committed** | Skipped |');
  if (actionRef) lines.push(`| **Action version** | \`${actionRef}\` |`);

  core.summary.addRaw(lines.join('\n'), true);
  core.summary.addEOL();

  if (entries.length) {
    core.summary.addHeading('Entries', 3);
    core.summary.addList(entries);
  }

  await core.summary.write();
}

module.exports = { writeSummary };
