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
};

// zrušené volby (dřív "Nákup bez hotovosti" v Nastavení): ze starších záloh a z účtu se při načtení odstraní
const REMOVED_SETTING_KEYS = ['pledge_financing_enabled', 'pledge_max_ltv'];

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

const BANK_COLORS = ['#2563eb', '#7c3aed', '#be185d', '#c2410c', '#047857', '#0e7490', '#b45309', '#4f46e5'];

function bankColor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return BANK_COLORS[hash % BANK_COLORS.length];
}

// Verze příloh se bere z adresy skriptu (?v=...), ať se loga po nasazení obnoví stejně jako ostatní soubory
const ASSET_VERSION = (() => {
  try {
    const el = document.querySelector('script[src*="js/app.js"]');
    return el ? new URL(el.src).searchParams.get('v') || '' : '';
  } catch (e) {
    return '';
  }
})();

// Původní loga bank (ikony z jejich webů, assets/banks). Název z dat se porovnává bez diakritiky a velikosti písmen.
const BANK_LOGOS = [
  { file: 'csas', names: ['ceska sporitelna', 'csas'] },
  { file: 'csob', names: ['csob', 'hypotecni banka'] },
  { file: 'kb', names: ['komercni banka', 'kb'] },
  { file: 'unicredit', names: ['unicredit bank', 'unicredit'] },
  { file: 'rb', names: ['raiffeisenbank', 'raiffeisen', 'rb'] },
  { file: 'moneta', names: ['moneta money bank', 'moneta'] },
  { file: 'mbank', names: ['mbank'] },
  { file: 'fio', names: ['fio banka', 'fio'] },
  { file: 'airbank', names: ['air bank', 'airbank'] },
];

function normBankName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function bankLogoUrl(name) {
  const n = normBankName(name);
  if (!n) return null;
  const hit = BANK_LOGOS.find((b) => b.names.some((alias) => n === alias || n.startsWith(alias + ' ')));
  return hit ? `assets/banks/${hit.file}.png${ASSET_VERSION ? '?v=' + ASSET_VERSION : ''}` : null;
}

const GENERIC_BANK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/></svg>';

/** Ikona banky: původní logo, u neznámé banky barevné písmeno, u prázdného názvu obecná budova banky. */
function bankLogoHtml(name, cls = 'bank-logo') {
  const url = bankLogoUrl(name);
  if (url) return `<img class="${cls}" src="${url}" alt="" width="24" height="24" />`;
  const trimmed = String(name || '').trim();
  if (!trimmed) return `<span class="${cls} bank-logo-generic">${GENERIC_BANK_ICON}</span>`;
  return `<span class="${cls} bank-logo-fallback" style="background:${bankColor(trimmed)}">${escapeHtml(trimmed.charAt(0).toUpperCase())}</span>`;
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

/**
 * Rozbalovací výběr banky: u každé položky její logo, nahoře v poli logo vybrané banky a na konci seznamu volba
 * "Vlastní", po které se do pole dá napsat libovolný název (psát jde vždy, "Vlastní" to jen zviditelní).
 */
function makeCombobox(input, getOptions) {
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.classList.add('has-lead');

  const lead = document.createElement('span');
  lead.className = 'combo-lead';
  lead.setAttribute('aria-hidden', 'true');
  wrap.appendChild(lead);

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
  let customMode = false;
  const CUSTOM = '\u0000custom';

  function refreshLead() {
    lead.innerHTML = bankLogoHtml(input.value, 'combo-lead-logo');
  }

  function build() {
    const all = getOptions();
    const query = typed ? input.value.trim().toLowerCase() : '';
    const known = query ? all.filter((o) => o.toLowerCase().includes(query)) : all;
    items = known.concat(CUSTOM);
    const current = input.value.trim().toLowerCase();
    let html = known
      .map(
        (o, i) => `<div class="combo-item${i === active ? ' is-active' : ''}${o.toLowerCase() === current ? ' is-selected' : ''}" role="option" data-i="${i}">
          ${bankLogoHtml(o, 'combo-logo')}<span>${escapeHtml(o)}</span></div>`
      )
      .join('');
    if (typed && query && !all.some((o) => o.toLowerCase() === query)) {
      html += `<div class="combo-hint">Vlastní: „${escapeHtml(input.value.trim())}“</div>`;
    }
    // "Vlastní" je vždy vidět na dně seznamu, i když je seznam delší a posouvá se
    html += `<div class="combo-foot"><div class="combo-item combo-custom${known.length === active ? ' is-active' : ''}" role="option" data-i="${known.length}">
      <span class="combo-logo bank-logo-generic">${GENERIC_BANK_ICON}</span><span>Vlastní…</span></div></div>`;
    list.innerHTML = html;
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
    if (value === CUSTOM) {
      // Vlastní: pole se vyprázdní (je-li v něm známá banka) a dá se psát cokoli
      const all = getOptions();
      if (all.some((o) => o.toLowerCase() === input.value.trim().toLowerCase())) input.value = '';
      customMode = true;
      input.placeholder = 'Napiš název';
      close();
      refreshLead();
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
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

  if (input.form) {
    input.form.addEventListener('reset', () => {
      close();
      customMode = false;
      input.placeholder = '';
      setTimeout(refreshLead, 0);
    });
  }
  input.addEventListener('focus', () => {
    typed = false;
    if (!customMode) open();
  });
  input.addEventListener('input', () => {
    typed = true;
    active = -1;
    refreshLead();
    if (!customMode) open();
  });
  input.addEventListener('change', refreshLead);
  input.addEventListener('blur', () => {
    close();
    customMode = false;
    input.placeholder = '';
  });
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
      customMode = false;
      open();
    } else {
      close();
    }
  });
  input._comboRefresh = refreshLead;
  refreshLead();
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
  // doplněná data se hned uloží do pracovní kopie, ať se příště nedoplňují znovu jiným dnem
  if (normalizeStateData()) persistWorkingCopy();
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
    const valid = (yy, mm, dd) => {
      if (yy < 1900 || yy > 2100) return false;
      const date = new Date(yy, mm - 1, dd);
      return date.getFullYear() === yy && date.getMonth() === mm - 1 && date.getDate() === dd;
    };
    let m = /^(\d{1,2})\s*[.,\-/ ]\s*(\d{1,2})\s*[.,\-/ ]\s*(\d{4})$/.exec(t);
    if (m) {
      d = Number(m[1]);
      mo = Number(m[2]);
      y = Number(m[3]);
    } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) {
      y = Number(m[1]);
      mo = Number(m[2]);
      d = Number(m[3]);
    } else if (/^\d{6,8}$/.test(t)) {
      // jen číslice (číselná klávesnice bez teček): den a měsíc po 1-2 číslicích, rok poslední čtyři
      const yearPart = Number(t.slice(-4));
      const front = t.slice(0, -4);
      const options = [];
      if (front.length === 2) options.push([Number(front[0]), Number(front[1])]);
      if (front.length === 3) options.push([Number(front.slice(0, 1)), Number(front.slice(1))], [Number(front.slice(0, 2)), Number(front.slice(2))]);
      if (front.length === 4) options.push([Number(front.slice(0, 2)), Number(front.slice(2))]);
      const ok = options.filter(([dd, mm]) => valid(yearPart, mm, dd));
      if (ok.length !== 1) return null; // nejednoznačné (např. 1122026) nebo neplatné
      [d, mo] = ok[0];
      y = yearPart;
    } else return null;
    if (!valid(y, mo, d)) return null;
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
    text.setAttribute('inputmode', 'decimal');
    if (native.dataset.placeholder) text.placeholder = native.dataset.placeholder;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'date-btn';
    button.tabIndex = -1;
    button.setAttribute('aria-label', 'Vybrat datum');
    button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>';
    button.setAttribute('aria-hidden', 'true');
    wrap.append(text, native, button);
    native.classList.add('date-native');
    native.tabIndex = -1;
    native.setAttribute('aria-label', 'Vybrat datum v kalendáři');

    const sync = () => {
      const iso = valueDesc.get.call(native);
      text.value = iso ? fmtDate(iso) : '';
      text.classList.remove('is-invalid');
      delete text.dataset.typedInvalid;
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
        text.dataset.typedInvalid = '1';
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
    // Na telefonu otevře kalendář přímo dotyk na průhledné pole nad ikonou (jediná cesta, která funguje i na iPhonu),
    // na počítači ho navíc otevře showPicker.
    const coarsePointer = window.matchMedia('(pointer: coarse)');
    native.addEventListener('click', () => {
      if (coarsePointer.matches || typeof native.showPicker !== 'function') return;
      try {
        native.showPicker();
      } catch (err) {
        /* už je otevřený, nebo ho prohlížeč nepovolil */
      }
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
  renderRefinancingTable();
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
const LEGACY_REFINANCE_KEYS = ['refinance_date', 'refinance_rate', 'refinance_years', 'refinance_merge_ids'];

/** Starší úvěr měl jedno refinancování v polích refinance_*; převede se na seznam událostí `refinancings` (stejné id pro stejný úvěr). */
function migrateLegacyRefinancing(loan) {
  if (!LEGACY_REFINANCE_KEYS.some((k) => k in loan)) return loan;
  const copy = { ...loan };
  const list = Array.isArray(copy.refinancings) ? copy.refinancings.slice() : [];
  if (copy.refinance_date) {
    list.push({
      id: 'refi-' + copy.id,
      date: copy.refinance_date,
      rate: copy.refinance_rate != null && copy.refinance_rate !== '' ? Number(copy.refinance_rate) : null,
      years: Number(copy.refinance_years) > 0 ? Number(copy.refinance_years) : null,
      merge_ids: Array.isArray(copy.refinance_merge_ids) ? copy.refinance_merge_ids.slice() : [],
    });
  }
  for (const k of LEGACY_REFINANCE_KEYS) delete copy[k];
  if (list.length) copy.refinancings = list;
  return copy;
}

function normalizeLoanList(loans, properties) {
  const alloc = {};
  const byId = new Map(properties.map((p) => [p.id, p]));
  const list = loans.map((l) => {
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
  return list.map(migrateLegacyRefinancing);
}

/**
 * Chybějící datum pořízení nemovitosti a zřízení úvěru se doplní dneškem a od té chvíle zůstává stejné (nesmí se
 * posouvat každý den, jinak by se časový test ani fixace nikdy nedokončily). Vrací, jestli se něco doplnilo.
 */
function stampMissingDates() {
  const today = toInputDate(new Date());
  let stamped = false;
  for (const p of state.properties) {
    if (!p.acquisition_date) {
      p.acquisition_date = today;
      stamped = true;
    }
  }
  for (const l of state.loans) {
    if (!l.start_date) {
      l.start_date = today;
      stamped = true;
    }
  }
  return stamped;
}

function normalizeStateData() {
  state.loans = normalizeLoanList(state.loans, state.properties);
  for (const key of REMOVED_SETTING_KEYS) delete state.settings[key];
  return stampMissingDates();
}

/** Podoba dat bez ohledu na verzi záznamu (porovnání s cloudem). */
function normalizeSnapshot(snapshot) {
  const copy = JSON.parse(JSON.stringify(snapshot || {}));
  copy.loans = normalizeLoanList(Array.isArray(copy.loans) ? copy.loans : [], Array.isArray(copy.properties) ? copy.properties : []);
  if (copy.settings) for (const key of REMOVED_SETTING_KEYS) delete copy.settings[key];
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
  const totals = { rent: 0, value: 0, lien: 0, freed: 0, appreciated: 0, growthWeighted: 0, yield: 0, quality: 0 };

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
    };
    r.yield = (Number(p.rent) || 0) * 12 * (1 - (Number(p.vacancy_rate) || 0)) - (Number(p.monthly_costs) || 0) * 12;
    r.q = calc.propertyQuality(p);
    totals.quality += r.q.score * marketValue;
    totals.yield += r.yield;
    totals.rent += Number(p.rent) || 0;
    totals.value += marketValue;
    totals.lien += own + crossSum;
    totals.freed += r.freed;
    totals.appreciated += r.av;
    totals.growthWeighted += marketValue * (Number(p.growth_rate) || 0);
    return r;
  });
  const avgGrowth = totals.value > 0 ? totals.growthWeighted / totals.value : 0;
  const dash = '<span class="t-faint">—</span>';

  const columns = [
    { label: 'Nemovitost', cell: (r) => `${rankDotHtml(r.q)}${r.p.never_sell ? lockIconHtml() : ''}<span class="font-medium">${escapeHtml(r.p.name)}</span> ${ownerBadge(r.p)}`, total: () => 'Celkem' },
    { label: 'Nájem', right: true, cell: (r) => (r.p.rent ? `<span class="rent-positive num">+${moneyHtml(r.p.rent)}</span>` : dash), total: () => moneyHtml(totals.rent) },
    { label: 'Tržní hodnota', right: true, cell: (r) => `<span class="num">${moneyHtml(r.marketValue)}</span>`, total: () => moneyHtml(totals.value) },
    {
      label: 'Kvalita',
      x: true,
      cell: (r) => rankBadgeHtml(r.q),
      total: () => {
        if (!(totals.value > 0)) return '';
        const score = totals.quality / totals.value;
        return rankBadgeHtml({ score, band: calc.qualityBand(score) });
      },
    },
    { label: 'Čistý výnos /rok', right: true, x: true, cell: (r) => `<span class="num ${r.yield < 0 ? 'figure-negative' : 'figure-positive'}">${moneyHtml(r.yield)}</span>`, total: () => moneyHtml(totals.yield) },
    {
      label: 'Zástava',
      right: true,
      x: true,
      cell: (r) => {
        const lines = [];
        const bankLine = (bank, amount) => `<span class="pledge-line">${bankLogoHtml(bank, 'bank-logo bank-logo-sm')}${escapeHtml(bank || '?')} <span class="num t-muted">${fmtMoney(amount)}</span></span>`;
        if (r.p.has_lien) lines.push(bankLine(r.p.lien_bank, r.own));
        for (const c of r.cross) lines.push(bankLine(c.bank, c.amount));
        return lines.length ? lines.join('<br>') : dash;
      },
      total: () => `<span class="num">${fmtMoney(totals.lien)}</span>`,
    },
    { label: 'Volné k zastavení', right: true, x: true, cell: (r) => `<span class="num">${moneyHtml(r.freed)}</span>`, total: () => moneyHtml(totals.freed) },
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

/** Volná hodnota k zastavení podle hodnot ve formuláři: hodnota − jiná zástava − zástavy za úvěry (řádky ve formuláři). */
function propertyFreeFromForm() {
  const f = propertyForm();
  const market = parseFormNumber(f.elements['market_value'].value);
  const lien = f.elements['has_lien'].checked ? parseFormNumber(f.elements['lien_value'].value) : 0;
  const cross = readPropertyPledges().reduce((sum, p) => sum + (p.amount > 0 ? p.amount : 0), 0);
  return { market, lien, cross, free: market - lien - cross };
}

/* ---------- Zástavy ve formuláři nemovitosti: řádek = úvěr + částka (ukládá se do úvěru, vidět je u obou) ---------- */

/** Řádky zástav z formuláře nemovitosti: [{ loanId, amount, row }]. */
function readPropertyPledges() {
  return Array.from(document.querySelectorAll('#property-pledge-list .ppledge-row'))
    .map((row) => ({ loanId: row.querySelector('.ppledge-loan').value, amount: parseFormNumber(row.querySelector('.ppledge-amount').value), row }))
    .filter((p) => p.loanId);
}

function pledgeLoanOptionsHtml(selectedId) {
  return state.loans
    .map((l) => `<option value="${l.id}"${l.id === selectedId ? ' selected' : ''}>${escapeHtml(l.bank)} · úvěr ${fmtMoney(l.amount)}</option>`)
    .join('');
}

/** Úvěr, který už má řádek jinde, nejde vybrat podruhé (jedna zástava na úvěr a nemovitost). */
function refreshPledgeLoanOptions() {
  const rows = Array.from(document.querySelectorAll('#property-pledge-list .ppledge-row'));
  const used = rows.map((row) => row.querySelector('.ppledge-loan').value);
  rows.forEach((row, i) => {
    row.querySelectorAll('.ppledge-loan option').forEach((opt) => {
      opt.disabled = opt.value !== used[i] && used.includes(opt.value);
    });
    const loan = state.loans.find((l) => l.id === used[i]);
    row.querySelector('.ppledge-logo').innerHTML = bankLogoHtml(loan ? loan.bank : '');
  });
}

function renderPropertyPledges(draft) {
  const box = document.getElementById('property-pledge-list');
  if (!box) return;
  const items = (draft || []).filter((p) => state.loans.some((l) => l.id === p.loanId));
  const add = document.getElementById('property-pledge-add');
  if (!state.loans.length) {
    box.innerHTML = '<p class="text-sm t-faint">Zatím žádné úvěry, zástava se přiřazuje k úvěru.</p>';
    add.disabled = true;
    updatePropertyBadges();
    return;
  }
  add.disabled = false;
  const head = items.length
    ? '<div class="ppledge-head" aria-hidden="true"><span></span><span>Úvěr</span><span>Zastavená částka</span><span></span></div>'
    : '';
  box.innerHTML =
    head +
    items
    .map(
      (p) => `<div class="ppledge-row">
        <span class="ppledge-logo"></span>
        <select class="input ppledge-loan" aria-label="Úvěr">${pledgeLoanOptionsHtml(p.loanId)}</select>
        <div class="ppledge-amount-wrap"><input class="input ppledge-amount" data-unit="money" aria-label="Zastavená částka" /></div>
        <button type="button" class="ppledge-remove" aria-label="Odebrat zástavu" title="Odebrat zástavu"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        <p class="pledge-msg hidden"></p>
      </div>`
    )
    .join('');
  box.querySelectorAll('.ppledge-row').forEach((row, i) => {
    const input = row.querySelector('.ppledge-amount');
    enhanceUnitInput(input, 'money');
    setFormattedValue(input, items[i].amount || '');
  });
  refreshPledgeLoanOptions();
  updatePropertyBadges();
}

/** Částku zástavy drží v mezích 1 Kč až volná hodnota nemovitosti (bez ostatních řádků a jiné zástavy). */
function clampPropertyPledge(row) {
  const input = row.querySelector('.ppledge-amount');
  const { market, lien } = propertyFreeFromForm();
  const others = readPropertyPledges().filter((p) => p.row !== row).reduce((sum, p) => sum + (p.amount > 0 ? p.amount : 0), 0);
  const max = Math.max(0, market - lien - others);
  const amount = parseFormNumber(input.value);
  if (amount > max) {
    setFormattedValue(input, Math.floor(max));
    showPledgeMessage(row, `Víc než volných ${fmtMoney(max)} zastavit nejde.`);
  } else if (!(amount > 0)) {
    setFormattedValue(input, Math.floor(max));
  }
}

function addPropertyPledge() {
  const used = readPropertyPledges().map((p) => p.loanId);
  const loan = state.loans.find((l) => !used.includes(l.id));
  if (!loan) {
    showFormError('property-form-error', 'Každý úvěr už má u této nemovitosti zástavu.');
    return;
  }
  const { market, lien, cross } = propertyFreeFromForm();
  const free = Math.max(0, market - lien - cross);
  if (free < 1) {
    showFormError('property-form-error', 'Z této nemovitosti už není co zastavit.');
    return;
  }
  const draft = readPropertyPledges().map((p) => ({ loanId: p.loanId, amount: p.amount }));
  draft.push({ loanId: loan.id, amount: Math.floor(Math.min(free, Number(loan.amount) || free)) });
  renderPropertyPledges(draft);
  showFormError('property-form-error', '');
  updatePropertyFreeReadout();
}

function updatePropertyFreeReadout() {
  const el = document.getElementById('property-free-pledge');
  if (!el) return;
  const { market, lien, cross, free } = propertyFreeFromForm();
  el.classList.toggle('is-over', free < 0);
  el.innerHTML =
    free < 0
      ? `Zástavy přesahují hodnotu nemovitosti o <strong>${fmtMoney(-free)}</strong>`
      : `Hodnota <strong>${fmtMoney(market)}</strong> · zastaveno <strong>${fmtMoney(lien + cross)}</strong> · volné k zastavení <strong>${fmtMoney(free)}</strong>`;
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
/** Rozumná výchozí částka zástavy u úvěru: tolik, kolik úvěru ještě chybí do výše úvěru (nejvýš volná hodnota nemovitosti). */
function defaultLoanPledge(row) {
  const free = Number(row.dataset.free) || 0;
  const loanAmount = parseFormNumber(loanForm().elements['amount'].value);
  if (!(loanAmount > 0)) return Math.floor(free);
  const others = Array.from(document.querySelectorAll('#loan-collateral-checklist .pledge-row'))
    .filter((r) => r !== row && r.querySelector('.loan-collateral-checkbox').checked)
    .reduce((sum, r) => sum + (parseFormNumber(r.querySelector('.loan-collateral-amount').value) || 0), 0);
  const remaining = loanAmount - others;
  return Math.floor(Math.min(free, remaining > 0 ? remaining : loanAmount));
}

function clampPledgeAmount(row) {
  const input = row.querySelector('.loan-collateral-amount');
  const free = Number(row.dataset.free) || 0;
  const amount = parseFormNumber(input.value);
  if (amount > free) {
    setFormattedValue(input, Math.floor(free));
    showPledgeMessage(row, `Víc než volných ${fmtMoney(free)} zastavit nejde.`);
  } else if (!(amount > 0)) {
    setFormattedValue(input, defaultLoanPledge(row));
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
        setFormattedValue(row.querySelector('.loan-collateral-amount'), defaultLoanPledge(row));
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

const MONTH_SHORT = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];

/** Jaká část roku je v řádku: u neúplného (letošního) roku např. "říj–pro", jinak prázdné. */
function monthRange(months) {
  if (!months || months >= 12) return '';
  return months === 1 ? 'pro' : `${MONTH_SHORT[12 - months]}–pro`;
}

/* ---------- Popup bublina: otevře se kliknutím na tlačítko, zavře se kliknutím mimo, klávesou Esc nebo křížkem ---------- */

const popoverContent = new Map(); // id -> HTML bubliny (plní se při vykreslení tabulek)
let popoverEl = null;
let popoverTrigger = null;

function registerPopover(id, html) {
  popoverContent.set(id, html);
  return id;
}

function closePopover() {
  if (popoverEl) popoverEl.classList.add('hidden');
  if (popoverTrigger) {
    popoverTrigger.setAttribute('aria-expanded', 'false');
    popoverTrigger.classList.remove('is-open');
  }
  popoverTrigger = null;
}

/** Bublina se drží u tlačítka: pod ním, nebo nad ním, když dole není místo; do stran se vejde na obrazovku. */
function positionPopover() {
  if (!popoverEl || !popoverTrigger) return;
  if (!popoverTrigger.isConnected) {
    closePopover();
    return;
  }
  const r = popoverTrigger.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) {
    closePopover();
    return;
  }
  const margin = 8;
  const body = popoverEl.querySelector('.popover-body');
  const keptScroll = body ? body.scrollTop : 0;
  if (body) body.style.maxHeight = ''; // změří se přirozená výška; při přepočtu (scroll, změna okna) se začíná znovu
  const width = popoverEl.offsetWidth;
  let height = popoverEl.offsetHeight;
  const left = Math.max(margin, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - margin));
  // bublina jde na stranu, kam se vejde; když se nevejde nikam, zkrátí se (obsah se v ní posouvá)
  const spaceBelow = window.innerHeight - margin - (r.bottom + 10);
  const spaceAbove = r.top - 10 - margin;
  const above = height > spaceBelow && spaceAbove > spaceBelow;
  const space = above ? spaceAbove : spaceBelow;
  if (body && height > space) {
    body.style.maxHeight = `${Math.max(120, Math.floor(space - (height - body.offsetHeight)))}px`;
    body.scrollTop = keptScroll;
    height = popoverEl.offsetHeight;
  }
  const top = above ? r.top - 10 - height : r.bottom + 10;
  popoverEl.style.left = `${Math.round(left)}px`;
  popoverEl.style.top = `${Math.round(top)}px`;
  popoverEl.style.setProperty('--arrow-x', `${Math.round(Math.max(16, Math.min(r.left + r.width / 2 - left, width - 16)))}px`);
  popoverEl.classList.toggle('is-above', above);
}

function openPopover(trigger) {
  if (popoverTrigger === trigger) {
    closePopover();
    return;
  }
  closePopover();
  const html = popoverContent.get(trigger.dataset.pop);
  if (!html) return;
  if (!popoverEl) {
    popoverEl = document.createElement('div');
    popoverEl.className = 'popover hidden';
    popoverEl.setAttribute('role', 'dialog');
    document.body.appendChild(popoverEl);
  }
  popoverEl.innerHTML = `<button type="button" class="popover-close" aria-label="Zavřít">&times;</button><div class="popover-body">${html}</div>`;
  popoverEl.setAttribute('aria-label', trigger.getAttribute('aria-label') || trigger.textContent.trim());
  popoverEl.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  trigger.classList.add('is-open');
  popoverTrigger = trigger;
  positionPopover();
}

function wirePopovers() {
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-pop]');
    if (trigger) {
      e.preventDefault();
      openPopover(trigger);
      return;
    }
    if (e.target.closest('.popover-close')) {
      const t = popoverTrigger;
      closePopover();
      if (t) t.focus();
      return;
    }
    if (popoverTrigger && !e.target.closest('.popover')) closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popoverTrigger) {
      const t = popoverTrigger;
      closePopover();
      t.focus();
    }
  });
  window.addEventListener('resize', positionPopover);
  // posouvání obsahu uvnitř bubliny ji nesmí přepočítávat (vrátilo by ho na začátek)
  window.addEventListener(
    'scroll',
    (e) => {
      if (popoverEl && e.target instanceof Node && popoverEl.contains(e.target)) return;
      positionPopover();
    },
    true
  );
}

const MONTH_NAMES = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

/** Malé "i" u neúplného (letošního) roku: po kliknutí řekne, za jaké období řádek je. */
function periodInfoButton(months) {
  if (!months || months >= 12) return '';
  const word = months === 1 ? 'měsíc' : months < 5 ? 'měsíce' : 'měsíců';
  const range = months === 1 ? 'prosinec' : `${MONTH_NAMES[12 - months]} až prosinec`;
  const id = registerPopover(
    `period:${months}`,
    `<div class="popover-title">Neúplný rok</div><p>Letos zbývá ${months} ${word} (${range}). Nájem, splátky a cashflow jsou jen za tyto měsíce, majetek a dluh jsou dnešní. Další roky jsou celé, od ledna do prosince.</p>`
  );
  return `<button type="button" class="info-btn" data-pop="${id}" aria-haspopup="dialog" aria-expanded="false" aria-label="Za jaké období je tento rok" title="Za jaké období je tento rok">i</button>`;
}

/** Částka v Kč na 1 mil. hodnoty ročně (nájem po nákladech), např. "30 000 Kč". */
const fmtPerMillion = (n) => `${fmtNumber(n, 0)} Kč`;

/**
 * Vysvětlení v bublině prodeje: proč se prodala právě tahle nemovitost a jak dopadla proti ostatním. Rozhoduje celkové
 * hodnocení kvality (výnos z nájmu na 1 mil. hodnoty, zhodnocení, stav, lokalita, rekonstrukce, energetický štítek).
 */
function saleWhyHtml(sale) {
  if (sale.reason === 'po') {
    return '<div class="popover-sub">Proč se prodala</div><p>PO se prodává co nejdřív: nemá časový test a daň z prodeje se platí vždy, další zhodnocení by jen zvětšovalo daň.</p>';
  }
  const cmp = sale.comparison;
  const trigger =
    sale.threshold > 0
      ? `<p class="popover-note">Prodej se spustil, protože nastřádané zhodnocení ${fmtMoney(sale.triggeredByGain)} dosáhlo prahu ${fmtMoney(sale.threshold)}. Výtěžek šel na umoření dluhu.</p>`
      : '';
  if (!cmp) {
    return `<div class="popover-sub">Proč se prodala</div><p>Nejméně výkonná z těch, které už prošly časovým testem: nájem ${fmtPerMillion((sale.yieldPct || 0) * 1e6)} ročně na 1 mil. hodnoty, zhodnocení ${fmtPercent(sale.growth)}.</p>${trigger}`;
  }
  const eligible = cmp.rows.filter((r) => r.eligible);
  const me = cmp.rows.find((r) => r.chosen);
  const others = eligible.filter((r) => !r.chosen);
  const points = (r) => Math.round(r.quality.score);
  let why;
  if (cmp.decidedBy === 'only') {
    why = `Jediná nemovitost, která už prošla časovým testem. Hodnocení kvality ${points(me)} z 100.`;
  } else {
    const scores = others.map(points);
    const low = Math.min(...scores);
    const high = Math.max(...scores);
    why = `Nejnižší hodnocení kvality ze ${eligible.length} nemovitostí po časovém testu: ${points(me)} z 100 (ostatní ${low === high ? low : `${low} až ${high}`}).`;
  }
  const weak = cmp.parts
    .filter((p) => p.known && p.score < 60)
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map(qualityPartPhrase);
  if (weak.length) why += ` Nejvíc ji táhne dolů: ${weak.join(', ')}.`;
  const skipNote = (r) =>
    r.reason === 'locked'
      ? 'neprodává se, nastaveno u nemovitosti'
      : r.reason === 'po'
        ? 'PO, prodává se zvlášť'
        : r.reason === 'minimum'
          ? 'prodej by srazil portfolio pod minimum'
          : `před časovým testem, zbývá ${escapeHtml(r.timeTestText)}`;
  const table = `<table class="popover-table">
    <thead><tr><th>Nemovitost</th><th>Kvalita</th><th>Nájem /1 mil.</th><th>Růst</th></tr></thead>
    <tbody>${cmp.rows
      .map(
        (r) => `<tr class="${r.chosen ? 'is-chosen' : r.eligible ? '' : 'is-muted'}"><td>${escapeHtml(r.name)}${r.chosen ? ' <span class="chip-tag">prodáno</span>' : ''}${
          r.eligible ? '' : `<span class="popover-sub-note">${skipNote(r)}</span>`
        }</td><td>${rankBadgeHtml(r.quality, false)}</td><td class="num">${fmtPerMillion(r.perMillion)}</td><td class="num">${fmtPercent(r.growth)}</td></tr>`
      )
      .join('')}</tbody></table>`;
  return `<div class="popover-sub">Proč se prodala</div><p>${why}</p><div class="popover-sub">Porovnání s ostatními</div>${table}${trigger}`;
}

/** Štítek prodeje ve Scénářích: jen název nemovitosti, podrobnosti a důvod jsou v bublině po kliknutí. */
function saleChipHtml(sale, year) {
  const rows = [['Prodáno za', fmtMoney(sale.marketValue)]];
  if (sale.acquisitionPrice > 0) rows.push(['Koupeno za', fmtMoney(sale.acquisitionPrice)]);
  rows.push(['Daň z prodeje', sale.taxExempt ? 'žádná' : fmtMoney(sale.estimatedSaleTax)]);
  rows.push(['Výtěžek', fmtMoney(sale.saleProceeds)]);
  rows.push(['Dluh po prodeji', sale.loanFullyCleared ? 'splacen celý' : 'zbytek se splácí dál']);
  const id = registerPopover(
    `sale:${year}:${sale.propertyId}`,
    `<div class="popover-title">Prodej: ${escapeHtml(sale.propertyName)}${sale.owner === 'po' ? ' <span class="badge badge-po">PO</span>' : ''}</div>
    <dl class="popover-list">${rows.map(([k, v]) => `<dt>${k}</dt><dd class="num">${v}</dd>`).join('')}</dl>
    ${saleWhyHtml(sale)}`
  );
  return `<button type="button" class="event-chip event-chip-sale" data-pop="${escapeHtml(id)}" aria-haspopup="dialog" aria-expanded="false" aria-label="Prodej: ${escapeHtml(sale.propertyName)}, detail" title="Detail prodeje">${escapeHtml(sale.propertyName)}</button>`;
}

/** Poznámky k úvěru (sloučení, vlastní poznámka) jsou v bublině po kliknutí na "i", aby byl řádek tabulky jednořádkový. */
function loanInfoButton(loan, mergeText) {
  const capitalized = mergeText ? mergeText.charAt(0).toUpperCase() + mergeText.slice(1) : '';
  const id = registerPopover(
    `loan:${loan.id}`,
    `<div class="popover-title">${escapeHtml(loan.bank)}</div>${capitalized ? `<p>${escapeHtml(capitalized)}.</p>` : ''}${loan.note ? `<p>${escapeHtml(loan.note)}</p>` : ''}`
  );
  return `<button type="button" class="info-btn" data-pop="${escapeHtml(id)}" aria-haspopup="dialog" aria-expanded="false" aria-label="Poznámky k úvěru ${escapeHtml(loan.bank)}" title="Poznámky">i</button>`;
}

/** Splátkový kalendář úvěru (jako list "Roky" v bankovní kalkulačce): úrok, jistina a podíl úroku po letech. */
function loanScheduleHtml(loan, expanded) {
  const sch = calc.loanSchedule(loan, { events: state.events, startYear: CURRENT_YEAR, maxYears: 40, loans: state.loans });
  if (!sch.rows.length) return '<p class="text-sm t-faint">Nic ke splácení</p>';
  const monthYear = (abs) => `${String((abs % 12) + 1).padStart(2, '0')}/${Math.floor(abs / 12)}`;
  const notes = [];
  if (loan.note) notes.push(escapeHtml(loan.note));
  if (sch.mergedInto) {
    const to = state.loans.find((x) => x.id === sch.mergedInto.to);
    notes.push(`Od ${monthYear(sch.mergedInto.abs)} sloučeno do úvěru ${to ? escapeHtml(to.bank) : 'jiného úvěru'}, dál se neplatí.`);
  }
  for (const m of sch.merges) notes.push(`Od ${monthYear(m.abs)} převzato ${fmtMoney(m.amount)} z úvěru ${escapeHtml(m.bank)}, zůstatek se o tuto částku zvýší.`);
  const notesHtml = notes.length ? `<p class="text-xs t-muted mb-2">${notes.join('<br>')}</p>` : '';
  const body = sch.rows
    .map((r) => {
      const share = Math.round(r.interestShare * 100);
      return `<tr>
        <td class="font-medium">${r.year}${periodInfoButton(r.months)}</td>
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
    ${notesHtml}
    <div class="overflow-x-auto"><table class="subtbl">
      <thead><tr><th>Rok</th><th>Úrok</th><th>Jistina</th><th>Podíl úroku</th><th>Zůstatek</th>${expanded ? '<th>Splátka /měs.</th><th>Sazba</th>' : ''}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>Celkem</td><td>${moneyHtml(sch.totalInterest)}</td><td>${moneyHtml(sch.totalPrincipal)}</td><td>${totalShare} %</td><td></td>${expanded ? '<td></td><td></td>' : ''}</tr></tfoot>
    </table></div>
  </div>`;
}

function renderLoansTable() {
  closePopover();
  const key = 'loans';
  applyTableMode(key);
  const expanded = isExpanded(key);
  const totals = { amount: 0, payment: 0, own: 0 };
  const dash = '<span class="t-faint">—</span>';

  const monthYear = (abs) => `${String((abs % 12) + 1).padStart(2, '0')}/${Math.floor(abs / 12)}`;
  const rows = state.loans.map((l) => {
    const end = calc.fixationEndDate(l);
    const terms = calc.loanTerms(l, CURRENT_YEAR);
    const sch = calc.loanSchedule(l, { events: state.events, startYear: CURRENT_YEAR, maxYears: 1 });
    // celý plán splácení bez scénářových událostí, ale s refinancováním a sloučením úvěrů: z něj je datum doplacení
    const plan = calc.loanSchedule(l, { events: [], startYear: CURRENT_YEAR, maxYears: 60, loans: state.loans });
    const ltv = ltvInfo(l);
    totals.amount += Number(l.amount) || 0;
    totals.payment += terms.payment;
    let mergeText = '';
    if (plan.mergedInto) {
      const to = state.loans.find((x) => x.id === plan.mergedInto.to);
      mergeText = `sloučí se do ${to ? to.bank : 'jiného úvěru'} od ${monthYear(plan.mergedInto.abs)}`;
    } else if (plan.merges.length) {
      mergeText = `od ${monthYear(plan.merges[0].abs)} slučuje ${plan.merges.map((m) => m.bank).join(', ')}`;
    }
    const payoff = plan.payoffAbs != null ? { year: Math.floor(plan.payoffAbs / 12), month: (plan.payoffAbs % 12) + 1 } : null;
    return { l, end, terms, payoff, merged: plan.mergedInto ? monthYear(plan.mergedInto.abs) : '', mergeText, share: sch.rows.length ? sch.rows[0].interestShare : null, ltv, fx: end ? calc.fixationRemainingUntil(end) : null };
  });

  const linkedName = (l) => {
    if (l.property_id && propertyName(l.property_id)) return escapeHtml(propertyName(l.property_id));
    const names = calc.loanCollateral(l).map((c) => propertyName(c.property_id)).filter(Boolean);
    return names.length ? escapeHtml(names.join(', ')) : '';
  };

  const columns = [
    {
      label: 'Banka',
      cell: (r) => `<button type="button" class="loan-toggle${expandedLoans.has(r.l.id) ? ' is-open' : ''}" data-loan-schedule="${r.l.id}" aria-expanded="${expandedLoans.has(r.l.id)}" title="Splátkový kalendář"><span class="year-chevron"></span>${bankLogoHtml(r.l.bank)}<span class="font-medium loan-name" title="${escapeHtml(r.l.bank)}">${escapeHtml(r.l.bank)}</span></button>${expanded && (r.mergeText || r.l.note) ? loanInfoButton(r.l, r.mergeText) : ''}`,
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
        return r.end ? `<span class="num">${fmtDate(toInputDate(r.end))}</span>${years ? ` <span class="text-xs t-muted">· ${years}</span>` : ''}` : years || dash;
      },
      total: () => '',
    },
    { label: 'Zbývá fixace', x: true, cell: (r) => (r.fx ? escapeHtml(r.fx.text) : dash), total: () => '' },
    {
      label: 'Doplatí se',
      x: true,
      cell: (r) => (r.merged ? `<span class="t-muted">sloučeno ${r.merged}</span>` : r.payoff ? `<span class="num">${String(r.payoff.month).padStart(2, '0')}/${r.payoff.year}</span>` : dash),
      total: () => '',
    },
    { label: 'Úrok ve splátce', right: true, x: true, cell: (r) => (r.share == null ? dash : `<span class="num">${Math.round(r.share * 100)} %</span>`), total: () => '' },
    { label: 'Poměr LTV', right: true, x: true, cell: (r) => (r.ltv && r.ltv.text ? `<span class="num">${r.ltv.text}</span>` : dash), total: () => '' },
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
  wirePopovers();
  document.querySelectorAll('[data-combo="bank"]').forEach((input) => makeCombobox(input, bankOptions));
  wirePropertyFormUi();
  wireLoanFormUi();
  wireRefiFormUi();
  wireEventFormUi();
  wireKpiFormulaToggles();
  wirePdfExportButtons();
  const horizonInput = document.getElementById('scenario-horizon');
  horizonInput.addEventListener('input', (e) => {
    const error = checkValue({ kind: 'number', integer: true, required: true, min: 1, max: 50, unit: ' let' }, e.target.value);
    setFieldError(horizonInput, error);
    if (error) return;
    state.scenario.horizonYears = Number(e.target.value);
    saveState();
    renderScenario();
    renderOverview();
  });
  horizonInput.addEventListener('blur', () => {
    setFieldError(horizonInput, '');
    renderScenario();
  });
  resetPropertyForm();
  resetLoanForm();
  resetRefiForm();
  resetEventForm();
  renderAll();
}

/** Chyba v aplikaci se ukáže v pruhu nahoře (místo tichého zamrznutí) a zapíše do konzole. */
function reportError(where, error) {
  console.error('Investix:', where, error);
  let el = document.getElementById('error-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'error-banner';
    el.className = 'notice error-banner';
    el.setAttribute('role', 'alert');
    document.getElementById('app-screen').prepend(el);
  }
  el.textContent = 'Chyba v aplikaci (' + where + '): ' + (error && error.message ? error.message : error);
}

/** Jedna chybná část nezastaví vykreslení ostatních (např. Přehled se spočítá, i když selže tabulka). */
function guarded(where, fn) {
  try {
    return fn();
  } catch (e) {
    reportError(where, e);
  }
}

function renderAll() {
  guarded('nemovitosti', renderProperties);
  guarded('úvěry', renderLoans);
  guarded('nastavení', renderSettings);
  guarded('události', renderEvents);
  guarded('scénáře', renderScenario);
  guarded('přehled', renderOverview);
}

/** Po změně dat, která se promítají do výpočtů (události, nemovitosti, úvěry, nastavení). */
function renderCalculations() {
  guarded('události', renderEvents);
  guarded('scénáře', renderScenario);
  guarded('přehled', renderOverview);
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

/* ---------- Hlídání hodnot ve formulářích ---------- */

// Každé pole má pravidlo (typ, meze). Formulář se před uložením zkontroluje, chyba se napíše přímo pod pole
// a hodnoty se ukládají do správných polí ve správných jednotkách (procenta jako zlomky, text bez zbytečných mezer).

const MAX_MONEY = 1e11; // 100 mld. Kč

/** Text bez zbytečných mezer a řídicích znaků. */
function cleanText(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Číslo z textu pole: null = prázdné pole, NaN = není to číslo. */
function readNumber(raw) {
  const t = String(raw == null ? '' : raw)
    .replace(/[\s ]/g, '')
    .replace(/[−–]/g, '-')
    .replace(',', '.');
  if (t === '') return null;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  return Number(t);
}

const RULE_UNIT = { money: ' Kč', percent: ' %' };

/** Zkontroluje hodnotu podle pravidla. Vrací text chyby, nebo prázdný text, když je všechno v pořádku. */
function checkValue(rule, raw) {
  if (rule.kind === 'text') {
    const t = cleanText(raw);
    if (!t) return rule.required ? 'Vyplň toto pole.' : '';
    if (rule.maxLen && t.length > rule.maxLen) return `Nejvýš ${rule.maxLen} znaků.`;
    return '';
  }
  if (rule.kind === 'date') {
    const iso = String(raw || '');
    if (!iso) return rule.required ? 'Zadej datum.' : '';
    const year = Number(iso.slice(0, 4));
    if (!(year >= 1900 && year <= 2100)) return 'Rok data musí být mezi 1900 a 2100.';
    return '';
  }
  const n = readNumber(raw);
  if (n === null) return rule.required ? 'Vyplň toto pole.' : '';
  if (!Number.isFinite(n)) return 'Zadej číslo.';
  if (rule.integer && !Number.isInteger(n)) return 'Zadej celé číslo.';
  const unit = rule.unit != null ? rule.unit : RULE_UNIT[rule.kind] || '';
  if (rule.minExclusive != null && n <= rule.minExclusive) return `Musí být víc než ${fmtNumber(rule.minExclusive)}${unit}.`;
  if (rule.min != null && rule.max != null && (n < rule.min || n > rule.max)) return `Zadej hodnotu od ${fmtNumber(rule.min)} do ${fmtNumber(rule.max)}${unit}.`;
  if (rule.min != null && n < rule.min) return rule.min === 0 && rule.kind === 'money' ? 'Částka nesmí být záporná.' : `Nejméně ${fmtNumber(rule.min)}${unit}.`;
  if (rule.max != null && n > rule.max) return `Nejvýš ${fmtNumber(rule.max)}${unit}.`;
  if (rule.extra) return rule.extra(n) || '';
  return '';
}

/** Viditelné pole: u data je to textové pole vedle průhledného nativního pole s kalendářem. */
function visibleInput(el) {
  if (el.classList && el.classList.contains('date-native')) {
    const field = el.closest('.date-field');
    return (field && field.querySelector('input[type="text"]')) || el;
  }
  return el;
}

/** Napíše chybu pod pole (nebo ji smaže, když je text prázdný) a označí pole červeně. */
function setFieldError(el, message) {
  const shown = visibleInput(el);
  let node = shown.closest('.input-suffix-wrap, .number-stepper-wrap, .date-field') || shown;
  const host = node.closest('label') || node.parentElement;
  let box = host.querySelector(':scope > .field-error');
  if (!message) {
    if (box) box.remove();
    shown.classList.remove('is-invalid');
    shown.removeAttribute('aria-invalid');
    return;
  }
  if (!box) {
    box = document.createElement('p');
    box.className = 'field-error';
    box.setAttribute('role', 'alert');
    host.appendChild(box);
  }
  box.textContent = message;
  shown.classList.add('is-invalid');
  shown.setAttribute('aria-invalid', 'true');
}

function clearFieldErrors(root) {
  if (!root) return;
  root.querySelectorAll('.field-error').forEach((box) => box.remove());
  root.querySelectorAll('.is-invalid').forEach((input) => {
    if (input.dataset.typedInvalid) return; // špatně napsané datum se smaže, až se pole opraví
    input.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
  });
}

/** Ukáže první chybné pole: rozbalí kartu, ve které je, a dá do něj kurzor. */
function focusInvalid(el) {
  const shown = visibleInput(el);
  const details = shown.closest('details');
  if (details) details.open = true;
  shown.scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    shown.focus({ preventScroll: true });
  } catch (e) {
    /* pole nejde zaměřit - nevadí */
  }
}

/** Sbírá chyby formuláře: field() zkontroluje pole podle pravidla, fail() přidá chybu ze vztahu mezi poli. */
function makeValidator() {
  const bad = [];
  return {
    field(rule) {
      const el = rule.el;
      if (!el) return;
      let error;
      const shown = visibleInput(el);
      if (rule.kind === 'date' && shown !== el && shown.dataset.typedInvalid) error = 'Zadej datum, např. 1. 2. 2026.';
      else if (el.validity && el.validity.badInput) error = 'Zadej číslo.'; // číselné pole s nesmyslem uvnitř vrací prázdnou hodnotu
      else error = checkValue(rule, el.value);
      setFieldError(el, error);
      if (error) bad.push(el);
    },
    fail(el, message) {
      if (!el || bad.includes(el)) return;
      setFieldError(el, message);
      bad.push(el);
    },
    done() {
      if (!bad.length) return true;
      bad.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      focusInvalid(bad[0]);
      return false;
    },
  };
}

function validateProperty(f) {
  clearFieldErrors(f);
  const v = makeValidator();
  const el = (name) => f.elements[name];
  v.field({ el: el('name'), kind: 'text', required: true, maxLen: 80 });
  v.field({ el: el('rent'), kind: 'money', min: 0, max: 1e8 });
  v.field({ el: el('market_value'), kind: 'money', required: true, minExclusive: 0, max: MAX_MONEY });
  v.field({ el: el('acquisition_price'), kind: 'money', min: 0, max: MAX_MONEY });
  v.field({ el: el('growth_rate'), kind: 'percent', min: -50, max: 100 });
  v.field({ el: el('acquisition_date'), kind: 'date' });
  v.field({ el: el('occupancy'), kind: 'percent', min: 0, max: 100 });
  v.field({ el: el('monthly_costs'), kind: 'money', min: 0, max: 1e8 });
  v.field({ el: el('rent_growth_rate'), kind: 'percent', min: -50, max: 100 });
  if (el('has_lien').checked) {
    v.field({ el: el('lien_bank'), kind: 'text', maxLen: 60 });
    v.field({ el: el('lien_value'), kind: 'money', required: true, minExclusive: 0, max: MAX_MONEY });
  }
  for (const p of readPropertyPledges()) v.field({ el: p.row.querySelector('.ppledge-amount'), kind: 'money', required: true, minExclusive: 0, max: MAX_MONEY });
  return v.done();
}

function validateLoan(f) {
  clearFieldErrors(f);
  const v = makeValidator();
  const el = (name) => f.elements[name];
  v.field({ el: el('bank'), kind: 'text', required: true, maxLen: 60 });
  v.field({ el: el('amount'), kind: 'money', required: true, minExclusive: 0, max: MAX_MONEY });
  v.field({ el: el('interest_rate'), kind: 'percent', required: true, min: 0, max: 100 });
  v.field({ el: el('monthly_payment'), kind: 'money', min: 0, max: 1e8 });
  v.field({ el: el('start_date'), kind: 'date' });
  v.field({ el: el('fixation_years'), kind: 'number', min: 0, max: 50, unit: ' let' });
  v.field({ el: el('fixation_end'), kind: 'date' });
  v.field({ el: el('rate_after_fixation'), kind: 'percent', min: 0, max: 100 });
  v.field({ el: el('payment_after_fixation'), kind: 'money', min: 0, max: 1e8 });
  v.field({ el: el('maturity_date'), kind: 'date' });
  v.field({ el: el('ltv_percent'), kind: 'percent', min: 0, max: 200 });
  v.field({ el: el('note'), kind: 'text', maxLen: 200 });

  // vztahy mezi poli (bez data zřízení se počítá od dneška)
  const start = el('start_date').value || toInputDate(new Date());
  const fixationEnd = el('fixation_end').value;
  const maturity = el('maturity_date').value;
  if (fixationEnd && fixationEnd < start) v.fail(el('fixation_end'), 'Konec fixace nemůže být před zřízením úvěru.');
  if (maturity && maturity <= start) v.fail(el('maturity_date'), 'Splatnost musí být po zřízení úvěru.');
  const afterFixationGiven = el('rate_after_fixation').value.trim() !== '' || el('payment_after_fixation').value.trim() !== '';
  const fixationKnown = el('fixation_years').value.trim() !== '' || !!fixationEnd;
  if (afterFixationGiven && !fixationKnown) v.fail(el('fixation_years'), 'Zadej dobu fixace nebo její konec, ať je jasné, odkdy platí nová sazba.');
  return v.done();
}

/** Refinancování: úvěr, datum v budoucnosti, nová sazba / doba / sloučení (aspoň něco z toho; sloučení potřebuje novou dobu). */
function validateRefinancing(f) {
  clearFieldErrors(f);
  const v = makeValidator();
  const el = (name) => f.elements[name];
  if (!el('loan_id').value) v.fail(el('loan_id'), 'Vyber úvěr.');
  v.field({ el: el('date'), kind: 'date', required: true });
  v.field({ el: el('rate'), kind: 'percent', min: 0, max: 100 });
  v.field({ el: el('years'), kind: 'number', minExclusive: 0, max: 50, unit: ' let' });
  const date = el('date').value;
  if (date) {
    const d = calc.toDate(date);
    const now = new Date();
    // refinancování, které už proběhlo, je v zadaném úvěru (částka, sazba, splátka) zahrnuté - jako událost by nic neudělalo
    if (!isNaN(d) && d.getFullYear() * 12 + d.getMonth() + (d.getDate() > 15 ? 1 : 0) < now.getFullYear() * 12 + now.getMonth()) {
      v.fail(el('date'), 'Datum musí být v budoucnosti. Zadaný úvěr už je po dřívějším refinancování.');
    }
  }
  const merge = readRefiMergeDraft() || new Set();
  const hasRate = el('rate').value.trim() !== '';
  const hasYears = el('years').value.trim() !== '';
  if (!hasRate && !hasYears && !merge.size) v.fail(el('rate'), 'Zadej novou sazbu, novou dobu nebo úvěry ke sloučení.');
  if (merge.size && !hasYears) v.fail(el('years'), 'Pro sloučení úvěrů zadej novou dobu splácení.');
  return v.done();
}

function validateEvent(f) {
  clearFieldErrors(f);
  const v = makeValidator();
  const type = f.elements['type'].value;
  v.field({ el: f.elements['year_from'], kind: 'number', integer: true, required: true, min: 2000, max: 2100, unit: '' });
  if (type !== 'one_time') v.field({ el: f.elements['year_to'], kind: 'number', integer: true, min: 2000, max: 2100, unit: '' });
  const ranges = { growth: [-50, 100], rent_growth: [-50, 100], vacancy: [0, 100], inflation: [-20, 100], interest: [0, 100] };
  if (type === 'one_time') {
    v.field({
      el: f.elements['value'],
      kind: 'money',
      required: true,
      min: -MAX_MONEY,
      max: MAX_MONEY,
      extra: (n) => (n === 0 ? 'Zadej částku (příjem kladně, výdaj záporně).' : ''),
    });
  } else {
    const [min, max] = ranges[type] || [-100, 100];
    v.field({ el: f.elements['value'], kind: 'percent', required: true, min, max });
  }
  v.field({ el: f.elements['note'], kind: 'text', maxLen: 200 });
  const from = readNumber(f.elements['year_from'].value);
  const to = readNumber(f.elements['year_to'].value);
  if (type !== 'one_time' && from != null && to != null && Number.isFinite(from) && Number.isFinite(to) && to < from) {
    v.fail(f.elements['year_to'], 'Do roku nesmí být před rokem „Od“.');
  }
  return v.done();
}

/* ---------- Kvalita nemovitosti: stav, rekonstrukce, lokalita, energetický štítek a celkové hodnocení ---------- */

const QUALITY_LABELS = {
  yield: 'Výnos z nájmu',
  growth: 'Zhodnocení',
  condition: 'Stav',
  location: 'Lokalita',
  renovation: 'Rekonstrukce',
  energy: 'Energetický štítek',
};
const QUALITY_OPTIONS = {
  condition: [['new', 'Novostavba'], ['excellent', 'Výborný'], ['good', 'Dobrý'], ['fair', 'Průměrný'], ['poor', 'Špatný']],
  renovation: [['after', 'Po rekonstrukci'], ['none', 'Bez nutnosti'], ['before', 'Před rekonstrukcí']],
  location: [['top', 'Výborná'], ['good', 'Dobrá'], ['avg', 'Průměrná'], ['weak', 'Slabá']],
  energy: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((x) => [x, x]),
};
const QUALITY_BAND_LABELS = { low: 'slabá', mid: 'průměrná', high: 'dobrá' };

function qualityOptionLabel(key, value) {
  const found = (QUALITY_OPTIONS[key] || []).find(([v]) => v === value);
  return found ? found[1] : '';
}

/** Výběry v kartě nemovitosti (stav, rekonstrukce, lokalita, energetický štítek) se plní z jednoho seznamu možností. */
function fillQualitySelects() {
  const f = propertyForm();
  for (const key of Object.keys(QUALITY_OPTIONS)) {
    f.elements[key].innerHTML = '<option value="">—</option>' + QUALITY_OPTIONS[key].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  }
}

const LOCK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

/** Zámek u nemovitosti, kterou uživatel při umořování dluhu určitě prodávat nechce. */
function lockIconHtml() {
  return `<span class="lock-icon" title="Neprodává se na umoření dluhu" role="img" aria-label="Neprodává se na umoření dluhu">${LOCK_SVG}</span>`;
}

/** Nemovitosti, které se při automatickém prodeji na umoření dluhu nikdy neprodají, i kdyby se to hodilo. */
function renderNeverSellChips() {
  const box = document.getElementById('never-sell-chips');
  if (!box) return;
  box.innerHTML = state.properties.length
    ? state.properties
        .map((p) => `<label class="chip"><input type="checkbox" value="${p.id}" ${p.never_sell ? 'checked' : ''} /><span>${escapeHtml(p.name)}</span></label>`)
        .join('')
    : '<span class="text-sm t-faint">Zatím žádné nemovitosti</span>';
}

function setNeverSell(propertyId, locked) {
  const p = state.properties.find((x) => x.id === propertyId);
  if (!p) return;
  if (locked) p.never_sell = true;
  else delete p.never_sell;
  saveState();
  renderPropertiesTable();
  renderCalculations();
}

/** Štítek celkového hodnocení: barva podle pásma (červená, oranžová, zelená), číslo 0 až 100 a slovní označení. */
function rankBadgeHtml(q, withLabel = true) {
  const n = Math.round(q.score);
  const text = `Kvalita ${n} z 100 · ${QUALITY_BAND_LABELS[q.band]}`;
  return `<span class="rank-badge rank-${q.band}" title="${text}">${n}${withLabel ? ` · ${QUALITY_BAND_LABELS[q.band]}` : ''}</span>`;
}

/** Malá barevná tečka u názvu nemovitosti (v úzké tabulce na telefonu). */
function rankDotHtml(q) {
  const text = `Kvalita ${Math.round(q.score)} z 100 · ${QUALITY_BAND_LABELS[q.band]}`;
  return `<span class="rank-dot rank-${q.band}" title="${text}" role="img" aria-label="${text}"></span>`;
}

/** Hodnota složky hodnocení jako text: výnos a zhodnocení v %, ostatní zvolená možnost, jinak "neuvedeno". */
function qualityValueText(part) {
  if (part.key === 'yield' || part.key === 'growth') return `${fmtNumber(part.value * 100)} %`;
  return part.known ? qualityOptionLabel(part.key, part.value) : 'neuvedeno';
}

/** Složka hodnocení do věty ("stav špatný", "výnos z nájmu 2,4 %"). */
function qualityPartPhrase(part) {
  const text = qualityValueText(part);
  switch (part.key) {
    case 'yield':
      return `výnos z nájmu ${text}`;
    case 'growth':
      return `zhodnocení ${text}`;
    case 'condition':
      return `stav ${text.toLowerCase()}`;
    case 'location':
      return `lokalita ${text.toLowerCase()}`;
    case 'renovation':
      return `rekonstrukce: ${text.toLowerCase()}`;
    default:
      return `energetický štítek ${text}`;
  }
}

/** Rozpis hodnocení po složkách: název, hodnota, barevný pruh a body. */
function renderQualityBreakdown(q) {
  const box = document.getElementById('property-quality-breakdown');
  if (!q) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML =
    q.parts
      .map(
        (part) => `<div class="qrow rank-${calc.qualityBand(part.score)}${part.known ? '' : ' is-unknown'}" title="Váha ${part.weight} %">
        <span class="qname">${QUALITY_LABELS[part.key]}<small>${escapeHtml(qualityValueText(part))}</small></span>
        <span class="qbar"><i style="width:${Math.round(part.score)}%"></i></span>
        <span class="qpts num">${Math.round(part.score)}</span>
      </div>`
      )
      .join('') + '<p class="qnote">Při automatickém prodeji na umoření dluhu se prodává nemovitost s nejnižším hodnocením.</p>';
}

/** Nemovitost podle hodnot ve formuláři (pro živé hodnocení, ještě neuložená). */
function propertyDraftFromForm() {
  const f = propertyForm();
  const occRaw = f.elements['occupancy'].value.trim();
  const occupancy = occRaw ? Math.min(100, Math.max(0, parseFormNumber(occRaw))) : 100;
  return {
    rent: parseFormNumber(f.elements['rent'].value),
    market_value: parseFormNumber(f.elements['market_value'].value),
    monthly_costs: parseFormNumber(f.elements['monthly_costs'].value),
    vacancy_rate: (100 - occupancy) / 100,
    growth_rate: parseFormNumber(f.elements['growth_rate'].value) / 100,
    condition: f.elements['condition'].value,
    renovation: f.elements['renovation'].value,
    location: f.elements['location'].value,
    energy: f.elements['energy'].value,
  };
}

function updateQualityBadge() {
  const draft = propertyDraftFromForm();
  const badge = document.getElementById('property-quality-badge');
  if (!(draft.market_value > 0)) {
    badge.textContent = '';
    renderQualityBreakdown(null);
    return;
  }
  const q = calc.propertyQuality(draft);
  badge.innerHTML = rankBadgeHtml(q);
  renderQualityBreakdown(q);
}

/* ---------- MOJE NEMOVITOSTI ---------- */

function renderProperties() {
  renderPropertiesTable();
  renderPropertyPledges(readPropertyPledges().map((p) => ({ loanId: p.loanId, amount: p.amount })));
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
  const pledges = readPropertyPledges().filter((p) => p.amount > 0);
  const pledgeSum = pledges.reduce((sum, p) => sum + p.amount, 0);
  const pledgeLoan = pledges.length === 1 ? state.loans.find((l) => l.id === pledges[0].loanId) : null;
  const badgeParts = [];
  if (pledges.length === 1) badgeParts.push(`${pledgeLoan ? pledgeLoan.bank : 'Úvěr'} · ${fmtMoney(pledgeSum)}`);
  else if (pledges.length > 1) badgeParts.push(`${pledges.length}× · ${fmtMoney(pledgeSum)}`);
  if (hasLien) badgeParts.push([lienBank || 'Jiná zástava', lienValue ? fmtMoney(lienValue) : ''].filter(Boolean).join(' · '));
  document.getElementById('property-pledge-badge').textContent = badgeParts.length ? badgeParts.join(' + ') : 'Bez zástavy';

  const occRaw = f.elements['occupancy'].value.trim();
  const occupancy = occRaw ? parseFormNumber(occRaw) : 100;
  const costs = parseFormNumber(f.elements['monthly_costs'].value);
  const rentGrowth = f.elements['rent_growth_rate'].value.trim();
  updateQualityBadge();
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
  fillQualitySelects();
  f.elements['has_lien'].addEventListener('change', () => setLienFieldsVisible(f.elements['has_lien'].checked));
  const pledgeList = document.getElementById('property-pledge-list');
  document.getElementById('property-pledge-add').addEventListener('click', addPropertyPledge);
  pledgeList.addEventListener('click', (e) => {
    const btn = e.target.closest('.ppledge-remove');
    if (!btn) return;
    const row = btn.closest('.ppledge-row');
    const draft = readPropertyPledges().filter((p) => p.row !== row).map((p) => ({ loanId: p.loanId, amount: p.amount }));
    renderPropertyPledges(draft);
    updatePropertyFreeReadout();
  });
  pledgeList.addEventListener('change', (e) => {
    const row = e.target.closest('.ppledge-row');
    if (!row) return;
    if (e.target.classList.contains('ppledge-loan')) refreshPledgeLoanOptions();
    else if (e.target.classList.contains('ppledge-amount')) clampPropertyPledge(row);
    updatePropertyBadges();
    showFormError('property-form-error', '');
  });
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
  clearFieldErrors(f);
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
  const pledgeDraft = state.loans.flatMap((l) =>
    calc
      .loanCollateral(l)
      .filter((cc) => cc.property_id === p.id && Number.isFinite(cc.amount))
      .map((cc) => ({ loanId: l.id, amount: cc.amount }))
  );
  renderPropertyPledges(pledgeDraft);
  document.getElementById('property-acc-pledge').open = !!p.has_lien || pledgeDraft.length > 0;
  for (const key of ['condition', 'renovation', 'location', 'energy']) f.elements[key].value = qualityOptionLabel(key, p[key]) ? p[key] : '';
  document.getElementById('property-acc-quality').open = ['condition', 'renovation', 'location', 'energy'].some((key) => qualityOptionLabel(key, p[key]));
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
  clearFieldErrors(f);
  f.elements['id'].value = '';
  showFormError('property-form-error', '');
  setLienFieldsVisible(false);
  setTimeTestEnabled(true);
  f.querySelectorAll('details.acc').forEach((acc) => {
    acc.open = false;
  });
  renderPropertyPledges([]);
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
  if (!validateProperty(f)) return;
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
  const pledges = readPropertyPledges().filter((p) => p.amount > 0);
  const rentGrowthRaw = f.elements['rent_growth_rate'].value.trim();
  const occupancyRaw = f.elements['occupancy'].value.trim();
  const occupancy = occupancyRaw ? Math.min(100, Math.max(0, parseFormNumber(occupancyRaw))) : 100;
  const years = Number(f.elements['tax_exempt_years'].value);
  const existing = id ? state.properties.find((p) => p.id === id) : null;
  const payload = {
    // nepoužívané starší údaje (např. ručně zadaná splátka) zůstanou v datech beze změny
    ...(existing || {}),
    id: id || uid(),
    name: cleanText(f.elements['name'].value),
    rent: parseFormNumber(f.elements['rent'].value),
    market_value: parseFormNumber(f.elements['market_value'].value),
    acquisition_price: parseFormNumber(f.elements['acquisition_price'].value),
    growth_rate: parseFormNumber(f.elements['growth_rate'].value) / 100,
    acquisition_date: f.elements['acquisition_date'].value || toInputDate(new Date()),
    owner_type: f.elements['owner_type'].value === 'po' ? 'po' : 'fo',
    tax_exempt_years: [0, 5, 10].includes(years) ? years : 10,
    has_lien: f.elements['has_lien'].checked,
    lien_bank: f.elements['has_lien'].checked ? cleanText(f.elements['lien_bank'].value) || null : null,
    lien_value: f.elements['has_lien'].checked && f.elements['lien_value'].value.trim() ? parseFormNumber(f.elements['lien_value'].value) : null,
    vacancy_rate: (100 - occupancy) / 100,
    monthly_costs: parseFormNumber(f.elements['monthly_costs'].value),
    rent_growth_rate: rentGrowthRaw ? parseFormNumber(rentGrowthRaw) / 100 : null,
    condition: f.elements['condition'].value || null,
    renovation: f.elements['renovation'].value || null,
    location: f.elements['location'].value || null,
    energy: f.elements['energy'].value || null,
  };
  if (id) {
    const idx = state.properties.findIndex((p) => p.id === id);
    if (idx !== -1) state.properties[idx] = payload;
  } else {
    state.properties.push(payload);
  }
  // zástavy jsou vazba nemovitost + úvěr: zapíšou se do úvěrů (u nemovitosti se nahradí ty, které tu byly dřív)
  state.loans.forEach((l) => {
    const rest = (Array.isArray(l.collateral) ? l.collateral : []).filter((cc) => cc.property_id !== payload.id);
    const mine = pledges.filter((p) => p.loanId === l.id).map((p) => ({ property_id: payload.id, amount: Math.round(p.amount) }));
    l.collateral = rest.concat(mine);
  });
  saveState();
  resetPropertyForm();
  renderAll();
  showSuccessToast(id ? 'Nemovitost upravena' : 'Nemovitost přidána');
}

/* ---------- MOJE ÚVĚRY ---------- */

/**
 * LTV a vlastní zdroje u úvěru. Zadává je uživatel ručně (jeden úvěr může financovat víc nemovitostí, takže se z
 * jedné nemovitosti spočítat nedají). Starší záznam jen s hodnotou nemovitosti při sjednání se dopočítá jako dřív.
 * Vrací { text: "80/20" nebo null, own: Kč nebo null }, nebo null, když není co ukázat.
 */
function ltvInfo(loan) {
  const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  let pct = num(loan.ltv_percent);
  let own = num(loan.own_funds);
  if (pct == null && own == null) {
    const propValue = num(loan.property_value_at_origination);
    if (propValue && propValue > 0) {
      const amount = Number(loan.amount) || 0;
      pct = Math.min(1, amount / propValue) * 100;
      own = Math.max(0, propValue - amount);
    }
  }
  if (pct == null && own == null) return null;
  const rounded = pct == null ? null : Math.round(pct);
  return { text: rounded == null ? null : `${rounded}/${Math.max(0, 100 - rounded)}`, own, pct: rounded };
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
        <span class="pledge-free">volné k zastavení <strong class="num">${fmtMoney(free)}</strong></span>
        <div class="pledge-amount ${on ? '' : 'hidden'}"><span class="label">Zastavená částka</span><input class="input loan-collateral-amount" data-unit="money" aria-label="Zastavená částka" /></div>
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

  const linked = f.elements['property_id'].value;
  const ltvRaw = f.elements['ltv_percent'].value.trim();
  document.getElementById('loan-details-badge').textContent = [
    linked ? propertyName(linked) : '',
    ltvRaw ? `LTV ${fmtNumber(parseFormNumber(ltvRaw))} %` : '',
  ]
    .filter(Boolean)
    .join(' · ');
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
    if (years.value === '') return;
    if (!start.value) start.value = toInputDate(new Date()); // bez data zřízení se počítá od dneška
    const d = calc.toDate(start.value);
    if (isNaN(d)) return;
    end.value = toInputDate(calc.addMonths(d, Math.round((Number(years.value) || 0) * 12)));
  };
  const yearsFromEnd = () => {
    if (!end.value) return;
    if (!start.value) start.value = toInputDate(new Date()); // bez data zřízení se počítá od dneška
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
  wireFixationFields();
  wirePledgeChecklist();
  f.addEventListener('input', updateLoanBadges);
  f.addEventListener('change', updateLoanBadges);
}

function renderLoans() {
  renderLoansTable();
  renderRefinancings();
  renderLoanCollateralChecklist(readPledgeDraft());
  renderLoanPropertySelect();
  renderEventTargets();
}

function fillLoanForm(id) {
  const l = state.loans.find((x) => x.id === id);
  if (!l) return;
  const f = loanForm();
  f.reset();
  clearFieldErrors(f);
  showFormError('loan-form-error', '');
  f.elements['id'].value = l.id;
  f.elements['bank'].value = l.bank;
  if (f.elements['bank']._comboRefresh) f.elements['bank']._comboRefresh();
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
  f.elements['note'].value = l.note || '';
  // LTV a vlastní zdroje: ruční hodnoty, u staršího záznamu se předvyplní z hodnoty nemovitosti při sjednání
  const ltv = ltvInfo(l);
  setFormattedValue(f.elements['ltv_percent'], l.ltv_percent != null ? l.ltv_percent : ltv && ltv.pct != null ? ltv.pct : '');
  renderLoanPropertySelect();
  f.elements['property_id'].value = l.property_id || '';
  renderLoanCollateralChecklist(null);
  document.getElementById('loan-acc-pledge').open = calc.loanCollateral(l).length > 0;
  const accordions = Array.from(f.querySelectorAll('details.acc:not(.acc-pledge)'));
  const [fixationAcc, detailsAcc] = accordions;
  fixationAcc.open = !!(l.start_date || end || l.fixation_years != null || l.rate_after_fixation != null || l.maturity_date || l.payment_after_fixation);
  detailsAcc.open = !!(l.ltv_percent != null || l.property_value_at_origination || l.property_id || l.note);
  document.getElementById('loan-form-title').textContent = 'Upravit úvěr';
  document.getElementById('loan-submit-label').textContent = 'Uložit změny';
  document.getElementById('loan-form-card').classList.add('is-editing');
  updateLoanBadges();
  revealForm('loan-form-card');
}

function resetLoanForm() {
  const f = loanForm();
  f.reset();
  clearFieldErrors(f);
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
  // ať po úvěru nezůstávají viset odkazy ze sloučení (jeho vlastní refinancování zmizí spolu s ním)
  state.loans.forEach((l) => {
    (Array.isArray(l.refinancings) ? l.refinancings : []).forEach((ev) => {
      if (Array.isArray(ev.merge_ids)) ev.merge_ids = ev.merge_ids.filter((x) => x !== id);
    });
  });
  expandedLoans.delete(id);
  pruneEventTargets(id, 'loan');
  saveState();
  renderAll();
}

function submitLoanForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.elements['id'].value;
  if (!validateLoan(f)) return;

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
    bank: cleanText(f.elements['bank'].value),
    amount: parseFormNumber(f.elements['amount'].value),
    interest_rate: parseFormNumber(f.elements['interest_rate'].value) / 100,
    monthly_payment: parseFormNumber(f.elements['monthly_payment'].value),
    fixation_years: yearsRaw === '' ? null : Math.max(0, Number(yearsRaw) || 0),
    start_date: f.elements['start_date'].value || toInputDate(new Date()),
    fixation_end: f.elements['fixation_end'].value || null,
    rate_after_fixation: num('rate_after_fixation'),
    payment_after_fixation: num('payment_after_fixation'),
    maturity_date: f.elements['maturity_date'].value || null,
    note: cleanText(f.elements['note'].value) || null,
    ltv_percent: num('ltv_percent'),
    property_id: f.elements['property_id'].value || null,
    collateral,
  };
  delete payload.additional_collateral_ids;
  delete payload.keep_payment_after_fixation; // starší volba "ponechat splátku" už neexistuje
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

/* ---------- REFINANCOVÁNÍ: samostatné události nad seznamem úvěrů (u úvěru jich může být víc) ---------- */

const refiForm = () => document.getElementById('refi-form');

/** Všechna refinancování ze všech úvěrů: [{ loan, ev }] podle data. */
function refinancingRows() {
  const rows = [];
  for (const loan of state.loans) for (const ev of Array.isArray(loan.refinancings) ? loan.refinancings : []) rows.push({ loan, ev });
  return rows.sort((a, b) => String(a.ev.date).localeCompare(String(b.ev.date)));
}

function findRefinancing(id) {
  return refinancingRows().find((r) => r.ev.id === id) || null;
}

/** Které úvěry se už slučují (a do kterého) a které úvěry něco slučují; `exceptEventId` = právě upravované refinancování. */
function mergeUsage(exceptEventId) {
  const takenBy = new Map();
  const mergers = new Set();
  for (const { loan, ev } of refinancingRows()) {
    if (ev.id === exceptEventId) continue;
    const ids = Array.isArray(ev.merge_ids) ? ev.merge_ids : [];
    if (ids.length) mergers.add(loan.id);
    for (const id of ids) takenBy.set(id, loan);
  }
  return { takenBy, mergers };
}

function renderRefiLoanSelect() {
  const select = document.getElementById('refi-loan-select');
  if (!select) return;
  const previous = select.value;
  select.innerHTML =
    (state.loans.length > 1 ? '<option value="">Vyber úvěr</option>' : '') +
    state.loans.map((l) => `<option value="${l.id}">${escapeHtml(l.bank)} · ${fmtMoney(l.amount)}</option>`).join('');
  select.value = state.loans.some((l) => l.id === previous) ? previous : state.loans.length === 1 ? state.loans[0].id : '';
}

/**
 * Úvěry, které jde při refinancování sloučit s vybraným úvěrem: jejich zůstatky se k datu refinancování splatí a přičtou
 * k němu. Nejde vybrat úvěr, který už se slučuje jinam nebo sám něco slučuje (bez řetězení).
 */
function renderRefiMergeChecklist(selected) {
  const container = document.getElementById('refi-merge-checklist');
  const wrap = document.getElementById('refi-merge-wrap');
  if (!container) return;
  const f = refiForm();
  const loanId = f.elements['loan_id'].value;
  const editId = f.elements['id'].value;
  const others = state.loans.filter((l) => l.id !== loanId);
  wrap.classList.toggle('hidden', state.loans.length < 2); // jediný úvěr: není co slučovat
  if (state.loans.length < 2) {
    container.innerHTML = '';
    return;
  }
  if (!loanId) {
    container.innerHTML = '<span class="text-sm t-faint">Nejdřív vyber úvěr</span>';
    return;
  }
  const { takenBy, mergers } = mergeUsage(editId);
  if (takenBy.has(loanId)) {
    container.innerHTML = `<span class="text-sm t-faint">Tento úvěr se slučuje do úvěru ${escapeHtml(takenBy.get(loanId).bank)}, sám nic slučovat nemůže.</span>`;
    return;
  }
  const editing = editId ? findRefinancing(editId) : null;
  const chosen = selected || new Set(editing && editing.loan.id === loanId ? editing.ev.merge_ids || [] : []);
  container.innerHTML = others
    .map((l) => {
      let blocked = '';
      if (takenBy.has(l.id)) blocked = `Už se slučuje do úvěru ${takenBy.get(l.id).bank}`;
      else if (mergers.has(l.id)) blocked = 'Tento úvěr sám něco slučuje';
      return `<label class="chip"${blocked ? ` title="${escapeHtml(blocked)}"` : ''}><input type="checkbox" value="${l.id}" ${chosen.has(l.id) && !blocked ? 'checked' : ''} ${blocked ? 'disabled' : ''} /><span class="chip-with-logo">${bankLogoHtml(l.bank)}${escapeHtml(l.bank)} · ${fmtMoney(l.amount)}</span></label>`;
    })
    .join('');
}

/** Vybrané úvěry ke sloučení tak, jak jsou právě ve formuláři (null = seznam ještě nebyl vykreslen). */
function readRefiMergeDraft() {
  const boxes = document.querySelectorAll('#refi-merge-checklist input[type="checkbox"]');
  if (!boxes.length) return null;
  return new Set(Array.from(boxes).filter((b) => b.checked).map((b) => b.value));
}

function renderRefinancingTable() {
  const card = document.getElementById('refi-card');
  if (!card) return;
  const key = 'refi';
  const rows = refinancingRows();
  card.classList.toggle('hidden', !rows.length);
  applyTableMode(key);
  const dash = '<span class="t-faint">—</span>';
  const now = new Date();
  const todayAbs = now.getFullYear() * 12 + now.getMonth();
  const donorsOf = (ev) => (Array.isArray(ev.merge_ids) ? ev.merge_ids : []).map((id) => state.loans.find((l) => l.id === id)).filter(Boolean);
  const columns = [
    {
      label: 'Úvěr',
      cell: ({ loan, ev }) => {
        return `<span class="refi-loan">${bankLogoHtml(loan.bank)}<span class="font-medium loan-name" title="${escapeHtml(loan.bank)}">${escapeHtml(loan.bank)}</span></span>`;
      },
    },
    { label: 'Výše úvěru', right: true, x: true, cell: ({ loan }) => `<span class="num">${moneyHtml(loan.amount)}</span>` },
    {
      label: 'Datum',
      cell: ({ ev }) => {
        const d = calc.toDate(ev.date);
        const past = !isNaN(d) && d.getFullYear() * 12 + d.getMonth() + (d.getDate() > 15 ? 1 : 0) < todayAbs;
        return `<span class="num">${fmtDate(ev.date)}</span>${past ? ' <span class="text-xs t-muted">· proběhlo</span>' : ''}`;
      },
    },
    {
      label: 'Nově',
      right: true,
      cell: ({ ev }) => {
        const parts = [];
        if (ev.rate != null && ev.rate !== '') parts.push(`${fmtNumber(ev.rate)} %`);
        if (Number(ev.years) > 0) parts.push(`${fmtNumber(ev.years, 1)} let`);
        return parts.length ? parts.map((p) => `<span class="num">${p}</span>`).join(' · ') : dash;
      },
    },
    {
      label: 'Sloučení',
      x: true,
      cell: ({ ev }) => {
        const names = donorsOf(ev).map((d) => d.bank).join(', ');
        return names ? `<span class="ellipsis" title="${escapeHtml(names)}">${escapeHtml(names)}</span>` : dash;
      },
    },
    { label: '', right: true, actions: true, cell: ({ ev }) => actionButtons('data-edit-refi', 'data-delete-refi', ev.id) },
  ];
  const cols = visibleColumns(columns, key);
  document.getElementById('refi-thead').innerHTML = headHtml(cols);
  const tbody = document.getElementById('refi-tbody');
  tbody.innerHTML = rows
    .map((r) => `<tr>${cols.map((c) => `<td class="${c.right ? 'text-right' : ''} ${c.actions ? 'whitespace-nowrap' : ''}">${c.cell(r)}</td>`).join('')}</tr>`)
    .join('');
  tbody.querySelectorAll('[data-edit-refi]').forEach((btn) => btn.addEventListener('click', () => fillRefiForm(btn.dataset.editRefi)));
  tbody.querySelectorAll('[data-delete-refi]').forEach((btn) => btn.addEventListener('click', () => deleteRefinancing(btn.dataset.deleteRefi)));
}

function renderRefinancings() {
  const formCard = document.getElementById('refi-form-card');
  if (!formCard) return;
  formCard.classList.toggle('hidden', !state.loans.length); // bez úvěru není co refinancovat
  // upravované refinancování (nebo jeho úvěr) mezitím zmizelo: formulář se vrátí do stavu "Přidat"
  const editId = refiForm().elements['id'].value;
  if (editId && !findRefinancing(editId)) resetRefiForm();
  renderRefiLoanSelect();
  renderRefiMergeChecklist(readRefiMergeDraft());
  renderRefinancingTable();
}

/** Refinancuje se nejčastěji po konci fixace: prázdné datum se předvyplní koncem fixace vybraného úvěru (je-li v budoucnu). */
function prefillRefiDate() {
  const f = refiForm();
  if (f.elements['date'].value) return;
  const loan = state.loans.find((l) => l.id === f.elements['loan_id'].value);
  const end = loan ? calc.fixationEndDate(loan) : null;
  if (end && end > new Date()) f.elements['date'].value = toInputDate(end);
}

function wireRefiFormUi() {
  const f = refiForm();
  f.elements['loan_id'].addEventListener('change', () => {
    renderRefiMergeChecklist(new Set());
    prefillRefiDate();
  });
}

function fillRefiForm(id) {
  const found = findRefinancing(id);
  if (!found) return;
  const { loan, ev } = found;
  const f = refiForm();
  f.reset();
  clearFieldErrors(f);
  showFormError('refi-form-error', '');
  f.elements['id'].value = ev.id;
  renderRefiLoanSelect();
  f.elements['loan_id'].value = loan.id;
  f.elements['date'].value = ev.date || '';
  setFormattedValue(f.elements['rate'], ev.rate != null && ev.rate !== '' ? ev.rate : '');
  f.elements['years'].value = ev.years != null && ev.years !== '' ? ev.years : '';
  renderRefiMergeChecklist(new Set(Array.isArray(ev.merge_ids) ? ev.merge_ids : []));
  document.getElementById('refi-form-title').textContent = 'Upravit refinancování';
  document.getElementById('refi-submit-label').textContent = 'Uložit změny';
  document.getElementById('refi-form-card').classList.add('is-editing');
  revealForm('refi-form-card');
}

function resetRefiForm() {
  const f = refiForm();
  f.reset();
  clearFieldErrors(f);
  f.elements['id'].value = '';
  showFormError('refi-form-error', '');
  renderRefiLoanSelect();
  renderRefiMergeChecklist(new Set());
  document.getElementById('refi-form-title').textContent = 'Přidat refinancování';
  document.getElementById('refi-submit-label').textContent = 'Přidat refinancování';
  document.getElementById('refi-form-card').classList.remove('is-editing');
}

async function deleteRefinancing(id) {
  if (!(await customConfirm('Smazat toto refinancování?', 'Smazat'))) return;
  for (const l of state.loans) if (Array.isArray(l.refinancings)) l.refinancings = l.refinancings.filter((x) => x.id !== id);
  saveState();
  renderAll();
}

function submitRefiForm(e) {
  e.preventDefault();
  const f = e.target;
  if (!validateRefinancing(f)) return;
  const id = f.elements['id'].value;
  const loan = state.loans.find((l) => l.id === f.elements['loan_id'].value);
  if (!loan) return;
  const rateRaw = f.elements['rate'].value.trim();
  const yearsRaw = f.elements['years'].value.trim();
  const ev = {
    id: id || uid(),
    date: f.elements['date'].value,
    rate: rateRaw ? parseFormNumber(rateRaw) : null,
    years: yearsRaw ? Number(yearsRaw) : null,
    merge_ids: Array.from(readRefiMergeDraft() || []),
  };
  // upravené refinancování může přejít na jiný úvěr: ze starého se odebere
  for (const l of state.loans) if (Array.isArray(l.refinancings)) l.refinancings = l.refinancings.filter((x) => x.id !== ev.id);
  loan.refinancings = [...(Array.isArray(loan.refinancings) ? loan.refinancings : []), ev];
  saveState();
  resetRefiForm();
  renderAll();
  showSuccessToast(id ? 'Refinancování upraveno' : 'Refinancování přidáno');
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
  syncSettingsVisibility();
  updateRentGrowthPlaceholders();
  renderNeverSellChips();
  clearFieldErrors(document.getElementById('tab-settings'));
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
}

function wireSettingsInputs() {
  const el = (id) => document.getElementById(id);
  // Pole nastavení: pravidlo a kam se hodnota uloží (procenta jako zlomek tam, kde to výpočet čeká).
  // Chybná hodnota se do nastavení neuloží, platí dál poslední správná, a pod polem je vidět proč.
  const fields = [
    { id: 'inflation-input', rule: { kind: 'percent', required: true, min: -20, max: 100 }, apply: (n) => (state.settings.inflation_rate = n / 100) },
    { id: 'rent-growth-input', rule: { kind: 'percent', min: -50, max: 100 }, apply: (n) => (state.settings.default_rent_growth = n == null ? null : n / 100) },
    { id: 'capgains-tax-input', rule: { kind: 'percent', required: true, min: 0, max: 100 }, apply: (n) => (state.settings.capital_gains_tax_rate = n) },
    { id: 'po-tax-input', rule: { kind: 'percent', required: true, min: 0, max: 100 }, apply: (n) => (state.settings.po_tax_rate = n) },
    { id: 'sale-trigger-input', rule: { kind: 'money', min: 0, max: MAX_MONEY }, apply: (n) => (state.settings.sale_trigger_amount = n || 0) },
    { id: 'min-portfolio-input', rule: { kind: 'money', min: 0, max: MAX_MONEY }, apply: (n) => (state.settings.min_portfolio_value = n || 0) },
  ];
  const save = () => {
    for (const field of fields) {
      const input = el(field.id);
      const error = checkValue(field.rule, input.value);
      setFieldError(input, error);
      if (!error) field.apply(readNumber(input.value));
    }
    state.settings.auto_sell_enabled = el('auto-sell-enabled-input').checked;
    state.settings.po_sell_asap = el('po-sell-asap-input').checked;
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
  ].forEach((id) => el(id).addEventListener('change', save));
  // chyba zmizí, jakmile se pole začne opravovat; znovu se zkontroluje při potvrzení
  fields.forEach((field) => el(field.id).addEventListener('input', () => setFieldError(el(field.id), '')));
  el('never-sell-chips').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') setNeverSell(e.target.value, e.target.checked);
  });
}

/* ---------- SCÉNÁŘOVÉ UDÁLOSTI ---------- */

const EVENT_LABELS = {
  growth: 'Růst hodnoty nemovitostí',
  rent_growth: 'Růst nájmu',
  vacancy: 'Obsazenost',
  interest: 'Změna úrokové sazby',
  inflation: 'Inflace',
  one_time: 'Jednorázový příjem/výdaj',
  sale: 'Prodej co nejdřív',
  rate_after_fixation: 'Sazba po fixaci',
  refinance: 'Refinancování',
};

const EVENT_UNITS = { growth: 'percent', rent_growth: 'percent', vacancy: 'percent', inflation: 'percent', interest: 'percent', one_time: 'money' };
const EVENT_VALUE_LABELS = {
  growth: 'Růst',
  rent_growth: 'Růst',
  vacancy: 'Obsazenost',
  interest: 'Nová sazba',
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

function eventLabel(ev) {
  if (ev.type === 'interest' && ev.mode !== 'set') return 'Růst sazeb (starší)';
  return EVENT_LABELS[ev.type] || ev.type;
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
      // nová událost přepisuje sazbu; starší (bez mode) přičítala procentní body
      return ev.mode === 'set' ? `${fmtNumber(v)} %` : `${v > 0 ? '+' : ''}${fmtNumber(v)} p. b.`;
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
    if (calc.isPO(p) && autoSell && !p.never_sell) out.push({ ...base, type: 'sale', period: `${CURRENT_YEAR}`, value: '—' });
  }
  for (const l of state.loans) {
    const base = { derived: true, targets: l.bank, source: { kind: 'loan', id: l.id }, from: l.bank };
    if (l.rate_after_fixation != null) {
      const end = calc.fixationEndDate(l);
      out.push({ ...base, type: 'rate_after_fixation', period: end ? `od ${end.getFullYear()}` : '—', value: `${fmtNumber(l.rate_after_fixation)} %` });
    }
    for (const r of Array.isArray(l.refinancings) ? l.refinancings : []) {
      if (!r.date) continue;
      const rate = r.rate != null && r.rate !== '' ? `${fmtNumber(r.rate)} %` : '';
      const years = Number(r.years) > 0 ? `${fmtNumber(r.years, 1)} let` : '';
      out.push({ ...base, source: { kind: 'refi', id: r.id }, type: 'refinance', period: fmtDate(r.date), value: [rate, years].filter(Boolean).join(' · ') || '—' });
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
      label: eventLabel(ev),
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
      } else if (kind === 'refi') {
        showTab('tab-loans');
        fillRefiForm(id);
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
  clearFieldErrors(f);
  f.elements['id'].value = ev.id;
  f.elements['type'].value = ev.type;
  eventTargets = (ev.target_ids || []).slice();
  f.elements['year_from'].value = ev.year_from;
  f.elements['year_to'].value = ev.year_to && Number(ev.year_to) !== Number(ev.year_from) ? ev.year_to : '';
  updateEventFormUi();
  const v = Number(ev.value) || 0;
  // starší událost "růst sazeb" měla jiný význam (p. b.), takže se hodnota nepřebírá a zadá se nová sazba
  const legacyRate = ev.type === 'interest' && ev.mode !== 'set';
  setFormattedValue(f.elements['value'], legacyRate ? '' : ev.type === 'vacancy' ? +(100 - v).toFixed(4) : v);
  f.elements['note'].value = ev.note || '';
  document.getElementById('event-form-title').textContent = 'Upravit scénářovou událost';
  document.getElementById('event-submit-label').textContent = 'Uložit změny';
  document.getElementById('event-form-card').classList.add('is-editing');
  revealForm('event-form-card');
}

function resetEventForm() {
  const f = document.getElementById('event-form');
  f.reset();
  clearFieldErrors(f);
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
  if (!validateEvent(f)) return;
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
    note: cleanText(f.elements['note'].value) || null,
  };
  if (eventTargetKind(type)) payload.target_ids = eventTargets.slice();
  if (type === 'interest') payload.mode = 'set'; // nová sazba přepisuje (starší události bez mode přičítaly p. b.)
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
  return `${eventLabel(ev)} ${eventValueText(ev)}`;
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
  renderCashflowStrips();
}

/** Pruh s cashflow za letošní rok nad tabulkami nemovitostí a úvěrů (stejná čísla jako v Přehledu). */
function renderCashflowStrips() {
  let row = runProjection(1).rows[0];
  // letošní řádek pokrývá jen zbytek roku, pruh ukazuje běžnou roční hodnotu (stejná čísla jako dřív)
  const scale = 12 / (row.months || 12);
  row = {
    totalRent: row.totalRent * scale,
    totalCosts: row.totalCosts * scale,
    totalInterest: row.totalInterest * scale,
    totalPrincipal: row.totalPrincipal * scale,
    cashflow: (row.totalRent - row.totalCosts - row.totalInterest - row.totalPrincipal) * scale,
  };
  const chip = (label, value, cls) => `<span class="cf-pill ${cls || ''}"><span class="cf-label">${label}</span> <strong class="num">${fmtMoney(value)}</strong></span>`;
  const html =
    chip('Nájem', row.totalRent, 'cf-pos') +
    (row.totalCosts > 0 ? chip('Náklady', -row.totalCosts, 'cf-neg') : '') +
    chip('Splátky', -(row.totalInterest + row.totalPrincipal), 'cf-neg') +
    chip('Cashflow /rok', row.cashflow, row.cashflow < 0 ? 'cf-neg cf-total' : 'cf-pos cf-total');
  document.querySelectorAll('[data-cf-strip]').forEach((el) => {
    el.innerHTML = html;
  });
}

function renderScenarioTable() {
  closePopover();
  const key = 'scenario';
  applyTableMode(key);
  const rows = scenarioRows;
  const money = (v) => (v == null ? '<span class="t-faint">—</span>' : `<span class="num">${moneyHtml(v)}</span>`);
  const columns = [
    {
      label: 'Rok',
      cls: 'whitespace-nowrap',
      cell: (r) => {
        const hasEvent = r.sales.length > 0 || state.events.some((ev) => Number(ev.year_from) === r.year);
        return `<span class="year-label">${r.year}</span>${periodInfoButton(r.months)}${hasEvent ? '<span class="ev-dot" title="Událost v tomto roce"></span>' : ''}`;
      },
    },
    { label: 'Majetek', right: true, cell: (r) => money(r.totalValue) },
    { label: 'Dluh', right: true, cell: (r) => money(r.totalDebt) },
    { label: '<span class="m-full">Vlastní kapitál</span><span class="m-short">Kapitál</span>', right: true, cell: (r) => `<span class="font-medium">${money(r.equity)}</span>` },
    { label: 'Nájem', right: true, x: true, cell: (r) => `<span class="figure-positive">${money(r.totalRent)}</span>` },
    { label: 'Náklady', right: true, x: true, cell: (r) => `<span class="figure-negative">${money(r.totalCosts)}</span>` },
    { label: 'Úrok', right: true, x: true, cell: (r) => `<span class="figure-negative">${money(r.totalInterest)}</span>` },
    { label: 'Jistina', right: true, x: true, cell: (r) => `<span class="figure-negative">${money(r.totalPrincipal)}</span>` },
    { label: 'Splátky', right: true, x: true, cell: (r) => `<span class="figure-negative">${money(r.totalInterest == null ? null : r.totalInterest + r.totalPrincipal)}</span>` },
    { label: 'Nashrom. zhodnocení', right: true, x: true, cell: (r) => money(r.cumulativeGain) },
    {
      label: 'Cashflow',
      right: true,
      cell: (r) => `<span class="font-medium ${r.cashflow == null ? '' : r.cashflow < 0 ? 'figure-negative' : 'figure-positive'}">${money(r.cashflow)}</span>`,
    },
    {
      label: 'Událost',
      x: true,
      cls: 'ev-cell',
      cell: (r) => {
        const starting = state.events.filter((ev) => Number(ev.year_from) === r.year);
        return (
          r.sales.map((sale) => saleChipHtml(sale, r.year)).join('') +
          starting.map((ev) => `<span class="event-chip">${escapeHtml(shortEventLabel(ev))}</span>`).join('')
        );
      },
    },
  ];
  const cols = visibleColumns(columns, key);
  document.getElementById('scenario-thead').innerHTML = headHtml(cols);
  document.getElementById('scenario-tbody').innerHTML = rows
    .map((r) => `<tr>${cols.map((c) => `<td class="${c.right ? 'text-right' : ''} ${c.cls || ''}">${c.cell(r)}</td>`).join('')}</tr>`)
    .join('');
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
    const error = checkValue({ kind: 'number', integer: true, required: true, min: 2000, max: 2100, unit: '' }, yearInput.value);
    setFieldError(yearInput, error);
    if (error) return;
    overviewState.year = Number(yearInput.value);
    saveState();
    renderOverview();
  });
  yearInput.addEventListener('blur', () => {
    setFieldError(yearInput, '');
    renderOverview();
  });
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
  const months = row.months || 12; // letošek pokrývá jen zbytek roku
  const partial = !isMonth && months < 12;
  const range = monthRange(months);
  const div = isMonth ? months : 1;
  const per = isMonth ? 'měsíc' : partial ? 'zbytek roku' : 'rok';

  document.getElementById('kpi-assets').textContent = fmtMoney(row.totalValue);
  document.getElementById('kpi-debt').textContent = fmtMoney(row.totalDebt);
  document.getElementById('kpi-networth').textContent = fmtMoney(row.equity);
  document.getElementById('kpi-debtratio').textContent = row.totalValue > 0 ? fmtPercent(row.totalDebt / row.totalValue) : '0 %';
  document.getElementById('kpi-cashflow').textContent = fmtMoney((row.cashflow || 0) / div);
  document.getElementById('kpi-appreciation').textContent = fmtMoney((row.appreciationGain || 0) / div);
  // průměrný růst je vždy roční: u neúplného roku se přepočte z růstu za zbývající měsíce
  const shortRow = months < 12;
  const avgGrowthYearly = row.avgGrowthRate == null ? null : shortRow ? Math.pow(1 + row.avgGrowthRate, 12 / months) - 1 : row.avgGrowthRate;
  document.getElementById('kpi-avg-growth').textContent = avgGrowthYearly == null ? '—' : fmtPercent(avgGrowthYearly);
  document.getElementById('kpi-inflation-loss').textContent = row.inflationRate == null ? '—' : fmtPercent(row.inflationRate);
  document.getElementById('kpi-inflation-loss-amount').textContent = row.inflationLoss == null ? '—' : fmtMoney((row.inflationLoss || 0) / div);
  document.getElementById('kpi-real-appreciation').textContent = fmtMoney((row.realAppreciation || 0) / div);

  document.getElementById('kpi-cashflow-label').textContent = isMonth ? 'Měsíční cashflow' : partial ? `Cashflow ${range}` : 'Roční cashflow';
  document.getElementById('kpi-appreciation-label').textContent = isMonth ? 'Měsíční zhodnocení' : partial ? `Zhodnocení ${range}` : 'Roční zhodnocení';
  document.getElementById('kpi-real-appreciation-label').textContent = isMonth ? 'Zbývá po inflaci (měsíc)' : partial ? `Zbývá po inflaci (${range})` : 'Zbývá po inflaci (rok)';

  setFormula('kpi-assets-formula', row.cashReserve ? `Nemovitosti ${fmtMoney(row.realEstateValue)} + hotovost ${fmtMoney(row.cashReserve)}` : `Součet tržních hodnot nemovitostí`);
  setFormula('kpi-debt-formula', 'Zbývající jistina všech úvěrů');
  setFormula('kpi-networth-formula', `Majetek ${fmtMoney(row.totalValue)} − dluh ${fmtMoney(row.totalDebt)}`);
  setFormula('kpi-debtratio-formula', `Dluh ÷ majetek`);
  if (row.totalRent != null) {
    const oneTime = row.oneTime ? ` ${row.oneTime > 0 ? '+' : '−'} jednorázově ${fmtMoney(Math.abs(row.oneTime / div))}` : '';
    // změna měsíční splátky během roku (konec fixace, refinancování, růst sazeb) - ať je vidět, proč se cashflow mění
    const changes = (row.perLoan || [])
      .filter((l) => l.payChange)
      .map(
        (l) =>
          `splátka ${l.bank}: ${fmtMoney(l.payChange.from)} → ${fmtMoney(l.payChange.to)} měsíčně${l.payChange.month > 1 ? ` od ${l.payChange.month}. měsíce roku` : ''}, sazba ${fmtPercent(l.rate)}`
      );
    setFormula(
      'kpi-cashflow-formula',
      `Nájem ${fmtMoney(row.totalRent / div)} − náklady ${fmtMoney(row.totalCosts / div)} − úrok ${fmtMoney(row.totalInterest / div)} − jistina ${fmtMoney(row.totalPrincipal / div)}${oneTime}${changes.length ? '. ' + changes.join('; ') : ''}`
    );
    setFormula('kpi-appreciation-formula', `Růst hodnoty nemovitostí za ${per}`);
    setFormula('kpi-avg-growth-formula', `Zhodnocení ${fmtMoney(row.appreciationGain)} ÷ hodnota nemovitostí ${fmtMoney(row.realEstateValue)}${shortRow ? `, přepočteno z ${months} měsíců na rok` : ''}`);
    setFormula('kpi-inflation-loss-formula', `Inflace v roce ${row.year}`);
    setFormula('kpi-real-appreciation-formula', `Zhodnocení − ztráta inflací ${fmtMoney((row.inflationLoss || 0) / div)}`);
  }

  const cashflowEl = document.getElementById('kpi-cashflow');
  cashflowEl.classList.toggle('t-neg', (row.cashflow || 0) < 0);
  cashflowEl.classList.toggle('t-pos', (row.cashflow || 0) >= 0);
  const realAppEl = document.getElementById('kpi-real-appreciation');
  realAppEl.classList.toggle('t-neg', (row.realAppreciation || 0) < 0);
  realAppEl.classList.toggle('t-pos', (row.realAppreciation || 0) >= 0);

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
      resetRefiForm();
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
  resetRefiForm();
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
    ['refi-form', submitRefiForm],
    ['event-form', submitEventForm],
  ];
  for (const [id, handler] of forms) {
    const form = document.getElementById(id);
    form.noValidate = true; // chyby píše appka přímo pod pole
    form.addEventListener('submit', handler);
    preventEnterSubmit(form);
    const forgive = (e) => {
      const input = e.target;
      if (input && input.dataset && !input.dataset.typedInvalid) setFieldError(input, ''); // špatně napsané datum drží chybu, dokud se neopraví
    };
    form.addEventListener('input', forgive);
    form.addEventListener('change', forgive);
  }
  document.getElementById('property-form-reset').addEventListener('click', resetPropertyForm);
  document.getElementById('loan-form-reset').addEventListener('click', resetLoanForm);
  document.getElementById('refi-form-reset').addEventListener('click', resetRefiForm);
  document.getElementById('event-form-reset').addEventListener('click', resetEventForm);
}

window.addEventListener('error', (e) => {
  // jen chyby z kódu appky (ne z přihlašovacího okna a rozšíření prohlížeče)
  if (/[/]js[/](app|calc|cloud|auth)[.]js/.test(e.filename || '')) reportError((e.filename || '').split('/').pop() + ':' + e.lineno, e.error || e.message);
});

document.addEventListener('DOMContentLoaded', () => {
  try {
    init();
  } catch (e) {
    reportError('start', e);
    throw e;
  }
});
