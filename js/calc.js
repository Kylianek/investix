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
  if (!property.acquisition_date || years <= 0) return { done: true, never: false, none: true, text: '—' };
  const tt = timeTestRemaining(toDate(property.acquisition_date), years, today);
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

/** O kolik procentních bodů události zvyšují (nebo snižují) sazbu daného úvěru v roce `year` (zlomek). */
function loanRateDelta(events, loanId, year) {
  return matchingEvents(events, 'interest', year, loanId).reduce((s, e) => s + (Number(e.value) || 0), 0) / 100;
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
function rebaseToYear(properties, loans, settings, events, targetYear, currentYear) {
  const rebasedProperties = [];
  for (const p of properties) {
    if (yearOf(p.acquisition_date, currentYear) > targetYear) continue;
    let value = Number(p.market_value) || 0;
    let rent = Number(p.rent) || 0;
    const rentBase = rentGrowthBase(p, settings);
    for (let y = currentYear; y > targetYear; y--) {
      // hodnota na začátku roku y vznikla zhodnocením během roku y-1, nájem roku y je navýšený v roce y
      value /= 1 + resolvePortfolioRate(events, 'growth', y - 1, Number(p.growth_rate) || 0, p.id);
      rent /= 1 + resolvePortfolioRate(events, 'rent_growth', y, rentBase, p.id);
    }
    rebasedProperties.push({ ...p, market_value: value, rent });
  }

  const rebasedLoans = [];
  for (const l of loans) {
    const amount = projectLoanAmount(l, targetYear, currentYear, events);
    if (amount == null) continue;
    rebasedLoans.push({ ...l, amount });
  }

  return { properties: rebasedProperties, loans: rebasedLoans };
}

/**
 * Zbývající jistina úvěru na začátku libovolného roku (minulého i budoucího) - pro
 * budoucnost amortizuje dopředu (stejně jako projectPortfolio), pro minulost
 * obrácením stejným způsobem jako rebaseToYear. Vrací null, pokud úvěr v tom
 * roce ještě nebyl sjednaný.
 */
function projectLoanAmount(loan, targetYear, currentYear, events) {
  events = events || [];
  const loanStartYear = yearOf(loan.start_date, currentYear);
  if (loanStartYear > targetYear) return null;
  let principal = Number(loan.amount) || 0;
  if (targetYear > currentYear) {
    const ls = { remainingPrincipal: principal, startYear: loanStartYear };
    for (let y = currentYear; y < targetYear; y++) {
      amortizeLoanForYear(loan, ls, y, currentYear, loanRateDelta(events, loan.id, y));
    }
    return ls.remainingPrincipal;
  }
  const payment = Number(loan.monthly_payment) || 0;
  for (let y = currentYear; y > targetYear; y--) {
    const monthlyRate = Math.max(0, loanRateForYear(loan, loanStartYear, y - 1) + loanRateDelta(events, loan.id, y - 1)) / 12;
    for (let m = 0; m < 12; m++) principal = (principal + payment) / (1 + monthlyRate);
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
 * - Konec fixace (od měsíce konce fixace): nová sazba (rate_after_fixation); banka
 *   přepočítá splátku na zbývající dobu (nebo platí zadaná payment_after_fixation).
 * - Refinancování (refinance_date): "kolo od začátku" - ze zbývající jistiny se podle nové
 *   sazby a nové doby (refinance_years) spočítá nová anuita, takže se zase platí hlavně úrok.
 * - Scénářová událost "růst úrokových sazeb": přičte procentní body, banka přepočítá splátku
 *   tak, aby se úvěr splatil ve stejném termínu.
 * - Předčasné splacení (prodej nemovitosti): splátka zůstává, úvěr se splatí dřív.
 * ========================================================================= */

const monthIndex = (date) => date.getFullYear() * 12 + date.getMonth();

/** Měsíc (absolutně), od kterého platí nové podmínky po datu; od 16. dne až následující měsíc. */
function monthAfter(date) {
  return monthIndex(date) + (date.getDate() > 15 ? 1 : 0);
}

/**
 * Měsíc, od kterého platí podmínky po fixaci. null = konec fixace není znám (pak se nic nemění).
 * Bez data počátku se fixace počítá od ledna roku sjednání/dneška.
 */
function fixationChangeMonth(loan, loanStartYear) {
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
  return loanStartYear * 12 + months;
}

/** Rok, od kterého úvěr přechází na sazbu po fixaci (Infinity = neznámo). */
function fixationEndYear(loan, loanStartYear) {
  const month = fixationChangeMonth(loan, loanStartYear);
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

/** Počáteční stav úvěru v prvním simulovaném roce (splátka, zbývající doba, plánované změny). */
function initLoanState(loan, ls, firstYear) {
  const firstAbs = firstYear * 12;
  const balance = ls.remainingPrincipal;
  const hasNumber = (v) => v != null && v !== '' && !isNaN(Number(v));
  ls.afterRate = hasNumber(loan.rate_after_fixation) ? Number(loan.rate_after_fixation) / 100 : null;
  ls.afterPay = Number(loan.payment_after_fixation) > 0 ? Number(loan.payment_after_fixation) : null;
  ls.fixAbs = fixationChangeMonth(loan, ls.startYear);
  const refDate = loan.refinance_date ? toDate(loan.refinance_date) : null;
  ls.refAbs = refDate && !isNaN(refDate) ? monthAfter(refDate) : null;
  ls.refRate = hasNumber(loan.refinance_rate) ? Number(loan.refinance_rate) / 100 : null;
  ls.refTerm = Number(loan.refinance_years) > 0 ? Number(loan.refinance_years) * 12 : null;

  let rate = Number(loan.interest_rate) || 0;
  let pay = Number(loan.monthly_payment) || 0;
  // fixace už skončila (nebo končí hned): zadaná splátka je už ta aktuální, jen se použije nová sazba
  const fixationOver = ls.fixAbs != null && ls.fixAbs <= firstAbs;
  if (fixationOver) {
    if (ls.afterRate != null) rate = ls.afterRate;
    if (ls.afterPay != null) pay = ls.afterPay;
    ls.fixAbs = null;
  }
  if (ls.refAbs != null && ls.refAbs < firstAbs) ls.refAbs = null;

  let term = null;
  if (loan.maturity_date) {
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
  ls.firstAbs = firstAbs;
  ls.init = true;
}

/**
 * Umoří jeden úvěr o jeden rok (rok `stateYear`). Mutuje stav úvěru `ls`
 * (remainingPrincipal, splátka, zbývající doba...). Vrací za ten rok
 * { interest, principal, rate, payment, monthlyPayment } (payment = zaplaceno za rok celkem).
 * `rateDelta` = zvýšení sazby ze scénářových událostí (zlomek).
 */
function amortizeLoanForYear(loan, ls, stateYear, startYear, rateDelta = 0) {
  if (!(ls.remainingPrincipal > 0 && stateYear >= ls.startYear)) {
    return { interest: 0, principal: 0, rate: 0, payment: 0, monthlyPayment: 0 };
  }
  if (!ls.init) initLoanState(loan, ls, stateYear);

  let interest = 0;
  let principal = 0;
  for (let m = 0; m < 12; m++) {
    if (ls.remainingPrincipal <= 0) break;
    const abs = stateYear * 12 + m;
    let recompute = false;
    let forceAnnuity = false;
    let payFixed = false;
    if (ls.refAbs === abs) {
      // refinancování: nová anuita ze zbývající jistiny (nová sazba, nová doba)
      if (ls.refRate != null) ls.rate = ls.refRate;
      if (ls.refTerm != null) {
        ls.term = ls.refTerm;
        forceAnnuity = true;
      }
      ls.refAbs = null;
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
        ls.term = remainingTermMonths(ls.remainingPrincipal, ls.pay, Math.max(0, ls.rate + ls.delta));
        payFixed = true;
      }
    }
    if (m === 0 && rateDelta !== ls.delta) {
      ls.delta = rateDelta;
      recompute = true;
    }
    const rate = Math.max(0, ls.rate + ls.delta);
    if (recompute && !payFixed && Number.isFinite(ls.term) && ls.term > 0 && (ls.pay > 0 || forceAnnuity)) {
      ls.pay = annuityPayment(ls.remainingPrincipal, rate, Math.max(ls.term, 1));
    }

    const interestM = ls.remainingPrincipal * (rate / 12);
    let principalM = ls.pay - interestM;
    if (principalM > ls.remainingPrincipal) principalM = ls.remainingPrincipal;
    if (principalM < 0) principalM = 0;
    ls.remainingPrincipal -= principalM;
    interest += interestM;
    principal += principalM;
    if (Number.isFinite(ls.term)) ls.term = Math.max(0, ls.term - 1);
  }
  ls.remainingPrincipal = Math.max(ls.remainingPrincipal, 0);
  return {
    interest,
    principal,
    rate: Math.max(0, ls.rate + ls.delta),
    payment: interest + principal,
    monthlyPayment: ls.pay,
  };
}

/**
 * Splátka, zbývající doba a rok doplacení úvěru podle zadaných údajů (bez scénářových událostí).
 * auto = splátka není zadaná a dopočítala se ze splatnosti.
 */
function loanTerms(loan, firstYear) {
  firstYear = firstYear || new Date().getFullYear();
  const amount = Number(loan.amount) || 0;
  const ls = { remainingPrincipal: amount, startYear: Math.max(yearOf(loan.start_date, firstYear), firstYear) };
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
 * Splátkový kalendář úvěru po letech (jako list "Roky" v bankovní kalkulačce): úrok, jistina,
 * podíl úroku ve splátkách a zůstatek. Zahrnuje fixaci, refinancování i scénářové události.
 */
function loanSchedule(loan, { events = [], startYear, maxYears = 40 } = {}) {
  startYear = startYear || new Date().getFullYear();
  const ls = { remainingPrincipal: Number(loan.amount) || 0, startYear: yearOf(loan.start_date, startYear) };
  const rows = [];
  let year = Math.max(startYear, ls.startYear);
  for (let i = 0; i < maxYears && ls.remainingPrincipal > 0.5; i++, year++) {
    const balanceStart = ls.remainingPrincipal;
    const r = amortizeLoanForYear(loan, ls, year, startYear, loanRateDelta(events, loan.id, year));
    rows.push({
      year,
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
  return {
    rows,
    totalInterest: rows.reduce((s, r) => s + r.interest, 0),
    totalPrincipal: rows.reduce((s, r) => s + r.principal, 0),
    paidOff: ls.remainingPrincipal <= 0.5,
  };
}

/**
 * Hlavní simulace portfolia na `horizonYears` let dopředu.
 * properties/loans/settings: stejná data jako jinde v appce.
 * events: pole { type: 'growth'|'rent_growth'|'vacancy'|'inflation'|'interest'|'one_time',
 *                year_from, year_to, value, target_ids, note }
 *
 * Model odděluje STAV (majetek/dluh na začátku roku) a TOK (co se stane BĚHEM
 * roku). rows[k] = stav na začátku roku startYear+k a tokové veličiny
 * (cashflow, zhodnocení, daň...) ZA TENTO ROK. Scénářová událost s rokem Y
 * proto ovlivňuje tok v řádku Y a stav až od řádku Y+1. rows[0] je přesně dnešek.
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
 * NIKDY neprodá, dokud u ní neuplyne časový test.
 */
function projectPortfolio({ properties, loans, settings, events, horizonYears, startYear }) {
  startYear = startYear || new Date().getFullYear();
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
  for (const l of loans) {
    loanState[l.id] = { remainingPrincipal: Number(l.amount) || 0, startYear: yearOf(l.start_date, startYear) };
    loanShares[l.id] = loanPropertyShares(l, properties);
  }

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
      curValue[p.id] = valueBefore * (1 + growth);
      const gain = curValue[p.id] - valueBefore;
      appreciationGain += gain;

      const rentAnnual = curRent[p.id] * 12 * (1 - vacancy);
      const costAnnual = curCost[p.id];
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
    const perLoan = [];
    for (const l of loans) {
      const ls = loanState[l.id];
      const balance = ls.remainingPrincipal;
      const active = stateYear >= ls.startYear;
      const { interest, principal, rate, payment, monthlyPayment } = amortizeLoanForYear(l, ls, stateYear, startYear, loanRateDelta(events, l.id, stateYear));
      totalInterest += interest;
      totalPrincipal += principal;
      // splacený úvěr už v přehledu úvěrů nefiguruje
      if (active && balance > 0.005) {
        perLoan.push({
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
        });
      }
    }

    const oneTimeTotal = events
      .filter((e) => e.type === 'one_time' && eventAppliesInYear(e, stateYear))
      .reduce((s, e) => s + (Number(e.value) || 0), 0);
    cashReserve += oneTimeTotal;

    const cashflow = totalRentNOI - totalInterest - totalPrincipal + oneTimeTotal;
    cumulativeCashflow += cashflow;

    const inflationLoss = realEstateValue * inflation;

    // --- Automatický prodej nemovitostí na umoření dluhu (na konci roku) ---
    // Nastřádané zhodnocení navíc samo podléhá inflaci (je to "papírový" zisk,
    // dokud se nerealizuje prodejem) - starší část součtu se každý rok
    // reálně znehodnotí, teprve pak se přičte letošní (ještě neznehodnocený) přírůstek.
    cumulativeGain = cumulativeGain / (1 + inflation) + appreciationGain;
    const sales = [];
    const saleDate = new Date(stateYear + 1, 0, 1);

    const sell = (candidate, reason) => {
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
        loanFullyCleared: totalDebtAfterSale <= 0.01,
        cashAfter: cashReserve,
      });
    };

    if (autoSellEnabled) {
      // 1) PO: prodat co nejdřív
      if (poSellAsap) {
        for (const p of activeProps) {
          if (!isPO(p) || soldProperties.has(p.id) || curValue[p.id] <= 0) continue;
          const remainingValue = activeProps.filter((x) => !soldProperties.has(x.id)).reduce((s, x) => s + curValue[x.id], 0);
          if (remainingValue - curValue[p.id] < minPortfolioValue) continue;
          sell(scoreSaleCandidate(p, curValue[p.id], capGainsTaxRate, saleDate, poTaxRate), 'po');
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
          const candidates = unsold
            .map((p) => scoreSaleCandidate(p, curValue[p.id], capGainsTaxRate, saleDate, poTaxRate))
            .sort((a, b) => b.score - a.score);
          const fullyCovers = candidates.find((c) => c.netProceeds >= totalDebtNow);
          sell(fullyCovers || candidates[0], 'gain');
          cumulativeGain = 0;
        }
      }
    }

    rows.push({
      year: stateYear,
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
  for (let k = 0; k < horizonYears; k++) {
    assetGrowthFactor *= 1 + (Number(rows[k].avgGrowthRate) || 0);
  }
  const cagrAssets = Math.pow(assetGrowthFactor, 1 / horizonYears) - 1;

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

/**
 * Ohodnotí, jak vhodná je nemovitost k prodeji (vysoké zhodnocení, ideálně po
 * časovém testu, slabý provozní výnos = horší kandidát na držení).
 *
 * estimatedSaleTax = odhad daně z příjmu z PRODEJE, KDYBY se nemovitost prodala
 * teď. Platí se jen jednou při prodeji a jen pokud ještě neuplynul časový test -
 * po jeho splnění je zisk z prodeje od daně osvobozen (§4 ZDP). U PO se daň
 * platí vždy (sazbou poTaxRate).
 */
function scoreSaleCandidate(property, marketValue, capGainsTaxRate, today, poTaxRate) {
  const gain = marketValue - (Number(property.acquisition_price) || 0);
  const gainPct = marketValue > 0 ? gain / marketValue : 0;
  const tt = timeTestInfo(property, today);
  const taxRate = isPO(property) && poTaxRate != null ? poTaxRate : capGainsTaxRate;
  const rentAnnual = (Number(property.rent) || 0) * 12 * (1 - (Number(property.vacancy_rate) || 0));
  const costsAnnual = (Number(property.monthly_costs) || 0) * 12;
  const yieldPct = marketValue > 0 ? (rentAnnual - costsAnnual) / marketValue : 0;
  const estimatedSaleTax = tt.done ? 0 : Math.max(gain, 0) * taxRate;
  const netProceeds = marketValue - estimatedSaleTax;
  const score = gainPct * 2 + (tt.done ? 0.5 : -0.3) - yieldPct * 1.5;
  return { property, marketValue, gain, gainPct, taxExempt: tt.done, timeTestText: tt.text, yieldPct, estimatedSaleTax, netProceeds, score };
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
 * Kolik nejdražší nemovitost lze koupit BEZ vlastní hotovosti, když banku
 * kryješ kombinovanou zástavou - kupovaná nemovitost + volná (nezastavená)
 * hodnota už vlastněných nemovitostí. Půjčka = 100 % kupní ceny (P), banka
 * počítá LTV z CELKOVÉ zástavy (kupovaná + volná stávající):
 *   maxLtv = P / (P + volnáZástava)  =>  P = volnáZástava × maxLtv / (1 − maxLtv)
 */
function pledgePurchaseCapacity(properties, maxLtv, loans) {
  const freeCollateral = properties.reduce((sum, p) => sum + freePledgeValue(p, loans), 0);
  const maxPurchasePrice = maxLtv > 0 && maxLtv < 1 ? (freeCollateral * maxLtv) / (1 - maxLtv) : 0;
  return { freeCollateral, maxPurchasePrice };
}

/**
 * Splatí co nejvíc zbývajícího dluhu z dostupné hotovosti: nejdřív úvěry vázané na prodanou
 * nemovitost (\`preferred\` = podíl úvěru na ní), pak vždy ten s nejvyšší aktuální sazbou. Úvěr
 * zůstává se stejnou splátkou, jen se splatí dřív. Mutuje loanState. Vrací hotovost, která
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
    if (ls.init && ls.pay > 0) ls.term = remainingTermMonths(ls.remainingPrincipal, ls.pay, Math.max(0, ls.rate + ls.delta));
  };
  for (const l of loans) {
    const share = preferred[l.id];
    if (share > 0 && loanState[l.id].remainingPrincipal > 0.01) reduce(l, loanState[l.id].remainingPrincipal * share);
  }
  const rateOf = (l) => {
    const ls = loanState[l.id];
    return ls.init ? ls.rate + ls.delta : loanRateForYear(l, ls.startYear, stateYear);
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
  rentGrowthBase,
  loanRateForYear,
  amortizeLoanForYear,
  loanTerms,
  loanSchedule,
  fixationChangeMonth,
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
  projectPortfolio,
  pledgePurchaseCapacity,
  payDownDebtWithCash,
  rebaseToYear,
  projectLoanAmount,
  yearOf,
};
