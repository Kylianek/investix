/* Data přihlášeného uživatele žijí v databázi (Clerk přihlášení + API ze složky api/ - viz api/data.js):
   každá uložená změna se hned odešle. Web zůstává na GitHub Pages, API je jen neviditelný backend.
   Adresa API: Vercel projekt s tímhle repem (bez lomítka na konci). */
const INVESTIX_API_URL = 'https://investix-sigma.vercel.app';

window.cloudSync = (() => {
  const base = INVESTIX_API_URL.trim().replace(/\/+$/, '');
  const SAVE_DELAY_MS = 200; // jen slepí rychlé změny za sebou do jednoho zápisu
  const RETRY_MS = 15000;

  const MESSAGES = {
    loading: ['Načítám data z účtu…', 'neutral'],
    saving: ['Ukládám…', 'warn'],
    saved: ['Uloženo v cloudu', 'ok'],
    error: ['Ukládání do cloudu selhalo', 'error'],
    unreachable: ['Cloud je nedostupný - změny se neukládají', 'error'],
    unconfigured: ['Ukládání do cloudu není nastavené', 'error'],
  };

  let getToken = null;
  let ready = false; // zapisovat se smí až po úspěšném PŘEČTENÍ - jinak hrozí přepsání novějších dat
  let generation = 0; // zahodí pozdní odpovědi po odhlášení / přepnutí účtu
  let pushTimer = null;
  let retryTimer = null;
  let pushing = false;
  let pushPromise = null;
  let dirty = false;
  let failed = false;
  let lastStartAttempt = 0;

  const byId = (id) => document.getElementById(id);

  function show(kind) {
    const [text, tone] = MESSAGES[kind];
    setStorageNote(text, tone);
    const status = byId('cloud-status');
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function setUi(active) {
    const section = byId('cloud-section');
    if (section) section.classList.toggle('hidden', !active);
  }

  async function api(method, body) {
    const token = await getToken();
    const response = await fetch(`${base}/api/data`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      let reason = '';
      try {
        reason = (await response.json()).reason || '';
      } catch (e) {
        /* odpověď nebyla JSON */
      }
      throw new Error(`API ${response.status}${reason ? ' ' + reason : ''}`);
    }
    return response.json();
  }

  // jsonb v databázi neudrží pořadí klíčů, proto se porovnává seřazená podoba, ne surový text
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])])
      );
    }
    return value;
  }

  // Porovnává se jen to podstatné (ne třeba vybraný rok v Přehledu)
  function fingerprint(snapshot) {
    // starší záznamy (např. zástavy bez částek) se před porovnáním převedou na dnešní podobu
    const { properties = [], loans = [], events = [], settings = {} } = typeof normalizeSnapshot === 'function' ? normalizeSnapshot(snapshot) : snapshot || {};
    // chybějící nastavení se doplní výchozími, ať starší záznam v účtu nevypadá jako "jiná data"
    const fullSettings = { ...DEFAULT_SETTINGS, ...settings };
    return JSON.stringify(canonical(JSON.parse(JSON.stringify({ properties, loans, events, settings: fullSettings }))));
  }

  function hasData(snapshot) {
    return !!snapshot && ['properties', 'loans', 'events'].some((key) => Array.isArray(snapshot[key]) && snapshot[key].length > 0);
  }

  async function push() {
    await api('PUT', { data: stateSnapshot() });
  }

  async function adoptRemote(remote) {
    setState(remote);
    persistWorkingCopy();
    renderAll();
    refreshSessionNotice();
    // starší záloha nemusí mít všechna dnešní nastavení - doplněný stav se pošle zpět, ať se příště nerozchází
    if (fingerprint(stateSnapshot()) !== fingerprint(remote)) await push();
  }

  async function reconcile(remote) {
    const local = stateSnapshot();
    if (!hasData(remote)) {
      if (hasData(local)) await push();
      return;
    }
    if (!hasData(local)) {
      await adoptRemote(remote);
      return;
    }
    if (fingerprint(remote) === fingerprint(local)) return;
    const useCloud = await customConfirm(
      'V účtu jsou jiná data než tady na stránce. Který stav chceš zachovat? Druhý se přepíše.',
      'Použít data z účtu',
      'Použít data ze stránky'
    );
    if (useCloud) await adoptRemote(remote);
    else await push();
  }

  async function start(tokenGetter) {
    if (!base) {
      show('unconfigured');
      return;
    }
    getToken = tokenGetter;
    ready = false;
    failed = false;
    clearTimeout(pushTimer);
    pushTimer = null;
    clearTimeout(retryTimer);
    const current = ++generation;
    lastStartAttempt = Date.now();
    setUi(true);
    show('loading');
    try {
      const { data: remote } = await api('GET');
      if (current !== generation) return;
      await reconcile(remote);
      if (current !== generation) return;
      clearLegacyLocalCopy(); // data jsou bezpečně v účtu - starý záznam z dřívější verze už není potřeba
      ready = true;
      show('saved');
    } catch (e) {
      if (current !== generation) return;
      console.warn('Cloud:', e);
      show('unreachable');
    }
  }

  function stop() {
    generation += 1;
    ready = false;
    getToken = null;
    failed = false;
    dirty = false;
    clearTimeout(pushTimer);
    pushTimer = null;
    clearTimeout(retryTimer);
    setUi(false);
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (getToken && ready && failed) pushNow();
    }, RETRY_MS);
  }

  function pushNow() {
    if (pushing) {
      dirty = true;
      return pushPromise;
    }
    pushing = true;
    pushPromise = (async () => {
      const current = generation;
      do {
        dirty = false;
        try {
          await push();
          failed = false;
          if (current === generation) show('saved');
        } catch (e) {
          failed = true;
          console.warn('Cloud:', e);
          if (current === generation) {
            show('error');
            scheduleRetry();
          }
          break;
        }
      } while (dirty);
      pushing = false;
    })();
    return pushPromise;
  }

  function schedulePush() {
    if (!base || !getToken) return;
    if (!ready) {
      // první čtení z cloudu selhalo - zkusit znovu, ale ne častěji než jednou za 20 s
      if (Date.now() - lastStartAttempt > 20000) start(getToken);
      return;
    }
    show('saving');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushNow();
    }, SAVE_DELAY_MS);
  }

  /** Okamžitě odešle všechno, co ještě čeká (před odhlášením). */
  async function flush() {
    if (!base || !getToken || !ready) return;
    if (pushTimer === null && !pushing && !dirty && !failed) return;
    clearTimeout(pushTimer);
    pushTimer = null;
    await pushNow();
  }

  function hasUnsavedChanges() {
    if (!base || !getToken) return hasAnyData();
    if (!ready) return hasAnyData();
    return pushTimer !== null || pushing || dirty || failed;
  }

  async function confirmAndDelete() {
    if (!getToken) return;
    const confirmed = await confirmTwice(
      'Opravdu smazat všechna data z tvého účtu? Nelze je obnovit.',
      'Fakt si tím jistý/á? Data z účtu zmizí navždy, budeš odhlášen(a) a z této stránky se smažou taky.',
      'Smazat data z účtu'
    );
    if (!confirmed) return;
    try {
      await api('DELETE');
    } catch (e) {
      alert('Smazání dat z účtu se nepodařilo.');
      return;
    }
    alert('Data z tvého účtu byla smazána. Byl(a) jsi odhlášen(a).');
    await window.investixSignOut({ flush: false });
  }

  const deleteButton = byId('btn-delete-cloud');
  if (deleteButton) deleteButton.addEventListener('click', confirmAndDelete);

  return { start, stop, schedulePush, flush, hasUnsavedChanges };
})();
