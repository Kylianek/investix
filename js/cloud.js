/* Záloha dat do cloudu podle přihlášeného účtu (Clerk + API ze složky api/ - viz api/data.js).
   Web zůstává na GitHub Pages, API je jen neviditelný backend. Dokud je adresa prázdná,
   záloha je vypnutá a data zůstávají jen v prohlížeči.
   Adresa: Vercel projekt s tímhle repem, např. 'https://investix-api.vercel.app' (bez lomítka na konci). */
const INVESTIX_API_URL = 'https://investix-sigma.vercel.app';

window.cloudSync = (() => {
  const base = INVESTIX_API_URL.trim().replace(/\/+$/, '');
  const NOTE_LOCAL = 'Data se ukládají jen v tomto prohlížeči';
  const NOTE_CLOUD = 'Data se zálohují do cloudu';

  let getToken = null;
  let ready = false; // zapisovat do cloudu se smí až po úspěšném PŘEČTENÍ - jinak hrozí přepsání cizích/novějších dat
  let generation = 0; // zahodí pozdní odpovědi po odhlášení / přepnutí účtu
  let pushTimer = null;
  let pushing = false;
  let dirty = false;
  let lastStartAttempt = 0;

  const byId = (id) => document.getElementById(id);

  function setStatus(text, isError) {
    const el = byId('cloud-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('text-red-600', !!isError);
    el.classList.toggle('text-slate-500', !isError);
  }

  function setUi(active) {
    const section = byId('cloud-section');
    if (section) section.classList.toggle('hidden', !active);
    const note = byId('storage-note');
    if (note) note.textContent = active ? NOTE_CLOUD : NOTE_LOCAL;
  }

  async function api(method, body) {
    const token = await getToken();
    const response = await fetch(`${base}/api/data`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`API ${response.status}`);
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
    const { properties = [], loans = [], events = [], settings = {} } = snapshot || {};
    return JSON.stringify(canonical(JSON.parse(JSON.stringify({ properties, loans, events, settings }))));
  }

  function hasData(snapshot) {
    return !!snapshot && ['properties', 'loans', 'events'].some((key) => Array.isArray(snapshot[key]) && snapshot[key].length > 0);
  }

  async function push() {
    await api('PUT', { data: stateSnapshot() });
  }

  async function adoptRemote(remote) {
    applyStateFromObject(remote);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateSnapshot()));
    renderAll();
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
      'V cloudu jsou jiná data než v tomto prohlížeči. Který stav chceš zachovat? Druhý se přepíše.',
      'Použít cloud',
      'Použít tento prohlížeč'
    );
    if (useCloud) await adoptRemote(remote);
    else await push();
  }

  async function start(tokenGetter) {
    if (!base) return;
    getToken = tokenGetter;
    ready = false;
    clearTimeout(pushTimer);
    const current = ++generation;
    lastStartAttempt = Date.now();
    setUi(true);
    setStatus('Načítám zálohu z cloudu…');
    try {
      const { data: remote } = await api('GET');
      if (current !== generation) return;
      await reconcile(remote);
      if (current !== generation) return;
      ready = true;
      setStatus('Data jsou zálohovaná v cloudu.');
    } catch (e) {
      if (current !== generation) return;
      console.warn('Záloha do cloudu:', e);
      setStatus('Cloud je nedostupný - data zůstávají jen v tomto prohlížeči.', true);
    }
  }

  function stop() {
    generation += 1;
    ready = false;
    getToken = null;
    clearTimeout(pushTimer);
    setUi(false);
  }

  async function runPush() {
    if (pushing) {
      dirty = true;
      return;
    }
    pushing = true;
    const current = generation;
    try {
      await push();
      if (current === generation) setStatus('Data jsou zálohovaná v cloudu.');
    } catch (e) {
      console.warn('Záloha do cloudu:', e);
      if (current === generation) setStatus('Zálohu do cloudu se nepodařilo uložit.', true);
    } finally {
      pushing = false;
      if (dirty) {
        dirty = false;
        schedulePush();
      }
    }
  }

  function schedulePush() {
    if (!base || !getToken) return;
    if (!ready) {
      // první čtení z cloudu selhalo - zkusit znovu, ale ne častěji než jednou za 20 s
      if (Date.now() - lastStartAttempt > 20000) start(getToken);
      return;
    }
    clearTimeout(pushTimer);
    pushTimer = setTimeout(runPush, 800);
  }

  async function confirmAndDelete() {
    if (!getToken) return;
    const confirmed = await confirmTwice(
      'Opravdu smazat zálohu dat uloženou v cloudu? Data v tomto prohlížeči zůstanou beze změny. Tuto akci nelze vrátit zpět.',
      'Fakt si tím jistý/á? Cloudová záloha se nedá obnovit a budeš odhlášen(a).',
      'Smazat zálohu'
    );
    if (!confirmed) return;
    try {
      await api('DELETE');
    } catch (e) {
      alert('Smazání cloudové zálohy se nepodařilo.');
      return;
    }
    stop();
    alert('Cloudová záloha byla smazána. Byl(a) jsi odhlášen(a).');
    if (window.Clerk) window.Clerk.signOut();
  }

  const deleteButton = byId('btn-delete-cloud');
  if (deleteButton) deleteButton.addEventListener('click', confirmAndDelete);

  return { start, stop, schedulePush };
})();
