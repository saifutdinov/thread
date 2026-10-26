# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: the **Security** tab of this repository, then **Report a vulnerability**. Do not open a public issue for them. This is a small volunteer project: reports are read and answered as soon as possible. Fixes are released as a new version and described in the advisory once people had a chance to update.

Only the latest release gets security fixes. Self-hosted instances update with `sudo scripts/update.sh`.

## What Thread protects against

- **A server that stores and relays data honestly** (a curious administrator, the hosting provider), **a stolen disk or backup.** Message text, reactions, photos, videos, voice messages, files, group names, avatars and call setup are encrypted in the browser. The server stores and relays only ciphertext. Encrypted backups use the owner's public age key, so the server cannot read them either.
- **A stolen password.** A password alone opens nothing: a new device must be approved by one of the user's existing devices, or, when all are lost, by a chat partner who compares a code with the user.
- **Network eavesdropping.** TLS for the app and its API. Call media is encrypted end to end by WebRTC (DTLS-SRTP); the relay's own control traffic is plain TURN and carries only short-lived credentials. The DTLS fingerprints travel inside the chat key's encryption, so the server cannot substitute its own keys into a call unless it first gets the chat key by inserting a device (see below).
- **Detecting a substituted device.** Safety codes (emoji and digits derived from both users' device keys) let two people confirm, in person or by phone, that nobody inserted a device. After they confirm, a later change of either person's devices shows a warning in their direct chat. This is detection, not prevention: see below.

## What it does not protect against

- **An actively malicious server adding a device.** The list of a user's devices comes from the server, and when a chat key rotates, the browser encrypts the new key for every device on that list. A server that inserts its own device can therefore read new messages in every chat where nobody has compared safety codes, and even where they have, the change only shows a warning. Key rotation can also be triggered by the server (keys expire weekly anyway).
- **A compromised server serving modified app code.** This is true of any end-to-end encryption delivered through a web page. A strict Content Security Policy and no third-party scripts reduce the risk; they do not remove it.
- **Third-party code in call effects.** Face effects use Google's MediaPipe face detector, served from your own server and run on the device; frames and face points never leave it. The library also tries to send usage statistics to `odml.pa.googleapis.com` and has no switch for that: the Content Security Policy blocks those requests.
- **Metadata.** The server sees names, who is in which chat, message times and sizes, who called whom and for how long, IP addresses, whether an open app is in front, and, if a user turns on link previews, the links they send. Push services (Apple, Google, Mozilla) see when a notification goes to which device, not its content. In a direct call the two people see each other's IP addresses.
- **Past messages after a key leak.** There is no forward secrecy within a key period. Chat keys rotate weekly and whenever someone joins or leaves or a device is removed.
- **A compromised device.** Whoever controls an unlocked device can read what that device can read. The optional app lock (PIN, Face ID, fingerprint) is a privacy screen, not encryption.
- **A deceived chat partner.** Recovery through a contact relies on that person really checking the code with you: a deceived partner lets someone who has your password into the chats you share with them.
- **The person who invited you.** They can make a recovery link for your account and open it themselves. That gives them a new password and the chats you share with them, which they could read anyway. Your other chats stay closed to that device until the people in them approve it after comparing a code, but from it they can sign out your other devices and change the password: they can take the account away from you, not your other conversations. You notice it from the new-device notification and from your old password no longer working. This is deliberate: in a family, forgotten passwords are far more common than a hostile inviter.

## The protocol

Standard WebCrypto primitives: ECDH P-256 and ECDSA P-256 device keys (non-extractable), AES-256-GCM chat keys per key period, an ECIES-style key wrap (ephemeral ECDH, HKDF-SHA256, AES-GCM), signed messages, HKDF-derived invite secrets carried in the URL fragment. The full description, including every authenticated-data label, is in [docs/adr/0001-e2ee-webcrypto.md](docs/adr/0001-e2ee-webcrypto.md) (in Russian).

**The protocol has not been independently audited.** Thread is meant for families and close circles. People facing serious, targeted threats should use Signal.
