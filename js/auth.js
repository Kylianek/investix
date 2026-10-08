/* Přihlášení přes Clerk (stejný systém jako v CRM) - bez build kroku, přes Clerk JS SDK.
   Dokud je klíč prázdný, přihlášení se v appce vůbec nenabídne a zbytek funguje beze změny.
   Klíč: Clerk dashboard -> Configure -> API Keys -> "Publishable key" (veřejný, smí být v repu). */
const CLERK_PUBLISHABLE_KEY = 'pk_test_dHJ1ZS1yZWRmaXNoLTI4MDkuY2xlcmsuYWNjb3VudHMuZGV2JA';

const CLERK_LOCALIZATION_URL = 'https://cdn.jsdelivr.net/npm/@clerk/localizations@4/dist/cs-CZ.mjs';
const CLERK_SCRIPT_TIMEOUT_MS = 15000;
const NOT_SIGNED_IN_NOTE = 'Nepřihlášen - data se neukládají';

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: timeout po ${ms} ms`)), ms)),
  ]);
}

function clerkFrontendApi(key) {
  const host = atob(key.split('_')[2] || '');
  return host.endsWith('$') ? host.slice(0, -1) : host;
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

function profileDisplayName(user) {
  const email = user.primaryEmailAddress && user.primaryEmailAddress.emailAddress;
  return user.fullName || user.username || email || 'Profil';
}

/** Přepne hlavičku mezi odhlášeným stavem (tlačítka přihlášení) a přihlášeným (menu profilu). Ozubené kolo zůstává pořád na stejném místě. */
function applyAuthState(user) {
  const signedIn = !!user;
  const byId = (id) => document.getElementById(id);
  byId('btn-sign-in').classList.toggle('hidden', signedIn);
  byId('btn-sign-up').classList.toggle('hidden', signedIn);
  byId('profile-menu').classList.toggle('hidden', !signedIn);
  byId('profile-dropdown').classList.add('hidden');
  if (!signedIn) return;
  byId('profile-display-name').textContent = profileDisplayName(user);
  const avatar = byId('profile-avatar');
  avatar.classList.toggle('hidden', !user.imageUrl);
  if (user.imageUrl) avatar.src = user.imageUrl;
}

/**
 * Vědomé odhlášení: nejdřív se do cloudu odešlo všechno, co čeká, pak se v prohlížeči smaže
 * pracovní kopie dat (po odhlášení tu nic nezůstane) a teprve potom se Clerk odhlásí. Přesměrování
 * se musí zadat výslovně - výchozí je kořen domény, tedy github.io/, ne tahle appka.
 */
window.investixSignOut = async ({ flush = true } = {}) => {
  const clerk = window.Clerk;
  if (!clerk) return;
  window.leaveGuard.signingOut = true;
  try {
    if (flush && window.cloudSync) {
      await window.cloudSync.flush();
      if (window.cloudSync.hasUnsavedChanges()) {
        const proceed = await customConfirm(
          'Poslední změny se nepodařilo uložit do cloudu. Odhlásit se i tak? Změny se ztratí.',
          'Odhlásit se',
          'Zůstat přihlášen(a)'
        );
        if (!proceed) {
          window.leaveGuard.signingOut = false;
          return;
        }
      }
    }
    if (window.cloudSync) window.cloudSync.stop();
    wipeWorkingCopy();
    await clerk.signOut({ redirectUrl: window.location.origin + window.location.pathname });
  } catch (e) {
    console.warn('Odhlášení se nepodařilo:', e);
    window.leaveGuard.signingOut = false;
  }
};

function wireProfileMenu(clerk) {
  const button = document.getElementById('profile-btn');
  const dropdown = document.getElementById('profile-dropdown');
  const close = () => {
    dropdown.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.toggle('hidden');
    button.setAttribute('aria-expanded', String(isOpen));
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  document.getElementById('menu-account').addEventListener('click', () => {
    close();
    clerk.openUserProfile();
  });
  document.getElementById('menu-signout').addEventListener('click', () => {
    close();
    window.investixSignOut();
  });
}

// Clerk si pamatuje přihlášení v cookie __client_uat (0 = odhlášen) - díky tomu se hned po otevření
// stránky ví, že se budou stahovat data z účtu, a místo prázdné appky se ukáže "načítám".
function looksSignedIn() {
  return document.cookie.split(';').some((cookie) => {
    const [name, value] = cookie.trim().split('=');
    return /^__client_uat(_|$)/.test(name) && !!value && value !== '0';
  });
}

// Přihlašovací okno Clerku (a přesměrování na Google a zpět) nesmí vyvolat "opravdu chceš odejít?".
function watchAuthModal() {
  new MutationObserver(() => {
    window.leaveGuard.authModalOpen = !!document.querySelector('.cl-modalBackdrop, .cl-modalContent');
  }).observe(document.body, { childList: true, subtree: true });
}

function markAuthReady(signedIn) {
  window.authState.ready = true;
  window.authState.signedIn = signedIn;
  if (!signedIn) {
    setStorageNote(NOT_SIGNED_IN_NOTE, 'warn');
    setSyncOverlay(false);
  }
  refreshSessionNotice();
}

async function initAuth() {
  const area = document.getElementById('auth-area');
  const key = CLERK_PUBLISHABLE_KEY.trim();
  if (!area || !/^pk_(test|live)_[A-Za-z0-9+/=_-]{8,}$/.test(key)) {
    markAuthReady(false);
    return;
  }

  if (looksSignedIn()) {
    setSyncOverlay(true);
    setTimeout(() => setSyncOverlay(false), 25000);
  }
  watchAuthModal();

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
        afterSignOutUrl: window.location.origin + window.location.pathname,
      }),
      20000,
      'Clerk.load'
    );

    let lastUserId = null;
    const render = () => {
      const user = clerk.user;
      applyAuthState(user);
      window.authState.ready = true;
      window.authState.signedIn = !!user;
      const userId = user ? user.id : null;
      if (userId !== lastUserId) {
        lastUserId = userId;
        if (window.cloudSync) {
          if (userId) {
            window.cloudSync.start(() => clerk.session.getToken()).finally(() => setSyncOverlay(false));
          } else {
            window.cloudSync.stop();
          }
        }
      }
      if (!user) markAuthReady(false);
      else refreshSessionNotice();
    };

    document.getElementById('btn-sign-in').addEventListener('click', () => clerk.openSignIn());
    document.getElementById('btn-sign-up').addEventListener('click', () => clerk.openSignUp());
    const noticeSignIn = document.getElementById('session-notice-signin');
    if (noticeSignIn) noticeSignIn.addEventListener('click', () => clerk.openSignIn());
    wireProfileMenu(clerk);
    clerk.addListener(render);
    render();
    area.classList.remove('hidden');
  } catch (e) {
    console.warn('Přihlášení se nepodařilo načíst, appka běží bez něj:', e);
    markAuthReady(false);
  }
}

initAuth();
