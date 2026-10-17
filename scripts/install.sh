#!/usr/bin/env bash
# Configures and starts Thread on this server:
#   1. asks for the domain and the server's public IP;
#   2. writes .env with fresh secrets (only the first time: never overwrites);
#   3. builds the app from this repository and starts it with Caddy (HTTPS)
#      and coturn (calls);
#   4. waits until https://<domain> answers and prints the first invite link.
#
#   sudo scripts/install.sh chat.example.org
set -euo pipefail
# shellcheck source=scripts/common.sh
. "$(dirname "$0")/common.sh"

need_docker
cd "$ROOT"

# local_ip: the IPv4 this host sends from. Equal to the public one on most
# VPS; a private address on clouds with 1:1 NAT.
local_ip() {
	ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}'
}

public_ip() {
	curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || local_ip
}

resolve() {
	if command -v getent >/dev/null 2>&1; then
		getent ahostsv4 "$1" | awk 'NR == 1 {print $1}'
	elif command -v dig >/dev/null 2>&1; then
		dig +short A "$1" | tail -1
	fi
}

if [ -f "$ENV_FILE" ]; then
	step "Настройки" "Settings"
	ok "Файл .env уже есть: секреты не меняются" ".env already exists: secrets stay as they are"
	current="$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
	if [ -n "${1:-}" ] && [ "$1" != "$current" ]; then
		warn "Домен в .env: $current. Указанный $1 не применён: поправьте DOMAIN в .env и запустите снова." \
			"The domain in .env is $current. $1 was not applied: change DOMAIN in .env and run again."
	fi
else
	step "Настройки" "Settings"
	domain="${1:-}"
	if [ -z "$domain" ]; then
		read -r -p "$(say "Домен для чата (например chat.example.org): " "Domain for the chat (e.g. chat.example.org): ")" domain
	fi
	domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')"
	printf '%s' "$domain" | grep -Eq '^(localhost|([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,}|xn--[a-z0-9-]+))$' ||
		die "Это не похоже на домен: $domain" "This does not look like a domain: $domain"

	if [ "$domain" = localhost ]; then
		ip=127.0.0.1
		relay=127.0.0.1
	else
		guess="$(public_ip || true)"
		read -r -p "$(say "Публичный IPv4 этого сервера [$guess]: " "This server's public IPv4 [$guess]: ")" ip
		ip="${ip:-$guess}"
	fi
	printf '%s' "$ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' ||
		die "Это не похоже на IPv4-адрес: $ip" "This does not look like an IPv4 address: $ip"
	relay="${relay:-$(local_ip || true)}"
	relay="${relay:-$ip}"
	if [ "$relay" != "$ip" ]; then
		ok "Сервер за NAT: звонки идут через локальный $relay, клиентам сообщается $ip" \
			"The server is behind NAT: calls relay via local $relay, clients are told $ip"
	fi

	(
		umask 077
		cat >"$ENV_FILE" <<EOF
# Thread settings. Keep a copy of this file somewhere safe and offline:
# without PASSWORD_PEPPER no password works, even with a database backup.
DOMAIN=$domain
PUBLIC_IP=$ip
RELAY_IP=$relay
PASSWORD_PEPPER=$(openssl rand -base64 32)
TURN_SECRET=$(openssl rand -hex 32)

# Optional, see README:
# BACKUP_RECIPIENT=age1...
# METRICS_ADDR=:9095
EOF
	)
	ok "Записан .env (права 600: читает только владелец)" "Wrote .env (mode 600: only its owner can read it)"
fi

load_env

if [ "$DOMAIN" != localhost ]; then
	step "Проверка DNS" "Checking DNS"
	resolved="$(resolve "$DOMAIN" || true)"
	if [ "$resolved" = "$PUBLIC_IP" ]; then
		ok "$DOMAIN → $PUBLIC_IP" "$DOMAIN → $PUBLIC_IP"
	else
		warn "$DOMAIN указывает на '${resolved:-ничего}', а не на $PUBLIC_IP. HTTPS-сертификат не выпустится, пока A-запись не поправлена." \
			"$DOMAIN points to '${resolved:-nothing}', not $PUBLIC_IP. The HTTPS certificate cannot be issued until the A record is fixed."
	fi
fi

step "Сборка и запуск (первый раз несколько минут)" "Building and starting (a few minutes the first time)"
compose up -d --build
wait_healthy || die "Приложение не запустилось. Логи: scripts/status.sh --logs" "The app did not start. Logs: scripts/status.sh --logs"
ok "Приложение работает" "The app is running"

step "HTTPS" "HTTPS"
if wait_https; then
	ok "https://$DOMAIN отвечает" "https://$DOMAIN answers"
else
	warn "https://$DOMAIN пока не отвечает. Проверьте DNS и порты 80/443, затем scripts/status.sh" \
		"https://$DOMAIN does not answer yet. Check DNS and ports 80/443, then run scripts/status.sh"
fi

invite="$(compose logs --no-color app 2>/dev/null | grep -o '"url":"[^"]*#/i/[^"]*"' | tail -1 | cut -d'"' -f4 || true)"
step "Готово" "Done"
if [ -n "$invite" ]; then
	say "Ссылка для первого пользователя (одноразовая, 24 часа):" "Link for the first user (one use, 24 hours):"
	printf '\n  %s\n\n' "$invite"
	say "Откройте её на телефоне, введите имя и сохраните выданный пароль. Остальных приглашаете уже из приложения." \
		"Open it on your phone, enter a name and save the password you get. Everyone else you invite from the app."
else
	say "Пользователи уже есть: войдите по паролю на https://$DOMAIN" "Users already exist: sign in with your password at https://$DOMAIN"
fi
