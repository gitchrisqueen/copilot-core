# Contributing

## Local development

```bash
npm install && npm test                              # JS: node:test + c8 coverage
pip install -e '.[dev]' && pytest test/python/        # Python: pytest + coverage.py
```

Both suites must pass, and coverage must meet the gates in [codecov.yml](codecov.yml) (80%
project + patch), before a PR can merge.

## Branch protection (repo owner setup, one time)

This repo is maintained solo, and GitHub does not allow a PR author to approve their own PR --
a literal "1 human approval required" rule would deadlock every merge. The review requirement is
instead satisfied by the `claude-review` workflow: it posts a review comment on every PR and its
own job exit code is a **required status check**, so it genuinely blocks a bad merge even with
zero required human approvals.

**Settings -> Rules -> Rulesets -> New branch ruleset**, name `main-protection`, target the
default branch, Enforcement: Active.

- Bypass list: **repo admin only** (an audited emergency hatch -- using it is logged, which is
  the point; it exists so an Anthropic API outage can't permanently block merges).
- Restrict deletions: on
- Block force pushes: on
- Require linear history: on
- Require a pull request before merging: on
  - Required approvals: **0**
  - Dismiss stale approvals on new commits: on
  - Require review from Code Owners: **off** (a solo maintainer can never satisfy this -- it
    would deadlock every PR; CODEOWNERS still exists for routing if a collaborator joins later)
  - Require conversation resolution before merging: on
- Require status checks to pass: on, require branches to be up to date, required checks:
  `js`, `python (3.11)`, `python (3.13)`, `shell`, `review` (the claude-review job),
  `codecov/project`, `codecov/patch` (the codecov pair only becomes selectable after the first
  coverage upload -- add them in a follow-up pass)

**Settings -> General**: allow squash merge only (disable merge commits and rebase merging);
auto-delete head branches; Issues enabled.

**Settings -> Advanced Security**: Dependabot alerts + security updates on; CodeQL default setup
on (free for public repos, zero YAML to write); secret scanning + push protection on.

## Required repo secrets

- `ANTHROPIC_API_KEY` -- for the claude-review workflow
- `CODECOV_TOKEN` -- from the CodeCov GitHub App install (public repos can upload tokenless, but
  a token avoids a rate-limit flake class)
- npm and PyPI publishing are meant to use **trusted publishing (OIDC)** once configured on each
  registry, so no long-lived publish tokens are needed as repo secrets. That configuration has
  not been done yet: the `npm-publish` and `pypi-publish` jobs failed on both the `v0.1.0` and
  `v0.1.1` release runs, and neither package is on its registry. Consumers install from a git
  tag for now (see [README.md](README.md#using-it-from-an-app)).

## Versioning

Semver, one version tracked across `package.json` and `pyproject.toml` in lockstep. Releases are
tag-driven (`vX.Y.Z` on `main`); `.github/workflows/release.yml` runs the full CI suite, then
publishes to npm and PyPI, then creates a GitHub Release with generated notes. The publish steps
have not succeeded yet (see above), so no GitHub Release has been created for either tag.
