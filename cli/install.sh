#!/usr/bin/env bash

set -euo pipefail

# check that 'bun' is installed

if ! command -v bun > /dev/null; then
  echo "bun is not installed. Follow the instructions at https://bun.sh/docs/installation"
  exit 1
fi

REPO="https://github.com/wormhole-foundation/example-native-token-transfers.git"

function main {
  branch=""

  while [[ $# -gt 0 ]]; do
    key="$1"

    case $key in
      -b|--branch)
        branch="$2"
        shift
        shift
        ;;
      -r|--repo)
        REPO="$2"
        shift
        shift
        ;;
      *)
        echo "Unknown option $key"
        exit 1
        ;;
    esac
  done

  path=""
  mkdir -p "$HOME/.ntt-cli"

  # check if there's a package.json in the parent directory, with "name": "@wormhole-foundation/ntt-cli"
  if [ -f "$(dirname $0)/package.json" ] && grep -q '"name": "@wormhole-foundation/ntt-cli"' "$(dirname $0)/package.json"; then
    path="$(dirname $0)/.."
    version=$(git -C "$path" rev-parse HEAD 2>/dev/null || echo "unknown")
    dirty=$(git -C "$path" diff --quiet 2>/dev/null || echo "-dirty")
    echo "$version$dirty" > "$HOME/.ntt-cli/version"
  else
    check_commit_included_in_main="false"
    # if branch is set, use it. otherwise use the latest tag of the form "vX.Y.Z+cli"
    if [ -z "$branch" ]; then
      branch="$(select_branch)"
      # if the branch was not set, we want to check that the default is included
      # in the main branch, i.e. it has been reviewed
      check_commit_included_in_main="true"
    else
      branch="origin/$branch"
    fi

    # clone to $HOME/.ntt-cli if it doesn't exist, otherwise update it
    echo "Cloning $REPO $branch"

    path="$HOME/.ntt-cli/.checkout"

    if [ ! -d "$path" ]; then
      git clone "$REPO" "$path"
    fi
    pushd "$path"
    # update origin url to REPO
    git remote set-url origin "$REPO"
    git fetch origin
    if [ "$check_commit_included_in_main" = "true" ]; then
      # check that the commit is included in the main branch
      if ! git merge-base --is-ancestor "$branch" "origin/main"; then
        echo "ref '$branch' is not included in the main branch"
        exit 1
      fi
    fi
    # reset hard
    git reset --hard "$branch"
    version=$(git rev-parse HEAD)
    dirty=$(git diff --quiet || echo "-dirty")
    echo "$version$dirty" > "$HOME/.ntt-cli/version"
    popd
  fi

  absolute_path="$(cd $path && pwd)"
  echo $absolute_path >> "$HOME/.ntt-cli/version"

  # jq would be nicer but it's not portable
  # here we make the assumption that the file uses 2 spaces for indentation.
  # this is a bit fragile, but we don't want to catch further nested objects
  # (there might be a "version" in the scripts section, for example)
  version=$(cat "$path/cli/package.json" | grep '^  "version":' | cut -d '"' -f 4)
  echo "$version" >> "$HOME/.ntt-cli/version"

  remote_url=$(git -C "$path" remote get-url origin 2>/dev/null || echo "unknown")
  echo "$remote_url" >> "$HOME/.ntt-cli/version"

  echo "Installing ntt CLI version $version"
  install_cli "$path"
}

# function that determines which branch/tag to clone
function select_branch {
  # if the repo has a tag of the form "vX.Y.Z+cli", use that (the latest one)
  branch=""
  regex="refs/tags/v[0-9]*\.[0-9]*\.[0-9]*+cli"
  if git ls-remote --tags "$REPO" | grep -q "$regex"; then
    branch="$(git ls-remote --tags "$REPO" | grep "$regex" | awk '{print $2}' | sort -V | tail -n 1)"
  else
    # otherwise error
    echo "No tag of the form vX.Y.Z+cli found" >&2
    exit 1
  fi

  echo "$branch"
}

function install_cli {
  cd "$1"

  # if 'ntt' is already installed, uninstall it
  # just check with 'which'
  if which ntt > /dev/null; then
    echo "Removing existing ntt CLI"
    rm $(which ntt)
  fi

  # swallow the output of the first install
  # TODO: figure out why it fails the first time.
  bun install > /dev/null 2>&1 || true
  bun install

  # make a temporary directory

  tmpdir="$(mktemp -d)"

  # create a temporary symlink 'npm' to 'bun'

  ln -s "$(command -v bun)" "$tmpdir/npm"

  # add the temporary directory to the PATH

  export PATH="$tmpdir:$PATH"

  # swallow the output of the first build
  # TODO: figure out why it fails the first time.
  bun --bun run --filter '*' build > /dev/null 2>&1 || true
  bun --bun run --filter '*' build

  # remove the temporary directory

  rm -r "$tmpdir"

  # now link the CLI

  cd cli

  bun link

  bun link @wormhole-foundation/ntt-cli
}

main "$@"
