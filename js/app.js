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
}

// Rozbalené roky ve Scénářích (jen pro zobrazení, neukládá se)
const expandedYears = new Set();
let scenarioShowDetail = false;

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
  const d = new Date(str);
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
  document.querySelectorAll('[data-unit]').forEach((el) => {
    const kind = el.dataset.unit;
    el.setAttribute('type', 'text');
    el.setAttribute('inputmode', kind === 'money' ? 'numeric' : 'decimal');
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

/** Hodnota nemovitosti uvolněná nad zástavou (0, pokud je zastavená i jako dodatečná jistota u úvěru). */
function freedValue(p, crossBank) {
  const marketValue = Number(p.market_value) || 0;
  if (p.has_lien) return Math.max(0, marketValue - (Number(p.lien_value) || 0));
  return crossBank ? 0 : marketValue;
}

/** Banky úvěrů, u kterých je nemovitost zastavená jako dodatečná jistota. */
function crossCollateralBanks() {
  const map = {};
  for (const l of state.loans) {
    for (const pid of l.additional_collateral_ids || []) {
      map[pid] = map[pid] ? `${map[pid]}, ${l.bank}` : l.bank;
    }
  }
  return map;
}

function ownerBadge(p) {
  return calc.isPO(p) ? '<span class="badge badge-po">PO</span>' : '<span class="badge badge-fo">FO</span>';
}

function propertyName(id) {
  const p = state.properties.find((x) => x.id === id);
  return p ? p.name : '';
}

/* ---------- MOJE NEMOVITOSTI ---------- */

function renderProperties() {
  const tbody = document.getElementById('properties-tbody');
  const tfoot = document.getElementById('properties-tfoot');
  tbody.innerHTML = '';
  const crossBanks = crossCollateralBanks();
  const totals = { rent: 0, payment: 0, value: 0, lien: 0, freed: 0, appreciated: 0, growthWeighted: 0 };

  for (const p of state.properties) {
    const av = calc.appreciatedValue(Number(p.market_value), Number(p.growth_rate));
    const tt = calc.timeTestInfo(p);
    const marketValue = Number(p.market_value) || 0;
    const lienValue = p.has_lien ? Number(p.lien_value) || 0 : 0;
    const crossBank = crossBanks[p.id];
    const freed = freedValue(p, crossBank);
    const lienCell = p.has_lien
      ? `${escapeHtml(p.lien_bank || '?')}<br><span class="text-xs t-muted num">${fmtMoney(lienValue)}</span>`
      : crossBank
      ? `Zástava<br><span class="text-xs t-muted">${escapeHtml(crossBank)}</span>`
      : '<span class="t-faint">—</span>';

    totals.rent += Number(p.rent) || 0;
    totals.payment += Number(p.payment) || 0;
    totals.value += marketValue;
    totals.lien += lienValue;
    totals.freed += freed;
    totals.appreciated += av;
    totals.growthWeighted += marketValue * (Number(p.growth_rate) || 0);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-medium">${escapeHtml(p.name)} ${ownerBadge(p)}</td>
      <td class="text-right num ${p.rent ? 'rent-positive' : 't-faint'}">${p.rent ? '+' + fmtMoney(p.rent) : '—'}</td>
      <td class="text-right num ${p.payment ? 'payment-negative' : 't-faint'}">${p.payment ? '-' + fmtMoney(p.payment) : '—'}</td>
      <td class="text-right num">${fmtMoney(marketValue)}</td>
      <td class="text-right">${lienCell}</td>
      <td class="text-right num">${fmtMoney(freed)}</td>
      <td class="text-right num">${fmtPercent(p.growth_rate)}</td>
      <td class="text-right num">${fmtMoney(av)}</td>
      <td>${tt.never ? '<span class="t-muted">Bez testu</span>' : escapeHtml(tt.text)}</td>
      <td class="whitespace-nowrap text-right">
        <button class="link-btn link-edit" data-edit-property="${p.id}">Upravit</button>
        <button class="link-btn link-delete" data-delete-property="${p.id}">Smazat</button>
      </td>`;
    tbody.appendChild(tr);
  }

  if (!state.properties.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10">Zatím žádné nemovitosti</td></tr>';
    tfoot.innerHTML = '';
  } else {
    const avgGrowth = totals.value > 0 ? totals.growthWeighted / totals.value : 0;
    tfoot.innerHTML = `<tr>
      <td>Celkem</td>
      <td class="text-right num">${fmtMoney(totals.rent)}</td>
      <td class="text-right num">${fmtMoney(totals.payment)}</td>
      <td class="text-right num">${fmtMoney(totals.value)}</td>
      <td class="text-right num">${fmtMoney(totals.lien)}</td>
      <td class="text-right num">${fmtMoney(totals.freed)}</td>
      <td class="text-right num">${fmtPercent(avgGrowth)}</td>
      <td class="text-right num">${fmtMoney(totals.appreciated)}</td>
      <td></td><td></td>
    </tr>`;
  }

  tbody.querySelectorAll('[data-edit-property]').forEach((btn) =>
    btn.addEventListener('click', () => fillPropertyForm(btn.dataset.editProperty))
  );
  tbody.querySelectorAll('[data-delete-property]').forEach((btn) =>
    btn.addEventListener('click', () => deleteProperty(btn.dataset.deleteProperty))
  );
  renderLoanPropertySelect();
  renderEventTargets();
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

  const payment = parseFormNumber(f.elements['payment'].value);
  const debt = parseFormNumber(f.elements['debt_invested'].value);
  document.getElementById('property-financing-badge').textContent = [payment ? `Splátka ${fmtMoney(payment)}` : '', debt ? `Úvěr ${fmtMoney(debt)}` : '']
    .filter(Boolean)
    .join(' · ');
}

function wirePropertyFormUi() {
  const f = propertyForm();
  f.elements['has_lien'].addEventListener('change', () => setLienFieldsVisible(f.elements['has_lien'].checked));
  f.querySelectorAll('input[name="owner_type"]').forEach((radio) =>
    radio.addEventListener('change', () => setTimeTestEnabled(f.elements['owner_type'].value !== 'po'))
  );
  f.addEventListener('input', updatePropertyBadges);
  f.addEventListener('change', updatePropertyBadges);
}

function fillPropertyForm(id) {
  const p = state.properties.find((x) => x.id === id);
  if (!p) return;
  const f = propertyForm();
  f.reset();
  f.elements['id'].value = p.id;
  f.elements['name'].value = p.name;
  setFormattedValue(f.elements['rent'], p.rent);
  setFormattedValue(f.elements['payment'], p.payment || '');
  setFormattedValue(f.elements['market_value'], p.market_value);
  setFormattedValue(f.elements['acquisition_price'], p.acquisition_price);
  setFormattedValue(f.elements['growth_rate'], (Number(p.growth_rate) || 0) * 100);
  f.elements['acquisition_date'].value = p.acquisition_date || '';
  f.elements['owner_type'].value = calc.isPO(p) ? 'po' : 'fo';
  const years = calc.taxExemptYears(p);
  f.elements['tax_exempt_years'].value = String([0, 5, 10].includes(years) ? years : 10);
  setFormattedValue(f.elements['equity_invested'], p.equity_invested || '');
  setFormattedValue(f.elements['debt_invested'], p.debt_invested || '');
  f.elements['has_lien'].checked = !!p.has_lien;
  f.elements['lien_bank'].value = p.lien_bank || '';
  setFormattedValue(f.elements['lien_value'], p.lien_value || '');
  const vacancy = Number(p.vacancy_rate) || 0;
  setFormattedValue(f.elements['occupancy'], vacancy > 0 ? +((1 - vacancy) * 100).toFixed(4) : '');
  setFormattedValue(f.elements['monthly_costs'], p.monthly_costs || '');
  setFormattedValue(f.elements['rent_growth_rate'], p.rent_growth_rate != null ? +(p.rent_growth_rate * 100).toFixed(4) : '');
  setLienFieldsVisible(!!p.has_lien);
  setTimeTestEnabled(!calc.isPO(p));
  document.getElementById('property-acc-pledge').open = !!p.has_lien;
  f.querySelectorAll('details.acc:not(.acc-pledge)').forEach((acc) => {
    acc.open = false;
  });
  const opAcc = document.getElementById('property-rent-growth').closest('details');
  opAcc.open = vacancy > 0 || !!p.monthly_costs || p.rent_growth_rate != null;
  const finAcc = f.elements['payment'].closest('details');
  finAcc.open = !!(p.payment || p.equity_invested || p.debt_invested);
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

async function deleteProperty(id) {
  if (!(await customConfirm('Opravdu smazat tuto nemovitost?', 'Smazat'))) return;
  state.properties = state.properties.filter((p) => p.id !== id);
  // ať po nemovitosti nezůstávají viset odkazy z úvěrů a událostí
  state.loans.forEach((l) => {
    if (l.property_id === id) l.property_id = null;
    if (l.additional_collateral_ids) l.additional_collateral_ids = l.additional_collateral_ids.filter((x) => x !== id);
  });
  pruneEventTargets(id, 'property');
  saveState();
  renderAll();
}

function submitPropertyForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.elements['id'].value;
  const rentGrowthRaw = f.elements['rent_growth_rate'].value.trim();
  const occupancyRaw = f.elements['occupancy'].value.trim();
  const occupancy = occupancyRaw ? Math.min(100, Math.max(0, parseFormNumber(occupancyRaw))) : 100;
  const years = Number(f.elements['tax_exempt_years'].value);
  const payload = {
    id: id || uid(),
    name: f.elements['name'].value.trim(),
    rent: parseFormNumber(f.elements['rent'].value),
    payment: parseFormNumber(f.elements['payment'].value),
    market_value: parseFormNumber(f.elements['market_value'].value),
    acquisition_price: parseFormNumber(f.elements['acquisition_price'].value),
    growth_rate: parseFormNumber(f.elements['growth_rate'].value) / 100,
    acquisition_date: f.elements['acquisition_date'].value || null,
    owner_type: f.elements['owner_type'].value === 'po' ? 'po' : 'fo',
    tax_exempt_years: [0, 5, 10].includes(years) ? years : 10,
    equity_invested: f.elements['equity_invested'].value.trim() ? parseFormNumber(f.elements['equity_invested'].value) : null,
    debt_invested: f.elements['debt_invested'].value.trim() ? parseFormNumber(f.elements['debt_invested'].value) : null,
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

/** Poměr LTV (dluh/vlastní), pokud je zadaná hodnota nemovitosti při sjednání. */
function ltvInfo(loan) {
  const propValue = Number(loan.property_value_at_origination);
  if (!propValue || propValue <= 0) return null;
  const amount = Number(loan.amount) || 0;
  const ltvPct = Math.round(Math.min(1, amount / propValue) * 100);
  return { text: `${ltvPct}/${100 - ltvPct}`, ownAmount: Math.max(0, propValue - amount) };
}

function loanForm() {
  return document.getElementById('loan-form');
}

/** Rozbalovací seznam "Zástava": které nemovitosti jsou zastavené pro tento úvěr, s hodnotou zástavy. */
function renderLoanCollateralChecklist() {
  const container = document.getElementById('loan-collateral-checklist');
  if (!container) return;
  const editId = loanForm().elements['id'].value;
  const editingLoan = editId ? state.loans.find((l) => l.id === editId) : null;
  const selected = (editingLoan && editingLoan.additional_collateral_ids) || [];
  if (!state.properties.length) {
    container.innerHTML = '<p class="text-sm t-faint">Zatím žádné nemovitosti</p>';
    updateLoanBadges();
    return;
  }
  container.innerHTML = state.properties
    .map(
      (p) => `<label class="chip" style="display:block">
        <input type="checkbox" class="loan-collateral-checkbox" value="${p.id}" ${selected.includes(p.id) ? 'checked' : ''} />
        <span style="display:flex;justify-content:space-between;gap:1rem;border-radius:0.7rem;padding:0.55rem 0.9rem">
          <strong style="font-weight:600">${escapeHtml(p.name)}</strong>
          <span class="num">${fmtMoney(freedValue(p, false))}</span>
        </span>
      </label>`
    )
    .join('');
  updateLoanBadges();
}

function renderLoanPropertySelect() {
  const select = document.getElementById('loan-property-select');
  if (!select) return;
  const previous = select.value;
  select.innerHTML =
    '<option value="">—</option>' + state.properties.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  select.value = state.properties.some((p) => p.id === previous) ? previous : '';
}

function updateLoanBadges() {
  const f = loanForm();
  const checked = Array.from(f.querySelectorAll('.loan-collateral-checkbox:checked'));
  const sum = checked.reduce((s, el) => {
    const p = state.properties.find((x) => x.id === el.value);
    return s + (p ? freedValue(p, false) : 0);
  }, 0);
  document.getElementById('loan-pledge-badge').textContent = checked.length ? `${checked.length}× · ${fmtMoney(sum)}` : 'Bez zástavy';

  const start = f.elements['start_date'].value;
  const end = f.elements['fixation_end'].value;
  const years = f.elements['fixation_years'].value;
  document.getElementById('loan-fixation-badge').textContent =
    start && end ? `${fmtDate(start)} → ${fmtDate(end)}` : end ? `do ${fmtDate(end)}` : years !== '' ? `${years} let` : '';

  const after = f.elements['rate_after_fixation'].value.trim();
  const linked = f.elements['property_id'].value;
  document.getElementById('loan-details-badge').textContent = [after ? `Po fixaci ${fmtNumber(parseFormNumber(after))} %` : '', linked ? propertyName(linked) : '']
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
    if (!start.value || years.value === '') return;
    const d = new Date(start.value);
    if (isNaN(d)) return;
    end.value = toInputDate(calc.addYears(d, Math.round(Number(years.value) || 0)));
  };
  const yearsFromEnd = () => {
    if (!start.value || !end.value) return;
    const a = new Date(start.value);
    const b = new Date(end.value);
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
  f.addEventListener('input', updateLoanBadges);
  f.addEventListener('change', updateLoanBadges);
}

function renderLoans() {
  const tbody = document.getElementById('loans-tbody');
  const tfoot = document.getElementById('loans-tfoot');
  tbody.innerHTML = '';
  const totals = { amount: 0, payment: 0, own: 0 };
  for (const l of state.loans) {
    const end = calc.fixationEndDate(l);
    const fx = end ? calc.fixationRemainingUntil(end) : null;
    const ltv = ltvInfo(l);
    totals.amount += Number(l.amount) || 0;
    totals.payment += Number(l.monthly_payment) || 0;
    if (ltv) totals.own += ltv.ownAmount;
    const years = l.fixation_years != null && l.fixation_years !== '' ? `${fmtNumber(l.fixation_years, 1)} let` : '';
    const fixCell = end
      ? `<span class="num">${fmtDate(end.toISOString())}</span>${years ? `<br><span class="text-xs t-muted">${years}</span>` : ''}`
      : years || '<span class="t-faint">—</span>';
    const linked = l.property_id ? propertyName(l.property_id) : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-medium">${escapeHtml(l.bank)}${l.note ? `<br><span class="text-xs t-muted">${escapeHtml(l.note)}</span>` : ''}</td>
      <td class="text-right num">${fmtMoney(l.amount)}</td>
      <td class="text-right num">${fmtPercent(l.interest_rate)}</td>
      <td class="text-right num">${fmtMoney(l.monthly_payment)}</td>
      <td>${fixCell}</td>
      <td>${fx ? escapeHtml(fx.text) : '<span class="t-faint">—</span>'}</td>
      <td>${ltv ? ltv.text : '<span class="t-faint">—</span>'}</td>
      <td class="text-right num">${ltv ? fmtMoney(ltv.ownAmount) : '<span class="t-faint">—</span>'}</td>
      <td>${linked ? escapeHtml(linked) : '<span class="t-faint">—</span>'}</td>
      <td class="whitespace-nowrap text-right">
        <button class="link-btn link-edit" data-edit-loan="${l.id}">Upravit</button>
        <button class="link-btn link-delete" data-delete-loan="${l.id}">Smazat</button>
      </td>`;
    tbody.appendChild(tr);
  }
  if (!state.loans.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10">Zatím žádné úvěry</td></tr>';
    tfoot.innerHTML = '';
  } else {
    tfoot.innerHTML = `<tr>
      <td>Celkem</td>
      <td class="text-right num">${fmtMoney(totals.amount)}</td>
      <td></td>
      <td class="text-right num">${fmtMoney(totals.payment)}</td>
      <td></td><td></td><td></td>
      <td class="text-right num">${totals.own ? fmtMoney(totals.own) : ''}</td>
      <td></td><td></td>
    </tr>`;
  }
  tbody.querySelectorAll('[data-edit-loan]').forEach((btn) =>
    btn.addEventListener('click', () => fillLoanForm(btn.dataset.editLoan))
  );
  tbody.querySelectorAll('[data-delete-loan]').forEach((btn) =>
    btn.addEventListener('click', () => deleteLoan(btn.dataset.deleteLoan))
  );
  renderLoanCollateralChecklist();
  renderLoanPropertySelect();
  renderEventTargets();
}

function fillLoanForm(id) {
  const l = state.loans.find((x) => x.id === id);
  if (!l) return;
  const f = loanForm();
  f.reset();
  f.elements['id'].value = l.id;
  f.elements['bank'].value = l.bank;
  setFormattedValue(f.elements['amount'], l.amount);
  setFormattedValue(f.elements['interest_rate'], +(l.interest_rate * 100).toFixed(4));
  setFormattedValue(f.elements['monthly_payment'], l.monthly_payment || '');
  f.elements['start_date'].value = l.start_date || '';
  f.elements['fixation_years'].value = l.fixation_years != null && l.fixation_years !== '' ? l.fixation_years : '';
  const end = calc.fixationEndDate(l);
  f.elements['fixation_end'].value = end ? toInputDate(end) : '';
  f.elements['note'].value = l.note || '';
  setFormattedValue(f.elements['rate_after_fixation'], l.rate_after_fixation != null ? l.rate_after_fixation : '');
  setFormattedValue(f.elements['property_value_at_origination'], l.property_value_at_origination || '');
  renderLoanPropertySelect();
  f.elements['property_id'].value = l.property_id || '';
  renderLoanCollateralChecklist();
  document.getElementById('loan-acc-pledge').open = !!(l.additional_collateral_ids && l.additional_collateral_ids.length);
  const [fixationAcc, detailsAcc] = Array.from(f.querySelectorAll('details.acc:not(.acc-pledge)'));
  fixationAcc.open = !!(l.start_date || end || l.fixation_years != null);
  detailsAcc.open = !!(l.rate_after_fixation != null || l.property_value_at_origination || l.property_id || l.note);
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
  f.querySelectorAll('details.acc').forEach((acc) => {
    acc.open = false;
  });
  document.getElementById('loan-form-title').textContent = 'Přidat úvěr';
  document.getElementById('loan-submit-label').textContent = 'Přidat úvěr';
  document.getElementById('loan-form-card').classList.remove('is-editing');
  renderLoanCollateralChecklist();
  renderLoanPropertySelect();
}

async function deleteLoan(id) {
  if (!(await customConfirm('Opravdu smazat tento úvěr?', 'Smazat'))) return;
  state.loans = state.loans.filter((l) => l.id !== id);
  pruneEventTargets(id, 'loan');
  saveState();
  renderAll();
}

function submitLoanForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.elements['id'].value;
  const rateAfterRaw = f.elements['rate_after_fixation'].value.trim();
  const propValueRaw = f.elements['property_value_at_origination'].value.trim();
  const yearsRaw = f.elements['fixation_years'].value.trim();
  const startDate = f.elements['start_date'].value || null;
  const fixationEnd = f.elements['fixation_end'].value || null;
  const payload = {
    id: id || uid(),
    bank: f.elements['bank'].value.trim(),
    amount: parseFormNumber(f.elements['amount'].value),
    interest_rate: parseFormNumber(f.elements['interest_rate'].value) / 100,
    monthly_payment: parseFormNumber(f.elements['monthly_payment'].value),
    fixation_years: yearsRaw === '' ? null : Math.max(0, Number(yearsRaw) || 0),
    start_date: startDate,
    fixation_end: fixationEnd,
    note: f.elements['note'].value.trim() || null,
    rate_after_fixation: rateAfterRaw ? parseFormNumber(rateAfterRaw) : null,
    property_value_at_origination: propValueRaw ? parseFormNumber(propValueRaw) : null,
    property_id: f.elements['property_id'].value || null,
    additional_collateral_ids: Array.from(f.querySelectorAll('.loan-collateral-checkbox:checked')).map((el) => el.value),
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

/**
 * Události, které vznikají přímo z karet nemovitostí a úvěrů (obsazenost, vlastní růst nájmu,
 * prodej PO, sazba po fixaci). Počítá je engine už z polí nemovitostí a úvěrů, tady se jen
 * ukazují ve Scénářích - upravují se v kartě, ze které pocházejí.
 */
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
    if (l.rate_after_fixation == null) continue;
    const end = calc.fixationEndDate(l);
    out.push({
      derived: true,
      type: 'rate_after_fixation',
      targets: l.bank,
      period: end ? `od ${end.getFullYear()}` : '—',
      value: `${fmtNumber(l.rate_after_fixation)} %`,
      source: { kind: 'loan', id: l.id },
      from: l.bank,
    });
  }
  return out;
}

function renderEvents() {
  const tbody = document.getElementById('events-tbody');
  const derived = derivedEvents();
  document.getElementById('events-card').classList.toggle('hidden', !state.events.length && !derived.length);
  tbody.innerHTML = '';
  for (const ev of state.events) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-medium">${EVENT_LABELS[ev.type] || ev.type}</td>
      <td>${escapeHtml(eventTargetNames(ev))}</td>
      <td class="num">${eventPeriod(ev)}</td>
      <td class="text-right num">${eventValueText(ev)}</td>
      <td>${escapeHtml(ev.note || '')}</td>
      <td class="whitespace-nowrap text-right">
        <button class="link-btn link-edit" data-edit-event="${ev.id}">Upravit</button>
        <button class="link-btn link-delete" data-delete-event="${ev.id}">Smazat</button>
      </td>`;
    tbody.appendChild(tr);
  }
  for (const d of derived) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-medium">${EVENT_LABELS[d.type]} <span class="badge badge-linked">${d.source.kind === 'property' ? 'z nemovitosti' : 'z úvěru'}</span></td>
      <td>${escapeHtml(d.targets)}</td>
      <td class="num">${d.period}</td>
      <td class="text-right num">${d.value}</td>
      <td></td>
      <td class="whitespace-nowrap text-right">
        <button class="link-btn link-edit" data-edit-source="${d.source.kind}:${d.source.id}">Upravit</button>
      </td>`;
    tbody.appendChild(tr);
  }
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

  const result = runProjection(horizon);
  const { rows, summary } = result;
  scenarioRows = rows;
  const last = rows[rows.length - 1];

  document.getElementById('sc-kpi-end-equity').textContent = fmtMoney(summary.endEquity);
  document.getElementById('sc-kpi-end-debt').textContent = fmtMoney(last.totalDebt);
  document.getElementById('sc-kpi-cagr-assets').textContent = fmtPercent(summary.cagrAssets);

  setFormula('sc-kpi-end-equity-formula', `Majetek ${fmtMoney(last.totalValue)} − dluh ${fmtMoney(last.totalDebt)}`);
  setFormula('sc-kpi-end-debt-formula', 'Zbývající jistina všech úvěrů');
  setFormula('sc-kpi-cagr-assets-formula', `Složený roční růst hodnoty nemovitostí za ${horizon} let`);

  document.getElementById('scenario-chart').innerHTML = buildLineChartSVG([
    { cls: 'chart-line-assets', points: rows.map((r) => ({ x: r.year, y: r.totalValue })) },
    { cls: 'chart-line-debt', points: rows.map((r) => ({ x: r.year, y: r.totalDebt })) },
    { cls: 'chart-line-equity', points: rows.map((r) => ({ x: r.year, y: r.equity })) },
  ]);

  renderScenarioTable();
}

function renderScenarioTable() {
  const rows = scenarioRows;
  const colspan = scenarioShowDetail ? 10 : 6;
  const detailCell = (v, colorClass) =>
    `<td class="text-right num scenario-detail-col ${scenarioShowDetail ? '' : 'hidden'} ${colorClass || ''}">${v == null ? '—' : fmtMoney(v)}</td>`;

  const html = rows
    .map((r) => {
      const expanded = expandedYears.has(r.year);
      const debtService = r.totalInterest == null ? null : r.totalInterest + r.totalPrincipal;
      const starting = state.events.filter((ev) => Number(ev.year_from) === r.year);
      const chips =
        r.sales.map((s) => `<span class="event-chip event-chip-sale">${saleChipText(s)}</span>`).join('') +
        starting.map((ev) => `<span class="event-chip">${escapeHtml(shortEventLabel(ev))}</span>`).join('');
      const main = `<tr class="year-row" data-year="${r.year}">
        <td><button type="button" class="year-pill" aria-expanded="${expanded}" aria-label="Rok ${r.year} - detail po nemovitostech"><span class="year-chevron"></span>${r.year}</button></td>
        <td class="text-right num">${fmtMoney(r.totalValue)}</td>
        <td class="text-right num">${fmtMoney(r.totalDebt)}</td>
        <td class="text-right num font-medium">${fmtMoney(r.equity)}</td>
        ${detailCell(r.totalRent, 'figure-positive')}
        ${detailCell(r.totalCosts, 'figure-negative')}
        ${detailCell(debtService, 'figure-negative')}
        ${detailCell(r.cumulativeGain)}
        <td class="text-right num font-medium ${r.cashflow == null ? '' : r.cashflow < 0 ? 'figure-negative' : 'figure-positive'}">${r.cashflow === null ? '—' : fmtMoney(r.cashflow)}</td>
        <td>${chips}</td>
      </tr>`;
      return expanded ? main + `<tr class="year-detail"><td colspan="${colspan}">${buildYearDetail(r)}</td></tr>` : main;
    })
    .join('');
  document.getElementById('scenario-tbody').innerHTML = html;
}

/**
 * Detail roku po nemovitostech: stejné veličiny jako v hlavním řádku, ale za jednotlivé nemovitosti.
 * Ukazuje jen to, co jde spočítat: dluh a splátka nemovitosti se znají, jen když je k ní v úvěru
 * přiřazená nemovitost ("Financuje nemovitost") - jinak je u ní pomlčka.
 */
function buildYearDetail(r) {
  const hasFlows = r.cashflow != null;
  const loans = r.perLoan || [];
  const everyLoanLinked = state.loans.every((l) => l.property_id && state.properties.some((p) => p.id === l.property_id));
  const money = (v, cls) => (v == null ? '<span class="t-faint">—</span>' : `<span class="${cls || ''}">${fmtMoney(v)}</span>`);

  const propertyRows = (r.perProperty || [])
    .map((pp) => {
      const linked = loans.filter((l) => l.property_id === pp.id);
      const debtKnown = linked.length > 0 || everyLoanLinked;
      const debt = debtKnown ? linked.reduce((s, l) => s + l.balance, 0) : null;
      const service = debtKnown && hasFlows ? linked.reduce((s, l) => s + l.payment, 0) : null;
      const equity = debt == null ? null : pp.value - debt;
      const cash = service == null ? null : pp.cashflow - service;
      return `<tr>
        <td class="font-medium">${escapeHtml(pp.name)} ${pp.owner === 'po' ? '<span class="badge badge-po">PO</span>' : ''}${pp.sold ? ' <span class="badge badge-linked">prodáno</span>' : ''}</td>
        <td>${money(pp.value)}</td>
        <td>${money(debt, 'figure-negative')}</td>
        <td>${money(equity)}</td>
        <td>${hasFlows ? money(pp.rent, 'figure-positive') : money(null)}</td>
        <td>${hasFlows ? money(pp.costs, 'figure-negative') : money(null)}</td>
        <td>${money(service, 'figure-negative')}</td>
        <td>${hasFlows ? money(pp.appreciation) : money(null)}</td>
        <td>${money(cash, cash == null ? '' : cash < 0 ? 'figure-negative' : 'figure-positive')}</td>
      </tr>`;
    })
    .join('');

  const loanRows = loans
    .map(
      (l) => `<tr>
        <td class="font-medium">${escapeHtml(l.bank)}</td>
        <td>${l.property_id ? escapeHtml(propertyName(l.property_id)) : '<span class="t-faint">—</span>'}</td>
        <td>${money(l.balance, 'figure-negative')}</td>
        <td>${hasFlows ? fmtPercent(l.rate) : '—'}</td>
        <td>${hasFlows ? money(l.interest, 'figure-negative') : '—'}</td>
        <td>${hasFlows ? money(l.principal) : '—'}</td>
        <td>${hasFlows ? money(l.payment, 'figure-negative') : '—'}</td>
      </tr>`
    )
    .join('');

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
      <thead><tr><th>Nemovitost</th><th>Majetek</th><th>Dluh</th><th>Vlastní kapitál</th><th>Nájem</th><th>Náklady</th><th>Splátka</th><th>Zhodnocení</th><th>Cashflow</th></tr></thead>
      <tbody>${propertyRows || '<tr><td colspan="9" class="t-faint">Žádné nemovitosti</td></tr>'}</tbody>
    </table></div>
    ${
      loanRows
        ? `<div class="detail-title">Úvěry</div><div class="overflow-x-auto"><table class="subtbl">
      <thead><tr><th>Úvěr</th><th>Nemovitost</th><th>Zůstatek</th><th>Sazba</th><th>Úrok</th><th>Jistina</th><th>Splátky</th></tr></thead>
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
  const btn = document.getElementById('scenario-detail-toggle');
  btn.addEventListener('click', () => {
    scenarioShowDetail = !scenarioShowDetail;
    btn.textContent = scenarioShowDetail ? 'Skrýt detail' : 'Zobrazit detail';
    document.querySelectorAll('.scenario-detail-col').forEach((el) => el.classList.toggle('hidden', !scenarioShowDetail));
    renderScenarioTable();
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
