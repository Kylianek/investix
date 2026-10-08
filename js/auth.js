/* Přihlášení přes Clerk (stejný systém jako v CRM) - bez build kroku, přes Clerk JS SDK.
   Dokud je klíč prázdný, přihlášení se v appce vůbec nenabídne a zbytek funguje beze změny.
   Klíč: Clerk dashboard -> Configure -> API Keys -> "Publishable key" (veřejný, smí být v repu). */
const CLERK_PUBLISHABLE_KEY = 'pk_test_dHJ1ZS1yZWRmaXNoLTI4MDkuY2xlcmsuYWNjb3VudHMuZGV2JA';

const CLERK_LOCALIZATION_URL = 'https://cdn.jsdelivr.net/npm/@clerk/localizations@4/dist/cs-CZ.mjs';

function clerkFrontendApi(key) {
  const host = atob(key.split('_')[2] || '');
  return host.endsWith('$') ? host.slice(0, -1) : host;
}

const CLERK_SCRIPT_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: timeout po ${ms} ms`)), ms)),
  ]);
}

function loadClerkScript(src, key) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('Načítání trvalo příliš dlouho: ' + src)), CLERK_SCRIPT_TIMEOUT_MS);
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-clerk-publishable-key', key);
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Nepodařilo se načíst ' + src));
    };
    document.head.appendChild(script);
  });
}

async function initAuth() {
  const area = document.getElementById('auth-area');
  const key = CLERK_PUBLISHABLE_KEY.trim();
  if (!area || !/^pk_(test|live)_[A-Za-z0-9+/=_-]{8,}$/.test(key)) return;

  const signInBtn = document.getElementById('btn-sign-in');
  const signUpBtn = document.getElementById('btn-sign-up');
  const userButtonEl = document.getElementById('clerk-user-button');
  let userButtonMounted = false;

  try {
    window.__clerk_publishable_key = key;
    const base = `https://${clerkFrontendApi(key)}/npm/@clerk`;
    // České texty se stahují souběžně s Clerkem; kdyby selhaly, přihlášení pojede anglicky.
    const localizationPromise = withTimeout(import(CLERK_LOCALIZATION_URL), 10000, 'České texty').then(
      (module) => module.csCZ,
      (e) => {
        console.warn('České texty přihlášení se nenačetly, použije se angličtina:', e);
        return undefined;
      }
    );
    await loadClerkScript(`${base}/clerk-js@6/dist/clerk.browser.js`, key);
    await loadClerkScript(`${base}/ui@1/dist/ui.browser.js`, key);
    if (!window.Clerk || typeof window.Clerk.load !== 'function' || !window.__internal_ClerkUICtor) {
      throw new Error('Clerk se po načtení skriptů nespustil (zkontroluj publishable key)');
    }

    const localization = await localizationPromise;
    const clerk = window.Clerk;
    await withTimeout(
      clerk.load({
        ui: { ClerkUI: window.__internal_ClerkUICtor },
        localization,
        appearance: { variables: { colorPrimary: '#2563eb' } },
      }),
      20000,
      'Clerk.load'
    );

    const render = () => {
      const signedIn = !!clerk.user;
      signInBtn.classList.toggle('hidden', signedIn);
      signUpBtn.classList.toggle('hidden', signedIn);
      userButtonEl.classList.toggle('hidden', !signedIn);
      if (signedIn && !userButtonMounted) {
        clerk.mountUserButton(userButtonEl, { showName: true });
        userButtonMounted = true;
      } else if (!signedIn && userButtonMounted) {
        clerk.unmountUserButton(userButtonEl);
        userButtonMounted = false;
      }
    };

    signInBtn.addEventListener('click', () => clerk.openSignIn());
    signUpBtn.addEventListener('click', () => clerk.openSignUp());
    clerk.addListener(render);
    render();
    area.classList.remove('hidden');
  } catch (e) {
    console.warn('Přihlášení se nepodařilo načíst, appka běží bez něj:', e);
  }
}

initAuth();
