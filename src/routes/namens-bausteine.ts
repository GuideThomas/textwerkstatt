/**
 * Namensbausteine für den Artikelanlage-Assistenten, seit Phase 3 der Wortliste aus dem Glossar.
 *
 * Plan `PLAN-wortliste.md` §2.2–§2.4 (Cockpit #1831), davor Plan `Artikelanlage-Assistent/docs/PLAN-Artikelnamen-Bausteine.md`
 * §2 Phase 2. Der Assistent bildet Artikelnamen selbst (`bildeName`, Entscheid Thomas 06.11.2026); seit 10.11.2026 gibt es dafür
 * keine eigene Tabelle mehr, sondern eine Wortliste je Sprache, die zugleich das Glossar ist (Entscheid Thomas 10.11.2026).
 *
 *   GET  /api/namens-bausteine?sprache=FR             freigegebene Wörter einer Sprache mit Fassung (ETag), Channel-Werten und
 *                                                     Gruppenzielen (je Gruppe ein eigener Eintrag mit `produktgruppe`)
 *   GET  /api/namens-bausteine/vorlaeufig?sprache=FR  offene Zeilen, getrennte Route
 *   POST /api/namens-bausteine/unbekannt              unbekannte Bausteine melden, sie werden offene Zeilen mit Vorschlag
 *
 * 🚨 DER SCHUTZ „NUR FREIGEGEBENES“ STEHT IN DER SICHT, NICHT HIER. `GET /` liest allein `wortliste_freigegeben` (Migration 036),
 * die Offenes nicht kennt; `…/vorlaeufig` liest allein `wortliste_offen`. Bis 10.11.2026 trugen zwei Tabellen diesen Schutz
 * (Migration 033). `scripts/namens-bausteine.test.mjs` hält beides fest und prüft, dass diese Datei `glossary_entries` nicht liest.
 *
 * 🚨 DIE VORLÄUFIGEN HABEN EINE EIGENE ROUTE, KEINEN PARAMETER. Der Bestandslauf (Phase 6) darf nur Freigegebenes sehen. Ein
 * Schalter `?stand=vorlaeufig` auf derselben Route wäre ein Filter, den ein Aufrufer falsch setzen kann; eine Route, die er nie
 * aufruft, ist eine Schranke.
 *
 * Auth: `requireServiceKeyOrLocal`, zu statt offen.
 *
 * In Phase 2 ruft nur das Messskript; eingebaut in die Lieferwege wird erst in Phase 5.
 *
 * DeepL-Vorschlag (Bauplan §8, Schritt 6): Nach dem Speichern holt `POST …/unbekannt` für jeden gemeldeten Vorschlag ohne
 * DeepL-Wert einen, mit dem ersten Beispielnamen als `context`. Ohne Beispiel fragt die Route DeepL nicht: Ein einzelnes Wort ohne
 * Zusammenhang ist genau der Weg, auf dem `rund → aproximadamente` entstand. Das Glossar geht bewusst **nicht** mit. Der Prüfer
 * sieht die Vorschläge der Quellen nebeneinander, und ein DeepL-Wert mit Glossar wäre nur das Glossar ein zweites Mal
 * (`principle-pruefer-teilt-quelle-mit-erzeuger`). Je Anfrage höchstens `MAX_DEEPL_JE_ANFRAGE` Aufrufe; was liegen bleibt, steht in
 * der Antwort als `ausstehend` und kommt mit der nächsten Meldung desselben Bausteins dran. Ein DeepL-Fehler bricht nur diesen
 * Schritt ab, die Meldungen sind dann schon gespeichert.
 */
import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { config } from '../config';
import { requireServiceKeyOrLocal } from '../middleware/dienstzugang';
import { holeDeeplVorschlag } from '../services/glossar-pflege';
import { alsBearbeiter, type Bearbeiter } from '../db/bearbeiter';

/** Wer meldet: der Assistent über den Dienstschlüssel, ohne angemeldete Person. Steht so im Verlauf (Migration 037). */
const MELDER: Bearbeiter = { id: null, name: 'Artikelanlage-Assistent (gemeldet)' };

const router = Router();

export const NAMENS_SPRACHEN = ['EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ'] as const;
type Sprache = (typeof NAMENS_SPRACHEN)[number];

/** Was ein Aufrufer als unbekannt melden kann. `fest` (Serie, Blockwort) entsteht nur über das Einlesen. */
const MELDBARE_ARTEN = new Set(['muster', 'wort', 'wendung']);
/** Obergrenze je Meldung. Der Aufrufer bündelt selbst; diese Schranke ist die zweite Reihe. */
export const MAX_MELDUNGEN = 2_000;
/**
 * Höchstens so viele DeepL-Aufrufe je Anfrage, einer je Baustein, weil jeder seinen eigenen Kontext trägt. Ein Aufruf kostet die
 * Zeichen des Bausteins (der Kontext ist frei) und dauert einige Zehntelsekunden; 50 halten die Antwort unter einer halben Minute.
 */
export const MAX_DEEPL_JE_ANFRAGE = 50;
const MAX_TEXT = 300;
const MAX_KOPFWORT = 100;
const MAX_BEISPIELE = 2;

function spracheAus(wert: unknown): Sprache | null {
  const s = typeof wert === 'string' ? wert.trim().toUpperCase() : '';
  return (NAMENS_SPRACHEN as readonly string[]).includes(s) ? (s as Sprache) : null;
}

const SPRACHFEHLER = `sprache muss eine von ${NAMENS_SPRACHEN.join(', ')} sein (Tschechisch heißt CZ)`;

/** Ein Text aus einer Meldung: getrimmt, nicht leer, ohne Steuerzeichen, nicht zu lang. */
function textAus(wert: unknown, max: number): string | null {
  if (typeof wert !== 'string') return null;
  const t = wert.trim();
  // eslint-disable-next-line no-control-regex
  if (!t || t.length > max || /[\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

function ganzzahlAus(wert: unknown): number | null | undefined {
  if (wert === undefined || wert === null) return null;
  if (typeof wert !== 'number' || !Number.isInteger(wert) || wert < 0 || wert > 2_147_483_647) return undefined;
  return wert;
}

router.get('/', requireServiceKeyOrLocal, async (req: Request, res: Response) => {
  const sprache = spracheAus(req.query.sprache);
  if (!sprache) {
    res.status(400).json({ error: SPRACHFEHLER });
    return;
  }
  const client = await pool.connect();
  try {
    // Ein Schnappschuss: Fassung und Zeilen müssen zusammenpassen, sonst trüge der ETag eine Nummer zu fremden Zeilen.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const f = await client.query<{ fassung: number }>(
      `SELECT COALESCE(max(nummer), 0)::int AS fassung FROM namens_bausteine_fassung WHERE sprache = $1`,
      [sprache],
    );
    const fassung = f.rows[0].fassung;
    const etag = `"namens-${sprache}-${fassung}"`;
    if (req.header('If-None-Match') === etag) {
      await client.query('COMMIT');
      res.status(304).set('ETag', etag).end();
      return;
    }
    const b = await client.query<FreiZeile>(
      `SELECT id, art, deutsch, ziel, ziel_name, wortart, genus, formen, merkmalsklasse, namensfassung, kanaele, gruppen
         FROM wortliste_freigegeben
        WHERE sprache = $1
        ORDER BY art, lower(btrim(deutsch)), deutsch`,
      [sprache],
    );
    await client.query('COMMIT');
    const bausteine = alsBausteine(b.rows);
    res.set('ETag', etag).set('Cache-Control', 'no-cache').json({ sprache, fassung, anzahl: bausteine.length, bausteine });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('namens-bausteine GET:', err);
    res.status(500).json({ error: 'Namensbausteine konnten nicht gelesen werden' });
  } finally {
    client.release();
  }
});

router.get('/vorlaeufig', requireServiceKeyOrLocal, async (req: Request, res: Response) => {
  const sprache = spracheAus(req.query.sprache);
  if (!sprache) {
    res.status(400).json({ error: SPRACHFEHLER });
    return;
  }
  try {
    const r = await pool.query(
      `SELECT id, art, deutsch, ziel, NULL::int AS produktgruppe, stelle, kopfwort, wortart, genus, formen, merkmalsklasse,
              COALESCE(quelle, 'glossar') AS quelle, status, artikel_anzahl
         FROM wortliste_offen
        WHERE sprache = $1
        ORDER BY art, lower(btrim(deutsch)), deutsch`,
      [sprache],
    );
    res.set('Cache-Control', 'no-cache').json({ sprache, vorlaeufig: true, anzahl: r.rowCount ?? r.rows.length, eintraege: r.rows });
  } catch (err) {
    console.error('namens-bausteine GET vorlaeufig:', err);
    res.status(500).json({ error: 'Vorläufige Namensbausteine konnten nicht gelesen werden' });
  }
});

interface Meldung {
  sprache: Sprache;
  art: string;
  deutsch: string;
  produktgruppe: number | null;
  stelle: 'kopf' | 'teil' | null;
  kopfwort: string | null;
  artikelAnzahl: number | null;
  beispiele: string[];
}

/** Prüft eine Meldung. Liefert die bereinigte Meldung oder den Grund, warum sie abgewiesen wird. */
export function pruefeMeldung(roh: unknown): Meldung | string {
  if (!roh || typeof roh !== 'object') return 'keine Meldung';
  const m = roh as Record<string, unknown>;
  const sprache = spracheAus(m.sprache);
  if (!sprache) return SPRACHFEHLER;
  const art = typeof m.art === 'string' ? m.art.trim() : '';
  if (!MELDBARE_ARTEN.has(art)) return `art muss eine von ${[...MELDBARE_ARTEN].join(', ')} sein`;
  const deutsch = textAus(m.deutsch, MAX_TEXT);
  if (!deutsch) return `deutsch fehlt, ist länger als ${MAX_TEXT} Zeichen oder enthält Steuerzeichen`;
  const produktgruppe = ganzzahlAus(m.produktgruppe);
  if (produktgruppe === undefined) return 'produktgruppe muss eine nicht negative ganze Zahl oder leer sein';
  let stelle: 'kopf' | 'teil' | null = null;
  if (m.stelle !== undefined && m.stelle !== null) {
    if (m.stelle !== 'kopf' && m.stelle !== 'teil') return 'stelle muss kopf oder teil sein';
    stelle = m.stelle;
  }
  let kopfwort: string | null = null;
  if (m.kopfwort !== undefined && m.kopfwort !== null) {
    kopfwort = textAus(m.kopfwort, MAX_KOPFWORT);
    if (!kopfwort) return `kopfwort ist leer, länger als ${MAX_KOPFWORT} Zeichen oder enthält Steuerzeichen`;
  }
  const artikelAnzahl = ganzzahlAus(m.artikelAnzahl);
  if (artikelAnzahl === undefined) return 'artikelAnzahl muss eine nicht negative ganze Zahl oder leer sein';
  const beispiele: string[] = [];
  if (m.beispiele !== undefined && m.beispiele !== null) {
    if (!Array.isArray(m.beispiele)) return 'beispiele muss eine Liste sein';
    for (const b of m.beispiele) {
      const t = textAus(b, MAX_TEXT);
      if (!t) return 'ein Beispiel ist leer, zu lang oder enthält Steuerzeichen';
      if (!beispiele.includes(t) && beispiele.length < MAX_BEISPIELE) beispiele.push(t);
    }
  }
  return { sprache, art, deutsch, produktgruppe, stelle, kopfwort, artikelAnzahl, beispiele };
}

/** Was der DeepL-Schritt einer Meldung bewirkt hat. `verworfen`: DeepL verlor einen geschützten Wert oder lieferte nichts. */
export interface DeeplStand {
  geholt: number;
  verworfen: number;
  ausstehend: number;
  fehler: string | null;
}

/**
 * Holt für die genannten offenen Zeilen den DeepL-Wert, wo er fehlt und ein Beispielname da ist. Schreibt nur
 * `wortliste_vorschlag.vorschlag_deepl`, und nur, wenn das Feld noch leer und die Zeile noch offen ist; ein gleichzeitiger Lauf
 * überschreibt also nichts. Das Ziel der Zeile folgt dann per Trigger (Migration 036), solange niemand es von Hand gesetzt hat.
 */
async function ergaenzeDeeplVorschlaege(ids: string[]): Promise<DeeplStand> {
  const stand: DeeplStand = { geholt: 0, verworfen: 0, ausstehend: 0, fehler: null };
  if (ids.length === 0) return stand;
  const offen = await pool.query<{ id: string; sprache: string; deutsch: string; kontext: string }>(
    `SELECT v.entry_id AS id, g.target_lang AS sprache, e.source_term AS deutsch, v.beispiele[1] AS kontext
       FROM wortliste_vorschlag v
       JOIN glossary_entries e ON e.id = v.entry_id
       JOIN glossaries g ON g.id = e.glossary_id
      WHERE v.entry_id = ANY($1::uuid[]) AND v.vorschlag_deepl IS NULL AND cardinality(v.beispiele) > 0
        AND e.approved IS NOT TRUE
      ORDER BY v.artikel_anzahl DESC NULLS LAST, v.entry_id`,
    [ids],
  );
  if (offen.rows.length === 0) return stand;
  if (!config.deepl.apiKey) {
    return { ...stand, ausstehend: offen.rows.length, fehler: 'DEEPL_API_KEY ist nicht gesetzt' };
  }
  for (const [i, z] of offen.rows.entries()) {
    if (i >= MAX_DEEPL_JE_ANFRAGE || stand.fehler) {
      stand.ausstehend += 1;
      continue;
    }
    try {
      const v = await holeDeeplVorschlag({
        begriff: z.deutsch,
        sourceLang: 'DE',
        targetLang: z.sprache,
        deeplGlossaryId: null,
        kontext: z.kontext,
      });
      if (v.status !== 'ok') {
        stand.verworfen += 1;
        continue;
      }
      const u = await alsBearbeiter(MELDER, (c) => c.query(
        `UPDATE wortliste_vorschlag v SET vorschlag_deepl = $2, geaendert_am = NOW()
           FROM glossary_entries e
          WHERE v.entry_id = $1 AND e.id = v.entry_id AND v.vorschlag_deepl IS NULL AND e.approved IS NOT TRUE`,
        [z.id, v.vorschlag],
      ));
      if ((u.rowCount ?? 0) > 0) stand.geholt += 1;
    } catch (err) {
      console.error('namens-bausteine DeepL-Vorschlag:', err);
      stand.fehler = 'DeepL hat nicht geantwortet';
      stand.ausstehend += 1;
    }
  }
  return stand;
}

/**
 * Meldet unbekannte Bausteine. Eine Zeile der Wortliste je exakter Schreibung (Plan Wortliste §2.1): Gibt es sie freigegeben, ist
 * der Baustein bekannt; offen, wird ihr Vorschlag ergänzt; gar nicht, entsteht eine offene Zeile mit `an_deepl = FALSE` und
 * Vorschlag `gemeldet`. Abgelehnte (`wortliste_abgelehnt`) werden nicht neu vorgeschlagen. Die Produktgruppe einer Meldung ist
 * kein Schlüssel mehr: Ein Ziel je Gruppe legt ein Mensch an der Zeile an.
 */
router.post('/unbekannt', requireServiceKeyOrLocal, async (req: Request, res: Response) => {
  const meldungen = req.body?.meldungen;
  if (!Array.isArray(meldungen) || meldungen.length === 0) {
    res.status(400).json({ error: 'meldungen muss eine nicht leere Liste sein' });
    return;
  }
  if (meldungen.length > MAX_MELDUNGEN) {
    res.status(413).json({ error: `höchstens ${MAX_MELDUNGEN} Meldungen je Anfrage` });
    return;
  }

  const abgewiesen: Array<{ index: number; grund: string }> = [];
  const gueltig: Array<{ index: number; m: Meldung }> = [];
  meldungen.forEach((roh: unknown, index: number) => {
    const p = pruefeMeldung(roh);
    if (typeof p === 'string') abgewiesen.push({ index, grund: p });
    else gueltig.push({ index, m: p });
  });

  const ergebnis = { angelegt: 0, aktualisiert: 0, bekannt: 0, abgelehnt: 0 };
  /** Die offenen Zeilen dieser Anfrage, angelegt oder ergänzt: Für sie holt der DeepL-Schritt danach den Wert, wo er fehlt. */
  const offeneIds: string[] = [];
  try {
    await alsBearbeiter(MELDER, async (client) => {
      // Zwei gleichzeitige Meldungen desselben neuen Worts legten sonst zwei Zeilen an.
      await client.query('SELECT pg_advisory_xact_lock(711036)');
      const glossare = new Map<string, string>();
      for (const { m } of gueltig) {
        let gid = glossare.get(m.sprache);
        if (!gid) {
          const g = await client.query<{ id: string }>(`SELECT id FROM glossaries WHERE source_lang = 'DE' AND target_lang = $1`, [m.sprache]);
          if (g.rows.length !== 1) throw new Error(`Glossar DE→${m.sprache}: ${g.rows.length} gefunden`);
          gid = g.rows[0].id;
          glossare.set(m.sprache, gid);
        }
        // Bekannt wie in `bildeName` (Plan §2.4): freigegeben in exakter Schreibung, sonst genau eine freigegebene ohne Groß/Klein.
        // Zwei solche (`Cover`, `COVER`) sind kein Treffer. Offene Zeilen gelten ohne Groß/Klein als dieselbe, sonst stünde jede
        // Schreibung eines Namens als eigener Vorschlag da.
        const frei = (await client.query<{ exakt: boolean }>(
          `SELECT btrim(source_term) = btrim($2) AS exakt FROM glossary_entries
            WHERE glossary_id = $1 AND approved IS TRUE AND target_term IS NOT NULL
              AND lower(btrim(source_term)) = lower(btrim($2))`,
          [gid, m.deutsch],
        )).rows;
        if (frei.some((f) => f.exakt) || frei.length === 1) {
          ergebnis.bekannt += 1;
          continue;
        }
        const z = (await client.query<{ id: string }>(
          `SELECT id FROM glossary_entries
            WHERE glossary_id = $1 AND approved IS NOT TRUE AND lower(btrim(source_term)) = lower(btrim($2))
            ORDER BY (btrim(source_term) = btrim($2)) DESC, (target_term IS NULL), created_at, id
            LIMIT 1 FOR UPDATE`,
          [gid, m.deutsch],
        )).rows[0];
        if (!z) {
          const ab = await client.query(`SELECT 1 FROM wortliste_abgelehnt WHERE glossary_id = $1 AND btrim(source_term) = btrim($2)`, [gid, m.deutsch]);
          if (ab.rows.length > 0) {
            ergebnis.abgelehnt += 1;
            continue;
          }
          const neu = await client.query<{ id: string }>(
            `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, source, an_deepl, art)
             VALUES ($1, $2, NULL, FALSE, 'gemeldet', FALSE, $3) RETURNING id`,
            [gid, m.deutsch, m.art],
          );
          await client.query(
            `INSERT INTO wortliste_vorschlag (entry_id, quelle, stelle, kopfwort, beispiele, artikel_anzahl)
             VALUES ($1, 'gemeldet', $2, $3, $4, $5)`,
            [neu.rows[0].id, m.stelle, m.kopfwort, m.beispiele, m.artikelAnzahl],
          );
          ergebnis.angelegt += 1;
          offeneIds.push(neu.rows[0].id);
          continue;
        }
        await client.query(`INSERT INTO wortliste_vorschlag (entry_id, quelle) VALUES ($1, 'gemeldet') ON CONFLICT (entry_id) DO NOTHING`, [z.id]);
        const vorhanden = (await client.query<{ beispiele: string[] }>(
          `SELECT beispiele FROM wortliste_vorschlag WHERE entry_id = $1 FOR UPDATE`, [z.id])).rows[0];
        const beispiele = [...vorhanden.beispiele];
        for (const b of m.beispiele) if (!beispiele.includes(b) && beispiele.length < MAX_BEISPIELE) beispiele.push(b);
        await client.query(
          `UPDATE wortliste_vorschlag
              SET beispiele = $2, artikel_anzahl = COALESCE($3, artikel_anzahl), stelle = COALESCE(stelle, $4),
                  kopfwort = COALESCE(kopfwort, $5), geaendert_am = NOW()
            WHERE entry_id = $1`,
          [z.id, beispiele, m.artikelAnzahl, m.stelle, m.kopfwort],
        );
        ergebnis.aktualisiert += 1;
        offeneIds.push(z.id);
      }
    });
  } catch (err) {
    console.error('namens-bausteine POST unbekannt:', err);
    res.status(500).json({ error: 'Meldungen konnten nicht gespeichert werden' });
    return;
  }

  // Erst nach dem Commit: Ein DeepL-Aufruf hält keine Sperre, und scheitert er, sind die Meldungen trotzdem gespeichert.
  let deepl: DeeplStand;
  try {
    deepl = await ergaenzeDeeplVorschlaege(offeneIds);
  } catch (err) {
    console.error('namens-bausteine DeepL-Schritt:', err);
    deepl = { geholt: 0, verworfen: 0, ausstehend: offeneIds.length, fehler: 'DeepL-Schritt fehlgeschlagen' };
  }
  res.json({ ...ergebnis, abgewiesen, deepl });
});

/** Eine Zeile von `wortliste_freigegeben`. */
export interface FreiZeile {
  id: string;
  art: string;
  deutsch: string;
  ziel: string;
  ziel_name: string | null;
  wortart: string | null;
  genus: string | null;
  formen: Record<string, string> | null;
  merkmalsklasse: string | null;
  namensfassung: number | null;
  kanaele: Record<string, string>;
  gruppen: Array<{ produktgruppe: number; ziel: string; genus: string | null; formen: Record<string, string> | null }>;
}

/**
 * Die Zeilen der Sicht als Bausteine, wie `bildeName` sie liest: je Zeile einer ohne Produktgruppe, dazu je Gruppenziel einer mit
 * `produktgruppe` und demselben `deutsch` (`Index` im Assistenten zieht die Gruppe vor). Ein Gruppenziel trägt keine Channel-Werte:
 * Die Gruppe trägt die Bedeutung, der Channel nur den Hauswortlaut (Plan §2.4).
 */
export function alsBausteine(zeilen: FreiZeile[]) {
  const aus = [];
  for (const z of zeilen) {
    const basis = {
      id: z.id, art: z.art, deutsch: z.deutsch, ziel: z.ziel, ziel_name: z.ziel_name, produktgruppe: null as number | null,
      wortart: z.wortart, genus: z.genus, formen: z.formen, merkmalsklasse: z.merkmalsklasse, fassung: z.namensfassung,
      kanaele: z.kanaele,
    };
    aus.push(basis);
    for (const g of z.gruppen) {
      aus.push({ ...basis, ziel: g.ziel, ziel_name: null, produktgruppe: g.produktgruppe, genus: g.genus ?? z.genus,
        formen: g.formen ?? z.formen, kanaele: {} });
    }
  }
  return aus;
}

export default router;
