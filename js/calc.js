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
    const d = new Date(loan.fixation_end);
    if (!isNaN(d)) return d;
  }
  if (loan.start_date && loan.fixation_years != null && loan.fixation_years !== '') {
    const start = new Date(loan.start_date);
    if (!isNaN(start)) return addYears(start, Number(loan.fixation_years) || 0);
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
  const tt = timeTestRemaining(new Date(property.acquisition_date), years, today);
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
  const d = new Date(dateStr);
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

/** Rok, od kterého úvěr přechází na sazbu po fixaci (zadané datum konce, jinak počátek + doba). */
function fixationEndYear(loan, loanStartYear) {
  if (loan.fixation_end) {
    const y = yearOf(loan.fixation_end, null);
    if (y != null) return y;
  }
  return loanStartYear + (Number(loan.fixation_years) || 0);
}

/** Efektivní roční úroková sazba úvěru pro daný rok (desetinný zlomek), bez scénářových událostí. */
function loanRateForYear(loan, loanStartYear, year) {
  const ratePct =
    year < fixationEndYear(loan, loanStartYear)
      ? Number(loan.interest_rate) * 100
      : Number(loan.rate_after_fixation ?? Number(loan.interest_rate) * 100);
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
 * Umoří jeden úvěr o jeden rok (rok `stateYear`). Mutuje `ls.remainingPrincipal`.
 * Vrací { interest, principal, rate, payment } za ten rok (payment = splátky za rok celkem).
 *
 * Měsíční splátka se NEDOPOČÍTÁVÁ z doby splatnosti - zadává ji přímo uživatel
 * (loan.monthly_payment), protože tu skutečnou hodnotu zná z bankovního
 * výpisu přesněji, než by ji uhodl libovolný anuitní vzorec. Z ní se pak
 * každý měsíc odvodí úrok (zbývající jistina × měsíční sazba) a jistina
 * (splátka − úrok); pokud splátka nepokryje ani úrok, jistina se toho měsíce
 * nehýbe (žádné záporné umořování).
 *
 * `rateDelta` = zvýšení sazby ze scénářové události (zlomek). Když se změní,
 * banka přepočítá splátku tak, aby se úvěr splatil ve stejném termínu - splátka
 * se proto přepočítá anuitním vzorcem na zbývající dobu (ls.termMonths).
 */
function amortizeLoanForYear(loan, ls, stateYear, startYear, rateDelta = 0) {
  let interest = 0;
  let principal = 0;
  let rate = 0;
  let paymentYear = 0;
  if (ls.remainingPrincipal > 0 && stateYear >= ls.startYear) {
    const baseRate = loanRateForYear(loan, ls.startYear, stateYear);
    if (ls.payment === undefined) ls.payment = Number(loan.monthly_payment) || 0;
    if (ls.termMonths === undefined) {
      ls.termMonths = remainingTermMonths(ls.remainingPrincipal, ls.payment, baseRate);
      ls.delta = 0;
    }
    rate = Math.max(0, baseRate + rateDelta);
    if (rateDelta !== ls.delta) {
      if (Number.isFinite(ls.termMonths) && ls.termMonths > 0) {
        ls.payment = annuityPayment(ls.remainingPrincipal, rate, ls.termMonths);
      }
      ls.delta = rateDelta;
    }
    const monthlyRate = rate / 12;

    let principalLeft = ls.remainingPrincipal;
    for (let m = 0; m < 12; m++) {
      if (principalLeft <= 0) break;
      const interestM = principalLeft * monthlyRate;
      let principalM = ls.payment - interestM;
      if (principalM > principalLeft) principalM = principalLeft;
      if (principalM < 0) principalM = 0;
      principalLeft -= principalM;
      interest += interestM;
      principal += principalM;
    }
    paymentYear = interest + principal;
    ls.remainingPrincipal = Math.max(principalLeft, 0);
    if (Number.isFinite(ls.termMonths)) ls.termMonths = Math.max(0, ls.termMonths - 12);
  }
  return { interest, principal, rate, payment: paymentYear };
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
  for (const l of loans) {
    loanState[l.id] = { remainingPrincipal: Number(l.amount) || 0, startYear: yearOf(l.start_date, startYear) };
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
          .map((l) => ({ id: l.id, bank: l.bank, property_id: l.property_id || null, balance: loanState[l.id].remainingPrincipal })),
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
      const { interest, principal, rate, payment } = amortizeLoanForYear(l, ls, stateYear, startYear, loanRateDelta(events, l.id, stateYear));
      totalInterest += interest;
      totalPrincipal += principal;
      // splacený úvěr už v přehledu úvěrů nefiguruje
      if (active && balance > 0.005) {
        perLoan.push({ id: l.id, bank: l.bank, property_id: l.property_id || null, balance, rate, interest, principal, payment });
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
      cashReserve = payDownDebtWithCash(activeLoans, loanState, stateYear, cashReserve);
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

/**
 * Kolik nejdražší nemovitost lze koupit BEZ vlastní hotovosti, když banku
 * kryješ kombinovanou zástavou - kupovaná nemovitost + volná (nezastavená)
 * hodnota už vlastněných nemovitostí. Půjčka = 100 % kupní ceny (P), banka
 * počítá LTV z CELKOVÉ zástavy (kupovaná + volná stávající):
 *   maxLtv = P / (P + volnáZástava)  =>  P = volnáZástava × maxLtv / (1 − maxLtv)
 */
function pledgePurchaseCapacity(properties, maxLtv, loans) {
  // Nemovitost je plně zastavená (0 volné hodnoty) i tehdy, když sama nemá
  // "svoji" zástavu (has_lien), ale je vedená jako zástava u nějakého úvěru
  // (additional_collateral_ids) - typicky přesně ten úvěr, který díky ní
  // financoval nákup jiné nemovitosti bez hotovosti.
  const crossCollateralized = new Set();
  for (const l of loans || []) {
    for (const propertyId of l.additional_collateral_ids || []) crossCollateralized.add(propertyId);
  }
  const freeCollateral = properties.reduce((sum, p) => {
    const marketValue = Number(p.market_value) || 0;
    if (crossCollateralized.has(p.id)) return sum;
    const lienValue = p.has_lien ? Number(p.lien_value) || 0 : 0;
    return sum + Math.max(0, marketValue - lienValue);
  }, 0);
  const maxPurchasePrice = maxLtv > 0 && maxLtv < 1 ? (freeCollateral * maxLtv) / (1 - maxLtv) : 0;
  return { freeCollateral, maxPurchasePrice };
}

/**
 * Splatí co nejvíc zbývajícího dluhu z dostupné hotovosti, vždy nejdřív ten
 * úvěr s nejvyšší aktuální sazbou (a případný zbytek hotovosti přeteče do
 * dalšího v pořadí). Mutuje loanState. Vrací hotovost, která po splacení
 * všeho dostupného dluhu ještě zbyla (0, pokud dluh >= hotovost).
 */
function payDownDebtWithCash(loans, loanState, stateYear, cashAvailable) {
  let cash = cashAvailable;
  const targets = loans
    .filter((l) => loanState[l.id].remainingPrincipal > 0.01)
    .sort((a, b) => loanRateForYear(b, loanState[b.id].startYear, stateYear) - loanRateForYear(a, loanState[a.id].startYear, stateYear));
  for (const l of targets) {
    if (cash <= 0) break;
    const ls = loanState[l.id];
    const pay = Math.min(ls.remainingPrincipal, cash);
    ls.remainingPrincipal -= pay;
    cash -= pay;
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
  annuityPayment,
  remainingTermMonths,
  scoreSaleCandidate,
  projectPortfolio,
  pledgePurchaseCapacity,
  payDownDebtWithCash,
  rebaseToYear,
  projectLoanAmount,
  yearOf,
};
