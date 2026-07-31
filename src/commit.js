// src/commit.js — commit and push CHANGELOG.md updates.
// Mirrors the commit_and_push() routine from gh-version-updater's update-version.sh,
// ported to actions/github-script's `exec` helper (@actions/exec).

'use strict';

async function commitAndPush({ exec, core, file, commitMessage, commitBranch, authorName, authorEmail, token }) {
  await exec.exec('git', ['config', '--local', 'user.name', authorName]);
  await exec.exec('git', ['config', '--local', 'user.email', authorEmail]);
  await exec.exec('git', ['add', '--', file]);

  // git diff --cached --quiet exits 0 when there is nothing staged.
  const diffExit = await exec.exec('git', ['diff', '--cached', '--quiet'], { ignoreReturnCode: true });
  if (diffExit === 0) {
    core.info(`Nothing to commit — ${file} is already up to date.`);
    return { committed: false };
  }

  await exec.exec('git', ['commit', '--message', commitMessage]);

  let remoteUrl = '';
  await exec.exec('git', ['remote', 'get-url', 'origin'], {
    listeners: {
      stdout: (data) => {
        remoteUrl += data.toString();
      },
    },
  });
  remoteUrl = remoteUrl.trim();

  // Inject the token into the remote URL for an authenticated push.
  const authRemoteUrl = remoteUrl.replace('https://', `https://x-access-token:${token}@`);

  await exec.exec('git', ['push', authRemoteUrl, `HEAD:refs/heads/${commitBranch}`]);
  core.info(`Pushed to ${commitBranch}.`);

  return { committed: true, message: commitMessage };
}

module.exports = { commitAndPush };
