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
| ČASOVÝ TEST A ZÁSTAVA | datum pořízení, časový test 5/10 let, zástava | součást formuláře nemovitosti (pole "Datum pořízení", "Časový test"); zástava se zadává u úvěru |
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

- Hodnota nemovitosti a nájem rostou **skládaně**; úvěry se splácejí **po měsících jako anuita** (viz
  Úvěry a splácení níže).
- Každá nemovitost má **obsazenost**, **provozní náklady** a vlastní **růst nájmu** (výchozí je v Nastavení).
- **FO / PO**: nemovitost pořízená na právnickou osobu nemá časový test a daň z prodeje se platí vždy,
  proto se při zapnutém automatickém prodeji prodá co nejdřív (první rok simulace). FO nemovitost se
  automaticky neprodá, dokud neuplyne časový test.
- **Hodnocení kvality nemovitosti** (0 až 100, červená / oranžová / zelená): v kartě nemovitosti je rozbalovací blok **Stav a kvalita**
  (stav: novostavba, výborný, dobrý, průměrný, špatný; rekonstrukce: po / bez nutnosti / před; atraktivita lokality; energetický štítek A až G).
  Hodnocení je vážený průměr: **výnos z nájmu** (kolik Kč čistého nájmu ročně vydělá na 1 mil. hodnoty) 30 %, **zhodnocení** 20 %,
  stav 15 %, lokalita 15 %, rekonstrukce 10 %, energetický štítek 10 %. Neuvedený údaj se bere jako průměr (50 bodů). Do 39 bodů je červená,
  40 až 64 oranžová, od 65 zelená. V tabulce nemovitostí je u názvu barevná tečka a ve sloupci Kvalita štítek s číslem.
- **Pořadí prodeje FO nemovitostí** (z těch, které už prošly časovým testem): prodává se vždy nemovitost s **nejnižším hodnocením kvality**, při
  shodě ta s nižším výnosem z nájmu. V bublině u prodeje ve Scénářích je napsáno, **proč se vybrala právě tahle nemovitost** (včetně jejích
  nejslabších stránek), a tabulka s hodnocením, nájmem na 1 mil. a růstem všech ostatních (i těch, které ještě nemají za sebou časový test).
- **Neprodávat**: nemovitost, kterou při umořování dluhu určitě prodat nechceš, se neprodá nikdy, ani kdyby se to hodilo (platí i pro PO
  a pro "prodat co nejdřív"). Vybírá se jen v Nastavení u Automatického prodeje ("Nikdy neprodávat", výběr nemovitostí). V tabulce
  nemovitostí je u názvu zámek, v bublině u prodeje je zamčená nemovitost mezi těmi, které se neprodávají.
- **Scénářové události** (rok = rok, ve kterém se dějí; prázdné "do roku" = trvale):
  růst hodnoty, růst nájmu, obsazenost, **změna úrokové sazby** (zadáš novou sazbu, např. z 5 na 7 %, nebo níž;
  banka přepočítá splátku na zbývající dobu), inflace a jednorázový příjem/výdaj. Událost jde zacílit na **jednu, více nebo všechny
  nemovitosti** (u sazeb na vybrané úvěry); konkrétní cíl má přednost před celoportfoliovou událostí.
- Co zadáš v kartě nemovitosti nebo úvěru (obsazenost, vlastní růst nájmu, prodej PO, refinancování),
  se ve Scénářích objeví jako událost s odkazem zpět na kartu.

V **Nastavení** je inflace, výchozí růst nájmu, sazba hypotéky, daň z prodeje (FO / PO), automatický prodej
a záloha dat. Daň je zjednodušení pro účely predikce, ne daňové poradenství;
daň z příjmu z pronájmu a odpisy appka nepočítá.

## Úvěry a splácení

Stejná metodika jako bankovní kalkulačka (ověřeno na tabulce od bankéře: 5 mil. Kč, 4,39 %, 30 let = úrok
217 858 Kč a jistina 82 244 Kč v 1. roce, shoda do koruny za všech 30 let):

- Každý měsíc je **úrok = zbývající jistina × sazba / 12**, zbytek splátky je **jistina**. Splátka je po celou
  dobu stejná, proto je v prvních letech většina splátky úrok a podíl jistiny postupně roste. Dluh je vždy jen
  zbývající jistina.
- Splátku zadáváš z banky a **zadaná splátka má přednost**. Když ji nezadáš, ale znáš **splatnost**, dopočítá se
  anuitním vzorcem. Prázdná splátka bez splatnosti = úvěr "jen úrok".
- **Sazba hypotéky** (Nastavení, výchozích 5 %) je jedna globální sazba pro všechna místa, kde u úvěru žádná zadaná není:
  úvěr bez "Úrok fixace" a refinancování bez nové sazby ji použijí. Platí i **po konci fixace** - sazba po fixaci se u úvěru
  nezadává, vždy se vezme z Nastavení. V seznamu úvěrů a refinancování je taková sazba ztlumená. Starší úvěry s ručně zadanou
  sazbou nebo splátkou po fixaci o ně při načtení přijdou (platí sazba z Nastavení).
- **Konec fixace**: od měsíce konce fixace platí sazba hypotéky z Nastavení a banka **přepočítá splátku** na zbývající dobu.
  Bez známého konce fixace (ani data, ani roků) se sazba nemění. V Přehledu je u cashflow vidět, kdy a o kolik se splátka změnila.
- Formulář úvěru má dvě rozbalovací buňky: **Splatnost** (zřízení úvěru, doba splácení v letech nebo "Splatnost do") a **Fixace**
  (úrok fixace, doba fixace v letech nebo "Fixace do"). Fixace začíná zřízením úvěru. U obou stačí zadat jedno (roky, nebo datum),
  druhé se dopočítá.
- Řádky Scénářů a Přehled jsou **kalendářní roky** (leden až prosinec). Letošní řádek začíná dneškem, takže obsahuje jen zbývající
  měsíce roku (od října 3 měsíce, označeno "říj–pro"); zhodnocení v něm se počítá poměrně. Nájem a náklady se indexují 1. ledna.
  Konec fixace, refinancování i splatnost připadnou přímo na svůj měsíc. Měsíční zobrazení dělí počtem měsíců řádku, pruhy nad
  tabulkami ukazují běžnou roční hodnotu. Pruh nad seznamem nemovitostí a úvěrů má jen nájem, náklady (když nějaké jsou) a splátky,
  cashflow v něm není (je v Přehledu).
- **Refinancování** je samostatná událost, podobně jako scénářové události: na záložce Úvěry nad seznamem úvěrů se přidá
  (úvěr, datum v budoucnosti, nová sazba, nová doba, případně sloučení) a je v seznamu naplánovaných refinancování. U jednoho
  úvěru jich může být víc. Ze zbývající jistiny se k datu spočítá nová anuita - "kolo od začátku", takže se zase platí hlavně
  úrok, i když úvěr předtím už běžel. Nová smlouva nahrazuje původní: po refinancování už konec fixace staré smlouvy sazbu
  nemění, a refinancování bez zadané sazby počítá se sazbou hypotéky z Nastavení. Prázdné datum se předvyplní nejbližším koncem
  fixace z vybraných úvěrů (dokud nezadáš vlastní). Ve Scénářích je refinancování i mezi událostmi s odkazem zpět.
- **Balíček refinancování**: úvěry se ve formuláři vybírají štítky (**Všechny** nebo víc úvěrů). Datum, nová sazba a nová doba se
  pak uplatní u každého vybraného úvěru zvlášť (každý si spočítá novou anuitu z vlastního zůstatku), ale v seznamu a ve Scénářích je to
  jeden řádek / jedna událost. Úprava balíčku mění všechny jeho úvěry najednou, smazání odstraní refinancování u všech; když se
  výběr zúží na jediný úvěr, z balíčku je zase samostatné refinancování. Smazání úvěru ho z balíčku jen vyřadí.
- **Sloučení úvěrů**: u refinancování jednoho úvěru jde zvolit "Sloučit s úvěry" (u balíčku víc úvěrů ne). Zůstatky vybraných úvěrů se k datu refinancování splatí
  a přičtou k refinancovanému úvěru, který pak splácí jedna nová anuita z celé částky (nová doba je povinná, datum musí být
  v budoucnosti). Sloučené úvěry se od toho měsíce neplatí, v tabulce a v kalendáři je vidět, kdy a kolik se převzalo.
- Scénářová událost **změna úrokové sazby** přepíše sazbu vybraných (nebo všech) úvěrů na zadanou hodnotu (nahoru i dolů)
  a splátka se přepočte do stejné splatnosti; po skončení události se vrací původní sazba. Starší události "růst sazeb"
  (o p. b.) fungují dál a jsou označené jako starší.
- Prodej nemovitosti splatí nejdřív úvěry vázané na ni, zbytek úvěr s nejvyšší sazbou; doba splácení zůstává
  a banka sníží splátku (cashflow tak neklesne víc, než činí ztracený nájem).
- U každého úvěru jde rozbalit **splátkový kalendář** po letech (úrok, jistina, podíl úroku, zůstatek).
- **Zástava** = nemovitost, kterou dáš bance jako jistotu za úvěr. Je to vazba nemovitost + úvěr + částka z hodnoty
  nemovitosti. Zadává se jen u úvěru ("Které nemovitosti jistí tenhle úvěr"); v seznamu nemovitostí je vidět, co je zastavené
  a kolik zbývá volné k zastavení. Hlídá se, že součet zástav nepřesáhne hodnotu nemovitosti. Zástavy jsou jen informace; při
  prodeji nemovitosti podle nich aplikace pozná, které úvěry jsou na ni vázané. Žádný nákup nemovitosti se podle zástav nepočítá.
  Starší "vlastní zástava" zadaná v kartě nemovitosti se při načtení zahodí.
- Ve Scénářích je prodej jen štítek s názvem nemovitosti, podrobnosti (cena, daň, výtěžek, proč se prodala a porovnání s ostatními)
  jsou v bublině po kliknutí. Dlouhá bublina se vejde na obrazovku a obsah v ní jde posouvat. Neúplný letošní rok je označený malým "i", které po kliknutí řekne, za jaké měsíce řádek je.
- **Prázdné datum** pořízení nemovitosti nebo zřízení úvěru se bere jako **dnešní den** a uloží se (u dat, která už v aplikaci jsou,
  se doplní při načtení). Pozor: časový test FO nemovitosti se pak počítá od dneška, takže bez skutečného data pořízení se
  nemovitost automaticky neprodá dřív než po jeho uplynutí. Skutečná data proto raději zadej.
- **Formuláře hlídají hodnoty** (nemovitost, úvěr, scénářová událost i Nastavení): povinná pole, meze (např. sazba 0–100 %, obsazenost
  0–100 %, růst −50 až 100 %), neexistující data (31. 2.), splatnost před zřízením, fixace delší než splatnost nebo refinancování bez data.
  Chyba je napsaná pod polem a uložení se zastaví, dokud se nespraví; chybné pole ve sbaleném bloku se samo rozbalí. Hodnoty se ukládají
  do svých polí ve správných jednotkách (procenta jako zlomek, text bez nadbytečných mezer). Kalendář jde použít i na telefonu.
- **LTV** se zadává ručně v "Další údaje" u úvěru (jeden úvěr může financovat víc nemovitostí).
- V seznamu bank jsou původní loga (ikony z webů bank, `assets/banks`) a volba **Vlastní**, po které jde napsat libovolný název.
- **Seznamy** (nemovitosti, úvěry, refinancování, události, tabulka po letech): každý záznam je na jednom řádku a seznam se
  nikdy neposouvá do strany. Na velké obrazovce se stránka roztáhne (až na 1600 px; formuláře, Přehled a Nastavení zůstávají
  úzké). Když se všechny sloupce na šířku nevejdou, samy se vypustí ty nejméně důležité (u nemovitostí nejdřív Volné k zastavení
  a Zástava, u úvěrů Nemovitost a Poměr LTV, ve Scénářích Nashromážděné zhodnocení a Náklady); tlačítko "Více sloupců" ukáže
  všechny (pak jde posouvat), "Méně sloupců" jen hlavní. Dlouhé texty (jméno, poznámka, cíle události) se zkrátí a celé jsou
  v tooltipu, poznámka a sloučení u úvěru v bublině "i". Na telefonu jsou seznamy ve výchozím stavu kompaktní, tlačítko "Více sloupců" je přes celou šířku (na počítači zůstává malé vpravo)
  a poznámka je v kalendáři po rozbalení úvěru.

## Vzhled

Světlý, tmavý a barevný motiv (ikona v hlavičce nebo Nastavení). Volba motivu je jen vzhled, drží se
v prohlížeči (`localStorage`), nejsou to data účtu.

Přepínač **Informace** (Nastavení, karta Vzhled, ikona i) je ve výchozím stavu zapnutý. Když ho vypneš, nejsou nikde vidět
nápovědy "Jak to počítám?", rozkliknutelné vzorce u karet v Přehledu ani Scénářích a malé "i" u neúplného roku, karty
přestanou vypadat jako klikací. Poznámky u úvěrů a bubliny u prodeje (to jsou data, ne nápověda) zůstávají. Volba se drží
v prohlížeči (`investix-info`), takže je zvlášť na každém zařízení, a nastaví se ještě před vykreslením stránky.

Částky, procenta a data se píšou s nedělitelnou mezerou (`\u00a0` v `js/app.js`), takže se "Kč" ani "%" nikdy nezalomí na
další řádek; u karet v Přehledu se navíc písmo u velmi dlouhého čísla mírně zmenší, aby se vešlo na jeden řádek.

## Appka na ploše (iPhone a Windows)

Investix jde přidat na plochu jako appku: celá obrazovka bez lišty Safari a ikona s logem. V Safari otevři
https://kylianek.github.io/investix/ a dej Sdílet → Přidat na plochu (nech zapnuté "Otevřít jako webovou aplikaci").

- Nastavení je v [index.html](index.html) (meta tagy pro iOS, `apple-touch-icon`, odkaz na manifest), v
  [manifest.webmanifest](manifest.webmanifest) (`display: standalone`) a v ikonách v `assets/icons/`. Stavový řádek je v režimu
  `default` jako v CRM; barva lišty (`theme-color`) se přepíná podle zvoleného motivu.
- iPhone si manifest a ikonu načte jen při přidání na plochu: po změně ikonu na ploše smaž a přidej znovu.
- Appka má vlastní úložiště oddělené od Safari, takže se v ní jednou přihlásíš znovu (motiv se nastaví zvlášť).
- Ikony se vyrábí z `assets/logo.png` skriptem [tools/make-icons.ps1](tools/make-icons.ps1)
  (`powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1`): čtvercová plná ikona 180 / 192 / 512 px, dům na 66 % šířky,
  malé logo do hlavičky a ikona záložky. Offline režim (service worker) appka nemá, data jsou v cloudu.

**Windows (Edge nebo Chrome)**: na https://kylianek.github.io/investix/ dej v adresním řádku Nainstalovat (v Edge také nabídka
Aplikace → Nainstalovat tento web jako aplikaci). Appka se otevře v samostatném okně bez adresního řádku, s ikonou v nabídce Start
a na hlavním panelu.

- `launch_handler` v manifestu (`focus-existing`) zajistí, že další spuštění použije už otevřené okno, ne druhé.
- Výběr textu a označování (`user-select: none` u tlačítek) je zakázané jen na dotykových zařízeních (`pointer: coarse`), na
  Windows s myší jde text normálně označit.
- **Posouvání**: `html` i `body` mají `overflow-x: hidden`, takže je kontejnerem s posouváním `body`. Proto se na `html` ani
  `body` nikdy nenastavuje `overscroll-behavior` - v nainstalované appce takové pravidlo zablokovalo kolečko myši i dotyk a stránka
  se nehnula (v css je u toho komentář).
- Po nasazení nové verze se appka aktualizuje sama při dalším spuštění; manifest (ikony, `launch_handler`) si Chrome a Edge
  načtou znovu do dne, případně appku odinstaluj a nainstaluj znovu.

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
