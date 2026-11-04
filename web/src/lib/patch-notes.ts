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
