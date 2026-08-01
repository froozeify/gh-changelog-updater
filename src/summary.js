'use strict';

// Skipped silently when there is no job summary target (e.g. running outside GitHub Actions).
async function writeSummary({ core, mode, file, version, entries, committed, commitBranch, actionRef }) {
  if (!core.summary) return;

  core.summary.addHeading('update-changelog', 2);

  const rows = [
    ['**Mode**', mode],
    ['**File**', `\`${file}\``],
  ];
  if (version) rows.push(['**Version**', `\`${version}\``]);
  rows.push(['**Entries**', String(entries.length)]);
  rows.push(committed ? ['**Committed to**', `\`${commitBranch}\``] : ['**Committed**', 'Skipped']);
  if (actionRef) rows.push(['**Action version**', `\`${actionRef}\``]);

  core.summary.addTable(rows);

  if (entries.length) {
    core.summary.addHeading('Entries', 3);
    core.summary.addList(entries);
  }

  await core.summary.write();
}

module.exports = { writeSummary };
