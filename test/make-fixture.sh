#!/usr/bin/env bash
# Creates a tiny deterministic git repository used by test/run-tests.js.
# Every commit has fixed authors and dates so expected metrics are exact.
set -euo pipefail

DIR="${1:-$(dirname "$0")/fixtures/tiny}"
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"

git init -q -b main .
git config user.name "Fixture"
git config user.email "fixture@example.com"
git config commit.gpgsign false

commit() { # $1=date $2=name $3=email $4=message
  GIT_AUTHOR_NAME="$2" GIT_AUTHOR_EMAIL="$3" \
  GIT_COMMITTER_NAME="$2" GIT_COMMITTER_EMAIL="$3" \
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" \
  git commit -q -m "$4"
}

# Commit A (Alice): .mailmap + a.txt (3 lines)
printf 'Alice <alice@example.com> <alice@wits.ac.za>\n' > .mailmap
printf 'one\ntwo\nthree\n' > a.txt
git add -A
commit "2024-01-01T00:00:00Z" "Alice" "alice@example.com" "A: initial commit"

# Commit B (Bob): modify a.txt (+3 -1), add dir/b.txt (2 lines)
printf 'one\nTWO\nthree\nfour\nfive\n' > a.txt
mkdir -p dir
printf 'x\ny\n' > dir/b.txt
git add -A
commit "2024-01-02T00:00:00Z" "Bob" "bob@example.com" "B: edits"

# Commit C (Bob): pure rename dir/b.txt -> dir/c.txt
git mv dir/b.txt dir/c.txt
commit "2024-01-03T00:00:00Z" "Bob" "bob@example.com" "C: rename"

# Commit D (Alice): delete dir/c.txt (2 lines removed)
git rm -q dir/c.txt
commit "2024-01-04T00:00:00Z" "Alice" "alice@example.com" "D: delete c.txt"

# Commit E (Alice via her Wits email - should be mailmap-merged):
# binary file (not measured) + one line added to a.txt
printf 'BIN\0DATA\n' > bin.dat
printf 'one\nTWO\nthree\nfour\nfive\nsix\n' > a.txt
git add -A
commit "2024-01-05T00:00:00Z" "Alice Rob" "alice@wits.ac.za" "E: binary + edit"

echo "fixture created at $DIR"
