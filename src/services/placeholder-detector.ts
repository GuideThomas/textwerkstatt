/**
 * Platzhalter-Detector
 *
 * Erkennt InDesign-Adobe-Latein und klassisches Lorem-Ipsum in extrahierten
 * Quellsegmenten. Loest beim Upload eine Warnung aus, wenn der Setzer den
 * Platzhaltertext vergessen hat zu ersetzen — sonst uebersetzt das Tool
 * pflichtbewusst Pseudo-Latein in Pseudo-Hungarisch (siehe Vorfall 20.05.2026,
 * Datei "Bedienungsanleitung_DE_V2.idml").
 *
 * Heuristik:
 *   1. Curated Token-Liste mit Adobe-Latein-Fingerabdruecken
 *      (Tokens die in echten DE/EN/IT/FR-Texten praktisch nie vorkommen).
 *   2. Klassische Lorem-Ipsum-Phrasen ("Lorem ipsum dolor sit amet", "consectetur").
 *   3. Ein Segment gilt als Platzhalter, wenn >= 2 Tokens matchen ODER eine
 *      klassische Lorem-Ipsum-Phrase enthalten ist.
 *   4. Projekt-Warnung wird ausgeloest, wenn:
 *        - Mindestens 1 Segment mit Lorem-Ipsum-Klassiker, ODER
 *        - >= 3 Segmente verdaechtig, ODER
 *        - Verdaechtige-Quote >= 5% der Segmente UND >= 2 Segmente.
 */

export interface PlaceholderSegmentHit {
  /** Segment-ID (vom jeweiligen Parser vergeben, z. B. `story_u13e_p1`) */
  id: string;
  /** Erste ~120 Zeichen des Segmenttexts zur Anzeige im Frontend */
  preview: string;
  /** Token, die den Hit ausgeloest haben */
  matchedTokens: string[];
}

export interface PlaceholderDetectionResult {
  /** True wenn die Schwelle ueberschritten wurde (Warnung anzeigen) */
  triggered: boolean;
  /** Gesamtzahl gescannter Segmente */
  totalSegments: number;
  /** Anzahl Segmente die als Platzhalter klassifiziert wurden */
  placeholderCount: number;
  /** Quote (0..1) */
  ratio: number;
  /** Bis zu 8 Beispielsegmente fuer die UI */
  samples: PlaceholderSegmentHit[];
  /** Klassisches Lorem-Ipsum nachgewiesen */
  loremIpsumDetected: boolean;
}

/**
 * Adobe-Latein-Fingerabdruck.
 *
 * Diese Tokens stammen aus dem Adobe-Lorem-Ipsum-Generator (InDesign
 * "Platzhaltertext einfuegen"). Sie sind weder echtes Latein noch echte
 * Sprache — und kommen in Produktkatalogen/Bedienungsanleitungen praktisch
 * nie vor. Alle lowercase, Match ist case-insensitive und wortgrenzen-stabil.
 */
const ADOBE_LATIN_TOKENS = new Set<string>([
  'eperitium', 'eperitio', 'ebitatu', 'riature',
  'venisquodi', 'commolupta', 'deliquis', 'moloris',
  'hiliqui', 'volorrovit', 'expernam', 'magnihil', 'sinullabo',
  'ssimilique', 'vendenduci', 'cuptae', 'officte', 'ndelecte', 'dioriamet',
  'intotas', 'magnate', 'mporiossum', 'apientis', 'occaborae',
  'suntiusdae', 'maximinimpor', 'ratibusam', 'earchiliqui',
  'quasped', 'quidunt', 'otatemporro', 'odiatendus',
  'imaximin', 'prehente', 'veroreiur', 'molorpos', 'doluptatur',
  'repudis', 'volupicatus',
  'quissed', 'moluptur', 'nimolorem', 'quiatur',
  'gendige', 'ndusda', 'comnimi', 'voluptatum', 'excese', 'optaeri',
  'buscide', 'parcia', 'velest', 'scitam', 'cumendae', 'moluptat',
  'elenda', 'omnimet', 'teculla', 'voloreces', 'faceraerest',
  'volupta', 'tusdam', 'escieni', 'odipsundenis', 'voloremqui',
  'doloritatur', 'volorpo', 'resciatiam', 'ipsant', 'restotas',
  'poritatinis', 'molute', 'officip', 'saperoritis', 'doluptate',
  'eatectus', 'dolorum', 'experspitem', 'suntis', 'volorero',
  'quaturibus', 'remporem', 'voloribus', 'milita', 'officiet',
  'volorias', 'poreste', 'dessendam', 'volupita', 'endanturia',
  'autatectoria', 'offictem', 'acepratem', 'vendent', 'aliquae',
  'enitam', 'volest', 'nonsequi', 'autector', 'poribus',
  'moluptatur', 'cuptam', 'ommoluptam', 'dipient',
  'eicaepe', 'riberia',
]);

/** Klassische Lorem-Ipsum-Phrasen (Cicero-Original, weit verbreitet) */
const LOREM_IPSUM_PHRASES: RegExp[] = [
  /\blorem\s+ipsum\b/i,
  /\bdolor\s+sit\s+amet\b/i,
  /\bconsectetur\s+adipiscing\s+elit\b/i,
  /\bsed\s+do\s+eiusmod\s+tempor\b/i,
  /\bduis\s+aute\s+irure\s+dolor\b/i,
];

/**
 * Scannt ein einzelnes Textsegment und liefert die matched Tokens zurueck.
 */
function scanSegment(text: string): { tokens: string[]; loremIpsum: boolean } {
  if (!text || text.length < 8) return { tokens: [], loremIpsum: false };

  const lowered = text.toLowerCase();
  const loremIpsum = LOREM_IPSUM_PHRASES.some((re) => re.test(lowered));

  const matched = new Set<string>();
  // Wortgrenzen-stabile Tokenisierung
  const words = lowered.match(/[a-zäöüß]{4,}/gi);
  if (words) {
    for (const w of words) {
      if (ADOBE_LATIN_TOKENS.has(w)) matched.add(w);
    }
  }

  return { tokens: Array.from(matched), loremIpsum };
}

/**
 * Fuehrt den Detector ueber alle Segmente eines Projekts aus.
 *
 * @param segments  Quellsegmente mit `{ id, text }`. Nur `text` wird gescannt;
 *                  `id` wird im Sample-Output mitgefuehrt.
 */
export function detectPlaceholders(
  segments: Array<{ id: string; text: string }>,
): PlaceholderDetectionResult {
  const hits: PlaceholderSegmentHit[] = [];
  let loremIpsumDetected = false;

  for (const seg of segments) {
    const { tokens, loremIpsum } = scanSegment(seg.text);
    if (loremIpsum) loremIpsumDetected = true;

    const isPlaceholder = loremIpsum || tokens.length >= 2;
    if (!isPlaceholder) continue;

    hits.push({
      id: seg.id,
      preview: seg.text.length > 120 ? `${seg.text.slice(0, 120)}…` : seg.text,
      matchedTokens: loremIpsum ? ['lorem-ipsum', ...tokens] : tokens,
    });
  }

  const totalSegments = segments.length;
  const placeholderCount = hits.length;
  const ratio = totalSegments > 0 ? placeholderCount / totalSegments : 0;

  // Trigger-Schwellen:
  //   - Lorem-Ipsum-Klassiker: immer triggern (eindeutig)
  //   - >= 3 verdaechtige Segmente: triggern
  //   - >= 5% UND >= 2 Segmente: triggern (kleine Dokumente schuetzen)
  const triggered =
    loremIpsumDetected ||
    placeholderCount >= 3 ||
    (placeholderCount >= 2 && ratio >= 0.05);

  return {
    triggered,
    totalSegments,
    placeholderCount,
    ratio,
    samples: hits.slice(0, 8),
    loremIpsumDetected,
  };
}
