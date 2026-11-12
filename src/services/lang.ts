/**
 * Sprachcode-Normalisierung fuer Glossar-Lookups.
 *
 * Tschechisch kommt im Stack unter ZWEI Codes an:
 *   - `CZ` — SAP-Sprachcode (langCode 26), den der Artikelanlage-Assistent
 *     ueber die Batch-/Condense-API schickt. Das sind die realen Segmente in
 *     der DB (Stand 27.07.2026: 284 Segmente `target_lang='CZ'`).
 *   - `CS` — ISO-639-1, den die Weboberflaeche in allen Sprach-Dropdowns
 *     anbietet (FileUpload, QuickTranslate, Schreibhilfe, ConsistencyCheck,
 *     ScanUpload, NativeSpeakerManagement).
 *
 * DeepL selbst ist davon nicht betroffen — `toDeepLSourceLang`/`toDeepLTargetLang`
 * mappen beide Codes auf `cs`. Der Glossar-Lookup vergleicht aber exakt gegen
 * `glossaries.target_lang`, d.h. ohne Normalisierung findet ein UI-Job (`CS`)
 * das Glossar `DE→CZ` nie und uebersetzt still ohne Terminologie.
 *
 * Kanonisch ist `CZ` (Entscheidung Thomas 27.07.2026, deckt sich mit den
 * Bestandsdaten). Diese Funktion gehoert an JEDE Stelle, die ein Glossar
 * ueber ein Sprachpaar aufloest oder anlegt.
 */
const GLOSSARY_LANG_ALIASES: Record<string, string> = {
  CS: 'CZ',
};

export function normalizeGlossaryLang(lang: string): string {
  const upper = (lang || '').toUpperCase();
  return GLOSSARY_LANG_ALIASES[upper] || upper;
}
