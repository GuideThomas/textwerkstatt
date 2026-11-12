import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { normalizeGlossaryLang } from '../services/lang';

/**
 * Terminologie-Nachschlag — reine Datenbankauskunft, KEINE Uebersetzung.
 *
 * Zweck: Die haeufigste Frage im Alltag ist nicht „uebersetze diesen Absatz",
 * sondern „wie heisst <Begriff> auf <Sprache>?". Diese Route beantwortet sie
 * aus dem gepflegten Glossar — ohne DeepL, also ohne dass Text das Haus
 * verlaesst und ohne Kosten. Sie ist damit der einzige der drei Chat-Zugaenge,
 * der vollstaendig im Haus bleibt.
 *
 * 🚨 `approved = TRUE` ist Wirkungsvoraussetzung, nicht Kosmetik: Alle
 *    Consumer filtern darauf (Erkenntnis 27.07.2026). Ein unfreigegebener
 *    Eintrag darf hier nicht als geltende Terminologie erscheinen.
 *
 * Sprachcodes laufen ueber `normalizeGlossaryLang` — sonst findet ein Aufruf
 * mit `CS` das Glossar `DE→CZ` nie und antwortet still „kein Eintrag".
 */

const router = Router();

const MAX_TERM_CHARS = 100;
const MAX_RESULTS = 25;

router.get('/', async (req: Request, res: Response) => {
  const rawTerm = typeof req.query.term === 'string' ? req.query.term.trim() : '';
  const rawTarget = typeof req.query.target === 'string' ? req.query.target.trim() : '';
  const rawSource = typeof req.query.source === 'string' ? req.query.source.trim() : 'DE';
  const rawChannel = typeof req.query.channel === 'string' ? req.query.channel.trim() : '';

  if (!rawTerm || !rawTarget) {
    res.status(400).json({ error: 'term und target sind erforderlich' });
    return;
  }
  if (rawTerm.length > MAX_TERM_CHARS) {
    res.status(400).json({ error: `term darf maximal ${MAX_TERM_CHARS} Zeichen lang sein` });
    return;
  }

  const sourceLang = normalizeGlossaryLang(rawSource);
  const targetLang = normalizeGlossaryLang(rawTarget);
  const channelCode = rawChannel ? rawChannel.toUpperCase() : null;

  try {
    const glossary = await pool.query(
      `SELECT id, name FROM glossaries WHERE source_lang = $1 AND target_lang = $2 LIMIT 1`,
      [sourceLang, targetLang],
    );

    if (glossary.rows.length === 0) {
      // Bewusst kein leeres Ergebnis: „kein Glossar" und „Begriff nicht
      // gepflegt" sind zwei verschiedene Aussagen, und nur die erste ist ein
      // Hinweis darauf, dass hier ueberhaupt nichts zu holen ist.
      const available = await pool.query(
        `SELECT DISTINCT target_lang FROM glossaries WHERE source_lang = $1 ORDER BY target_lang`,
        [sourceLang],
      );
      res.status(404).json({
        error: `Kein Glossar fuer ${sourceLang} → ${targetLang}`,
        availableTargets: available.rows.map((r: { target_lang: string }) => r.target_lang),
      });
      return;
    }

    const entries = await pool.query(
      `SELECT ge.source_term,
              ge.target_term,
              ge.context,
              ge.category,
              gec.target_term AS channel_target_term
         FROM glossary_entries ge
         LEFT JOIN glossary_entry_channels gec
                ON gec.entry_id = ge.id AND gec.channel_code = $3
        WHERE ge.glossary_id = $1
          AND ge.approved = TRUE
          AND (LOWER(ge.source_term) = LOWER($2::text)
               OR LOWER(ge.source_term) LIKE LOWER($2::text) || '%'
               OR LOWER($2::text) LIKE LOWER(ge.source_term) || '%')
        ORDER BY (LOWER(ge.source_term) = LOWER($2::text)) DESC, LENGTH(ge.source_term) ASC
        LIMIT ${MAX_RESULTS}`,
      [glossary.rows[0].id, rawTerm, channelCode],
    );

    res.json({
      term: rawTerm,
      sourceLang,
      targetLang,
      channelCode,
      glossary: glossary.rows[0].name,
      results: entries.rows.map((e: any) => ({
        source: e.source_term,
        target: e.channel_target_term || e.target_term,
        // Der Standardwert bleibt sichtbar, wenn ein Channel abweicht — sonst
        // laesst sich nicht erkennen, dass ueberhaupt ein Sonderfall greift.
        standardTarget: e.channel_target_term ? e.target_term : null,
        context: e.context,
        category: e.category,
        exact: e.source_term.toLowerCase() === rawTerm.toLowerCase(),
      })),
    });
  } catch (err: any) {
    console.error('[Terminology] Error:', err.message);
    res.status(500).json({ error: 'Terminologie-Abfrage fehlgeschlagen' });
  }
});

export default router;
