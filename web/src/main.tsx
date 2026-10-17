import { render } from 'preact';
import { InviteScreen, LoginScreen, LostScreen, PasswordScreen, PendingScreen, RecoverScreen } from './components/Auth';
import { Main } from './components/Main';
import { LockScreen } from './components/Security';
import { initLock, locked } from './lib/lock';
import { initPrefs } from './lib/prefs';
import { registerSW } from './lib/pwa';
import { route } from './lib/route';
import { screen, start } from './lib/store';
import './styles.css';

function App() {
  if (route.value.name === 'recover' && screen.value !== 'loading' && screen.value !== 'password') return <RecoverScreen />;
  switch (screen.value) {
    case 'loading':
      return <div class="splash" aria-busy="true" />;
    case 'login':
      return route.value.name === 'invite' ? <InviteScreen /> : <LoginScreen />;
    case 'invite':
      return <InviteScreen />;
    case 'password':
      return <PasswordScreen />;
    case 'pending':
      return <PendingScreen />;
    case 'lost':
      return <LostScreen />;
    default:
      if (locked.value) return <LockScreen />;
      return route.value.name === 'invite' ? <InviteScreen /> : <Main />;
  }
}

// iOS Safari ignores interactive-widget and overlays the keyboard: size
// the app to the visual viewport so the composer stays above it.
function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const fit = () => {
    root.style.setProperty('--app-h', vv.height + 'px');
    root.style.setProperty('--app-top', vv.offsetTop + 'px');
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

initPrefs();
trackViewport();
registerSW();
render(<App />, document.getElementById('root')!);
// The lock state is read before the app shows anything.
initLock()
  .catch(() => {})
  .finally(() => start().catch(() => (screen.value = 'login')));
