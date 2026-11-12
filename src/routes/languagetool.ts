import { Router, Request, Response } from 'express';
import { checkText } from '../services/languagetool';
import { loadHouseTerms, findHouseTermMatches } from '../services/house-terms';

const router = Router();

// LanguageTool-Proxy. Frontend ruft NICHT direkt das LT-Backend auf,
// sondern uns — so können wir spaeter Auth/Quota/Logging zentral haengen.
//
// Bei deutschem Text kommen die Treffer der Hausschreibweise dazu
// (optional channel-spezifisch über channelCode). Sie hängen nicht an
// LanguageTool: fällt LT aus, werden sie trotzdem geliefert, samt
// `languagetoolError`, damit die Oberfläche den Ausfall nennen kann.
router.post('/check', async (req: Request, res: Response) => {
  const { text, language, picky, channelCode } = req.body as {
    text?: string;
    language?: string;
    picky?: boolean;
    channelCode?: string | null;
  };

  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'text ist erforderlich' });
    return;
  }
  if (text.length > 50000) {
    res.status(400).json({ error: 'Text darf maximal 50.000 Zeichen lang sein' });
    return;
  }
  if (!language || typeof language !== 'string') {
    res.status(400).json({ error: 'language ist erforderlich (z.B. DE, EN, AUTO)' });
    return;
  }

  let ltResult: Awaited<ReturnType<typeof checkText>> | null = null;
  let ltError: string | null = null;
  try {
    ltResult = await checkText(text, language, { picky: picky === true });
  } catch (err: any) {
    console.error('[LanguageTool] Error:', err.message);
    ltError = err.message || 'LanguageTool nicht erreichbar';
  }

  // Deutsch = explizit gewählt, oder bei AUTO von LT als Deutsch erkannt
  const isGerman =
    language.toUpperCase() === 'DE' ||
    (language.toUpperCase() === 'AUTO' && (ltResult?.language.code || '').toLowerCase().startsWith('de'));

  if (!isGerman) {
    if (ltError) {
      res.status(502).json({ error: ltError });
      return;
    }
    res.json(ltResult);
    return;
  }

  try {
    const channel = typeof channelCode === 'string' && channelCode.trim() ? channelCode.trim().toUpperCase() : null;
    const houseMatches = findHouseTermMatches(text, await loadHouseTerms(channel));
    // Hausschreibweise zuerst: bei gleicher Stelle soll ihr Hinweis sichtbar sein
    const ltMatches = (ltResult?.matches || []).filter(
      (m) => !houseMatches.some((h) => m.offset < h.offset + h.length && h.offset < m.offset + m.length),
    );
    res.json({
      matches: [...houseMatches, ...ltMatches],
      language: ltResult?.language || { code: 'de-DE', name: 'German' },
      houseTermHits: houseMatches.length,
      languagetoolError: ltError,
    });
  } catch (err: any) {
    console.error('[HouseTerms] Error:', err.message);
    if (ltError) {
      res.status(502).json({ error: ltError });
      return;
    }
    res.json({ ...ltResult, houseTermError: 'Hausschreibweise konnte nicht geprüft werden' });
  }
});

export default router;
