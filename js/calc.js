/*
 * Čisté výpočetní funkce - přepis vzorců z "INVESTIČNÍ KALKULAČKA 1.xlsx" plus
 * rozšířený víceletý simulační model (viz projectPortfolio níže).
 * Žádná z těchto funkcí nesahá na DOM ani na síť.
 */

/** Hodnota nemovitosti po ročním zhodnocení. Excel: F*rate+F */
function appreciatedValue(marketValue, growthRate) {
  return marketValue * (1 + (growthRate || 0));
}

/**
 * Kalendářní rozdíl mezi dvěma daty, ekvivalent Excel DATEDIF("y")/("ym")/("md") dohromady.
 * Předpokládá to >= from. Vrací { years, months, days }.
 */
function calendarDiff(from, to) {
  if (to < from) return { years: 0, months: 0, days: 0 };
  let years = to.getFullYear() - from.getFullYear();
  let months = to.getMonth() - from.getMonth();
  let days = to.getDate() - from.getDate();

  if (days < 0) {
    months -= 1;
    const prevMonthLastDay = new Date(to.getFullYear(), to.getMonth(), 0).getDate();
    days += prevMonthLastDay;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years, months, days };
}

/** Přidá k datu daný počet let (zachovává den/měsíc jako Excel DATE(YEAR(x)+n, MONTH(x), DAY(x))). */
function addYears(date, years) {
  return new Date(date.getFullYear() + years, date.getMonth(), date.getDate());
}

/** Přidá k datu daný počet měsíců. */
function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

/** Datum z textu "RRRR-MM-DD" (nebo jiného formátu) jako místní datum - bez posunu o časové pásmo. */
function toDate(value) {
  if (value instanceof Date) return value;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
}

/**
 * ČASOVÝ TEST - zbývající čas do konce daňového časového testu.
 * Excel: "y let " & "ym měs. a " & "md dní", nebo "0 let 0 měs. 0 dní" pokud test už uplynul.
 */
function timeTestRemaining(acquisitionDate, exemptYears, today = new Date()) {
  const target = addYears(acquisitionDate, exemptYears);
  if (today >= target) {
    return { done: true, text: '0 let 0 měs. 0 dní', years: 0, months: 0, days: 0 };
  }
  const { years, months, days } = calendarDiff(today, target);
  return { done: false, text: `${years} let ${months} měs. a ${days} dní`, years, months, days };
}

/** Zbývající čas do zadaného data konce fixace. Excel: "m měs. a md dní" (m = celkem měsíců). */
function fixationRemainingUntil(target, today = new Date()) {
  if (today >= target) {
    return { done: true, text: '0 měs. 0 dní', totalMonths: 0, days: 0 };
  }
  const { years, months, days } = calendarDiff(today, target);
  const totalMonths = years * 12 + months;
  return { done: false, text: `${totalMonths} měs. a ${days} dní`, totalMonths, days };
}

/** FIXACE - zbývající čas do konce fixace počítané z počátku a doby fixace. */
function fixationRemaining(startDate, fixationYears, today = new Date()) {
  return fixationRemainingUntil(addYears(startDate, fixationYears), today);
}

/**
 * Datum konce fixace úvěru: buď zadané přímo (fixation_end), nebo počátek + doba fixace.
 * Vrací null, když ho nejde určit.
 */
function fixationEndDate(loan) {
  if (loan.fixation_end) {
    const d = toDate(loan.fixation_end);
    if (!isNaN(d)) return d;
  }
  if (loan.start_date && loan.fixation_years != null && loan.fixation_years !== '') {
    const start = toDate(loan.start_date);
    if (!isNaN(start)) return addMonths(start, Math.round((Number(loan.fixation_years) || 0) * 12));
  }
  return null;
}

/* =========================================================================
 * FO / PO a časový test
 * ========================================================================= */

/** Nemovitost pořízená na právnickou osobu: žádný časový test, daň se platí vždy. */
function isPO(property) {
  return !!property && property.owner_type === 'po';
}

/** Počet let časového testu (0 = žádný, výchozí 10 u starších záznamů bez hodnoty). */
function taxExemptYears(property) {
  if (property.tax_exempt_years == null || property.tax_exempt_years === '') return 10;
  return Number(property.tax_exempt_years) || 0;
}

/**
 * Stav časového testu nemovitosti k danému dni: { done, never, text }.
 * done = prodej je bez daně, never = test se nikdy nesplní (PO).
 */
function timeTestInfo(property, today = new Date()) {
  if (isPO(property)) return { done: false, never: true, text: 'Bez časového testu' };
  const years = taxExemptYears(property);
  if (years <= 0) return { done: true, never: false, none: true, text: '—' };
  // bez data pořízení se počítá od dneška (aplikace chybějící datum při uložení sama doplní dnešním)
  const acquired = property.acquisition_date ? toDate(property.acquisition_date) : new Date();
  const tt = timeTestRemaining(acquired, years, today);
  return { done: tt.done, never: false, text: tt.text };
}

/* =========================================================================
 * SCÉNÁŘE / PŘEHLED - jednotný víceletý simulační model.
 * rows[0] odpovídá dnešku (stejná čísla jako by dal originální jednoroční
 * Excel vzorec), rows[1..horizonYears] jsou skládaně dopočítané roky dopředu.
 * Přehled i Scénáře čerpají ze stejné funkce - Přehled si jen vybere jeden rok.
 * ========================================================================= */

function yearOf(dateStr, fallbackYear) {
  if (!dateStr) return fallbackYear;
  const d = toDate(dateStr);
  return isNaN(d) ? fallbackYear : d.getFullYear();
}

/* ---------- Scénářové události ---------- */

/** Poslední rok, kdy událost platí (prázdné "do" = trvale; jednorázová jen v jednom roce). */
function eventLastYear(event) {
  if (event.type === 'one_time') return Number(event.year_to || event.year_from);
  return event.year_to ? Number(event.year_to) : Infinity;
}

function eventAppliesInYear(event, year) {
  return year >= Number(event.year_from) && year <= eventLastYear(event);
}

function eventHasTargets(event) {
  return Array.isArray(event.target_ids) && event.target_ids.length > 0;
}

/**
 * Události daného typu platné v roce `year` pro cíl `targetId` (nemovitost/úvěr).
 * Událost bez vybraných cílů platí pro všechny.
 */
function matchingEvents(events, type, year, targetId) {
  return events.filter((e) => {
    if (e.type !== type || !eventAppliesInYear(e, year)) return false;
    if (!eventHasTargets(e)) return true;
    return targetId != null && e.target_ids.includes(targetId);
  });
}

/**
 * Hodnota, kterou pro daný rok (a případně konkrétní nemovitost) přepisuje událost
 * daného typu. Událost zacílená na konkrétní nemovitost má přednost před celoportfoliovou;
 * při překryvu stejné konkrétnosti vyhrává poslední v seznamu.
 */
function resolvePortfolioOverride(events, type, year, targetId) {
  const matches = matchingEvents(events, type, year, targetId);
  if (!matches.length) return undefined;
  const specific = matches.filter(eventHasTargets);
  const pool = specific.length ? specific : matches;
  return Number(pool[pool.length - 1].value);
}

function resolvePortfolioRate(events, type, year, fallbackFraction, targetId) {
  const v = resolvePortfolioOverride(events, type, year, targetId);
  return v === undefined ? fallbackFraction : v / 100;
}

/**
 * Starší události "růst sazeb" (bez mode) přičítaly procentní body; ty se dál přehrávají beze změny.
 * O kolik se sazba daného úvěru v roce `year` zvyšuje (nebo snižuje), jako zlomek.
 */
function loanRateDelta(events, loanId, year) {
  return matchingEvents(events, 'interest', year, loanId)
    .filter((e) => e.mode !== 'set')
    .reduce((s, e) => s + (Number(e.value) || 0), 0) / 100;
}

/**
 * Sazba úvěru přepsaná událostí "Změna úrokové sazby" (mode 'set'): hodnota je nová roční sazba v %, ne příplatek.
 * Zacílená událost má přednost před celoportfoliovou, při shodě vyhrává poslední. Vrací zlomek, nebo undefined.
 */
function loanRateOverride(events, loanId, year) {
  const matches = matchingEvents(events, 'interest', year, loanId).filter((e) => e.mode === 'set');
  if (!matches.length) return undefined;
  const specific = matches.filter(eventHasTargets);
  const pool = specific.length ? specific : matches;
  return Math.max(0, Number(pool[pool.length - 1].value) || 0) / 100;
}

/** Výchozí růst nájmu nemovitosti: její vlastní, jinak výchozí z Nastavení, jinak inflace. */
function rentGrowthBase(property, settings) {
  if (property.rent_growth_rate != null) return Number(property.rent_growth_rate);
  const fallback = settings.default_rent_growth;
  if (fallback != null && fallback !== '') return Number(fallback);
  return Number(settings.inflation_rate) || 0;
}

/**
 * Zrekonstruuje, jak by (se stejným růstem/splátkami jako dnes) vypadaly
 * nemovitosti a úvěry v nějakém MINULÉM roce - obrácením zhodnocení (dělením
 * místo násobení) a obrácením umoření úvěru měsíc po měsíci (přesná inverze
 * kroku v amortizeLoanForYear: principal = (principal + splátka) / (1 + sazba/12)).
 * Používá se v Přehledu, když uživatel zvolí rok před dneškem - jinak appka
 * umí jen predikci DOPŘEDU od dneška (viz projectPortfolio).
 * Nemovitosti/úvěry, které v cílovém roce ještě neexistovaly (podle data
 * pořízení/sjednání), se vynechají.
 */
function rebaseToYear(properties, loans, settings, events, targetYear, currentYear, startMonth) {
  const rebasedProperties = [];
  for (const p of properties) {
    if (yearOf(p.acquisition_date, currentYear) > targetYear) continue;
    let value = Number(p.market_value) || 0;
    let rent = Number(p.rent) || 0;
    const rentBase = rentGrowthBase(p, settings);
    // dnešek je uprostřed letošního roku: nejdřív zpět na 1. 1. letošního roku (poměrná část zhodnocení)
    const monthsDone = startMonth == null ? defaultStartMonth(currentYear) : startMonth;
    value /= Math.pow(1 + resolvePortfolioRate(events, 'growth', currentYear, Number(p.growth_rate) || 0, p.id), monthsDone / 12);
    for (let y = currentYear; y > targetYear; y--) {
      // hodnota na začátku roku y vznikla zhodnocením během roku y-1, nájem roku y je navýšený v roce y
      value /= 1 + resolvePortfolioRate(events, 'growth', y - 1, Number(p.growth_rate) || 0, p.id);
      rent /= 1 + resolvePortfolioRate(events, 'rent_growth', y, rentBase, p.id);
    }
    rebasedProperties.push({ ...p, market_value: value, rent });
  }

  const rebasedLoans = [];
  for (const l of loans) {
    const amount = projectLoanAmount(l, targetYear, currentYear, events, startMonth);
    if (amount == null) continue;
    rebasedLoans.push({ ...l, amount });
  }

  return { properties: rebasedProperties, loans: rebasedLoans };
}

/**
 * Zbývající jistina úvěru k 1. 1. libovolného roku (minulého i budoucího) - pro
 * budoucnost amortizuje dopředu (stejně jako projectPortfolio), pro minulost
 * obrácením stejným způsobem jako rebaseToYear. Vrací null, pokud úvěr v tom
 * roce ještě nebyl sjednaný.
 */
function projectLoanAmount(loan, targetYear, currentYear, events, startMonth) {
  events = events || [];
  const monthsDone = startMonth == null ? defaultStartMonth(currentYear) : startMonth;
  const loanStartYear = yearOf(loan.start_date, currentYear);
  if (loanStartYear > targetYear) return null;
  let principal = Number(loan.amount) || 0;
  if (targetYear > currentYear) {
    const ls = { remainingPrincipal: principal, startYear: loanStartYear, projYear: currentYear, startMonth: monthsDone };
    for (let y = currentYear; y < targetYear; y++) {
      amortizeLoanForYear(loan, ls, y, currentYear, loanRateDelta(events, loan.id, y), loanRateOverride(events, loan.id, y));
    }
    return ls.remainingPrincipal;
  }
  // zpětně: nejdřív letošní měsíce do dneška, pak celé roky až po 1. 1. cílového roku
  const payment = Number(loan.monthly_payment) || 0;
  for (let y = currentYear; y >= targetYear; y--) {
    const override = loanRateOverride(events, loan.id, y);
    const monthlyRate = (override != null ? override : Math.max(0, loanRateForYear(loan, loanStartYear, y) + loanRateDelta(events, loan.id, y))) / 12;
    const months = y === currentYear ? monthsDone : 12;
    for (let m = 0; m < months; m++) principal = (principal + payment) / (1 + monthlyRate);
  }
  return Math.max(0, principal);
}

/* =========================================================================
 * ÚVĚRY - měsíční splátkový kalendář (anuita, stejná metodika jako bankovní kalkulačka)
 *
 * Každý měsíc: úrok = zbývající jistina × roční sazba / 12, jistina = splátka − úrok.
 * Splátka je po celou dobu stejná, proto je v prvních letech většina splátky úrok a
 * podíl jistiny roste. Splátku zná uživatel z banky (monthly_payment); nezadá-li ji, ale
 * zná splatnost (maturity_date), dopočítá se anuitním vzorcem. Prázdná splátka bez
 * splatnosti = úvěr "jen úrok" (jistina se nesplácí).
 *
 * Co se s úvěrem může stát:
 * - Konec fixace (od měsíce konce fixace): nová sazba (rate_after_fixation); banka přepočítá splátku
 *   na zbývající dobu (nebo platí zadaná payment_after_fixation).
 * - Refinancování (samostatné události loan.refinancings = [{ date, rate, years, merge_ids }], u úvěru jich může být víc):
 *   "kolo od začátku" - ze zbývající jistiny se podle nové sazby a nové doby (years) spočítá nová anuita, takže se zase
 *   platí hlavně úrok. Nová smlouva nahrazuje původní, takže sazba po fixaci té staré už neplatí. Při refinancování se
 *   dají sloučit i další úvěry (merge_ids): jejich zůstatky se k tomu měsíci splatí a přičtou k refinancovanému úvěru,
 *   který je dál splácí jednou novou anuitou. (Starší záznam má jedno refinancování v polích refinance_date,
 *   refinance_rate, refinance_years a refinance_merge_ids - čte se také.)
 * - Scénářová událost "změna úrokové sazby": sazba úvěru se po dobu události přepíše na zadanou hodnotu (nahoru i dolů),
 *   banka přepočítá splátku tak, aby se úvěr splatil ve stejném termínu. Po skončení události se sazba vrací.
 * - Mimořádné splacení z prodeje nemovitosti: doba splácení zůstává, banka sníží splátku.
 * ========================================================================= */

const monthIndex = (date) => date.getFullYear() * 12 + date.getMonth();

/**
 * Řádky simulace jsou KALENDÁŘNÍ roky. První řádek (letošek) pokrývá jen zbytek roku od dneška (od měsíce
 * `defaultStartMonth`), další řádky celé roky leden až prosinec. Data (konec fixace, refinancování, splatnost) se tak
 * dají přímo na kalendářní měsíc. Mimo aktuální rok (zpětný výpočet) se začíná od ledna.
 */
function defaultStartMonth(startYear) {
  const now = new Date();
  return startYear === now.getFullYear() ? now.getMonth() : 0;
}

/** Měsíc (absolutně), od kterého platí nové podmínky po datu; od 16. dne až následující měsíc. */
function monthAfter(date) {
  return monthIndex(date) + (date.getDate() > 15 ? 1 : 0);
}

/**
 * Měsíc, od kterého platí podmínky po fixaci. null = konec fixace není znám (pak se nic nemění).
 * Bez data počátku se fixace počítá od dneška (od měsíce `startMonth` roku sjednání).
 */
function fixationChangeMonth(loan, loanStartYear, startMonth = 0) {
  if (loan.fixation_end) {
    const d = toDate(loan.fixation_end);
    if (!isNaN(d)) return monthAfter(d);
  }
  if (loan.fixation_years == null || loan.fixation_years === '') return null;
  const months = Math.round((Number(loan.fixation_years) || 0) * 12);
  if (loan.start_date) {
    const start = toDate(loan.start_date);
    if (!isNaN(start)) return monthAfter(addMonths(start, months));
  }
  return loanStartYear * 12 + startMonth + months;
}

/** Rok, od kterého úvěr přechází na sazbu po fixaci (Infinity = neznámo). */
function fixationEndYear(loan, loanStartYear) {
  const month = fixationChangeMonth(loan, loanStartYear, defaultStartMonth(loanStartYear));
  return month == null ? Infinity : Math.floor(month / 12);
}

/** Základní roční úroková sazba úvěru pro daný rok (zlomek), bez událostí a refinancování. */
function loanRateForYear(loan, loanStartYear, year) {
  const hasAfter = loan.rate_after_fixation != null && loan.rate_after_fixation !== '';
  const ratePct =
    hasAfter && year >= fixationEndYear(loan, loanStartYear) ? Number(loan.rate_after_fixation) : Number(loan.interest_rate) * 100;
  return ratePct / 100;
}

/** Měsíční anuitní splátka, která při dané roční sazbě splatí `principal` za `months` měsíců. */
function annuityPayment(principal, annualRate, months) {
  if (months <= 0) return principal;
  const r = annualRate / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

/** Za kolik měsíců se při dané splátce a sazbě splatí `principal` (Infinity, pokud splátka nepokryje úrok). */
function remainingTermMonths(principal, payment, annualRate) {
  if (principal <= 0) return 0;
  if (payment <= 0) return Infinity;
  const r = annualRate / 12;
  if (r === 0) return principal / payment;
  const x = 1 - (principal * r) / payment;
  if (x <= 0) return Infinity;
  return -Math.log(x) / Math.log(1 + r);
}

/**
 * Refinancování úvěru jako seznam událostí: loan.refinancings = [{ id, date, rate (%), years, merge_ids }].
 * Starší záznam má jedno refinancování v polích refinance_date / refinance_rate / refinance_years / refinance_merge_ids.
 * Vrací [{ id, date, abs, rate (zlomek | null), term (měsíce | null), mergeIds }] seřazené podle měsíce.
 */
function refinancingList(loan) {
  const hasNumber = (v) => v != null && v !== '' && !isNaN(Number(v));
  const raw = Array.isArray(loan.refinancings)
    ? loan.refinancings
    : loan.refinance_date
      ? [{ id: 'refi-' + loan.id, date: loan.refinance_date, rate: loan.refinance_rate, years: loan.refinance_years, merge_ids: loan.refinance_merge_ids }]
      : [];
  const list = [];
  for (const r of raw) {
    if (!r || !r.date) continue;
    const date = toDate(r.date);
    if (isNaN(date)) continue;
    list.push({
      id: r.id,
      date,
      abs: monthAfter(date),
      rate: hasNumber(r.rate) ? Number(r.rate) / 100 : null,
      term: Number(r.years) > 0 ? Number(r.years) * 12 : null,
      mergeIds: Array.isArray(r.merge_ids) ? r.merge_ids : [],
    });
  }
  return list.sort((a, b) => a.abs - b.abs);
}

/** Počáteční stav úvěru v prvním simulovaném roce (splátka, zbývající doba, plánované změny). */
function initLoanState(loan, ls, firstYear) {
  // v prvním simulovaném roce (letošek) se začíná od dnešního měsíce, jinak od ledna
  const firstMonth = firstYear === ls.projYear ? ls.startMonth || 0 : 0;
  const firstAbs = firstYear * 12 + firstMonth;
  const balance = ls.remainingPrincipal;
  const hasNumber = (v) => v != null && v !== '' && !isNaN(Number(v));
  ls.afterRate = hasNumber(loan.rate_after_fixation) ? Number(loan.rate_after_fixation) / 100 : null;
  ls.afterPay = Number(loan.payment_after_fixation) > 0 ? Number(loan.payment_after_fixation) : null;
  ls.keepPay = false;
  ls.fixAbs = fixationChangeMonth(loan, ls.startYear, ls.startYear === ls.projYear ? ls.startMonth || 0 : 0);
  ls.refQueue = refinancingList(loan);

  let rate = Number(loan.interest_rate) || 0;
  let pay = Number(loan.monthly_payment) || 0;
  // fixace už skončila (nebo končí hned): zadaná splátka je už ta aktuální, jen se použije nová sazba
  const fixationOver = ls.fixAbs != null && ls.fixAbs <= firstAbs;
  if (fixationOver) {
    if (ls.afterRate != null) rate = ls.afterRate;
    if (ls.afterPay != null) pay = ls.afterPay;
    ls.fixAbs = null;
  }
  // refinancování, které už proběhlo, je ve vstupních údajích úvěru (částka, sazba, splátka) zahrnuté
  ls.refQueue = ls.refQueue.filter((r) => r.abs >= firstAbs);

  // Zadaná splátka má přednost: splatnost se bere jen tehdy, když splátka není zadaná (jinak by si zadaná splátka a splatnost
  // odporovaly a po konci fixace by splátka klesla, i když sazba roste).
  let term = null;
  if (loan.maturity_date && pay <= 0) {
    const d = toDate(loan.maturity_date);
    const months = isNaN(d) ? 0 : monthIndex(d) - firstAbs + 1;
    if (months >= 1) term = months;
  }
  if (pay <= 0 && term != null) pay = annuityPayment(balance, rate, term);
  if (term == null) term = remainingTermMonths(balance, pay, rate);

  ls.rate = rate;
  ls.pay = pay;
  ls.term = term;
  ls.delta = 0;
  ls.override = null;
  ls.firstAbs = firstAbs;
  ls.init = true;
}

/**
 * Plán sloučení úvěrů při refinancování. Úvěr, jehož refinancování má `merge_ids`, převezme k měsíci refinancování
 * zůstatky vybraných úvěrů ("dárců"), ty se splatí a dál se neplatí. Slučuje se jen do budoucnosti (u minulého
 * data jsou dnešní zůstatky už sloučené). Úvěr je buď dárce, nebo úvěr, který slučuje, ne obojí (řetězení se
 * ignoruje). Vrací { mergeInto: { [idDárce]: { to, abs } } }.
 */
function mergePlan(loans, projYear, projMonth) {
  const ids = new Set(loans.map((l) => l.id));
  const todayAbs = projYear * 12 + (projMonth || 0);
  const mergeInto = {};
  for (const l of loans) {
    for (const ev of refinancingList(l)) {
      if (!ev.mergeIds.length || ev.abs < todayAbs) continue;
      for (const id of ev.mergeIds) {
        if (id === l.id || !ids.has(id) || mergeInto[id]) continue;
        mergeInto[id] = { to: l.id, abs: ev.abs };
      }
    }
  }
  // žádné řetězení: úvěr, který něco slučuje, se sám nesloučí do jiného (a naopak)
  const survivors = new Set(Object.values(mergeInto).map((m) => m.to));
  for (const id of Object.keys(mergeInto)) {
    if (survivors.has(id) || !ids.has(mergeInto[id].to) || mergeInto[mergeInto[id].to]) delete mergeInto[id];
  }
  return { mergeInto };
}

/** Úvěry v pořadí, ve kterém se mají umořovat: nejdřív ty, které se slučují (jejich zůstatek se předává), pak ostatní. */
function loansInMergeOrder(loans, plan) {
  return loans.filter((l) => plan.mergeInto[l.id]).concat(loans.filter((l) => !plan.mergeInto[l.id]));
}

/** Aktuální sazba úvěru: přepsaná scénářem, jinak základní sazba (+ posun ze starších událostí). Nikdy záporná. */
function effectiveRate(ls) {
  return Math.max(0, ls.override != null ? ls.override : ls.rate + ls.delta);
}

/**
 * Umoří jeden úvěr o kalendářní rok `stateYear` (v prvním simulovaném roce jen od dneška do prosince). Mutuje stav
 * úvěru `ls` (remainingPrincipal, splátka, zbývající doba...). Vrací za ten rok
 * { interest, principal, rate, payment, monthlyPayment } (payment = zaplaceno za rok celkem).
 * `rateDelta` = posun sazby ze starších scénářových událostí (zlomek), `rateOverride` = sazba přepsaná událostí
 * "změna úrokové sazby" (zlomek, undefined = bez přepisu). `book` je sdílená účetní kniha sloučení úvěrů (viz
 * mergePlan): úvěr, který se slučuje, v ní k měsíci sloučení zanechá svůj zůstatek a úvěr, který slučuje, si ho převezme.
 */
function amortizeLoanForYear(loan, ls, stateYear, startYear, rateDelta = 0, rateOverride, book) {
  if (!(ls.remainingPrincipal > 0 && stateYear >= ls.startYear)) {
    return { interest: 0, principal: 0, rate: 0, payment: 0, monthlyPayment: 0 };
  }
  if (!ls.init) initLoanState(loan, ls, stateYear);

  let interest = 0;
  let principal = 0;
  let payChange = null; // změna měsíční splátky během roku (měsíc 1-12, původní a nová splátka)
  // splátka snížená mimořádným splacením z prodeje nemovitosti na konci minulého roku
  if (ls.salePayFrom != null) {
    if (Math.abs(ls.pay - ls.salePayFrom) > 0.5) payChange = { month: 1, from: ls.salePayFrom, to: ls.pay };
    ls.salePayFrom = null;
  }
  const rateStart = effectiveRate(ls);
  const payStart = ls.pay;
  const mFrom = stateYear === ls.projYear ? ls.startMonth || 0 : 0;
  let lastPaidAbs = null;
  for (let m = mFrom; m < 12; m++) {
    if (ls.remainingPrincipal <= 0) break;
    const abs = stateYear * 12 + m;
    if (book && ls.mergeAbs === abs) {
      // sloučení: zůstatek se předá úvěru, do kterého se slučuje, a tenhle úvěr se od tohoto měsíce neplatí
      book[ls.mergeTo + ':' + abs] = (book[ls.mergeTo + ':' + abs] || 0) + ls.remainingPrincipal;
      (book.log = book.log || []).push({ from: loan.id, bank: loan.bank, to: ls.mergeTo, abs, amount: ls.remainingPrincipal });
      ls.remainingPrincipal = 0;
      break;
    }
    const payBefore = ls.pay;
    let recompute = false;
    let forceAnnuity = false;
    let payFixed = false;
    if (ls.refQueue && ls.refQueue.length && ls.refQueue[0].abs === abs) {
      // refinancování: nová anuita ze zbývající jistiny (nová sazba, nová doba)
      const incoming = book ? book[loan.id + ':' + abs] || 0 : 0;
      if (incoming > 0) {
        // sloučené úvěry: jejich zůstatky se přičtou a nová anuita se počítá z celé částky
        ls.mergeIn = { abs, own: ls.remainingPrincipal, added: incoming };
        ls.remainingPrincipal += incoming;
        delete book[loan.id + ':' + abs];
      }
      // víc refinancování v jednom měsíci se použije popořadě
      while (ls.refQueue.length && ls.refQueue[0].abs === abs) {
        const ev = ls.refQueue.shift();
        if (ev.rate != null) {
          ls.rate = ev.rate;
          ls.fixAbs = null; // nová smlouva nahrazuje původní: sazba (a splátka) po fixaci staré smlouvy už neplatí
        }
        if (ev.term != null) {
          ls.term = ev.term;
          forceAnnuity = true;
        }
      }
      if (ls.fixAbs === abs) ls.fixAbs = null;
      recompute = true;
    } else if (ls.fixAbs === abs) {
      ls.fixAbs = null;
      if (ls.afterRate != null) {
        ls.rate = ls.afterRate;
        recompute = true;
      }
      if (ls.afterPay != null) {
        ls.pay = ls.afterPay;
        ls.term = remainingTermMonths(ls.remainingPrincipal, ls.pay, effectiveRate(ls));
        payFixed = true;
      }
    }
    if (m === mFrom && (rateDelta !== ls.delta || (rateOverride == null ? null : rateOverride) !== ls.override)) {
      ls.delta = rateDelta;
      ls.override = rateOverride == null ? null : rateOverride;
      recompute = true;
    }
    const rate = effectiveRate(ls);
    if (recompute && !payFixed && Number.isFinite(ls.term) && ls.term > 0 && (ls.pay > 0 || forceAnnuity)) {
      ls.pay = annuityPayment(ls.remainingPrincipal, rate, Math.max(ls.term, 1));
    }
    if (Math.abs(ls.pay - payBefore) > 0.5) payChange = { month: m + 1, from: payBefore, to: ls.pay };

    const interestM = ls.remainingPrincipal * (rate / 12);
    let principalM = ls.pay - interestM;
    // zbytek pod půl haléře se doplatí touto splátkou (jinak by zaokrouhlení přidalo další měsíc s drobnou splátkou)
    if (principalM > ls.remainingPrincipal - 0.005) principalM = ls.remainingPrincipal;
    if (principalM < 0) principalM = 0;
    ls.remainingPrincipal -= principalM;
    interest += interestM;
    principal += principalM;
    lastPaidAbs = abs;
    if (Number.isFinite(ls.term)) ls.term = Math.max(0, ls.term - 1);
  }
  ls.remainingPrincipal = Math.max(ls.remainingPrincipal, 0);
  return {
    interest,
    principal,
    rate: effectiveRate(ls),
    rateStart,
    payment: interest + principal,
    monthlyPayment: ls.pay,
    monthlyPaymentStart: payStart,
    payChange,
    lastPaidAbs,
  };
}

/**
 * Splátka, zbývající doba a rok doplacení úvěru podle zadaných údajů (bez scénářových událostí).
 * auto = splátka není zadaná a dopočítala se ze splatnosti.
 */
function loanTerms(loan, firstYear, startMonth) {
  firstYear = firstYear || new Date().getFullYear();
  const amount = Number(loan.amount) || 0;
  const ls = {
    remainingPrincipal: amount,
    startYear: Math.max(yearOf(loan.start_date, firstYear), firstYear),
    projYear: firstYear,
    startMonth: startMonth == null ? defaultStartMonth(firstYear) : startMonth,
  };
  if (amount <= 0) return { payment: 0, termMonths: 0, payoffYear: null, payoffMonth: null, auto: false };
  initLoanState(loan, ls, ls.startYear);
  const payoffAbs = Number.isFinite(ls.term) ? ls.firstAbs + Math.ceil(ls.term) - 1 : null;
  return {
    payment: ls.pay,
    termMonths: ls.term,
    payoffYear: payoffAbs == null ? null : Math.floor(payoffAbs / 12),
    payoffMonth: payoffAbs == null ? null : (payoffAbs % 12) + 1,
    auto: !(Number(loan.monthly_payment) > 0) && ls.pay > 0,
  };
}

/**
 * Splátkový kalendář úvěru po letech (jako list "Roky" v bankovní kalkulačce): úvěr, podíl úroku
 * ve splátkách a zůstatek. Zahrnuje fixaci, refinancování i scénářové události. S `loans` (všechny úvěry) počítá
 * i sloučení úvěrů při refinancování: úvěr, který slučuje, převezme zůstatky, a úvěr, který se slučuje, končí.
 * Vrací i měsíc doplacení (payoffAbs), sloučení do jiného úvěru (mergedInto) a převzaté zůstatky (merges).
 */
function loanSchedule(loan, { events = [], startYear, maxYears = 40, startMonth, loans } = {}) {
  startYear = startYear || new Date().getFullYear();
  const sm = startMonth == null ? defaultStartMonth(startYear) : startMonth;
  const plan = loans ? mergePlan(loans, startYear, sm) : { mergeInto: {} };
  const makeState = (l) => {
    const st = { remainingPrincipal: Number(l.amount) || 0, startYear: yearOf(l.start_date, startYear), projYear: startYear, startMonth: sm };
    const m = plan.mergeInto[l.id];
    if (m) {
      st.mergeTo = m.to;
      st.mergeAbs = m.abs;
    }
    return st;
  };
  const ls = makeState(loan);
  const donors = (loans || []).filter((l) => plan.mergeInto[l.id] && plan.mergeInto[l.id].to === loan.id).map((l) => ({ loan: l, ls: makeState(l) }));
  const book = {};
  const rows = [];
  let payoffAbs = null;
  let year = Math.max(startYear, ls.startYear);
  for (let i = 0; i < maxYears && ls.remainingPrincipal > 0.5; i++, year++) {
    for (const d of donors) amortizeLoanForYear(d.loan, d.ls, year, startYear, loanRateDelta(events, d.loan.id, year), loanRateOverride(events, d.loan.id, year), book);
    const balanceStart = ls.remainingPrincipal;
    const r = amortizeLoanForYear(loan, ls, year, startYear, loanRateDelta(events, loan.id, year), loanRateOverride(events, loan.id, year), book);
    if (r.lastPaidAbs != null) payoffAbs = r.lastPaidAbs;
    rows.push({
      year,
      months: year === ls.projYear ? 12 - (ls.startMonth || 0) : 12,
      balanceStart,
      interest: r.interest,
      principal: r.principal,
      payment: r.payment,
      interestShare: r.payment > 0 ? r.interest / r.payment : 0,
      balanceEnd: ls.remainingPrincipal,
      rate: r.rate,
      monthlyPayment: r.monthlyPayment,
    });
  }
  const paidOff = ls.remainingPrincipal <= 0.5;
  return {
    rows,
    totalInterest: rows.reduce((s, r) => s + r.interest, 0),
    totalPrincipal: rows.reduce((s, r) => s + r.principal, 0),
    paidOff,
    payoffAbs: paidOff ? payoffAbs : null,
    mergedInto: plan.mergeInto[loan.id] || null,
    merges: (book.log || []).filter((e) => e.to === loan.id),
  };
}

/**
 * Hlavní simulace portfolia na `horizonYears` let dopředu.
 * properties/loans/settings: stejná data jako jinde v appce.
 * events: pole { type: 'growth'|'rent_growth'|'vacancy'|'inflation'|'interest'|'one_time',
 *                year_from, year_to, value, target_ids, note }
 *
 * Řádky jsou KALENDÁŘNÍ roky. Model odděluje STAV (majetek/dluh na začátku období) a TOK (co se stane BĚHEM
 * období). rows[k] = stav na začátku období a tokové veličiny (cashflow, zhodnocení, daň...) ZA TOTO OBDOBÍ.
 * rows[0] je letošek: stav je dnešek a toky jsou jen od dneška do konce roku (rows[0].months < 12, pokud už
 * letos něco uplynulo). Další řádky jsou celé roky (leden až prosinec, stav k 1. 1.). Zhodnocení hodnoty v
 * neúplném roce se počítá poměrně. Scénářová událost s rokem Y ovlivňuje tok v řádku Y a stav až od řádku Y+1.
 * Poslední řádek má jen stav (nemá už žádný další rok, ze kterého by tok počítal).
 * Daň z příjmu z pronájmu se tak počítá stejně pro "dnešek" i pro všechny
 * budoucí roky - na rozdíl od daně z prodeje se časového testu netýká.
 *
 * Součástí simulace je i AUTOMATICKÝ PRODEJ nemovitosti na umoření dluhu,
 * VOLITELNÝ (viz karta "Automatický prodej" v Nastavení):
 * - settings.auto_sell_enabled (výchozí true, pokud chybí) ho jako celek
 *   zapíná/vypíná.
 * - settings.min_portfolio_value (Kč, 0 = bez omezení) je ochranná hranice -
 *   prodej se nikdy neprovede, pokud by hodnota ZBÝVAJÍCÍCH nemovitostí
 *   klesla pod ni.
 * - settings.sale_trigger_amount (Kč, 0/prázdné = výchozí chování) pevně
 *   určuje, kolik nastřádaného zhodnocení stačí k prodeji - když není
 *   zadáno, použije se cena nejlevnější dostupné nemovitosti.
 * - nemovitosti na PO (bez časového testu, daň se platí vždy) se prodají co
 *   nejdřív, hned první rok, kdy je portfolio vlastní (settings.po_sell_asap,
 *   výchozí zapnuto) - dál zhodnocená hodnota by jen zvětšovala daň.
 * Pevné pravidlo bez výjimky: FO nemovitost se v běžném automatickém prodeji
 * NIKDY neprodá, dokud u ní neuplyne časový test. Ze způsobilých nemovitostí se prodává ta nejméně výkonná:
 * nejdřív podle výnosnosti z nájmu (nižší výnos dřív), potom podle zhodnocení (nižší dřív).
 */
function projectPortfolio({ properties, loans, settings, events, horizonYears, startYear, startMonth }) {
  startYear = startYear || new Date().getFullYear();
  const timelineMonth = startMonth == null ? defaultStartMonth(startYear) : startMonth;
  const firstRowMonths = 12 - timelineMonth; // letošek: od dneška do prosince
  events = events || [];
  horizonYears = Math.max(1, Number(horizonYears) || 1);
  const capGainsTaxRate = (Number(settings.capital_gains_tax_rate) || 0) / 100;
  const poTaxRate = settings.po_tax_rate != null && settings.po_tax_rate !== '' ? Number(settings.po_tax_rate) / 100 : capGainsTaxRate;
  const inflationBase = Number(settings.inflation_rate) || 0;
  const autoSellEnabled = settings.auto_sell_enabled !== false;
  const poSellAsap = settings.po_sell_asap !== false;
  const minPortfolioValue = Number(settings.min_portfolio_value) || 0;
  const saleTriggerAmount = Number(settings.sale_trigger_amount) || 0;

  const loanState = {};
  const loanShares = {};
  const mergeBook = {}; // sloučení úvěrů při refinancování (viz mergePlan)
  const merging = mergePlan(loans, startYear, timelineMonth);
  for (const l of loans) {
    loanState[l.id] = { remainingPrincipal: Number(l.amount) || 0, startYear: yearOf(l.start_date, startYear), projYear: startYear, startMonth: timelineMonth };
    const m = merging.mergeInto[l.id];
    if (m) {
      loanState[l.id].mergeTo = m.to;
      loanState[l.id].mergeAbs = m.abs;
    }
    loanShares[l.id] = loanPropertyShares(l, properties);
  }
  const loansToAmortize = loansInMergeOrder(loans, merging);

  const curValue = {};
  const curRent = {};
  const curCost = {};
  const started = new Set();
  const soldProperties = new Set();
  for (const p of properties) {
    curValue[p.id] = Number(p.market_value) || 0;
    curRent[p.id] = Number(p.rent) || 0;
    curCost[p.id] = (Number(p.monthly_costs) || 0) * 12;
  }

  let cashReserve = 0;
  let cumulativeCashflow = 0;
  let cumulativeGain = 0; // zhodnocení portfolia nastřádané od posledního automatického prodeje
  const rows = [];

  for (let k = 0; k <= horizonYears; k++) {
    const stateYear = startYear + k;
    const months = k === 0 ? firstRowMonths : 12; // kolik měsíců řádek pokrývá
    const yf = months / 12;
    const activeProps = properties.filter(
      (p) => yearOf(p.acquisition_date, startYear) <= stateYear && !soldProperties.has(p.id)
    );
    // Úvěr se počítá do dluhu portfolia až od svého skutečného data sjednání -
    // stejná podmínka jako uvnitř amortizeLoanForYear (stateYear >= ls.startYear).
    const activeLoans = loans.filter((l) => stateYear >= loanState[l.id].startYear);
    const realEstateValue = activeProps.reduce((s, p) => s + curValue[p.id], 0);
    const totalDebt = activeLoans.reduce((s, l) => s + loanState[l.id].remainingPrincipal, 0);
    const totalValue = realEstateValue + cashReserve;
    const equity = totalValue - totalDebt;

    if (k === horizonYears) {
      rows.push({
        year: stateYear,
        months: null,
        realEstateValue,
        cashReserve,
        totalValue,
        totalDebt,
        equity,
        cashflow: null,
        cumulativeCashflow,
        appreciationGain: null,
        avgGrowthRate: null,
        inflationRate: null,
        inflationLoss: null,
        realAppreciation: null,
        totalRent: null,
        totalCosts: null,
        totalInterest: null,
        totalPrincipal: null,
        cumulativeGain,
        sales: [],
        perProperty: activeProps.map((p) => ({ id: p.id, name: p.name, owner: isPO(p) ? 'po' : 'fo', value: curValue[p.id] })),
        perLoan: activeLoans
          .filter((l) => loanState[l.id].remainingPrincipal > 0.005)
          .map((l) => ({ id: l.id, bank: l.bank, property_id: l.property_id || null, shares: loanShares[l.id], balance: loanState[l.id].remainingPrincipal })),
      });
      break;
    }

    // --- TOK: co se stane během roku stateYear ---
    const inflation = resolvePortfolioRate(events, 'inflation', stateYear, inflationBase);

    let appreciationGain = 0;
    let totalRentNOI = 0;
    let totalRent = 0;
    let totalCosts = 0;
    const perProperty = [];

    for (const p of activeProps) {
      // nájem a náklady se indexují od druhého roku vlastnictví (první rok jsou zadané hodnoty)
      const rentGrowth = resolvePortfolioRate(events, 'rent_growth', stateYear, rentGrowthBase(p, settings), p.id);
      if (started.has(p.id)) {
        curRent[p.id] *= 1 + rentGrowth;
        curCost[p.id] *= 1 + inflation;
      }
      started.add(p.id);

      const growth = resolvePortfolioRate(events, 'growth', stateYear, Number(p.growth_rate) || 0, p.id);
      const vacancy = resolvePortfolioRate(events, 'vacancy', stateYear, Number(p.vacancy_rate) || 0, p.id);

      const valueBefore = curValue[p.id];
      curValue[p.id] = valueBefore * Math.pow(1 + growth, yf);
      const gain = curValue[p.id] - valueBefore;
      appreciationGain += gain;

      const rentAnnual = curRent[p.id] * months * (1 - vacancy); // za období řádku (letošek jen zbytek roku)
      const costAnnual = curCost[p.id] * yf;
      const propertyNOI = rentAnnual - costAnnual;
      totalRentNOI += propertyNOI;
      totalRent += rentAnnual;
      totalCosts += costAnnual;
      perProperty.push({
        id: p.id,
        name: p.name,
        owner: isPO(p) ? 'po' : 'fo',
        value: valueBefore,
        appreciation: gain,
        rent: rentAnnual,
        costs: costAnnual,
        cashflow: propertyNOI,
        vacancy,
        growth,
        sold: false,
      });
    }

    // Úvěry se umořují po jednom (každý má svou sazbu, splátku i případné zvýšení sazby ze scénáře).
    let totalInterest = 0;
    let totalPrincipal = 0;
    const perLoanById = {};
    for (const l of loansToAmortize) {
      const ls = loanState[l.id];
      const balance = ls.remainingPrincipal;
      const active = stateYear >= ls.startYear;
      const { interest, principal, rate, payment, monthlyPayment, payChange } = amortizeLoanForYear(l, ls, stateYear, startYear, loanRateDelta(events, l.id, stateYear), loanRateOverride(events, l.id, stateYear), mergeBook);
      totalInterest += interest;
      totalPrincipal += principal;
      // splacený úvěr už v přehledu úvěrů nefiguruje
      if (active && balance > 0.005) {
        perLoanById[l.id] = {
          id: l.id,
          bank: l.bank,
          property_id: l.property_id || null,
          shares: loanShares[l.id],
          balance,
          rate,
          interest,
          principal,
          payment,
          monthlyPayment,
          payChange,
        };
      }
    }
    const perLoan = loans.filter((l) => perLoanById[l.id]).map((l) => perLoanById[l.id]);
    // po sloučení patří úvěr, který slučuje, ke všem nemovitostem sloučených úvěrů (podle výše zůstatků)
    for (const l of loans) {
      const info = loanState[l.id].mergeIn;
      if (!info || info.applied) continue;
      info.applied = true;
      const parts = [{ w: info.own, shares: loanShares[l.id] }];
      for (const d of loans) {
        const st = loanState[d.id];
        if (st.mergeTo === l.id && st.mergeAbs === info.abs) parts.push({ w: (mergeBook.log || []).filter((e) => e.from === d.id && e.abs === info.abs).reduce((x, e) => x + e.amount, 0), shares: loanShares[d.id] });
      }
      const total = parts.reduce((x, p) => x + p.w, 0);
      if (total > 0) {
        const combined = {};
        for (const p of parts) for (const [pid, share] of Object.entries(p.shares)) combined[pid] = (combined[pid] || 0) + (share * p.w) / total;
        loanShares[l.id] = combined;
      }
    }

    const oneTimeTotal = events
      .filter((e) => e.type === 'one_time' && eventAppliesInYear(e, stateYear))
      .reduce((s, e) => s + (Number(e.value) || 0), 0);
    cashReserve += oneTimeTotal;

    const cashflow = totalRentNOI - totalInterest - totalPrincipal + oneTimeTotal;
    cumulativeCashflow += cashflow;

    const inflationLoss = realEstateValue * inflation * yf;

    // --- Automatický prodej nemovitostí na umoření dluhu (na konci roku) ---
    // Nastřádané zhodnocení navíc samo podléhá inflaci (je to "papírový" zisk,
    // dokud se nerealizuje prodejem) - starší část součtu se každý rok
    // reálně znehodnotí, teprve pak se přičte letošní (ještě neznehodnocený) přírůstek.
    cumulativeGain = cumulativeGain / Math.pow(1 + inflation, yf) + appreciationGain;
    const sales = [];
    const saleDate = new Date(stateYear + 1, 0, 1);

    const sell = (candidate, reason, extra = {}) => {
      cashReserve += candidate.netProceeds;
      soldProperties.add(candidate.property.id);
      const sold = perProperty.find((pp) => pp.id === candidate.property.id);
      if (sold) sold.sold = true;
      const preferred = {};
      for (const l of activeLoans) preferred[l.id] = loanShares[l.id][candidate.property.id] || 0;
      cashReserve = payDownDebtWithCash(activeLoans, loanState, stateYear, cashReserve, preferred);
      const totalDebtAfterSale = activeLoans.reduce((s, l) => s + loanState[l.id].remainingPrincipal, 0);
      sales.push({
        saleYear: stateYear,
        reason,
        propertyId: candidate.property.id,
        propertyName: candidate.property.name,
        owner: isPO(candidate.property) ? 'po' : 'fo',
        // Cena v roce prodeje (už zhodnocená skládaným růstem) a původní pořizovací cena.
        marketValue: candidate.marketValue,
        acquisitionPrice: Number(candidate.property.acquisition_price) || 0,
        saleProceeds: candidate.netProceeds,
        estimatedSaleTax: candidate.estimatedSaleTax,
        taxExempt: candidate.taxExempt,
        triggeredByGain: cumulativeGain,
        yieldPct: candidate.yieldPct,
        growth: candidate.growth,
        loanFullyCleared: totalDebtAfterSale <= 0.01,
        cashAfter: cashReserve,
        ...extra,
      });
    };

    // výkon nemovitosti v tomto roce (nájem, náklady, neobsazenost a růst už s událostmi) pro řazení kandidátů na prodej
    const performanceOf = (p) => {
      const pp = perProperty.find((x) => x.id === p.id);
      return {
        valueBase: pp ? pp.value : curValue[p.id], // hodnota na začátku roku, ke které se vztahuje nájem tohoto roku
        rentMonthly: curRent[p.id],
        costsAnnual: curCost[p.id],
        vacancy: pp ? pp.vacancy : Number(p.vacancy_rate) || 0,
        growth: pp ? pp.growth : Number(p.growth_rate) || 0,
      };
    };

    if (autoSellEnabled) {
      // 1) PO: prodat co nejdřív
      if (poSellAsap) {
        for (const p of activeProps) {
          if (!isPO(p) || soldProperties.has(p.id) || curValue[p.id] <= 0) continue;
          const remainingValue = activeProps.filter((x) => !soldProperties.has(x.id)).reduce((s, x) => s + curValue[x.id], 0);
          if (remainingValue - curValue[p.id] < minPortfolioValue) continue;
          sell(scoreSaleCandidate(p, curValue[p.id], capGainsTaxRate, saleDate, poTaxRate, performanceOf(p)), 'po');
        }
      }

      // 2) běžný prodej FO nemovitosti, když nastřádané zhodnocení dosáhne prahu
      const totalDebtNow = activeLoans.reduce((s, l) => s + loanState[l.id].remainingPrincipal, 0);
      const stillOwned = activeProps.filter((p) => !soldProperties.has(p.id));
      const realEstateValueNow = stillOwned.reduce((s, p) => s + curValue[p.id], 0);
      // Kandidát na prodej smí být jen nemovitost, jejíž prodej NESRAZÍ hodnotu
      // zbývajících nemovitostí pod minPortfolioValue, A ZÁROVEŇ u ní musí být už
      // splněný časový test - nemovitost se NIKDY neprodává před jeho splněním.
      const unsold = stillOwned.filter((p) => {
        if (curValue[p.id] <= 0) return false;
        if (realEstateValueNow - curValue[p.id] < minPortfolioValue) return false;
        return timeTestInfo(p, saleDate).done;
      });
      if (totalDebtNow > 0.01 && unsold.length) {
        const cheapestValue = Math.min(...unsold.map((p) => curValue[p.id]));
        // Práh, po jehož dosažení se prodává: pevná částka z Nastavení, nebo (výchozí)
        // cena nejlevnější dostupné nemovitosti - "kolik reálně stojí náhrada".
        const threshold = saleTriggerAmount > 0 ? saleTriggerAmount : cheapestValue;
        if (cumulativeGain >= threshold) {
          // Prodává se nemovitost s nejnižším celkovým hodnocením kvality (výnos z nájmu, zhodnocení, stav, lokalita,
          // rekonstrukce, energetický štítek), při shodě ta s nižším výnosem. Viz propertyQuality a compareSaleCandidates.
          const score = (p) => scoreSaleCandidate(p, curValue[p.id], capGainsTaxRate, saleDate, poTaxRate, performanceOf(p));
          const candidates = unsold.map(score).sort(compareSaleCandidates);
          const eligibleIds = new Set(unsold.map((p) => p.id));
          const notEligible = stillOwned.filter((p) => !eligibleIds.has(p.id)).map(score);
          sell(candidates[0], 'gain', { threshold, comparison: describeSaleChoice(candidates[0], candidates, notEligible) });
          cumulativeGain = 0;
        }
      }
    }

    rows.push({
      year: stateYear,
      months,
      realEstateValue,
      cashReserve,
      totalValue,
      totalDebt,
      equity,
      cashflow,
      cumulativeCashflow,
      appreciationGain,
      avgGrowthRate: realEstateValue > 0 ? appreciationGain / realEstateValue : 0,
      inflationRate: inflation,
      inflationLoss,
      realAppreciation: appreciationGain - inflationLoss,
      totalRent,
      totalCosts,
      totalInterest,
      totalPrincipal,
      oneTime: oneTimeTotal,
      cumulativeGain,
      sales,
      perProperty,
      perLoan,
    });
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  // Růst hodnoty NEMOVITOSTÍ - čistá vážená sazba zhodnocení, složená za
  // celý horizont ze skutečné avgGrowthRate jednotlivých let (rows[k], k < horizonYears).
  // NESMÍ se počítat jako prosté porovnání celkové hodnoty na začátku/konci
  // (last.totalValue / first.totalValue) - to by jako "růst" započítalo i
  // kapitál vložený koupí DALŠÍ nemovitosti během horizontu, případně vliv
  // hotovostní rezervy/splácení dluhu. avgGrowthRate každého roku je naproti
  // tomu čistý poměr appreciationGain ÷ realEstateValue toho roku.
  let assetGrowthFactor = 1;
  let growthMonths = 0;
  for (let k = 0; k < horizonYears; k++) {
    assetGrowthFactor *= 1 + (Number(rows[k].avgGrowthRate) || 0);
    growthMonths += rows[k].months;
  }
  const cagrAssets = Math.pow(assetGrowthFactor, 12 / growthMonths) - 1;

  return {
    rows,
    summary: {
      startEquity: first.equity,
      endEquity: last.equity,
      totalCashflow: last.cumulativeCashflow,
      totalGain: last.equity - first.equity + last.cumulativeCashflow,
      cagrAssets,
    },
  };
}

/* =========================================================================
 * KVALITA NEMOVITOSTI - celkové hodnocení 0 až 100 (červená, oranžová, zelená)
 *
 * Skládá se z výnosu z nájmu na hodnotu, zhodnocení a údajů z karty nemovitosti (stav, lokalita, rekonstrukce,
 * energetický štítek). Každá složka dostane 0 až 100 bodů, celek je vážený průměr. Neuvedený údaj se bere jako
 * průměr (50 bodů), aby nemovitost bez vyplněných údajů nebyla ani zvýhodněná, ani potrestaná.
 * Podle hodnocení se při automatickém prodeji na umoření dluhu vybírá, co se prodá první: nejnižší.
 * ========================================================================= */

const QUALITY_WEIGHTS = { yield: 30, growth: 20, condition: 15, location: 15, renovation: 10, energy: 10 };

/** Body za zvolenou možnost u složek, které se vybírají z nabídky karty nemovitosti. */
const QUALITY_SCORES = {
  condition: { new: 100, excellent: 85, good: 65, fair: 40, poor: 15 },
  location: { top: 100, good: 75, avg: 50, weak: 20 },
  renovation: { after: 100, none: 90, before: 20 },
  energy: { A: 100, B: 90, C: 75, D: 55, E: 35, F: 20, G: 5 },
};
const QUALITY_NEUTRAL = 50;

/** Pásmo hodnocení podle zaokrouhleného čísla, které se zobrazuje: pod 40 červená (low), do 64 oranžová (mid), od 65 zelená (high). */
function qualityBand(score) {
  const points = Math.round(score);
  return points < 40 ? 'low' : points < 65 ? 'mid' : 'high';
}

/** Čistá výnosnost z nájmu dnes: (nájem za rok po neobsazenosti − náklady za rok) ÷ tržní hodnota. */
function propertyNetYield(property) {
  const value = Number(property.market_value) || 0;
  if (!(value > 0)) return 0;
  const rent = (Number(property.rent) || 0) * 12 * (1 - (Number(property.vacancy_rate) || 0));
  return (rent - (Number(property.monthly_costs) || 0) * 12) / value;
}

/**
 * Hodnocení kvality nemovitosti. `perf` = { yieldPct, growth } (v simulaci hodnoty z roku prodeje), bez něj se bere
 * výnos a zhodnocení zadané u nemovitosti.
 *   výnos z nájmu:  1 % = 0 bodů, 7 % = 100 bodů (lineárně)
 *   zhodnocení:    -2 % = 0 bodů, 6 % = 100 bodů (lineárně)
 * Vrací { score, band, parts: [{ key, weight, score, known, value }] }, složky v pořadí výnos, zhodnocení, stav, lokalita,
 * rekonstrukce, energetický štítek (known = údaj je uvedený, value = výnos / zhodnocení / zvolená možnost).
 */
function propertyQuality(property, perf) {
  const p = property || {};
  const yieldPct = perf && perf.yieldPct != null ? perf.yieldPct : propertyNetYield(p);
  const growth = perf && perf.growth != null ? perf.growth : Number(p.growth_rate) || 0;
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const parts = [
    { key: 'yield', score: clamp(((yieldPct - 0.01) / 0.06) * 100), known: true, value: yieldPct },
    { key: 'growth', score: clamp(((growth + 0.02) / 0.08) * 100), known: true, value: growth },
  ];
  for (const key of ['condition', 'location', 'renovation', 'energy']) {
    const option = p[key];
    const known = typeof option === 'string' && Object.prototype.hasOwnProperty.call(QUALITY_SCORES[key], option);
    parts.push({ key, score: known ? QUALITY_SCORES[key][option] : QUALITY_NEUTRAL, known, value: known ? option : null });
  }
  let total = 0;
  let weights = 0;
  for (const part of parts) {
    part.weight = QUALITY_WEIGHTS[part.key];
    total += part.weight * part.score;
    weights += part.weight;
  }
  const score = total / weights;
  return { score, band: qualityBand(score), parts };
}

/**
 * Podklady pro rozhodnutí o prodeji nemovitosti: výnosnost z nájmu, zhodnocení, hodnocení kvality a odhad daně z prodeje.
 *
 * yieldPct = čistá výnosnost z nájmu = (nájem za rok po neobsazenosti − náklady za rok) ÷ hodnota na začátku roku.
 * Počítá se z nájmu, nákladů a hodnoty v roce prodeje (`perf`), jinak z údajů zadaných u nemovitosti. growth = roční zhodnocení.
 * quality = celkové hodnocení nemovitosti (viz propertyQuality) s výnosem a zhodnocením z roku prodeje.
 *
 * estimatedSaleTax = odhad daně z příjmu z PRODEJE, KDYBY se nemovitost prodala
 * teď. Platí se jen jednou při prodeji a jen pokud ještě neuplynul časový test -
 * po jeho splnění je zisk z prodeje od daně osvobozen (§4 ZDP). U PO se daň
 * platí vždy (sazbou poTaxRate).
 */
function scoreSaleCandidate(property, marketValue, capGainsTaxRate, today, poTaxRate, perf) {
  const gain = marketValue - (Number(property.acquisition_price) || 0);
  const gainPct = marketValue > 0 ? gain / marketValue : 0;
  const tt = timeTestInfo(property, today);
  const taxRate = isPO(property) && poTaxRate != null ? poTaxRate : capGainsTaxRate;
  const rentMonthly = perf ? perf.rentMonthly : Number(property.rent) || 0;
  const vacancy = perf ? perf.vacancy : Number(property.vacancy_rate) || 0;
  const costsAnnual = perf ? perf.costsAnnual : (Number(property.monthly_costs) || 0) * 12;
  const growth = perf ? perf.growth : Number(property.growth_rate) || 0;
  // výnosnost se vztahuje k hodnotě na začátku roku (ke které patří tento nájem), ať ji zhodnocení nezkresluje podruhé
  const valueBase = perf && perf.valueBase > 0 ? perf.valueBase : marketValue;
  const yieldPct = valueBase > 0 ? (rentMonthly * 12 * (1 - vacancy) - costsAnnual) / valueBase : 0;
  const estimatedSaleTax = tt.done ? 0 : Math.max(gain, 0) * taxRate;
  const netProceeds = marketValue - estimatedSaleTax;
  const quality = propertyQuality(property, { yieldPct, growth });
  return { property, marketValue, gain, gainPct, taxExempt: tt.done, timeTestText: tt.text, yieldPct, growth, quality, estimatedSaleTax, netProceeds };
}

/**
 * Srovnání nemovitostí při rozhodnutí o prodeji, z něj se v aplikaci skládá vysvětlení, proč se prodala právě tahle.
 * Řádek = nemovitost, perMillion = čistý nájem za rok v Kč na 1 mil. hodnoty, quality = { score, band }. Nejdřív způsobilé
 * nemovitosti v pořadí prodeje, pak ty, které ještě neprošly časovým testem (s textem, kolik jim zbývá).
 * decidedBy: 'only' = jediná způsobilá, 'quality' = nejnižší celkové hodnocení. parts = složky hodnocení prodané nemovitosti.
 */
function describeSaleChoice(chosen, eligible, notEligible) {
  const row = (c, isEligible) => ({
    id: c.property.id,
    name: c.property.name,
    owner: isPO(c.property) ? 'po' : 'fo',
    perMillion: Math.round(c.yieldPct * 1e6),
    yieldPct: c.yieldPct,
    growth: c.growth,
    quality: { score: c.quality.score, band: c.quality.band },
    eligible: isEligible,
    timeTestText: isEligible ? '' : c.timeTestText,
    chosen: c === chosen,
  });
  return {
    decidedBy: eligible.length <= 1 ? 'only' : 'quality',
    parts: chosen.quality.parts.map(({ key, weight, score, known, value }) => ({ key, weight, score, known, value })),
    rows: eligible.map((c) => row(c, true)).concat(notEligible.map((c) => row(c, false))),
  };
}

/**
 * Pořadí prodeje: nemovitost s nejnižším celkovým hodnocením kvality první. Při shodě rozhoduje nižší výnosnost z nájmu,
 * pak nižší zhodnocení. Kandidát bez vypočteného hodnocení se ohodnotí z výnosnosti a zhodnocení.
 */
function compareSaleCandidates(a, b) {
  const scoreOf = (c) => (c.quality ? c.quality.score : propertyQuality(c.property || {}, { yieldPct: c.yieldPct, growth: c.growth }).score);
  const qa = scoreOf(a);
  const qb = scoreOf(b);
  if (qa !== qb) return qa - qb;
  if (a.yieldPct !== b.yieldPct) return a.yieldPct - b.yieldPct;
  return a.growth - b.growth;
}

/* =========================================================================
 * ZÁSTAVY - kolik z hodnoty nemovitosti je volné k zastavení
 *
 * Na nemovitosti může ležet vlastní zástava (has_lien/lien_value) a zástavy za jiné úvěry
 * (loan.collateral = [{ property_id, amount }]). Součet nesmí přesáhnout tržní hodnotu.
 * ========================================================================= */

/** Zástavy zadané u úvěru: [{ property_id, amount }]. Starší záznam jen s ID = zastaveno celé (amount Infinity). */
function loanCollateral(loan) {
  if (Array.isArray(loan.collateral)) {
    return loan.collateral.filter((c) => c && c.property_id).map((c) => ({ property_id: c.property_id, amount: Number(c.amount) || 0 }));
  }
  return (loan.additional_collateral_ids || []).map((id) => ({ property_id: id, amount: Infinity }));
}

/** Vlastní zástava nemovitosti (Kč). */
function ownLienValue(property) {
  return property.has_lien ? Number(property.lien_value) || 0 : 0;
}

/** Kolik z nemovitosti je zastaveno za úvěry (bez úvěru \`excludeLoanId\`, např. toho, který se právě upravuje). */
function pledgedByLoans(propertyId, loans, excludeLoanId) {
  let sum = 0;
  for (const l of loans || []) {
    if (excludeLoanId && l.id === excludeLoanId) continue;
    for (const c of loanCollateral(l)) if (c.property_id === propertyId) sum += c.amount;
  }
  return sum;
}

/** Volná hodnota k zastavení = tržní hodnota − vlastní zástava − zástavy za úvěry (nikdy záporná). */
function freePledgeValue(property, loans, excludeLoanId) {
  const marketValue = Number(property.market_value) || 0;
  return Math.max(0, marketValue - ownLienValue(property) - pledgedByLoans(property.id, loans, excludeLoanId));
}

/**
 * Jak se dluh úvěru dělí mezi nemovitosti: vybraná "financovaná nemovitost" nese celý úvěr,
 * jinak se dělí podle výše zástav. Prázdný objekt = vazbu na nemovitost neznáme.
 */
function loanPropertyShares(loan, properties) {
  const exists = (id) => properties.some((p) => p.id === id);
  if (loan.property_id && exists(loan.property_id)) return { [loan.property_id]: 1 };
  const pledges = loanCollateral(loan).filter((c) => exists(c.property_id) && Number.isFinite(c.amount) && c.amount > 0);
  const total = pledges.reduce((s, c) => s + c.amount, 0);
  const shares = {};
  if (total > 0) for (const c of pledges) shares[c.property_id] = (shares[c.property_id] || 0) + c.amount / total;
  return shares;
}

/**
 * Splatí co nejvíc zbývajícího dluhu z dostupné hotovosti: nejdřív úvěry vázané na prodanou
 * nemovitost (\`preferred\` = podíl úvěru na ní), pak vždy ten s nejvyšší aktuální sazbou. Zbývající doba
 * zůstává a banka přepočítá (sníží) splátku. Mutuje loanState. Vrací hotovost, která
 * po splacení všeho dostupného dluhu ještě zbyla.
 */
function payDownDebtWithCash(loans, loanState, stateYear, cashAvailable, preferred = {}) {
  let cash = cashAvailable;
  const reduce = (l, maxAmount) => {
    const ls = loanState[l.id];
    const pay = Math.min(ls.remainingPrincipal, cash, maxAmount);
    if (!(pay > 0)) return;
    ls.remainingPrincipal -= pay;
    cash -= pay;
    if (ls.remainingPrincipal < 0.01) ls.remainingPrincipal = 0;
    if (ls.init && ls.pay > 0 && ls.remainingPrincipal > 0) {
      if (Number.isFinite(ls.term) && ls.term > 0) {
        // doba splácení se nemění, klesá splátka (zapamatuje se původní, ať je změna vidět v cashflow)
        if (ls.salePayFrom == null) ls.salePayFrom = ls.pay;
        ls.pay = annuityPayment(ls.remainingPrincipal, effectiveRate(ls), ls.term);
      } else {
        ls.term = remainingTermMonths(ls.remainingPrincipal, ls.pay, effectiveRate(ls));
      }
    }
  };
  for (const l of loans) {
    const share = preferred[l.id];
    if (share > 0 && loanState[l.id].remainingPrincipal > 0.01) reduce(l, loanState[l.id].remainingPrincipal * share);
  }
  const rateOf = (l) => {
    const ls = loanState[l.id];
    return ls.init ? effectiveRate(ls) : loanRateForYear(l, ls.startYear, stateYear);
  };
  const targets = loans.filter((l) => loanState[l.id].remainingPrincipal > 0.01).sort((a, b) => rateOf(b) - rateOf(a));
  for (const l of targets) {
    if (cash <= 0) break;
    reduce(l, Infinity);
  }
  return cash;
}

// Export pro použití v ostatních skriptech (bez modulů, aby to fungovalo i přes file://).
window.calc = {
  appreciatedValue,
  calendarDiff,
  addYears,
  timeTestRemaining,
  fixationRemaining,
  fixationRemainingUntil,
  fixationEndDate,
  fixationEndYear,
  isPO,
  taxExemptYears,
  timeTestInfo,
  eventAppliesInYear,
  eventLastYear,
  resolvePortfolioOverride,
  resolvePortfolioRate,
  loanRateDelta,
  loanRateOverride,
  rentGrowthBase,
  loanRateForYear,
  amortizeLoanForYear,
  loanTerms,
  loanSchedule,
  mergePlan,
  refinancingList,
  fixationChangeMonth,
  defaultStartMonth,
  annuityPayment,
  remainingTermMonths,
  toDate,
  addMonths,
  loanCollateral,
  ownLienValue,
  pledgedByLoans,
  freePledgeValue,
  loanPropertyShares,
  scoreSaleCandidate,
  compareSaleCandidates,
  describeSaleChoice,
  propertyQuality,
  propertyNetYield,
  qualityBand,
  QUALITY_WEIGHTS,
  QUALITY_SCORES,
  projectPortfolio,
  payDownDebtWithCash,
  rebaseToYear,
  projectLoanAmount,
  yearOf,
};
