/**
 * Das Muster der Firmen- und Channelnamen, die im öffentlichen Repo nicht stehen dürfen (Plan `PLAN-oeffentlich-und-demo.md` §8).
 * Gelesen von scripts/firmenfrei.test.mjs (Positivliste im privaten Repo) und scripts/oeffentlich/export.mjs (ganzer Exportbaum).
 *
 * Die Namen stehen als Bausteine, damit diese Datei selbst firmenfrei bleibt. Die beiden kurzen Channel-Kürzel mit Wortgrenzen,
 * sonst träfen sie `isClarification`, `Tennisclub` und `atmosphere`.
 */
const NAMEN = [['iso', 'led'], ['gal', 'axy'], ['iso', 'licht'], ['inno', 'vate'], ['sc', 'l-licht']].map((t) => t.join(''));
const MIT_GRENZE = [['s', 'cl'], ['sph', 'ere']].map((t) => t.join(''));

export const MUSTER = new RegExp(`(${NAMEN.join('|')})|\\b(${MIT_GRENZE.join('|')})\\b`, 'i');

/** Dateien, deren Inhalt nicht als Text gelesen wird. */
export const BINAER = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip)$/i;

/** Positiv- und Negativprobe; liefert die Fehler, leer heißt: das Muster trifft, was es soll, und nur das. */
export function selbsttest() {
  const treffen = [NAMEN[0].toUpperCase() + ' Translationtool', `channel ${MIT_GRENZE[0].toUpperCase()}`, `www.${NAMEN[0]}.shop`];
  const nichtTreffen = ['isClarification', 'Tennisclub', 'atmosphere', 'disclaimer', 'SHOPA'];
  return [
    ...treffen.filter((s) => !MUSTER.test(s)).map((s) => `Positivprobe nicht erkannt: ${s}`),
    ...nichtTreffen.filter((s) => MUSTER.test(s)).map((s) => `Negativprobe fälschlich erkannt: ${s}`),
  ];
}
