# shellcheck shell=bash
# Shared helpers for the scripts in this folder. Sourced, not run.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

# Messages in Russian when the session's locale is Russian, else English.
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
ru*) RU=1 ;;
*) RU= ;;
esac

# say "русский текст" "English text"
say() { if [ -n "$RU" ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$(say "$1" "$2")"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$(say "$1" "$2")"; }
warn() { printf '\033[33m!\033[0m %s\n' "$(say "$1" "$2")" >&2; }
die() {
	printf '\033[31m✗\033[0m %s\n' "$(say "$1" "$2")" >&2
	exit 1
}

need_root() {
	[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo $0" "Run as root: sudo $0"
}

need_docker() {
	command -v docker >/dev/null 2>&1 ||
		die "Docker не установлен. Сначала: sudo scripts/setup-server.sh" "Docker is not installed. First run: sudo scripts/setup-server.sh"
	docker compose version >/dev/null 2>&1 ||
		die "Нет docker compose (плагин). Сначала: sudo scripts/setup-server.sh" "docker compose (plugin) is missing. First run: sudo scripts/setup-server.sh"
	docker info >/dev/null 2>&1 ||
		die "Нет доступа к Docker. Запустите через sudo." "Cannot talk to Docker. Run with sudo."
}

# compose runs docker compose on this repository's deploy file and .env.
compose() { docker compose -f "$ROOT/deploy/docker-compose.yml" --env-file "$ENV_FILE" "$@"; }

load_env() {
	[ -f "$ENV_FILE" ] || die "Нет файла .env. Сначала: scripts/install.sh" "No .env file. First run: scripts/install.sh"
	set -a
	# shellcheck source=/dev/null
	. "$ENV_FILE"
	set +a
}

# https_get URL: localhost gets Caddy's own CA, so its certificate is not
# checked there; any real domain must have a valid one.
https_get() {
	case "$DOMAIN" in
	localhost) curl -fsSk --max-time 10 "$1" ;;
	*) curl -fsS --max-time 10 "$1" ;;
	esac
}

# wait_healthy: the app's container healthcheck passes (up to ~3 min: the
# first start builds nothing, but a slow disk can take a while).
wait_healthy() {
	local id state i
	id="$(compose ps -q app)"
	[ -n "$id" ] || return 1
	for i in $(seq 1 90); do
		state="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || true)"
		[ "$state" = healthy ] && return 0
		[ "$i" -eq 90 ] || sleep 2
	done
	return 1
}

# wait_https: Caddy has its certificate and answers (Let's Encrypt usually
# takes a few seconds, up to a couple of minutes on a busy day).
wait_https() {
	local i
	for i in $(seq 1 60); do
		[ "$(https_get "https://$DOMAIN/healthz" 2>/dev/null)" = ok ] && return 0
		[ "$i" -eq 60 ] || sleep 3
	done
	return 1
}
