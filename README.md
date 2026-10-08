# Investix

Webová verze osobní kalkulačky z `INVESTIČNÍ KALKULAČKA 1.xlsx` — přehled nemovitostí,
úvěrů (fixací), časového testu / zástav a zhodnocení portfolia.

Aplikace je čistá statická stránka (HTML/CSS/JS, žádný build krok). Přihlášený uživatel má data
v databázi, nepřihlášenému se data nikam neukládají a po zavření stránky zmizí - jediná cesta,
jak je zachovat, je záloha do souboru (Nastavení → Záloha dat).

## Jak vzorce odpovídají originálnímu Excelu

| Excel list | List/Buňka | Web |
|---|---|---|
| NEMOVITOSTI | řádek nemovitosti (nájem, splátka, tržní hodnota, pořizovací cena) | záložka **Nemovitosti** |
| NEMOVITOSTI!H = F*růst+F | hodnota po zhodnocení | sloupec "Po zhodnocení" |
| FIXACE | banka, částka, úrok, doba fixace, od | záložka **Úvěry / fixace** |
| FIXACE!G (DATEDIF měsíce+dny) | zbývá do konce fixace | sloupec "Zbývá fixace" |
| ČASOVÝ TEST A ZÁSTAVA | datum pořízení, časový test 5/10 let, zástava | součást formuláře nemovitosti (pole "Datum pořízení", "Časový test", "Zástava") |
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

Přehled si vybírá jeden konkrétní rok ze stejné víceleté simulace jako záložka Scénáře
(výchozí je aktuální rok = přesně dnešní stav). Přepínač **Rok / Měsíc** mění jen
tokové (za období) veličiny — cashflow, zhodnocení, ztrátu inflací — na jejich
měsíční ekvivalent; stavové veličiny (majetek, dluh, vlastní kapitál, poměr
zadlužení) se s přepínačem nemění, protože jsou k danému okamžiku, ne za období.

Na Přehledu je i karta **Doporučení** — transparentně obodovaná (ne černá skříňka)
tipuje, kterou nemovitost má smysl zvážit k prodeji (vysoké zhodnocení, ideálně po
časovém testu, slabý provozní výnos) a který úvěr splatit přednostně (nejvyšší úrok).

## Záložka Scénáře (predikce na X let dopředu)

Nad rámec originálního Excelu přidává aplikace záložku **Scénáře**, která simuluje vývoj
portfolia rok po roce, ne jen jeden rok dopředu:

- Hodnota nemovitosti a nájem rostou **skládaně** (rok po roce), ne jen jednorázově.
- Úvěry se **reálně umořují** za celé portfolio (agregovaně) — anuitní splátka se
  každý rok rozpadá na úrok a jistinu podle zbývající jistiny, sazby a doby splatnosti
  (nastavuje se v pokročilé sekci formuláře úvěru). Po konci fixace se použije zadaná
  "sazba po fixaci".
- Každá nemovitost může mít **neobsazenost (%)**, **provozní náklady (Kč/měs)** a
  vlastní **růst nájmu** — to všechno snižuje reálný cashflow, ne jen nominální nájem.
- Nemovitost může mít nastavený **plánovaný rok prodeje**. Simulace k tomu roku spočítá
  čistý výnos z prodeje (cena − daň z prodeje, pokud ještě neuplynul časový test) a
  částkou zadanou v poli **"Cizí kapitál (úvěr) vložený"** přednostně splatí úvěr s
  nejvyšší aktuální sazbou (a až pak další) — stejná logika jako doporučuje karta
  Doporučení. Zbytek jde do hotovostní rezervy portfolia.
- **Scénářové události** dočasně přepíšou libovolnou sazbu pro celé portfolio na určité
  období (žádné cílení na konkrétní nemovitost/úvěr - jednoduše celé portfolio), např.:
  - *"rok 2029: neobsazenost 50 %"* (výpadek nájemníka na půl roku)
  - *"roky 2027-2029: nižší růst hodnoty nemovitostí (recese)"*
  - *"rok 2030: jednorázový výdaj -500 000 Kč"* (rekonstrukce)

  Budoucí změnu úrokové sazby konkrétního úvěru (např. po konci fixace) nastavíš přímo
  v jeho poli "Sazba po konci fixace", ne přes událost.
- Výstup: graf a tabulka vývoje majetku/dluhu/vlastního kapitálu po letech, plus
  souhrnné KPI (vlastní kapitál za zvolený počet let, kumulovaný cashflow, CAGR).

V **Nastavení** lze nastavit i orientační daň z prodeje nemovitosti (uplatní se jen při
prodeji před koncem časového testu) — jde o zjednodušení pro účely predikce, ne o daňové
poradenství. Daň z příjmu z pronájmu a daňové odpisy appka nepočítá.

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
