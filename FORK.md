# FORK.md: pmossman/forceteki, the tools fork

This repository is Parker Mossman's fork of [SWU-Karabast/forceteki](https://github.com/SWU-Karabast/forceteki), the
Star Wars: Unlimited rules engine and game server behind [Karabast](https://karabast.net). The fork carries "offline"
tools built on Karabast's engine and UI: a board editor, hotseat play for both seats, a trigger-stack viewer and
branching analysis. Its companion is [pmossman/forceteki-client](https://github.com/pmossman/forceteki-client).

The fork does not depend on upstream accepting anything. Upstreaming pieces of it is optional and happens on separate
branches (see "Cutting an upstream PR").

This file is part of the fork layer. It does not exist upstream.

## Branch model

| Branch | What it is | Who moves it |
|---|---|---|
| `main` | An exact mirror of `upstream/main`. Never commit to it. It only ever fast-forwards. | The sync workflow, or a person with `git push origin upstream/main:main` |
| `tools` | Upstream plus our layer. The fork's default and working branch. | Our commits and PRs; the sync workflow merges upstream into it |
| `sync/<date>-run<N>` | A sync attempt that needs attention (merge conflicts, failing checks, or a push GITHUB_TOKEN may not make). | Created by the sync workflow only on failure; resolved and deleted by a person |
| `tools-<topic>` | Work in progress on the tools, cut from `tools`, merged back into `tools`. | Us |
| `contrib/<topic>` | A change offered upstream, cut from `main`. Never contains fork-layer files. | Us |

Rules:
- `main` never has commits upstream doesn't have. If it ever does, the sync workflow stops touching it and reports
  it; a person sorts it out. Nothing is force-pushed.
- `tools` history is never rewritten. Upstream comes in by merge, never by rebase.
- Branches that existed before the fork was set up (2026-10-08) are left exactly as they are: never deleted,
  renamed or rewritten. Many are copies of upstream contributors' branches; a few are Parker's earlier upstream
  contributions (`feature/filtered-lobbies`, `feature/matchmaking-leader-base-filter`).
- A branch can't be called `tools/<anything>` because `tools` already exists (git can't hold both refs), hence
  `tools-<topic>`.

## Sync policy

`.github/workflows/fork-sync-upstream.yml` runs daily at 09:23 UTC and on demand (Actions tab, "Run workflow"; untick
"publish" for a dry run that pushes nothing). A manual run can also preview an upstream ref other than `main`, such as
`refs/pull/1234/head`, to see whether an upstream PR would break our layer before it lands; previews are always dry runs
and report only in the run summary.

1. Fetch `SWU-Karabast/forceteki` `main`.
2. Fast-forward our `main` to it, if `main` is a pure ancestor. Otherwise leave `main` alone and say so.
3. Run `node fork/check-layer.mjs` on `tools` as it stands. If `tools` already contains upstream, stop.
4. Merge `upstream/main` into `tools` with `fork/sync-merge.sh`. The merge is deterministic (fixed author, committer
   and date), so every job rebuilds the same commit sha and the commit that gets published is exactly the one that was
   tested.
5. Run upstream's own CI checks on the merge commit, in parallel jobs: `eslint`, `validate-cards`,
   `test-parallel` and `test-parallel-undo`. A test job that fails is re-run once without rebuilding; a pass on the
   retry counts as green and the flaky specs are listed as a warning.
6. All green: fast-forward `tools` to the merge commit. This is a plain push, rejected if `tools` moved meanwhile.
7. Anything else (conflict, red check, rejected push): push the attempt as `sync/<date>-run<N>`, with conflict markers
   committed as-is if it conflicted, then open an issue titled `[fork-sync] upstream sync needs attention` (or comment
   on the open one). If Issues are off, it tries a draft PR from the sync branch into `tools`. The run is marked failed
   either way, and the run summary always holds the full report.

The workflow needs no secrets. Its token is the run's `GITHUB_TOKEN`, scoped per job: the jobs that run upstream code
get read-only access and don't keep the token on disk; only the jobs that push or file the report get write access.

What the policy is:
- We take all of upstream, always. No cherry-picking, skipping or reverting upstream commits on `tools`. If upstream
  breaks something of ours, we fix our layer.
- A sync that conflicts or fails is fixed on its sync branch (or by redoing the merge locally), keeping to the layering
  rules below, then `tools` is fast-forwarded to the fix and the sync branch deleted.
- The repair stage in the workflow is a disabled stub (`if: false`). It is where the code factory will plug in once
  its gates exist; see "Code factory".

Known limit: `GITHUB_TOKEN` can't push commits that change `.github/workflows/*`. Upstream changes its workflow files
a few times a year (four times in 2026 so far). The workflow still tests such a sync, then reports it with the commands
to push it by hand:

```sh
git fetch upstream && git switch tools && git merge upstream/main && git push origin tools upstream/main:main
```

A fine-grained token with the Workflows permission, stored as a secret, would remove this limit. It isn't set up.

Syncing by hand, any time:

```sh
git remote add upstream https://github.com/SWU-Karabast/forceteki.git   # once
git fetch upstream
git push origin upstream/main:main                                      # mirror; fails safely if main diverged
git switch tools && git merge upstream/main                             # resolve conflicts per the layering rules
npm install && npx eslint --quiet && npm run test-parallel && node fork/check-layer.mjs
git push origin tools
```

## Layering rules

Every line we touch in an upstream file is a line that can conflict at the next sync. So:

1. **Our code lives in our own directories.** In this repo:
   - `FORK.md`, and `fork/**` for fork infrastructure and build tooling (the layer registry and check, sync scripts,
     and later the browser-engine bundle config and shims);
   - `server/**/fork/**` for engine-side code (e.g. a read-only resolution-stack walker, a position loader);
   - `test/**/fork/**` for our tests (picked up by the existing `tsc` and jasmine globs, so no config edits);
   - `.github/workflows/fork-*.yml` for our workflows.

   Any path with a `fork` directory segment is ours. The machine-readable list is `ourPaths` in `fork/layer.json`.
2. **Upstream files are touched only at named hook points.** A hook point is the smallest possible edit, ideally an
   import plus one call into our directories, never logic. Each one:
   - carries a marker comment on the edited lines: `// FORK-HOOK(<name>): <one-line why>. See FORK.md.`;
   - is registered in `fork/layer.json` (`hookPoints`: file, name, why, and an upstream PR link if one exists);
   - is listed in the table below.
3. **No drive-by edits to upstream files**: no reformatting, renames, dependency bumps, or fixes "while we're here".
   A fix to upstream code goes upstream on a `contrib/` branch. If we need it before upstream merges it, carry it as a
   registered hook point of kind "carried patch" with the upstream PR link, and drop it when the PR lands.
4. **Upstream config counts as an upstream file.** `package.json`, `package-lock.json`, `tsconfig*.json`,
   `eslint.config.mjs` and upstream workflows are hook points if we edit them. Prefer a separate config of our own
   (e.g. our own build script under `fork/`) to editing theirs. If a lockfile conflicts at sync, take upstream's and
   regenerate.
5. **Prefer reading engine state to changing engine behaviour.** Our engine code observes (walks windows, serialises
   state) and only drives the engine through the public input methods tests use (`cardClicked`, `menuButton`, ...).

`node fork/check-layer.mjs` enforces rules 1 and 2. It lists every file that differs from upstream and fails if one is
outside `ourPaths` and not a registered hook file, or if a registered hook file lacks its marker. The sync workflow
runs it on every sync. With `--base A --head B` it checks only the files changed between two commits, which is the
diff-scope gate a repair must pass.

Why this matters: automatic repair after an upstream change is only tractable if the area it can break is small and
known. With every touch point registered, a broken sync usually means one of two things: our code calls an engine API
that changed (fix it inside our directories), or a hook point conflicts (redo a one-line edit). Both are small, local
and checkable. Scattered edits through upstream files would turn each sync into an open-ended merge job.

### Registered hook points

None yet. `tools` currently differs from upstream only by the fork-layer files listed in rule 1.

| File | Hook name | Why | Upstream PR |
|---|---|---|---|

## Cutting an upstream PR

```sh
git fetch upstream
git switch -c contrib/<topic> upstream/main      # never from tools
# ...commit only the change itself; no fork/ files, no FORK.md, no FORK-HOOK markers
git push -u origin contrib/<topic>
gh pr create --repo SWU-Karabast/forceteki --base main --head pmossman:contrib/<topic>
```

- Talk to the maintainers on the Karabast Discord before opening anything sizeable; upstream's README asks for that.
- If `tools` already carries the change as a hook point, delete the hook point and its registry entry after the
  upstream PR merges and the next sync brings the change in.
- Automation (the sync workflow, the code factory) never pushes to, opens PRs on, or files issues on the upstream repos.
  Only a person does that.

## Licence and attribution

forceteki is MIT licensed: Copyright (c) 2016 Stuart Walsh (ringteki) and Copyright (c) 2024 Addison Mayberry. The
`LICENSE` file stays exactly as upstream has it, and its notice must ship with anything built from this code, including
the bundled JavaScript of a public site (for example as a licences page or a `LICENSE` file served with the bundle). Our
additions are released under the same MIT terms.

Card text, card data and card images are not covered by that licence. They are Fantasy Flight Games / Lucasfilm
property. `npm run get-cards` pulls card data from FFG's public card API (`admin.starwarsunlimited.com`); Karabast's
card images are served from Karabast's own S3 bucket. A public site must not fetch from Karabast's S3 bucket without
Karabast's permission, and how a public site sources card data and images is an open question
(see the stream's `SPIKE-browser-engine.md`).

## Naming and branding

- The public site has its own name (working name: karatools.com). It is never presented as Karabast or as an official
  Karabast product, and it doesn't use Karabast's logo or visual branding as its own.
- It says plainly that it is built on Karabast, with links to karabast.net and to the upstream repositories, and that it
  is an unofficial fan project not affiliated with Karabast, Fantasy Flight Games or Lucasfilm.
- Inside the code, upstream names stay as they are. Our own modules use our own names.

## Code factory

Planned, not built: when a sync fails, a Claude-based repair agent will try to fix it on the sync branch and open a PR
into `tools`, behind the gates above (upstream tests, our tests, a browser smoke test, `check-layer.mjs` scope check).
The design lives with the overseer stream (`CODE-FACTORY.md`). In this repo it is only the disabled `repair` job in
`fork-sync-upstream.yml`.

## Repository settings this relies on

- Default branch: `tools` (so the scheduled sync runs; GitHub only runs scheduled workflows from the default branch).
- Actions enabled. Workflow token default stays read-only; the sync workflow asks for the write permissions it needs.
- Optional: Issues enabled (sync reports become issues), or "Allow GitHub Actions to create and approve pull
  requests" (sync reports become draft PRs). With neither, reports live only in the run summary.
- Secrets: the sync needs none. `ANTHROPIC_API_KEY` exists for the future repair stage and is not referenced by any
  workflow yet.
