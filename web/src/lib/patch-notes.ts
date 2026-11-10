// What each release changed, for the people using the app, newest first. A
// release is a `vX.Y.Z` tag: the app shows its entry once after the update,
// and the settings list them all. Write what a person notices, not the code.
export interface PatchNote {
  version: string;
  date: string;
  ru: string[];
  en: string[];
}

export const patchNotes: PatchNote[] = [
  {
    version: 'v0.2.0',
    date: '2026-11-10',
    ru: [
      'Звонок больше не теряется, если соединение оборвалось незаметно, например после сна ноутбука или смены Wi-Fi: приложение само проверяет связь и подключается заново, пока звонок ещё звонит.',
      'Приложения для Windows, macOS, Linux и Android, если владелец сервера их собрал: ссылки на экране входа и в Настройках → «Приложения», ваша система выделена, ссылкой можно поделиться. На компьютере трей, запуск при входе, окно поверх других и системные уведомления; на Android звонок на весь экран, как телефонный, и текст сообщений в уведомлениях, расшифрованный на телефоне.',
      'Приложения обновляются сами с вашего сервера: при новой версии появляется кнопка «Обновить», обновление проверяется перед установкой.',
      'Звонок сразу берёт микрофон и динамик, которые выбраны в системе. Другой выбор в звонке действует до его конца.',
      'Двойное нажатие на сообщение может ставить ❤️ или 👍 вместо ответа: Настройки → Сообщения.',
      'После звонка больше не приходит лишнее уведомление о нём: остаётся только уведомление о пропущенном звонке.',
      'Фото уходят в лучшем качестве, а переключатель HD над вложениями отправляет оригинал, только без геолокации и других данных о снимке.',
      'На телефоне скрепка открывает свою камеру: нажатие делает фото, удержание пишет видео, есть смена камеры и вспышка, у фронтальной камеры кольцевая подсветка по краям экрана. В приложении для Android там же сетка фото и видео из галереи.',
    ],
    en: [
      'A call is no longer lost when the connection died unnoticed, after a laptop slept or the Wi-Fi changed: the app checks the line itself and reconnects while the call still rings.',
      "Apps for Windows, macOS, Linux and Android, if the server's owner built them: links on the sign-in screen and in Settings, Apps, with your system marked and a link to share. On a computer a tray icon, start at login, a window over the others and system notifications; on Android a call rings full screen like a phone call, and notifications show the message text, decrypted on the phone.",
      'The apps update themselves from your server: when a new version is out, an Update button appears, and the update is checked before it installs.',
      'A call starts on the microphone and speaker chosen in the system. Another choice in the call lasts until it ends.',
      'A double tap on a message can put ❤️ or 👍 instead of a reply: Settings, Messages.',
      'No extra notification after a call any more: only a missed call is announced.',
      'Photos go out in better quality, and the HD switch above the attachments sends the original, only without its location and other photo data.',
      "On a phone the paperclip opens the app's own camera: a tap takes a photo, holding records a video, with a camera switch and a flash, and a ring light around the screen for the front camera. In the Android app the gallery's photos and videos are right there too.",
    ],
  },
  {
    version: 'v0.1.0',
    date: '2026-11-04',
    ru: [
      'На компьютере шумодав теперь можно выбрать: RNNoise по умолчанию, DeepFilterNet3, шумодав браузера или без него. В Safari и на телефонах работает шумодав браузера.',
      'Новые настройки микрофона на компьютере, а в проверке устройств можно послушать свой голос таким, каким его услышат другие.',
      'В окне звонка правая кнопка открывает меню приложения: громкость голоса, звук показанного экрана и профиль человека.',
      'Показанный экран можно открыть во весь экран: кнопкой на нём или двойным кликом в групповом звонке, кнопкой вверху в личном.',
      'Звонки надёжнее: старые уведомления не мешают новому звонку, видео подстраивается под слабую сеть, блокировка приложения не глушит личный звонок.',
      'Для «Нажми, чтобы говорить» можно назначить свою клавишу, на Windows она работает и поверх других приложений.',
      'Появились звуки сообщений и участников звонка.',
    ],
    en: [
      'On a computer you can now choose the noise suppression: RNNoise by default, DeepFilterNet3, the browser one or none. Safari and phones use the browser one.',
      'New microphone settings on a computer, and the device check lets you hear your own voice the way others will.',
      "In a call window the right button opens the app's menu: voice volume, the sound of a shared screen and the person's profile.",
      'A shared screen can fill the display: the button on it or a double click in a group call, the button at the top in a personal one.',
      'Calls are more reliable: old notifications do not get in the way of a new call, video adapts to a weak network, the app lock no longer silences a personal call.',
      'Push to talk can use a key of your own, on Windows even over other apps.',
      'Messages and call participants now have sounds.',
    ],
  },
];
