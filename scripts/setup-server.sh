#!/usr/bin/env bash
# Prepares a fresh Ubuntu (22.04, 24.04) or Debian (12, 13) server for
# Thread: Docker from Docker's own repository, a firewall with the ports the
# chat needs, swap on small machines, automatic security updates.
# Safe to run again: every step checks what is already there.
#
#   sudo scripts/setup-server.sh
set -euo pipefail
# shellcheck source=scripts/common.sh
. "$(dirname "$0")/common.sh"

need_root
# shellcheck source=/dev/null
. /etc/os-release
case "${ID:-}" in
ubuntu | debian) ;;
*) die "Поддерживаются Ubuntu и Debian (здесь: ${ID:-?})." "Only Ubuntu and Debian are supported (found: ${ID:-?})." ;;
esac
in_container() { [ -f /.dockerenv ] || grep -qa container= /proc/1/environ 2>/dev/null; }

step "Системные пакеты" "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl ufw unattended-upgrades dnsutils >/dev/null
ok "Готово" "Done"

step "Docker" "Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
	ok "Уже установлен: $(docker --version)" "Already installed: $(docker --version)"
else
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${VERSION_CODENAME:?} stable" \
		>/etc/apt/sources.list.d/docker.list
	apt-get update -qq
	apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
	ok "Установлен: $(docker --version)" "Installed: $(docker --version)"
fi
if command -v systemctl >/dev/null 2>&1 && ! in_container; then
	systemctl enable --now docker >/dev/null
fi

step "Файрвол (ufw)" "Firewall (ufw)"
# Keep SSH open on whatever port(s) sshd really listens on: a wrong guess
# here locks the owner out once ufw is enabled. sudo drops SSH_CONNECTION,
# so sshd's own config comes first.
ssh_ports="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' || true)"
# Ubuntu 24.04 can listen through ssh.socket, whose port may differ.
sock_ports="$(systemctl show ssh.socket -p Listen --value 2>/dev/null | grep -oE '[0-9]+ \(Stream\)' | cut -d' ' -f1 || true)"
ssh_ports="$(printf '%s\n%s\n' "$ssh_ports" "$sock_ports" | awk 'NF' | sort -un)"
if [ -z "$ssh_ports" ]; then
	conn="${SSH_CONNECTION:-}"
	ssh_ports="${conn##* }"
fi
ssh_ports="${ssh_ports:-22}"
for p in $ssh_ports; do
	ufw allow "$p/tcp" comment ssh >/dev/null
done
ssh_port="$(echo "$ssh_ports" | tr '\n' ' ' | sed 's/ $//')"
ufw allow 80/tcp comment 'http, certificate' >/dev/null
ufw allow 443/tcp comment https >/dev/null
ufw allow 443/udp comment 'https, http/3' >/dev/null
ufw allow 3478/tcp comment 'calls, turn' >/dev/null
ufw allow 3478/udp comment 'calls, turn' >/dev/null
ufw allow 49160:49200/udp comment 'calls, turn relay' >/dev/null
ufw --force enable >/dev/null
ok "Открыты: SSH ($ssh_port), 80, 443, 3478, 49160-49200/udp" "Open: SSH ($ssh_port), 80, 443, 3478, 49160-49200/udp"
warn "Если у хостера есть свой файрвол в панели, откройте там те же порты." "If your hosting panel has its own firewall, open the same ports there."

step "Подкачка (swap)" "Swap"
mem_mb=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
if [ "$(swapon --noheadings 2>/dev/null | wc -l)" -gt 0 ]; then
	ok "Уже есть" "Already present"
elif [ "$mem_mb" -ge 2000 ]; then
	ok "Не нужна: памяти ${mem_mb} МБ" "Not needed: ${mem_mb} MB of memory"
elif in_container; then
	warn "Пропущено внутри контейнера" "Skipped inside a container"
else
	# Building the app needs ~1.5 GB; small VPS get 2 GB of swap.
	fallocate -l 2G /swapfile
	chmod 600 /swapfile
	mkswap /swapfile >/dev/null
	swapon /swapfile
	grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
	ok "Добавлено 2 ГБ" "Added 2 GB"
fi

step "Автоматические обновления безопасности" "Automatic security updates"
echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1
ok "Включены" "Enabled"

step "Сервер готов" "Server is ready"
say "Дальше: направьте домен (A-запись) на IP этого сервера и запустите
  scripts/install.sh chat.example.org" "Next: point your domain (A record) to this server's IP and run
  scripts/install.sh chat.example.org"
