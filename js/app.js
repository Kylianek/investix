/* Hlavní logika aplikace. Přihlášený uživatel má data v databázi (viz js/cloud.js), nepřihlášenému
   se data nikam neukládají - drží se jen v sessionStorage (přežije obnovení stránky, po zavření
   záložky zmizí). Výpočty jsou v js/calc.js. */

// Klíč pracovní kopie v sessionStorage. Pod stejným názvem dřív appka ukládala data natrvalo do
// localStorage - ten starý záznam se jen jednou načte a smaže se, až jsou data bezpečně v účtu.
const STORAGE_KEY = 'investicni-kalkulacka-v1';
const THEME_KEY = 'investix-theme';
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

const DEFAULT_SETTINGS = {
  inflation_rate: 0.03,
  default_rent_growth: null,
  capital_gains_tax_rate: 15,
  po_tax_rate: 21,
  min_portfolio_value: 0,
  auto_sell_enabled: true,
  po_sell_asap: true,
  sale_trigger_amount: 0,
  pledge_financing_enabled: false,
  pledge_max_ltv: 80,
};

function defaultState() {
  return {
    properties: [],
    loans: [],
    events: [],
    settings: { ...DEFAULT_SETTINGS },
    scenario: { horizonYears: 20 },
    overview: { year: CURRENT_YEAR, period: 'year' },
  };
}

const state = defaultState();

function replaceContents(target, source) {
  Object.keys(target).forEach((key) => delete target[key]);
  Object.assign(target, source);
}

/**
 * Nahradí celý stav (záloha, smazání, odhlášení) - objekty settings/scenario/overview... se mění
 * NA MÍSTĚ, protože ovládací prvky (např. rok v Přehledu) si drží odkaz na ně. Kdyby se místo
 * toho přiřadil nový objekt, prvky by dál upravovaly ten starý a změna roku by se neprojevila.
 */
function setState(next) {
  const fallback = defaultState();
  state.properties = Array.isArray(next.properties) ? next.properties : fallback.properties;
  state.loans = Array.isArray(next.loans) ? next.loans : fallback.loans;
  state.events = Array.isArray(next.events) ? next.events : fallback.events;
  const validSettings = next.settings && typeof next.settings.inflation_rate === 'number';
  replaceContents(state.settings, { ...DEFAULT_SETTINGS, ...(validSettings ? next.settings : {}) });
  const pick = (value, key, fallbackValue) => (value && typeof value[key] === 'number' ? value : fallbackValue);
  replaceContents(state.scenario, pick(next.scenario, 'horizonYears', fallback.scenario));
  replaceContents(state.overview, pick(next.overview, 'year', fallback.overview));
  normalizeStateData();
}

// Rozbalené roky ve Scénářích (jen pro zobrazení, neukládá se)
const expandedYears = new Set();
// Tabulky: rozšíření sloupců (klíč tabulky -> true/false; nenastaveno = podle šířky obrazovky) a rozbalené kalendáře úvěrů
const tableExpandedState = {};
let printingNow = false;
const expandedLoans = new Set();

// Nedělitelná mezera mezi skupinami číslic i před jednotkou - číslo se
// svojí příponou (Kč/%) se tak nikdy nezalomí na dva řádky uprostřed buňky.
const fmtMoney = (n) =>
  (Number(n) || 0).toLocaleString('cs-CZ', { maximumFractionDigits: 0 }).replace(/\s/g, ' ') + ' Kč';
const fmtPercent = (n) =>
  ((Number(n) || 0) * 100).toLocaleString('cs-CZ', { maximumFractionDigits: 2 }).replace(/\s/g, ' ') + ' %';
const fmtNumber = (n, digits = 2) =>
  (Number(n) || 0).toLocaleString('cs-CZ', { maximumFractionDigits: digits }).replace(/\s/g, ' ');
const fmtDate = (str) => {
  if (!str) return '';
  const d = calc.toDate(str);
  return isNaN(d) ? '' : d.toLocaleDateString('cs-CZ').replace(/\s/g, ' ');
};

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/* ---------- Formátovaná pole (Kč / % / p. b.) - živé zarovnávání tisíců + jednotka ---------- */

const UNIT_SUFFIX = { money: 'Kč', percent: '%', pp: 'p. b.' };

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
    const formatted = kind === 'money' ? formatGroupedInteger(el.value) : formatDecimalValue(el.value);
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
  el.setAttribute('inputmode', kind === 'money' ? 'numeric' : 'decimal');
  const suffixEl = el.parentElement.querySelector('.input-suffix');
  if (suffixEl) suffixEl.textContent = UNIT_SUFFIX[kind] || '';
  el.dispatchEvent(new Event('input'));
}

function wireFormattedInputs() {
  document.querySelectorAll('[data-unit]').forEach((el) => enhanceUnitInput(el));
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
 * Pro nevratné mazání dat se ptá DVAKRÁT po sobě - první
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
 * každém stisku klávesy (nešlo by pole smazat/přepsat).
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

/** Po kliknutí na "Upravit" posune stránku k formuláři nahoře a krátce ho zvýrazní. */
function revealForm(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // když prohlížeč plynulé posouvání nespustí (vypnuté animace v systému), skočí se k formuláři rovnou
  setTimeout(() => {
    if (Math.abs(card.getBoundingClientRect().top) > 160) card.scrollIntoView({ block: 'start' });
  }, 900);
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
  setTimeout(() => {
    const first = card.querySelector('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), select');
    if (first) first.focus({ preventScroll: true });
  }, 400);
}

/* ---------- Motiv (světlý / tmavý / barevný) ---------- */

const THEMES = ['light', 'dark', 'color'];
const THEME_LABELS = { light: 'Světlý', dark: 'Tmavý', color: 'Barevný' };
const THEME_ICONS = {
  light:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  dark: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  color:
    '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 3-4 3h-2a2 2 0 0 0-1.4 3.4c.6.7.4 3.6-2.6 3.6z"/>',
};

function currentTheme() {
  const theme = document.documentElement.getAttribute('data-theme');
  return THEMES.includes(theme) ? theme : 'light';
}

function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'light';
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (e) {
    /* soukromé okno / zablokované úložiště - motiv se jen nezapamatuje */
  }
  const icon = document.getElementById('theme-icon');
  if (icon) icon.innerHTML = THEME_ICONS[theme];
  const button = document.getElementById('btn-theme');
  if (button) {
    button.title = `Vzhled: ${THEME_LABELS[theme]}`;
    button.setAttribute('aria-label', button.title);
  }
  document.querySelectorAll('input[name="theme"]').forEach((radio) => {
    radio.checked = radio.value === theme;
  });
}

function wireTheme() {
  applyTheme(currentTheme());
  document.getElementById('btn-theme').addEventListener('click', () => {
    applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]);
  });
  document.querySelectorAll('input[name="theme"]').forEach((radio) => {
    radio.addEventListener('change', () => radio.checked && applyTheme(radio.value));
  });
}

/** Vlna po kliknutí na tlačítka - drobnost, díky které appka působí živěji. */
function wireRipples() {
  const selector = '.btn-primary, .btn-secondary, .btn-danger, .btn-ghost, .btn-icon, .seg > button, .seg > label, .scenario-chip';
  document.addEventListener('pointerdown', (e) => {
    const target = e.target.closest ? e.target.closest(selector) : null;
    if (!target || target.disabled) return;
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = e.clientX - rect.left - size / 2 + 'px';
    ripple.style.top = e.clientY - rect.top - size / 2 + 'px';
    if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
    target.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
}

/* ---------- Vlastní výběr banky (combobox) ---------- */

const BANK_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2', '#b45309', '#4f46e5'];

function bankColor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return BANK_COLORS[hash % BANK_COLORS.length];
}

/** Nabídka bank: číselník + banky, které už v datech jsou (úvěry, zástavy). */
function bankOptions() {
  const seen = new Set();
  const out = [];
  const add = (name) => {
    const trimmed = (name || '').trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) return;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  };
  CZ_BANKS.forEach(add);
  state.loans.forEach((l) => add(l.bank));
  state.properties.forEach((p) => add(p.lien_bank));
  return out;
}

function makeCombobox(input, getOptions) {
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'combo-caret';
  caret.tabIndex = -1;
  caret.setAttribute('aria-label', 'Zobrazit seznam');
  caret.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  wrap.appendChild(caret);

  const list = document.createElement('div');
  list.className = 'combo-list hidden';
  list.setAttribute('role', 'listbox');
  wrap.appendChild(list);

  let items = [];
  let active = -1;
  let typed = false;

  function build() {
    const all = getOptions();
    const query = typed ? input.value.trim().toLowerCase() : '';
    items = query ? all.filter((o) => o.toLowerCase().includes(query)) : all;
    const current = input.value.trim().toLowerCase();
    let html = items
      .map(
        (o, i) => `<div class="combo-item${i === active ? ' is-active' : ''}${o.toLowerCase() === current ? ' is-selected' : ''}" role="option" data-i="${i}">
          <span class="combo-avatar" style="background:${bankColor(o)}">${escapeHtml(o.charAt(0).toUpperCase())}</span><span>${escapeHtml(o)}</span></div>`
      )
      .join('');
    if (typed && query && !all.some((o) => o.toLowerCase() === query)) {
      html += `<div class="combo-hint">Vlastní: „${escapeHtml(input.value.trim())}“</div>`;
    }
    list.innerHTML = html || '<div class="combo-hint">Nic k výběru</div>';
  }

  function open() {
    build();
    list.classList.remove('hidden');
    wrap.classList.add('is-open');
  }
  function close() {
    list.classList.add('hidden');
    wrap.classList.remove('is-open');
    active = -1;
    typed = false;
  }
  function choose(value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  }
  function setActive(index) {
    if (!items.length) return;
    active = (index + items.length) % items.length;
    build();
    const el = list.querySelector('.is-active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  if (input.form) input.form.addEventListener('reset', close);
  input.addEventListener('focus', () => {
    typed = false;
    open();
  });
  input.addEventListener('input', () => {
    typed = true;
    active = -1;
    open();
  });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    const isOpen = !list.classList.contains('hidden');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) open();
      else setActive(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (isOpen) setActive(active - 1);
    } else if (e.key === 'Enter' && isOpen && active >= 0) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape' && isOpen) {
      e.stopPropagation();
      close();
    }
  });
  list.addEventListener('mousedown', (e) => {
    e.preventDefault(); // pole si nechá focus, ať nezavře seznam dřív než se vybere
    const item = e.target.closest('.combo-item');
    if (item) choose(items[Number(item.dataset.i)]);
  });
  caret.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (list.classList.contains('hidden')) {
      input.focus();
      typed = false;
      open();
    } else {
      close();
    }
  });
}

/* ---------- Perzistence ---------- */

function applyStateFromObject(parsed) {
  if (!parsed) return;
  if (Array.isArray(parsed.properties)) state.properties = parsed.properties;
  if (Array.isArray(parsed.loans)) state.loans = parsed.loans;
  if (Array.isArray(parsed.events)) state.events = parsed.events;
  if (parsed.settings) Object.assign(state.settings, parsed.settings);
  if (parsed.scenario) Object.assign(state.scenario, parsed.scenario);
  if (parsed.overview) Object.assign(state.overview, parsed.overview);
  normalizeStateData();
}

function loadState() {
  try {
    const session = sessionStorage.getItem(STORAGE_KEY);
    if (session) {
      applyStateFromObject(JSON.parse(session));
      return;
    }
    // Starší verze appky ukládala data natrvalo do localStorage - jednou se načtou, ale záznam se
    // nemaže, dokud se data nenahrají do účtu (clearLegacyLocalCopy), ať se nic neztratí.
    const legacy = localStorage.getItem(STORAGE_KEY);
    if (legacy) {
      applyStateFromObject(JSON.parse(legacy));
      sessionStorage.setItem(STORAGE_KEY, legacy);
    }
  } catch (e) {
    console.error('Nepodařilo se načíst uložená data:', e);
  }
}

function clearLegacyLocalCopy() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('Starý záznam se nepodařilo smazat:', e);
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
  };
}

function persistWorkingCopy() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stateSnapshot()));
  } catch (e) {
    console.warn('Pracovní kopii dat se nepodařilo uložit:', e);
  }
}

function saveState() {
  persistWorkingCopy();
  if (window.cloudSync) window.cloudSync.schedulePush();
  refreshSessionNotice();
}

/* ---------- Přihlášený / nepřihlášený uživatel ---------- */

// Plní ho js/auth.js. ready = Clerk se načetl (nebo selhal), signedIn = někdo je přihlášený.
window.authState = { ready: false, signedIn: false };
// Příznaky, kdy se NEMÁ ukazovat "opravdu chceš odejít?" (vědomé odhlášení, přihlašovací okno).
window.leaveGuard = { signingOut: false, authModalOpen: false };

function hasAnyData() {
  return state.properties.length + state.loans.length + state.events.length > 0;
}

// Stav ukládání do cloudu je vidět jako barevná tečka v hlavičce (text je v jejím popisku).
function setStorageNote(text, tone) {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  dot.dataset.tone = tone || 'neutral';
  dot.title = text;
  dot.setAttribute('aria-label', text);
  dot.classList.toggle('hidden', !window.authState.signedIn);
}

// Pruh "nejsi přihlášen(a)" - ukáže se, jen když by se přišlo o nějaká data.
function refreshSessionNotice() {
  const notice = document.getElementById('session-notice');
  if (!notice) return;
  notice.classList.toggle('hidden', !(window.authState.ready && !window.authState.signedIn && hasAnyData()));
}

function setSyncOverlay(visible) {
  const overlay = document.getElementById('sync-overlay');
  if (overlay) overlay.classList.toggle('hidden', !visible);
}

// Po odhlášení v prohlížeči nezůstane nic (ani pracovní kopie) - bez uložení, ať se nic nepošle do cloudu.
function wipeWorkingCopy() {
  setState(defaultState());
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('Pracovní kopii se nepodařilo smazat:', e);
  }
  renderAll();
  refreshSessionNotice();
}

// Při zavírání/obnovení stránky prohlížeč zobrazí vlastní upozornění (text si volit nelze), když by
// se přišlo o data: bez přihlášení kdykoli, po přihlášení jen s ještě neuloženou změnou.
function wireLeaveGuard() {
  window.addEventListener('beforeunload', (e) => {
    if (window.leaveGuard.signingOut || window.leaveGuard.authModalOpen) return;
    const unsaved = window.authState.signedIn
      ? !!(window.cloudSync && window.cloudSync.hasUnsavedChanges())
      : hasAnyData();
    if (!unsaved) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

/** Částka krátce (mil./tis.) - pro kompaktní tabulky na úzkých obrazovkách. */
function fmtShort(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const nbsp = (s) => s.replace(/\s/g, ' ');
  if (abs >= 1e6) return sign + nbsp((abs / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })) + ' mil.';
  if (abs >= 1e3) return sign + nbsp(Math.round(abs / 1e3).toLocaleString('cs-CZ')) + ' tis.';
  return sign + Math.round(abs);
}

/** Částka v tabulce: plná (rozšířená tabulka) i krátká (kompaktní) - přepíná se třídou karty. */
function moneyHtml(n) {
  return `<span class="m-full">${fmtMoney(n)}</span><span class="m-short">${fmtShort(n)}</span>`;
}

/** Přidá poli s jednotkou (Kč / % / p. b.) živé formátování a příponu; použitelné i pro dynamicky vytvořená pole. */
function enhanceUnitInput(el, kind) {
  kind = kind || el.dataset.unit;
  if (!el.parentElement.classList.contains('input-suffix-wrap')) {
    el.setAttribute('type', 'text');
    el.setAttribute('autocomplete', 'off');
    const wrap = document.createElement('div');
    wrap.className = 'input-suffix-wrap';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
    const suffix = document.createElement('span');
    suffix.className = 'input-suffix';
    wrap.appendChild(suffix);
  }
  el.dataset.unit = kind;
  el.setAttribute('inputmode', kind === 'money' ? 'numeric' : 'decimal');
  el.parentElement.querySelector('.input-suffix').textContent = UNIT_SUFFIX[kind] || '';
  if (el._formatHandler) el.removeEventListener('input', el._formatHandler);
  el._formatHandler = formatInputHandler(kind);
  el.addEventListener('input', el._formatHandler);
}

/** Datumová pole bez nápovědy "dd.mm.rrrr": textové pole (píše se např. 1. 2. 2023) + tlačítko s kalendářem. */
function wireDateFields() {
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const parseTyped = (raw) => {
    const t = raw.trim();
    if (!t) return '';
    let y;
    let mo;
    let d;
    let m = /^(\d{1,2})\s*[.\-/ ]\s*(\d{1,2})\s*[.\-/ ]\s*(\d{4})$/.exec(t);
    if (m) {
      d = Number(m[1]);
      mo = Number(m[2]);
      y = Number(m[3]);
    } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) {
      y = Number(m[1]);
      mo = Number(m[2]);
      d = Number(m[3]);
    } else return null;
    const date = new Date(y, mo - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  document.querySelectorAll('input[type="date"]').forEach((native) => {
    if (native.closest('.date-field')) return;
    const wrap = document.createElement('div');
    wrap.className = 'date-field';
    native.parentNode.insertBefore(wrap, native);
    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'input';
    text.autocomplete = 'off';
    text.setAttribute('inputmode', 'numeric');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'date-btn';
    button.tabIndex = -1;
    button.setAttribute('aria-label', 'Vybrat datum');
    button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>';
    wrap.append(text, button, native);
    native.classList.add('date-native');
    native.tabIndex = -1;
    native.setAttribute('aria-hidden', 'true');

    const sync = () => {
      const iso = valueDesc.get.call(native);
      text.value = iso ? fmtDate(iso) : '';
      text.classList.remove('is-invalid');
    };
    // programové nastavení hodnoty (vyplnění formuláře, dopočty) se hned propíše i do textu
    Object.defineProperty(native, 'value', {
      configurable: true,
      get() {
        return valueDesc.get.call(this);
      },
      set(v) {
        valueDesc.set.call(this, v);
        sync();
      },
    });
    native.addEventListener('change', sync);
    const commit = () => {
      const iso = parseTyped(text.value);
      if (iso === null) {
        text.classList.add('is-invalid');
        return;
      }
      if (iso !== valueDesc.get.call(native)) {
        valueDesc.set.call(native, iso);
        native.dispatchEvent(new Event('input', { bubbles: true }));
        native.dispatchEvent(new Event('change', { bubbles: true }));
      }
      sync();
    };
    text.addEventListener('change', commit);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
    });
    button.addEventListener('click', () => {
      if (typeof native.showPicker === 'function') {
        try {
          native.showPicker();
          return;
        } catch (err) {
          /* prohlížeč výběr nepovolil - zkusí se klasicky */
        }
      }
      native.focus();
      native.click();
    });
    if (native.form) native.form.addEventListener('reset', () => setTimeout(sync, 0));
    sync();
  });
}

/* ---------- Tabulky: hlavní sloupce / rozšíření ---------- */

/** Je tabulka rozšířená (všechny sloupce, plné částky)? Bez volby uživatele podle šířky obrazovky; v tisku vždy. */
function isExpanded(key) {
  if (printingNow) return true;
  if (key in tableExpandedState) return tableExpandedState[key];
  return window.matchMedia('(min-width: 768px)').matches;
}

function visibleColumns(columns, key) {
  const expanded = isExpanded(key);
  return columns.filter((c) => expanded || !c.x);
}

function headHtml(cols) {
  return `<tr>${cols.map((c) => `<th class="${c.right ? 'text-right' : ''}">${c.label || ''}</th>`).join('')}</tr>`;
}

/** Nastaví kartě tabulky třídu (kompaktní / rozšířená) a popisek tlačítka. */
function applyTableMode(key) {
  const card = document.querySelector(`[data-table-card="${key}"]`);
  if (!card) return;
  const expanded = isExpanded(key);
  card.classList.toggle('is-expanded', expanded);
  card.classList.toggle('is-compact', !expanded);
  const button = card.querySelector('[data-table-toggle]');
  if (button) {
    button.querySelector('.tbl-toggle-label').textContent = expanded ? 'Méně sloupců' : 'Více sloupců';
    button.setAttribute('aria-pressed', String(expanded));
  }
}

function rerenderTable(key) {
  const renderers = { properties: renderPropertiesTable, loans: renderLoansTable, scenario: renderScenarioTable, events: renderEvents };
  if (renderers[key]) renderers[key]();
}

function renderAllTables() {
  renderPropertiesTable();
  renderLoansTable();
  renderEvents();
  renderScenarioTable();
}

function wireTableToggles() {
  document.querySelectorAll('[data-table-toggle]').forEach((button) =>
    button.addEventListener('click', () => {
      const key = button.dataset.tableToggle;
      tableExpandedState[key] = !isExpanded(key);
      rerenderTable(key);
    })
  );
  window.matchMedia('(min-width: 768px)').addEventListener('change', renderAllTables);
  // PDF/tisk vždy se všemi sloupci
  window.addEventListener('beforeprint', () => {
    printingNow = true;
    renderAllTables();
  });
  window.addEventListener('afterprint', () => {
    printingNow = false;
    renderAllTables();
  });
}

/** Tlačítka Upravit / Smazat v řádku tabulky (v kompaktní tabulce jen ikony). */
function actionButtons(editAttr, deleteAttr, id) {
  const edit =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  const del =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
  return (
    `<button type="button" class="link-btn link-edit" ${editAttr}="${id}" title="Upravit" aria-label="Upravit">${edit}<span class="lbl">Upravit</span></button>` +
    (deleteAttr ? `<button type="button" class="link-btn link-delete" ${deleteAttr}="${id}" title="Smazat" aria-label="Smazat">${del}<span class="lbl">Smazat</span></button>` : '')
  );
}

/* ---------- Normalizace dat (starší záznamy) ---------- */

/**
 * Starší úvěr měl u zástavy jen seznam nemovitostí (additional_collateral_ids). Teď má u každé
 * částku (loan.collateral = [{ property_id, amount }]): u starých záznamů se převezme tehdy volná
 * hodnota nemovitosti, takže se jejich dosavadní výpočty nemění.
 */
function normalizeLoanList(loans, properties) {
  const alloc = {};
  const byId = new Map(properties.map((p) => [p.id, p]));
  return loans.map((l) => {
    if (Array.isArray(l.collateral) && !('additional_collateral_ids' in l)) {
      for (const c of l.collateral) alloc[c.property_id] = (alloc[c.property_id] || 0) + (Number(c.amount) || 0);
      return l;
    }
    const copy = { ...l };
    if (!Array.isArray(copy.collateral)) {
      const ids = Array.isArray(copy.additional_collateral_ids) ? copy.additional_collateral_ids : [];
      copy.collateral = ids
        .filter((id) => byId.has(id))
        .map((id) => {
          const p = byId.get(id);
          const free = Math.max(0, (Number(p.market_value) || 0) - calc.ownLienValue(p) - (alloc[id] || 0));
          alloc[id] = (alloc[id] || 0) + free;
          return { property_id: id, amount: Math.round(free) };
        });
    } else {
      for (const c of copy.collateral) alloc[c.property_id] = (alloc[c.property_id] || 0) + (Number(c.amount) || 0);
    }
    delete copy.additional_collateral_ids;
    return copy;
  });
}

function normalizeStateData() {
  state.loans = normalizeLoanList(state.loans, state.properties);
}

/** Podoba dat bez ohledu na verzi záznamu (porovnání s cloudem). */
function normalizeSnapshot(snapshot) {
  const copy = JSON.parse(JSON.stringify(snapshot || {}));
  copy.loans = normalizeLoanList(Array.isArray(copy.loans) ? copy.loans : [], Array.isArray(copy.properties) ? copy.properties : []);
  return copy;
}

/** Údaje o úvěrech pro výpočty v tabulkách (splátka, podíl úvěru na nemovitostech). */
function loanInfos() {
  return state.loans.map((loan) => ({
    loan,
    shares: calc.loanPropertyShares(loan, state.properties),
    terms: calc.loanTerms(loan, CURRENT_YEAR),
  }));
}

/** Dluh a splátka nemovitosti z úvěrů, které se k ní vážou. known=false, pokud se vazbu nedá zjistit. */
function propertyLoanFigures(p, infos) {
  const attributed = infos.filter((i) => (i.shares[p.id] || 0) > 0);
  const known = attributed.length > 0 || infos.every((i) => Object.keys(i.shares).length > 0);
  if (!known) return { known: false, debt: 0, payment: 0 };
  return {
    known: true,
    debt: attributed.reduce((s, i) => s + (Number(i.loan.amount) || 0) * i.shares[p.id], 0),
    payment: attributed.reduce((s, i) => s + i.terms.payment * i.shares[p.id], 0),
  };
}

function renderPropertiesTable() {
  const key = 'properties';
  applyTableMode(key);
  const infos = loanInfos();
  const totals = { rent: 0, payment: 0, debt: 0, value: 0, lien: 0, freed: 0, appreciated: 0, growthWeighted: 0 };

  const rows = state.properties.map((p) => {
    const marketValue = Number(p.market_value) || 0;
    const own = calc.ownLienValue(p);
    const cross = [];
    for (const l of state.loans) {
      const amount = calc.loanCollateral(l).filter((c) => c.property_id === p.id).reduce((s, c) => s + c.amount, 0);
      if (amount > 0) cross.push({ bank: l.bank, amount });
    }
    const crossSum = cross.reduce((s, c) => s + c.amount, 0);
    const r = {
      p,
      marketValue,
      own,
      cross,
      crossSum,
      freed: calc.freePledgeValue(p, state.loans),
      av: calc.appreciatedValue(marketValue, Number(p.growth_rate)),
      tt: calc.timeTestInfo(p),
      figs: propertyLoanFigures(p, infos),
    };
    totals.rent += Number(p.rent) || 0;
    totals.value += marketValue;
    totals.lien += own + crossSum;
    totals.freed += r.freed;
    totals.appreciated += r.av;
    totals.growthWeighted += marketValue * (Number(p.growth_rate) || 0);
    if (r.figs.known) {
      totals.payment += r.figs.payment;
      totals.debt += r.figs.debt;
    }
    return r;
  });
  const avgGrowth = totals.value > 0 ? totals.growthWeighted / totals.value : 0;
  const dash = '<span class="t-faint">—</span>';

  const columns = [
    { label: 'Nemovitost', cell: (r) => `<span class="font-medium">${escapeHtml(r.p.name)}</span> ${ownerBadge(r.p)}`, total: () => 'Celkem' },
    { label: 'Nájem', right: true, cell: (r) => (r.p.rent ? `<span class="rent-positive num">+${moneyHtml(r.p.rent)}</span>` : dash), total: () => moneyHtml(totals.rent) },
    { label: 'Tržní hodnota', right: true, cell: (r) => `<span class="num">${moneyHtml(r.marketValue)}</span>`, total: () => moneyHtml(totals.value) },
    {
      label: 'Splátka',
      right: true,
      x: true,
      cell: (r) => (r.figs.known && r.figs.payment ? `<span class="payment-negative num">-${moneyHtml(r.figs.payment)}</span>` : dash),
      total: () => moneyHtml(totals.payment),
    },
    { label: 'Dluh', right: true, x: true, cell: (r) => (r.figs.known ? `<span class="num">${moneyHtml(r.figs.debt)}</span>` : dash), total: () => moneyHtml(totals.debt) },
    {
      label: 'Zástava',
      right: true,
      x: true,
      cell: (r) => {
        const lines = [];
        if (r.p.has_lien) lines.push(`${escapeHtml(r.p.lien_bank || '?')} <span class="num t-muted">${fmtMoney(r.own)}</span>`);
        for (const c of r.cross) lines.push(`${escapeHtml(c.bank || '?')} <span class="num t-muted">${fmtMoney(c.amount)}</span>`);
        return lines.length ? lines.join('<br>') : dash;
      },
      total: () => `<span class="num">${fmtMoney(totals.lien)}</span>`,
    },
    { label: 'Uvolněno nad zástavu', right: true, x: true, cell: (r) => `<span class="num">${moneyHtml(r.freed)}</span>`, total: () => moneyHtml(totals.freed) },
    { label: 'Růst %', right: true, x: true, cell: (r) => `<span class="num">${fmtPercent(r.p.growth_rate)}</span>`, total: () => `<span class="num">${fmtPercent(avgGrowth)}</span>` },
    { label: 'Po zhodnocení', right: true, x: true, cell: (r) => `<span class="num">${moneyHtml(r.av)}</span>`, total: () => moneyHtml(totals.appreciated) },
    { label: 'Časový test - zbývá', x: true, cell: (r) => (r.tt.never ? '<span class="t-muted">Bez testu</span>' : r.tt.none ? dash : escapeHtml(r.tt.text)), total: () => '' },
    { label: '', right: true, actions: true, cell: (r) => actionButtons('data-edit-property', 'data-delete-property', r.p.id), total: () => '' },
  ];
  const cols = visibleColumns(columns, key);
  document.getElementById('properties-thead').innerHTML = headHtml(cols);
  const tbody = document.getElementById('properties-tbody');
  const tfoot = document.getElementById('properties-tfoot');
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${cols.length}">Zatím žádné nemovitosti</td></tr>`;
    tfoot.innerHTML = '';
  } else {
    tbody.innerHTML = rows
      .map((r) => `<tr>${cols.map((c) => `<td class="${c.right ? 'text-right' : ''} ${c.actions ? 'whitespace-nowrap' : ''}">${c.cell(r)}</td>`).join('')}</tr>`)
      .join('');
    tfoot.innerHTML = `<tr>${cols.map((c) => `<td class="${c.right ? 'text-right' : ''}">${c.total()}</td>`).join('')}</tr>`;
  }
  tbody.querySelectorAll('[data-edit-property]').forEach((btn) => btn.addEventListener('click', () => fillPropertyForm(btn.dataset.editProperty)));
  tbody.querySelectorAll('[data-delete-property]').forEach((btn) => btn.addEventListener('click', () => deleteProperty(btn.dataset.deleteProperty)));
}

/** Zástava za úvěry, která na nemovitosti právě leží (u upravované nemovitosti podle uloženého stavu). */
function propertyCrossPledged(propertyId) {
  return propertyId ? calc.pledgedByLoans(propertyId, state.loans) : 0;
}

/** Volná hodnota k zastavení podle hodnot ve formuláři: hodnota − vlastní zástava − zástavy za úvěry. */
function propertyFreeFromForm() {
  const f = propertyForm();
  const market = parseFormNumber(f.elements['market_value'].value);
  const lien = f.elements['has_lien'].checked ? parseFormNumber(f.elements['lien_value'].value) : 0;
  const cross = propertyCrossPledged(f.elements['id'].value);
  return { market, lien, cross, free: market - lien - cross };
}

function updatePropertyFreeReadout() {
  const el = document.getElementById('property-free-pledge');
  if (!el) return;
  const { free, cross } = propertyFreeFromForm();
  el.classList.toggle('is-over', free < 0);
  el.innerHTML =
    free < 0
      ? `Zástavy přesahují hodnotu o <strong>${fmtMoney(-free)}</strong>`
      : `Volné k zastavení <strong>${fmtMoney(free)}</strong>${cross ? ` <span class="t-muted">(za úvěry zastaveno ${fmtMoney(cross)})</span>` : ''}`;
}

function showFormError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
  if (message) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }
}

/** Vybrané zástavy a částky tak, jak jsou právě ve formuláři (null = seznam ještě nebyl vykreslen). */
function readPledgeDraft() {
  const rows = document.querySelectorAll('#loan-collateral-checklist .pledge-row');
  if (!rows.length) return null;
  const draft = new Map();
  rows.forEach((row) => {
    if (row.querySelector('.loan-collateral-checkbox').checked) {
      draft.set(row.dataset.pid, parseFormNumber(row.querySelector('.loan-collateral-amount').value));
    }
  });
  return draft;
}

function showPledgeMessage(row, text) {
  const msg = row.querySelector('.pledge-msg');
  msg.textContent = text;
  msg.classList.toggle('hidden', !text);
  clearTimeout(row._msgTimer);
  if (text) row._msgTimer = setTimeout(() => showPledgeMessage(row, ''), 3500);
}

/** Částku zástavy drží v mezích 1 Kč až volná hodnota nemovitosti. */
function clampPledgeAmount(row) {
  const input = row.querySelector('.loan-collateral-amount');
  const free = Number(row.dataset.free) || 0;
  const amount = parseFormNumber(input.value);
  if (amount > free) {
    setFormattedValue(input, Math.floor(free));
    showPledgeMessage(row, `Víc než volných ${fmtMoney(free)} zastavit nejde.`);
  } else if (!(amount > 0)) {
    setFormattedValue(input, Math.floor(free));
  }
}

function wirePledgeChecklist() {
  const container = document.getElementById('loan-collateral-checklist');
  container.addEventListener('change', (e) => {
    const row = e.target.closest('.pledge-row');
    if (!row) return;
    if (e.target.classList.contains('loan-collateral-checkbox')) {
      const free = Number(row.dataset.free) || 0;
      if (e.target.checked && free < 1) {
        e.target.checked = false;
        showPledgeMessage(row, 'Z této nemovitosti už není co zastavit.');
      }
      row.classList.toggle('is-on', e.target.checked);
      row.querySelector('.pledge-amount').classList.toggle('hidden', !e.target.checked);
      if (e.target.checked && !(parseFormNumber(row.querySelector('.loan-collateral-amount').value) > 0)) {
        setFormattedValue(row.querySelector('.loan-collateral-amount'), Math.floor(free));
      }
    } else if (e.target.classList.contains('loan-collateral-amount')) {
      clampPledgeAmount(row);
    }
    updateLoanBadges();
    showFormError('loan-form-error', '');
  });
  container.addEventListener('input', (e) => {
    if (e.target.classList.contains('loan-collateral-amount')) updateLoanBadges();
  });
}

/** Splátkový kalendář úvěru (jako list "Roky" v bankovní kalkulačce): úrok, jistina a podíl úroku po letech. */
function loanScheduleHtml(loan, expanded) {
  const sch = calc.loanSchedule(loan, { events: state.events, startYear: CURRENT_YEAR, maxYears: 40 });
  if (!sch.rows.length) return '<p class="text-sm t-faint">Nic ke splácení</p>';
  const body = sch.rows
    .map((r) => {
      const share = Math.round(r.interestShare * 100);
      return `<tr>
        <td class="font-medium">${r.year}</td>
        <td>${moneyHtml(r.interest)}</td>
        <td>${moneyHtml(r.principal)}</td>
        <td><span class="share-bar" title="${share} % splátek tvoří úrok"><i style="width:${share}%"></i></span> ${share} %</td>
        <td>${moneyHtml(r.balanceEnd)}</td>
        ${expanded ? `<td>${fmtMoney(r.monthlyPayment)}</td><td>${fmtPercent(r.rate)}</td>` : ''}
      </tr>`;
    })
    .join('');
  const total = sch.totalInterest + sch.totalPrincipal;
  const totalShare = total > 0 ? Math.round((sch.totalInterest / total) * 100) : 0;
  return `<div class="detail-panel">
    <div class="overflow-x-auto"><table class="subtbl">
      <thead><tr><th>Rok</th><th>Úrok</th><th>Jistina</th><th>Podíl úroku</th><th>Zůstatek</th>${expanded ? '<th>Splátka /měs.</th><th>Sazba</th>' : ''}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>Celkem</td><td>${moneyHtml(sch.totalInterest)}</td><td>${moneyHtml(sch.totalPrincipal)}</td><td>${totalShare} %</td><td></td>${expanded ? '<td></td><td></td>' : ''}</tr></tfoot>
    </table></div>
  </div>`;
}

function renderLoansTable() {
  const key = 'loans';
  applyTableMode(key);
  const expanded = isExpanded(key);
  const totals = { amount: 0, payment: 0, own: 0 };
  const dash = '<span class="t-faint">—</span>';

  const rows = state.loans.map((l) => {
    const end = calc.fixationEndDate(l);
    const terms = calc.loanTerms(l, CURRENT_YEAR);
    const sch = calc.loanSchedule(l, { events: state.events, startYear: CURRENT_YEAR, maxYears: 1 });
    const ltv = ltvInfo(l);
    totals.amount += Number(l.amount) || 0;
    totals.payment += terms.payment;
    if (ltv) totals.own += ltv.ownAmount;
    return { l, end, terms, share: sch.rows.length ? sch.rows[0].interestShare : null, ltv, fx: end ? calc.fixationRemainingUntil(end) : null };
  });

  const linkedName = (l) => {
    if (l.property_id && propertyName(l.property_id)) return escapeHtml(propertyName(l.property_id));
    const names = calc.loanCollateral(l).map((c) => propertyName(c.property_id)).filter(Boolean);
    return names.length ? escapeHtml(names.join(', ')) : '';
  };

  const columns = [
    {
      label: 'Banka',
      cell: (r) => `<button type="button" class="loan-toggle${expandedLoans.has(r.l.id) ? ' is-open' : ''}" data-loan-schedule="${r.l.id}" aria-expanded="${expandedLoans.has(r.l.id)}" title="Splátkový kalendář"><span class="year-chevron"></span><span class="font-medium">${escapeHtml(r.l.bank)}</span></button>${r.l.note ? `<br><span class="text-xs t-muted">${escapeHtml(r.l.note)}</span>` : ''}`,
      total: () => 'Celkem',
    },
    { label: 'Výše úvěru', right: true, cell: (r) => `<span class="num">${moneyHtml(r.l.amount)}</span>`, total: () => moneyHtml(totals.amount) },
    { label: 'Úrok', right: true, x: true, cell: (r) => `<span class="num">${fmtPercent(r.l.interest_rate)}</span>`, total: () => '' },
    {
      label: 'Splátka',
      right: true,
      cell: (r) => `<span class="num">${r.terms.payment ? `${r.terms.auto ? '≈ ' : ''}${moneyHtml(r.terms.payment)}` : dash}</span>`,
      total: () => moneyHtml(totals.payment),
    },
    {
      label: 'Fixace',
      x: true,
      cell: (r) => {
        const years = r.l.fixation_years != null && r.l.fixation_years !== '' ? `${fmtNumber(r.l.fixation_years, 1)} let` : '';
        return r.end ? `<span class="num">${fmtDate(r.end.toISOString())}</span>${years ? `<br><span class="text-xs t-muted">${years}</span>` : ''}` : years || dash;
      },
      total: () => '',
    },
    { label: 'Zbývá fixace', x: true, cell: (r) => (r.fx ? escapeHtml(r.fx.text) : dash), total: () => '' },
    {
      label: 'Doplatí se',
      x: true,
      cell: (r) => (r.terms.payoffYear ? `<span class="num">${String(r.terms.payoffMonth).padStart(2, '0')}/${r.terms.payoffYear}</span>` : dash),
      total: () => '',
    },
    { label: 'Úrok ve splátce', right: true, x: true, cell: (r) => (r.share == null ? dash : `<span class="num">${Math.round(r.share * 100)} %</span>`), total: () => '' },
    { label: 'Poměr LTV', x: true, cell: (r) => (r.ltv ? r.ltv.text : dash), total: () => '' },
    { label: 'Vlastní vklad', right: true, x: true, cell: (r) => (r.ltv ? `<span class="num">${moneyHtml(r.ltv.ownAmount)}</span>` : dash), total: () => (totals.own ? moneyHtml(totals.own) : '') },
    { label: 'Nemovitost', x: true, cell: (r) => linkedName(r.l) || dash, total: () => '' },
    { label: '', right: true, actions: true, cell: (r) => actionButtons('data-edit-loan', 'data-delete-loan', r.l.id), total: () => '' },
  ];
  const cols = visibleColumns(columns, key);
  document.getElementById('loans-thead').innerHTML = headHtml(cols);
  const tbody = document.getElementById('loans-tbody');
  const tfoot = document.getElementById('loans-tfoot');
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${cols.length}">Zatím žádné úvěry</td></tr>`;
    tfoot.innerHTML = '';
  } else {
    tbody.innerHTML = rows
      .map((r) => {
        const main = `<tr class="loan-row">${cols.map((c) => `<td class="${c.right ? 'text-right' : ''} ${c.actions ? 'whitespace-nowrap' : ''}">${c.cell(r)}</td>`).join('')}</tr>`;
        return expandedLoans.has(r.l.id) ? main + `<tr class="loan-detail"><td colspan="${cols.length}">${loanScheduleHtml(r.l, expanded)}</td></tr>` : main;
      })
      .join('');
    tfoot.innerHTML = `<tr>${cols.map((c) => `<td class="${c.right ? 'text-right' : ''}">${c.total()}</td>`).join('')}</tr>`;
  }
  tbody.querySelectorAll('[data-edit-loan]').forEach((btn) => btn.addEventListener('click', () => fillLoanForm(btn.dataset.editLoan)));
  tbody.querySelectorAll('[data-delete-loan]').forEach((btn) => btn.addEventListener('click', () => deleteLoan(btn.dataset.deleteLoan)));
  tbody.querySelectorAll('[data-loan-schedule]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = btn.dataset.loanSchedule;
      if (expandedLoans.has(id)) expandedLoans.delete(id);
      else expandedLoans.add(id);
      renderLoansTable();
    })
  );
}

/* ---------- Inicializace ---------- */

function init() {
  loadState();
  wireTheme();
  wireRipples();
  wireLeaveGuard();
  wireTabs();
  wireForms();
  wireBackup();
  wireOverviewControls();
  wireSettingsInputs();
  wireZeroClearsOnFocus();
  wireFormattedInputs();
  wireNumberSteppers();
  wireDateFields();
  wireTableToggles();
  document.querySelectorAll('[data-combo="bank"]').forEach((input) => makeCombobox(input, bankOptions));
  wirePropertyFormUi();
  wireLoanFormUi();
  wireEventFormUi();
  wireScenarioTable();
  wireKpiFormulaToggles();
  wirePdfExportButtons();
  document.getElementById('scenario-horizon').addEventListener('input', (e) => {
    state.scenario.horizonYears = Math.max(1, Number(e.target.value) || 1);
    saveState();
    renderScenario();
    renderOverview();
  });
  document.getElementById('scenario-horizon').addEventListener('blur', () => renderScenario());
  resetPropertyForm();
  resetLoanForm();
  resetEventForm();
  renderAll();
}

function renderAll() {
  renderProperties();
  renderLoans();
  renderSettings();
  renderEvents();
  renderScenario();
  renderOverview();
}

/** Po změně dat, která se promítají do výpočtů (události, nemovitosti, úvěry, nastavení). */
function renderCalculations() {
  renderEvents();
  renderScenario();
  renderOverview();
}

/* ---------- Tabs ---------- */

let activeTab = 'tab-overview';
let tabBeforeSettings = 'tab-overview';

function showTab(tabId) {
  if (tabId === 'tab-settings' && activeTab !== 'tab-settings') tabBeforeSettings = activeTab;
  activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('tab-active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== tabId));
  const gear = document.getElementById('btn-settings');
  if (gear) gear.setAttribute('aria-pressed', String(tabId === 'tab-settings'));
  window.scrollTo({ top: 0 });
}

function wireTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });
  // Nastavení nemá záložku v liště - otevírá se ozubeným kolem v hlavičce (druhé kliknutí vrátí zpět).
  document.getElementById('btn-settings').addEventListener('click', () => {
    showTab(activeTab === 'tab-settings' ? tabBeforeSettings : 'tab-settings');
  });
}

/* ---------- Pomocné pro nemovitosti a úvěry ---------- */

function ownerBadge(p) {
  return calc.isPO(p) ? '<span class="badge badge-po">PO</span>' : '<span class="badge badge-fo">FO</span>';
}

function propertyName(id) {
  const p = state.properties.find((x) => x.id === id);
  return p ? p.name : '';
}

/* ---------- MOJE NEMOVITOSTI ---------- */

function renderProperties() {
  renderPropertiesTable();
  renderLoanPropertySelect();
  renderEventTargets();
  updatePropertyFreeReadout();
}

function propertyForm() {
  return document.getElementById('property-form');
}

function setLienFieldsVisible(visible) {
  document.getElementById('lien-fields').classList.toggle('hidden', !visible);
}

function setTimeTestEnabled(enabled) {
  document.getElementById('time-test-seg').classList.toggle('is-off', !enabled);
}

function updatePropertyBadges() {
  const f = propertyForm();
  const hasLien = f.elements['has_lien'].checked;
  const lienBank = f.elements['lien_bank'].value.trim();
  const lienValue = parseFormNumber(f.elements['lien_value'].value);
  document.getElementById('property-pledge-badge').textContent = hasLien
    ? [lienBank || 'Zastaveno', lienValue ? fmtMoney(lienValue) : ''].filter(Boolean).join(' · ')
    : 'Bez zástavy';

  const occRaw = f.elements['occupancy'].value.trim();
  const occupancy = occRaw ? parseFormNumber(occRaw) : 100;
  const costs = parseFormNumber(f.elements['monthly_costs'].value);
  const rentGrowth = f.elements['rent_growth_rate'].value.trim();
  document.getElementById('property-operation-badge').textContent = [
    occupancy < 100 ? `Obsazenost ${fmtNumber(occupancy)} %` : '',
    costs ? `Náklady ${fmtMoney(costs)}` : '',
    rentGrowth ? `Nájem ${fmtNumber(parseFormNumber(rentGrowth))} %` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  updatePropertyFreeReadout();
}

function wirePropertyFormUi() {
  const f = propertyForm();
  f.elements['has_lien'].addEventListener('change', () => setLienFieldsVisible(f.elements['has_lien'].checked));
  f.querySelectorAll('input[name="owner_type"]').forEach((radio) =>
    radio.addEventListener('change', () => setTimeTestEnabled(f.elements['owner_type'].value !== 'po'))
  );
  f.addEventListener('input', () => {
    updatePropertyBadges();
    showFormError('property-form-error', '');
  });
  f.addEventListener('change', updatePropertyBadges);
}

function fillPropertyForm(id) {
  const p = state.properties.find((x) => x.id === id);
  if (!p) return;
  const f = propertyForm();
  f.reset();
  showFormError('property-form-error', '');
  f.elements['id'].value = p.id;
  f.elements['name'].value = p.name;
  setFormattedValue(f.elements['rent'], p.rent);
  setFormattedValue(f.elements['market_value'], p.market_value);
  setFormattedValue(f.elements['acquisition_price'], p.acquisition_price);
  setFormattedValue(f.elements['growth_rate'], (Number(p.growth_rate) || 0) * 100);
  f.elements['acquisition_date'].value = p.acquisition_date || '';
  f.elements['owner_type'].value = calc.isPO(p) ? 'po' : 'fo';
  const years = calc.taxExemptYears(p);
  f.elements['tax_exempt_years'].value = String([0, 5, 10].includes(years) ? years : 10);
  f.elements['has_lien'].checked = !!p.has_lien;
  f.elements['lien_bank'].value = p.lien_bank || '';
  setFormattedValue(f.elements['lien_value'], p.lien_value || '');
  const vacancy = Number(p.vacancy_rate) || 0;
  setFormattedValue(f.elements['occupancy'], vacancy > 0 ? +((1 - vacancy) * 100).toFixed(4) : '');
  setFormattedValue(f.elements['monthly_costs'], p.monthly_costs || '');
  setFormattedValue(f.elements['rent_growth_rate'], p.rent_growth_rate != null ? +(p.rent_growth_rate * 100).toFixed(4) : '');
  setLienFieldsVisible(!!p.has_lien);
  setTimeTestEnabled(!calc.isPO(p));
  document.getElementById('property-acc-pledge').open = !!p.has_lien || propertyCrossPledged(p.id) > 0;
  const opAcc = document.getElementById('property-rent-growth').closest('details');
  opAcc.open = vacancy > 0 || !!p.monthly_costs || p.rent_growth_rate != null;
  document.getElementById('property-form-title').textContent = 'Upravit nemovitost';
  document.getElementById('property-submit-label').textContent = 'Uložit změny';
  document.getElementById('property-form-card').classList.add('is-editing');
  updatePropertyBadges();
  revealForm('property-form-card');
}

function resetPropertyForm() {
  const f = propertyForm();
  f.reset();
  f.elements['id'].value = '';
  showFormError('property-form-error', '');
  setLienFieldsVisible(false);
  setTimeTestEnabled(true);
  f.querySelectorAll('details.acc').forEach((acc) => {
    acc.open = false;
  });
  document.getElementById('property-form-title').textContent = 'Přidat nemovitost';
  document.getElementById('property-submit-label').textContent = 'Přidat nemovitost';
  document.getElementById('property-form-card').classList.remove('is-editing');
  updatePropertyBadges();
}

function deleteProperty(id) {
  return customConfirm('Opravdu smazat tuto nemovitost?', 'Smazat').then((ok) => {
    if (!ok) return;
    state.properties = state.properties.filter((p) => p.id !== id);
    // ať po nemovitosti nezůstávají viset odkazy z úvěrů a událostí
    state.loans.forEach((l) => {
      if (l.property_id === id) l.property_id = null;
      if (Array.isArray(l.collateral)) l.collateral = l.collateral.filter((c) => c.property_id !== id);
    });
    pruneEventTargets(id, 'property');
    saveState();
    renderAll();
  });
}

function submitPropertyForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.elements['id'].value;
  // zástavy nesmí přesáhnout hodnotu nemovitosti (vlastní zástava + zástavy za úvěry)
  const { market, lien, cross, free } = propertyFreeFromForm();
  if (free < 0) {
    document.getElementById('property-acc-pledge').open = true;
    showFormError(
      'property-form-error',
      `Zástava ${fmtMoney(lien)}${cross ? ` a zástavy za úvěry ${fmtMoney(cross)}` : ''} přesahují hodnotu nemovitosti ${fmtMoney(market)}. Sniž zástavu nebo zvyš hodnotu.`
    );
    return;
  }
  showFormError('property-form-error', '');
  const rentGrowthRaw = f.elements['rent_growth_rate'].value.trim();
  const occupancyRaw = f.elements['occupancy'].value.trim();
  const occupancy = occupancyRaw ? Math.min(100, Math.max(0, parseFormNumber(occupancyRaw))) : 100;
  const years = Number(f.elements['tax_exempt_years'].value);
  const existing = id ? state.properties.find((p) => p.id === id) : null;
  const payload = {
    // nepoužívané starší údaje (např. ručně zadaná splátka) zůstanou v datech beze změny
    ...(existing || {}),
    id: id || uid(),
    name: f.elements['name'].value.trim(),
    rent: parseFormNumber(f.elements['rent'].value),
    market_value: parseFormNumber(f.elements['market_value'].value),
    acquisition_price: parseFormNumber(f.elements['acquisition_price'].value),
    growth_rate: parseFormNumber(f.elements['growth_rate'].value) / 100,
    acquisition_date: f.elements['acquisition_date'].value || null,
    owner_type: f.elements['owner_type'].value === 'po' ? 'po' : 'fo',
    tax_exempt_years: [0, 5, 10].includes(years) ? years : 10,
    has_lien: f.elements['has_lien'].checked,
    lien_bank: f.elements['has_lien'].checked ? f.elements['lien_bank'].value.trim() || null : null,
    lien_value: f.elements['has_lien'].checked && f.elements['lien_value'].value.trim() ? parseFormNumber(f.elements['lien_value'].value) : null,
    vacancy_rate: (100 - occupancy) / 100,
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

/** Poměr LTV (dluh/vlastní): z hodnoty při sjednání, jinak z tržní hodnoty financované nemovitosti. */
function ltvInfo(loan) {
  let propValue = Number(loan.property_value_at_origination);
  if (!propValue || propValue <= 0) {
    const linked = loan.property_id && state.properties.find((p) => p.id === loan.property_id);
    propValue = linked ? Number(linked.market_value) || 0 : 0;
  }
  if (!propValue || propValue <= 0) return null;
  const amount = Number(loan.amount) || 0;
  const ltvPct = Math.round(Math.min(1, amount / propValue) * 100);
  return { text: `${ltvPct}/${100 - ltvPct}`, ownAmount: Math.max(0, propValue - amount) };
}

function loanForm() {
  return document.getElementById('loan-form');
}

/**
 * Rozbalovací seznam "Zástava": u každé nemovitosti jde zaškrtnout, že je zastavená pro tento úvěr, a zadat
 * částku. Částka nemůže přesáhnout volnou hodnotu nemovitosti (hodnota − vlastní zástava − zástavy za jiné úvěry).
 */
function renderLoanCollateralChecklist(draft) {
  const container = document.getElementById('loan-collateral-checklist');
  if (!container) return;
  const editId = loanForm().elements['id'].value;
  const editing = editId ? state.loans.find((l) => l.id === editId) : null;
  const selected = draft || new Map((editing ? calc.loanCollateral(editing) : []).filter((c) => Number.isFinite(c.amount)).map((c) => [c.property_id, c.amount]));
  if (!state.properties.length) {
    container.innerHTML = '<p class="text-sm t-faint">Zatím žádné nemovitosti</p>';
    updateLoanBadges();
    return;
  }
  container.innerHTML = state.properties
    .map((p) => {
      const free = calc.freePledgeValue(p, state.loans, editId);
      const on = selected.has(p.id);
      return `<div class="pledge-row${on ? ' is-on' : ''}${free <= 0 && !on ? ' is-full' : ''}" data-pid="${p.id}" data-free="${free}">
        <label class="pledge-check">
          <input type="checkbox" class="loan-collateral-checkbox" value="${p.id}" ${on ? 'checked' : ''} />
          <span class="pledge-name">${escapeHtml(p.name)}</span>
        </label>
        <span class="pledge-free">volné <strong class="num">${fmtMoney(free)}</strong></span>
        <div class="pledge-amount ${on ? '' : 'hidden'}"><input class="input loan-collateral-amount" data-unit="money" aria-label="Zastavená částka" /></div>
        <p class="pledge-msg hidden"></p>
      </div>`;
    })
    .join('');
  container.querySelectorAll('.pledge-row').forEach((row) => {
    const input = row.querySelector('.loan-collateral-amount');
    enhanceUnitInput(input, 'money');
    if (selected.has(row.dataset.pid)) setFormattedValue(input, selected.get(row.dataset.pid) || '');
  });
  updateLoanBadges();
}

function renderLoanPropertySelect() {
  const select = document.getElementById('loan-property-select');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = '<option value="">—</option>' + state.properties.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  select.value = state.properties.some((p) => p.id === previous) ? previous : '';
}

function updateLoanBadges() {
  const f = loanForm();
  const draft = readPledgeDraft();
  const sum = draft ? Array.from(draft.values()).reduce((s, v) => s + v, 0) : 0;
  document.getElementById('loan-pledge-badge').textContent = draft && draft.size ? `${draft.size}× · ${fmtMoney(sum)}` : 'Bez zástavy';

  const start = f.elements['start_date'].value;
  const end = f.elements['fixation_end'].value;
  const years = f.elements['fixation_years'].value;
  const maturity = f.elements['maturity_date'].value;
  document.getElementById('loan-fixation-badge').textContent = [
    start && end ? `${fmtDate(start)} → ${fmtDate(end)}` : end ? `do ${fmtDate(end)}` : years !== '' ? `${years} let` : '',
    f.elements['rate_after_fixation'].value.trim() ? `po fixaci ${fmtNumber(parseFormNumber(f.elements['rate_after_fixation'].value))} %` : '',
    maturity ? `splatnost ${fmtDate(maturity)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const refDate = f.elements['refinance_date'].value;
  const refRate = f.elements['refinance_rate'].value.trim();
  const refYears = f.elements['refinance_years'].value.trim();
  document.getElementById('loan-refinance-badge').textContent = [refDate ? fmtDate(refDate) : '', refRate ? `${fmtNumber(parseFormNumber(refRate))} %` : '', refYears ? `${refYears} let` : '']
    .filter(Boolean)
    .join(' · ');

  const linked = f.elements['property_id'].value;
  document.getElementById('loan-details-badge').textContent = linked ? propertyName(linked) : '';
}

const toInputDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Fixace od / doba / do: změna kteréhokoli pole dopočítá ostatní. */
function wireFixationFields() {
  const f = loanForm();
  const start = f.elements['start_date'];
  const years = f.elements['fixation_years'];
  const end = f.elements['fixation_end'];

  const endFromYears = () => {
    if (!start.value || years.value === '') return;
    const d = calc.toDate(start.value);
    if (isNaN(d)) return;
    end.value = toInputDate(calc.addMonths(d, Math.round((Number(years.value) || 0) * 12)));
  };
  const yearsFromEnd = () => {
    if (!start.value || !end.value) return;
    const a = calc.toDate(start.value);
    const b = calc.toDate(end.value);
    if (isNaN(a) || isNaN(b) || b < a) return;
    const diff = calc.calendarDiff(a, b);
    years.value = +(diff.years + diff.months / 12).toFixed(1);
  };

  years.addEventListener('change', endFromYears);
  start.addEventListener('change', () => {
    if (years.value !== '') endFromYears();
    else yearsFromEnd();
  });
  end.addEventListener('change', yearsFromEnd);
}

function wireLoanFormUi() {
  const f = loanForm();
  f.elements['fixation_years'].step = 'any';
  f.elements['refinance_years'].step = 'any';
  wireFixationFields();
  wirePledgeChecklist();
  f.addEventListener('input', updateLoanBadges);
  f.addEventListener('change', updateLoanBadges);
}

function renderLoans() {
  renderLoansTable();
  renderLoanCollateralChecklist(readPledgeDraft());
  renderLoanPropertySelect();
  renderEventTargets();
}

function fillLoanForm(id) {
  const l = state.loans.find((x) => x.id === id);
  if (!l) return;
  const f = loanForm();
  f.reset();
  showFormError('loan-form-error', '');
  f.elements['id'].value = l.id;
  f.elements['bank'].value = l.bank;
  setFormattedValue(f.elements['amount'], l.amount);
  setFormattedValue(f.elements['interest_rate'], +(l.interest_rate * 100).toFixed(4));
  setFormattedValue(f.elements['monthly_payment'], l.monthly_payment || '');
  f.elements['start_date'].value = l.start_date || '';
  f.elements['fixation_years'].value = l.fixation_years != null && l.fixation_years !== '' ? l.fixation_years : '';
  const end = calc.fixationEndDate(l);
  f.elements['fixation_end'].value = end ? toInputDate(end) : '';
  setFormattedValue(f.elements['rate_after_fixation'], l.rate_after_fixation != null ? l.rate_after_fixation : '');
  setFormattedValue(f.elements['payment_after_fixation'], l.payment_after_fixation || '');
  f.elements['maturity_date'].value = l.maturity_date || '';
  f.elements['refinance_date'].value = l.refinance_date || '';
  setFormattedValue(f.elements['refinance_rate'], l.refinance_rate != null ? l.refinance_rate : '');
  f.elements['refinance_years'].value = l.refinance_years != null ? l.refinance_years : '';
  f.elements['note'].value = l.note || '';
  setFormattedValue(f.elements['property_value_at_origination'], l.property_value_at_origination || '');
  renderLoanPropertySelect();
  f.elements['property_id'].value = l.property_id || '';
  renderLoanCollateralChecklist(null);
  document.getElementById('loan-acc-pledge').open = calc.loanCollateral(l).length > 0;
  const accordions = Array.from(f.querySelectorAll('details.acc:not(.acc-pledge)'));
  const [fixationAcc, refinanceAcc, detailsAcc] = accordions;
  fixationAcc.open = !!(l.start_date || end || l.fixation_years != null || l.rate_after_fixation != null || l.maturity_date || l.payment_after_fixation);
  refinanceAcc.open = !!(l.refinance_date || l.refinance_rate != null || l.refinance_years);
  detailsAcc.open = !!(l.property_value_at_origination || l.property_id || l.note);
  document.getElementById('loan-form-title').textContent = 'Upravit úvěr';
  document.getElementById('loan-submit-label').textContent = 'Uložit změny';
  document.getElementById('loan-form-card').classList.add('is-editing');
  updateLoanBadges();
  revealForm('loan-form-card');
}

function resetLoanForm() {
  const f = loanForm();
  f.reset();
  f.elements['id'].value = '';
  showFormError('loan-form-error', '');
  f.querySelectorAll('details.acc').forEach((acc) => {
    acc.open = false;
  });
  document.getElementById('loan-form-title').textContent = 'Přidat úvěr';
  document.getElementById('loan-submit-label').textContent = 'Přidat úvěr';
  document.getElementById('loan-form-card').classList.remove('is-editing');
  renderLoanCollateralChecklist(null);
  renderLoanPropertySelect();
  updateLoanBadges();
}

async function deleteLoan(id) {
  if (!(await customConfirm('Opravdu smazat tento úvěr?', 'Smazat'))) return;
  state.loans = state.loans.filter((l) => l.id !== id);
  expandedLoans.delete(id);
  pruneEventTargets(id, 'loan');
  saveState();
  renderAll();
}

function submitLoanForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.elements['id'].value;

  // zástavy: částka u každé zaškrtnuté nemovitosti nesmí přesáhnout její volnou hodnotu
  const collateral = [];
  for (const row of document.querySelectorAll('#loan-collateral-checklist .pledge-row')) {
    if (!row.querySelector('.loan-collateral-checkbox').checked) continue;
    const free = Number(row.dataset.free) || 0;
    const amount = parseFormNumber(row.querySelector('.loan-collateral-amount').value);
    if (!(amount > 0) || amount > free + 0.5) {
      document.getElementById('loan-acc-pledge').open = true;
      showPledgeMessage(row, `Zástava musí být od 1 Kč do ${fmtMoney(free)}.`);
      showFormError('loan-form-error', `Zástava u „${row.querySelector('.pledge-name').textContent}“ přesahuje volnou hodnotu nemovitosti (${fmtMoney(free)}).`);
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    collateral.push({ property_id: row.dataset.pid, amount: Math.round(amount) });
  }
  showFormError('loan-form-error', '');

  const num = (name) => {
    const raw = f.elements[name].value.trim();
    return raw ? parseFormNumber(raw) : null;
  };
  const yearsRaw = f.elements['fixation_years'].value.trim();
  const existing = id ? state.loans.find((l) => l.id === id) : null;
  const payload = {
    ...(existing || {}),
    id: id || uid(),
    bank: f.elements['bank'].value.trim(),
    amount: parseFormNumber(f.elements['amount'].value),
    interest_rate: parseFormNumber(f.elements['interest_rate'].value) / 100,
    monthly_payment: parseFormNumber(f.elements['monthly_payment'].value),
    fixation_years: yearsRaw === '' ? null : Math.max(0, Number(yearsRaw) || 0),
    start_date: f.elements['start_date'].value || null,
    fixation_end: f.elements['fixation_end'].value || null,
    rate_after_fixation: num('rate_after_fixation'),
    payment_after_fixation: num('payment_after_fixation'),
    maturity_date: f.elements['maturity_date'].value || null,
    refinance_date: f.elements['refinance_date'].value || null,
    refinance_rate: num('refinance_rate'),
    refinance_years: f.elements['refinance_years'].value.trim() ? Math.max(0, Number(f.elements['refinance_years'].value) || 0) : null,
    note: f.elements['note'].value.trim() || null,
    property_value_at_origination: num('property_value_at_origination'),
    property_id: f.elements['property_id'].value || null,
    collateral,
  };
  delete payload.additional_collateral_ids;
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
  const s = state.settings;
  setFormattedValue(document.getElementById('inflation-input'), +(s.inflation_rate * 100).toFixed(4));
  setFormattedValue(document.getElementById('rent-growth-input'), s.default_rent_growth != null ? +(s.default_rent_growth * 100).toFixed(4) : '');
  setFormattedValue(document.getElementById('capgains-tax-input'), s.capital_gains_tax_rate);
  setFormattedValue(document.getElementById('po-tax-input'), s.po_tax_rate);
  document.getElementById('auto-sell-enabled-input').checked = s.auto_sell_enabled !== false;
  document.getElementById('po-sell-asap-input').checked = s.po_sell_asap !== false;
  setFormattedValue(document.getElementById('sale-trigger-input'), s.sale_trigger_amount || '');
  setFormattedValue(document.getElementById('min-portfolio-input'), s.min_portfolio_value || '');
  document.getElementById('pledge-financing-enabled-input').checked = !!s.pledge_financing_enabled;
  setFormattedValue(document.getElementById('pledge-max-ltv-input'), s.pledge_max_ltv);
  syncSettingsVisibility();
  updateRentGrowthPlaceholders();
}

/** Prázdné pole růstu nájmu = použije se výchozí z Nastavení, jinak inflace - její hodnota je vidět jako nápověda. */
function updateRentGrowthPlaceholders() {
  const effective = state.settings.default_rent_growth != null ? state.settings.default_rent_growth : state.settings.inflation_rate;
  const text = fmtNumber(effective * 100);
  document.getElementById('property-rent-growth').placeholder = text;
  document.getElementById('rent-growth-input').placeholder = fmtNumber(state.settings.inflation_rate * 100);
}

function syncSettingsVisibility() {
  document.getElementById('auto-sell-options').classList.toggle('hidden', !document.getElementById('auto-sell-enabled-input').checked);
  document.getElementById('pledge-financing-options').classList.toggle('hidden', !document.getElementById('pledge-financing-enabled-input').checked);
}

function wireSettingsInputs() {
  const el = (id) => document.getElementById(id);
  const save = () => {
    const rentGrowthRaw = el('rent-growth-input').value.trim();
    state.settings.inflation_rate = parseFormNumber(el('inflation-input').value) / 100;
    state.settings.default_rent_growth = rentGrowthRaw ? parseFormNumber(rentGrowthRaw) / 100 : null;
    state.settings.capital_gains_tax_rate = parseFormNumber(el('capgains-tax-input').value);
    state.settings.po_tax_rate = parseFormNumber(el('po-tax-input').value);
    state.settings.auto_sell_enabled = el('auto-sell-enabled-input').checked;
    state.settings.po_sell_asap = el('po-sell-asap-input').checked;
    state.settings.sale_trigger_amount = parseFormNumber(el('sale-trigger-input').value);
    state.settings.min_portfolio_value = parseFormNumber(el('min-portfolio-input').value);
    state.settings.pledge_financing_enabled = el('pledge-financing-enabled-input').checked;
    state.settings.pledge_max_ltv = parseFormNumber(el('pledge-max-ltv-input').value);
    saveState();
    syncSettingsVisibility();
    updateRentGrowthPlaceholders();
    renderCalculations();
  };
  [
    'inflation-input',
    'rent-growth-input',
    'capgains-tax-input',
    'po-tax-input',
    'auto-sell-enabled-input',
    'po-sell-asap-input',
    'sale-trigger-input',
    'min-portfolio-input',
    'pledge-financing-enabled-input',
    'pledge-max-ltv-input',
  ].forEach((id) => el(id).addEventListener('change', save));
}

/* ---------- SCÉNÁŘOVÉ UDÁLOSTI ---------- */

const EVENT_LABELS = {
  growth: 'Růst hodnoty nemovitostí',
  rent_growth: 'Růst nájmu',
  vacancy: 'Obsazenost',
  interest: 'Růst úrokových sazeb',
  inflation: 'Inflace',
  one_time: 'Jednorázový příjem/výdaj',
  sale: 'Prodej co nejdřív',
  rate_after_fixation: 'Sazba po fixaci',
  refinance: 'Refinancování',
};

const EVENT_UNITS = { growth: 'percent', rent_growth: 'percent', vacancy: 'percent', inflation: 'percent', interest: 'pp', one_time: 'money' };
const EVENT_VALUE_LABELS = {
  growth: 'Růst',
  rent_growth: 'Růst',
  vacancy: 'Obsazenost',
  interest: 'Změna sazby',
  inflation: 'Inflace',
  one_time: 'Částka',
};

let eventTargets = []; // vybrané nemovitosti/úvěry ve formuláři události (prázdné = všechny)

function eventTargetKind(type) {
  if (type === 'interest') return 'loan';
  return ['growth', 'rent_growth', 'vacancy'].includes(type) ? 'property' : null;
}

/** Po smazání nemovitosti/úvěru ho odebere z cílů událostí; událost, která by tím ztratila všechny cíle, zmizí. */
function pruneEventTargets(removedId, kind) {
  state.events = state.events.filter((ev) => {
    if (!ev.target_ids || !ev.target_ids.length || eventTargetKind(ev.type) !== kind) return true;
    ev.target_ids = ev.target_ids.filter((x) => x !== removedId);
    return ev.target_ids.length > 0;
  });
}

function currentEventType() {
  return document.getElementById('event-type').value;
}

function updateEventFormUi() {
  const type = currentEventType();
  const unit = EVENT_UNITS[type];
  document.getElementById('event-value-label').textContent = EVENT_VALUE_LABELS[type];
  setFieldUnit(document.getElementById('event-value-input'), unit);
  const oneTime = type === 'one_time';
  document.getElementById('event-year-to-wrap').classList.toggle('hidden', oneTime);
  document.getElementById('event-year-from-label').textContent = oneTime ? 'Rok' : 'Od roku';
  renderEventTargets();
}

function renderEventTargets() {
  const container = document.getElementById('event-targets');
  if (!container) return;
  const kind = eventTargetKind(currentEventType());
  document.getElementById('event-targets-wrap').classList.toggle('hidden', !kind);
  if (!kind) return;
  const items =
    kind === 'loan'
      ? state.loans.map((l) => ({ id: l.id, label: l.bank || 'Úvěr' }))
      : state.properties.map((p) => ({ id: p.id, label: p.name }));
  eventTargets = eventTargets.filter((id) => items.some((i) => i.id === id));
  container.innerHTML =
    `<label class="chip"><input type="checkbox" data-all ${eventTargets.length ? '' : 'checked'} /><span>Všechny</span></label>` +
    items
      .map(
        (i) => `<label class="chip"><input type="checkbox" value="${i.id}" ${eventTargets.includes(i.id) ? 'checked' : ''} /><span>${escapeHtml(i.label)}</span></label>`
      )
      .join('');
}

function wireEventFormUi() {
  document.getElementById('event-type').addEventListener('change', () => {
    eventTargets = [];
    updateEventFormUi();
  });
  document.getElementById('event-targets').addEventListener('change', (e) => {
    if (e.target.hasAttribute('data-all')) eventTargets = [];
    else eventTargets = Array.from(document.querySelectorAll('#event-targets input[value]:checked')).map((el) => el.value);
    renderEventTargets();
  });
}

function eventTargetNames(ev) {
  if (!ev.target_ids || !ev.target_ids.length) return 'Všechny';
  const pool = ev.type === 'interest' ? state.loans.map((l) => [l.id, l.bank]) : state.properties.map((p) => [p.id, p.name]);
  const map = new Map(pool);
  const names = ev.target_ids.map((id) => map.get(id)).filter(Boolean);
  return names.length ? names.join(', ') : '—';
}

function eventPeriod(ev) {
  if (ev.type === 'one_time' || (ev.year_to && Number(ev.year_to) === Number(ev.year_from))) return `${ev.year_from}`;
  return ev.year_to ? `${ev.year_from}–${ev.year_to}` : `${ev.year_from} →`;
}

function eventValueText(ev) {
  const v = Number(ev.value) || 0;
  switch (ev.type) {
    case 'one_time':
      return fmtMoney(v);
    case 'interest':
      return `${v > 0 ? '+' : ''}${fmtNumber(v)} p. b.`;
    case 'vacancy':
      return `${fmtNumber(100 - v)} %`;
    default:
      return `${fmtNumber(v)} %`;
  }
}

function derivedEvents() {
  const out = [];
  const autoSell = state.settings.auto_sell_enabled !== false && state.settings.po_sell_asap !== false;
  for (const p of state.properties) {
    const vacancy = Number(p.vacancy_rate) || 0;
    const base = { derived: true, targets: p.name, source: { kind: 'property', id: p.id }, from: p.name };
    if (vacancy > 0) out.push({ ...base, type: 'vacancy', period: 'trvale', value: `${fmtNumber((1 - vacancy) * 100)} %` });
    if (p.rent_growth_rate != null) out.push({ ...base, type: 'rent_growth', period: 'trvale', value: `${fmtNumber(p.rent_growth_rate * 100)} %` });
    if (calc.isPO(p) && autoSell) out.push({ ...base, type: 'sale', period: `${CURRENT_YEAR}`, value: '—' });
  }
  for (const l of state.loans) {
    const base = { derived: true, targets: l.bank, source: { kind: 'loan', id: l.id }, from: l.bank };
    if (l.rate_after_fixation != null) {
      const end = calc.fixationEndDate(l);
      out.push({ ...base, type: 'rate_after_fixation', period: end ? `od ${end.getFullYear()}` : '—', value: `${fmtNumber(l.rate_after_fixation)} %` });
    }
    if (l.refinance_date) {
      const rate = l.refinance_rate != null ? `${fmtNumber(l.refinance_rate)} %` : '';
      const years = l.refinance_years ? `${fmtNumber(l.refinance_years, 1)} let` : '';
      out.push({ ...base, type: 'refinance', period: fmtDate(l.refinance_date), value: [rate, years].filter(Boolean).join(' · ') || '—' });
    }
  }
  return out;
}

function renderEvents() {
  const key = 'events';
  applyTableMode(key);
  const derived = derivedEvents();
  document.getElementById('events-card').classList.toggle('hidden', !state.events.length && !derived.length);
  const items = [
    ...state.events.map((ev) => ({
      label: EVENT_LABELS[ev.type] || ev.type,
      badge: '',
      targets: eventTargetNames(ev),
      period: eventPeriod(ev),
      value: eventValueText(ev),
      note: ev.note || '',
      actions: actionButtons('data-edit-event', 'data-delete-event', ev.id),
    })),
    ...derived.map((d) => ({
      label: EVENT_LABELS[d.type],
      badge: `<span class="badge badge-linked">${d.source.kind === 'property' ? 'z nemovitosti' : 'z úvěru'}</span>`,
      targets: d.targets,
      period: d.period,
      value: d.value,
      note: '',
      actions: actionButtons('data-edit-source', null, `${d.source.kind}:${d.source.id}`),
    })),
  ];
  const columns = [
    { label: 'Událost', cell: (it) => `<span class="font-medium">${it.label}</span> ${it.badge}<br><span class="text-xs t-muted">${escapeHtml(it.targets)}</span>` },
    { label: 'Období', cell: (it) => `<span class="num">${it.period}</span>` },
    { label: 'Hodnota', right: true, cell: (it) => `<span class="num">${it.value}</span>` },
    { label: 'Poznámka', x: true, cell: (it) => escapeHtml(it.note) },
    { label: '', right: true, actions: true, cell: (it) => it.actions },
  ];
  const cols = visibleColumns(columns, key);
  document.getElementById('events-thead').innerHTML = headHtml(cols);
  const tbody = document.getElementById('events-tbody');
  tbody.innerHTML = items.map((it) => `<tr>${cols.map((c) => `<td class="${c.right ? 'text-right' : ''} ${c.actions ? 'whitespace-nowrap' : ''}">${c.cell(it)}</td>`).join('')}</tr>`).join('');
  tbody.querySelectorAll('[data-edit-event]').forEach((btn) => btn.addEventListener('click', () => fillEventForm(btn.dataset.editEvent)));
  tbody.querySelectorAll('[data-delete-event]').forEach((btn) => btn.addEventListener('click', () => deleteEvent(btn.dataset.deleteEvent)));
  tbody.querySelectorAll('[data-edit-source]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [kind, id] = btn.dataset.editSource.split(':');
      if (kind === 'property') {
        showTab('tab-properties');
        fillPropertyForm(id);
      } else {
        showTab('tab-loans');
        fillLoanForm(id);
      }
    })
  );
}

function fillEventForm(id) {
  const ev = state.events.find((x) => x.id === id);
  if (!ev) return;
  const f = document.getElementById('event-form');
  f.elements['id'].value = ev.id;
  f.elements['type'].value = ev.type;
  eventTargets = (ev.target_ids || []).slice();
  f.elements['year_from'].value = ev.year_from;
  f.elements['year_to'].value = ev.year_to && Number(ev.year_to) !== Number(ev.year_from) ? ev.year_to : '';
  updateEventFormUi();
  const v = Number(ev.value) || 0;
  setFormattedValue(f.elements['value'], ev.type === 'vacancy' ? +(100 - v).toFixed(4) : v);
  f.elements['note'].value = ev.note || '';
  document.getElementById('event-form-title').textContent = 'Upravit scénářovou událost';
  document.getElementById('event-submit-label').textContent = 'Uložit změny';
  document.getElementById('event-form-card').classList.add('is-editing');
  revealForm('event-form-card');
}

function resetEventForm() {
  const f = document.getElementById('event-form');
  f.reset();
  f.elements['id'].value = '';
  f.elements['year_from'].value = CURRENT_YEAR;
  eventTargets = [];
  updateEventFormUi();
  document.getElementById('event-form-title').textContent = 'Přidat scénářovou událost';
  document.getElementById('event-submit-label').textContent = 'Přidat událost';
  document.getElementById('event-form-card').classList.remove('is-editing');
}

async function deleteEvent(id) {
  if (!(await customConfirm('Smazat tuto scénářovou událost?', 'Smazat'))) return;
  state.events = state.events.filter((e) => e.id !== id);
  saveState();
  renderCalculations();
}

function submitEventForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.elements['id'].value;
  const type = f.elements['type'].value;
  const yearFrom = Number(f.elements['year_from'].value);
  const yearToRaw = f.elements['year_to'].value;
  let yearTo = type === 'one_time' ? yearFrom : yearToRaw ? Number(yearToRaw) : null;
  if (yearTo != null && yearTo < yearFrom) yearTo = yearFrom;
  const input = parseFormNumber(f.elements['value'].value);
  const payload = {
    id: id || uid(),
    type,
    year_from: yearFrom,
    year_to: yearTo,
    // obsazenost se zadává jako obsazenost, uložená je neobsazenost (stejně jako u nemovitosti)
    value: type === 'vacancy' ? 100 - input : input,
    note: f.elements['note'].value.trim() || null,
  };
  if (eventTargetKind(type)) payload.target_ids = eventTargets.slice();
  if (id) {
    const idx = state.events.findIndex((ev) => ev.id === id);
    if (idx !== -1) state.events[idx] = payload;
  } else {
    state.events.push(payload);
  }
  saveState();
  resetEventForm();
  renderCalculations();
  showSuccessToast(id ? 'Událost upravena' : 'Událost přidána');
}

/* ---------- SCÉNÁŘE (predikce) ---------- */

function runProjection(horizonYears, properties, loans, startYear) {
  return calc.projectPortfolio({
    properties: properties || state.properties,
    loans: loans || state.loans,
    settings: state.settings,
    events: state.events,
    horizonYears,
    startYear: startYear || CURRENT_YEAR,
  });
}

let scenarioRows = [];

function shortEventLabel(ev) {
  const base = EVENT_LABELS[ev.type] || ev.type;
  return `${base} ${eventValueText(ev)}`;
}

function saleChipText(s) {
  const tax = s.taxExempt ? 'bez daně' : `daň ${fmtMoney(s.estimatedSaleTax)}`;
  return `Prodej: ${escapeHtml(s.propertyName)}${s.owner === 'po' ? ' (PO)' : ''} · ${fmtMoney(s.saleProceeds)} (${tax})`;
}

function renderScenario() {
  const horizon = state.scenario.horizonYears;
  setValueIfNotFocused(document.getElementById('scenario-horizon'), horizon);
  document.getElementById('sc-kpi-end-equity-label').textContent = `Vlastní kapitál za ${horizon} let`;
  document.getElementById('sc-kpi-end-debt-label').textContent = `Dluh za ${horizon} let`;
  document.getElementById('sc-kpi-cumcf-label').textContent = `Cashflow za ${horizon} let`;

  const result = runProjection(horizon);
  const { rows, summary } = result;
  scenarioRows = rows;
  const last = rows[rows.length - 1];

  document.getElementById('sc-kpi-end-equity').textContent = fmtMoney(summary.endEquity);
  document.getElementById('sc-kpi-end-debt').textContent = fmtMoney(last.totalDebt);
  document.getElementById('sc-kpi-cagr-assets').textContent = fmtPercent(summary.cagrAssets);
  const cumEl = document.getElementById('sc-kpi-cumcf');
  cumEl.textContent = fmtMoney(summary.totalCashflow);
  cumEl.classList.toggle('t-neg', summary.totalCashflow < 0);
  cumEl.classList.toggle('t-pos', summary.totalCashflow >= 0);

  setFormula('sc-kpi-end-equity-formula', `Majetek ${fmtMoney(last.totalValue)} − dluh ${fmtMoney(last.totalDebt)}`);
  setFormula('sc-kpi-end-debt-formula', 'Zbývající jistina všech úvěrů');
  setFormula('sc-kpi-cagr-assets-formula', `Složený roční růst hodnoty nemovitostí za ${horizon} let`);
  setFormula('sc-kpi-cumcf-formula', 'Součet ročních cashflow (po splátkách úroku i jistiny)');

  document.getElementById('scenario-chart').innerHTML = buildLineChartSVG([
    { cls: 'chart-line-assets', points: rows.map((r) => ({ x: r.year, y: r.totalValue })) },
    { cls: 'chart-line-debt', points: rows.map((r) => ({ x: r.year, y: r.totalDebt })) },
    { cls: 'chart-line-equity', points: rows.map((r) => ({ x: r.year, y: r.equity })) },
  ]);

  renderScenarioTable();
}

function renderScenarioTable() {
  const key = 'scenario';
  applyTableMode(key);
  const rows = scenarioRows;
  const money = (v) => (v == null ? '<span class="t-faint">—</span>' : `<span class="num">${moneyHtml(v)}</span>`);
  const columns = [
    {
      label: 'Rok',
      cell: (r) => {
        const expandedYear = expandedYears.has(r.year);
        const hasEvent = r.sales.length > 0 || state.events.some((ev) => Number(ev.year_from) === r.year);
        return `<button type="button" class="year-pill" aria-expanded="${expandedYear}" aria-label="Rok ${r.year} - detail po nemovitostech"><span class="year-chevron"></span>${r.year}</button>${hasEvent ? '<span class="ev-dot" title="Událost v tomto roce"></span>' : ''}`;
      },
    },
    { label: 'Majetek', right: true, cell: (r) => money(r.totalValue) },
    { label: 'Dluh', right: true, cell: (r) => money(r.totalDebt) },
    { label: '<span class="m-full">Vlastní kapitál</span><span class="m-short">Kapitál</span>', right: true, cell: (r) => `<span class="font-medium">${money(r.equity)}</span>` },
    { label: 'Nájem', right: true, x: true, cell: (r) => `<span class="figure-positive">${money(r.totalRent)}</span>` },
    { label: 'Náklady', right: true, x: true, cell: (r) => `<span class="figure-negative">${money(r.totalCosts)}</span>` },
    { label: 'Úrok', right: true, x: true, cell: (r) => `<span class="figure-negative">${money(r.totalInterest)}</span>` },
    { label: 'Jistina', right: true, x: true, cell: (r) => `<span class="figure-negative">${money(r.totalPrincipal)}</span>` },
    { label: 'Nashrom. zhodnocení', right: true, x: true, cell: (r) => money(r.cumulativeGain) },
    {
      label: 'Cashflow',
      right: true,
      cell: (r) => `<span class="font-medium ${r.cashflow == null ? '' : r.cashflow < 0 ? 'figure-negative' : 'figure-positive'}">${money(r.cashflow)}</span>`,
    },
    {
      label: 'Událost',
      x: true,
      cell: (r) => {
        const starting = state.events.filter((ev) => Number(ev.year_from) === r.year);
        return (
          r.sales.map((s) => `<span class="event-chip event-chip-sale">${saleChipText(s)}</span>`).join('') +
          starting.map((ev) => `<span class="event-chip">${escapeHtml(shortEventLabel(ev))}</span>`).join('')
        );
      },
    },
  ];
  const cols = visibleColumns(columns, key);
  document.getElementById('scenario-thead').innerHTML = headHtml(cols);
  document.getElementById('scenario-tbody').innerHTML = rows
    .map((r) => {
      const main = `<tr class="year-row" data-year="${r.year}">${cols.map((c) => `<td class="${c.right ? 'text-right' : ''}">${c.cell(r)}</td>`).join('')}</tr>`;
      return expandedYears.has(r.year) ? main + `<tr class="year-detail"><td colspan="${cols.length}">${buildYearDetail(r)}</td></tr>` : main;
    })
    .join('');
}

/**
 * Detail roku po nemovitostech: stejné veličiny jako v hlavním řádku, ale za jednotlivé nemovitosti.
 * Ukazuje jen to, co jde spočítat: dluh a splátka nemovitosti se znají, když je úvěr přiřazený k nemovitosti
 * ("Financuje nemovitost" nebo zástava) - jinak je u ní pomlčka.
 */
function buildYearDetail(r) {
  const expanded = isExpanded('scenario');
  const hasFlows = r.cashflow != null;
  const loans = r.perLoan || [];
  const everyLoanLinked = state.loans.every((l) => Object.keys(calc.loanPropertyShares(l, state.properties)).length > 0);
  const money = (v, cls) => (v == null ? '<span class="t-faint">—</span>' : `<span class="${cls || ''}">${moneyHtml(v)}</span>`);

  const propertyCols = [
    { label: 'Nemovitost', f: (x) => `<span class="font-medium">${escapeHtml(x.pp.name)}</span> ${x.pp.owner === 'po' ? '<span class="badge badge-po">PO</span>' : ''}${x.pp.sold ? ' <span class="badge badge-linked">prodáno</span>' : ''}` },
    { label: 'Majetek', f: (x) => money(x.pp.value) },
    { label: 'Dluh', f: (x) => money(x.debt, 'figure-negative') },
    { label: 'Vlastní kapitál', xcol: true, f: (x) => money(x.equity) },
    { label: 'Nájem', xcol: true, f: (x) => (hasFlows ? money(x.pp.rent, 'figure-positive') : money(null)) },
    { label: 'Náklady', xcol: true, f: (x) => (hasFlows ? money(x.pp.costs, 'figure-negative') : money(null)) },
    { label: 'Splátka', xcol: true, f: (x) => money(x.service, 'figure-negative') },
    { label: 'Zhodnocení', xcol: true, f: (x) => (hasFlows ? money(x.pp.appreciation) : money(null)) },
    { label: 'Cashflow', f: (x) => money(x.cash, x.cash == null ? '' : x.cash < 0 ? 'figure-negative' : 'figure-positive') },
  ].filter((c) => expanded || !c.xcol);

  const propertyRows = (r.perProperty || [])
    .map((pp) => {
      const linked = loans.filter((l) => (l.shares && l.shares[pp.id]) > 0);
      const debtKnown = linked.length > 0 || everyLoanLinked;
      const debt = debtKnown ? linked.reduce((s, l) => s + l.balance * l.shares[pp.id], 0) : null;
      const service = debtKnown && hasFlows ? linked.reduce((s, l) => s + l.payment * l.shares[pp.id], 0) : null;
      const x = { pp, debt, service, equity: debt == null ? null : pp.value - debt, cash: service == null ? null : pp.cashflow - service };
      return `<tr>${propertyCols.map((c) => `<td>${c.f(x)}</td>`).join('')}</tr>`;
    })
    .join('');

  const sharesText = (l) => {
    const names = Object.keys(l.shares || {}).map((id) => propertyName(id)).filter(Boolean);
    return names.length ? escapeHtml(names.join(', ')) : '<span class="t-faint">—</span>';
  };
  const loanCols = [
    { label: 'Úvěr', f: (l) => `<span class="font-medium">${escapeHtml(l.bank)}</span>` },
    { label: 'Nemovitost', xcol: true, f: (l) => sharesText(l) },
    { label: 'Zůstatek', f: (l) => money(l.balance, 'figure-negative') },
    { label: 'Sazba', xcol: true, f: (l) => (hasFlows ? fmtPercent(l.rate) : '—') },
    { label: 'Úrok', f: (l) => (hasFlows ? money(l.interest, 'figure-negative') : '—') },
    { label: 'Jistina', f: (l) => (hasFlows ? money(l.principal) : '—') },
    { label: 'Splátky', xcol: true, f: (l) => (hasFlows ? money(l.payment, 'figure-negative') : '—') },
  ].filter((c) => expanded || !c.xcol);
  const loanRows = loans.map((l) => `<tr>${loanCols.map((c) => `<td>${c.f(l)}</td>`).join('')}</tr>`).join('');

  const active = state.events.filter((ev) => calc.eventAppliesInYear(ev, r.year));
  const eventsHtml = active.length
    ? `<div class="detail-title">Události v roce</div><div>${active
        .map((ev) => `<span class="event-chip">${escapeHtml(shortEventLabel(ev))}${eventTargetNames(ev) !== 'Všechny' ? ' · ' + escapeHtml(eventTargetNames(ev)) : ''}</span>`)
        .join('')}</div>`
    : '';

  const salesHtml = (r.sales || []).length
    ? `<div class="detail-title">Prodej</div>${r.sales
        .map((s) => {
          const bought = s.acquisitionPrice > 0 ? `koupeno za ${fmtMoney(s.acquisitionPrice)}, prodáno za ${fmtMoney(s.marketValue)}` : `prodáno za ${fmtMoney(s.marketValue)}`;
          const tax = s.taxExempt ? 'bez daně' : `daň ${fmtMoney(s.estimatedSaleTax)}`;
          return `<div class="text-sm"><strong>${escapeHtml(s.propertyName)}</strong>${s.owner === 'po' ? ' (PO)' : ''}: ${bought}, ${tax}, výtěžek ${fmtMoney(s.saleProceeds)}${s.loanFullyCleared ? ' · dluh splacen' : ''}</div>`;
        })
        .join('')}`
    : '';

  return `<div class="detail-panel">
    <div class="detail-title">Rok ${r.year} · podle nemovitostí</div>
    <div class="overflow-x-auto"><table class="subtbl">
      <thead><tr>${propertyCols.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${propertyRows || `<tr><td colspan="${propertyCols.length}" class="t-faint">Žádné nemovitosti</td></tr>`}</tbody>
    </table></div>
    ${
      loanRows
        ? `<div class="detail-title">Úvěry</div><div class="overflow-x-auto"><table class="subtbl">
      <thead><tr>${loanCols.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${loanRows}</tbody></table></div>`
        : ''
    }
    ${eventsHtml}
    ${salesHtml}
  </div>`;
}

function wireScenarioTable() {
  document.getElementById('scenario-tbody').addEventListener('click', (e) => {
    const row = e.target.closest('tr.year-row');
    if (!row) return;
    const year = Number(row.dataset.year);
    if (expandedYears.has(year)) expandedYears.delete(year);
    else expandedYears.add(year);
    renderScenarioTable();
    const pill = document.querySelector(`tr.year-row[data-year="${year}"] .year-pill`);
    if (pill && e.target.closest('.year-pill')) pill.focus({ preventScroll: true });
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
  if (!allPoints.length) return '<p class="text-sm t-faint">Zatím žádná data</p>';

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
    gridSvg += `<line class="chart-grid" x1="${padding}" y1="${yy}" x2="${width - padding}" y2="${yy}" stroke-width="1" />`;
    gridSvg += `<text class="chart-text" x="${padding - 8}" y="${yy + 4}" font-size="11" text-anchor="end">${fmtCompact(y)}</text>`;
  }

  let xTicksSvg = '';
  const tickCount = Math.min(maxX - minX, 10) || 1;
  for (let i = 0; i <= tickCount; i++) {
    const x = Math.round(minX + (i / tickCount) * (maxX - minX));
    xTicksSvg += `<text class="chart-text" x="${xScale(x)}" y="${height - padding + 18}" font-size="11" text-anchor="middle">${x}</text>`;
  }

  const pathsSvg = seriesList
    .map((s) => {
      const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.x).toFixed(1)} ${yScale(p.y).toFixed(1)}`).join(' ');
      return `<path class="chart-line ${s.cls}" d="${d}" />`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" class="w-full h-auto">
    ${gridSvg}
    <line class="chart-axis" x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke-width="1" />
    ${pathsSvg}
    ${xTicksSvg}
  </svg>`;
}

/* ---------- PŘEHLED (konkrétní rok / měsíc) ---------- */
/* Přehled i Scénáře čerpají z JEDNÉ simulace (calc.projectPortfolio) se stejnými scénářovými
   událostmi. Přehled si jen vybere rok; je-li dál než horizont Scénářů, simulace se prodlouží, takže
   události (včetně těch bez konce) platí dál a nic se po horizontu nevrací ke starému počítání. */

function pluralEvents(n) {
  if (n === 1) return 'událost';
  return n >= 2 && n <= 4 ? 'události' : 'událostí';
}

function wireOverviewControls() {
  const overviewState = state.overview;
  const yearInput = document.getElementById('overview-year');
  yearInput.value = overviewState.year;
  yearInput.addEventListener('input', () => {
    overviewState.year = Number(yearInput.value) || CURRENT_YEAR;
    saveState();
    renderOverview();
  });
  yearInput.addEventListener('blur', renderOverview);
  document.getElementById('overview-period-year').addEventListener('click', () => setOverviewPeriod('year'));
  document.getElementById('overview-period-month').addEventListener('click', () => setOverviewPeriod('month'));
  document.getElementById('overview-scenario-chip').addEventListener('click', () => showTab('tab-scenario'));
}

function setOverviewPeriod(period) {
  state.overview.period = period;
  saveState();
  renderOverview();
}

function renderOverview() {
  const overviewState = state.overview;
  document.getElementById('overview-period-year').classList.toggle('period-toggle-active', overviewState.period !== 'month');
  document.getElementById('overview-period-month').classList.toggle('period-toggle-active', overviewState.period === 'month');
  const selectedYear = overviewState.year || CURRENT_YEAR;
  setValueIfNotFocused(document.getElementById('overview-year'), selectedYear);

  const eventCount = state.events.length + derivedEvents().length;
  const chip = document.getElementById('overview-scenario-chip');
  chip.classList.toggle('hidden', !eventCount);
  chip.textContent = `Scénář: ${eventCount} ${pluralEvents(eventCount)}`;

  // Minulost appka neumí predikovat dopředu - zvolený minulý rok se místo toho
  // ZREKONSTRUUJE z dnešních hodnot (obrácené zhodnocení/umoření, viz
  // calc.rebaseToYear) a od NĚJ se pak nasimuluje jeden rok dopředu, aby šly
  // spočítat i tokové veličiny (cashflow...).
  const isPast = selectedYear < CURRENT_YEAR;
  let baseProperties = state.properties;
  let baseLoans = state.loans;
  let startYear = CURRENT_YEAR;
  let idx = Math.max(selectedYear - CURRENT_YEAR, 0);
  // horizont Scénářů je jen minimum - do vzdálenějšího roku se simulace prodlouží
  let horizon = Math.max(state.scenario.horizonYears, idx + 1);

  if (isPast) {
    const rebased = calc.rebaseToYear(state.properties, state.loans, state.settings, state.events, selectedYear, CURRENT_YEAR);
    baseProperties = rebased.properties;
    baseLoans = rebased.loans;
    startYear = selectedYear;
    idx = 0;
    horizon = 1;
  }

  const result = runProjection(horizon, baseProperties, baseLoans, startYear);
  idx = Math.min(idx, result.rows.length - 1);
  const row = result.rows[idx];

  const isMonth = overviewState.period === 'month';
  const div = isMonth ? 12 : 1;
  const per = isMonth ? 'měsíc' : 'rok';

  document.getElementById('kpi-assets').textContent = fmtMoney(row.totalValue);
  document.getElementById('kpi-debt').textContent = fmtMoney(row.totalDebt);
  document.getElementById('kpi-networth').textContent = fmtMoney(row.equity);
  document.getElementById('kpi-debtratio').textContent = row.totalValue > 0 ? fmtPercent(row.totalDebt / row.totalValue) : '0 %';
  document.getElementById('kpi-cashflow').textContent = fmtMoney((row.cashflow || 0) / div);
  document.getElementById('kpi-appreciation').textContent = fmtMoney((row.appreciationGain || 0) / div);
  document.getElementById('kpi-avg-growth').textContent = row.avgGrowthRate == null ? '—' : fmtPercent(row.avgGrowthRate);
  document.getElementById('kpi-inflation-loss').textContent = row.inflationRate == null ? '—' : fmtPercent(row.inflationRate);
  document.getElementById('kpi-inflation-loss-amount').textContent = row.inflationLoss == null ? '—' : fmtMoney((row.inflationLoss || 0) / div);
  document.getElementById('kpi-real-appreciation').textContent = fmtMoney((row.realAppreciation || 0) / div);

  document.getElementById('kpi-cashflow-label').textContent = isMonth ? 'Měsíční cashflow' : 'Roční cashflow';
  document.getElementById('kpi-appreciation-label').textContent = isMonth ? 'Měsíční zhodnocení' : 'Roční zhodnocení';
  document.getElementById('kpi-real-appreciation-label').textContent = isMonth ? 'Zbývá po inflaci (měsíc)' : 'Zbývá po inflaci (rok)';

  setFormula('kpi-assets-formula', row.cashReserve ? `Nemovitosti ${fmtMoney(row.realEstateValue)} + hotovost ${fmtMoney(row.cashReserve)}` : `Součet tržních hodnot nemovitostí`);
  setFormula('kpi-debt-formula', 'Zbývající jistina všech úvěrů');
  setFormula('kpi-networth-formula', `Majetek ${fmtMoney(row.totalValue)} − dluh ${fmtMoney(row.totalDebt)}`);
  setFormula('kpi-debtratio-formula', `Dluh ÷ majetek`);
  if (row.totalRent != null) {
    const oneTime = row.oneTime ? ` ${row.oneTime > 0 ? '+' : '−'} jednorázově ${fmtMoney(Math.abs(row.oneTime / div))}` : '';
    setFormula(
      'kpi-cashflow-formula',
      `Nájem ${fmtMoney(row.totalRent / div)} − náklady ${fmtMoney(row.totalCosts / div)} − úrok ${fmtMoney(row.totalInterest / div)} − jistina ${fmtMoney(row.totalPrincipal / div)}${oneTime}`
    );
    setFormula('kpi-appreciation-formula', `Růst hodnoty nemovitostí za ${per}`);
    setFormula('kpi-avg-growth-formula', `Zhodnocení ${fmtMoney(row.appreciationGain)} ÷ hodnota nemovitostí ${fmtMoney(row.realEstateValue)}`);
    setFormula('kpi-inflation-loss-formula', `Inflace v roce ${row.year}`);
    setFormula('kpi-real-appreciation-formula', `Zhodnocení − ztráta inflací ${fmtMoney((row.inflationLoss || 0) / div)}`);
  }

  const cashflowEl = document.getElementById('kpi-cashflow');
  cashflowEl.classList.toggle('t-neg', (row.cashflow || 0) < 0);
  cashflowEl.classList.toggle('t-pos', (row.cashflow || 0) >= 0);
  const realAppEl = document.getElementById('kpi-real-appreciation');
  realAppEl.classList.toggle('t-neg', (row.realAppreciation || 0) < 0);
  realAppEl.classList.toggle('t-pos', (row.realAppreciation || 0) >= 0);

  renderPledgeCapacity(row, selectedYear);
}

function renderPledgeCapacity(row, selectedYear) {
  const card = document.getElementById('pledge-purchase-card');
  const enabled = !!state.settings.pledge_financing_enabled;
  card.classList.toggle('hidden', !enabled);
  if (!enabled) return;
  const maxLtv = (Number(state.settings.pledge_max_ltv) || 0) / 100;
  // Zástava je pevná Kč částka (banka ji nezmenšuje jen proto, že hodnota
  // nemovitosti mezitím vzrostla) - proto se pro vybraný rok přebírá jen
  // PROJEKTOVANÁ tržní hodnota (row.perProperty), zatímco has_lien/lien_value
  // zůstává tak, jak je zadané u nemovitosti dnes.
  const projectedProperties = (row.perProperty || []).map((rp) => {
    const original = state.properties.find((p) => p.id === rp.id) || {};
    return { id: rp.id, market_value: rp.value, has_lien: original.has_lien, lien_value: original.lien_value };
  });
  // Úvěr, který ještě v tom roce nebyl sjednaný, ještě nemohl "spotřebovat"
  // zástavu žádné jiné nemovitosti.
  const activeLoans = state.loans.filter((l) => calc.yearOf(l.start_date, CURRENT_YEAR) <= selectedYear);
  const { freeCollateral, maxPurchasePrice } = calc.pledgePurchaseCapacity(projectedProperties, maxLtv, activeLoans);
  document.getElementById('pledge-free-collateral').textContent = fmtMoney(freeCollateral);
  document.getElementById('pledge-max-purchase').textContent = fmtMoney(maxPurchasePrice);
}

/* ---------- Záloha (export / import / smazání) ---------- */

function wireBackup() {
  document.getElementById('btn-export').addEventListener('click', exportBackup);
  document.getElementById('import-file').addEventListener('change', importBackup);
  document.getElementById('btn-clear').addEventListener('click', clearAllData);
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
      if (!(await customConfirm('Nahrání zálohy přepíše aktuální data. Pokračovat?', 'Nahrát a přepsat'))) return;
      setState(parsed);
      saveState();
      resetPropertyForm();
      resetLoanForm();
      resetEventForm();
      renderAll();
      showSuccessToast('Záloha nahrána');
    } catch (err) {
      alert('Soubor se nepodařilo přečíst - není to platná záloha.');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
}

async function clearAllData() {
  const where = window.authState.signedIn ? 'Smažou se i z tvého účtu.' : 'Nejsi přihlášen(a), data se nikde neukládají.';
  const confirmed = await confirmTwice(
    `Opravdu smazat všechna data? ${where} Tuto akci nelze vrátit zpět.`,
    'Fakt si tím jistý/á? Všechny nemovitosti, úvěry i nastavení zmizí a nedají se obnovit (pokud si je předtím nezálohuješ).',
    'Smazat'
  );
  if (!confirmed) return;
  setState(defaultState());
  clearLegacyLocalCopy();
  saveState();
  resetPropertyForm();
  resetLoanForm();
  resetEventForm();
  renderAll();
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
 * dočasnou změnu viewportu nespolehlivý napříč prohlížeči - tlačítka
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

/* ---------- Formuláře ---------- */

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
