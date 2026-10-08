# Investix

Webová verze osobní kalkulačky z `INVESTIČNÍ KALKULAČKA 1.xlsx` — přehled nemovitostí,
úvěrů (fixací), časového testu / zástav a zhodnocení portfolia.

Aplikace je čistá statická stránka (HTML/CSS/JS, žádný build krok). Přihlášený uživatel má data
v databázi, nepřihlášenému se data nikam neukládají a po zavření stránky zmizí - jediná cesta,
jak je zachovat, je záloha do souboru (Nastavení → Data).

## Jak vzorce odpovídají originálnímu Excelu

| Excel list | List/Buňka | Web |
|---|---|---|
| NEMOVITOSTI | řádek nemovitosti (nájem, splátka, tržní hodnota, pořizovací cena) | záložka **Nemovitosti** |
| NEMOVITOSTI!H = F*růst+F | hodnota po zhodnocení | sloupec "Po zhodnocení" |
| FIXACE | banka, částka, úrok, doba fixace, od | záložka **Úvěry / fixace** |
| FIXACE!G (DATEDIF měsíce+dny) | zbývá do konce fixace | sloupec "Zbývá fixace" |
| ČASOVÝ TEST A ZÁSTAVA | datum pořízení, časový test 5/10 let, zástava | součást formuláře nemovitosti (pole "Datum pořízení", "Časový test", rozbalovací "Zástava") |
| ČASOVÝ TEST!E (DATEDIF roky/měsíce/dny) | zbývá do konce časového testu | sloupec "Časový test - zbývá" |
| PŘEHLED!D5 majetek | `SUM(tržní hodnoty)` | KPI "Majetek" |
| PŘEHLED!D6 dluh | `SUM(úvěry)` | KPI "Dluh" |
| PŘEHLED!D7 vlastní majetek | majetek − dluh | KPI "Vlastní majetek" |
| PŘEHLED!D8 poměr zadlužení | dluh / majetek | KPI "Poměr zadlužení" |
| PŘEHLED!D9 cashflow | `SUM(nájem) − SUM(splátky)` | KPI "Cashflow" |
| PŘEHLED!D11 roční zhodnocení | `SUM(po zhodnocení) − majetek` | KPI "Roční zhodnocení" |
| PŘEHLED!D12 inflace | majetek × míra inflace | KPI "Ztráta inflací" |
| PŘEHLED!D13 zbývá po inflaci | zhodnocení − ztráta inflací | KPI "Zbývá po inflaci" |
| PŘEHLED!D15 majetek po zhodnocení | `SUM(po zhodnocení)` | KPI "Majetek po zhodnocení" |
| údaje!C7:C14 (růst % podle pozice v tabulce) | — | ve webu má **každá nemovitost svoje vlastní pole "Roční růst hodnoty %"**, aby to nezáviselo na pořadí řádků jako v Excelu |

Všechny vzorce jsou v [js/calc.js](js/calc.js) jako čisté funkce (ověřené na skutečných
číslech z originálního souboru — souhlasí do koruny).

## Záložka Přehled - libovolný rok i měsíc

Přehled i Scénáře čerpají z **jedné simulace** (`projectPortfolio` v [js/calc.js](js/calc.js)) se stejnými
scénářovými událostmi - co zapíšeš ve Scénářích, se hned promítne i do Přehledu. Přehled si vybere
jeden konkrétní rok (výchozí je aktuální rok = přesně dnešní stav); je-li dál než horizont Scénářů,
simulace se prodlouží, takže události (včetně těch bez konce) platí dál a po horizontu se nic nevrací
ke starému počítání. Zvolený minulý rok se zrekonstruuje z dnešních hodnot (obrácené zhodnocení a umoření).

Přepínač **Rok / Měsíc** mění jen tokové veličiny (cashflow, zhodnocení, ztrátu inflací) na měsíční
ekvivalent; stavové veličiny (majetek, dluh, vlastní kapitál, poměr zadlužení) se nemění.

## Záložka Scénáře (predikce na X let dopředu)

Simulace vývoje portfolia rok po roce:

- Hodnota nemovitosti a nájem rostou **skládaně**; úvěry se **reálně umořují** podle zadané skutečné
  měsíční splátky (po konci fixace se použije "sazba po fixaci"; konec fixace jde zadat datem).
- Každá nemovitost má **obsazenost**, **provozní náklady** a vlastní **růst nájmu** (výchozí je v Nastavení).
- **FO / PO**: nemovitost pořízená na právnickou osobu nemá časový test a daň z prodeje se platí vždy,
  proto se při zapnutém automatickém prodeji prodá co nejdřív (první rok simulace). FO nemovitost se
  automaticky neprodá, dokud neuplyne časový test.
- **Scénářové události** (rok = rok, ve kterém se dějí; prázdné "do roku" = trvale):
  růst hodnoty, růst nájmu, obsazenost, **růst úrokových sazeb** (o p. b.; banka přepočítá splátku na
  zbývající dobu), inflace a jednorázový příjem/výdaj. Událost jde zacílit na **jednu, více nebo všechny
  nemovitosti** (u sazeb na vybrané úvěry); konkrétní cíl má přednost před celoportfoliovou událostí.
- Co zadáš v kartě nemovitosti nebo úvěru (obsazenost, vlastní růst nájmu, prodej PO, sazba po fixaci),
  se ve Scénářích objeví jako událost s odkazem zpět na kartu.
- Kliknutím na **rok** v tabulce se rozbalí stejné veličiny po jednotlivých nemovitostech a úvěrech.
  Dluh a splátka nemovitosti se znají, jen když je u úvěru vyplněné "Financuje nemovitost".

V **Nastavení** je inflace, výchozí růst nájmu, daň z prodeje (FO / PO), automatický prodej,
financování zástavou a záloha dat. Daň je zjednodušení pro účely predikce, ne daňové poradenství;
daň z příjmu z pronájmu a odpisy appka nepočítá.

## Vzhled

Světlý, tmavý a barevný motiv (ikona v hlavičce nebo Nastavení). Volba motivu je jen vzhled, drží se
v prohlížeči (`localStorage`), nejsou to data účtu.

## Lokální vyzkoušení

Stačí otevřít `index.html` přímo v prohlížeči (dvojklikem), nebo spustit jednoduchý
lokální server, např. `npx serve .`

## Nasazení (GitHub Pages)

Repozitář je nasazený na GitHub Pages ze složky `/ (root)` větve `main`:
**https://kylianek.github.io/investix/**

## Přihlášení (Clerk)

Přihlášení běží přes [Clerk](https://clerk.com) (stejně jako v CRM), načítá se z
[js/auth.js](js/auth.js) bez build kroku. Dokud je v něm `CLERK_PUBLISHABLE_KEY` prázdný, přihlášení se
v appce vůbec nenabídne. Klíč se bere z Clerk dashboardu (Configure → API Keys, je veřejný, smí
být v repu). Nastavení je pod ozubeným kolem v hlavičce (po přihlášení v menu profilu).

## Ukládání dat

- **Přihlášený:** každá uložená změna se do ~0,2 s odešle do databáze (stav je vidět v hlavičce).
  V prohlížeči zůstává jen pracovní kopie v `sessionStorage` (přežije obnovení stránky, po zavření
  záložky zmizí). Po odhlášení se i ta smaže.
- **Nepřihlášený:** nic se neukládá. Pracovní kopie v `sessionStorage` zmizí po zavření záložky a
  appka na to upozorní (pruh nahoře i dotaz prohlížeče při odchodu). Po přihlášení se data ze stránky
  nahrají do účtu.
- Starší data z `localStorage` (dřívější verze) se jednou načtou a smažou se, až jsou v účtu.

### Databáze (Vercel + Postgres/Neon)

Web zůstává na GitHub Pages, o databázi se stará neviditelné API ze složky [api/](api/). Prohlížeč mu
data posílá spolu s Clerk tokenem, API token ověří veřejnými klíči Clerku (žádný tajný klíč) a uloží
data k danému uživateli.

1. Neon: databáze propojená s Vercel projektem (proměnná `DATABASE_URL` nebo `POSTGRES_URL`).
2. Vercel: projekt z tohoto repa, kořen se přesměrovává na GitHub Pages (viz [vercel.json](vercel.json)).
3. Adresa projektu je v `INVESTIX_API_URL` v [js/cloud.js](js/cloud.js).

Tabulka se v databázi vytvoří sama. Diagnostika (bez tajných údajů): `/api/health`.

## Soukromí dat

- Data přihlášeného jsou v jeho účtu v databázi a nikdo jiný je nevidí (API čte a zapisuje jen
  záznam uživatele z ověřeného tokenu). Nejsou ani ve zdrojovém kódu na GitHubu.
- Zálohuj si data přes tlačítko "Stáhnout zálohu (JSON)" v Nastavení - jde nahrát zpět přes
  "Nahrát zálohu", i bez přihlášení.
