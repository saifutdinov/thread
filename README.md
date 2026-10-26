# Thread

[English](README.md) | [Русский](README.ru.md)

**A thread that keeps your people connected.** Thread is an end-to-end encrypted chat for family and close friends that you run on your own server. It works in any modern browser on phones, tablets and computers, and installs to the home screen like a regular app. No phone numbers, no app stores, and no third party that can read your messages.

## Features

- **Your own server, your own circle.** People join only through one-time invite links that you or they create. Sign-in uses a generated, easy-to-remember password plus approval from one of your own devices. Forgot the password? The person who invited you can send a recovery link. Someone who already has an account is added with a friend link, which only lets them sign in.
- **End-to-end encryption.** Messages, photos, files, voice messages, reactions, group names and avatars are encrypted on the devices; the server stores only ciphertext. Safety codes let you check that nobody added or swapped a contact's devices.
- **Messaging:** private chats and groups, replies, reactions, formatting, editing and deleting, forwarding, pinned messages, search on the device, link previews (off by default), swipe to reply.
- **Media:** photos (location and other metadata removed), videos, files up to 50 MB, voice messages (up to 5 minutes) with playback speed and round video messages (up to a minute), recorded as in Telegram: hold to record, let go to send, tap to switch, slide up to lock, left to cancel.
- **Calls:** one-to-one voice and video calls with your own relay server, the camera can be turned on mid-call, a call minimizes so you can keep chatting, the other side's battery level (where their browser shares it), face effects drawn on your device (a crown, cat ears, hearts, snow, colour filters), recovery after network changes (Wi-Fi to mobile data) and a connection quality indicator.
- **App:** push notifications (also in a background tab or behind other windows; one notification per call with Answer and Decline buttons, then a missed-call note if nobody answered; a chat read on one device clears its notifications on the others in Chromium browsers), a setup guide for every platform and a test button in Settings, a Reload banner when a new version is installed on the server (and the version and a reload button in Settings), a floating call window above other windows (Chrome and Edge on computers), light and dark themes, English and Russian, adjustable text size, app lock with a PIN or Face ID / fingerprint, hidden online status.
- **Small server:** one Go binary with SQLite, encrypted daily backups (optionally to S3), Prometheus metrics. Runs on a 1 GB VPS.

## Quick start

You need a VPS with Ubuntu or Debian and a domain pointing to it. Then:

```bash
git clone https://github.com/saifutdinov/thread.git && cd thread
sudo scripts/setup-server.sh                 # Docker, firewall, updates
sudo scripts/install.sh chat.example.org     # start, prints the first invite link
```

Open the printed link on your phone, and you are the first member. **Full guide with every step, ports, backups and troubleshooting: [scripts/README.md](scripts/README.md).**

## Security: what it protects and what it does not

Thread is built so that a server that stores and relays data honestly, its hosting provider, or anyone who copies its disk or backups cannot read your conversations.

**Encrypted on the devices:** message text, reactions, photos, videos, voice messages, files, group names, avatars and call setup. Device keys never leave the device and cannot be exported, even by the app itself. A new device gets access only when one of your devices (or, if you lost them all, a contact after comparing a code with you) approves it. Calls are encrypted by WebRTC end to end; the relay server sees only ciphertext.

**Visible to the server:** names, who is in which chat, when messages are sent and how large they are, who called whom and for how long, IP addresses, whether an open app is in front. With link previews turned on, the server also sees the links you send. **Visible to others:** push services (Apple, Google, Mozilla) see when a notification goes to which device, not its content; in a direct call the two people see each other's IP addresses, as in any WebRTC call.

**Honest limitations:**

- The encryption protocol is our own design built from standard WebCrypto primitives (ECDH and ECDSA P-256, AES-256-GCM, HKDF). **It has not been independently audited.** For people facing serious threats, use Signal.
- **An actively malicious server can add a device** to someone's device list: new chat keys are then encrypted for that device too, and it can read new messages. Comparing safety codes reveals this, as a warning in your direct chat, but only after you have compared them, and nothing blocks it automatically. Compare codes with the people who matter most.
- As with any encryption in the browser, the app's code comes from the server: a compromised server could serve modified code. A strict Content Security Policy and no third-party scripts reduce, but do not remove, this risk.
- There is no forward secrecy within a key period: a leaked chat key exposes the messages of that period. Keys rotate weekly and whenever someone joins, leaves or a device is removed.

The protocol is described in [docs/adr/0001-e2ee-webcrypto.md](docs/adr/0001-e2ee-webcrypto.md) (in Russian); the threat model summary and how to report a vulnerability are in [SECURITY.md](SECURITY.md).

## Configuration

`scripts/install.sh` writes `.env` for you. Everything you can set there:

| Variable | Meaning |
|---|---|
| `DOMAIN` | The chat's domain, e.g. `chat.example.org` |
| `PUBLIC_IP` | The server's public IPv4 (for the call relay) |
| `RELAY_IP` | The local IPv4 the relay sends from; differs from `PUBLIC_IP` only behind 1:1 NAT (default: `PUBLIC_IP`) |
| `PASSWORD_PEPPER` | Secret mixed into every password hash. **Never change or lose it.** |
| `TURN_SECRET` | Secret for short-lived call relay credentials |
| `VAPID_SUBJECT` | Contact for push services, `mailto:` or `https:` (default: the chat's address) |
| `BACKUP_RECIPIENT` | age public key(s), comma-separated: turns on daily encrypted backups |
| `BACKUP_KEEP` | How many local snapshots to keep (7) |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` | Optional S3-compatible bucket for off-server copies |
| `METRICS_ADDR` | e.g. `:9095`: Prometheus metrics on the internal Docker network (`thread_http_responses_total`, `thread_push_total`, `thread_sockets`, `thread_backup_*`) |

After editing `.env`, apply it with `sudo scripts/install.sh`.

## Development

Requirements: Go and Node.js in the versions pinned in [mise.toml](mise.toml).

```bash
go run ./cmd/thread                 # server on :8080, data in ./data, serves web/dist
cd web && npm ci && npm run dev     # web app with hot reload on :5173, API proxied to :8080
go test -race ./...                 # server tests
cd web && npm test                  # crypto, i18n and call tuning tests
```

On first start with an empty database the server logs a one-time invite link for the first user. Architecture, modules and patterns: [PROJECT_GRAPH.md](PROJECT_GRAPH.md). Rules for contributors (people and AI agents alike): [AGENTS.md](AGENTS.md).

## License

[GNU AGPL-3.0](LICENSE). You may use, change and run Thread for anyone; if you run a modified version as a service, you must offer its source code to its users. Third-party components and their licenses: [NOTICE](NOTICE).
