# PROJECT_GRAPH: Thread (Нитка)

## Modules

```
cmd/thread             env config, pepper, `healthcheck` subcommand, wiring
internal/server        the whole backend, one package
  server.go            Server, routes, security headers (CSP, Origin check), static PWA, cleanup loop
  store.go             SQLite schema (WAL, _txlock=immediate), seq counter, small query helpers
  auth.go              passwords (argon2id + pepper), sessions, login + device challenge, rate limits
  invites.go           bootstrap invite, peek/redeem, chat creation, invite links
  chats.go             chat list, messages, edits, deletes, reactions, read marks, rotation, keys, sync
  devices.go           device list, pending/recovery, approve, revoke
  recovery.go          recovery links: the inviter vouches, a new password and device
  media.go             encrypted blob upload/download, orphan cleanup
  hub.go               WebSocket fan-out, presence, typing, call signaling relay
  push.go              Web Push (VAPID) with ciphertext payloads, silent read/call-end clears, test push, delivery counters
  calls.go             1:1 call signaling (sealed SDP/ICE), ringing state, TURN REST credentials
  profiles.go          sealed avatars (per chat) and group photos, versioned
  preview.go           opt-in link preview fetcher with a dialer-level SSRF guard
  backup.go            daily VACUUM INTO snapshot, age encryption, retention, S3 upload (SigV4)
  metrics.go           Prometheus text endpoint on an internal port, response counters
  words.txt            EFF long wordlist subset for passwords (CC BY 3.0 US, EFF)
web/                   Preact + Vite PWA
  src/lib/crypto.ts    WebCrypto: device keys, ECIES wrap, seal/open, sign/verify, invite keys, device code
  src/lib/idb.ts       IndexedDB kv (device keys, chat keys, lang); shared with public/sw.js
  src/lib/api.ts       typed /api client
  src/lib/store.ts     app state (signals), decrypt/encrypt, sending, sync, WebSocket, devices, invites
  src/lib/route.ts     hash router on real history entries; in memory in iOS home-screen apps (WebKit 215884)
  src/lib/i18n.ts      ru/en strings, plurals, date formats
  src/lib/prefs.ts     theme, text size, language effects
  src/lib/pwa.ts       install prompt, push subscription, SW registration, new-release check
  src/lib/image.ts     client-side image, video poster, avatar and link-card picture preparation
  src/lib/notify.ts    system notifications from a page that is visible but behind another window
  src/lib/attention.ts unread count in the tab title and on the app icon, a ringing call in the title
  src/lib/effects.ts   call effects: face points from the landmarker, smoothing, vector drawings, puffs, particles, background cut-out, canvas pipeline
  src/lib/face.ts      lazy MediaPipe face landmarker and person segmenter (self-hosted WebAssembly and models)
  src/lib/tunes.ts     built-in ring, line and message tunes (synthesized notes), pure
  src/lib/sounds.ts    plays the sound this device chose (a tune or an own file in IndexedDB) through one shared AudioContext
  scripts/brotli.mjs   brotli copies of the build's WebAssembly (served by static())
  src/lib/emoji.ts     emoji-only messages drawn large
  src/lib/call.ts      WebRTC call state machine, tones, sealed signaling, ICE restart, quality stats
  src/lib/rtc.ts       call tuning without the DOM: Opus SDP params, codec order per device, quality level
  src/lib/devices.ts   cameras, microphones, speakers; names for Android audio routes; remembered choices
  src/lib/markup.tsx   **bold** __italic__ ~~strike~~ `code` > quote, links
  src/lib/recorder.ts  voice/circle recording (MediaRecorder), waveform, format fallback, hold-drag gesture
  src/lib/lock.ts      app lock: PIN (PBKDF2), WebAuthn biometrics, timeout, hidden push text
  src/components/*     screens: Auth, Main (layout, approval, onboarding), ChatList, ChatView, Composer,
                       EmojiPicker, ChatInfo, NewChat, Settings, Media (voice, circles, files),
                       Security (lock screen, lock settings, safety codes), Call (call screen),
                       ui (icons, Modal, Avatar, PictureButtons)
  public/sw.js         app-shell cache, push decrypt + notification, click-to-open (asks an open app to route, else navigates)
deploy/                docker compose: app, Caddy (automatic HTTPS), coturn (host network)
scripts/               server setup, install, update, status (see scripts/README.md)
```

Dependencies: Go `modernc.org/sqlite` (pure Go, CGO-free static binary), `coder/websocket`, `golang.org/x/crypto/argon2`, `golang.org/x/time/rate`, `SherClockHolmes/webpush-go`, `filippo.io/age` (backup encryption; restore with the stock age CLI). Web: `preact`, `@preact/signals`, `unicode-emoji-json` (lazy chunk).

## Flows

- **Register:** `#/i/<secret>` → `peek` (inviter, chat, encrypted key bundle) → name → `redeem` creates user + active device + membership, returns generated password once → keys from the bundle into IndexedDB. A friend link `#/f/<secret>` is the same invite; the browser offers only sign-in and joins right after it (signed in: `redeem` adds the membership).
- **Recovery link:** the inviter's browser seals the keys of shared chats under a fragment secret (`#/r/<secret>`) → `POST /api/recoveries` (only for someone they invited) → the person opens it signed out → `redeem` (with the bundle keys wrapped for the new device) sets a new password, adds an active device flagged `recovery`, stores its keys for chats shared with the inviter only, flags them for rotation → keys into IndexedDB → partners in other chats approve it as in device recovery; until then `keyHoldersSQL` leaves it out of their rotations.
- **Login:** password → `argon2id(pepper)` lookup. Known device signs a server nonce. Unknown device becomes `pending` (or `active` if the user has no chats) → own device or chat partner approves by wrapping chat keys for it.
- **Send:** ensure epoch (rotate if flagged) → upload encrypted images → seal payload + sign → `POST` with client id → server stores, bumps `seq`, fans out over WebSocket, pushes to devices without a visible page (no socket, or a socket that reported `vis` hidden) unless the send is `quiet` (an answered or declined call's log).
- **Read elsewhere:** `POST /read` → `read` event to sockets → a silent `read` push (Chromium push services only) to the reader's other devices that got a push for that chat → the service worker closes the chat's notifications.
- **Catch-up:** socket open → `/api/sync?since=<seq>` (messages changed since) → reload chat list and pending approvals.
- **New release:** the checkout's `git describe` reaches the image as `VERSION` (`scripts/common.sh` → compose build argument; server `-X main.version`, web `VITE_VERSION`) → every socket open (a deploy restarts the server, so every page reconnects) fetches `/healthz` → a version other than the page's own shows the reload banner (not during a call). Settings show the version and a reload button.
- **Call:** caller seals an SDP offer with the chat key → WS `call` (offers rate-limited per user) → server relays to the partner's active sockets and pushes sleeping phones, keeps the offer 45 s → a phone opened from the push gets it on connect and rings once its chat list has loaded → the first device to answer wins (the server drops later answers, others get `taken`, sleeping ones a silent `callEnd` push that closes the ring) → ICE over the same channel → media peer-to-peer or via coturn. Every call has a video slot, so the camera, another camera (devices menu, remembered) or a shared screen (`getDisplayMedia`, computers only) goes in with `replaceTrack`, no renegotiation; the call's data channel tells the other side whether it is a screen (always shown whole). Mid-call, when media stops or the network changes, the caller re-offers with an ICE restart (`reoffer`/`reanswer`, the callee can ask with `restart`) every 5 s until it reconnects or 30 s pass; signals are handled strictly in order.
- **Avatar:** pick → 256 px square → sealed once per chat (`a:<chat>:<user>:<epoch>`) → `PUT /api/me/avatar` bumps the version. After every chat list load the client copies the latest version into chats that lag (joined later, re-keyed direct chat). Lists carry versions; pictures are fetched and decrypted on first render.
- **Link preview (opt-in):** composer finds the first link → `POST /api/preview` → server fetches the page (public IPs, ports 80/443 only) → card with a shrunk picture goes inside the sealed payload.
- **Backup:** hourly loop → a snapshot when the last is a day old → age-encrypted file in `DATA_DIR/backups`, oldest pruned → with S3: snapshots newer than the last uploaded, media rows not `backed_up`.

## Patterns

| Pattern | Where | Why | Rejected alternative |
|---|---|---|---|
| Idempotent send by client id | `handleSend`, `sendMessage` | Retries on flaky mobile networks must not duplicate messages | Server-side dedup by content: ambiguous for repeated texts |
| Global change counter (`seq`) + tombstones | `messages.seq`, `/api/sync` | One cursor catches up edits, deletes and reactions after a dropped socket | Per-chat "since id": misses edits and deletes |
| Lazy key rotation by the next writer | `chats.rotate`, `ensureEpoch`, `keyHoldersSQL` | Set on join, leave, device revoke and a week-old key; whoever writes next has the keys and is online. Only key holders may rotate | Server-driven rotation: impossible, the server has no keys |
| In-process hub | `hub.go` | One small instance; no broker to run | Redis pub/sub: extra service for no present need |
| Coalesced refetch | `loadChats` | Bursts of `chat` events collapse into few requests | Debounce timer: adds latency to single events |
| Numbered schema migrations | `store.go` `migrations` | The base schema (version 0) is frozen; changes are appended and applied once via PRAGMA user_version | Editing CREATE TABLE: never reaches an existing database |
| Recorder format fallback | `recorder.ts` `begin` | Browsers claim formats they then fail to encode (Chrome AAC with a bitrate); restart with the next one | Trusting isTypeSupported alone |
| Socket by platform, visibility reported | `store.ts` visibility handler (`holdSocket`, `{t:'vis'}`), `hub.deviceInFront` | Phones drop the socket when hidden (frozen pages, iOS penalizes silent pushes); computers keep it in a background tab so a call rings there, and the server still pushes because the tab said it is hidden. A page visible but not in front shows its own notifications | Socket only while visible everywhere: a background tab neither rang nor got pushes in time; always-on socket without the flag: the server would skip push |
| One shared AudioContext | `sounds.ts` `audio`, `wake`, `idle` | iOS keeps a context silent until a tap starts it: every tap starts the shared one, so a ring or a message later sounds without a tap; it sleeps when idle, and rounds are scheduled only while it runs (a stopped clock would pile them up) | A context per sound: made outside a tap, iOS left it mute |
| One Euro filter on face points | `effects.ts` `OneEuro`, `Tracker` | Landmarks jitter by a pixel or two; the filter smooths hard at rest and barely lags in motion, and the drawn face glides between readings (the model runs ~15 times a second) | A fixed blend towards each reading: either jitter or lag |
| Hold-to-record state machine | `Composer.tsx` (`Press`, `pressDown`/`pressMove`/`pressUp`), `recorder.ts` `dragAction` | One button does tap (switch voice/circle), hold (record, release sends), drag up (lock), drag left (cancel); the press lives in a ref because opening the microphone is async, the gesture rule is a pure function | Separate buttons per action: not how people expect a messenger to work |
| Version-keyed lazy pictures | `picture()` in `store.ts`, `avatar_v`/`photo_v` | Chat lists stay small; a picture is fetched once per version | Pictures inline in `/api/chats`: every list reload carries every avatar |
| Copy-on-lag avatar reconcile | `reconcileAvatar`, `PUT /api/me/avatar` copy with `v` | The server cannot re-encrypt; after each chat list load the owner's client fills chats that lag (joined later, or a direct chat whose key moved on). The copy names the version it carries, so a race with a newer upload is refused (409 `stale`) instead of storing an old picture under the new version | A rotation hook that re-seals: the rotating writer may not be the avatar's owner |
| SSRF check in the dialer | `newPreviewClient` `Dialer.Control` | Runs on the resolved IP of every connection, redirects included, so DNS rebinding cannot slip past | Resolving and checking the host before the request: time-of-check gap |
| Caller-only ICE restart | `renegotiate` in `call.ts` | Only one side ever offers, so a restart cannot collide with one from the other side; the callee just asks | "Perfect negotiation" with polite/impolite roles: more code for a 1:1 call |
| Hand-written Prometheus text and SigV4 | `metrics.go`, `backup.go` | A few counters and a single-object PUT; verified against the AWS test vector and a real S3 server | `client_golang`, `aws-sdk-go-v2`: large dependency trees for two small needs |
