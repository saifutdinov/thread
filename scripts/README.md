# Running Thread on your server

[English](README.md) | [Русский](README.ru.md)

From a clean server to the first invite link in about ten minutes. Four scripts do all the work; each one prints what it does and is safe to run again.

## What you need

- **A server (VPS)** with a public IPv4 address: 1 CPU, 1 GB of memory (2 GB is more comfortable), 10 GB of disk. Ubuntu 22.04 or 24.04, or Debian 12 or 13. Any hosting provider will do, including clouds where the server sits behind 1:1 NAT: the installer finds the local address itself.
- **A domain or subdomain**, for example `chat.example.org`, with an **A record** pointing to the server's IP (IPv4 only: leave out an AAAA record). Create it first: the HTTPS certificate is issued for this name, and that only works once the name leads to your server.
- **SSH access** as `root` or a user with `sudo`. The commands below use `sudo`; logged in as `root` you can leave it out (a minimal Debian has no `sudo` at all).

## Step by step

**1. Connect to the server and get the code.**

```bash
ssh root@<server-ip>
apt-get update && apt-get install -y git
git clone https://github.com/saifutdinov/thread.git
cd thread
```

**2. Prepare the server:** Docker, a firewall, swap on small machines, automatic security updates.

```bash
sudo scripts/setup-server.sh
```

If your hosting panel has its own firewall, open the same ports there (see [Ports](#ports)).

**3. Install and start the chat** with your domain:

```bash
sudo scripts/install.sh chat.example.org
```

The script asks to confirm the server's public IP, generates the secrets into `.env`, builds the app from this repository (a few minutes the first time), gets the HTTPS certificate and prints a **link for the first user**.

**4. Open the link** on your phone, enter a name and save the password the app gives you. Install the app to the home screen when it offers. Everyone else you invite from the app itself.

## Commands

| Command | What it does |
|---|---|
| `sudo scripts/setup-server.sh` | Prepares a fresh server (once) |
| `sudo scripts/install.sh <domain>` | First start; later runs keep `.env` and just restart what changed |
| `sudo scripts/status.sh` | Checks the containers, HTTPS and its certificate, the call relay |
| `sudo scripts/status.sh --logs` | The last log lines of every container |
| `sudo scripts/update.sh` | Updates and restarts: keeps following `main` if the server was cloned from `main`, otherwise the latest release |
| `sudo scripts/update.sh release` | Switches to the latest release (a `v*` tag) |
| `sudo scripts/update.sh main` | Switches to the newest code on `main` |

`update.sh` never moves back to older code: the database only migrates forward.

The scripts wrap plain Docker Compose. The same by hand:

```bash
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build   # start / apply changes
docker compose -f deploy/docker-compose.yml --env-file .env ps              # what is running
docker compose -f deploy/docker-compose.yml --env-file .env logs -f app     # follow the app log
docker compose -f deploy/docker-compose.yml --env-file .env down            # stop (data stays)
```

## Ports

| Port | Why |
|---|---|
| 22/tcp (or your SSH port) | Your access to the server |
| 80/tcp | Getting the HTTPS certificate, redirect to HTTPS |
| 443/tcp, 443/udp | The chat itself (HTTPS, HTTP/3) |
| 3478/tcp, 3478/udp | Calls: the relay for devices that cannot reach each other directly |
| 49160-49200/udp | Calls: audio and video going through the relay |

Without the call ports the chat works, and calls only connect where both devices see each other directly (rarely the case on mobile networks).

## Where things are

- **`.env`** next to this folder: the domain, the server's public and local IPs and two secrets. `PASSWORD_PEPPER` is part of every password: if it is lost or changed, no one can sign in, even with a database backup. **Keep a copy of `.env` offline**, for example in a password manager.
- **Docker volumes:** `thread_data` (the database and encrypted files), `thread_caddy_data` (the certificate).

Messages, photos and files are encrypted on the devices; the server only stores ciphertext. Names, who talks to whom and when are not encrypted, so treat the server and its backups with care.

## Backups

The app can back itself up once a day, encrypted for your key, so that even the server cannot read its own backups.

1. **On your computer** (not the server) install [age](https://age-encryption.org) and create a key:
   ```bash
   age-keygen -o thread-backup.key
   ```
   It prints a public key `age1...`. Keep `thread-backup.key` offline next to your copy of `.env`.
2. **On the server**, add the public key to `.env` and apply:
   ```bash
   echo 'BACKUP_RECIPIENT=age1...' | sudo tee -a .env
   sudo scripts/install.sh
   ```
   Snapshots appear in the `thread_data` volume under `backups/`; the last 7 are kept (`BACKUP_KEEP`).
3. **Off the server:** add an S3-compatible bucket (`BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` in `.env`), and every hour new snapshots and files are uploaded there. Set a lifecycle rule on the `db/` prefix (for example, delete after 30 days); leave `media/` alone.

**Restore:** stop the app, decrypt a snapshot with `age -d -i thread-backup.key -o thread.db thread-<time>.db.age`, put `thread.db` and the `media/` folder into the `thread_data` volume (owner `65532:65532`, remove old `thread.db-wal` and `thread.db-shm`), bring back your `.env` with the same `PASSWORD_PEPPER`, start again. Devices keep their own keys, so conversations open again on the same phones and computers.

## When something does not work

- **The certificate is not issued** (`https://` does not open): the A record must point to this server and port 80 must be open, also in the hosting panel. DNS changes can take up to an hour. Then `sudo scripts/install.sh` again.
- **Calls connect only on Wi-Fi, not on mobile data:** the call ports are closed, most often in the hosting panel's firewall.
- **The first link expired** (24 hours) and nobody has registered yet: `docker compose -f deploy/docker-compose.yml --env-file .env restart app`, then `sudo scripts/install.sh` prints a fresh one.
- **iPhone:** register and use the app from the home screen icon, not from Safari: Safari and the installed app keep their data apart, and only the installed app gets notifications.
- Anything else: `sudo scripts/status.sh --logs`.

## Removing

`docker compose -f deploy/docker-compose.yml --env-file .env down` stops everything and keeps the data. Adding `-v` **deletes all data and the certificate** for good.
