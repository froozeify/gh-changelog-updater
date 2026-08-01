// src/commit.js — commit and push CHANGELOG.md updates.
// Two paths:
//   - commitViaApi: GitHub's createCommitOnBranch GraphQL mutation. GitHub signs the commit
//     server-side (shows as Verified) and the author is always the identity behind the token
//     used to call the API — it can't be spoofed via commit-author-name/email.
//   - commitAndPush: local git commit + push, for SSH remotes / self-hosted setups where the
//     API path isn't reachable. Mirrors the commit_and_push() routine from
//     gh-version-updater's update-version.sh, ported to actions/github-script's `exec` helper.

'use strict';

const MAX_ATTEMPTS = 3;

// applyChange(rawContent) -> { content, changed, entries } is supplied by the caller (built in
// src/index.js from the already-resolved PR/version data) so a conflict retry can be re-run
// against freshly-fetched remote content without redoing any async GitHub API work.
async function commitViaApi({ github, core, owner, repo, file, branch, headline, body, applyChange }) {
  const message = body ? `${headline}\n\n${body}` : headline;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { data: branchData } = await github.rest.repos.getBranch({ owner, repo, branch });
    const headOid = branchData.commit.sha;

    let rawContent = '';
    try {
      const { data: fileData } = await github.rest.repos.getContent({ owner, repo, path: file, ref: branch });
      rawContent = Buffer.from(fileData.content, fileData.encoding || 'base64').toString('utf8');
    } catch (err) {
      if (err.status !== 404) throw err;
      // File doesn't exist on the branch yet — applyChange is expected to create it from ''.
    }

    const result = applyChange(rawContent);
    if (!result.changed) {
      core.info(`Nothing to commit — ${file} is already up to date.`);
      return { committed: false, entries: result.entries };
    }

    try {
      const response = await github.graphql(
        `mutation($input: CreateCommitOnBranchInput!) {
          createCommitOnBranch(input: $input) {
            commit { oid url }
          }
        }`,
        {
          input: {
            branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
            expectedHeadOid: headOid,
            message: { headline, body },
            fileChanges: {
              additions: [{ path: file, contents: Buffer.from(result.content, 'utf8').toString('base64') }],
            },
          },
        },
      );

      const commit = response.createCommitOnBranch.commit;
      core.info(`Pushed to ${branch} (${commit.oid}).`);
      return { committed: true, message, sha: commit.oid, url: commit.url, entries: result.entries };
    } catch (err) {
      const isConflict = /expected(HeadOid)?|does not match|Head ref .* has changed/i.test(String(err.message || ''));
      if (!isConflict || attempt === MAX_ATTEMPTS) throw err;
      core.warning(`Branch ${branch} moved while committing — retrying (attempt ${attempt}/${MAX_ATTEMPTS}).`);
    }
  }

  return { committed: false };
}

async function commitAndPush({ exec, core, file, commitMessage, commitMessageBody, commitBranch, authorName, authorEmail, token }) {
  // Read-only and independent of the add/diff/commit sequence below, so it can run
  // concurrently instead of after the commit.
  let remoteUrl = '';
  const remoteUrlPromise = exec.exec('git', ['remote', 'get-url', 'origin'], {
    listeners: {
      stdout: (data) => {
        remoteUrl += data.toString();
      },
    },
  });

  await exec.exec('git', ['add', '--', file]);

  // git diff --cached --quiet exits 0 when there is nothing staged.
  const diffExit = await exec.exec('git', ['diff', '--cached', '--quiet'], { ignoreReturnCode: true });
  if (diffExit === 0) {
    await remoteUrlPromise;
    core.info(`Nothing to commit — ${file} is already up to date.`);
    return { committed: false };
  }

  const commitArgs = ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '--message', commitMessage];
  if (commitMessageBody) commitArgs.push('--message', commitMessageBody);

  // Author/email set via -c instead of separate `git config` calls, saving two subprocess spawns.
  await exec.exec('git', commitArgs);

  await remoteUrlPromise;
  remoteUrl = remoteUrl.trim();

  // Inject the token into the remote URL for an authenticated push.
  const authRemoteUrl = remoteUrl.replace('https://', `https://x-access-token:${token}@`);

  await exec.exec('git', ['push', authRemoteUrl, `HEAD:refs/heads/${commitBranch}`]);
  core.info(`Pushed to ${commitBranch}.`);

  return { committed: true, message: commitMessage };
}

module.exports = { commitViaApi, commitAndPush };
