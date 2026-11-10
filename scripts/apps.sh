#!/usr/bin/env bash
# Puts this server's apps where people and the apps' updates find them:
# the installers, their checksums and the signed update manifest from a
# release of the fork that builds them for this server (docs/apps.md), into
# downloads/, which the server offers on the sign-in screen and in Settings.
#
#   sudo scripts/apps.sh owner/repo            # its latest release
#   sudo scripts/apps.sh owner/repo v1.2.3     # that release
#
# Every file is checked against the release's manifest before it replaces
# the ones there now.
set -euo pipefail
# shellcheck source=scripts/common.sh
. "$(dirname "$0")/common.sh"

repo="${1:-}"
tag="${2:-}"
case "$repo" in
*/*) ;;
*) die "Использование: scripts/apps.sh владелец/репозиторий [тег]" "Usage: scripts/apps.sh owner/repo [tag]" ;;
esac
if [ -n "$tag" ]; then base="https://github.com/$repo/releases/download/$tag"; else base="https://github.com/$repo/releases/latest/download"; fi

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

step "Получение списка приложений" "Fetching the list of apps"
curl -fsSL "$base/manifest.json" -o "$tmp/manifest.json" ||
	die "В релизе нет manifest.json: соберите приложения в форке (docs/apps.md)" "The release has no manifest.json: build the apps in the fork (docs/apps.md)"
curl -fsSL "$base/manifest.sig" -o "$tmp/manifest.sig" || warn "Манифест без подписи: приложения предложат только скачать обновление" "The manifest is unsigned: the apps only offer the update as a download"

# name<TAB>sha256 for each installer; only names as CI makes them.
python3 - "$tmp/manifest.json" >"$tmp/list" <<'PY'
import json, re, sys
for f in json.load(open(sys.argv[1]))['files']:
    if re.fullmatch(r'Thread-(Setup-)?[0-9][0-9A-Za-z._-]*\.(exe|dmg|deb|AppImage|apk)', f['name']) and re.fullmatch(r'[0-9a-f]{64}', f['sha256']):
        print(f['name'] + '\t' + f['sha256'])
PY
[ -s "$tmp/list" ] || die "В манифесте нет приложений" "The manifest lists no apps"

step "Скачивание приложений" "Downloading the apps"
while IFS="$(printf '\t')" read -r name sum; do
	curl -fsSL "$base/$name" -o "$tmp/$name"
	[ "$(sha256sum "$tmp/$name" | cut -d' ' -f1)" = "$sum" ] ||
		die "Контрольная сумма не сошлась: $name" "The checksum does not match: $name"
	ok "$name" "$name"
done <"$tmp/list"
(cd "$tmp" && cut -f1 list | xargs sha256sum >SHA256SUMS.txt)
rm -f -- "$tmp/list"

# Swapped in place: the server's bind mount holds this very folder. The new
# files go in first, then the old ones that are not among them go.
mkdir -p "$ROOT/downloads"
cp -- "$tmp"/* "$ROOT/downloads/"
for f in "$ROOT/downloads"/*; do
	[ -e "$tmp/$(basename -- "$f")" ] || rm -f -- "$f"
done
chmod -R a+rX "$ROOT/downloads"
ok "Приложения выложены: Настройки → Приложения" "The apps are up: Settings, Apps"
