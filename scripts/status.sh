#!/usr/bin/env bash
# Checks that everything works: containers, HTTPS and its certificate, the
# call relay. With --logs it prints the last lines of every container's log.
#
#   sudo scripts/status.sh
#   sudo scripts/status.sh --logs
set -euo pipefail
# shellcheck source=scripts/common.sh
. "$(dirname "$0")/common.sh"

need_docker
load_env

if [ "${1:-}" = --logs ]; then
	compose logs --no-color --tail 50
	exit 0
fi

fails=0
check() { if "$@"; then :; else fails=$((fails + 1)); fi; }

step "Контейнеры" "Containers"
compose ps --format 'table {{.Service}}\t{{.Status}}'

step "Приложение" "App"
app_ok() {
	local id
	id="$(compose ps -q app)"
	if [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$id")" = healthy ]; then
		ok "Работает" "Healthy"
	else
		warn "Не отвечает: scripts/status.sh --logs" "Not healthy: scripts/status.sh --logs"
		return 1
	fi
}
check app_ok

step "HTTPS" "HTTPS"
https_ok() {
	local health version
	health="$(https_get "https://$DOMAIN/healthz" 2>/dev/null || true)"
	if printf '%s' "$health" | grep -q '"status":"ok"'; then
		version="$(printf '%s' "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
		ok "https://$DOMAIN отвечает, версия $version" "https://$DOMAIN answers, version $version"
	else
		warn "https://$DOMAIN не отвечает: проверьте DNS и порты 80/443" "https://$DOMAIN does not answer: check DNS and ports 80/443"
		return 1
	fi
	[ "$DOMAIN" = localhost ] && return 0
	local end
	end="$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
	if [ -n "$end" ]; then
		ok "Сертификат действует до $end (Caddy продлевает сам)" "Certificate valid until $end (Caddy renews it)"
	fi
}
check https_ok

step "Звонки (TURN)" "Calls (TURN)"
turn_ok() {
	# A STUN request to the relay on its local address. It proves coturn
	# answers; whether the firewall lets the outside in is only proven by a
	# real call from a phone on mobile data.
	local addr="${RELAY_IP:-$PUBLIC_IP}"
	if compose exec -T turn turnutils_stunclient -p 3478 "$addr" 2>/dev/null | grep -q 'reflexive addr'; then
		ok "Ретранслятор отвечает на $addr:3478" "Relay answers on $addr:3478"
	else
		warn "Ретранслятор не отвечает: scripts/status.sh --logs" "Relay does not answer: scripts/status.sh --logs"
		return 1
	fi
}
check turn_ok

echo
if [ "$fails" -eq 0 ]; then
	ok "Всё в порядке" "All good"
else
	die "Проблем: $fails" "Problems: $fails"
fi
