/**
 * Vertrag eines Themas (PLAN-oeffentlich-und-demo.md, Phase 3).
 *
 * Die Oberfläche kennt nur diese Schnittstelle; welches Thema dahinter steht, entscheidet der Build (`THEMA`,
 * client/thema.config.js, Alias `@thema`). Farben, die nur aus einer Variable kommen, stehen nicht hier, sondern
 * als `--pal-*` in `themes/<name>/thema.css` — hier steht, was Markup oder ganze Klassenfolgen braucht.
 */
import type { CSSProperties, ReactElement } from 'react';

export interface KopfKlassen {
  /** Stil des `<header>` (Grund, untere Linie). */
  stil: CSSProperties;
  reiterAktiv: string;
  reiterInaktiv: string;
  /** Senkrechter Strich zwischen den Reitergruppen. */
  trenner: string;
  /** Ausklappmenü „Verwaltung“. */
  menue: string;
  menueStil: CSSProperties;
  menueTitel: string;
  menueEintragAktiv: string;
  menueEintragInaktiv: string;
  /** Personen-Kürzel rechts; `kuerzelAktiv` kommt dazu, wenn die Panel-Seite offen ist. */
  kuerzel: string;
  kuerzelAktiv: string;
  abmelden: string;
  /** Rand links vor Sprache · Person · Abmelden (ab lg). */
  rechts: string;
  /** Variante des Sprachumschalters in der Kopfzeile. */
  sprachwahl: 'dark' | 'light';
}

export interface AnmeldeKlassen {
  /** Stil der Karte, auf der die Anmeldung steht. */
  karte: CSSProperties;
  /** Eingabefeld auf dieser Karte. */
  feld: string;
  /** Ausrichtung des Blocks aus Titel und Untertitel. */
  kopf: string;
  /** Klasse und Stil des Titels über dem Formular. */
  titel: string;
  titelStil: CSSProperties;
  /** Text des Titels; `null` = Name der Anwendung aus den Einstellungen. */
  titelText: string | null;
}

export interface Thema {
  name: string;
  /** Logo links in der Kopfzeile, zugleich der Weg zur Startseite. */
  Logo: () => ReactElement;
  /** Logo über der Anmeldung. */
  AnmeldeLogo: () => ReactElement;
  kopf: KopfKlassen;
  anmeldung: AnmeldeKlassen;
  /** Titel und Untertitel einer Seite (ohne die Aktionen rechts, die setzt `PageHeader`). */
  Seitentitel: (p: { title: string; subtitle?: string }) => ReactElement;
  /** Unterstrich des aktiven Unterreiters (`SubTabs`). */
  unterreiterAktiv: string;
  /** Fußzeile unter jeder Seite; `null`, wenn das Thema keine hat. */
  Fuss: (() => ReactElement) | null;
  /** Hintergrund hinter allem (Skizzen); `null`, wenn das Thema keinen hat. */
  Hintergrund: (() => ReactElement) | null;
  /** Farbe, mit der ein neues Thema in „Themen“ (Dokument-Kategorien) startet — wird gespeichert, also ein Hexwert. */
  kategorieFarbe: string;
}
