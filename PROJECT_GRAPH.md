# PROJECT_GRAPH: Thread (Нитка)

## Modules

```
cmd/thread             env config, pepper, `healthcheck` subcommand, wiring
cmd/thread-hotkeys     Windows native messaging entry, physical key state, per-user install/uninstall with ownership checks (ADR 0005)
internal/hotkeys       bounded native frames, one configured chord, rate-limited changes, release/rearm gate and heartbeat
desktop/extension      Chrome/Edge bridge for the one origin set in its manifest, one tab owner, reconnect and cross-host binding rate limit
desktop/make-dev-extension.mjs explicitly generates an ignored localhost dev build, separate from the distributed extension
internal/server        the whole backend, one package
  server.go            Server, routes, security headers (CSP, Origin check), static PWA, cleanup loop
  store.go             SQLite schema (WAL, _txlock=immediate), seq counter, small query helpers
  auth.go              passwords (argon2id + pepper), sessions, login + device challenge, rate limits
  invites.go           bootstrap invite, peek/redeem, chat creation, invite links, direct chat with a group member
  vault.go             the personal vault: my sealed names for people, its key wrapped for the devices I gave it, rotation after a revoke
  chats.go             chat list, messages, edits, deletes, reactions, read marks, rotation, keys, sync
  devices.go           device list, pending/recovery, approve, revoke
  recovery.go          recovery links: the inviter vouches, a new password and device
  media.go             encrypted blob upload/download, orphan cleanup
  hub.go               WebSocket fan-out, presence, typing, call signaling relay
  push.go              Web Push (VAPID) with ciphertext payloads, silent read/call-end clears, test push, delivery counters
  calls.go             1:1 call signaling (sealed SDP/ICE), TURN REST credentials
  call_state.go        pending calls, first answering tab/device, late-signal guards and expiry
                       exact-id call-status check for notification freshness (active chat members only)
  group.go             group calls: LiveKit tokens (HS256), who is in which call, ringing the chat, /lk signaling proxy
  profiles.go          sealed avatars (per chat) and group photos, versioned
  preview.go           opt-in link preview fetcher with a dialer-level SSRF guard
  backup.go            daily VACUUM INTO snapshot, pinned media + manifest, age encryption, retention, ordered S3 upload (SigV4)
  metrics.go           Prometheus text endpoint on an internal port, response counters
  words.txt            EFF long wordlist subset for passwords (CC BY 3.0 US, EFF)
web/                   Preact + Vite PWA
  src/lib/crypto.ts    WebCrypto: device keys, ECIES wrap, seal/open, sign/verify, invite keys, device code
  src/lib/idb.ts       IndexedDB kv (device keys, chat keys, lang); shared with public/sw.js
  src/lib/api.ts       typed /api client
  src/lib/store.ts     app state (signals), decrypt/encrypt, sending, sync, WebSocket, devices, invites
  src/lib/messages.ts  monotonic message versions and chat previews
  src/lib/media-cache.ts reference-counted Blob URL LRU; use-media.ts loads nearby media and retains it until unmount
  src/lib/diagnostics.ts allowlisted local RTC diagnostics, without addresses, identities or content
                        bounded 120-second event history, immediate final report and generation-guarded stats enrichment
  src/lib/hold.ts      push-to-talk input sources, release and focus-loss reset
  src/lib/hotkey.ts    physical key binding validation, exact modifiers and labels; navigation keys stay available
  src/lib/ptt-prefs.ts device-local chord/global preference, companion discovery
  src/components/PushToTalk.tsx browser/native holds, native state sessions, heartbeat and safe release outside browser focus
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
  src/lib/wallpaper.ts the chat background's own photo (IndexedDB, a CSS variable)
  src/lib/player.ts    the music player: one <audio> for the app, next/previous in the chat, Media Session, its sound into a call
  src/lib/track.ts     which files are tracks, their title, artist and audio type (pure)
  src/lib/sounds.ts    plays the sound this device chose (a tune or an own file in IndexedDB) through one shared AudioContext
                       1.5-second message cooldown, call opt-in, natural preview completion; cached one-shot PCM limited to five seconds
  src/lib/call-presence.ts participant identity tracker; join/leave sounds without duplicate reconnect chimes
  scripts/brotli.mjs   brotli copies of the build's WebAssembly (served by static())
  scripts/call-failures.mjs real-browser call failures with isolated Thread/LiveKit processes, signal cleanup and screenshots on failure
  scripts/install-livekit.mjs pinned, checksum-verified test SFU; LIVEKIT_BINARY bypass for other platforms
  src/lib/emoji.ts     emoji-only messages drawn large
  src/lib/call.ts      WebRTC call state machine, tones, sealed signaling, ICE restart, quality stats
  src/lib/group.ts     group calls through LiveKit (lazy chunk): sealed call key, frame encryption, people, ringing, banners
  src/lib/rtc.ts       call tuning without the DOM: Opus SDP params (voice, music slot), codec order per device, quality level
  src/lib/network-policy.ts hysteresis and camera/screen video budgets; music keeps its stereo 128 kbit/s SDP and medium priority
  src/lib/network.ts   per-device automatic/normal/economy preference, shared by personal and group calls
  src/lib/tap.ts       the call screen's pure touch helpers: double tap, the small tile's width, where a dragged tile lands
  src/lib/mic.ts       the calls' microphone on computers: RNNoise (lazy) and the voice gate through Web Audio, settings, level meter
  src/lib/gate-worklet.js the voice gate on the audio thread (live threshold, hold, fade)
  src/lib/devices.ts   cameras, microphones, speakers; names for Android audio routes; remembered choices
  src/lib/markup.tsx   **bold** __italic__ ~~strike~~ `code` > quote, links
  src/lib/recorder.ts  voice/circle recording (MediaRecorder), waveform, format fallback, hold-drag gesture
  src/lib/lock.ts      app lock: PIN (PBKDF2), WebAuthn biometrics, timeout, hidden push text
  src/components/*     screens: Auth, Main (layout, approval, onboarding), ChatList, ChatView, Composer,
                       EmojiPicker, ChatInfo, NewChat, Settings, Media (voice, circles, files),
                       Security (lock screen, lock settings, safety codes), Call (call screen),
                       GroupCall (group call: ring, tiles, strip), CallSettings (devices and microphone, both call kinds), MicTuning (noise suppression, sensitivity),
                       Player (the player bar),
                       ui (icons, Modal, Avatar, PictureButtons)
  public/sw.js         app-shell cache, push decrypt + notification, click-to-open (asks an open app to route, else navigates)
deploy/                docker compose: app, Caddy (automatic HTTPS), coturn (host network), LiveKit SFU (one UDP port)
scripts/               server setup, install, update, status (see scripts/README.md), check.sh (everything to run before a review)
```

Dependencies: Go `modernc.org/sqlite` (pure Go, CGO-free static binary), `coder/websocket`, `golang.org/x/crypto/argon2`, `golang.org/x/time/rate`, `SherClockHolmes/webpush-go`, `filippo.io/age` (backup encryption; restore with the stock age CLI). Web: `preact`, `@preact/signals`, `unicode-emoji-json` (lazy chunk), `livekit-client` (lazy chunk, group calls only). Container: `livekit/livekit-server` (pinned by digest).

## Flows

- **Register:** `#/i/<secret>` → `peek` (inviter, chat, encrypted key bundle) → name → `redeem` creates user + active device + membership, returns generated password once → keys from the bundle into IndexedDB. A friend link `#/f/<secret>` is the same invite; the browser offers only sign-in and joins right after it (signed in: `redeem` adds the membership).
- **Recovery link:** the inviter's browser seals the keys of shared chats under a fragment secret (`#/r/<secret>`) → `POST /api/recoveries` (only for someone they invited) → the person opens it signed out → `redeem` (with the bundle keys wrapped for the new device) sets a new password, adds an active device flagged `recovery`, stores its keys for chats shared with the inviter only, flags them for rotation → keys into IndexedDB → partners in other chats approve it as in device recovery; until then `keyHoldersSQL` leaves it out of their rotations.
- **Login:** password → `argon2id(pepper)` lookup. Known device signs a server nonce. Unknown device becomes `pending` (or `active` if the user has no chats) → own device or chat partner approves by wrapping chat keys for it.
- **Send:** ensure epoch (rotate if flagged) → upload encrypted images → seal payload + sign → `POST` with client id → server stores, bumps `seq`, fans out over WebSocket, pushes to devices without a visible page (no socket, or a socket that reported `vis` hidden) unless the send is `quiet` (an answered or declined call's log).
- **Read elsewhere:** `POST /read` → `read` event to sockets → a silent `read` push (Chromium push services only) to the reader's other devices that got a push for that chat → the service worker closes the chat's notifications.
- **Group call:** the first member seals a random call key with the chat key (`call:<chat>:<id>:gkey:<epoch>`) → `POST /api/chats/{id}/call` stores the ciphertext and who is in, rings the other members (socket `gcall ring` and push) and returns a LiveKit token for the chat's own room → the browser opens the key, turns on frame encryption and connects to LiveKit through `/lk` (signaling) and `7882/udp` or `7881/tcp` (media). Later members get the same sealed key. `gcall state` tells the chat who is in; a device joins only with an open socket, leaves by `DELETE` or when its last socket closes, and joins again with a new one (`rejoin` puts back a call the server forgot after a restart, without ringing). An app that opens asks `GET /api/calls/group` for the "Join" banners. A computer can share its screen as one more frame-encrypted track; it is shown whole above the tiles.
- **Direct chat from a group:** a member's Message button → an existing direct chat of the two opens; otherwise the browser makes a key, wraps it for every active device of both (`/api/chats/{group}/devices?all=1` and its own) → `POST /api/chats/direct` checks the two share a chat and that the keys cover exactly those devices, makes the chat (or returns the one they have) → `chat` event to both.
- **Microphone on computers:** the call opens the microphone with the browser's echo cancellation and gain (its noise suppression only when RNNoise is off) → `openMic` runs RNNoise and the voice gate in a 48 kHz AudioContext when either is on → the processed track goes into the 1:1 sender or is published to LiveKit as the microphone (unprocessed, LiveKit opens the microphone itself and reopens it when it ends). A change of noise suppression reopens the microphone (`reopenMic`, `reopenGroupMic`); a threshold change goes straight to the gate.
- **Notification notes:** after every chat list load the app writes `push:<chat>` (the chat's name, a data: URL of its picture) to IndexedDB when it changed; the service worker builds a message notification from it, the push (`u`, `at`) and `names` (own names): a group's title over "Name: text", a count since the chat was last open, the badge, "Mark as read" (`POST /read`). A group call's push has "Join": a `gjoin` note the app acts on once it knows the running calls.
- **Leaving a running group call for good:** leaving the group or a device switched off → the server drops them from who is in the call and asks LiveKit's RoomService (an admin pass for that room) to remove their connections.
- **Music player and into a call:** a track's play button → `player.ts` plays it in the app's one `<audio>`, the bar on top shows it, it goes on to the chat's next track → in a call "Play into the call" routes the element through Web Audio to the speakers and to a track: the 1:1 sound slot (`shareMusic`) or a LiveKit track of its own (`shareGroupMusic`).
- **Own names on all my devices:** a change here is applied and marked (`namesDirty`) → `loadVault` reads the vault, opens its key with this device's wrap (`vk:`), puts the marked changes on top and writes it back with the version it replaces → the server tells my devices (`vault` event), which read it again; a device of mine gets the key only by my hand: approving it, or Settings → Devices → "Передать мои имена" after comparing its code (`vaultShare` lists those missing it); after a revoke the next write takes a new key for the holders left (`key_for`); a device without the key writes only once nobody holds it (`lost`).
- **Catch-up:** socket open → `/api/sync?since=<seq>` (messages changed since) → reload chat list and pending approvals.
- **New release:** the checkout's `git describe` reaches the image as `VERSION` (`scripts/common.sh` → compose build argument; server `-X main.version`, web `VITE_VERSION`) → every socket open (a deploy restarts the server, so every page reconnects) fetches `/healthz` → a version other than the page's own shows the reload banner (not during a call). Settings show the version and a reload button.
- **Call:** caller seals an SDP offer with the chat key → WS `call` (offers rate-limited per user) → server relays to the partner's active sockets and pushes sleeping phones, keeps the offer 45 s → a phone opened from the push gets it on connect and rings once its chat list has loaded → the first device to answer wins (the server drops later answers, others get `taken`, sleeping ones a silent `callEnd` push that closes the ring) → ICE over the same channel → media peer-to-peer or via coturn. Every call has a video slot, so the camera, another camera (devices menu, remembered) or a shared screen (`getDisplayMedia`, computers only) goes in with `replaceTrack`, no renegotiation; the call's data channel tells the other side whether it is a screen (always shown whole). Every call also has a music slot, a second audio transceiver: music from a tab or the screen (`getDisplayMedia` with sound, Chrome and Edge on computers) goes in with `replaceTrack` too, as stereo Opus at 128 kbit/s with no voice processing, and the other side plays it through its own `<audio>` at its own volume. Mid-call, when media stops or the network changes, the caller re-offers with an ICE restart (`reoffer`/`reanswer`, the callee can ask with `restart`) every 5 s until it reconnects or 30 s pass; signals are handled strictly in order.
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
| Style and background as attributes | `prefs.ts` `design`/`wallpaper` set `data-design`/`data-wall` on `<html>`; `styles.css` overrides per attribute | A whole style is one CSS block over the same markup, so "Classic" stays exactly as it was and the public copy can default to it | A second set of components per style |
| One shared AudioContext | `sounds.ts` `audio`, `wake`, `idle` | iOS keeps a context silent until a tap starts it: every tap starts the shared one, so a ring or a message later sounds without a tap; it sleeps when idle, and rounds are scheduled only while it runs (a stopped clock would pile them up) | A context per sound: made outside a tap, iOS left it mute |
| One Euro filter on face points | `effects.ts` `OneEuro`, `Tracker` | Landmarks jitter by a pixel or two; the filter smooths hard at rest and barely lags in motion, and the drawn face glides between readings (the model runs ~15 times a second) | A fixed blend towards each reading: either jitter or lag |
| Hold-to-record state machine | `Composer.tsx` (`Press`, `pressDown`/`pressMove`/`pressUp`), `recorder.ts` `dragAction` | One button does tap (switch voice/circle), hold (record, release sends), drag up (lock), drag left (cancel); the press lives in a ref because opening the microphone is async, the gesture rule is a pure function | Separate buttons per action: not how people expect a messenger to work |
| Version-keyed lazy pictures | `picture()` in `store.ts`, `avatar_v`/`photo_v` | Chat lists stay small; a picture is fetched once per version | Pictures inline in `/api/chats`: every list reload carries every avatar |
| Copy-on-lag avatar reconcile | `reconcileAvatar`, `PUT /api/me/avatar` copy with `v` | The server cannot re-encrypt; after each chat list load the owner's client fills chats that lag (joined later, or a direct chat whose key moved on). The copy names the version it carries, so a race with a newer upload is refused (409 `stale`) instead of storing an old picture under the new version | A rotation hook that re-seals: the rotating writer may not be the avatar's owner |
| SSRF check in the dialer | `newPreviewClient` `Dialer.Control` | Runs on the resolved IP of every connection, redirects included, so DNS rebinding cannot slip past | Resolving and checking the host before the request: time-of-check gap |
| Screen sound as a second audio track | `musicSlot`, `shareScreen`/`shareSound` in `call.ts`, `tuneOpus` in `rtc.ts` | Sharing a screen or a tab carries its sound too (the separate "Play music" button is gone: at times it cut the call's sound for both): the person plays YouTube or Spotify in their own tab and the call carries the picture and the sound: in sync by construction (one stream), end-to-end encrypted, nothing fetched by the app or the server; its own slot keeps it stereo at 128 kbit/s with a deeper jitter buffer while the voice stays mono with RED | Each side playing the same link in sync: YouTube forbids a hidden or audio-only player and shows each side its own ads; Spotify needs Premium for every listener and forbids one source for several listeners; a server fetching the audio (Jockie-style bots) breaks both services' terms and the end-to-end design |
| SFU with frame encryption for groups | `group.go`, `group.ts`, `deploy/docker-compose.yml` `sfu` | Ten people cannot send to each other directly (9 uploads each, phones overheat); LiveKit forwards each stream once with layers per viewer, and the frames are encrypted in the browsers with a key only members can open, so the SFU forwards ciphertext | Full mesh: tops out at 3-4 with video; an own Pion SFU: months of layer switching and bandwidth estimation |
| Own microphone chain on computers | `mic.ts` `openMic`, `gate-worklet.js`, `publishTrack` in `group.ts` | Chrome's noise suppression is weak on Windows; RNNoise and a gate in Web Audio work in every desktop browser, offline, under the same CSP. Group calls publish the processed track themselves, so the chain runs in our 48 kHz context | LiveKit's audio processor API: its context belongs to the room and may be rebuilt at another rate; Krisp: LiveKit Cloud only |
| Push notes in IndexedDB | `notePush` in `store.ts`, `card` in `sw.js`, `notifyMessage` in `notify.ts` | A push wakes the service worker for a moment: no time to fetch and decrypt a group title or a picture. The app, which has both, leaves them per chat in the same IndexedDB as the keys, written only when they changed | Decrypting in the service worker on each push: a network round trip and the picture's key per notification; plaintext titles from the server: against the end-to-end design |
| Latest-wins reopen | `latest` in `mic.ts`, `reopenMic`, `reopenGroupMic` | A slider drag or quick toggles must not open the microphone many times at once; calls during a run make one more run with the settings as they are by then | A queue: reopens once per event; a debounce timer: lags a single toggle |
| Caller-only ICE restart | `renegotiate` in `call.ts` | Only one side ever offers, so a restart cannot collide with one from the other side; the callee just asks | "Perfect negotiation" with polite/impolite roles: more code for a 1:1 call |
| Hand-written Prometheus text and SigV4 | `metrics.go`, `backup.go` | A few counters and a single-object PUT; verified against the AWS test vector and a real S3 server | `client_golang`, `aws-sdk-go-v2`: large dependency trees for two small needs |
