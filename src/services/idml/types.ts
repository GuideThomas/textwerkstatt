/**
 * IDML Parser Types — Phase 2
 *
 * Datenstrukturen für die IDML-Verarbeitung:
 * Segment-Extraktion, Content-Mapping, Textbox-Dimensionen
 */

/** Ein extrahiertes Textsegment aus einer IDML Story */
export interface IdmlSegment {
  /** Eindeutige ID: story_<storyId>_p<paraIdx>  */
  id: string;
  /** Kombinierter Text aller Content-Tags im Absatz */
  text: string;
  /** Story-Dateiname (z.B. "Story_u123.xml") */
  storyFile: string;
  /** Story Self-Attribut (z.B. "u123") */
  storySelf: string;
  /** Index des ParagraphStyleRange innerhalb der Story */
  paragraphIndex: number;
  /** Mapping: welcher Textabschnitt zu welchem Content-Tag gehört */
  contentMap: ContentMapping[];
  /** Maximale Zeichenanzahl (aus Frame-Dimensionen, null wenn unbekannt) */
  maxChars: number | null;
  /**
   * True wenn der Text <x id="N"/> Style-Marker enthält (bei Paragraphen mit
   * mehreren CharacterStyleRanges). Muss bei Übersetzung DeepL tag_handling=xml
   * mit ignore_tags=['x'] nutzen, damit die Marker erhalten bleiben.
   */
  hasStyleMarkers?: boolean;
}

/** Mapping eines Textabschnitts zurück auf sein Content-Tag */
export interface ContentMapping {
  /** Start-Offset im kombinierten Text */
  startOffset: number;
  /** End-Offset im kombinierten Text */
  endOffset: number;
  /** Original-Text dieses Content-Tags */
  originalText: string;
  /** Index des CharacterStyleRange */
  charStyleIndex: number;
  /** Index des Content-Tags innerhalb des CharacterStyleRange */
  contentIndex: number;
}

/** Ergebnis des IDML-Entpackens */
export interface UnpackResult {
  /** Temporaerer Ordner mit entpackten Dateien */
  tempDir: string;
  /** Liste der gefundenen Story-Dateien (relative Pfade) */
  storyFiles: string[];
  /** Liste der Spread-Dateien (für Frame-Dimensionen) */
  spreadFiles: string[];
  /** Liste der MasterSpread-Dateien (TextFrames auf Musterseiten) */
  masterSpreadFiles: string[];
  /** designmap.xml Pfad */
  designMapPath: string;
}

/** Frame-Dimensionen aus Spreads */
export interface TextFrameDimension {
  /** Story-ID die dieser Frame referenziert */
  parentStory: string;
  /** Breite in Points */
  width: number;
  /** Höhe in Points */
  height: number;
  /** Geschätzte maximale Zeichen (basierend auf durchschnittlicher Zeichenbreite) */
  estimatedMaxChars: number;
}

/** Ergebnis des vollständigen IDML-Parsings */
export interface IdmlParseResult {
  /** Alle extrahierten Segmente */
  segments: IdmlSegment[];
  /** Frame-Dimensionen pro Story */
  frameDimensions: Map<string, TextFrameDimension>;
  /** Pfad zum entpackten temp-Ordner */
  tempDir: string;
  /** Gefundene Story-Dateien */
  storyFiles: string[];
}

/** Übersetzungs-Zuordnung für den Re-Writer */
export interface TranslationMapping {
  /** Segment-ID */
  segmentId: string;
  /** Übersetzter Text (oder gekürzter Text) */
  translatedText: string;
}
