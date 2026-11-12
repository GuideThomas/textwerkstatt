/**
 * Vorschläge zum Glossar ansehen, freigeben, verwerfen (Plan `PLAN-glossar-freigabe.md`, Cockpit #1874).
 *
 *   GET  /:id/vorschlaege                  offene Vorschläge, je mit dem Stand von jetzt (`aktuell`); `?status=entschieden` die letzten
 *   POST /:id/vorschlaege/:vid/freigeben   nur Admins: führt den Vorschlag aus, mit demselben Code wie der direkte Weg
 *   POST /:id/vorschlaege/:vid/verwerfen   nur Admins
 *
 * 🚨 Die Freigabe schreibt unter dem Admin, mit dem Vorschlagenden im Namen (`freigabeBearbeiter`), damit der Verlauf beide nennt.
 * Ablauf: beanspruchen (`in_arbeit`, nur mit der Fassung, die der Admin gesehen hat), wirken, abschließen. Ein zweiter Admin, ein
 * zweiter Klick oder ein Verwerfen dazwischen bekommt 409 (Befund Code-Review 12.11.2026: getrennte Schritte ohne Sperre ließen eine
 * Änderung wirken, die danach als verworfen dastand). Scheitert die Wirkung (Begriff inzwischen vorhanden, Zeile gelöscht, Konflikt
 * beim Umbenennen), wird der Vorschlag zurückgegeben und bleibt offen. Hängt er nach einem Absturz in Arbeit, gilt er nach zehn
 * Minuten wieder als offen.
 */
import { Router, Request, Response } from 'express';
import { requireGlossarRecht } from '../middleware/glossar-recht';
import { bearbeiterAusAnfrage } from '../db/bearbeiter';
import {
  ladeVorschlag,
  listeVorschlaege,
  beanspruche,
  schliesseFreigabe,
  gibZurueck,
  freigabeBearbeiter,
  type VorschlagZeile,
} from '../services/glossar-vorschlaege';
import { legeEintragAn, wendeEintragAn, setzeChannelWert, eintragFelderAus, type Wirkung } from './glossaries';
import { wendeWortlisteAn, setzeGruppenziel } from './wortliste-pflege';

const router = Router();

const text = (w: unknown): string | null => (typeof w === 'string' && w.trim() !== '' ? w.trim() : null);

/** Führt einen offenen Vorschlag aus. Gibt die Wirkung und die Zeile für den Verlauf zurück. */
async function wirke(v: VorschlagZeile, req: Request): Promise<{ w: Wirkung; entryId: string | null }> {
  const wer = freigabeBearbeiter(bearbeiterAusAnfrage(req), v);
  const d = v.daten;
  switch (v.weg) {
    case 'neu': {
      const ziel = text(d.target_term);
      if (!ziel) return { w: { code: 400, body: { error: 'Der Vorschlag hat keine Übersetzung' } }, entryId: null };
      const quelle = v.quelle === 'quickadd' ? 'review-quickadd' : v.quelle === 'glossar' ? 'manual' : 'auto-detected';
      const w = await legeEintragAn(v.glossary_id, {
        sourceTerm: v.source_term, targetTerm: ziel, context: text(d.context), category: text(d.category),
        channelCode: text(d.channel_code), quelle,
      }, wer);
      return { w, entryId: w.code === 201 ? String(w.body.id) : null };
    }
    case 'eintrag': {
      const f = eintragFelderAus(d);
      if ('fehler' in f) return { w: { code: 400, body: { error: f.fehler } }, entryId: v.entry_id };
      return { w: await wendeEintragAn(v.glossary_id, v.entry_id as string, f, wer, { freigeben: true }), entryId: v.entry_id };
    }
    case 'channel':
      return { w: await setzeChannelWert(v.glossary_id, v.entry_id as string, v.schluessel, text(d.target_term), wer), entryId: v.entry_id };
    case 'wortliste':
      return { w: await wendeWortlisteAn(v.glossary_id, v.entry_id as string, d, wer), entryId: v.entry_id };
    case 'gruppe': {
      const genus = typeof d.genus === 'string' && d.genus !== '' ? d.genus : null;
      const ziel = text(d.target_term);
      const w = await setzeGruppenziel(v.glossary_id, v.entry_id as string, Number(v.schluessel), ziel, genus, wer);
      // Entfernen, wo schon nichts mehr steht: Der gewünschte Zustand ist erreicht, wie beim Channel-Wert.
      if (ziel === null && w.code === 404 && w.body.error === 'Gruppenziel nicht gefunden') {
        return { w: { code: 200, body: { deleted: false } }, entryId: v.entry_id };
      }
      return { w, entryId: v.entry_id };
    }
  }
}

router.get('/:id/vorschlaege', async (req: Request<{ id: string }>, res: Response) => {
  const status = req.query.status === 'entschieden' ? 'entschieden' : 'offen';
  try {
    res.json(await listeVorschlaege(req.params.id, status));
  } catch (err) {
    console.error('Error listing glossary proposals:', err);
    res.status(500).json({ error: 'Vorschläge konnten nicht geladen werden' });
  }
});

/** Die Fassung, die der Admin gesehen hat. Ohne Angabe gilt die jetzige; die Oberfläche schickt sie immer mit. */
function gesehen(req: Request): number | null {
  const f = (req.body ?? {}).fassung;
  return typeof f === 'number' && Number.isInteger(f) && f > 0 ? f : null;
}

/** Warum ein Vorschlag nicht beansprucht werden konnte: es gibt ihn nicht, er ist entschieden, in Arbeit oder ergänzt worden. */
async function nichtBeansprucht(req: Request<{ id: string; vid: string }>, res: Response) {
  const v = await ladeVorschlag(req.params.id, req.params.vid);
  if (!v) return res.status(404).json({ error: 'Vorschlag nicht gefunden' });
  if (v.status === 'offen') {
    return res.status(409).json({ error: 'Der Vorschlag wurde inzwischen ergänzt, bitte neu ansehen', fassung: v.fassung });
  }
  return res.status(409).json({ error: 'Der Vorschlag ist schon entschieden', status: v.status });
}

router.post('/:id/vorschlaege/:vid/freigeben', requireGlossarRecht, async (req: Request<{ id: string; vid: string }>, res: Response) => {
  try {
    const admin = bearbeiterAusAnfrage(req);
    // Erst beanspruchen, dann wirken: Ein zweiter Admin oder ein zweiter Klick bekommt 409, statt doppelt zu wirken. Gewirkt wird
    // genau die beanspruchte Fassung, nicht eine, die der Vorschlagende danach ergänzt hat.
    const v = await beanspruche(req.params.id, req.params.vid, gesehen(req), 'in_arbeit', admin);
    if (!v) return nichtBeansprucht(req, res);
    let ergebnis: { w: Wirkung; entryId: string | null };
    try {
      ergebnis = await wirke(v, req);
    } catch (err) {
      await gibZurueck(v);
      throw err;
    }
    if (ergebnis.w.code >= 400) {
      await gibZurueck(v);
      return res.status(ergebnis.w.code).json({ ...ergebnis.w.body, vorschlag_offen: true });
    }
    await schliesseFreigabe(v, admin, ergebnis.entryId);
    res.json({ freigegeben: true, entry_id: ergebnis.entryId, ergebnis: ergebnis.w.body });
  } catch (err) {
    console.error('Error approving glossary proposal:', err);
    res.status(500).json({ error: 'Freigabe fehlgeschlagen' });
  }
});

router.post('/:id/vorschlaege/:vid/verwerfen', requireGlossarRecht, async (req: Request<{ id: string; vid: string }>, res: Response) => {
  try {
    const v = await beanspruche(req.params.id, req.params.vid, gesehen(req), 'verworfen', bearbeiterAusAnfrage(req));
    if (!v) return nichtBeansprucht(req, res);
    res.json({ verworfen: true });
  } catch (err) {
    console.error('Error rejecting glossary proposal:', err);
    res.status(500).json({ error: 'Verwerfen fehlgeschlagen' });
  }
});

export default router;
