/**
 * Öffentliche Einstellungen der Installation (`GET /api/einstellungen`), einmal vor dem ersten Rendern geladen.
 *
 * `main.tsx` wartet darauf, bevor es i18n und die App lädt: Der Organisationsname ist die Vorgabe für `{{org}}`
 * in allen Texten. Scheitert der Abruf, läuft die Oberfläche mit neutraler Bezeichnung weiter.
 */
export interface OeffentlicheEinstellungen {
  organisationName: string;
  appName: string;
  languagetoolLink: string | null;
  /** `alle`: jede angemeldete Person schreibt direkt ins Glossar (Demo). Fehlt die Angabe, gilt `admin`. */
  glossarFreigabe: 'admin' | 'alle';
  /** Demo-Modus: Tor statt Anmeldung, Hinweisband auf jeder Seite. `null` = keine Demo. */
  demo: { naechsterReset: string | null } | null;
}

let stand: OeffentlicheEinstellungen = { organisationName: '', appName: 'Textwerkstatt', languagetoolLink: null, glossarFreigabe: 'admin', demo: null };

export async function ladeEinstellungen(): Promise<void> {
  try {
    const res = await fetch('/api/einstellungen');
    if (res.ok) stand = { ...stand, ...(await res.json()) };
    if (stand.appName) document.title = stand.appName;
  } catch {
    // Server nicht erreichbar: die App zeigt das selbst an, hier reicht die neutrale Vorgabe.
  }
}

export const einstellungen = (): OeffentlicheEinstellungen => stand;

/** Name für Texte wie „Standard ({{org}})“; ohne Angabe eine neutrale Bezeichnung. */
export const orgName = (): string => stand.organisationName || 'Organisation';
