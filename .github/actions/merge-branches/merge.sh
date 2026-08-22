#!/usr/bin/env bash
set -euo pipefail

MODE="${MODE:-merge}"
SYNC_BACK="${SYNC_BACK:-false}"
GENERATED_PATHS="${GENERATED_PATHS:-README.md}"

case "$MODE" in
  merge | overwrite) ;;
  *)
    echo "::error::mode must be merge or overwrite, got '$MODE'"
    exit 1
    ;;
esac

git fetch --force --tags origin

resolve_ref() {
  if git rev-parse --verify --quiet "origin/$1" >/dev/null; then
    echo "origin/$1"
  else
    echo "$1"
  fi
}

# A --no-commit merge leaves HEAD at the pre-merge tip, so the branch's own prior state is what
# HEAD: resolves to. That is what lets a generated path be restored without recording it first.
restore_generated() {
  printf '%s\n' "$GENERATED_PATHS" | while IFS= read -r path; do
    [ -n "$path" ] || continue
    if git cat-file -e "HEAD:$path" 2>/dev/null; then
      git checkout HEAD -- "$path"
    else
      git rm -q --cached --ignore-unmatch -- "$path"
      rm -f "$path"
    fi
  done
}

merge_into() {
  from="$1"
  onto="$2"
  echo "::group::merge $from into $onto"

  if ! git ls-remote --exit-code --heads origin "$onto" >/dev/null 2>&1; then
    git checkout -b "$onto" "$from"
    git push origin "$onto"
    echo "created $onto from $from"
    echo "::endgroup::"
    return
  fi

  git checkout "$onto"

  if [ "$MODE" = overwrite ]; then
    git merge -s ours --no-commit --allow-unrelated-histories "$from"
    git read-tree --reset -u "$from"
  else
    git merge --no-commit --no-ff -X theirs "$from" || {
      git rev-parse -q --verify MERGE_HEAD >/dev/null || {
        echo "::error::merge of $from into $onto could not start"
        exit 1
      }
    }
  fi

  if ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    echo "already up to date: $onto contains $from"
    echo "::endgroup::"
    return
  fi

  restore_generated

  unresolved="$(git diff --name-only --diff-filter=U)"
  if [ -n "$unresolved" ]; then
    echo "::error::merge of $from into $onto left conflicts outside the generated paths:"
    echo "$unresolved"
    exit 1
  fi

  git commit --no-edit -m "chore: merge $from into $onto"
  git push origin "$onto"
  echo "::endgroup::"
}

source_ref="$(resolve_ref "$SOURCE")"
merge_into "$source_ref" "$TARGET"

if [ "$SYNC_BACK" = true ]; then
  if git ls-remote --exit-code --heads origin "$SOURCE" >/dev/null 2>&1; then
    merge_into "$(resolve_ref "$TARGET")" "$SOURCE"
  else
    echo "no $SOURCE branch to sync back to"
  fi
fi
