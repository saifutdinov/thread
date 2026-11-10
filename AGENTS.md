# AGENTS.md: Thread (Нитка)

Rules for anyone changing this code, people and AI agents alike.

Thread is an end-to-end encrypted chat for close people that anyone can run on their own server (installable PWA). Go server + SQLite in one container, Preact frontend, Caddy for HTTPS and coturn for calls next to it (`deploy/`).

Read before changing anything:
- `docs/adr/0001-e2ee-webcrypto.md`: the encryption protocol. Any change to key handling, AAD strings, payload format or invite derivation is a protocol change: messages and keys already stored on people's servers and devices must stay readable.
- `docs/adr/0002-group-calls.md`: group calls through the LiveKit SFU, frame encryption with a sealed call key, what the server sees.
- `docs/adr/0003-mic-processing.md`: RNNoise and the voice gate on computers, the call's own microphone chain.
- `docs/adr/0006-microphone-models.md`: microphone models, local preview, bounded preparation and fallback.
- `docs/adr/0004-music.md`: the app's player and music into calls.
- `docs/adr/0007-installable-apps.md`: the desktop app (Electron, `desktop/app`) and the Android app (Kotlin WebView shell, `android/`): the interface from inside the app on the server's own origin, their guards, pushes through FCM. `docs/apps.md`: building them for your server, with the keys and settings they need. `docs/updates.md`: how they update themselves.
- `docs/agent-guide.md`: what to do before a review, invariants from real bugs, how author and reviewer agents work together.
- `PROJECT_GRAPH.md`: modules, flows, patterns.
- `SECURITY.md`: what the design promises and what it does not.

## Rules

- The server must never receive plaintext: message text, reactions, group titles, avatars, group photos, call signaling, file contents and file keys are encrypted in the browser. New content fields go inside the encrypted payload, not into new plaintext columns. Group calls (`docs/adr/0002-group-calls.md`) run through the LiveKit SFU: their media must stay frame-encrypted with the sealed call key (never join without encryption); LiveKit's own signaling is visible to our server by design, so no names or content go into LiveKit metadata.
- Device private keys stay `extractable: false`. Never add code that exports them.
- AAD strings (`m:`, `r:`, `t:`, `k:`, `f`, `invite`, `recovery`, `call:`, `a:`, `p:`, `v:`, `vk:`), HKDF info strings and signature prefixes are frozen. They keep the project's earlier name (`connect/wrap/v1`, `connect/invite/*`, `connect/recovery/*`, `connect-login:`) on purpose: they are protocol labels, not branding. `web/public/sw.js` duplicates the message AAD and the IndexedDB layout from `web/src/lib/idb.ts`, and the Android app repeats `sw.js` (`android/app/src/main/kotlin/io/github/saifutdinov/thread/Words.kt`, `Push.kt`, the keys `web/src/lib/android.ts` keeps for it): change them together.
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
scripts/check.sh                     # everything to run before a review
gofmt -l . && go vet ./... && golangci-lint run && go test -race ./...
cd web && npm test                   # node:test: crypto, i18n, call tuning (no extra deps)
cd web && npm run test:proxy         # the dev proxy for /api and /lk (needs :8080 free)
shellcheck -x scripts/*.sh           # server scripts
python3 -m unittest discover -s scripts -p '*_test.py'   # the backup restore check
cd desktop/app && npm start          # the desktop app; THREAD_ORIGIN=http://localhost:8080 for a local server
cd desktop/app && npm run test:e2e   # the app against a real server, silent
cd android && gradle testDebugUnitTest assembleDebug   # the Android app; needs the Android SDK and web/dist (docs/apps.md)
docker build -t thread .
```

First start with an empty DB logs a one-time first-user invite URL (`BASE_URL/#/i/...`).

## Config (env)

`ADDR` (:8080), `DATA_DIR` (./data), `STATIC_DIR` (./web/dist), `BASE_URL`, `PASSWORD_PEPPER` (base64, 32+ bytes; generated into DATA_DIR when unset, development only), `TRUST_PROXY=1` behind a reverse proxy that sets `X-Real-IP`, `VAPID_SUBJECT`, `FCM_CREDENTIALS` (path to the Firebase service account key for the Android app's pushes; absent or empty: off), `DOWNLOADS_DIR` (the apps' installers served publicly at `/api/downloads`; empty: none; `docs/apps.md`).
Calls: `TURN_SECRET`, `TURN_URLS` (comma-separated). Monitoring: `METRICS_ADDR` (internal Prometheus listener, off when empty). Backups: `BACKUP_RECIPIENT` (age public keys, comma-separated; off when empty), `BACKUP_KEEP` (7), `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`. Self-hosters set these through `.env` (see `README.md`, `scripts/README.md`).

## Git

Conventional Commits; changes go through pull requests into `main`, which CI checks (Go, web, scripts, compose, image build). Releases are `vX.Y.Z` tags; `scripts/update.sh` moves servers to the newest one, so a tag must be something people can run. What a person notices goes into `web/src/lib/patch-notes.ts`, RU and EN: a release shows its entry once after the update.
