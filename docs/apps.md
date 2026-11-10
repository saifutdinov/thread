# Приложения для своего сервера

Приложения Нитки для Windows, macOS, Linux и Android несут адрес одного сервера: интерфейс в них свой, и они говорят только с ним (`docs/adr/0007-installable-apps.md`). Поэтому владелец сервера собирает их под свой сервер в своём форке. Готовые установщики раздаёт сам сервер: на экране входа и в Настройках → «Приложения», и оттуда же приложения обновляются (`docs/updates.md`).

Без приложений всё работает как раньше, в браузере и как PWA.

## 1. Форк и настройки

Сделайте форк репозитория на GitHub. В новом форке GitHub выключает Actions: откройте вкладку Actions и включите их. Затем Settings → Secrets and variables → Actions.

Переменные (Variables):

| Имя | Что в ней |
| --- | --- |
| `THREAD_ORIGIN` | адрес вашего сервера, например `https://chat.example.org` |
| `THREAD_APP_ID` | идентификатор Android-приложения, например `org.example.chat`: то же имя, что у приложения в Firebase. С `GOOGLE_SERVICES_JSON` обязателен |
| `THREAD_UPDATE_KEY` | открытый ключ обновлений (шаг 3) |

Секреты (Secrets):

| Имя | Что в нём |
| --- | --- |
| `GOOGLE_SERVICES_JSON` | `google-services.json` из Firebase целиком (шаг 4) |
| `ANDROID_KEYSTORE` | ключ подписи APK в base64 (шаг 2) |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD` | его пароль (оба одинаковые) |
| `ANDROID_KEY_ALIAS` | `thread` (или свой `-alias`) |
| `UPDATE_SIGNING_KEY` | секретный ключ обновлений (шаг 3) |

Пока `THREAD_ORIGIN` не задан, CI только проверяет, что приложения собираются. С ним секреты `ANDROID_*` обязательны: без ключа подписи тег не выпустит ничего.

## 2. Ключ подписи APK

Один раз, на своём компьютере (Java из `mise.toml`: `mise install`):

```bash
cd ~ && "$(cd ~/path/to/thread && mise which keytool)" -genkeypair -v -keystore ~/thread-release.jks -alias thread -keyalg RSA -keysize 4096 -validity 36500
```

Пароль хранилища придумываете вы. Имя и организация попадают в сертификат внутри APK, их видит любой: достаточно названия чата. Затем `base64 -i ~/thread-release.jks` (macOS) или `base64 -w0 ~/thread-release.jks` (Linux) в секрет `ANDROID_KEYSTORE`. Файл и пароль храните в менеджере паролей: без них новый APK не встанет поверх старого.

## 3. Ключ обновлений

Им CI подписывает список установщиков, а приложения для компьютера ставят только подписанное (`docs/updates.md`):

```bash
cd ~/path/to/thread && node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');require('fs').writeFileSync(process.env.HOME+'/thread-update-key.pem',k.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});console.log(k.publicKey.export({type:'spki',format:'der'}).subarray(12).toString('base64'))"
gh secret set UPDATE_SIGNING_KEY -R <вы>/<форк> < ~/thread-update-key.pem
```

Напечатанная строка, открытый ключ, идёт в переменную `THREAD_UPDATE_KEY`. Файл `~/thread-update-key.pem` сохраните в менеджере паролей и удалите с диска.

## 4. Пуши для Android (Firebase, бесплатно)

1. Firebase Console → проект → Android-приложение с идентификатором из `THREAD_APP_ID`. Скачайте `google-services.json` в секрет `GOOGLE_SERVICES_JSON`.
2. Project settings → Cloud Messaging: «Firebase Cloud Messaging API (V1)» включён.
3. Project settings → Service accounts → Generate new private key. Этот JSON нужен серверу, в GitHub его не кладите. На сервере:

```bash
sudo install -d -m 755 secrets && sudo cp ~/ключ.json secrets/fcm.json && sudo chown 65532:65532 secrets/fcm.json && sudo chmod 400 secrets/fcm.json
```

(в папке Нитки на сервере; `65532` это пользователь контейнера). Перезапустите: `sudo scripts/update.sh`. Без ключа пуши Android-приложению выключены, остальное работает.

## 5. Выпуск

Сервер должен стоять на релизе (`sudo scripts/update.sh release`), а приложения собираются из того же тега: иначе интерфейс в них и на сервере разный, и они просят переустановку. В форке подтяните изменения основного репозитория и поставьте тег той же версии, что и сервер (`git tag -a v1.2.3 && git push --tags`). CI соберёт приложения под ваш сервер и выложит их в релиз форка вместе с `SHA256SUMS.txt`, `manifest.json` и подписью.

На сервере:

```bash
sudo scripts/apps.sh <вы>/<форк>
```

Скрипт скачивает последний релиз форка, сверяет каждый файл с манифестом и кладёт их в `downloads/`. Сервер отдаёт их на `/api/downloads`, а приложения находят там обновления. Повторяйте после каждого выпуска.

## Собрать у себя

Компьютер: `cd web && npm run build && cd ../desktop/app && npm ci && npm start` (адрес сервера в `desktop/app/app-config.json` или `THREAD_ORIGIN=http://localhost:8080`).

Android: нужны Android SDK (Android Studio или command-line tools, платформа 37 и build-tools 36+), Java и Gradle из `mise.toml`:

```bash
cd web && npm run build && cd ../android && gradle testDebugUnitTest assembleDebug -PthreadOrigin=https://chat.example.org
```

APK окажется в `android/app/build/outputs/apk/debug/`. Без `android/app/google-services.json` приложение собирается и работает, но без пушей.

## Как поставить

- Компьютер: `docs/install-desktop.md`.
- Android: `docs/install-android.md`.
