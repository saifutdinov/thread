#!/usr/bin/env bash
# Updates Thread and restarts it. Data and .env stay.
#
#   sudo scripts/update.sh            # keep following what this server runs:
#                                     # main if it was cloned from main,
#                                     # otherwise the latest release
#   sudo scripts/update.sh release    # switch to the latest release (a v* tag)
#   sudo scripts/update.sh main       # switch to the newest code on main
#
# It never moves back to older code: the database only migrates forward.
set -euo pipefail
# shellcheck source=scripts/common.sh
. "$(dirname "$0")/common.sh"

need_docker
load_env
cd "$ROOT"

mode="${1:-auto}"
case "$mode" in
auto | release | main) ;;
*) die "Использование: scripts/update.sh [release|main]" "Usage: scripts/update.sh [release|main]" ;;
esac

step "Получение обновлений" "Fetching updates"
git fetch --quiet --tags origin
if [ "$mode" = auto ]; then
	if [ "$(git branch --show-current)" = main ]; then mode=main; else mode=release; fi
fi

if [ "$mode" = main ]; then
	git checkout --quiet main
	git pull --quiet --ff-only origin main
	target="main ($(git rev-parse --short HEAD))"
else
	target="$(git tag -l 'v*' --sort=-v:refname | head -1)"
	[ -n "$target" ] || die "Релизов пока нет. Для последней версии кода: scripts/update.sh main" "No releases yet. For the latest code: scripts/update.sh main"
	if [ "$(git rev-parse "$target^{commit}")" != "$(git rev-parse HEAD)" ] && git merge-base --is-ancestor "$target" HEAD; then
		die "Здесь код новее последнего релиза $target, а откатываться нельзя (база обновляется только вперёд). Обновляйтесь по main: scripts/update.sh main" \
			"This server runs code newer than the latest release $target, and going back is not supported (the database only migrates forward). Follow main: scripts/update.sh main"
	fi
	git -c advice.detachedHead=false checkout --quiet "$target"
fi
ok "Версия: $target" "Version: $target"

step "Пересборка и перезапуск" "Rebuilding and restarting"
compose up -d --build
wait_healthy || die "После обновления приложение не запустилось. Логи: scripts/status.sh --logs" "The app did not start after the update. Logs: scripts/status.sh --logs"
# Only this project's leftovers: the host may run other things.
docker image prune -f --filter label=com.docker.compose.project=thread >/dev/null
ok "Обновлено до $target" "Updated to $target"
