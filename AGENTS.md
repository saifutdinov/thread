# AGENTS.md: Thread (Нитка)

Rules for anyone changing this code, people and AI agents alike.

Thread is an end-to-end encrypted chat for close people that anyone can run on their own server (installable PWA). Go server + SQLite in one container, Preact frontend, Caddy for HTTPS and coturn for calls next to it (`deploy/`).

Read before changing anything:
- `docs/adr/0001-e2ee-webcrypto.md`: the encryption protocol. Any change to key handling, AAD strings, payload format or invite derivation is a protocol change: messages and keys already stored on people's servers and devices must stay readable.
- `docs/adr/0002-group-calls.md`: group calls through the LiveKit SFU, frame encryption with a sealed call key, what the server sees.
- `docs/adr/0003-mic-processing.md`: RNNoise and the voice gate on computers, the call's own microphone chain.
- `docs/adr/0004-music.md`: the app's player, music into calls, and the optional (off by default) music from a link through a spotDL sidecar, with what the server sees.
- `PROJECT_GRAPH.md`: modules, flows, patterns.
- `SECURITY.md`: what the design promises and what it does not.

## Rules

- The server must never receive plaintext: message text, reactions, group titles, avatars, group photos, call signaling, file contents and file keys are encrypted in the browser. New content fields go inside the encrypted payload, not into new plaintext columns. Group calls (`docs/adr/0002-group-calls.md`) run through the LiveKit SFU: their media must stay frame-encrypted with the sealed call key (never join without encryption); LiveKit's own signaling is visible to our server by design, so no names or content go into LiveKit metadata.
- Device private keys stay `extractable: false`. Never add code that exports them.
- Music from a link (`docs/adr/0004-music.md`) is the one deliberate exception to the rule above, and it stays off unless the operator turns it on: the server and its sidecar see which track is fetched and its audio, never the chat it goes to. No chat ids, names or links in its requests or logs; keep the README's warning next to any way of turning it on.
- AAD strings (`m:`, `r:`, `t:`, `k:`, `f`, `invite`, `recovery`, `call:`, `a:`, `p:`, `v:`, `vk:`), HKDF info strings and signature prefixes are frozen. They keep the project's earlier name (`connect/wrap/v1`, `connect/invite/*`, `connect/recovery/*`, `connect-login:`) on purpose: they are protocol labels, not branding. `web/public/sw.js` duplicates the message AAD and the IndexedDB layout from `web/src/lib/idb.ts`: change both together.
- Schema changes are appended to `migrations` in `internal/server/store.go`; the base schema is frozen.
- Server responses use stable error codes (`{"error": "code"}`); the client translates them via `err.<code>` in `web/src/lib/i18n.ts`. Every UI string exists in both `ru` and `en`.
- Accessibility is a requirement: labels on icon buttons, native `<dialog>` for modals, 44px touch targets, sizes in `rem`, no information by color alone.
- No em dash (U+2014) in code, docs or UI strings.
- No third-party scripts, fonts or trackers in the web app, and nothing that phones home: the strict CSP is part of the security model.

## Commands

```bash
go run ./cmd/thread                  # server on :8080, data in ./data, serves web/dist
cd web && npm run dev                # Vite on :5173, proxies /api (incl. WebSocket) to :8080
cd web && npm run build              # tsc + production bundle into web/dist
gofmt -l . && go vet ./... && golangci-lint run && go test -race ./...
cd web && npm test                   # node:test: crypto, i18n, call tuning (no extra deps)
cd deploy/music && uv run --only-group dev pytest && ruff check . && ruff format --check .   # the optional music sidecar
shellcheck -x scripts/*.sh           # server scripts
docker build -t thread .
```

First start with an empty DB logs a one-time first-user invite URL (`BASE_URL/#/i/...`).

## Config (env)

`ADDR` (:8080), `DATA_DIR` (./data), `STATIC_DIR` (./web/dist), `BASE_URL`, `PASSWORD_PEPPER` (base64, 32+ bytes; generated into DATA_DIR when unset, development only), `TRUST_PROXY=1` behind a reverse proxy that sets `X-Real-IP`, `VAPID_SUBJECT`.
Calls: `TURN_SECRET`, `TURN_URLS` (comma-separated). Music from a link (off by default): `MUSIC_URL` with `COMPOSE_PROFILES=music`; the sidecar takes `MUSIC_PROXY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and `/config/cookies.txt`. Monitoring: `METRICS_ADDR` (internal Prometheus listener, off when empty). Backups: `BACKUP_RECIPIENT` (age public keys, comma-separated; off when empty), `BACKUP_KEEP` (7), `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`. Self-hosters set these through `.env` (see `README.md`, `scripts/README.md`).

## Git

Conventional Commits; changes go through pull requests into `main`, which CI checks (Go, web, scripts, compose, image build). Releases are `vX.Y.Z` tags; `scripts/update.sh` moves servers to the newest one, so a tag must be something people can run.
