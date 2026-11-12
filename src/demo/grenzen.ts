/**
 * Grenzen der Demo (`PLAN-oeffentlich-und-demo.md` Phase 2, Schalter `DEMO_MODUS`). Ohne Demo kehrt jede Funktion hier sofort
 * zurück, ohne die Datenbank zu fragen; die Produktion merkt nichts (G2).
 *
 * - **Zeichen** für DeepL und KI, je Tag für die ganze Demo und je Sitzung. Gezählt an den drei Stellen, durch die jeder Aufruf geht:
 *   `translateText`/`translateBatch` (`services/deepl.ts`), `callLlm` (`services/llm.ts`), `kiAufrufen` (`services/ki-weg.ts`).
 *   Die Sitzung kommt über `demoKontext` aus der Anfrage. Läuft ein Aufruf außerhalb einer Anfrage (Dokument in der Warteschlange),
 *   zählt nur die Summe der Demo — die schützt das Firmenkontingent, auf sie kommt es an.
 * - **Klare Meldung statt stillem Kürzen:** Wer an eine Grenze stößt, bekommt 429 mit dem Grund, auch wenn die Route den Fehler
 *   selbst fängt und ein 500 schicken wollte (`demoAnfrage` merkt sich die Grenze und ersetzt die Antwort).
 * - **Aufrufe je Minute** je Sitzung bzw. Adresse.
 * - **PDF eines zur Zeit:** Docling teilt sich den Speicher mit der Produktion (E3). `pdfNacheinander` reiht die Aufrufe auf,
 *   `pdfBelegt` lässt den Upload eines zweiten PDF gleich abweisen.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db/connection';
import { config } from '../config';

interface Kontext {
  /** Sitzung (users.id des Gastes) oder Adresse; leer = außerhalb einer Anfrage. */
  wer: string;
  /** Gesetzt, sobald diese Anfrage an eine Grenze gestoßen ist. */
  grenze?: string;
}

export const demoKontext = new AsyncLocalStorage<Kontext>();

export class DemoGrenzeErreicht extends Error {
  readonly code = 'demo_grenze';
  constructor(message: string) {
    super(message);
    this.name = 'DemoGrenzeErreicht';
  }
}

function meldeGrenze(text: string): never {
  const k = demoKontext.getStore();
  if (k) k.grenze = text;
  throw new DemoGrenzeErreicht(text);
}

const NAME: Record<'deepl' | 'ki', string> = { deepl: 'Übersetzung (DeepL)', ki: 'KI' };

/**
 * Bucht `zeichen` für `art`, bevor der Aufruf hinausgeht. Überschreitet die Buchung eine Grenze, wird nichts gebucht und
 * `DemoGrenzeErreicht` geworfen.
 */
export async function verbrauche(art: 'deepl' | 'ki', zeichen: number): Promise<void> {
  if (!config.demo.an || !(zeichen > 0)) return;
  const wer = demoKontext.getStore()?.wer ?? '';
  const d = config.demo;
  const grenzen: { wer: string; max: number; text: string }[] = [{
    wer: '',
    max: art === 'deepl' ? d.deeplZeichenTag : d.kiZeichenTag,
    text: `Die Demo hat ihr Tageskontingent für ${NAME[art]} aufgebraucht. Morgen geht es weiter.`,
  }];
  if (wer) {
    grenzen.push({
      wer,
      max: art === 'deepl' ? d.deeplZeichenJeSitzung : d.kiZeichenJeSitzung,
      text: `Du hast dein Tageskontingent für ${NAME[art]} in der Demo aufgebraucht (${art === 'deepl' ? d.deeplZeichenJeSitzung : d.kiZeichenJeSitzung} Zeichen).`,
    });
  }
  const c = await pool.connect();
  let ueber: string | null = null;
  try {
    await c.query('BEGIN');
    for (const g of grenzen) {
      const r = await c.query<{ zeichen: string }>(
        `INSERT INTO demo_verbrauch (tag, art, wer, zeichen) VALUES ((now() AT TIME ZONE 'Europe/Vienna')::date, $1, $2, $3)
         ON CONFLICT (tag, art, wer) DO UPDATE SET zeichen = demo_verbrauch.zeichen + EXCLUDED.zeichen
         RETURNING zeichen`,
        [art, g.wer, zeichen],
      );
      if (Number(r.rows[0].zeichen) > g.max) { ueber = g.text; break; }
    }
    await c.query(ueber ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  if (ueber) meldeGrenze(ueber);
}

// ── PDF eines zur Zeit ─────────────────────────────────────────────────────────────────────────────────────────────────────────

let pdfKette: Promise<unknown> = Promise.resolve();
let pdfLaufend = 0;

/** Ob gerade ein PDF gelesen wird oder eines wartet. Nur in der Demo von Bedeutung. */
export const pdfBelegt = (): boolean => config.demo.an && pdfLaufend > 0;

/** In der Demo nacheinander, sonst unverändert. */
export async function pdfNacheinander<T>(arbeit: () => Promise<T>): Promise<T> {
  if (!config.demo.an) return arbeit();
  pdfLaufend += 1;
  const lauf = pdfKette.then(arbeit, arbeit);
  pdfKette = lauf.catch(() => undefined);
  try {
    return await lauf;
  } finally {
    pdfLaufend -= 1;
  }
}

// ── Anfrage: Kontext, Aufrufe je Minute, Meldung ───────────────────────────────────────────────────────────────────────────────

const aufrufe = new Map<string, { minute: number; n: number }>();

/**
 * Für jede Anfrage in der Demo: Kontext für die Zähler, Aufrufe je Minute, und die Antwort an einer Grenze. Hinter der Sitzung
 * einhängen (sie liefert `wer`).
 */
export function demoAnfrage(req: Request, res: Response, next: NextFunction): void {
  if (!config.demo.an) return next();
  const wer = String(req.session?.userId ?? '') || `ip:${req.ip ?? ''}`;
  const minute = Math.floor(Date.now() / 60000);
  const a = aufrufe.get(wer);
  if (!a || a.minute !== minute) {
    aufrufe.set(wer, { minute, n: 1 });
    if (aufrufe.size > 5000) for (const [k, v] of aufrufe) if (v.minute !== minute) aufrufe.delete(k);
  } else if (++a.n > config.demo.aufrufeJeMinute) {
    res.status(429).json({ error: 'Zu viele Aufrufe in einer Minute. Bitte kurz warten.', code: 'demo_grenze' });
    return;
  }
  const kontext: Kontext = { wer: String(req.session?.userId ?? '') };
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (kontext.grenze && !res.headersSent) {
      res.status(429);
      return json({ error: kontext.grenze, code: 'demo_grenze' });
    }
    return json(body);
  };
  demoKontext.run(kontext, () => next());
}
