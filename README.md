# Froozeify's GH Changelog Updater (gCu)

A GitHub Action that automatically maintains a [Keep a Changelog](http://keepachangelog.com/) `CHANGELOG.md`:

- On every **merged pull request**, it appends an entry under `## [Unreleased]`, categorized by the
  PR's labels (Added / Changed / Fixed / ...).
- On every **published release**, it "cuts" the release: `## [Unreleased]` is restamped to
  `## [X.Y.Z] - YYYY-MM-DD` and a fresh empty `## [Unreleased]` is opened above it.
  Draft releases never trigger this (GitHub only fires `published` once a release leaves draft
  state), and pre-releases are skipped by default too — set `skip-prerelease: false` to include them.

---

## Quick start

One workflow, two triggers. `mode: auto` (the default) resolves the right behaviour from whichever event
fired, so the same `uses:` step works for both.

```yaml
# .github/workflows/changelog.yml
name: Changelog

on:
  pull_request_target:
    types: [ closed ]
  release:
    types: [ published ]

permissions:
  contents: write

jobs:
  update-changelog:
    if: github.event_name == 'release' || github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: main
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: froozeify/gh-changelog-updater@v1
```

`pull_request_target` (rather than `pull_request`) is used so the action gets a write-capable token even for pull requests opened from forks.

## Categories

Each pull request is filed under a Keep a Changelog category based on its labels, using `label-mapping` (see [Inputs](#inputs)).  
The default mapping mirrors the labels used in this repo's own `.github/release.yml`:

| Category     | Default labels                                                                                                        |
|--------------|-----------------------------------------------------------------------------------------------------------------------|
| `Added`      | `enhancement`, `feature`                                                                                              |
| `Fixed`      | `fix`, `bug`                                                                                                          |
| `Changed`    | `refactor`, `performance`, `style`, `documentation`, `test`, `ci`, `build`, `chore`, `github-actions`, `dependencies` |
| `Deprecated` | `deprecated`                                                                                                          |
| `Removed`    | `removed`                                                                                                             |
| `Security`   | `security`                                                                                                            |

Pull requests with none of these labels fall back to `default-category` (`Changed` by default; set to an empty string to skip unlabeled PRs entirely).  
Pull requests carrying an `exclude-labels` label (default: `ignore-for-release`) are always skipped.

Each entry shows the PR number by default (`- {title} (#{number})`).

`add-unreleased` mode matches entries by looking for `#42`.  
If you customize `entry-template`, keep `{number}` somewhere or re-runs will duplicate entries.

## Manual / custom changelog text

You can freely hand-edit `CHANGELOG.md` yourself.

- **Editing an auto-added entry's wording**: You should only keep the `#42` reference somewhere. The action matches entries by that number.
- **Adding your own lines that aren't tied to any PR**: Write them under `## [Unreleased]` (or any category) like any other markdown bullet. 
  - `add-unreleased` only ever *appends* a new bullet for the PR that triggered it; it never touches, reorders, or removes existing lines.
  - `promote-unreleased` only renames the `[Unreleased]` heading — it doesn't touch the bullets under it.

You can also front-load the wording before merging: write a line starting with `Changelog:` anywhere in the pull request description, and that text is used instead of the PR title

```
Changelog: Fix crash when opening the settings page
```

Customize or disable the marker with the `note-marker` input (set it to `''` to turn this off).

## Commit identity

Commits are authored as `github-actions[bot]` — the real, GitHub-linked bot account behind `${{ github.token }}`.  
By default (`commit-method: api`) they're also made through GitHub's `createCommitOnBranch` API, so GitHub signs them server-side and they show a green **Verified** badge; the author always matches whichever token you pass, regardless of
`commit-author-name`/`commit-author-email`.

### Committing as a GitHub App

If you want commits attributed to your own bot (rather than generic `github-actions[bot]`), or you need to bypass branch protection, or you want the changelog commit to *trigger* other workflows (`GITHUB_TOKEN` pushes deliberately don't, to avoid infinite loops) — register your own GitHub App,
install it on the repo, and mint a token for it with [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token):

```yaml
- uses: actions/create-github-app-token@v3
  id: app-token
  with:
    app-id: ${{ vars.APP_ID }}
    private-key: ${{ secrets.APP_KEY }}

- uses: froozeify/gh-changelog-updater@v1
  with:
    token: ${{ steps.app-token.outputs.token }}
```

With `commit-method: api` (the default) that's the whole change — the commit author follows the token automatically, so `commit-author-name`/`commit-author-email` don't need to be set.

## Committing to the pull request's own branch before merge

The default flow (`require-merged: true`, the canonical [Quick start](#quick-start) setup) adds the
entry to `main` right after merge — which needs `contents: write` on a possibly protected branch. If
`main` requires pull requests and you don't have a bypass-capable token handy, you can instead add the
entry to the PR's own branch *before* it merges, so it rides into the base branch as part of the merge
commit itself — no push to the base branch needed at all:

```yaml
# .github/workflows/changelog.yml
name: Changelog

on:
  pull_request:
    types: [ opened, synchronize, reopened, edited, labeled, unlabeled ]

permissions:
  contents: write

jobs:
  update-changelog:
    # GITHUB_TOKEN can never push to a fork's branch — same-repo PRs only.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.head_ref }}

      - uses: froozeify/gh-changelog-updater@v1
        with:
          require-merged: 'false'
          commit-branch: ${{ github.head_ref }}
```

Re-triggering on `edited`/`labeled`/`unlabeled` keeps the entry in sync as the title, description, or
labels change — each run updates the same entry (matched by PR number) instead of duplicating it. The
trade-off is the fork limitation: `GITHUB_TOKEN` can never push to a fork's branch, so this only covers
pull requests opened from within the same repository. Forks still need the post-merge flow above (with
a bypass-capable token if the base branch is protected).

## Inputs

| Input                 | Required | Default                                                     | Description                                                                                                                                     |
|-----------------------|----------|-------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| `mode`                | no       | `auto`                                                      | `auto` resolves from the event (`add-unreleased` on a PR event, `promote-unreleased` on a release event). Can be set explicitly.                |
| `version`             | no       | `${{ github.event.release.tag_name \|\| github.ref_name }}` | Version for promote. Leading `v` is stripped automatically.                                                                                     |
| `pr-number`           | no       | `${{ github.event.pull_request.number }}`                   | PR to add (add-unreleased mode).                                                                                                                |
| `require-merged`      | no       | `true`                                                      | Set `false` to add the entry to an open (not-yet-merged) PR — see [committing to pr](#committing-to-the-pull-requests-own-branch-before-merge). |
| `changelog-file`      | no       | `CHANGELOG.md`                                              | File to maintain.                                                                                                                               |
| `label-mapping`       | no       | see above                                                   | `Category=label1,label2` per line.                                                                                                              |
| `default-category`    | no       | `Changed`                                                   | Category for PRs with no matching label. Empty = skip.                                                                                          |
| `exclude-labels`      | no       | `ignore-for-release`                                        | Labels that exclude a PR entirely.                                                                                                              |
| `category-order`      | no       | `Added,Changed,Deprecated,Removed,Fixed,Security`           | Section ordering.                                                                                                                               |
| `entry-template`      | no       | `- {title} (#{number})`                                     | Bullet template. Placeholders: `{title}` `{number}` `{author}` `{url}`. Keep `{number}` in the template or re-runs will duplicate entries.      |
| `note-marker`         | no       | `Changelog:`                                                | PR description line that overrides the PR title for the entry's `{title}`. Empty string disables it.                                            |
| `skip-prerelease`     | no       | `true`                                                      | promote-unreleased does nothing on a pre-release event. Set `false` to promote pre-releases too.                                                |
| `skip-if-empty`       | no       | `true`                                                      | Skip promoting (and the commit) when `[Unreleased]` is empty.                                                                                   |
| `keep-unreleased`     | no       | `true`                                                      | After promoting, reopen an empty `[Unreleased]`. Set `false` to drop it.                                                                        |
| `date`                | no       | today (UTC)                                                 | Override the version's date.                                                                                                                    |
| `commit`              | no       | `true`                                                      | Set to `false` to update the file without committing.                                                                                           |
| `commit-message`      | no       | mode-dependent                                              | `docs: add changelog entry for #{number}` (add) / `ci: update changelog for {version}` (promote).                                               |
| `commit-branch`       | no       | `main`                                                      | Branch to push to.                                                                                                                              |
| `commit-method`       | no       | `api`                                                       | `api` commits via GitHub's `createCommitOnBranch` (signed, shows as Verified). `git` commits locally via `git commit`/`push` instead.           |
| `commit-author-name`  | no       | `github-actions[bot]`                                       | Git author name. Only used when `commit-method: git`.                                                                                           |
| `commit-author-email` | no       | `41898282+github-actions[bot]@users.noreply.github.com`     | Git author email. Only used when `commit-method: git`.                                                                                          |
| `token`               | no       | `${{ github.token }}`                                       | Needs `contents: write`.                                                                                                                        |

## Outputs

| Output           | Description                                          |
|------------------|------------------------------------------------------|
| `version`        | Clean version involved (empty for `add-unreleased`). |
| `changelog-file` | The file that was processed.                         |
| `updated`        | Whether the file was actually modified.              |
| `entries-count`  | Number of entries written in this run.               |
| `section`        | The full rendered changelog content after this run.  |

---

See also the companion actions:

- [`froozeify/gh-version-updater`](https://github.com/froozeify/gh-version-updater) — bump version fields in config files on release.
- [`froozeify/gh-release-semver-autotag`](https://github.com/froozeify/gh-release-semver-autotag) — maintain rolling `v1`/`v1.2` tags on release.
