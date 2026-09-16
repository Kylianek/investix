/* Hlavní logika aplikace: data se ukládají jen lokálně v prohlížeči (localStorage),
   žádný účet ani server. Výpočty jsou v js/calc.js. */

// Záměrně NEpřejmenováno na "investix" i po rebrandingu - je to jen interní
// localStorage klíč, uživatel ho nikde nevidí, ale kdyby se změnil, appka by
// si "nenašla" data, která si lidi už dřív uložili pod starým klíčem.
const STORAGE_KEY = 'investicni-kalkulacka-v1';
const CURRENT_YEAR = new Date().getFullYear();

const CZ_BANKS = [
  'Česká spořitelna',
  'ČSOB',
  'Komerční banka',
  'UniCredit Bank',
  'Raiffeisenbank',
  'Moneta Money Bank',
  'mBank',
  'Fio banka',
  'Air Bank',
  'Hypoteční banka',
];

const state = {
  properties: [],
  loans: [],
  events: [],
  settings: {
    inflation_rate: 0.03,
    rental_tax_rate: 15,
    capital_gains_tax_rate: 15,
    min_portfolio_value: 0,
    auto_sell_enabled: true,
    sale_trigger_amount: 0,
  },
  scenario: { horizonYears: 20 },
  overview: { year: CURRENT_YEAR, period: 'year' },
  overviewReal: { year: CURRENT_YEAR, period: 'year' },
  freedom: { horizonYears: 10 },
};

let scenarioShowDetail = false;
let currentUserId = null;
let syncDebounceTimer = null;
const SYNC_TABLE = 'app_data';

// Nedělitelná mezera ( ) mezi skupinami číslic i před jednotkou - číslo se
// svojí příponou (Kč/%) se tak nikdy nezalomí na dva řádky uprostřed buňky.
const fmtMoney = (n) =>
  (Number(n) || 0).toLocaleString('cs-CZ', { maximumFractionDigits: 0 }).replace(/\s/g, ' ') + ' Kč';
const fmtPercent = (n) =>
  ((Number(n) || 0) * 100).toLocaleString('cs-CZ', { maximumFractionDigits: 2 }).replace(/\s/g, ' ') + ' %';

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}

/* ---------- Formátovaná pole (Kč / %) - živé zarovnávání tisíců + jednotka ---------- */

const UNIT_SUFFIX = { money: 'Kč', percent: '%' };

function formatGroupedInteger(raw) {
  const neg = raw.trim().startsWith('-');
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return neg ? '-' : '';
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + grouped;
}

function formatDecimalValue(raw) {
  const neg = raw.trim().startsWith('-');
  let cleaned = raw.replace(/[^0-9.,]/g, '').replace(',', '.');
  const parts = cleaned.split('.');
  if (parts.length > 2) cleaned = parts[0] + '.' + parts.slice(1).join('');
  return (neg ? '-' : '') + cleaned;
}

function parseFormNumber(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/\s/g, '').replace(',', '.');
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

function formatInputHandler(kind) {
  return function () {
    const el = this;
    const cursorFromEnd = el.value.length - el.selectionStart;
    const formatted = kind === 'percent' ? formatDecimalValue(el.value) : formatGroupedInteger(el.value);
    el.value = formatted;
    const newPos = Math.max(formatted.length - cursorFromEnd, 0);
    try {
      el.setSelectionRange(newPos, newPos);
    } catch (e) {
      /* input typu, ktery selectionRange nepodporuje - nevadi */
    }
  };
}

function setFieldUnit(el, kind) {
  if (el._formatHandler) el.removeEventListener('input', el._formatHandler);
  el._formatHandler = formatInputHandler(kind);
  el.addEventListener('input', el._formatHandler);
  el.dataset.unit = kind;
  const suffixEl = el.parentElement.querySelector('.input-suffix');
  if (suffixEl) suffixEl.textContent = UNIT_SUFFIX[kind] || '';
  el.dispatchEvent(new Event('input'));
}

function wireFormattedInputs() {
  document.querySelectorAll('[data-unit]').forEach((el) => {
    const kind = el.dataset.unit;
    el.setAttribute('type', 'text');
    el.setAttribute('inputmode', kind === 'percent' ? 'decimal' : 'numeric');
    el.setAttribute('autocomplete', 'off');

    const wrap = document.createElement('div');
    wrap.className = 'input-suffix-wrap';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
    const suffix = document.createElement('span');
    suffix.className = 'input-suffix';
    suffix.textContent = UNIT_SUFFIX[kind] || '';
    wrap.appendChild(suffix);

    el._formatHandler = formatInputHandler(kind);
    el.addEventListener('input', el._formatHandler);
  });
}

/** Nastaví hodnotu formátovaného pole a hned ji přeformátuje (mezery/desetinná čárka). */
function setFormattedValue(el, value) {
  el.value = value === null || value === undefined || value === '' ? '' : value;
  el.dispatchEvent(new Event('input'));
}

/**
 * Přidá vždy viditelné šipky nahoru/dolů ke všem číselným polím (roky,
 * horizonty predikce...) - nativní spinner prohlížeče se u type="number"
 * ukazuje jen při najetí myší/focusu a leckde vůbec, tenhle funguje všude
 * stejně. Šipka jen mění hodnotu pole a vyvolá 'input'/'change' - o zbytek
 * (uložení, přepočet) se postarají posluchače, které už na poli visí.
 */
function wireNumberSteppers() {
  document.querySelectorAll('input[type="number"]').forEach((input) => {
    if (input.closest('.number-stepper-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'number-stepper-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const bump = (dir) => {
      const step = Number(input.step) || 1;
      let next = (Number(input.value) || 0) + dir * step;
      if (input.min !== '' && next < Number(input.min)) next = Number(input.min);
      if (input.max !== '' && next > Number(input.max)) next = Number(input.max);
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const buttons = document.createElement('div');
    buttons.className = 'number-stepper-buttons';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'number-stepper-btn';
    up.textContent = '▲';
    up.setAttribute('aria-label', 'Zvýšit');
    up.addEventListener('click', () => bump(1));
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'number-stepper-btn';
    down.textContent = '▼';
    down.setAttribute('aria-label', 'Snížit');
    down.addEventListener('click', () => bump(-1));
    buttons.appendChild(up);
    buttons.appendChild(down);
    wrap.appendChild(buttons);
  });
}

/* ---------- Klik do pole s "0" ho smaže; Enter v seznamových formulářích nic neodešle ---------- */

function wireZeroClearsOnFocus() {
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.tagName === 'INPUT' && el.classList.contains('input') && el.value.trim() === '0') {
      el.value = '';
    }
  });
}

/**
 * Vlastní potvrzovací dialog místo nativního window.confirm() - spolehlivější
 * napříč prohlížeči/mobilem (nativní confirm() se v některých kontextech umí
 * chovat nespolehlivě). Vrací Promise<boolean>.
 */
function customConfirm(message, okLabel, cancelLabel) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const okBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    document.getElementById('confirm-modal-text').textContent = message;
    okBtn.textContent = okLabel || 'Potvrdit';
    cancelBtn.textContent = cancelLabel || 'Zrušit';
    modal.classList.remove('hidden');
    const cleanup = (result) => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

/**
 * Pro nevratné mazání dat (lokálně i v cloudu) se ptá DVAKRÁT po sobě - první
 * potvrzení je běžný dotaz, druhé je záměrně formulované jinak (ne jen
 * zopakované), ať jde vidět, že to není omylem odklikané dvojklikem.
 * Vrací true jen pokud uživatel potvrdí OBĚ dotazy.
 */
async function confirmTwice(firstMessage, secondMessage, okLabel) {
  if (!(await customConfirm(firstMessage, okLabel, 'Zrušit'))) return false;
  return customConfirm(secondMessage, 'Ano, opravdu smazat', 'Ne, nechat data');
}

/**
 * Nastaví hodnotu pole, JEN pokud na něm zrovna není focus. Používá se u polí
 * jako "horizont"/"rok", kde render běží i z vlastního 'input' posluchače
 * pole - bez tyhle podmínky by se hodnota psaná uživatelem přepisovala po
 * každém stisku klávesy (nešlo by pole smazat/přepsat). Díky tomu se validace
 * (např. minimum) projeví až po odfokusování, ne během psaní.
 */
function setValueIfNotFocused(el, value) {
  if (document.activeElement !== el) el.value = value;
}

function preventEnterSubmit(form) {
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const isSubmitBtn = e.target.tagName === 'BUTTON' && e.target.type === 'submit';
    if (isSubmitBtn) return;
    e.preventDefault();
    e.target.blur();
  });
}

/** Krátká "fajfka" v rohu obrazovky po úspěšném uložení (nemovitost/úvěr/událost). */
let successToastTimer = null;
function showSuccessToast(text) {
  const el = document.getElementById('success-toast');
  if (!el) return;
  document.getElementById('success-toast-text').textContent = text || 'Uloženo';
  clearTimeout(successToastTimer);
  el.classList.remove('hidden');
  el.classList.remove('success-toast-anim');
  void el.offsetWidth; // vynutí reflow, aby se animace spustila znovu i při rychlém opakování
  el.classList.add('success-toast-anim');
  successToastTimer = setTimeout(() => el.classList.add('hidden'), 1800);
}

/* ---------- Perzistence (localStorage) ---------- */

function applyStateFromObject(parsed) {
  if (!parsed) return;
  if (Array.isArray(parsed.properties)) state.properties = parsed.properties;
  if (Array.isArray(parsed.loans)) state.loans = parsed.loans;
  if (Array.isArray(parsed.events)) state.events = parsed.events;
  if (parsed.settings) Object.assign(state.settings, parsed.settings);
  if (parsed.scenario) Object.assign(state.scenario, parsed.scenario);
  if (parsed.overview) Object.assign(state.overview, parsed.overview);
  if (parsed.overviewReal) Object.assign(state.overviewReal, parsed.overviewReal);
  if (parsed.freedom) Object.assign(state.freedom, parsed.freedom);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    applyStateFromObject(JSON.parse(raw));
  } catch (e) {
    console.error('Nepodařilo se načíst uložená data:', e);
  }
}

function stateSnapshot() {
  return {
    properties: state.properties,
    loans: state.loans,
    events: state.events,
    settings: state.settings,
    scenario: state.scenario,
    overview: state.overview,
    overviewReal: state.overviewReal,
    freedom: state.freedom,
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stateSnapshot()));
  scheduleCloudSync();
}

/* ---------- Volitelné přihlášení a záloha do cloudu (Supabase) ---------- */

function scheduleCloudSync() {
  if (!currentUserId || !supabaseClient) return;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => pushToCloud(currentUserId), 800);
}

async function pushToCloud(userId) {
  if (!supabaseClient) return;
  const { error } = await supabaseClient
    .from(SYNC_TABLE)
    .upsert({ user_id: userId, data: stateSnapshot(), updated_at: new Date().toISOString() });
  const statusEl = document.getElementById('auth-sync-status');
  if (statusEl) statusEl.textContent = error ? 'Zálohu do cloudu se nepodařilo uložit.' : 'Data jsou zálohovaná v cloudu.';
}

/**
 * Smaže záznam z tabulky app_data patřící přihlášenému uživateli - ne jen
 * přepíše prázdnými daty, ale skutečně smaže ten řádek (RLS "owner only"
 * politika DELETE u vlastního řádku už povoluje, žádná změna v Supabase
 * není potřeba). Lokální data v tomto prohlížeči tím nejsou nijak dotčená -
 * jakmile se ale příště něco lokálně změní, autosync by zálohu zase nahrál
 * nahoru, proto se po smazání ODHLÁSÍ, ať si uživatel vědomě řekne, jestli
 * chce zálohování znovu zapnout přihlášením.
 */
async function deleteCloudData() {
  if (!supabaseClient || !currentUserId) return;
  const userId = currentUserId;
  const { error } = await supabaseClient.from(SYNC_TABLE).delete().eq('user_id', userId);
  if (error) {
    alert('Smazání cloudové zálohy se nepodařilo: ' + error.message);
    return;
  }
  await supabaseClient.auth.signOut();
  currentUserId = null;
  alert('Cloudová záloha byla smazána. Byl(a) jsi odhlášen(a).');
}

/**
 * Po přihlášení VŽDY vyhraje cloud, pokud v něm něco je - žádné dotazování.
 * Nemá smysl nutit uživatele volit "lokální vs. cloud" pokaždé, když se
 * přihlásí ze zařízení, které už s cloudem jednou synchronizovalo - cloud je
 * "zdroj pravdy". Jen když cloud ještě nemá vůbec nic (úplně první přihlášení
 * z libovolného zařízení), nahraje se tam to, co má uživatel rozdělané lokálně.
 */
async function handlePostLogin(userId) {
  currentUserId = userId;
  const { data, error } = await supabaseClient.from(SYNC_TABLE).select('data').eq('user_id', userId).maybeSingle();
  if (error) {
    console.error(error);
    return;
  }
  const cloud = data && data.data;
  const cloudHasData = cloud && ((Array.isArray(cloud.properties) && cloud.properties.length) || (Array.isArray(cloud.loans) && cloud.loans.length));

  if (cloudHasData) {
    applyStateFromObject(cloud);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateSnapshot()));
    renderAll();
  } else {
    await pushToCloud(userId);
  }
}

/**
 * Přihlašovací UI existuje na dvou místech (kompaktní widget v hlavičce a
 * plná karta v Nastavení), obě řízená stejnou logikou - prefix '' je karta
 * v Nastavení (auth-email, auth-form...), prefix 'header-' je widget v
 * hlavičce (header-auth-email, header-auth-form...). Aktualizují/reagují
 * se vždy OBĚ najednou, ať uživatel vidí konzistentní stav, ať přihlášení
 * použije odkudkoliv.
 */
const AUTH_UI_PREFIXES = ['', 'header-'];

function updateAuthUI(session) {
  for (const prefix of AUTH_UI_PREFIXES) {
    const loggedOut = document.getElementById(prefix + 'auth-logged-out');
    const loggedIn = document.getElementById(prefix + 'auth-logged-in');
    if (!loggedOut || !loggedIn) continue;
    if (session) {
      loggedOut.classList.add('hidden');
      loggedIn.classList.remove('hidden');
      document.getElementById(prefix + 'auth-user-email').textContent = session.user.email;
    } else {
      loggedOut.classList.remove('hidden');
      loggedIn.classList.add('hidden');
    }
  }
  if (!session) currentUserId = null;
  document.getElementById('header-auth-dropdown').classList.add('hidden');
  document.getElementById('cloud-delete-section').classList.toggle('hidden', !session);
}

function showAuthMessage(prefix, text) {
  const el = document.getElementById(prefix + 'auth-message');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

function setAuthFieldsInvalid(prefix, invalid) {
  const emailEl = document.getElementById(prefix + 'auth-email');
  const passwordEl = document.getElementById(prefix + 'auth-password');
  emailEl.classList.toggle('input-error', invalid);
  passwordEl.classList.toggle('input-error', invalid);
}

function translateAuthError(message) {
  const known = {
    'Invalid login credentials': 'Nesprávný e-mail nebo heslo.',
    'User already registered': 'Uživatel s tímto e-mailem už existuje.',
    'Password should be at least 6 characters': 'Heslo musí mít alespoň 6 znaků.',
    'Email not confirmed': 'E-mail zatím nebyl potvrzen - zkontroluj schránku.',
  };
  if (known[message]) return known[message];
  // Supabase vrací číslo vteřin přímo v textu (mění se každý pokus), takže
  // přesnou shodu v `known` nejde použít - hlídá to proti spamování mailů.
  const rateLimitMatch = message.match(/^For security purposes, you can only request this after (\d+) seconds?\.$/);
  if (rateLimitMatch) {
    return `Z bezpečnostních důvodů to zkus znovu až za ${rateLimitMatch[1]} sekund.`;
  }
  return message;
}

async function handleAuthLogin(prefix, e) {
  e.preventDefault();
  if (!supabaseClient) return;
  const email = document.getElementById(prefix + 'auth-email').value.trim();
  const password = document.getElementById(prefix + 'auth-password').value;
  // Bez emailu/hesla by Supabase volání vzalo jako pokus o anonymní
  // přihlášení (které appka nepoužívá) a vrátilo matoucí anglickou hlášku
  // "Anonymous sign-ins are disabled" - radši zachytit prázdná pole rovnou tady.
  if (!email || !password) {
    setAuthFieldsInvalid(prefix, true);
    showAuthMessage(prefix, 'Vyplň e-mail i heslo.');
    return;
  }
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  setAuthFieldsInvalid(prefix, !!error);
  showAuthMessage(prefix, error ? translateAuthError(error.message) : '');
}

async function handleAuthSignup(prefix) {
  if (!supabaseClient) return;
  const email = document.getElementById(prefix + 'auth-email').value.trim();
  const password = document.getElementById(prefix + 'auth-password').value;
  if (!email || !password) {
    setAuthFieldsInvalid(prefix, true);
    showAuthMessage(prefix, 'Vyplň e-mail i heslo.');
    return;
  }
  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  if (error) {
    setAuthFieldsInvalid(prefix, true);
    showAuthMessage(prefix, translateAuthError(error.message));
    return;
  }
  setAuthFieldsInvalid(prefix, false);
  if (data.user && !data.session) {
    showAuthMessage(prefix, 'Registrace proběhla - zkontroluj e-mail a potvrď účet, pak se přihlas.');
  }
}

async function handleAuthSignout() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  currentUserId = null;
}

function wireAuthPrefix(prefix) {
  const form = document.getElementById(prefix + 'auth-form');
  if (!form) return;
  form.addEventListener('submit', (e) => handleAuthLogin(prefix, e));
  document.getElementById(prefix + 'btn-auth-signup').addEventListener('click', () => handleAuthSignup(prefix));
  document.getElementById(prefix + 'btn-auth-signout').addEventListener('click', handleAuthSignout);
  // Jakmile uživatel začne znovu psát, zmizí červené zvýraznění po chybě.
  document.getElementById(prefix + 'auth-email').addEventListener('input', () => setAuthFieldsInvalid(prefix, false));
  document.getElementById(prefix + 'auth-password').addEventListener('input', () => setAuthFieldsInvalid(prefix, false));
}

/** Kompaktní přihlašovací dropdown v hlavičce - klik na tlačítko ho otevře/zavře, klik mimo něj ho zavře. */
function wireHeaderAuthDropdown() {
  const toggle = document.getElementById('header-auth-toggle');
  const dropdown = document.getElementById('header-auth-dropdown');
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  });
  dropdown.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => dropdown.classList.add('hidden'));
}

function initAuth() {
  if (!supabaseClient) {
    document.getElementById('auth-config-warning').classList.remove('hidden');
    document.getElementById('header-auth-widget').classList.add('hidden');
    return;
  }
  for (const prefix of AUTH_UI_PREFIXES) wireAuthPrefix(prefix);
  wireHeaderAuthDropdown();

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    updateAuthUI(session);
    if (session) handlePostLogin(session.user.id);
  });
  supabaseClient.auth.getSession().then(({ data }) => {
    updateAuthUI(data.session);
    if (data.session) handlePostLogin(data.session.user.id);
  });
}

/* ---------- Inicializace ---------- */

function init() {
  loadState();
  wireTabs();
  wireForms();
  wireBackup();
  wireLienToggle();
  wireOverviewControls();
  wireOverviewRealControls();
  wireSettingsInputs();
  wireZeroClearsOnFocus();
  populateBankList();
  wireFormattedInputs();
  wireNumberSteppers();
  syncLienFieldsVisibility();
  resetEventForm();
  wireScenarioDetailToggle();
  wireFreedomControls();
  wireKpiFormulaToggles();
  wirePdfExportButtons();
  initAuth();
  document.getElementById('event-type').addEventListener('change', updateEventValueLabel);
  document.getElementById('scenario-horizon').addEventListener('input', (e) => {
    state.scenario.horizonYears = Math.max(1, Number(e.target.value) || 1);
    saveState();
    renderScenario();
    renderOverview();
    renderOverviewReal();
    renderFreedom();
  });
  document.getElementById('scenario-horizon').addEventListener('blur', () => renderScenario());
  renderAll();
}

function renderAll() {
  renderProperties();
  renderLoans();
  renderSettings();
  renderEvents();
  renderScenario();
  renderOverview();
  renderOverviewReal();
  renderFreedom();
}

/* ---------- Tabs ---------- */

function wireTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('tab-active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      btn.classList.add('tab-active');
      document.getElementById(btn.dataset.tab).classList.remove('hidden');
    });
  });
}

/* ---------- Banky (číselník) ---------- */

function populateBankList() {
  const dl = document.getElementById('bank-list');
  for (const bank of CZ_BANKS) {
    const opt = document.createElement('option');
    opt.value = bank;
    dl.appendChild(opt);
  }
}

/* ---------- Zástava - podmíněné zobrazení polí ---------- */

function wireLienToggle() {
  document.getElementById('property-has-lien').addEventListener('change', syncLienFieldsVisibility);
}

function syncLienFieldsVisibility() {
  const checked = document.getElementById('property-has-lien').checked;
  document.getElementById('lien-bank-label').classList.toggle('hidden', !checked);
  document.getElementById('lien-value-label').classList.toggle('hidden', !checked);
}

/* ---------- MOJE NEMOVITOSTI ---------- */

function renderProperties() {
  const tbody = document.getElementById('properties-tbody');
  tbody.innerHTML = '';
  for (const p of state.properties) {
    const av = calc.appreciatedValue(Number(p.market_value), Number(p.growth_rate));
    const tt = p.acquisition_date
      ? calc.timeTestRemaining(new Date(p.acquisition_date), p.tax_exempt_years || 10)
      : null;
    const marketValue = Number(p.market_value) || 0;
    const lienValue = Number(p.lien_value) || 0;
    const lienCell = p.has_lien
      ? `${escapeHtml(p.lien_bank || '?')}<br><span class="text-xs text-slate-500">${fmtMoney(lienValue)}</span>`
      : '<span class="text-slate-400">Bez zástavy</span>';
    const freedCell = p.has_lien
      ? fmtMoney(Math.max(0, marketValue - lienValue))
      : `${fmtMoney(marketValue)}<br><span class="text-xs text-slate-500">celá hodnota, bez zástavy</span>`;
    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-200 dark:border-slate-700';
    tr.innerHTML = `
      <td class="py-2 pr-3 font-medium">${escapeHtml(p.name)}</td>
      <td class="py-2 pr-3 text-right rent-positive">+${fmtMoney(p.rent)}</td>
      <td class="py-2 pr-3 text-right payment-negative">-${fmtMoney(p.payment)}</td>
      <td class="py-2 pr-3 text-right">${fmtMoney(marketValue)}</td>
      <td class="py-2 pr-3 text-right">${lienCell}</td>
      <td class="py-2 pr-3 text-right">${freedCell}</td>
      <td class="py-2 pr-3 text-right">${fmtPercent(p.growth_rate)}</td>
      <td class="py-2 pr-3 text-right">${fmtMoney(av)}</td>
      <td class="py-2 pr-3">${tt ? tt.text : '—'}</td>
      <td class="py-2 pr-3 whitespace-nowrap">
        <button class="text-blue-600 hover:underline mr-2" data-edit-property="${p.id}">Upravit</button>
        <button class="text-red-600 hover:underline" data-delete-property="${p.id}">Smazat</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-edit-property]').forEach((btn) =>
    btn.addEventListener('click', () => fillPropertyForm(btn.dataset.editProperty))
  );
  tbody.querySelectorAll('[data-delete-property]').forEach((btn) =>
    btn.addEventListener('click', () => deleteProperty(btn.dataset.deleteProperty))
  );
}

function fillPropertyForm(id) {
  const p = state.properties.find((x) => x.id === id);
  if (!p) return;
  const f = document.getElementById('property-form');
  f.elements['id'].value = p.id;
  f.elements['name'].value = p.name;
  setFormattedValue(f.elements['rent'], p.rent);
  setFormattedValue(f.elements['payment'], p.payment);
  setFormattedValue(f.elements['market_value'], p.market_value);
  setFormattedValue(f.elements['acquisition_price'], p.acquisition_price);
  setFormattedValue(f.elements['growth_rate'], p.growth_rate * 100);
  f.elements['acquisition_date'].value = p.acquisition_date || '';
  f.elements['tax_exempt_years'].value = p.tax_exempt_years || 10;
  setFormattedValue(f.elements['equity_invested'], p.equity_invested || '');
  setFormattedValue(f.elements['debt_invested'], p.debt_invested || '');
  f.elements['has_lien'].checked = !!p.has_lien;
  f.elements['lien_bank'].value = p.lien_bank || '';
  setFormattedValue(f.elements['lien_value'], p.lien_value || '');
  setFormattedValue(f.elements['vacancy_rate'], (p.vacancy_rate || 0) * 100);
  setFormattedValue(f.elements['monthly_costs'], p.monthly_costs || 0);
  setFormattedValue(f.elements['rent_growth_rate'], p.rent_growth_rate != null ? p.rent_growth_rate * 100 : '');
  syncLienFieldsVisibility();
  document.getElementById('property-form-title').textContent = 'Upravit nemovitost';
}

function resetPropertyForm() {
  const f = document.getElementById('property-form');
  f.reset();
  f.elements['id'].value = '';
  f.elements['tax_exempt_years'].value = '10';
  syncLienFieldsVisibility();
  document.getElementById('property-form-title').textContent = 'Přidat nemovitost';
}

async function deleteProperty(id) {
  if (!(await customConfirm('Opravdu smazat tuto nemovitost?', 'Smazat'))) return;
  state.properties = state.properties.filter((p) => p.id !== id);
  saveState();
  renderAll();
}

function submitPropertyForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.elements['id'].value;
  const rentGrowthRaw = f.elements['rent_growth_rate'].value.trim();
  const payload = {
    id: id || uid(),
    name: f.elements['name'].value.trim(),
    rent: parseFormNumber(f.elements['rent'].value),
    payment: parseFormNumber(f.elements['payment'].value),
    market_value: parseFormNumber(f.elements['market_value'].value),
    acquisition_price: parseFormNumber(f.elements['acquisition_price'].value),
    growth_rate: parseFormNumber(f.elements['growth_rate'].value) / 100,
    acquisition_date: f.elements['acquisition_date'].value || null,
    tax_exempt_years: Number(f.elements['tax_exempt_years'].value) || 10,
    equity_invested: f.elements['equity_invested'].value.trim() ? parseFormNumber(f.elements['equity_invested'].value) : null,
    debt_invested: f.elements['debt_invested'].value.trim() ? parseFormNumber(f.elements['debt_invested'].value) : null,
    has_lien: f.elements['has_lien'].checked,
    lien_bank: f.elements['has_lien'].checked ? f.elements['lien_bank'].value.trim() || null : null,
    lien_value: f.elements['has_lien'].checked && f.elements['lien_value'].value.trim() ? parseFormNumber(f.elements['lien_value'].value) : null,
    vacancy_rate: parseFormNumber(f.elements['vacancy_rate'].value) / 100,
    monthly_costs: parseFormNumber(f.elements['monthly_costs'].value),
    rent_growth_rate: rentGrowthRaw ? parseFormNumber(rentGrowthRaw) / 100 : null,
  };
  if (id) {
    const idx = state.properties.findIndex((p) => p.id === id);
    if (idx !== -1) state.properties[idx] = payload;
  } else {
    state.properties.push(payload);
  }
  saveState();
  resetPropertyForm();
  renderAll();
  showSuccessToast(id ? 'Nemovitost upravena' : 'Nemovitost přidána');
}

/* ---------- MOJE ÚVĚRY ---------- */

/** Poměr LTV (dluh/vlastní), pokud je zadaná hodnota nemovitosti při sjednání. */
function ltvInfo(loan) {
  const propValue = Number(loan.property_value_at_origination);
  if (!propValue || propValue <= 0) return null;
  const amount = Number(loan.amount) || 0;
  const ltvPct = Math.round(Math.min(1, amount / propValue) * 100);
  return { text: `${ltvPct}/${100 - ltvPct}`, ownAmount: Math.max(0, propValue - amount) };
}

function renderLoans() {
  const tbody = document.getElementById('loans-tbody');
  tbody.innerHTML = '';
  for (const l of state.loans) {
    const fx = l.start_date ? calc.fixationRemaining(new Date(l.start_date), l.fixation_years) : null;
    const ltv = ltvInfo(l);
    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-200 dark:border-slate-700';
    tr.innerHTML = `
      <td class="py-2 pr-3 font-medium">${escapeHtml(l.bank)}</td>
      <td class="py-2 pr-3 text-right">${fmtMoney(l.amount)}</td>
      <td class="py-2 pr-3 text-right">${fmtPercent(l.interest_rate)}</td>
      <td class="py-2 pr-3 text-right">${fmtMoney(l.monthly_payment)}</td>
      <td class="py-2 pr-3 text-right">${l.fixation_years} let</td>
      <td class="py-2 pr-3">${l.start_date || '—'}</td>
      <td class="py-2 pr-3">${fx ? fx.text : '—'}</td>
      <td class="py-2 pr-3">${ltv ? ltv.text : '—'}</td>
      <td class="py-2 pr-3 text-right">${ltv ? fmtMoney(ltv.ownAmount) : '—'}</td>
      <td class="py-2 pr-3">${escapeHtml(l.note || '')}</td>
      <td class="py-2 pr-3 whitespace-nowrap">
        <button class="text-blue-600 hover:underline mr-2" data-edit-loan="${l.id}">Upravit</button>
        <button class="text-red-600 hover:underline" data-delete-loan="${l.id}">Smazat</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-edit-loan]').forEach((btn) =>
    btn.addEventListener('click', () => fillLoanForm(btn.dataset.editLoan))
  );
  tbody.querySelectorAll('[data-delete-loan]').forEach((btn) =>
    btn.addEventListener('click', () => deleteLoan(btn.dataset.deleteLoan))
  );
}

function fillLoanForm(id) {
  const l = state.loans.find((x) => x.id === id);
  if (!l) return;
  const f = document.getElementById('loan-form');
  f.elements['id'].value = l.id;
  f.elements['bank'].value = l.bank;
  setFormattedValue(f.elements['amount'], l.amount);
  setFormattedValue(f.elements['interest_rate'], l.interest_rate * 100);
  setFormattedValue(f.elements['monthly_payment'], l.monthly_payment || '');
  f.elements['fixation_years'].value = l.fixation_years;
  f.elements['start_date'].value = l.start_date || '';
  f.elements['note'].value = l.note || '';
  setFormattedValue(f.elements['rate_after_fixation'], l.rate_after_fixation != null ? l.rate_after_fixation : '');
  setFormattedValue(f.elements['property_value_at_origination'], l.property_value_at_origination || '');
  document.getElementById('loan-form-title').textContent = 'Upravit úvěr';
}

function resetLoanForm() {
  const f = document.getElementById('loan-form');
  f.reset();
  f.elements['id'].value = '';
  document.getElementById('loan-form-title').textContent = 'Přidat úvěr';
}

async function deleteLoan(id) {
  if (!(await customConfirm('Opravdu smazat tento úvěr?', 'Smazat'))) return;
  state.loans = state.loans.filter((l) => l.id !== id);
  saveState();
  renderAll();
}

function submitLoanForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.elements['id'].value;
  const rateAfterRaw = f.elements['rate_after_fixation'].value.trim();
  const propValueRaw = f.elements['property_value_at_origination'].value.trim();
  const payload = {
    id: id || uid(),
    bank: f.elements['bank'].value.trim(),
    amount: parseFormNumber(f.elements['amount'].value),
    interest_rate: parseFormNumber(f.elements['interest_rate'].value) / 100,
    monthly_payment: parseFormNumber(f.elements['monthly_payment'].value),
    fixation_years: Number(f.elements['fixation_years'].value) || 5,
    start_date: f.elements['start_date'].value || null,
    note: f.elements['note'].value.trim() || null,
    rate_after_fixation: rateAfterRaw ? parseFormNumber(rateAfterRaw) : null,
    property_value_at_origination: propValueRaw ? parseFormNumber(propValueRaw) : null,
  };
  if (id) {
    const idx = state.loans.findIndex((l) => l.id === id);
    if (idx !== -1) state.loans[idx] = payload;
  } else {
    state.loans.push(payload);
  }
  saveState();
  resetLoanForm();
  renderAll();
  showSuccessToast(id ? 'Úvěr upraven' : 'Úvěr přidán');
}

/* ---------- NASTAVENÍ ---------- */

function renderSettings() {
  setFormattedValue(document.getElementById('inflation-input'), (state.settings.inflation_rate * 100).toFixed(2));
  setFormattedValue(document.getElementById('rental-tax-input'), state.settings.rental_tax_rate);
  setFormattedValue(document.getElementById('capgains-tax-input'), state.settings.capital_gains_tax_rate);
  document.getElementById('auto-sell-enabled-input').checked = state.settings.auto_sell_enabled !== false;
  setFormattedValue(document.getElementById('sale-trigger-input'), state.settings.sale_trigger_amount || '');
  setFormattedValue(document.getElementById('min-portfolio-input'), state.settings.min_portfolio_value || '');
  syncAutoSellOptionsVisibility();
}

function syncAutoSellOptionsVisibility() {
  const enabled = document.getElementById('auto-sell-enabled-input').checked;
  document.getElementById('auto-sell-options').classList.toggle('hidden', !enabled);
}

function wireSettingsInputs() {
  const inflationEl = document.getElementById('inflation-input');
  const rentalTaxEl = document.getElementById('rental-tax-input');
  const capGainsEl = document.getElementById('capgains-tax-input');
  const autoSellEnabledEl = document.getElementById('auto-sell-enabled-input');
  const saleTriggerEl = document.getElementById('sale-trigger-input');
  const minPortfolioEl = document.getElementById('min-portfolio-input');
  const save = () => {
    state.settings.inflation_rate = parseFormNumber(inflationEl.value) / 100;
    state.settings.rental_tax_rate = parseFormNumber(rentalTaxEl.value);
    state.settings.capital_gains_tax_rate = parseFormNumber(capGainsEl.value);
    state.settings.auto_sell_enabled = autoSellEnabledEl.checked;
    state.settings.sale_trigger_amount = parseFormNumber(saleTriggerEl.value);
    state.settings.min_portfolio_value = parseFormNumber(minPortfolioEl.value);
    saveState();
    syncAutoSellOptionsVisibility();
    renderScenario();
    renderOverview();
    renderOverviewReal();
    renderFreedom();
  };
  inflationEl.addEventListener('change', save);
  rentalTaxEl.addEventListener('change', save);
  capGainsEl.addEventListener('change', save);
  autoSellEnabledEl.addEventListener('change', save);
  saleTriggerEl.addEventListener('change', save);
  minPortfolioEl.addEventListener('change', save);
}

/* ---------- SCÉNÁŘOVÉ UDÁLOSTI (celoportfoliové) ---------- */

const EVENT_LABELS = {
  growth: 'Růst hodnoty nemovitostí',
  rent_growth: 'Růst nájmu',
  vacancy: 'Neobsazenost',
  inflation: 'Inflace',
  one_time: 'Jednorázový příjem/výdaj',
};

function updateEventValueLabel() {
  const type = document.getElementById('event-type').value;
  const isMoney = type === 'one_time';
  document.getElementById('event-value-label').textContent = isMoney ? 'Hodnota (Kč)' : 'Hodnota (%)';
  setFieldUnit(document.getElementById('event-value-input'), isMoney ? 'money' : 'percent');
}

function renderEvents() {
  const tbody = document.getElementById('events-tbody');
  tbody.innerHTML = '';
  for (const ev of state.events) {
    const period = ev.year_to && ev.year_to !== ev.year_from ? `${ev.year_from}–${ev.year_to}` : `${ev.year_from}`;
    const valueLabel = ev.type === 'one_time' ? fmtMoney(ev.value) : `${ev.value} %`;
    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-200';
    tr.innerHTML = `
      <td class="py-2 pr-3">${EVENT_LABELS[ev.type] || ev.type}</td>
      <td class="py-2 pr-3">${period}</td>
      <td class="py-2 pr-3 text-right">${valueLabel}</td>
      <td class="py-2 pr-3">${escapeHtml(ev.note || '')}</td>
      <td class="py-2 pr-3 whitespace-nowrap">
        <button class="text-blue-600 hover:underline mr-2" data-edit-event="${ev.id}">Upravit</button>
        <button class="text-red-600 hover:underline" data-delete-event="${ev.id}">Smazat</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-edit-event]').forEach((btn) =>
    btn.addEventListener('click', () => fillEventForm(btn.dataset.editEvent))
  );
  tbody.querySelectorAll('[data-delete-event]').forEach((btn) =>
    btn.addEventListener('click', () => deleteEvent(btn.dataset.deleteEvent))
  );
}

function fillEventForm(id) {
  const ev = state.events.find((x) => x.id === id);
  if (!ev) return;
  const f = document.getElementById('event-form');
  f.elements['id'].value = ev.id;
  f.elements['type'].value = ev.type;
  f.elements['year_from'].value = ev.year_from;
  f.elements['year_to'].value = ev.year_to && ev.year_to !== ev.year_from ? ev.year_to : '';
  updateEventValueLabel();
  setFormattedValue(f.elements['value'], ev.value);
  f.elements['note'].value = ev.note || '';
  document.getElementById('event-form-title').textContent = 'Upravit scénářovou událost';
}

function resetEventForm() {
  const f = document.getElementById('event-form');
  f.reset();
  f.elements['id'].value = '';
  f.elements['year_from'].value = CURRENT_YEAR;
  updateEventValueLabel();
  document.getElementById('event-form-title').textContent = 'Přidat scénářovou událost';
}

async function deleteEvent(id) {
  if (!(await customConfirm('Smazat tuto scénářovou událost?', 'Smazat'))) return;
  state.events = state.events.filter((e) => e.id !== id);
  saveState();
  renderEvents();
  renderScenario();
  renderOverview();
  renderOverviewReal();
  renderFreedom();
}

function submitEventForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.elements['id'].value;
  const yearFrom = Number(f.elements['year_from'].value);
  const yearToRaw = f.elements['year_to'].value;
  const payload = {
    id: id || uid(),
    type: f.elements['type'].value,
    year_from: yearFrom,
    year_to: yearToRaw ? Number(yearToRaw) : yearFrom,
    value: parseFormNumber(f.elements['value'].value),
    note: f.elements['note'].value.trim() || null,
  };
  if (id) {
    const idx = state.events.findIndex((ev) => ev.id === id);
    if (idx !== -1) state.events[idx] = payload;
  } else {
    state.events.push(payload);
  }
  saveState();
  resetEventForm();
  renderEvents();
  renderScenario();
  renderOverview();
  renderOverviewReal();
  renderFreedom();
  showSuccessToast(id ? 'Událost upravena' : 'Událost přidána');
}

/* ---------- SCÉNÁŘE (predikce) ---------- */

function renderScenario() {
  const horizon = state.scenario.horizonYears;
  setValueIfNotFocused(document.getElementById('scenario-horizon'), horizon);
  document.getElementById('sc-kpi-end-equity-label').textContent = `Vlastní kapitál za ${horizon} let`;
  document.getElementById('sc-kpi-end-debt-label').textContent = `Cizí kapitál za ${horizon} let`;

  const result = calc.projectPortfolio({
    properties: state.properties,
    loans: state.loans,
    settings: state.settings,
    events: state.events,
    horizonYears: horizon,
    startYear: CURRENT_YEAR,
  });

  const { rows, summary } = result;
  const first = rows[0];
  const last = rows[rows.length - 1];

  document.getElementById('sc-kpi-end-equity').textContent = fmtMoney(summary.endEquity);
  document.getElementById('sc-kpi-end-debt').textContent = fmtMoney(last.totalDebt);
  document.getElementById('sc-kpi-cagr-assets').textContent = fmtPercent(summary.cagrAssets);

  setFormula('sc-kpi-end-equity-formula', `Majetek za ${horizon} let (${fmtMoney(last.totalValue)}) − dluh za ${horizon} let (${fmtMoney(last.totalDebt)}) = ${fmtMoney(last.equity)}`);
  setFormula('sc-kpi-end-debt-formula', `Součet zbývající jistiny všech úvěrů za ${horizon} let = ${fmtMoney(last.totalDebt)}. "Cizí kapitál" = peníze v nemovitostech, které ještě nejsou tvoje - jsou zastavené bance, dokud se úvěr nesplatí.`);
  setFormula(
    'sc-kpi-cagr-assets-formula',
    `Složený průměr ročního zhodnocení nemovitostí za všech ${horizon} let (stejná sazba jako "Průměrné zhodnocení" na Přehledu, jen za celý horizont) = ${fmtPercent(summary.cagrAssets)}. Počítá se ze skutečné roční sazby zhodnocení, NE z porovnání celkové hodnoty portfolia na začátku a na konci - takže když si během horizontu koupíš další nemovitost, ten nákup se sem nepočítá jako "zhodnocení" (je to nový vklad, ne zisk).`
  );

  const chartEl = document.getElementById('scenario-chart');
  chartEl.innerHTML = buildLineChartSVG([
    { label: 'Majetek', color: '#2563eb', points: rows.map((r) => ({ x: r.year, y: r.totalValue })) },
    { label: 'Dluh', color: '#dc2626', points: rows.map((r) => ({ x: r.year, y: r.totalDebt })) },
    { label: 'Vlastní kapitál', color: '#16a34a', points: rows.map((r) => ({ x: r.year, y: r.equity })) },
  ]);

  const detailCell = (v, colorClass) =>
    `<td class="py-1.5 pr-3 text-right scenario-detail-col ${scenarioShowDetail ? '' : 'hidden'} ${colorClass || ''}">${v == null ? '—' : fmtMoney(v)}</td>`;

  const saleEventCell = (r) => {
    if (!r.soldThisYear) return '<td class="py-1.5 pr-3 text-xs text-slate-400"></td>';
    const s = r.soldThisYear;
    const taxNote = s.taxExempt ? 'bez daně - časový test splněn' : `po dani ${fmtMoney(s.estimatedSaleTax)}`;
    const growthNote = s.acquisitionPrice > 0 ? `koupeno za ${fmtMoney(s.acquisitionPrice)} → zhodnoceno na ${fmtMoney(s.marketValue)} ke dni prodeje` : `tržní cena ke dni prodeje ${fmtMoney(s.marketValue)}`;
    return `<td class="py-1.5 pr-3 text-xs">
      <span class="font-medium text-blue-700">Prodej: ${escapeHtml(s.propertyName)}</span><br>
      <span class="text-slate-500">${growthNote}, výtěžek ${fmtMoney(s.saleProceeds)} (${taxNote}) - spuštěno tím, že nastřádané zhodnocení portfolia dosáhlo ${fmtMoney(s.triggeredByGain)}, ${s.loanFullyCleared ? 'tím byl celý zbývající dluh splacen' : 'použito na částečné splacení dluhu'}</span>
    </td>`;
  };

  const tbody = document.getElementById('scenario-tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const debtService = r.totalInterest == null ? null : r.totalInterest + r.totalPrincipal;
    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-200' + (r.soldThisYear ? ' bg-blue-50' : r.depreciationExhausted ? ' bg-orange-50' : '');
    tr.innerHTML = `
      <td class="py-1.5 pr-3">${r.year}</td>
      <td class="py-1.5 pr-3 text-right">${fmtMoney(r.totalValue)}</td>
      <td class="py-1.5 pr-3 text-right">${fmtMoney(r.totalDebt)}</td>
      <td class="py-1.5 pr-3 text-right font-medium">${fmtMoney(r.equity)}</td>
      ${detailCell(r.totalRent, 'figure-positive')}
      ${detailCell(r.totalCosts, 'figure-negative')}
      ${detailCell(debtService, 'figure-negative')}
      ${detailCell(r.totalDepreciation)}
      ${detailCell(r.taxes, 'figure-negative')}
      ${detailCell(r.cumulativeGain)}
      <td class="py-1.5 pr-3 text-right font-medium ${r.cashflow == null ? '' : r.cashflow < 0 ? 'figure-negative' : 'figure-positive'}">${r.cashflow === null ? '—' : fmtMoney(r.cashflow)}</td>
      ${saleEventCell(r)}`;
    tbody.appendChild(tr);
  }
}

function wireScenarioDetailToggle() {
  const btn = document.getElementById('scenario-detail-toggle');
  btn.addEventListener('click', () => {
    scenarioShowDetail = !scenarioShowDetail;
    btn.textContent = scenarioShowDetail ? 'Skrýt detail' : 'Zobrazit detail (nájem, náklady, splátka, odpisy...)';
    document.querySelectorAll('.scenario-detail-col').forEach((el) => el.classList.toggle('hidden', !scenarioShowDetail));
  });
}

function fmtCompact(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(0) + 'k';
  return String(Math.round(n));
}

function buildLineChartSVG(seriesList, { width = 900, height = 280, padding = 46 } = {}) {
  const allPoints = seriesList.flatMap((s) => s.points);
  if (!allPoints.length) return '<p class="text-sm text-slate-400">Zatím žádná data - přidej nemovitost nebo úvěr.</p>';

  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(...ys, 1);

  const xScale = (x) => padding + ((x - minX) / (maxX - minX || 1)) * (width - 2 * padding);
  const yScale = (y) => height - padding - ((y - minY) / (maxY - minY || 1)) * (height - 2 * padding);

  let gridSvg = '';
  for (let i = 0; i <= 4; i++) {
    const y = minY + (i / 4) * (maxY - minY);
    const yy = yScale(y);
    gridSvg += `<line x1="${padding}" y1="${yy}" x2="${width - padding}" y2="${yy}" stroke="#e2e8f0" stroke-width="1" />`;
    gridSvg += `<text x="${padding - 8}" y="${yy + 4}" font-size="11" text-anchor="end" fill="#94a3b8">${fmtCompact(y)}</text>`;
  }

  let xTicksSvg = '';
  const tickCount = Math.min(maxX - minX, 10) || 1;
  for (let i = 0; i <= tickCount; i++) {
    const x = Math.round(minX + (i / tickCount) * (maxX - minX));
    xTicksSvg += `<text x="${xScale(x)}" y="${height - padding + 18}" font-size="11" text-anchor="middle" fill="#94a3b8">${x}</text>`;
  }

  const pathsSvg = seriesList
    .map((s) => {
      const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.x).toFixed(1)} ${yScale(p.y).toFixed(1)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" />`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" class="w-full h-auto">
    ${gridSvg}
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#cbd5e1" stroke-width="1" />
    ${pathsSvg}
    ${xTicksSvg}
  </svg>`;
}

/* ---------- OSVOBOZENÍ OD DLUHU ---------- */

function wireFreedomControls() {
  const horizonInput = document.getElementById('freedom-horizon');
  horizonInput.value = state.freedom.horizonYears;
  horizonInput.addEventListener('input', () => {
    state.freedom.horizonYears = Math.max(1, Number(horizonInput.value) || 1);
    saveState();
    renderFreedom();
  });
  horizonInput.addEventListener('blur', () => renderFreedom());
}

function pluralYears(n) {
  if (n === 1) return 'rok';
  if (n >= 2 && n <= 4) return 'roky';
  return 'let';
}

function renderFreedom() {
  const horizon = state.freedom.horizonYears;
  setValueIfNotFocused(document.getElementById('freedom-horizon'), horizon);

  const plan = calc.simulateDebtFreedomPlan({
    properties: state.properties,
    loans: state.loans,
    settings: state.settings,
    events: state.events,
    horizonYears: horizon,
    startYear: CURRENT_YEAR,
  });

  const banner = document.getElementById('freedom-result-banner');
  const totalDebtToday = state.loans.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const autoSellOff = state.settings.auto_sell_enabled === false;
  if (autoSellOff) {
    banner.className = 'rounded-xl border p-4 mb-6 bg-slate-50 border-slate-300';
    banner.innerHTML = `<p class="font-semibold text-slate-700">Automatický prodej nemovitostí je v Nastavení vypnutý.</p>
      <p class="text-sm text-slate-600 mt-1">Zapni ho v kartě "Automatický prodej nemovitostí" v Nastavení, pokud chceš vidět plán prodejů na umoření dluhu.</p>`;
  } else if (totalDebtToday <= 0) {
    banner.className = 'rounded-xl border p-4 mb-6 bg-emerald-50 border-emerald-300';
    banner.innerHTML = '<p class="font-semibold text-emerald-800">Portfolio už teď nemá žádný dluh.</p>';
  } else if (plan.debtFreeYear !== null) {
    const yearsToFree = plan.debtFreeYear - CURRENT_YEAR;
    const whenText = yearsToFree <= 0 ? 'hned letos' : `za ${yearsToFree} ${pluralYears(yearsToFree)}`;
    banner.className = 'rounded-xl border p-4 mb-6 bg-emerald-50 border-emerald-300';
    banner.innerHTML = `<p class="font-semibold text-emerald-800">Celé portfolio bez dluhu od roku ${plan.debtFreeYear} (${whenText}).</p>`;
  } else {
    banner.className = 'rounded-xl border p-4 mb-6 bg-amber-50 border-amber-300';
    banner.innerHTML = `<p class="font-semibold text-amber-800">V horizontu ${horizon} let se nepodaří dluh celý splatit prodejem nemovitostí ve vlastnictví - zkus delší horizont, nebo přidej další nemovitosti.</p>`;
  }

  const eventsEl = document.getElementById('freedom-events');
  if (autoSellOff) {
    eventsEl.innerHTML = '<p class="text-slate-500">Automatický prodej je vypnutý - žádné prodeje se nesimulují.</p>';
  } else if (!plan.events.length) {
    eventsEl.innerHTML = '<p class="text-slate-500">V tomhle horizontu není potřeba nic prodávat.</p>';
  } else {
    eventsEl.innerHTML = plan.events
      .map((e) => {
        const growthNote = e.acquisitionPrice > 0
          ? `Koupeno za ${fmtMoney(e.acquisitionPrice)}, do roku prodeje zhodnoceno na ${fmtMoney(e.marketValue)}.`
          : `Tržní cena ke dni prodeje ${fmtMoney(e.marketValue)}.`;
        return `
      <div class="border-l-4 border-blue-400 pl-3">
        <p class="font-medium text-slate-800">${e.year}: prodej "${escapeHtml(e.propertyName)}"</p>
        <p class="text-xs text-slate-500">
          Spuštěno tím, že zhodnocení portfolia od posledního prodeje narostlo na ${fmtMoney(e.triggeredByGain)} - dost na to, aby se prodej vyplatil.
          ${growthNote}
          Výtěžek ${fmtMoney(e.saleProceeds)}
          (${e.taxExempt ? 'bez daně z příjmu - časový test splněn' : 'po odhadované dani ' + fmtMoney(e.estimatedSaleTax)}) -
          ${e.loanFullyCleared ? 'veškerý zbývající dluh tím byl toho roku splacen.' : 'použito na částečné splacení dluhu, hotovost ' + fmtMoney(e.cashAfter) + ' zůstává na další splátky.'}
        </p>
      </div>`;
      })
      .join('');
  }

  const tbody = document.getElementById('freedom-tbody');
  tbody.innerHTML = '';
  for (const r of plan.rows) {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-200' + (r.soldThisYear ? ' bg-blue-50' : '');
    tr.innerHTML = `
      <td class="py-1.5 pr-3">${r.year}</td>
      <td class="py-1.5 pr-3 text-right ${r.totalDebt <= 0 ? 'text-emerald-600 font-medium' : ''}">${fmtMoney(r.totalDebt)}</td>
      <td class="py-1.5 pr-3 text-right">${fmtMoney(r.activeValue)}</td>
      <td class="py-1.5 pr-3 text-right">${fmtMoney(r.cash)}</td>
      <td class="py-1.5 pr-3 text-right">${fmtMoney(r.cumulativeGain)}</td>
      <td class="py-1.5 pr-3">${r.soldThisYear ? 'Prodej: ' + escapeHtml(r.soldThisYear.propertyName) : ''}</td>`;
    tbody.appendChild(tr);
  }
}

/* ---------- PŘEHLED (konkrétní rok / měsíc + doporučení) ---------- */
/* Sdílená logika i pro záložku "Přehled (reálné hodnoty)" - viz renderOverviewReal
   níže. idPrefix odlišuje DOM prvky ('' pro hlavní Přehled, 'real-' pro kopii),
   deflate přepočítá všechny Kč částky na dnešní kupní sílu peněz. */

function wireOverviewControlsGeneric(idPrefix, overviewState, onChange) {
  const yearInput = document.getElementById(idPrefix + 'overview-year');
  yearInput.value = overviewState.year;
  yearInput.addEventListener('input', () => {
    overviewState.year = Number(yearInput.value) || CURRENT_YEAR;
    saveState();
    onChange();
  });
  yearInput.addEventListener('blur', onChange);
  document.getElementById(idPrefix + 'overview-year-reset').addEventListener('click', () => {
    overviewState.year = CURRENT_YEAR;
    yearInput.value = CURRENT_YEAR;
    saveState();
    onChange();
  });
  document.getElementById(idPrefix + 'overview-period-year').addEventListener('click', () => setOverviewPeriodGeneric(idPrefix, overviewState, 'year', onChange));
  document.getElementById(idPrefix + 'overview-period-month').addEventListener('click', () => setOverviewPeriodGeneric(idPrefix, overviewState, 'month', onChange));
  setOverviewPeriodGeneric(idPrefix, overviewState, overviewState.period, onChange, true);
}

function setOverviewPeriodGeneric(idPrefix, overviewState, period, onChange, skipRender) {
  overviewState.period = period;
  document.getElementById(idPrefix + 'overview-period-year').classList.toggle('period-toggle-active', period === 'year');
  document.getElementById(idPrefix + 'overview-period-month').classList.toggle('period-toggle-active', period === 'month');
  saveState();
  if (!skipRender) onChange();
}

function wireOverviewControls() {
  wireOverviewControlsGeneric('', state.overview, renderOverview);
}

function wireOverviewRealControls() {
  wireOverviewControlsGeneric('real-', state.overviewReal, renderOverviewReal);
}

function renderOverviewGeneric(idPrefix, overviewState, deflate) {
  const selectedYear = overviewState.year || CURRENT_YEAR;
  setValueIfNotFocused(document.getElementById(idPrefix + 'overview-year'), selectedYear);

  const yearsAhead = Math.max(selectedYear - CURRENT_YEAR, 0);
  const horizon = Math.max(state.scenario.horizonYears, yearsAhead + 1);
  const result = calc.projectPortfolio({
    properties: state.properties,
    loans: state.loans,
    settings: state.settings,
    events: state.events,
    horizonYears: horizon,
    startYear: CURRENT_YEAR,
  });
  const idx = Math.min(yearsAhead, result.rows.length - 1);
  const row = result.rows[idx];
  const nextRow = result.rows[idx + 1] || row;

  const isMonth = overviewState.period === 'month';
  const div = isMonth ? 12 : 1;

  // Deflátor = kolikrát nominální Kč z vybraného roku "stojí míň" než dnešní Kč
  // kvůli inflaci mezi dneškem a tím rokem - viz cumulativeInflationFactor.
  const deflator = deflate ? calc.cumulativeInflationFactor(result.rows, idx) : 1;
  const real = (nominal) => (Number(nominal) || 0) / deflator;

  document.getElementById(idPrefix + 'kpi-assets').textContent = fmtMoney(real(row.totalValue));
  document.getElementById(idPrefix + 'kpi-debt').textContent = fmtMoney(real(row.totalDebt));
  document.getElementById(idPrefix + 'kpi-networth').textContent = fmtMoney(real(row.equity));
  document.getElementById(idPrefix + 'kpi-debtratio').textContent = row.totalValue > 0 ? fmtPercent(row.totalDebt / row.totalValue) : '0 %';
  document.getElementById(idPrefix + 'kpi-cashflow').textContent = fmtMoney(real((row.cashflow || 0) / div));
  document.getElementById(idPrefix + 'kpi-appreciation').textContent = fmtMoney(real((row.appreciationGain || 0) / div));
  document.getElementById(idPrefix + 'kpi-avg-growth').textContent = row.avgGrowthRate == null ? '—' : fmtPercent(row.avgGrowthRate);
  document.getElementById(idPrefix + 'kpi-inflation-loss').textContent = row.inflationRate == null ? '—' : fmtPercent(row.inflationRate);
  document.getElementById(idPrefix + 'kpi-inflation-loss-amount').textContent = row.inflationLoss == null ? '—' : fmtMoney(real((row.inflationLoss || 0) / div));
  document.getElementById(idPrefix + 'kpi-real-appreciation').textContent = fmtMoney(real((row.realAppreciation || 0) / div));

  document.getElementById(idPrefix + 'kpi-cashflow-label').textContent = isMonth ? 'Měsíční cashflow' : 'Roční cashflow';
  document.getElementById(idPrefix + 'kpi-appreciation-label').textContent = isMonth ? 'Měsíční zhodnocení' : 'Roční zhodnocení';
  document.getElementById(idPrefix + 'kpi-real-appreciation-label').textContent = isMonth ? 'Zbývá po inflaci (měsíc)' : 'Zbývá po inflaci (rok)';

  const realNote = deflate ? ` Přepočteno na dnešní kupní sílu (÷ ${deflator.toFixed(3)}, kumulovaná inflace od dneška do roku ${row.year}).` : '';
  setFormula(idPrefix + 'kpi-assets-formula', `Hodnota nemovitostí ve vlastnictví (${fmtMoney(real(row.realEstateValue))}) + hotovost z dřívějších prodejů (${fmtMoney(real(row.cashReserve))}) = ${fmtMoney(real(row.totalValue))}.${realNote}`);
  setFormula(idPrefix + 'kpi-debt-formula', `Součet zbývající jistiny všech úvěrů zadaných v Moje úvěry = ${fmtMoney(real(row.totalDebt))}.${realNote}`);
  setFormula(idPrefix + 'kpi-networth-formula', `Majetek (${fmtMoney(real(row.totalValue))}) − Dluh (${fmtMoney(real(row.totalDebt))}) = ${fmtMoney(real(row.equity))}.${realNote}`);
  setFormula(idPrefix + 'kpi-debtratio-formula', `Dluh (${fmtMoney(row.totalDebt)}) ÷ Majetek (${fmtMoney(row.totalValue)}) = ${row.totalValue > 0 ? fmtPercent(row.totalDebt / row.totalValue) : '0 %'}. Poměr se inflací nemění (dělí se stejným číslem nahoře i dole).`);
  if (row.totalRent != null) {
    const d = div;
    setFormula(
      idPrefix + 'kpi-cashflow-formula',
      `Nájem +${fmtMoney(real(row.totalRent / d))} − náklady ${fmtMoney(real(row.totalCosts / d))} − úrok ${fmtMoney(real(row.totalInterest / d))} − jistina ${fmtMoney(real(row.totalPrincipal / d))} − daň ${fmtMoney(real(row.taxes / d))} = ${fmtMoney(real(row.cashflow / d))}. Úrok a jistina se počítají ze skutečné splátky úvěru v Moje úvěry, ne z pole "Splátka" u nemovitosti.${realNote}`
    );
    setFormula(idPrefix + 'kpi-appreciation-formula', `Hodnota nemovitostí příští rok − hodnota dnes, součet za všechny nemovitosti podle jejich zadaného růstu = ${fmtMoney(real(row.appreciationGain / d))}.${realNote}`);
    setFormula(idPrefix + 'kpi-avg-growth-formula', `Roční zhodnocení (${fmtMoney(row.appreciationGain)}) ÷ hodnota nemovitostí (${fmtMoney(row.realEstateValue)}) = ${fmtPercent(row.avgGrowthRate)}. Vážený průměr růstu jednotlivých nemovitostí (podle jejich hodnoty), včetně případných scénářových událostí. Toto je poměr dvou nominálních čísel, inflace se v podílu vyruší.`);
    setFormula(idPrefix + 'kpi-inflation-loss-formula', `Míra inflace použitá pro přechod do roku ${nextRow.year} (ze Scénářů/Nastavení, případně přepsaná scénářovou událostí) = ${fmtPercent(row.inflationRate)}. Snižuje hodnotu nemovitostí o ${fmtMoney(real(row.inflationLoss / d))} ${isMonth ? 'měsíčně' : 'ročně'}.${realNote}`);
    setFormula(idPrefix + 'kpi-real-appreciation-formula', `Roční zhodnocení (${fmtMoney(real(row.appreciationGain / d))}) − ztráta inflací (${fmtMoney(real(row.inflationLoss / d))}) = ${fmtMoney(real(row.realAppreciation / d))}.${realNote}`);
  }

  const cashflowEl = document.getElementById(idPrefix + 'kpi-cashflow');
  cashflowEl.classList.toggle('text-red-600', (row.cashflow || 0) < 0);
  cashflowEl.classList.toggle('text-emerald-600', (row.cashflow || 0) >= 0);
  const realAppEl = document.getElementById(idPrefix + 'kpi-real-appreciation');
  realAppEl.classList.toggle('text-red-600', (row.realAppreciation || 0) < 0);
  realAppEl.classList.toggle('text-emerald-600', (row.realAppreciation || 0) >= 0);

  if (!deflate) renderRecommendation();
}

function renderOverview() {
  renderOverviewGeneric('', state.overview, false);
}

function renderOverviewReal() {
  renderOverviewGeneric('real-', state.overviewReal, true);
}

function renderRecommendation() {
  const rec = calc.recommendActions(state.properties, state.loans, state.settings, new Date());
  const el = document.getElementById('recommendation-content');
  if (!rec) {
    el.innerHTML = '<p>Zatím nemáš dost dat (přidej nemovitosti a úvěry) pro doporučení.</p>';
    return;
  }
  let html = '';
  if (rec.bestProperty) {
    const bp = rec.bestProperty;
    html += `<div>
      <p class="font-medium text-slate-800">Nejvhodnější k prodeji: ${escapeHtml(bp.property.name)}</p>
      <p class="text-xs text-slate-500">Zhodnocení ${fmtPercent(bp.gainPct)} (${fmtMoney(bp.gain)}), časový test už splněn — prodej by byl bez daně z příjmu, provozní výnos ${fmtPercent(bp.yieldPct)} ročně z tržní hodnoty.</p>
    </div>`;
  } else if (rec.hasProperties) {
    html += `<div>
      <p class="font-medium text-slate-800">Zatím žádná nemovitost nesplňuje časový test</p>
      <p class="text-xs text-slate-500">Doporučení k prodeji se ukáže, až u některé nemovitosti uplyne časový test (5 nebo 10 let od pořízení) - do té doby by prodej navíc podléhal dani z příjmu.</p>
    </div>`;
  }
  if (rec.worstLoan) {
    const wl = rec.worstLoan;
    html += `<div>
      <p class="font-medium text-slate-800">Nejnevýhodnější úvěr ke splacení: ${escapeHtml(wl.loan.bank)}</p>
      <p class="text-xs text-slate-500">Úrok ${fmtPercent(wl.rate)} - nejvyšší ze všech úvěrů, zbývající jistina ${fmtMoney(wl.loan.amount)}.</p>
    </div>`;
  }
  el.innerHTML = html || '<p>Zatím nemáš dost dat pro doporučení.</p>';
}

/* ---------- Záloha (export / import / smazání) ---------- */

function wireBackup() {
  document.getElementById('btn-export').addEventListener('click', exportBackup);
  document.getElementById('import-file').addEventListener('change', importBackup);
  document.getElementById('btn-clear').addEventListener('click', clearAllData);
  document.getElementById('btn-delete-cloud').addEventListener('click', confirmAndDeleteCloudData);
}

function exportBackup() {
  const payload = { ...stateSnapshot(), exported_at: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `investix-zaloha-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!(await customConfirm('Nahrání zálohy přepíše aktuální data v tomto prohlížeči. Pokračovat?', 'Nahrát a přepsat'))) return;
      state.properties = Array.isArray(parsed.properties) ? parsed.properties : [];
      state.loans = Array.isArray(parsed.loans) ? parsed.loans : [];
      state.events = Array.isArray(parsed.events) ? parsed.events : [];
      const defaultSettings = { inflation_rate: 0.03, rental_tax_rate: 15, capital_gains_tax_rate: 15, min_portfolio_value: 0, auto_sell_enabled: true, sale_trigger_amount: 0 };
      state.settings = parsed.settings && typeof parsed.settings.inflation_rate === 'number'
        ? { ...defaultSettings, ...parsed.settings }
        : { ...defaultSettings };
      state.scenario = parsed.scenario && typeof parsed.scenario.horizonYears === 'number'
        ? parsed.scenario
        : { horizonYears: 20 };
      state.overview = parsed.overview && typeof parsed.overview.year === 'number'
        ? parsed.overview
        : { year: CURRENT_YEAR, period: 'year' };
      state.overviewReal = parsed.overviewReal && typeof parsed.overviewReal.year === 'number'
        ? parsed.overviewReal
        : { year: CURRENT_YEAR, period: 'year' };
      state.freedom = parsed.freedom && typeof parsed.freedom.horizonYears === 'number'
        ? parsed.freedom
        : { horizonYears: 10 };
      saveState();
      renderAll();
      alert('Záloha byla úspěšně nahrána.');
    } catch (err) {
      alert('Soubor se nepodařilo přečíst - není to platná záloha.');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
}

async function clearAllData() {
  const confirmed = await confirmTwice(
    'Opravdu smazat všechna data v tomto prohlížeči? Tuto akci nelze vrátit zpět.',
    'Fakt si tím jistý/á? Všechny nemovitosti, úvěry i nastavení v tomto prohlížeči zmizí a nedají se obnovit (pokud si je předtím nezálohuješ).',
    'Smazat'
  );
  if (!confirmed) return;
  state.properties = [];
  state.loans = [];
  state.events = [];
  state.settings = { inflation_rate: 0.03, rental_tax_rate: 15, capital_gains_tax_rate: 15, min_portfolio_value: 0, auto_sell_enabled: true, sale_trigger_amount: 0 };
  state.scenario = { horizonYears: 20 };
  state.overview = { year: CURRENT_YEAR, period: 'year' };
  state.overviewReal = { year: CURRENT_YEAR, period: 'year' };
  state.freedom = { horizonYears: 10 };
  saveState();
  renderAll();
}

async function confirmAndDeleteCloudData() {
  const confirmed = await confirmTwice(
    'Opravdu smazat zálohu dat uloženou v cloudu? Lokální data v tomto prohlížeči zůstanou beze změny. Tuto akci nelze vrátit zpět.',
    'Fakt si tím jistý/á? Cloudová záloha se nedá obnovit a budeš odhlášen(a).',
    'Smazat zálohu'
  );
  if (!confirmed) return;
  await deleteCloudData();
}

/* ---------- Vzorce na kartách (klikni pro rozkliknutí) ---------- */

function setFormula(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function wireKpiFormulaToggles() {
  document.querySelectorAll('.kpi-clickable').forEach((card) => {
    card.addEventListener('click', () => {
      const formulaEl = card.querySelector('.kpi-formula');
      if (formulaEl) formulaEl.classList.toggle('hidden');
    });
  });
}

/**
 * "Stáhnout PDF" = nativní tisk prohlížeče (Uložit jako PDF v tiskovém
 * dialogu) - žádná externí knihovna, žádné generování na serveru. CSS
 * @media print (viz style.css) schová vše kromě obsahu aktuálně otevřené
 * záložky. Název dokumentu na chvíli změníme, ať prohlížeč nabídne
 * rozumný výchozí název souboru.
 *
 * ZÁMĚRNĚ JEN NA POČÍTAČI. Mobilní tisk/PDF se ukázal být přes CSS i přes
 * dočasnou změnu viewportu nespolehlivý napříč prohlížeči (různě rozbité
 * zarovnání, na Chromu na Androidu se stránka dokonce zaseknout) - tlačítka
 * jsou proto v HTML schovaná pod `md:` (viz index.html, `hidden md:inline-flex`)
 * a tahle kontrola je jen druhá pojistka pro případ, že by je zprostředkovaně
 * spustilo něco jiného.
 */
function wirePdfExportButtons() {
  document.querySelectorAll('.btn-pdf-export').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!window.matchMedia('(min-width: 768px)').matches) return;
      const originalTitle = document.title;
      document.title = `Investix - ${btn.dataset.pdfTitle || 'export'}`;
      const restoreTitle = () => {
        document.title = originalTitle;
        window.removeEventListener('afterprint', restoreTitle);
      };
      window.addEventListener('afterprint', restoreTitle);
      window.print();
    });
  });
}

/* ---------- Pomocné ---------- */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function wireForms() {
  const forms = [
    ['property-form', submitPropertyForm],
    ['loan-form', submitLoanForm],
    ['event-form', submitEventForm],
  ];
  for (const [id, handler] of forms) {
    const form = document.getElementById(id);
    form.addEventListener('submit', handler);
    preventEnterSubmit(form);
  }
  document.getElementById('property-form-reset').addEventListener('click', resetPropertyForm);
  document.getElementById('loan-form-reset').addEventListener('click', resetLoanForm);
  document.getElementById('event-form-reset').addEventListener('click', resetEventForm);
}

document.addEventListener('DOMContentLoaded', init);
