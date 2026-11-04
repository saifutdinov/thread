#!/usr/bin/env bash
# Everything to run before asking for a review, in one command: what CI runs,
# plus the linter and the em dash rule. BASE is what the branch is compared
# with for that rule (default origin/main).
set -euo pipefail
cd "$(dirname "$0")/.."
base=${BASE:-origin/main}
dash=$(printf '\342\200\224') # the character itself would break the rule here

step() { printf '\n== %s\n' "$*"; }

step gofmt
unformatted=$(gofmt -l .)
if [ -n "$unformatted" ]; then
	echo "$unformatted"
	exit 1
fi

step go vet
go vet ./...

step golangci-lint
golangci-lint run

step go test
go test -race ./...

step web
(
	cd web
	npm test
	npm run test:proxy
	npm run build
)

step restore checker
python3 -m unittest discover -s scripts -p '*_test.py'

step em dash
if git diff "$(git merge-base "$base" HEAD)" -- . ':!web/package-lock.json' | grep -n "^+.*$dash"; then
	echo "No em dash (U+2014) in code, docs or UI strings."
	exit 1
fi

printf '\nAll checks passed.\n'
