#!/usr/bin/env bash
# Fork layer script (not an upstream file). See FORK.md, "Sync policy".
#
# Merges an upstream commit into a tools commit, deterministically: the same three arguments always
# produce the same merge commit sha, so separate CI jobs can each rebuild the merge and test exactly
# the commit that will be published, without pushing anything first.
#
#   fork/sync-merge.sh <tools-sha> <upstream-sha> <iso-date>
#
# Leaves HEAD detached at the result.
#   exit 0  merged cleanly; prints the merge sha
#   exit 1  conflicts; the conflicted merge is left in the working tree and the conflicted paths are printed
set -euo pipefail

tools_sha=$1
upstream_sha=$2
when=$3

export GIT_AUTHOR_NAME='fork-sync'
export GIT_AUTHOR_EMAIL='fork-sync@users.noreply.github.com'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="$when"
export GIT_COMMITTER_DATE="$when"

git -c advice.detachedHead=false checkout -q --detach "$tools_sha"
if git merge -q --no-ff --no-edit -m "Sync upstream ${upstream_sha:0:9} into tools" "$upstream_sha" >/dev/null 2>&1; then
    git rev-parse HEAD
    exit 0
fi
git diff --name-only --diff-filter=U
exit 1
