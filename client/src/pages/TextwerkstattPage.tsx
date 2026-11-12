import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import i18n from '../i18n';
import PageHeader from '../components/PageHeader';
import SubTabs from '../components/SubTabs';
import HouseTermManager from '../components/HouseTermManager';
import PruefenErgebnis, { isSafeMatch, type LtMatch, type PruefStatistik } from '../components/textwerkstatt/PruefenErgebnis';
import AlternativenDialog from '../components/textwerkstatt/AlternativenDialog';
import GlossarEintragDialog, { type GlossarEntwurf } from '../components/textwerkstatt/GlossarEintragDialog';
import PseudonymVorschau, { type Masken, type Vorschau } from '../components/textwerkstatt/PseudonymVorschau';
import OptimierenErgebnis, { type OptimierAntwort } from '../components/textwerkstatt/OptimierenErgebnis';
import { wortSucher } from '../components/textwerkstatt/wortDiff';
import KiBudgetHinweis from '../components/KiBudgetHinweis';
import { einstellungen } from '../einstellungen';
import { kiFetch, useKiStatus } from '../hooks/useKiStatus';

/**
 * Textwerkstatt (PLAN-textwerkstatt.md, Phase 1, 10.11.2026): Schnellübersetzung und
 * Schreibhilfe auf einer Seite. Ein Eingabefeld, die Schritte einzeln wählbar:
 *   Prüfen      LanguageTool + Hausschreibweise je Channel — wie die frühere Schreibhilfe
 *   Optimieren  KI lokal oder in der Cloud, Art wählbar, harte Prüfung danach (Phase 4,
 *               11.11.2026) — nur für deutschen Text
 *   Übersetzen  DeepL mit Glossar, Channel, Anrede, Markup — wie die frühere Schnellübersetzung
 * Die Nummern der Schritte zählen aus der Liste, nicht fest: Bei fremdsprachigem Text
 * fällt „Optimieren“ weg, aus 3 wird 2.
 *
 * Die Routen von Prüfen und Übersetzen bleiben unverändert (Grundsatz G6):
 * `/api/languagetool/check`, `/api/quick-translate` samt `/alternatives`, `/word-order`,
 * `/formality`, `/api/glossaries/quickadd`. Optimieren ruft `/api/textwerkstatt/optimieren`;
 * für die Cloud schickt es nur die Kennung der Vorschau, nie den Text (G3).
 */

// BCP-47-Locale für die Spracheingabe (Web Speech API) je Textsprache
const SPEECH_LOCALES: Record<string, string> = {
  DE: 'de-DE', EN: 'en-US', IT: 'it-IT', FR: 'fr-FR', ES: 'es-ES',
  HU: 'hu-HU', PL: 'pl-PL', CS: 'cs-CZ', SK: 'sk-SK', SL: 'sl-SI',
};

const isSpeechRecognitionSupported = () =>
  typeof window !== 'undefined' &&
  ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

/**
 * Anredestufe: sprachneutrale Beschriftung PLUS das Pronomen der GERADE GEWÄHLTEN
 * Zielsprache. „Formell“ allein setzt voraus, dass man weiß, was das in der Zielsprache
 * heißt — das Pronomen zeigt es. Belegt für PL am 14.08.2026: `more` liefert
 * „Czy mógłby Pan/Pani …“, `less` „Czy mógłbyś …“.
 */
const FORMALITY_PRONOUNS: Record<string, { more: string; less: string }> = {
  DE: { more: 'Sie', less: 'du' },
  IT: { more: 'Lei', less: 'tu' },
  FR: { more: 'vous', less: 'tu' },
  ES: { more: 'usted', less: 'tú' },
  NL: { more: 'u', less: 'je' },
  PL: { more: 'Pan/Pani', less: 'ty' },
};

type FormalityChoice = 'default' | 'more' | 'less';
type TranslateMode = 'text' | 'xml' | 'html';
type Schritt = 'pruefen' | 'optimieren' | 'uebersetzen';

const SCHRITTE: readonly Schritt[] = ['pruefen', 'optimieren', 'uebersetzen'];
// Optimiert wird nur deutscher Text (Entscheid Thomas 10.11.2026, Plan §0); „Automatisch“ zählt nicht als Deutsch.
const schritteFuer = (sprache: string): readonly Schritt[] =>
  sprache === 'DE' ? SCHRITTE : SCHRITTE.filter((s) => s !== 'optimieren');

interface OptimierArtKurz {
  id: string;
  name: string;
  beschreibung: string;
  anrede: 'beibehalten' | 'du' | 'sie';
  zielzeichen: boolean;
}

/** Stilprofil für die Auswahl (Phase 5, #1841). `cloud`: darf in die Cloud; entscheidet der Server beim Lauf noch einmal. */
interface StilKurz {
  id: string;
  name: string;
  channelCode: string | null;
  fassung: number;
  beschreibung: string;
  beispiele: string;
  cloud: boolean;
}

// Sprachen des Textes. „Automatisch“ kennt nur LanguageTool; DeepL braucht die Sprache.
const SPRACHEN = ['DE', 'EN', 'IT', 'FR', 'ES', 'HU', 'PL', 'CS', 'SK', 'SL'] as const;
const AUTO = 'AUTO';

const SCHRITT_KEY = 'tt-textwerkstatt-schritt';

function gemerkterSchritt(): Schritt {
  try {
    const s = localStorage.getItem(SCHRITT_KEY);
    if (s && (SCHRITTE as readonly string[]).includes(s)) return s as Schritt;
  } catch { /* Speicher gesperrt (Privatmodus) — dann eben die Vorgabe */ }
  return 'pruefen';
}

interface GlossaryHit {
  source: string;
  target: string;
  start: number;
  end: number;
  channel?: string | null;
}

interface Channel {
  code: string;
  name: string;
}

interface TranslateResult {
  translatedText: string;
  glossaryUsed: string | null;
  glossaryHits?: GlossaryHit[];
  channelCode?: string | null;
  charCount: number;
  mode?: TranslateMode;
  /** Tatsächlich angewandte Anredestufe — `applied: null` heißt: keine. */
  formality?: { requested: FormalityChoice; applied: 'more' | 'less' | null; supported: boolean };
  /** Nur bei Deutsch → Deutsch: Channel-Fassung statt Übersetzung. */
  channelFassung?: {
    begriffe: number;
    eigene: number;
    stellen: number;
    sprachmodell: number;
    regel: number;
    pruefen: string[];
  };
}

function renderWithHighlights(
  text: string,
  hits: GlossaryHit[],
  onHitClick?: (hit: GlossaryHit) => void,
  fassung = false,
) {
  if (!hits || hits.length === 0) return text;
  const sorted = [...hits].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const h of sorted) {
    if (h.start < cursor) continue;
    if (h.start > cursor) parts.push(text.slice(cursor, h.start));
    const isChannel = !!h.channel;
    const style = isChannel
      ? { backgroundColor: 'var(--pal-treffer-channel-grund)', color: 'var(--pal-treffer-channel-text)' }
      : { backgroundColor: 'var(--pal-treffer-glossar-grund)', color: 'var(--pal-treffer-glossar-text)' };
    const tooltip = fassung
      ? i18n.t('quick:highlight.fassungTooltip', { channel: h.channel, source: h.source, target: h.target })
      : isChannel
      ? i18n.t('quick:highlight.channelTooltip', { channel: h.channel, source: h.source, target: h.target })
      : i18n.t('quick:highlight.glossaryTooltip', { source: h.source, target: h.target });
    parts.push(
      <mark
        key={`${h.start}-${h.end}`}
        title={tooltip}
        onClick={onHitClick ? () => onHitClick(h) : undefined}
        className={`font-semibold rounded px-0.5 ${onHitClick ? 'cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-primary-400' : ''}`}
        style={style}
      >
        {text.slice(h.start, h.end)}
      </mark>,
    );
    cursor = h.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** „Modus:“ → „Modus“: Die Beschriftungen stammen aus der früheren Schnellübersetzung, wo sie links neben dem Feld standen. */
const ohneDoppelpunkt = (s: string) => s.replace(/\s*:\s*$/, '');

const segmentCls = (active: boolean) =>
  `text-xs px-3 py-1 rounded-[4px] transition-colors ${
    active ? 'bg-primary-600 text-white font-semibold' : 'text-gray-700 hover:bg-gray-100'
  }`;

export default function TextwerkstattPage() {
  const { t } = useTranslation('textwerkstatt');
  const { t: tq } = useTranslation('quick');
  const { t: tw } = useTranslation('writing');
  // Sprachnamen stehen in `writing` (dort auch „Automatisch“)
  const langName = (code: string) =>
    code === AUTO || (SPRACHEN as readonly string[]).includes(code) ? tw(`languages.${code}`) : code;

  const [view, setView] = useState<'werkstatt' | 'terms'>('werkstatt');
  const [gewaehlterSchritt, setSchritt] = useState<Schritt>(gemerkterSchritt);

  // ── Gemeinsam für alle Schritte ─────────────────────────────────────────
  const [text, setText] = useState('');
  const [sourceLang, setSourceLang] = useState('DE');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelCode, setChannelCode] = useState('');
  // Der gemerkte Schritt bleibt gespeichert; gilt er für diese Sprache nicht, zeigt die Seite „Prüfen“.
  const schritte = schritteFuer(sourceLang);
  const schritt: Schritt = schritte.includes(gewaehlterSchritt) ? gewaehlterSchritt : 'pruefen';

  // ── Prüfen ──────────────────────────────────────────────────────────────
  const [picky, setPicky] = useState(false);
  const [matches, setMatches] = useState<LtMatch[]>([]);
  const [stats, setStats] = useState<PruefStatistik | null>(null);
  const [activeMatchIdx, setActiveMatchIdx] = useState<number | null>(null);
  const [checkLoading, setCheckLoading] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [ltWarning, setLtWarning] = useState<string | null>(null);
  // Bei „Automatisch“: die Sprache, die LanguageTool erkannt hat (nur wenn DeepL sie kennt).
  const [erkannteSprache, setErkannteSprache] = useState<string | null>(null);
  // Jede Änderung zählt hoch; eine Antwort zu einem älteren Stand wird verworfen.
  const pruefLauf = useRef(0);

  // ── Übersetzen ──────────────────────────────────────────────────────────
  const [targetLang, setTargetLang] = useState('EN');
  const [mode, setMode] = useState<TranslateMode>('text');
  // Neutral-Modus: keine Glossar-/Channel-Logik, rohe DeepL-Übersetzung
  const [useGlossary, setUseGlossary] = useState(true);
  // Anredestufe. Vorgabe 'default' sendet KEINEN Parameter — wer sie nicht anfasst, merkt nichts.
  const [formality, setFormality] = useState<FormalityChoice>('default');
  // Welche Zielsprachen kennen eine Anredestufe? Der Server holt die Liste bei DeepL.
  const [formalityLangs, setFormalityLangs] = useState<string[]>([]);
  const [result, setResult] = useState<TranslateResult | null>(null);
  // Der Text, zu dem `result` gehört — weicht der Text ab, ist die Übersetzung veraltet.
  const [uebersetzterText, setUebersetzterText] = useState('');
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const uebersetzLauf = useRef(0);

  // ── Optimieren ──────────────────────────────────────────────────────────
  const { status: kiStatus, laden: kiLaden } = useKiStatus();
  const [arten, setArten] = useState<OptimierArtKurz[] | null>(null);
  const [optArt, setOptArt] = useState('');
  const [stilprofile, setStilprofile] = useState<StilKurz[]>([]);
  // Ohne Profil ist die Vorgabe; ein Profil wählt nur der Nutzer selbst.
  const [optStil, setOptStil] = useState('');
  // Vorgabe ist immer ein lokaler Weg; die Cloud nur auf ausdrückliche Wahl, nie gemerkt (Plan §0, „ein vergessener
  // Schalter darf nicht in die Cloud führen“).
  const [optWeg, setOptWeg] = useState('');
  const [zielzeichen, setZielzeichen] = useState('');
  const [vorschau, setVorschau] = useState<Vorschau | null>(null);
  // Masken der Vorschau leben hier, nicht in der Komponente: Sonst gingen verdeckte Wörter bei jeder Textänderung verloren,
  // auch bei der Übernahme eines Ergebnisses, und ein zweiter Lauf schickte sie im Klartext (Review M1).
  const [masken, setMasken] = useState<Masken>({ verdecken: [], aufdecken: [] });
  const [maskenWeg, setMaskenWeg] = useState<string[]>([]);
  const maskenRef = useRef(masken);
  maskenRef.current = masken;
  // Der Text, den „Übernehmen“ gesetzt hat. Nur wenn der Text genau dieser ist, bleiben Aufdeckungen stehen; an den Text
  // gebunden, nicht als Ja/Nein, sonst hielte eine Übernahme ohne Änderung die Markierung bis zur nächsten Eingabe.
  const ausUebernahme = useRef<string | null>(null);
  const [optErgebnis, setOptErgebnis] = useState<OptimierAntwort | null>(null);
  const [optLaeuft, setOptLaeuft] = useState(false);
  const [optFehler, setOptFehler] = useState<string | null>(null);
  const [optUebernommen, setOptUebernommen] = useState(false);
  const optimierLauf = useRef(0);

  // ── Alternativen, Glossareintrag ────────────────────────────────────────
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [sourceSelection, setSourceSelection] = useState('');
  const [altAnfrage, setAltAnfrage] = useState<{ span: string | null } | null>(null);
  const [glossarEntwurf, setGlossarEntwurf] = useState<GlossarEntwurf | null>(null);

  // ── Datei, Spracheingabe ────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [speechSupported] = useState<boolean>(isSpeechRecognitionSupported);
  const recognitionRef = useRef<any>(null);
  // Die Spracheingabe schreibt in den AKTUELLEN Text, nicht in eine Kopie vom Start —
  // sonst gingen Tippen, Korrekturen oder eine geladene Datei während des Diktats verloren.
  const textRef = useRef(text);
  textRef.current = text;
  // Der noch vorläufige Teil des Diktats am Ende des Textes; das nächste Ergebnis ersetzt ihn.
  const interimRef = useRef('');

  const isAuto = sourceLang === AUTO;
  // Deutsch → Deutsch: der Text wird in die Fassung des Channels umgeschrieben.
  const deToDe = sourceLang === 'DE' && targetLang === 'DE';
  // Hausschreibweise prüft der Server nur bei deutschem Text (AUTO: wenn LanguageTool Deutsch erkennt).
  const houseTermsApply = sourceLang === 'DE' || isAuto;
  const formalitySupported = formalityLangs.includes(targetLang.toUpperCase().split('-')[0]);

  useEffect(() => {
    fetch('/api/glossaries/channels')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setChannels(Array.isArray(data) ? data : []))
      .catch(() => setChannels([]));
    fetch('/api/quick-translate/formality')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => Array.isArray(d?.languages) && setFormalityLangs(d.languages))
      .catch(() => {});
  }, []);

  // Zielsprache ohne Anredestufe setzt die Wahl zurück — sonst behauptete die Oberfläche
  // „Formell“, während serverseitig nichts hinausgeht.
  useEffect(() => {
    if (!formalitySupported && formality !== 'default') setFormality('default');
  }, [formalitySupported, formality]);

  // Arten der Optimierung: einmal laden, die erste ist die Vorgabe.
  useEffect(() => {
    kiFetch<OptimierArtKurz[]>('/arten')
      .then((r) => {
        const liste = r.ok && Array.isArray(r.body) ? r.body : [];
        setArten(liste);
        setOptArt((a) => (a && liste.some((x) => x.id === a) ? a : liste[0]?.id ?? ''));
      })
      .catch(() => setArten([]));
  }, []);

  // Stilprofile: einmal laden. Gibt es keine, fehlt die Auswahl.
  useEffect(() => {
    kiFetch<StilKurz[]>('/stilprofile')
      .then((r) => setStilprofile(r.ok && Array.isArray(r.body) ? r.body : []))
      .catch(() => setStilprofile([]));
  }, []);

  // KI-Wege: Vorgabe ist der erste verfügbare lokale Weg. Einen Cloud-Weg wählt nur der Nutzer selbst.
  useEffect(() => {
    const wege = kiStatus?.wege ?? [];
    if (optWeg && wege.some((w) => w.id === optWeg)) return;
    const lokal = wege.find((w) => w.art === 'lokal' && w.verfuegbar) ?? wege.find((w) => w.art === 'lokal');
    if (lokal) setOptWeg(lokal.id);
  }, [kiStatus, optWeg]);
  const kiWege = kiStatus?.wege ?? [];
  const gewaehlterWeg = kiWege.find((w) => w.id === optWeg) ?? null;
  const istCloud = gewaehlterWeg?.art === 'cloud';
  const artInfo = arten?.find((a) => a.id === optArt) ?? null;
  const stilInfo = stilprofile.find((p) => p.id === optStil) ?? null;
  // Ohne angezeigte Vorschau gibt es keine gültige: Eine alte Kennung darf beim Zurückwechseln nicht kurz sendbar sein.
  useEffect(() => {
    if (!istCloud || schritt !== 'optimieren') setVorschau(null);
  }, [istCloud, schritt]);
  // Bei jeder Textänderung: Eine verdeckte Maske bleibt, solange ihr Wort als ganzes Wort im Text steht (dieselbe Regel wie
  // am Server). Eine Aufdeckung bleibt nur bei der Übernahme eines Ergebnisses; sonst gälte die Entscheidung für Mail A auch
  // für eine eingefügte Mail B, und der Weg öffnete sich still (Review M1-Rest). Was wegfällt, wird gemeldet.
  useEffect(() => {
    const m = maskenRef.current;
    const uebernahme = ausUebernahme.current === text;
    ausUebernahme.current = null;
    if (m.verdecken.length === 0 && m.aufdecken.length === 0) return;
    const hat = wortSucher(text);
    const verdecken = m.verdecken.filter(hat);
    const aufdecken = uebernahme ? m.aufdecken.filter(hat) : [];
    const weg = [...m.verdecken.filter((w) => !verdecken.includes(w)), ...m.aufdecken.filter((w) => !aufdecken.includes(w))];
    if (weg.length === 0) return;
    setMasken({ verdecken, aufdecken });
    setMaskenWeg((alt) => [...new Set([...alt, ...weg])]);
  }, [text]);

  const waehleSchritt = (s: Schritt) => {
    setSchritt(s);
    try { localStorage.setItem(SCHRITT_KEY, s); } catch { /* Privatmodus — egal */ }
  };

  /** Treffer verwerfen — auch die einer Prüfung, deren Antwort noch unterwegs ist. */
  const verwirfPruefung = () => {
    pruefLauf.current += 1;
    setMatches([]);
    setStats(null);
    setActiveMatchIdx(null);
    setCheckLoading(false);
  };

  /** Übersetzung verwerfen, wenn sich eine Einstellung ändert — auch eine, die noch lädt. */
  const verwirfUebersetzung = () => {
    uebersetzLauf.current += 1;
    setResult(null);
    setTranslating(false);
  };

  /**
   * Optimierung verwerfen, wenn sich eine Einstellung ändert, gegen die geprüft wurde (Channel, Sprache) — auch eine, die
   * noch läuft. Eine Textänderung verwirft sie nicht: Dann steht das Ergebnis da, ist aber als veraltet gesperrt, wie die
   * Übersetzung.
   */
  const verwirfOptimierung = () => {
    optimierLauf.current += 1;
    setOptErgebnis(null);
    setOptFehler(null);
    setOptLaeuft(false);
  };

  /** Jede Änderung am Text macht die Treffer ungültig — ihre Stellen stimmen nicht mehr. */
  const setzeText = (next: string) => {
    textRef.current = next;
    setText(next);
    verwirfPruefung();
    setFileError(null);
    setOptUebernommen(false);
  };

  const aendereSprache = (lang: string) => {
    abbrechenAufnahme();
    setSourceLang(lang);
    setErkannteSprache(null);
    verwirfUebersetzung();
    verwirfPruefung();
    verwirfOptimierung();
  };

  const channelSetzen = (code: string) => {
    setChannelCode(code);
    verwirfUebersetzung();
    verwirfPruefung();
    verwirfOptimierung();
  };
  const aendereChannel = (code: string) => {
    // Ein Profil mit Channel gilt nur in seinem Channel (der Server lehnt sonst ab).
    if (stilInfo?.channelCode && stilInfo.channelCode !== code) setOptStil('');
    channelSetzen(code);
  };

  /** Ein Profil mit Channel stellt den Channel mit um: Gegen dessen Hausschreibweise wird geprüft, danach läuft die Channel-Fassung. */
  const waehleStil = (id: string) => {
    setOptStil(id);
    // Ein Ergebnis gehört zum Profil, mit dem es entstand (Review N10).
    verwirfOptimierung();
    const p = stilprofile.find((x) => x.id === id);
    if (p?.channelCode && p.channelCode !== channelCode) channelSetzen(p.channelCode);
  };

  const waehleAnsicht = (v: 'werkstatt' | 'terms') => {
    // Ein Diktat liefe im Unterreiter unsichtbar weiter, ohne Stopp-Knopf.
    if (v === 'terms') abbrechenAufnahme();
    setView(v);
  };

  // ── Prüfen ──────────────────────────────────────────────────────────────
  const handleCheck = useCallback(async () => {
    if (!text.trim()) return;
    const lauf = ++pruefLauf.current;
    setCheckLoading(true);
    setCheckError(null);
    setLtWarning(null);
    setFileError(null);
    try {
      const res = await fetch('/api/languagetool/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: sourceLang, picky, channelCode: channelCode || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || tw('errors.http', { status: res.status }));
      }
      const data = await res.json();
      // Hat sich der Text inzwischen geändert, gehören die Stellen zum alten Stand.
      if (lauf !== pruefLauf.current) return;
      const ms: LtMatch[] = Array.isArray(data.matches) ? data.matches : [];
      setMatches(ms);
      setActiveMatchIdx(null);
      setStats({ checked: text.length, found: ms.length, houseTerms: data.houseTermHits || 0 });
      if (sourceLang === AUTO) {
        const code = String(data.language?.code || '').slice(0, 2).toUpperCase();
        setErkannteSprache((SPRACHEN as readonly string[]).includes(code) ? code : null);
      }
      // Fällt LanguageTool aus, prüft der Server bei deutschem Text trotzdem die
      // Hausschreibweise — das muss sichtbar sein, sonst hält man den Text für geprüft.
      if (data.languagetoolError) {
        setLtWarning(tw('errors.ltUnreachableHouseOnly', { error: data.languagetoolError }));
      } else if (data.houseTermError) {
        setLtWarning(data.houseTermError);
      }
    } catch (err: any) {
      if (lauf === pruefLauf.current) setCheckError(err.message || tw('errors.ltUnreachable'));
    } finally {
      if (lauf === pruefLauf.current) setCheckLoading(false);
    }
  }, [text, sourceLang, picky, channelCode, tw]);

  const ueberlappt = (a: LtMatch, b: LtMatch) =>
    a.offset < b.offset + b.length && b.offset < a.offset + a.length;

  const applyReplacement = useCallback((idx: number, replacement: string) => {
    const m = matches[idx];
    if (!m) return;
    const next = text.slice(0, m.offset) + replacement + text.slice(m.offset + m.length);
    textRef.current = next;
    setText(next);
    // Die folgenden Treffer rücken um die Längendifferenz; überlappende passen nicht mehr.
    const delta = replacement.length - m.length;
    setMatches((prev) =>
      prev
        .filter((mm, i) => i !== idx && !ueberlappt(mm, m))
        .map((mm) => (mm.offset > m.offset ? { ...mm, offset: mm.offset + delta } : mm)),
    );
    setActiveMatchIdx(null);
    // Eine Prüfung, die noch läuft, gilt dem Text vor dieser Korrektur.
    pruefLauf.current += 1;
    setCheckLoading(false);
  }, [matches, text]);

  const dismissMatch = useCallback((idx: number) => {
    setMatches((prev) => prev.filter((_, i) => i !== idx));
    setActiveMatchIdx(null);
  }, []);

  // Eindeutige Vorschläge für Tippfehler, Typografie und Satzzeichen gesammelt übernehmen.
  // Im Modus XML/HTML gesperrt: dort prüft LanguageTool auch das Markup, eine „sichere“
  // Typografie-Korrektur träfe sonst Tags und Attribute.
  const safeGesperrt = mode !== 'text';
  const acceptAllSafe = () => {
    if (safeGesperrt) return;
    // Überlappende sichere Treffer nur einmal anwenden, sonst zerschneidet der zweite den ersten.
    const safe: LtMatch[] = [];
    for (const m of matches.filter(isSafeMatch).sort((a, b) => a.offset - b.offset)) {
      if (!safe.some((s) => ueberlappt(s, m))) safe.push(m);
    }
    if (safe.length === 0) return;
    let next = text;
    for (const m of [...safe].reverse()) {
      next = next.slice(0, m.offset) + m.replacements[0].value + next.slice(m.offset + m.length);
    }
    textRef.current = next;
    setText(next);
    // Die übrigen Treffer rücken um die Längendifferenz aller Korrekturen davor
    // (bis 10.11.2026 blieben sie stehen und zeigten danach auf falsche Zeichen).
    setMatches(
      matches
        .filter((m) => !isSafeMatch(m) && !safe.some((s) => ueberlappt(s, m)))
        .map((m) => {
          const delta = safe
            .filter((s) => s.offset < m.offset)
            .reduce((d, s) => d + s.replacements[0].value.length - s.length, 0);
          return delta ? { ...m, offset: m.offset + delta } : m;
        }),
    );
    setActiveMatchIdx(null);
    pruefLauf.current += 1;
    setCheckLoading(false);
  };

  // ── Übersetzen ──────────────────────────────────────────────────────────
  const translateDisabled =
    translating || !text.trim() || isAuto || (sourceLang === targetLang && !(deToDe && channelCode));

  const handleTranslate = async () => {
    if (translateDisabled) return;
    const lauf = ++uebersetzLauf.current;
    const quelle = text.trim();
    setTranslating(true);
    setTranslateError(null);
    setFileError(null);
    setResult(null);
    try {
      const res = await fetch('/api/quick-translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: quelle,
          sourceLang,
          targetLang,
          mode,
          channelCode: useGlossary || deToDe ? (channelCode || null) : null,
          useGlossary,
          formality,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || tq('errors.http', { status: res.status }));
      }
      const data = await res.json();
      // Wurde inzwischen Sprache, Channel, Modus, Glossar oder Anrede geändert, gehört die
      // Antwort zu den alten Einstellungen — ein Glossartreffer speicherte sonst das falsche Paar.
      if (lauf !== uebersetzLauf.current) return;
      setResult(data);
      setUebersetzterText(quelle);
    } catch (err: any) {
      if (lauf === uebersetzLauf.current) setTranslateError(err.message || tq('errors.translateFailed'));
    } finally {
      if (lauf === uebersetzLauf.current) setTranslating(false);
    }
  };

  // Nach einer Korrektur im Schritt Prüfen steht sonst die Übersetzung des alten Textes da.
  const uebersetzungVeraltet = !!result && text.trim() !== uebersetzterText;

  const handleSwapLanguages = () => {
    if (isAuto) return;
    abbrechenAufnahme();
    const neu = result?.translatedText;
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
    setErkannteSprache(null);
    verwirfUebersetzung();
    verwirfPruefung();
    verwirfOptimierung();
    if (neu !== undefined) {
      textRef.current = neu;
      setText(neu);
    }
  };

  /** Nach dem Prüfen mit „Automatisch“: die erkannte Sprache übernehmen, damit DeepL sie bekommt. */
  const uebernimmErkannteSprache = () => {
    if (!isAuto || !erkannteSprache) return;
    // Die Treffer bleiben gültig, der Text ist derselbe.
    setSourceLang(erkannteSprache);
    setErkannteSprache(null);
    verwirfUebersetzung();
  };

  const handleCopyResult = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.translatedText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSourceSelect = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    setSourceSelection(end > start ? ta.value.slice(start, end).trim() : '');
  };

  const openAlternatives = (span: string | null) => {
    if (!text.trim()) return;
    // Erst ab zwei Zeichen ist eine Markierung eine Phrase, sonst gilt der ganze Text.
    setAltAnfrage({ span: span && span.length >= 2 ? span : null });
  };

  // Markieren im Ergebnis löst die Alternativen aus, damit man nicht zum Knopf muss.
  const handleResultMouseUp = () => {
    // Nur im Modus Text — sonst ginge Markup als Fließtext an die Alternativen.
    if (!result || mode !== 'text') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length < 2) return;
    openAlternatives(sourceSelection || null);
  };

  const applyAlternative = (alt: string) => {
    if (altAnfrage?.span || !result) {
      // Bei einer Phrase kennen wir ihre Stelle im Ergebnis nicht (kein Alignment) — Zwischenablage.
      navigator.clipboard.writeText(alt).catch(() => {});
    } else {
      // Ganzer Text: Ergebnis ersetzen, die Glossar-Markierungen gelten dann nicht mehr.
      setResult({ ...result, translatedText: alt, glossaryHits: [] });
    }
    setAltAnfrage(null);
  };

  // ── Optimieren ──────────────────────────────────────────────────────────
  // Fehlercodes kommen aus drei Bereichen des Servers (Optimieren, KI-Weg, Pseudonymisierung); die Texte stehen je
  // Namespace. Unbekannter Code: die Meldung des Servers.
  const fehlerText = (b: { error?: string; code?: string }, status: number) => {
    // Bei ungültiger Eingabe sagt die Meldung des Servers den Grund („Zielzahl: 20 bis 10000“), der allgemeine Text nicht (Review N9).
    if (b.code === 'EINGABE' && b.error) return b.error;
    if (b.code) {
      for (const k of [`textwerkstatt:optimieren.fehler.${b.code}`, `ki:fehler.${b.code}`, `pseudonym:fehler.${b.code}`]) {
        if (i18n.exists(k)) return i18n.t(k);
      }
    }
    return b.error || tq('errors.http', { status });
  };

  const zielzeichenWert = artInfo?.zielzeichen && zielzeichen.trim() ? Number(zielzeichen) : null;
  const zielzeichenUngueltig = zielzeichenWert !== null && (!Number.isInteger(zielzeichenWert) || zielzeichenWert < 20 || zielzeichenWert > 10_000);
  const optimierGrund: string | null =
    !text.trim() ? null
      : text.length > 10_000 ? t('optimieren.zuLang')
      : arten && arten.length === 0 ? t('optimieren.keineArten')
      : !gewaehlterWeg ? t('optimieren.keinWeg')
      : !gewaehlterWeg.verfuegbar ? fehlerText({ code: gewaehlterWeg.grund ?? undefined }, 0)
      : zielzeichenUngueltig ? t('optimieren.zielzeichenTitle')
      : istCloud && stilInfo && !stilInfo.cloud ? t('optimieren.stilNichtCloud')
      : istCloud && !vorschau ? t('optimieren.cloudWartet')
      : istCloud && !vorschau!.restpruefung.ok ? t('optimieren.cloudRest')
      : null;
  const optimierDisabled = optLaeuft || !text.trim() || !optArt || optimierGrund !== null;

  const handleOptimieren = async () => {
    if (optimierDisabled || !gewaehlterWeg) return;
    const lauf = ++optimierLauf.current;
    setOptLaeuft(true);
    setOptFehler(null);
    setOptErgebnis(null);
    setOptUebernommen(false);
    setMaskenWeg([]);
    // Für die Cloud nur die Kennung der Vorschau: Der Server schickt den Text, den er dort gespeichert hat (G3).
    const body = {
      art: optArt,
      wegId: gewaehlterWeg.id,
      channelCode: channelCode || null,
      zielzeichen: zielzeichenWert,
      stilprofil: optStil || null,
      // Die angezeigte Fassung: Hat ein Admin das Profil inzwischen geändert, sendet der Server nichts (409).
      stilprofilFassung: stilInfo?.fassung ?? null,
      ...(istCloud ? { vorschauId: vorschau?.vorschauId } : { text }),
    };
    try {
      const r = await kiFetch<OptimierAntwort>('/optimieren', { method: 'POST', body: JSON.stringify(body) });
      if (lauf !== optimierLauf.current) return;
      if (r.ok) {
        setOptErgebnis(r.body);
      } else {
        setOptFehler(fehlerText(r.body, r.status));
        // Budget oder Freischaltung hat sich geändert: Anzeige der Wege nachziehen.
        if (r.body.code && ['BUDGET_EIGEN', 'BUDGET_GLOBAL', 'NICHT_FREIGESCHALTET', 'WEG_INAKTIV'].includes(r.body.code)) kiLaden();
      }
    } catch {
      if (lauf === optimierLauf.current) setOptFehler(t('optimieren.netzFehler'));
    } finally {
      if (lauf === optimierLauf.current) setOptLaeuft(false);
    }
  };

  /** Das Ergebnis wird der neue Text für Prüfen und Übersetzen; eine Übersetzung bleibt stehen, gilt aber als veraltet. */
  const optErgebnisRef = useRef(optErgebnis);
  optErgebnisRef.current = optErgebnis;
  const uebernimmOptimierung = (neu: string, basis: OptimierAntwort) => {
    // Nur, wenn das Ergebnis noch angezeigt wird und der Text noch der ist, gegen den es geprüft wurde (Review K1).
    if (optErgebnisRef.current !== basis || textRef.current !== basis.original) {
      setOptFehler(t('optimieren.veraltet'));
      return;
    }
    abbrechenAufnahme();
    ausUebernahme.current = neu;
    setzeText(neu);
    optimierLauf.current += 1;
    setOptErgebnis(null);
    setOptUebernommen(true);
  };

  const optimierungVeraltet = !!optErgebnis && optErgebnis.original !== text;

  // ── Datei und Spracheingabe ─────────────────────────────────────────────
  const handleFile = (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setFileError(tw('errors.fileTooLarge'));
      return;
    }
    if (!/\.(txt|md|markdown)$/i.test(file.name)) {
      setFileError(tw('errors.fileType'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      abbrechenAufnahme();
      setzeText(String(e.target?.result || ''));
      verwirfUebersetzung();
    };
    reader.readAsText(file);
  };

  // Nur Dateien fängt die Fläche ab; gezogener Text geht wie gewohnt ins Feld.
  const istDateiZug = (e: React.DragEvent) => Array.from(e.dataTransfer.types || []).includes('Files');

  const handleDragOver = (e: React.DragEvent) => {
    if (!istDateiZug(e)) return;
    e.preventDefault();
    setDragOver(true);
  };

  const handleDrop = (e: React.DragEvent) => {
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    handleFile(file);
  };

  /** Stopp auf Knopfdruck: das letzte Ergebnis des Diktats kommt noch an. */
  const stopRecording = () => {
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    setIsRecording(false);
  };

  /** Abbruch, wenn der Text anderswoher neu kommt (Tauschen, Datei, Sprachwechsel): nichts kommt nach. */
  const abbrechenAufnahme = () => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    interimRef.current = '';
    try { rec?.abort(); } catch { /* ignore */ }
    setIsRecording(false);
  };

  const startRecording = () => {
    if (!speechSupported) return;
    const Ctor: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new Ctor();
    rec.lang = SPEECH_LOCALES[sourceLang] || 'de-DE';
    rec.continuous = true;
    rec.interimResults = true;
    interimRef.current = '';

    rec.onresult = (e: any) => {
      // Ergebnisse einer abgebrochenen Aufnahme verwerfen
      if (recognitionRef.current !== rec) return;
      let finalText = '';
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      if (!finalText && !interimText) return;
      // Den vorläufigen Teil vom Ende nehmen, falls er noch dort steht, dann anhängen.
      const aktuell = textRef.current;
      const vorlaeufig = interimRef.current;
      const ohne = vorlaeufig && aktuell.endsWith(vorlaeufig) ? aktuell.slice(0, aktuell.length - vorlaeufig.length) : aktuell;
      const basis = ohne.length > 0 && !/\s$/.test(ohne) ? ohne + ' ' : ohne;
      if (finalText) {
        interimRef.current = '';
        setzeText(basis + finalText + ' ');
      } else {
        interimRef.current = interimText;
        setzeText(basis + interimText);
      }
    };
    rec.onerror = (e: any) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        console.error('SpeechRecognition error:', e.error);
      }
      setIsRecording(false);
    };
    rec.onend = () => setIsRecording(false);

    recognitionRef.current = rec;
    try {
      rec.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Konnte Spracherkennung nicht starten:', err);
      setIsRecording(false);
    }
  };

  // Beim Verlassen aufräumen
  useEffect(() => () => { try { recognitionRef.current?.abort(); } catch { /* ignore */ } }, []);
  // Bei jedem Sprachwechsel laufende Aufnahme abbrechen (sonst falsche Erkennungssprache)
  useEffect(() => { if (recognitionRef.current) abbrechenAufnahme(); /* eslint-disable-next-line */ }, [sourceLang]);

  // ── Aktion des gewählten Schritts ───────────────────────────────────────
  const checkDisabled = checkLoading || !text.trim();
  const aktion =
    schritt === 'pruefen'
      ? {
          label: checkLoading ? tw('actions.checking') : tw('actions.check'),
          name: tw('actions.check'),
          disabled: checkDisabled,
          run: handleCheck,
        }
      : schritt === 'optimieren'
      ? {
          label: optLaeuft ? t('optimieren.laeuft') : t('optimieren.aktion'),
          name: t('optimieren.aktion'),
          disabled: optimierDisabled,
          run: handleOptimieren,
        }
      : {
          label: translating
            ? (deToDe ? tq('actions.rewriting') : tq('actions.translating'))
            : (deToDe ? tq('actions.rewrite') : tq('actions.translate')),
          name: deToDe ? tq('actions.rewrite') : tq('actions.translate'),
          disabled: translateDisabled,
          run: handleTranslate,
        };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !aktion.disabled) {
      e.preventDefault();
      aktion.run();
    }
  };

  const channelDisabled =
    schritt === 'pruefen' ? !houseTermsApply : schritt === 'optimieren' ? false : !useGlossary && !deToDe;
  const channelTitle =
    schritt === 'pruefen'
      ? (houseTermsApply ? t('channel.checkTitle') : t('channel.checkOnlyGerman'))
      : schritt === 'optimieren'
      ? t('optimieren.channelTitle')
      : (useGlossary ? tq('channel.tooltip') : tq('channel.tooltipNeutral'));

  return (
    <div>
      <PageHeader title={t('header.title')} subtitle={t('header.subtitle')} />

      <SubTabs
        tabs={[
          { key: 'werkstatt', label: t('tabs.work') },
          { key: 'terms', label: tw('tabs.terms') },
        ] as const}
        active={view}
        onChange={waehleAnsicht}
      />

      {view === 'terms' ? (
        <HouseTermManager />
      ) : (
        <>
          {/* Schritte — jeder einzeln wählbar, der Text bleibt derselbe. Am Handy über die ganze Breite (bei 390 px lief die Leiste
              2 px über den Rand, gemessen 11.11.2026). */}
          <div role="tablist" aria-label={t('steps.label')} className="flex w-full sm:inline-flex sm:w-auto rounded-[5px] border border-gray-300 bg-white p-0.5 gap-0.5 mb-2">
            {schritte.map((s, i) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={schritt === s}
                onClick={() => waehleSchritt(s)}
                title={t(`steps.${s}Title`)}
                className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 sm:gap-2 text-sm px-2 sm:px-4 py-1.5 rounded-[4px] transition-colors ${
                  schritt === s ? 'bg-primary-600 text-white font-semibold' : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <span
                  className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold ${
                    schritt === s ? 'bg-white/25 text-white' : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {i + 1}
                </span>
                {t(`steps.${s}`)}
              </button>
            ))}
          </div>
          {/* Was der Schritt tut, sichtbar statt nur im Tooltip: Prüfen schlägt einzelne Stellen vor und ändert nichts von selbst,
              Optimieren schreibt mit KI den ganzen Text um (Wunsch Thomas 11.11.2026: den Unterschied hervorheben). */}
          <p className="text-xs text-gray-500 mb-4 max-w-3xl">
            <span className={`inline-block mr-2 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
              schritt === 'optimieren' ? 'bg-primary-100 text-primary-800' : 'bg-gray-100 text-gray-600'
            }`}>
              {t(`steps.${schritt}Art`)}
            </span>
            {t(`steps.${schritt}Hinweis`)}
          </p>

          {/* Sprache und Channel gelten für alle Schritte; dahinter, was nur der gewählte Schritt kennt. Jede Beschriftung steht über
              ihrem Feld (bis 11.11.2026 standen Modus und Anrede links daneben in eigenen Zeilen). Am Handy zwei Spalten. */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-3 mb-4 sm:flex sm:flex-wrap sm:items-end sm:gap-x-4">
            {/* Ausgangs- und Zielsprache bleiben am Handy in einer Zeile zusammen; ab sm löst sich die Klammer auf (`contents`). */}
            <div className={schritt === 'uebersetzen' ? 'col-span-2 flex items-end gap-2 sm:contents' : 'contents'}>
              <div className="min-w-0 flex-1 sm:flex-none">
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('lang.text')}</label>
                <select
                  value={sourceLang}
                  onChange={(e) => aendereSprache(e.target.value)}
                  className="w-full sm:w-auto text-sm border border-gray-300 rounded px-3 py-1.5"
                >
                  <option value={AUTO}>{langName(AUTO)}</option>
                  {SPRACHEN.map((code) => (
                    <option key={code} value={code}>{langName(code)}</option>
                  ))}
                </select>
              </div>

              {schritt === 'uebersetzen' && (
                <>
                  <button
                    type="button"
                    onClick={handleSwapLanguages}
                    disabled={isAuto}
                    className="pb-1.5 px-1 text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title={tq('lang.swap')}
                    aria-label={tq('lang.swap')}
                  >
                    ⇄
                  </button>
                  <div className="min-w-0 flex-1 sm:flex-none">
                    <label className="block text-xs font-medium text-gray-500 mb-1">{tq('lang.target')}</label>
                    <select
                      value={targetLang}
                      onChange={(e) => { setTargetLang(e.target.value); verwirfUebersetzung(); }}
                      className="w-full sm:w-auto text-sm border border-gray-300 rounded px-3 py-1.5"
                    >
                      {SPRACHEN.map((code) => (
                        <option key={code} value={code}>{langName(code)}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>

            <div className="min-w-0">
              <label className="block text-xs font-medium text-gray-500 mb-1">{tq('channel.label')}</label>
              <select
                value={channelCode}
                onChange={(e) => aendereChannel(e.target.value)}
                disabled={channelDisabled}
                className="w-full sm:w-auto text-sm border border-gray-300 rounded px-3 py-1.5 disabled:bg-gray-100 disabled:text-gray-400"
                title={channelTitle}
              >
                <option value="">{tq('channel.default')}</option>
                {channels.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            </div>

            {schritt === 'pruefen' && (
              <>
                <label className="self-end inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer pb-1.5">
                  <input
                    type="checkbox"
                    checked={picky}
                    onChange={(e) => setPicky(e.target.checked)}
                    className="accent-primary-600"
                  />
                  {tw('picky')}
                </label>
                {matches.length > 0 && (
                  <button
                    type="button"
                    onClick={acceptAllSafe}
                    disabled={safeGesperrt}
                    className="col-span-2 sm:ml-auto px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    title={safeGesperrt ? t('check.markupHint') : tw('actions.acceptSafeTitle')}
                  >
                    ✓ {tw('actions.acceptSafe')}
                  </button>
                )}
              </>
            )}

            {schritt === 'optimieren' && (
              <>
                <div className="min-w-0">
                  <label className="block text-xs font-medium text-gray-500 mb-1" htmlFor="tw-opt-art">{t('optimieren.art')}</label>
                  <select
                    id="tw-opt-art"
                    value={optArt}
                    onChange={(e) => setOptArt(e.target.value)}
                    disabled={!arten || arten.length === 0}
                    title={artInfo?.beschreibung || undefined}
                    className="w-full sm:w-auto text-sm border border-gray-300 rounded px-3 py-1.5 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    {(arten ?? []).map((a) => (
                      <option key={a.id} value={a.id} title={a.beschreibung}>{a.name}</option>
                    ))}
                  </select>
                </div>
                {stilprofile.length > 0 && (
                  <div className="min-w-0">
                    <label className="block text-xs font-medium text-gray-500 mb-1" htmlFor="tw-opt-stil">{t('optimieren.stil')}</label>
                    <select
                      id="tw-opt-stil"
                      value={optStil}
                      onChange={(e) => waehleStil(e.target.value)}
                      title={stilInfo ? t('optimieren.stilTitle', { fassung: stilInfo.fassung, beschreibung: stilInfo.beschreibung }) : t('optimieren.stilOhneTitle')}
                      className="w-full sm:w-auto text-sm border border-gray-300 rounded px-3 py-1.5"
                    >
                      <option value="">{t('optimieren.stilOhne')}</option>
                      {stilprofile.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.channelCode ? t('optimieren.stilMitChannel', { name: p.name, code: p.channelCode }) : p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="col-span-2 sm:col-span-1 min-w-0">
                  <span className="block text-xs font-medium text-gray-500 mb-1">{t('optimieren.weg')}</span>
                  <div className="inline-flex flex-wrap max-w-full rounded-[5px] border border-gray-300 bg-white p-0.5 gap-0.5" role="radiogroup" aria-label={t('optimieren.weg')}>
                    {kiWege.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        role="radio"
                        aria-checked={optWeg === w.id}
                        disabled={!w.verfuegbar}
                        onClick={() => setOptWeg(w.id)}
                        title={w.verfuegbar ? w.name : t('optimieren.wegGesperrt', { grund: fehlerText({ code: w.grund ?? undefined }, 0) })}
                        className={`${segmentCls(optWeg === w.id)} disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed`}
                      >
                        {w.name}
                      </button>
                    ))}
                    {kiWege.length === 0 && <span className="text-xs text-gray-400 px-2 py-1">{t('optimieren.keinWeg')}</span>}
                  </div>
                </div>
                {artInfo?.zielzeichen && (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1" htmlFor="tw-opt-ziel">{t('optimieren.zielzeichen')}</label>
                    <input
                      id="tw-opt-ziel"
                      type="number"
                      min={20}
                      max={10000}
                      step={10}
                      value={zielzeichen}
                      onChange={(e) => setZielzeichen(e.target.value)}
                      placeholder={text.trim() ? String(Math.round(text.trim().length / 2)) : ''}
                      title={t('optimieren.zielzeichenTitle')}
                      className={`w-28 text-sm border rounded px-3 py-1.5 ${zielzeichenUngueltig ? 'border-red-400' : 'border-gray-300'}`}
                    />
                  </div>
                )}
              </>
            )}

            {schritt === 'uebersetzen' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{tq('glossary.label')}</label>
                <label
                  className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer px-3 py-1.5 border border-gray-300 rounded select-none"
                  title={tq('glossary.tooltip')}
                >
                  <input
                    type="checkbox"
                    checked={useGlossary}
                    onChange={(e) => { setUseGlossary(e.target.checked); verwirfUebersetzung(); }}
                    className="accent-primary-600"
                  />
                  {useGlossary ? tq('glossary.use') : tq('glossary.neutral')}
                </label>
              </div>
            )}

            {schritt === 'uebersetzen' && (
              <>
                {/* Modus: Text oder XML/HTML mit erhaltenen Tags */}
                <div className="min-w-0">
                  <span className="block text-xs font-medium text-gray-500 mb-1">{ohneDoppelpunkt(tq('mode.label'))}</span>
                  <div className="inline-flex rounded-[5px] border border-gray-300 bg-white p-0.5 gap-0.5">
                    {(['text', 'xml', 'html'] as TranslateMode[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={mode === m}
                        onClick={() => { setMode(m); verwirfUebersetzung(); }}
                        className={segmentCls(mode === m)}
                        title={m === 'text' ? tq('mode.textTitle') : m === 'xml' ? tq('mode.xmlTitle') : tq('mode.htmlTitle')}
                      >
                        {m === 'text' ? tq('mode.text') : m.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Anredestufe. Bei nicht unterstützter Zielsprache ausgegraut MIT Grund, nicht
                    ausgeblendet: wer die Option sucht und nicht findet, hält sie für einen Fehler. */}
                <div className="col-span-2 sm:col-span-1 min-w-0">
                  <span className="block text-xs font-medium text-gray-500 mb-1">{ohneDoppelpunkt(tq('formality.label'))}</span>
                  <div className="inline-flex flex-wrap max-w-full rounded-[5px] border border-gray-300 bg-white p-0.5 gap-0.5">
                    {(['default', 'more', 'less'] as FormalityChoice[]).map((f) => {
                      const pron = FORMALITY_PRONOUNS[targetLang.toUpperCase()];
                      const beschriftung =
                        f === 'default' ? tq('formality.default') : f === 'more' ? tq('formality.more') : tq('formality.less');
                      const hinweis = f === 'default' ? null : pron ? (f === 'more' ? pron.more : pron.less) : null;
                      return (
                        <button
                          key={f}
                          type="button"
                          disabled={f !== 'default' && !formalitySupported}
                          aria-pressed={formality === f}
                          onClick={() => { setFormality(f); verwirfUebersetzung(); }}
                          className={`${segmentCls(formality === f)} disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed`}
                          title={
                            f === 'default'
                              ? tq('formality.defaultTitle')
                              : formalitySupported
                                ? (f === 'more' ? tq('formality.moreTitle') : tq('formality.lessTitle'))
                                : tq('formality.unsupportedTitle')
                          }
                        >
                          {beschriftung}
                          {hinweis && formalitySupported && (
                            <span className={formality === f ? 'ml-1 opacity-80' : 'ml-1 text-gray-400'}>{hinweis}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Hinweise zu Modus und Anrede unter der Zeile: daneben hätten sie die Felder aus der Flucht geschoben. */}
          {schritt === 'uebersetzen' && (mode !== 'text' || !formalitySupported) && (
            <p className="-mt-2 mb-4 text-xs text-gray-400">
              {[
                mode !== 'text' ? tq('mode.codeTagsKept') : null,
                !formalitySupported ? tq('formality.unsupportedFor', { lang: langName(targetLang) }) : null,
              ].filter(Boolean).join(' · ')}
            </p>
          )}

          {fileError && <div className="mb-3 text-sm text-red-600">{fileError}</div>}
          {schritt === 'pruefen' && checkError && <div className="mb-3 text-sm text-red-600">{checkError}</div>}
          {schritt === 'pruefen' && ltWarning && <div className="mb-3 text-sm text-amber-700">{ltWarning}</div>}
          {schritt === 'pruefen' && mode !== 'text' && (
            <div className="mb-3 text-sm text-amber-700">{t('check.markupHint')}</div>
          )}
          {schritt === 'optimieren' && kiStatus && (
            <div className="mb-3 empty:hidden"><KiBudgetHinweis wege={kiStatus.wege} /></div>
          )}
          {schritt === 'optimieren' && optimierGrund && (
            <div className="mb-3 text-sm text-amber-700">{optimierGrund}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Eingabe — dieselbe für alle Schritte */}
            <div className="bg-white rounded-lg border border-gray-200 flex flex-col">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-medium text-gray-700">{langName(sourceLang)}</span>
                  {text.length > 0 && (
                    <span className="text-xs text-gray-400 ml-2">{tw('editor.chars', { count: text.length })}</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {speechSupported && (
                    <button
                      type="button"
                      onClick={() => (isRecording ? stopRecording() : startRecording())}
                      title={isRecording
                        ? tq('speech.stop')
                        : tq('speech.startWithLocale', { locale: SPEECH_LOCALES[sourceLang] || 'de-DE' })}
                      aria-label={isRecording ? tq('speech.stop') : tq('speech.start')}
                      className={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${
                        isRecording
                          ? 'bg-red-100 text-red-700 ring-1 ring-red-300'
                          : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
                      }`}
                    >
                      <span className={isRecording ? 'inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse' : ''} />
                      <span>🎤</span>
                      <span>{isRecording ? tq('speech.recording') : tq('speech.speak')}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-primary-700 hover:text-primary-900"
                  >
                    {tw('editor.loadFile')}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,.markdown"
                    onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); e.target.value = ''; }}
                    className="hidden"
                  />
                </div>
              </div>
              <div
                onDragOver={handleDragOver}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`relative ${dragOver ? 'bg-primary-50' : ''}`}
              >
                <textarea
                  ref={textareaRef}
                  value={text}
                  onChange={(e) => setzeText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onSelect={handleSourceSelect}
                  onMouseUp={handleSourceSelect}
                  onKeyUp={handleSourceSelect}
                  placeholder={
                    schritt === 'uebersetzen' && mode !== 'text'
                      ? tq('input.placeholderCode', { mode: mode.toUpperCase() })
                      : tw('editor.placeholder')
                  }
                  className={`w-full h-80 px-4 py-3 resize-none focus:outline-none ${
                    schritt === 'uebersetzen' && mode !== 'text' ? 'text-xs font-mono' : 'text-sm font-sans'
                  }`}
                  autoFocus
                />
                {dragOver && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none border-2 border-dashed border-primary-400 rounded text-sm text-primary-700">
                    {tw('editor.dropHere')}
                  </div>
                )}
              </div>

              {schritt === 'uebersetzen' && result && mode === 'text' && (
                <div className="px-4 py-2 border-t border-gray-100 bg-primary-50/40">
                  {sourceSelection ? (
                    <button
                      type="button"
                      onClick={() => openAlternatives(sourceSelection)}
                      className="w-full inline-flex items-center justify-center gap-2 text-sm px-3 py-1.5 rounded-md bg-primary-600 text-white hover:bg-primary-700 transition-colors"
                      title={tq('alt.forSelectionTitle', { text: sourceSelection.length > 60 ? sourceSelection.slice(0, 60) + '…' : sourceSelection })}
                    >
                      <span>≡</span>
                      <span>
                        <Trans
                          t={tq}
                          i18nKey="alt.forSelection"
                          values={{ text: sourceSelection.length > 40 ? sourceSelection.slice(0, 40) + '…' : sourceSelection }}
                          components={{ b: <span className="font-semibold" /> }}
                        />
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openAlternatives(null)}
                      className="w-full inline-flex items-center justify-center gap-2 text-sm px-3 py-1.5 rounded-md border border-dashed border-primary-300 text-primary-700 hover:bg-primary-50 transition-colors"
                      title={tq('alt.markHintTitle')}
                    >
                      <span>≡</span>
                      <span>{tq('alt.markHint')}</span>
                    </button>
                  )}
                </div>
              )}

              <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3 mt-auto">
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  <span>{t('input.shortcut', { action: aktion.name })}</span>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(text)}
                    className="text-gray-500 hover:text-gray-800 disabled:opacity-40"
                    disabled={!text}
                  >
                    {tw('editor.copy')}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={aktion.run}
                  disabled={aktion.disabled}
                  className="px-4 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {aktion.label}
                </button>
              </div>
              {schritt === 'uebersetzen' && isAuto && (
                <div className="px-4 pb-3 text-xs text-amber-700">
                  {t('lang.autoNotForTranslate')}
                  {erkannteSprache && (
                    <button
                      type="button"
                      onClick={uebernimmErkannteSprache}
                      className="ml-2 font-semibold text-primary-700 hover:text-primary-900"
                    >
                      {t('lang.useDetected', { lang: langName(erkannteSprache) })}
                    </button>
                  )}
                </div>
              )}
              {schritt === 'uebersetzen' && deToDe && (
                <div className="px-4 pb-3 text-xs text-gray-500">
                  {channelCode ? tq('channelFassung.hint') : tq('channelFassung.needChannel')}
                </div>
              )}
              <div className="px-4 pb-2 text-[11px] text-gray-400">{tw('editor.dragDropHint')}</div>
            </div>

            {/* Ergebnis des gewählten Schritts */}
            {schritt === 'pruefen' ? (
              <PruefenErgebnis
                text={text}
                matches={matches}
                stats={stats}
                activeIdx={activeMatchIdx}
                onSelect={setActiveMatchIdx}
                onApply={applyReplacement}
                onDismiss={dismissMatch}
                onWeiter={() => {
                  // Bis 11.11.2026 sprang „Weiter“ immer zum Übersetzen und überging das Optimieren (Meldung Thomas).
                  const deutsch = sourceLang === 'DE' || (isAuto && erkannteSprache === 'DE');
                  uebernimmErkannteSprache();
                  waehleSchritt(deutsch ? 'optimieren' : 'uebersetzen');
                }}
                weiterLabel={sourceLang === 'DE' || (isAuto && erkannteSprache === 'DE') ? t('check.nextOptimieren') : t('check.next')}
              />
            ) : schritt === 'optimieren' ? (
              <OptimierenErgebnis
                ergebnis={optErgebnis}
                laeuft={optLaeuft}
                fehler={optFehler}
                veraltet={optimierungVeraltet}
                uebernommen={optUebernommen}
                wegName={kiWege.find((w) => w.id === optErgebnis?.weg.id)?.name ?? null}
                channelCode={channelCode || null}
                onUebernehmen={uebernimmOptimierung}
                onVerwerfen={verwirfOptimierung}
                onWeiter={() => waehleSchritt('uebersetzen')}
              />
            ) : (
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">{langName(targetLang)}</span>
                  <div className="flex items-center gap-3">
                    {/* Ein Glossar braucht ein Sprachpaar — „Automatisch“ legte sonst „AUTO → EN“ an. */}
                    <button
                      type="button"
                      onClick={() => setGlossarEntwurf({ source: '', target: '', channel: channelCode })}
                      disabled={isAuto}
                      className="text-xs text-primary-700 hover:text-primary-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      title={isAuto ? t('lang.autoNotForTranslate') : tq('result.newGlossaryEntryTitle')}
                    >
                      + {tq('result.newGlossaryEntry')}
                    </button>
                    {result && (
                      <button
                        type="button"
                        onClick={handleCopyResult}
                        className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
                      >
                        {copied ? tq('result.copied') : tq('result.copy')}
                      </button>
                    )}
                  </div>
                </div>
                {uebersetzungVeraltet && !translating && (
                  <div className="px-4 py-2 border-b border-amber-100 bg-amber-50 text-xs text-amber-800">
                    {t('translate.stale')}
                  </div>
                )}
                <div className="h-80 px-4 py-3 overflow-y-auto" onMouseUp={handleResultMouseUp}>
                  {translating && (
                    <div className="flex items-center gap-2 text-sm text-gray-400">
                      <span className="animate-spin">&#9696;</span> {tq('result.loading')}
                    </div>
                  )}
                  {translateError && <div className="text-sm text-red-600">{translateError}</div>}
                  {result && (() => {
                    const inhalt = result.channelFassung
                      ? renderWithHighlights(result.translatedText, result.glossaryHits || [], undefined, true)
                      : renderWithHighlights(result.translatedText, result.glossaryHits || [], (hit) =>
                          setGlossarEntwurf({ source: hit.source, target: hit.target, channel: hit.channel || '' }));
                    return mode === 'text'
                      ? <p className="text-sm text-gray-900 whitespace-pre-wrap">{inhalt}</p>
                      : <pre className="text-xs font-mono text-gray-900 whitespace-pre-wrap break-all">{inhalt}</pre>;
                  })()}
                  {!translating && !translateError && !result && (
                    <p className="text-sm text-gray-300">{tq('result.placeholder')}</p>
                  )}
                </div>
                {/* Angewandte Anredestufe — nur, wenn eine gewählt wurde; bei nicht unterstützter
                    Zielsprache ausdrücklich „nicht angewandt“, nicht einfach nichts. */}
                {result?.formality && result.formality.requested !== 'default' && (
                  <div className="px-4 py-2 border-t border-gray-100">
                    <span className="text-xs text-gray-400">
                      {tq('formality.label')}{' '}
                      {result.formality.applied ? (
                        <span className="text-gray-600">
                          {result.formality.applied === 'more' ? tq('formality.appliedMore') : tq('formality.appliedLess')}
                          {FORMALITY_PRONOUNS[targetLang.toUpperCase()] && (
                            <span className="ml-1 text-gray-500">
                              (
                              {result.formality.applied === 'more'
                                ? FORMALITY_PRONOUNS[targetLang.toUpperCase()].more
                                : FORMALITY_PRONOUNS[targetLang.toUpperCase()].less}
                              )
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-amber-600">{tq('formality.notApplied')}</span>
                      )}
                    </span>
                  </div>
                )}
                {result?.glossaryUsed && (
                  <div className="px-4 py-2 border-t border-gray-100">
                    <span className="text-xs text-gray-400">
                      {tq('result.glossaryUsed')} <span className="text-gray-600">{result.glossaryUsed}</span>
                      {result.channelCode && (
                        <span className="ml-1 text-gray-600">{tq('result.plusChannel', { code: result.channelCode })}</span>
                      )}
                      {' – '}{tq('result.glossaryMarked')}
                      {result.glossaryHits && result.glossaryHits.length > 0 && (() => {
                        const total = result.glossaryHits.length;
                        const channelHits = result.glossaryHits.filter((h) => h.channel).length;
                        return (
                          <span className="ml-1 text-gray-500">
                            {channelHits > 0
                              ? tq('result.hitsWithChannel', { count: total, channel: channelHits })
                              : tq('result.hits', { count: total })}
                          </span>
                        );
                      })()}
                    </span>
                  </div>
                )}
                {result?.channelFassung && (
                  <div className="px-4 py-2 border-t border-gray-100 text-xs text-gray-500 space-y-1">
                    <div>
                      {result.channelFassung.sprachmodell + result.channelFassung.regel > 0
                        ? tq('channelFassung.summary', {
                            count: result.channelFassung.sprachmodell + result.channelFassung.regel,
                            channel: result.channelCode,
                            model: result.channelFassung.sprachmodell,
                            rule: result.channelFassung.regel,
                          })
                        : tq('channelFassung.unchanged', { channel: result.channelCode })}
                    </div>
                    {result.channelFassung.eigene === 0 && (
                      <div className="text-amber-700">{tq('channelFassung.noOwnTerms', { channel: result.channelCode })}</div>
                    )}
                    {result.channelFassung.pruefen.map((p, i) => (
                      <div key={i} className="text-amber-700">⚠ {p}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Cloud: die Vorschau „so sieht es das Modell“; gesendet wird genau ihr Text. Lokal: ein Satz, wohin der Text geht. */}
          {schritt === 'optimieren' && istCloud && (
            <div className="mt-4 bg-white rounded-lg border border-gray-200 p-4">
              <p className="text-xs text-gray-500 mb-3">{t('optimieren.cloudHinweis')}</p>
              {maskenWeg.length > 0 && (
                <p role="status" className="text-xs text-amber-800 mb-3">
                  {t('optimieren.maskenWeg', { liste: maskenWeg.join(', ') })}
                </p>
              )}
              <PseudonymVorschau text={text} onVorschau={setVorschau} masken={masken} onMasken={setMasken} />
              {stilInfo && (
                // Was außer dem Text an das Modell geht: das Stilprofil, ohne Platzhalter (Review M4). Der Nutzer soll sehen, was
                // die Cloud liest, nicht nur den eigenen Text.
                <details className="mt-3 text-xs text-gray-600 border border-gray-200 rounded-md p-2 bg-gray-50">
                  <summary className="cursor-pointer">{t('optimieren.stilGehtMit', { name: stilInfo.name, fassung: stilInfo.fassung })}</summary>
                  <pre className="whitespace-pre-wrap font-sans mt-2">{stilInfo.beschreibung}</pre>
                  {stilInfo.beispiele && <pre className="whitespace-pre-wrap font-sans mt-2 italic text-gray-500">{stilInfo.beispiele}</pre>}
                </details>
              )}
            </div>
          )}
          {schritt === 'optimieren' && !istCloud && gewaehlterWeg && (
            <p className="mt-3 text-xs text-gray-400">{t('optimieren.lokalHinweis')}</p>
          )}

          {schritt === 'pruefen' && (
            <p className="mt-3 text-xs text-gray-400">
              {tw('footer.poweredBy')}
              {einstellungen().languagetoolLink && (
                <>
                  {' '}·{' '}
                  <a href={einstellungen().languagetoolLink!} target="_blank" rel="noreferrer" className="underline">
                    {new URL(einstellungen().languagetoolLink!).host}
                  </a>
                </>
              )}
              {houseTermsApply && (
                <>
                  {' '}·{' '}
                  <Trans
                    t={tw}
                    i18nKey="footer.legend"
                    components={{ hl: <span className="px-1 rounded bg-cyan-100 text-cyan-900" /> }}
                  />
                </>
              )}
            </p>
          )}

          {altAnfrage && (
            <AlternativenDialog
              span={altAnfrage.span}
              text={text}
              sourceLang={sourceLang}
              targetLang={targetLang}
              channelCode={channelCode}
              useGlossary={useGlossary}
              formality={formality}
              translatedText={result?.translatedText ?? null}
              onApply={applyAlternative}
              onSaveAsGlossary={(alt) => {
                const source = altAnfrage.span?.trim();
                if (!source) return;
                setAltAnfrage(null);
                setGlossarEntwurf({ source, target: alt, channel: channelCode });
              }}
              onClose={() => setAltAnfrage(null)}
            />
          )}

          {glossarEntwurf && (
            <GlossarEintragDialog
              entwurf={glossarEntwurf}
              sourceLang={sourceLang}
              targetLang={targetLang}
              channels={channels}
              langName={langName}
              onClose={() => setGlossarEntwurf(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
