#!/usr/bin/env bash
# Builds cofertility/v<version> from upstream tag twenty/v<version> plus our branches.
# Usage: git cofertility-release <version|latest> [--rebuild]
# Runs in a separate worktree, so the current checkout is never touched.
set -euo pipefail

version="${1:?usage: release.sh <version, e.g. 2.51.0, or latest> [--rebuild]}"
rebuild="${2:-}"
infra_branch="cofertility/infra"
image_workflow=".github/workflows/cofertility-image.yaml"

git fetch upstream --tags --quiet
git fetch origin --quiet

if [[ "${version}" == "latest" ]]; then
  # Upstream tags a version before publishing its release notes; only take published releases
  version="$(gh release view -R twentyhq/twenty --json tagName --jq .tagName)"
  version="${version#twenty/v}"
  [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "Latest upstream release is not a twenty/vX.Y.Z tag: ${version}" >&2
    exit 1
  }
  echo "Latest upstream release: ${version}"
fi

base="twenty/v${version}"
release_branch="cofertility/v${version}"
tmp_root="${TMPDIR:-/tmp}"
worktree="${tmp_root%/}/twenty-release-${version}"

git rev-parse --verify --quiet "${base}^{commit}" >/dev/null || {
  echo "Upstream tag ${base} not found" >&2
  exit 1
}

if git rev-parse --verify --quiet "refs/heads/${release_branch}" >/dev/null; then
  if [[ "${rebuild}" != "--rebuild" ]]; then
    echo "${release_branch} already exists; pass --rebuild to recreate it" >&2
    exit 1
  fi
  echo "Rebuilding ${release_branch} (previous tip: $(git rev-parse --short "${release_branch}"))"
fi

branches=("${infra_branch}")
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line//[[:space:]]/}"
  [[ -n "${line}" ]] && branches+=("${line}")
done < <(git show "${infra_branch}:cofertility/release-branches")

for branch in "${branches[@]}"; do
  git rev-parse --verify --quiet "refs/heads/${branch}" >/dev/null || {
    echo "Branch ${branch} not found locally" >&2
    exit 1
  }
done

git worktree remove --force "${worktree}" 2>/dev/null || true
git worktree add --quiet -B "${release_branch}" "${worktree}" "${base}"

run() {
  git -C "${worktree}" -c rerere.enabled=true -c rerere.autoUpdate=true "$@"
}

stop_on_conflict() {
  echo >&2
  echo "Conflict while applying $1. Resolve it in ${worktree} and finish the" >&2
  echo "cherry-pick, then re-run with --rebuild (rerere will replay the resolution)." >&2
  exit 1
}

for branch in "${branches[@]}"; do
  # Branches are based on upstream/main, which is ahead of the tag; only replay their own commits
  fork_point="$(git merge-base upstream/main "${branch}")"
  commits=()
  while IFS= read -r commit; do commits+=("${commit}"); done \
    < <(git rev-list --reverse --no-merges "${fork_point}..${branch}")

  if [[ ${#commits[@]} -eq 0 ]]; then
    echo "Skipping ${branch}: no commits beyond upstream/main"
    continue
  fi

  echo "Applying ${branch} (${#commits[@]} commits)"
  run switch --quiet --detach

  for commit in "${commits[@]}"; do
    if ! run cherry-pick "${commit}" >/dev/null; then
      unmerged="$(git -C "${worktree}" diff --name-only --diff-filter=U)"
      if [[ "${unmerged}" == "yarn.lock" ]]; then
        echo "  regenerating yarn.lock for $(git log -1 --format='%h' "${commit}")"
        run checkout --ours yarn.lock
        # The worktree has no node_modules, so yarn.config.cjs constraints cannot load
        (cd "${worktree}" && YARN_ENABLE_CONSTRAINTS_CHECKS=false \
          yarn install --mode=update-lockfile >/dev/null)
        run add yarn.lock
      elif [[ -n "${unmerged}" ]]; then
        stop_on_conflict "${branch} ($(git log -1 --format='%h %s' "${commit}"))"
      else
        echo "  rerere resolved $(git log -1 --format='%h' "${commit}")"
      fi
      GIT_EDITOR=true run cherry-pick --continue >/dev/null
    fi
  done

  feature_tip="$(git -C "${worktree}" rev-parse HEAD)"
  run switch --quiet "${release_branch}"
  run merge --quiet --no-ff -m "Merge branch '${branch}' into ${release_branch}" "${feature_tip}"
done

git worktree remove "${worktree}"

# Fork pushes register upstream's workflow files as active; only the image build should run
if command -v gh >/dev/null; then
  origin_repo="$(git remote get-url origin | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')"
  active="$(gh api "repos/${origin_repo}/actions/workflows" --paginate \
    --jq ".workflows[] | select(.state == \"active\" and .path != \"${image_workflow}\") | \"\(.id) \(.path)\"" \
    2>/dev/null || echo "?")"
  if [[ "${active}" == "?" ]]; then
    echo "Could not list ${origin_repo} workflows; check that none but the image build are active" >&2
  elif [[ -n "${active}" ]]; then
    echo
    echo "Active workflows on ${origin_repo} besides the image build (disable with"
    echo "gh api -X PUT repos/${origin_repo}/actions/workflows/<id>/disable):"
    echo "${active}" | sed 's/^/  /'
  fi
fi

echo
echo "Built ${release_branch}: ${base} + ${branches[*]}"
echo "Next:"
echo "  git push --force-with-lease origin ${release_branch}"
echo "  then run the 'Cofertility image' workflow on ${release_branch} with tag v${version}-cf.<n>"
