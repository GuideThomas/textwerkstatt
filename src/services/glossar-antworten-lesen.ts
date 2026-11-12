/**
 * Der reine Leser der Antwortliste zum Glossar-Blatt, ohne Datenbank (abgeteilt am 10.11.2026 aus `glossar-antworten.ts`).
 *
 * Warum eigen: `glossar-antworten.ts` zieht über `glossar-pflege` die Datenbankverbindung nach, und deren Konfiguration verlangt
 * `DB_PASSWORD` schon beim Laden. Das Einlesen der Namensbausteine (`namens-einlesen.ts`) braucht nur diesen Leser, und das
 * Messskript des Assistenten lädt `namens-einlesen.js` ohne Datenbank (`scripts/namens-messung.mjs`).
 */
export type AntwortEntscheidung = 'vorschlag' | 'ok';

export interface AntwortZeile {
  zeile: number;
  deutsch: string;
  heute: string;
  vorschlag: string;
  entscheidung: AntwortEntscheidung;
}

const SPALTEN = ['zeile', 'deutsch', 'heute', 'vorschlag', 'entscheidung'];

/** Entscheidung aus der Auswahlliste des Blatts. Andere Werte („bis 04.11.“, „ohne Eintrag“) kann dieser Weg noch nicht. */
export function entscheidungAus(wert: string): AntwortEntscheidung | null {
  const w = wert.trim();
  if (w === 'OK') return 'ok';
  if (w.startsWith('Vorschlag')) return 'vorschlag';
  return null;
}

/** Liest die Antwortliste (TSV mit Kopfzeile, Spalten mindestens `zeile, deutsch, heute, vorschlag, entscheidung`). */
export function leseAntworten(text: string): AntwortZeile[] {
  const zeilen = text.replace(/\r\n/g, '\n').split('\n').filter((z) => z.trim() !== '');
  if (zeilen.length === 0) throw new Error('Die Liste ist leer');
  const kopf = zeilen[0].split('\t');
  const fehlt = SPALTEN.filter((s) => !kopf.includes(s));
  if (fehlt.length > 0) throw new Error(`Der Liste fehlen Spalten: ${fehlt.join(', ')}`);
  const stelle = (s: string) => kopf.indexOf(s);
  const gesehen = new Set<string>();
  return zeilen.slice(1).map((roh, i) => {
    const t = roh.split('\t');
    const wert = (s: string) => t[stelle(s)] ?? '';
    const nr = i + 2;
    const deutsch = wert('deutsch');
    const entscheidung = entscheidungAus(wert('entscheidung'));
    if (!deutsch.trim()) throw new Error(`Zeile ${nr}: Begriff fehlt`);
    if (deutsch !== deutsch.trim()) throw new Error(`Zeile ${nr}: Begriff mit Leerraum am Rand`);
    if (!entscheidung) throw new Error(`Zeile ${nr}: Entscheidung „${wert('entscheidung')}“ kann dieser Weg nicht`);
    if (gesehen.has(deutsch)) throw new Error(`Zeile ${nr}: Begriff „${deutsch}“ doppelt`);
    gesehen.add(deutsch);
    const vorschlag = wert('vorschlag');
    if (entscheidung === 'vorschlag') {
      if (!vorschlag.trim()) throw new Error(`Zeile ${nr}: „Vorschlag“ gewählt, aber kein Vorschlag da`);
      if (vorschlag !== vorschlag.trim()) throw new Error(`Zeile ${nr}: Vorschlag mit Leerraum am Rand`);
      if (vorschlag === wert('heute')) throw new Error(`Zeile ${nr}: Vorschlag gleich dem heutigen Wert`);
    }
    const zeile = Number(wert('zeile'));
    return { zeile: Number.isInteger(zeile) ? zeile : nr, deutsch, heute: wert('heute'), vorschlag, entscheidung };
  });
}
