/**
 * Verifikation des <script>/<style>-Block-Schutzes — insbesondere des Block-Wrappers,
 * der den Anker-Verlust in DeepLs Tag-Handling v2 verhindert (14.08.2026).
 *
 * Kein Framework im Repo — daher ein eigenstaendiges Skript, analog verify-storeview.ts.
 * Geprueft wird ausschliesslich, was NICHT von DeepL abhaengt: wann der Wrapper gesetzt
 * wird, und dass Protect→Restore in jeder Konstellation byte-identisch zurueckfuehrt.
 *
 * Der Wrapper selbst (dass v2 den Anker behaelt) ist gegen die echte API gemessen und im
 * Kommentar von protectCodeBlocks() dokumentiert — das laesst sich hier nicht nachstellen,
 * ohne DeepL aufzurufen.
 *
 * Aufruf:
 *   npx tsx src/scripts/verify-codeblocks.ts
 *
 * Bei Aenderungen an magento-html.ts (Code-Block-Schutz) bitte ausfuehren.
 */

// `export {}` macht die Datei zum Modul. Ohne das liegen `pass`/`fail`/`check` im globalen
// Scope und kollidieren im Typecheck mit den gleichnamigen Bindungen aus verify-storeview.ts
// (beides Skripte ohne import/export). Auf die Ausfuehrung hat es keine Wirkung.
export {};

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'verify-only-not-used';

const { protectCodeBlocks, restoreCodeBlocks } =
  require('../services/text/magento-html') as typeof import('../services/text/magento-html');

let pass = 0;
let fail = 0;

function check(name: string, actual: string, expected: string) {
  if (actual === expected) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`       erwartet: ${expected}`);
    console.log(`       bekommen: ${actual}`);
  }
}

function checkTrue(name: string, cond: boolean, hinweis: string) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${hinweis}`);
  }
}

/** Protect → Restore ohne "Uebersetzung": muss byte-identisch zurueckfuehren. */
function roundtrip(html: string): string {
  const p = protectCodeBlocks(html);
  return restoreCodeBlocks(p.protectedText, p.restoreMap);
}

const SCRIPT = `<script type="text/javascript">document.querySelector('.x').on('click');</script>`;
const STYLE = `<style>#html-body [data-pb-style=ABC]{background-position:left top;}</style>`;
const LINK = `<a href="/de/produkt-8192355.html" title="Mehr">Mehr erfahren</a>`;

console.log('\n=== 1. Wrapper wird NUR im Ausloeserfall gesetzt ===');
{
  // Ausloeser: Block direkt hinter </a>
  const p = protectCodeBlocks(`<div>${LINK}${SCRIPT}</div>`);
  check('Block direkt hinter </a> -> Wrapper',
    p.protectedText, `<div>${LINK}<div>__ISOLCODE0__</div></div>`);
}
{
  // Ausloeser mit Whitespace dazwischen (Zeilenumbruch im Quelldokument)
  const p = protectCodeBlocks(`<div>${LINK}\n  ${SCRIPT}</div>`);
  check('Block hinter </a> + Whitespace -> Wrapper',
    p.protectedText, `<div>${LINK}\n  <div>__ISOLCODE0__</div></div>`);
}
{
  // Kein Ausloeser: kein Anker davor -> unveraendertes Verhalten wie vor dem Fix
  const p = protectCodeBlocks(`<div><p>Text</p>${SCRIPT}</div>`);
  check('Block ohne Anker davor -> KEIN Wrapper',
    p.protectedText, `<div><p>Text</p>__ISOLCODE0__</div>`);
}
{
  // Kein Ausloeser: Anker weiter weg (Text dazwischen)
  const p = protectCodeBlocks(`<div>${LINK} Noch ein ganzer Satz dazwischen. ${SCRIPT}</div>`);
  checkTrue('Anker weit entfernt -> KEIN Wrapper',
    !p.protectedText.includes('<div>__ISOLCODE0__</div>'),
    `bekommen: ${p.protectedText}`);
}
{
  // Style-Block zaehlt genauso wie script
  const p = protectCodeBlocks(`<div>${LINK}${STYLE}</div>`);
  check('Style-Block hinter </a> -> Wrapper',
    p.protectedText, `<div>${LINK}<div>__ISOLCODE0__</div></div>`);
}

console.log('\n=== 2. Roundtrip fuehrt byte-identisch zurueck ===');
{
  const original = `<div>${LINK}${SCRIPT}</div>`;
  check('mit Wrapper', roundtrip(original), original);
}
{
  const original = `<div><p>Text</p>${SCRIPT}</div>`;
  check('ohne Wrapper', roundtrip(original), original);
}
{
  const original = `<div>${LINK}${SCRIPT}</div><p>x</p>${STYLE}<div>${LINK}${STYLE}</div>`;
  check('gemischt (gewrappt + ungewrappt, mehrere Bloecke)', roundtrip(original), original);
}
{
  const original = `<p>Kein Codeblock hier.</p>`;
  check('ohne jeden Codeblock (no-op)', roundtrip(original), original);
}

console.log('\n=== 3. Restore ist robust gegen DeepL-Umbauten ===');
{
  // DeepL ergaenzt ein Attribut am Wrapper
  const p = protectCodeBlocks(`<div>${LINK}${SCRIPT}</div>`);
  const veraendert = p.protectedText.replace('<div>__ISOLCODE0__</div>', '<div dir="ltr">__ISOLCODE0__</div>');
  check('Wrapper mit Attribut wird erkannt',
    restoreCodeBlocks(veraendert, p.restoreMap), `<div>${LINK}${SCRIPT}</div>`);
}
{
  // DeepL entfernt den Wrapper wieder -> Rueckfall auf den nackten Sentinel
  const p = protectCodeBlocks(`<div>${LINK}${SCRIPT}</div>`);
  const veraendert = p.protectedText.replace('<div>__ISOLCODE0__</div>', '__ISOLCODE0__');
  check('Wrapper entfernt -> Rueckfall greift',
    restoreCodeBlocks(veraendert, p.restoreMap), `<div>${LINK}${SCRIPT}</div>`);
}
{
  // Whitespace im Wrapper (Re-Formatierung)
  const p = protectCodeBlocks(`<div>${LINK}${SCRIPT}</div>`);
  const veraendert = p.protectedText.replace('<div>__ISOLCODE0__</div>', '<div> __ISOLCODE0__ </div>');
  check('Whitespace im Wrapper wird toleriert',
    restoreCodeBlocks(veraendert, p.restoreMap), `<div>${LINK}${SCRIPT}</div>`);
}

console.log('\n=== 4. Sonderzeichen im Codeblock (Regex-Ersetzungsfalle) ===');
{
  // `$&` und `$1` in der Ersetzung wuerden bei String-Replace als Muster gelten und
  // den Block zerstoeren. Genau dafuer steht der Callback in restoreCodeBlocks().
  const boese = `<script>var s = "$& und $1 und $\`";</script>`;
  const original = `<div>${LINK}${boese}</div>`;
  check('$&/$1 im Script ueberleben den Restore', roundtrip(original), original);
}
{
  const boeseStyle = `<style>a::after{content:"$&";}</style>`;
  const original = `<p>x</p>${boeseStyle}`;
  check('$& im Style ueberlebt den Restore', roundtrip(original), original);
}

console.log('\n=== 5. Negativkontrolle — der Test wuerde einen Regress sehen ===');
{
  // Wenn der Wrapper NICHT gesetzt wuerde, saehe die geschuetzte Form anders aus.
  const p = protectCodeBlocks(`<div>${LINK}${SCRIPT}</div>`);
  checkTrue('Ausloeserfall ist vom Normalfall unterscheidbar',
    p.protectedText.includes('<div>__ISOLCODE0__</div>') &&
      !protectCodeBlocks(`<div><p>x</p>${SCRIPT}</div>`).protectedText.includes('<div>__ISOLCODE0__</div>'),
    'Beide Faelle liefern dieselbe Form — der Test koennte den Fix nicht von seinem Fehlen unterscheiden.');
}

console.log(`\n${pass} ok, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
