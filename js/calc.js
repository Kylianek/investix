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

/**
 * FIXACE - zbývající čas do konce fixace úrokové sazby.
 * Excel: "m měs. a " & "md dní" (m = celkový počet celých měsíců, ne omezeno na 0-11).
 */
function fixationRemaining(startDate, fixationYears, today = new Date()) {
  const target = addYears(startDate, fixationYears);
  if (today >= target) {
    return { done: true, text: '0 měs. 0 dní', totalMonths: 0, days: 0 };
  }
  const { years, months, days } = calendarDiff(today, target);
  const totalMonths = years * 12 + months;
  return { done: false, text: `${totalMonths} měs. a ${days} dní`, totalMonths, days };
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

/**
 * Hodnota, kterou pro daný rok přepisuje scénářová událost daného typu (pokud
 * nějaká pro ten rok existuje). Události jsou vždy celoportfoliové - žádný cíl
 * se nevybírá. Pokud se překrývá víc událostí stejného typu, vyhrává poslední
 * v seznamu (uživatel ji může přidat "navrch" té starší).
 */
function resolvePortfolioOverride(events, type, year) {
  const matches = events.filter(
    (e) => e.type === type && year >= Number(e.year_from) && year <= Number(e.year_to || e.year_from)
  );
  if (!matches.length) return undefined;
  return Number(matches[matches.length - 1].value);
}

function resolvePortfolioRate(events, type, year, fallbackFraction) {
  const v = resolvePortfolioOverride(events, type, year);
  return v === undefined ? fallbackFraction : v / 100;
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
  const inflationBase = Number(settings.inflation_rate) || 0;

  const rebasedProperties = [];
  for (const p of properties) {
    if (yearOf(p.acquisition_date, currentYear) > targetYear) continue;
    let value = Number(p.market_value) || 0;
    let rent = Number(p.rent) || 0;
    const rentGrowthBase = p.rent_growth_rate != null ? Number(p.rent_growth_rate) : inflationBase;
    for (let y = currentYear; y > targetYear; y--) {
      value /= 1 + resolvePortfolioRate(events, 'growth', y, Number(p.growth_rate) || 0);
      rent /= 1 + resolvePortfolioRate(events, 'rent_growth', y, rentGrowthBase);
    }
    rebasedProperties.push({ ...p, market_value: value, rent });
  }

  const rebasedLoans = [];
  for (const l of loans) {
    const amount = projectLoanAmount(l, targetYear, currentYear);
    if (amount == null) continue;
    rebasedLoans.push({ ...l, amount });
  }

  return { properties: rebasedProperties, loans: rebasedLoans };
}

/**
 * Zbývající jistina úvěru v libovolném roce (minulém i budoucím) - pro
 * budoucnost amortizuje dopředu (stejně jako projectPortfolio), pro minulost
 * obrácením stejným způsobem jako rebaseToYear. Vrací null, pokud úvěr v tom
 * roce ještě nebyl sjednaný. Používá se v Doporučení na Přehledu, aby "nejhorší
 * úvěr" odpovídal zvolenému roku, ne vždycky jen dnešku.
 */
function projectLoanAmount(loan, targetYear, currentYear) {
  const loanStartYear = yearOf(loan.start_date, currentYear);
  if (loanStartYear > targetYear) return null;
  let principal = Number(loan.amount) || 0;
  if (targetYear > currentYear) {
    const ls = { remainingPrincipal: principal, startYear: loanStartYear };
    for (let y = currentYear; y < targetYear; y++) amortizeLoanForYear(loan, ls, y, currentYear);
    return ls.remainingPrincipal;
  }
  const payment = Number(loan.monthly_payment) || 0;
  for (let y = currentYear; y > targetYear; y--) {
    const monthlyRate = loanRateForYear(loan, loanStartYear, y) / 12;
    for (let m = 0; m < 12; m++) principal = (principal + payment) / (1 + monthlyRate);
  }
  return Math.max(0, principal);
}

/** Kumulovaná inflace mezi dvěma roky (fromYear < toYear), pro převod na "dnešní" kupní sílu. */
function inflationFactorBetween(events, inflationBase, fromYear, toYear) {
  let factor = 1;
  for (let y = fromYear + 1; y <= toYear; y++) {
    factor *= 1 + resolvePortfolioRate(events, 'inflation', y, inflationBase);
  }
  return factor;
}

/** Efektivní roční úroková sazba úvěru pro daný rok (desetinný zlomek). */
function loanRateForYear(loan, loanStartYear, year) {
  const fixEnd = loanStartYear + (Number(loan.fixation_years) || 0);
  const ratePct =
    year < fixEnd
      ? Number(loan.interest_rate) * 100
      : Number(loan.rate_after_fixation ?? Number(loan.interest_rate) * 100);
  return ratePct / 100;
}

/**
 * Umoří jeden úvěr o jeden rok (ze stateYear do stateYear+1). Mutuje `ls.remainingPrincipal`.
 * Vrací { interest, principal } zaplacené za ten rok. Sdílené mezi projectPortfolio
 * a simulateDebtFreedomPlan, aby obě počítaly úvěry naprosto stejně.
 *
 * Měsíční splátka se NEDOPOČÍTÁVÁ z doby splatnosti - zadává ji přímo uživatel
 * (loan.monthly_payment), protože tu skutečnou hodnotu zná z bankovního
 * výpisu přesněji, než by ji uhodl libovolný anuitní vzorec. Z ní se pak
 * každý měsíc odvodí úrok (zbývající jistina × měsíční sazba) a jistina
 * (splátka − úrok); pokud splátka nepokryje ani úrok, jistina se toho měsíce
 * nehýbe (žádné záporné umořování).
 */
function amortizeLoanForYear(loan, ls, stateYear, startYear) {
  let interest = 0;
  let principal = 0;
  if (ls.remainingPrincipal > 0 && stateYear >= ls.startYear) {
    const targetYear = stateYear + 1;
    const rate = loanRateForYear(loan, ls.startYear, targetYear);
    const monthlyRate = rate / 12;
    const monthlyPayment = Number(loan.monthly_payment) || 0;

    let principalLeft = ls.remainingPrincipal;
    for (let m = 0; m < 12; m++) {
      if (principalLeft <= 0) break;
      const interestM = principalLeft * monthlyRate;
      let principalM = monthlyPayment - interestM;
      if (principalM > principalLeft) principalM = principalLeft;
      if (principalM < 0) principalM = 0;
      principalLeft -= principalM;
      interest += interestM;
      principal += principalM;
    }
    ls.remainingPrincipal = Math.max(principalLeft, 0);
  }
  return { interest, principal };
}

/**
 * Hlavní simulace portfolia na `horizonYears` let dopředu.
 * properties/loans/settings: stejná data jako jinde v appce.
 * events: pole { type: 'growth'|'rent_growth'|'vacancy'|'inflation'|'one_time', year_from, year_to, value, note }
 *
 * Model odděluje STAV (majetek/dluh k danému roku) a TOK (co se stane BĚHEM
 * přechodu do dalšího roku - zhodnocení, nájem, splátky, daň). rows[k].* jsou
 * stavové veličiny NA ZAČÁTKU roku k (rows[0] = přesně dnešek, beze změny) a
 * tokové veličiny (cashflow, zhodnocení, daň...) za rok, který z něj vychází.
 * Poslední řádek má jen stav (nemá už žádný další rok, ze kterého by tok počítal).
 * Daň z příjmu z pronájmu se tak počítá stejně pro "dnešek" i pro všechny
 * budoucí roky - na rozdíl od daně z prodeje se časového testu netýká.
 *
 * Součástí simulace je i AUTOMATICKÝ PRODEJ nemovitosti na umoření dluhu -
 * stejná strategie jako dřív jen v záložce Osvobození od dluhu (viz podrobné
 * vysvětlení principu u simulateDebtFreedomPlan níže), teď rovnou zapletená
 * do hlavní projekce, aby: (1) šla vidět v tabulce Scénáře, a (2) použila
 * STEJNÝ (skládaně rostoucí, událostmi ovlivněný) odhad budoucí ceny
 * nemovitosti jako zbytek scénáře, místo jen ploché growth_rate nemovitosti.
 * Celý tenhle automatický prodej je VOLITELNÝ (viz karta "Automatický
 * prodej nemovitostí" v Nastavení):
 * - settings.auto_sell_enabled (výchozí true, pokud chybí) ho jako celek
 *   zapíná/vypíná.
 * - settings.min_portfolio_value (Kč, 0 = bez omezení) je ochranná hranice -
 *   prodej se nikdy neprovede, pokud by hodnota ZBÝVAJÍCÍCH nemovitostí
 *   klesla pod ni.
 * - settings.sale_trigger_amount (Kč, 0/prázdné = výchozí chování) pevně
 *   určuje, kolik nastřádaného zhodnocení stačí k prodeji - když není
 *   zadáno, použije se cena nejlevnější dostupné nemovitosti (viz níže).
 * Pevné pravidlo bez výjimky: nemovitost se NIKDY neprodá, dokud u ní
 * neuplyne časový test (viz timeTestRemaining) - i kdyby jinak byla
 * nejlépe bodovaným kandidátem. Než ho splní, do výběru se vůbec nepočítá.
 */
function projectPortfolio({ properties, loans, settings, events, horizonYears, startYear }) {
  startYear = startYear || new Date().getFullYear();
  events = events || [];
  horizonYears = Math.max(1, Number(horizonYears) || 1);
  const capGainsTaxRate = (Number(settings.capital_gains_tax_rate) || 0) / 100;
  const inflationBase = Number(settings.inflation_rate) || 0;
  // Automatický prodej nemovitostí na umoření dluhu (volitelný, viz Nastavení):
  // autoSellEnabled ho jako celek zapíná/vypíná, minPortfolioValue nikdy
  // neprodá nemovitost, pokud by hodnota ZBÝVAJÍCÍCH klesla pod tuhle hranici
  // (0 = žádná ochrana), a saleTriggerAmount určuje pevnou částku nastřádaného
  // zhodnocení, po které se prodává - když je 0/prázdná, použije se výchozí
  // logika (cena nejlevnější dostupné nemovitosti, viz níže).
  const autoSellEnabled = settings.auto_sell_enabled !== false;
  const minPortfolioValue = Number(settings.min_portfolio_value) || 0;
  const saleTriggerAmount = Number(settings.sale_trigger_amount) || 0;

  const loanState = {};
  for (const l of loans) {
    loanState[l.id] = { remainingPrincipal: Number(l.amount) || 0, startYear: yearOf(l.start_date, startYear) };
  }

  const curValue = {};
  const curRent = {};
  const curCost = {};
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
    // stejná podmínka jako uvnitř amortizeLoanForYear (stateYear >= ls.startYear),
    // jinak by se budoucí (ještě nesjednaný) úvěr počítal jako dluh už dnes.
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
        soldThisYear: null,
        perProperty: activeProps.map((p) => ({ id: p.id, name: p.name, value: curValue[p.id] })),
      });
      break;
    }

    // --- TOK: co se stane během přechodu ze stateYear do stateYear+1 ---
    const targetYear = stateYear + 1;
    const inflation = resolvePortfolioRate(events, 'inflation', targetYear, inflationBase);

    let appreciationGain = 0;
    let totalRentNOI = 0;
    let totalRent = 0;
    let totalCosts = 0;
    const perProperty = [];

    for (const p of activeProps) {
      const growth = resolvePortfolioRate(events, 'growth', targetYear, Number(p.growth_rate) || 0);
      const rentGrowthBase = p.rent_growth_rate != null ? Number(p.rent_growth_rate) : inflationBase;
      const rentGrowth = resolvePortfolioRate(events, 'rent_growth', targetYear, rentGrowthBase);
      const vacancy = resolvePortfolioRate(events, 'vacancy', targetYear, Number(p.vacancy_rate) || 0);

      const valueBefore = curValue[p.id];
      const rentThisYear = curRent[p.id];
      const costThisYear = curCost[p.id];

      curValue[p.id] = valueBefore * (1 + growth);
      curRent[p.id] = curRent[p.id] * (1 + rentGrowth);
      curCost[p.id] = curCost[p.id] * (1 + inflation);

      appreciationGain += curValue[p.id] - valueBefore;
      const rentAnnual = rentThisYear * 12 * (1 - vacancy);
      const propertyNOI = rentAnnual - costThisYear;
      totalRentNOI += propertyNOI;
      totalRent += rentAnnual;
      totalCosts += costThisYear;
      perProperty.push({ id: p.id, name: p.name, value: valueBefore, rent: rentAnnual, cashflow: propertyNOI });
    }

    // Úvěry se umořují agregovaně za portfolio (nezávisle na konkrétní nemovitosti),
    // sdílenou logikou s simulateDebtFreedomPlan (viz amortizeLoanForYear).
    let totalInterest = 0;
    let totalPrincipal = 0;
    for (const l of loans) {
      const { interest, principal } = amortizeLoanForYear(l, loanState[l.id], stateYear, startYear);
      totalInterest += interest;
      totalPrincipal += principal;
    }

    const oneTimeTotal = events
      .filter((e) => e.type === 'one_time' && targetYear >= Number(e.year_from) && targetYear <= Number(e.year_to || e.year_from))
      .reduce((s, e) => s + (Number(e.value) || 0), 0);
    cashReserve += oneTimeTotal;

    const cashflow = totalRentNOI - totalInterest - totalPrincipal + oneTimeTotal;
    cumulativeCashflow += cashflow;

    const inflationLoss = realEstateValue * inflation;

    // --- Automatický prodej nemovitosti na umoření dluhu ---
    // Nespouští ho výše dluhu, ale to, kolik už samotné zhodnocení portfolia
    // od posledního prodeje vydělalo (viz simulateDebtFreedomPlan). curValue
    // tady už v sobě má i letošní růst podle scénářových událostí výše, takže
    // se srovnává s AKTUÁLNÍ (už zhodnocenou) cenou nemovitostí k roku targetYear.
    // Nastřádané zhodnocení navíc samo podléhá inflaci (je to "papírový" zisk,
    // dokud se nerealizuje prodejem) - starší část součtu se každý rok
    // reálně znehodnotí, teprve pak se přičte letošní (ještě neznehodnocený) přírůstek.
    cumulativeGain = cumulativeGain / (1 + inflation) + appreciationGain;
    let soldThisYear = null;
    if (autoSellEnabled) {
      const totalDebtNow = activeLoans.reduce((s, l) => s + loanState[l.id].remainingPrincipal, 0);
      const realEstateValueNow = activeProps.reduce((s, p) => s + curValue[p.id], 0);
      // Kandidát na prodej smí být jen nemovitost, jejíž prodej NESRAZÍ hodnotu
      // zbývajících nemovitostí pod minPortfolioValue (viz nastavení), A ZÁROVEŇ
      // u ní musí být už splněný časový test - nemovitost se NIKDY neprodává
      // před jeho splněním (i za cenu zaplacení daně), to je pevné pravidlo.
      const unsold = activeProps.filter((p) => {
        if (curValue[p.id] <= 0) return false;
        if (realEstateValueNow - curValue[p.id] < minPortfolioValue) return false;
        if (!p.acquisition_date) return true;
        return timeTestRemaining(new Date(p.acquisition_date), Number(p.tax_exempt_years) || 10, new Date(targetYear, 0, 1)).done;
      });
      if (totalDebtNow > 0.01 && unsold.length) {
        const cheapestValue = Math.min(...unsold.map((p) => curValue[p.id]));
        // Práh, po jehož dosažení se prodává: buď pevná částka zadaná v
        // Nastavení (saleTriggerAmount), nebo (výchozí) cena nejlevnější
        // dostupné nemovitosti - "kolik reálně stojí náhrada".
        const threshold = saleTriggerAmount > 0 ? saleTriggerAmount : cheapestValue;
        if (cumulativeGain >= threshold) {
          const candidates = unsold
            .map((p) => scoreSaleCandidate(p, curValue[p.id], capGainsTaxRate, new Date(targetYear, 0, 1)))
            .sort((a, b) => b.score - a.score);
          const fullyCovers = candidates.find((c) => c.netProceeds >= totalDebtNow);
          const chosen = fullyCovers || candidates[0];

          cashReserve += chosen.netProceeds;
          soldProperties.add(chosen.property.id);
          cashReserve = payDownDebtWithCash(activeLoans, loanState, targetYear, cashReserve);
          const totalDebtAfterSale = activeLoans.reduce((s, l) => s + loanState[l.id].remainingPrincipal, 0);

          soldThisYear = {
            saleYear: targetYear,
            propertyId: chosen.property.id,
            propertyName: chosen.property.name,
            // Cena v roce prodeje (už zhodnocená skládaným růstem od acquisitionPrice)
            // a původní pořizovací cena, aby šlo v UI VIDĚT, že se neprodává za
            // dnešní/pořizovací cenu, ale za tehdejší zhodnocenou tržní hodnotu.
            marketValue: chosen.marketValue,
            acquisitionPrice: Number(chosen.property.acquisition_price) || 0,
            saleProceeds: chosen.netProceeds,
            estimatedSaleTax: chosen.estimatedSaleTax,
            taxExempt: chosen.taxExempt,
            triggeredByGain: cumulativeGain,
            loanFullyCleared: totalDebtAfterSale <= 0.01,
            cashAfter: cashReserve,
          };
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
      cumulativeGain,
      soldThisYear,
      perProperty,
    });
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  // Růst hodnoty NEMOVITOSTÍ - čistá vážená sazba zhodnocení, složená za
  // celý horizont ze skutečné avgGrowthRate jednotlivých let (rows[k], k < horizonYears).
  // NESMÍ se počítat jako prosté porovnání celkové hodnoty na začátku/konci
  // (last.totalValue / first.totalValue) - to by jako "růst" započítalo i
  // kapitál vložený koupí DALŠÍ nemovitosti během horizontu (portfolio
  // 1 mil. + koupě bytu za 1 mil. = "100% zhodnocení", i když se nezhodnotilo
  // vůbec nic), případně vliv hotovostní rezervy/splácení dluhu. avgGrowthRate
  // každého roku je naproti tomu čistý poměr appreciationGain ÷ realEstateValue
  // toho roku, takže nově koupenou nemovitost nezkreslí.
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
 * Kumulovaný inflační "deflátor" mezi rows[0] (dnešek) a rows[uptoIndex] -
 * součin (1 + míra inflace) za každý rok mezi nimi, podle skutečně použité
 * (scénářovými událostmi případně přepsané) inflace v jednotlivých letech
 * (rows[k].inflationRate). Vydělením nominální částky tímhle číslem dostaneš
 * "kolik by ta budoucí částka byla dnes za peníze" (reálnou hodnotu v
 * dnešních Kč) - používá se v záložce Přehled (reálné hodnoty).
 */
function cumulativeInflationFactor(rows, uptoIndex) {
  let factor = 1;
  for (let k = 0; k < uptoIndex; k++) {
    factor *= 1 + (Number(rows[k].inflationRate) || 0);
  }
  return factor;
}

/**
 * Ohodnotí, jak vhodná je nemovitost k prodeji (vysoké zhodnocení, ideálně po
 * časovém testu, slabý provozní výnos = horší kandidát na držení). Sdíleno
 * mezi recommendActions a simulateDebtFreedomPlan, ať používají STEJNÝ vzorec.
 *
 * estimatedSaleTax = odhad daně z příjmu z PRODEJE, KDYBY se nemovitost prodala
 * teď. Na rozdíl od daně z pronájmu (viz projectPortfolio) se tahle daň platí
 * jen jednou při prodeji a jen pokud ještě neuplynul časový test - po jeho
 * splnění je zisk z prodeje od daně osvobozen (§4 ZDP).
 */
function scoreSaleCandidate(property, marketValue, capGainsTaxRate, today) {
  const gain = marketValue - (Number(property.acquisition_price) || 0);
  const gainPct = marketValue > 0 ? gain / marketValue : 0;
  const tt = property.acquisition_date
    ? timeTestRemaining(new Date(property.acquisition_date), Number(property.tax_exempt_years) || 10, today)
    : { done: true, text: '0 let 0 měs. 0 dní' };
  const rentAnnual = (Number(property.rent) || 0) * 12 * (1 - (Number(property.vacancy_rate) || 0));
  const costsAnnual = (Number(property.monthly_costs) || 0) * 12;
  const yieldPct = marketValue > 0 ? (rentAnnual - costsAnnual) / marketValue : 0;
  const estimatedSaleTax = tt.done ? 0 : Math.max(gain, 0) * capGainsTaxRate;
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
  // "svoji" zástavu (has_lien), ale je vedená jako DODATEČNÁ zástava u
  // nějakého úvěru (additional_collateral_ids) - typicky přesně ten úvěr,
  // který díky ní financoval nákup jiné nemovitosti bez hotovosti.
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

function recommendActions(properties, loans, settings, today = new Date()) {
  const capGainsTaxRate = (Number(settings.capital_gains_tax_rate) || 0) / 100;

  let bestProperty = null;
  let bestScore = -Infinity;
  let hasProperties = false;
  for (const p of properties) {
    const marketValue = Number(p.market_value) || 0;
    if (marketValue <= 0) continue;
    hasProperties = true;
    const candidate = scoreSaleCandidate(p, marketValue, capGainsTaxRate, today);
    // Doporučit k prodeji dává smysl jen po splnění časového testu - jinak by
    // prodej navíc podléhal dani z příjmu a doporučení by bylo zavádějící.
    if (!candidate.taxExempt) continue;
    if (candidate.score > bestScore) {
      bestScore = candidate.score;
      bestProperty = candidate;
    }
  }

  let worstLoan = null;
  for (const l of loans) {
    const rate = Number(l.interest_rate) || 0;
    if (!worstLoan || rate > worstLoan.rate) worstLoan = { loan: l, rate };
  }

  if (!bestProperty && !worstLoan && !hasProperties) return null;
  return { bestProperty, worstLoan, hasProperties };
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

/**
 * Plán "osvobození" portfolia od dluhu - teď jen tenký pohled na hlavní
 * simulaci projectPortfolio (ta od teď sama umí automaticky prodávat
 * nemovitosti na umoření dluhu, viz komentář u ní). Díky tomu je tahle
 * záložka VŽDY přesně konzistentní se Scénáři - stejné prodeje, stejné roky,
 * stejné částky - a navíc teď respektuje i scénářové události (růst, inflace,
 * neobsazenost...), ne jen plochou growth_rate jednotlivé nemovitosti.
 *
 * Vrací { rows, events, debtFreeYear } - debtFreeYear je null, pokud se dluh
 * nepodaří do horizontu vynulovat.
 */
function simulateDebtFreedomPlan({ properties, loans, settings, events, horizonYears, startYear }) {
  startYear = startYear || new Date().getFullYear();
  horizonYears = Math.max(1, Number(horizonYears) || 1);

  const result = projectPortfolio({ properties, loans, settings, events: events || [], horizonYears, startYear });

  const rows = result.rows.map((r) => ({
    year: r.year,
    totalDebt: r.totalDebt,
    activeValue: r.realEstateValue,
    cash: r.cashReserve,
    cumulativeGain: r.cumulativeGain,
    soldThisYear: r.soldThisYear,
  }));

  const saleEvents = [];
  for (const r of result.rows) {
    if (r.soldThisYear) saleEvents.push({ year: r.soldThisYear.saleYear, ...r.soldThisYear });
  }

  let debtFreeYear = null;
  for (const r of result.rows) {
    if (r.totalDebt <= 0.01) {
      debtFreeYear = r.year;
      break;
    }
  }

  return { rows, events: saleEvents, debtFreeYear, horizonYears };
}

// Export pro použití v ostatních skriptech (bez modulů, aby to fungovalo i přes file://).
window.calc = {
  appreciatedValue,
  calendarDiff,
  addYears,
  timeTestRemaining,
  fixationRemaining,
  resolvePortfolioOverride,
  resolvePortfolioRate,
  loanRateForYear,
  amortizeLoanForYear,
  scoreSaleCandidate,
  projectPortfolio,
  cumulativeInflationFactor,
  recommendActions,
  pledgePurchaseCapacity,
  simulateDebtFreedomPlan,
  rebaseToYear,
  inflationFactorBetween,
  projectLoanAmount,
  yearOf,
};