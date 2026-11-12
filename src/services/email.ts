/**
 * Email-Versand-Service
 *
 * Aktuell genutzt fuer Native-Speaker-Reviewer-Anfragen aus der Pruefen-Seite.
 * Versand ueber lokales Postfix auf dem VPS (Port 25, kein Auth, kein TLS —
 * gleiche Konfiguration wie Listmonk). Im Dev-Modus (config.smtp.host leer)
 * wird die Mail nur ins Log geschrieben.
 */

import nodemailer from 'nodemailer';
import { config } from '../config';

/** Host der App für Fußzeilen der Mails, aus APP_URL. */
const APP_HOST = new URL(config.publicUrl).host;
/** Kopfzeile der Mails: „<Organisation> · Translator“ oder nur „Translator“. */
const MAIL_KOPF = config.organisationName ? `${config.organisationName} · Translator` : 'Translator';

// Hardcoded auf lokales Postfix (127.0.0.1:25, kein Auth). Gleiches Pattern
// wie Sonderanfragen + Listmonk — auf dem VPS laeuft Postfix immer dort und
// nimmt Mails von localhost ohne Auth an.
const transporter = nodemailer.createTransport({
  host: '127.0.0.1',
  port: 25,
  secure: false,
  tls: { rejectUnauthorized: false },
});

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SendMailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendMail(opts: SendMailOptions): Promise<SendMailResult> {
  // Die Demo verschickt nie Mail, auch nicht mit gesetztem Absender (PLAN-oeffentlich-und-demo.md Phase 2).
  if (config.demo.an) {
    return { ok: false, error: 'In der Demo werden keine E-Mails verschickt' };
  }
  if (!config.mailFrom) {
    return { ok: false, error: 'Mailversand ist nicht eingerichtet (MAIL_FROM fehlt)' };
  }
  try {
    const info = await transporter.sendMail({
      from: `${`Translator ${config.organisationName}`.trim()} <${config.mailFrom}>`,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: opts.replyTo,
    });
    console.log(`[Email] Sent to ${opts.to}: ${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (err: any) {
    console.error(`[Email] Send failed to ${opts.to}:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Sprachen der Mails an Native Speaker (18.09.2026).
 *
 * Die Review-Anfrage und „Bereits erledigt" gehen an Native Speaker, viele
 * davon mit schwachem Deutsch — sie kommen in der Zielsprache des Projekts.
 * Die Mails an die anfragende Person (Freigegeben, Freigabe aufgehoben) sind
 * intern und bleiben deutsch.
 */
export type MailLang = 'de' | 'en' | 'it' | 'fr' | 'hu' | 'sk';
const MAIL_LANGS: readonly MailLang[] = ['de', 'en', 'it', 'fr', 'hu', 'sk'];

/**
 * Projekt-Zielsprache → Mailsprache. Codes wie `EN-GB`, `EN-US`, `HU`, `SK`
 * werden auf zwei Buchstaben gekürzt; was nicht unterstützt ist (z. B. `CZ`,
 * `CS`, `PL`), bekommt Englisch.
 */
export function mailLangFor(targetLang: string | null | undefined): MailLang {
  const code = String(targetLang || '').slice(0, 2).toLowerCase();
  return (MAIL_LANGS as readonly string[]).includes(code) ? (code as MailLang) : 'en';
}

/**
 * Texte der Reviewer-Mails je Sprache. `**…**` markiert Fettdruck in der
 * HTML-Fassung (siehe `richHtml`); eingesetzte Werte werden mit escaped.
 * Die Beschriftungen „Übersetzung freigeben" und „Kürzel" entsprechen den
 * Knöpfen im Review-Editor der jeweiligen Sprache.
 */
interface ReviewerMailTexts {
  /** Doppelpunkt nach Beschriftungen der Text-Fassung (FR mit Leerzeichen). */
  colon: string;
  greeting: (name: string) => string;
  documentLabel: string;
  languagesLabel: string;
  segmentsLabel: string;
  segmentCount: (n: number) => string;
  noticeFooterHtml: string;
  noticeFooterText: string;
  // Review-Anfrage
  requestSubject: (project: string, src: string, tgt: string) => string;
  requestHeading: string;
  introHtml: string;
  introText: string[];
  howItWorks: string;
  stepsHtml: (requester: string) => string[];
  stepsText: (requester: string) => string[];
  otherReviewers: (total: number) => string;
  noteLabel: string;
  noteHtml: string;
  noteText: string[];
  keyboardLabel: string;
  spaceKey: string;
  kbNextPrev: string;
  kbSpace: string;
  kbEdit: string;
  kbAsk: string;
  kbFullListHtml: string;
  keyboardText: string[];
  cta: string;
  fallbackLink: string;
  thanks: string;
  toTranslation: string;
  footerSentHtml: string;
  footerReplyHtml: string;
  footerText: (email: string) => string;
  // Bereits erledigt
  doneSubject: (project: string, src: string, tgt: string) => string;
  doneHeading: string;
  doneParagraph: (reviewer: string) => string;
  doneCta: string;
}

const REVIEWER_MAIL_TEXTS: Record<MailLang, ReviewerMailTexts> = {
  de: {
    colon: ':',
    greeting: (name) => `Hallo ${name},`,
    documentLabel: 'Dokument',
    languagesLabel: 'Sprachen',
    segmentsLabel: 'Segmente',
    segmentCount: (n) => (n === 1 ? '1 Segment' : `${n} Segmente`),
    noticeFooterHtml: `Diese E-Mail wurde automatisch versendet von **${APP_HOST}**.`,
    noticeFooterText: `Automatisch versendet von ${APP_HOST}.`,
    requestSubject: (p, s, t) => `Bitte um Review: ${p} (${s} → ${t})`,
    requestHeading: 'Bitte um Review',
    introHtml:
      'wir haben eine maschinelle Übersetzung erstellt und wären dir sehr dankbar, wenn du als **Muttersprachler:in** einen prüfenden Blick darauf werfen könntest.',
    introText: [
      'wir haben eine maschinelle Übersetzung erstellt und wären dir sehr dankbar,',
      'wenn du als Muttersprachler:in einen prüfenden Blick darauf werfen könntest.',
    ],
    howItWorks: "So funktioniert's:",
    stepsHtml: (r) => [
      'Auf den Button unten klicken — du landest direkt im Review-Editor.',
      'Anmelden mit deinem Microsoft-Konto.',
      'Pro Segment: passt die Übersetzung, **Häkchen in die Checkbox setzen** (wird zum grünen Haken). Stimmt etwas nicht, einfach in den Text klicken und korrigieren.',
      'Mit den **Filtern oben** kannst du dich gezielt auf gekürzte Segmente oder solche mit Review-Bedarf konzentrieren.',
      `Passt alles, oben auf **„Übersetzung freigeben"** klicken. Erst damit weiß ${r}, dass du fertig bist.`,
    ],
    stepsText: (r) => [
      'Link unten öffnen.',
      'Mit deinem Microsoft-Konto anmelden.',
      'Pro Segment: passt die Übersetzung, Häkchen in die Checkbox setzen.\nStimmt etwas nicht, in den Text klicken und korrigieren.',
      'Mit den Filtern oben gezielt auf gekürzte / Review-Segmente konzentrieren.',
      `Passt alles, oben auf "Übersetzung freigeben" klicken. Erst damit weiß ${r}, dass du fertig bist.`,
    ],
    otherReviewers: (n) =>
      `Diese Anfrage ging an ${n} Personen — wer zuerst Zeit hat, prüft. Gibt jemand anderes vorher frei, bekommst du eine kurze Nachricht.`,
    noteLabel: 'Hinweis:',
    noteHtml:
      'Begriffe mit gepunkteter Cyan-Unterstreichung stammen aus unserem internen Firmen-Glossar (z.B. Markennamen, Produktbezeichnungen). Lass diese nach Möglichkeit unverändert — es sei denn die Übersetzung passt grammatikalisch wirklich nicht.',
    noteText: [
      'Hinweis: Begriffe mit gepunkteter Cyan-Unterstreichung stammen aus dem',
      'Firmen-Glossar (Markennamen, Produktbezeichnungen). Nach Möglichkeit',
      'unverändert lassen.',
    ],
    keyboardLabel: '⌨ Schneller mit Tastatur:',
    spaceKey: 'Leertaste',
    kbNextPrev: 'nächstes/voriges Segment',
    kbSpace: 'abnicken + weiter (Flow-Modus)',
    kbEdit: 'bearbeiten',
    kbAsk: 'Rückfrage stellen',
    kbFullListHtml: 'Komplette Liste oben rechts unter **„⌨ Kürzel"**.',
    keyboardText: [
      'Tastatur-Tipp: J/K = nächstes/voriges Segment, Leertaste = abnicken + weiter,',
      'E = bearbeiten, ? = Rückfrage. Komplette Liste oben rechts unter "⌨ Kürzel".',
    ],
    cta: 'Übersetzung jetzt prüfen',
    fallbackLink: 'Falls der Button nicht funktioniert, kopiere bitte diesen Link in deinen Browser:',
    thanks: 'Vielen Dank für die Unterstützung!',
    toTranslation: 'Zur Übersetzung',
    footerSentHtml: `Diese E-Mail wurde automatisch versendet von **${APP_HOST}**.`,
    footerReplyHtml: 'Bei Rückfragen antworte einfach direkt an',
    footerText: (e) => `Automatisch versendet von ${APP_HOST}. Rückfragen an ${e}.`,
    doneSubject: (p, s, t) => `Bereits erledigt: ${p} (${s} → ${t})`,
    doneHeading: 'Review bereits erledigt',
    doneParagraph: (r) => `${r} hat diese Übersetzung bereits geprüft und freigegeben. Du musst dafür nichts mehr tun.`,
    doneCta: 'Freigabe ansehen',
  },

  en: {
    colon: ':',
    greeting: (name) => `Hello ${name},`,
    documentLabel: 'Document',
    languagesLabel: 'Languages',
    segmentsLabel: 'Segments',
    segmentCount: (n) => (n === 1 ? '1 segment' : `${n} segments`),
    noticeFooterHtml: `This email was sent automatically by **${APP_HOST}**.`,
    noticeFooterText: `Sent automatically by ${APP_HOST}.`,
    requestSubject: (p, s, t) => `Review request: ${p} (${s} → ${t})`,
    requestHeading: 'Review request',
    introHtml:
      'we have created a machine translation and would be very grateful if you could take a look at it as a **native speaker**.',
    introText: [
      'we have created a machine translation and would be very grateful if you',
      'could take a look at it as a native speaker.',
    ],
    howItWorks: 'How it works:',
    stepsHtml: (r) => [
      'Click the button below — it takes you straight to the review editor.',
      'Sign in with your Microsoft account.',
      'For each segment: if the translation is correct, **tick the checkbox** (it turns into a green check mark). If something is wrong, simply click into the text and correct it.',
      'Use the **filters at the top** to focus on shortened segments or segments that need review.',
      `When everything is correct, click **“Approve translation”** at the top. Only then will ${r} know that you are done.`,
    ],
    stepsText: (r) => [
      'Open the link below.',
      'Sign in with your Microsoft account.',
      'For each segment: if the translation is correct, tick the checkbox.\nIf something is wrong, click into the text and correct it.',
      'Use the filters at the top to focus on shortened / review segments.',
      `When everything is correct, click "Approve translation" at the top. Only then will ${r} know that you are done.`,
    ],
    otherReviewers: (n) =>
      `This request was sent to ${n} people — whoever has time first does the review. If someone else approves it before you, you will receive a short message.`,
    noteLabel: 'Note:',
    noteHtml:
      'Terms with a dotted cyan underline come from our internal company glossary (e.g. brand names, product names). Please leave them unchanged if possible — unless the translation really does not work grammatically.',
    noteText: [
      'Note: Terms with a dotted cyan underline come from the company',
      'glossary (brand names, product names). Please leave them unchanged',
      'if possible.',
    ],
    keyboardLabel: '⌨ Faster with the keyboard:',
    spaceKey: 'Space',
    kbNextPrev: 'next/previous segment',
    kbSpace: 'confirm + next (flow mode)',
    kbEdit: 'edit',
    kbAsk: 'ask a question',
    kbFullListHtml: 'Full list at the top right under **“⌨ Shortcuts”**.',
    keyboardText: [
      'Keyboard tip: J/K = next/previous segment, Space = confirm + next,',
      'E = edit, ? = question. Full list at the top right under "⌨ Shortcuts".',
    ],
    cta: 'Review translation now',
    fallbackLink: "If the button doesn't work, please copy this link into your browser:",
    thanks: 'Thank you very much for your support!',
    toTranslation: 'Go to the translation',
    footerSentHtml: `This email was sent automatically by **${APP_HOST}**.`,
    footerReplyHtml: 'If you have any questions, simply reply directly to',
    footerText: (e) => `Sent automatically by ${APP_HOST}. Questions to ${e}.`,
    doneSubject: (p, s, t) => `Already done: ${p} (${s} → ${t})`,
    doneHeading: 'Review already done',
    doneParagraph: (r) => `${r} has already reviewed and approved this translation. There is nothing more you need to do.`,
    doneCta: 'View approval',
  },

  // Italienisch unpersönlich/Infinitiv wie im Review-Editor, keine „Lei"-Form.
  it: {
    colon: ':',
    greeting: (name) => `Buongiorno ${name},`,
    documentLabel: 'Documento',
    languagesLabel: 'Lingue',
    segmentsLabel: 'Segmenti',
    segmentCount: (n) => (n === 1 ? '1 segmento' : `${n} segmenti`),
    noticeFooterHtml: `Questa e-mail è stata inviata automaticamente da **${APP_HOST}**.`,
    noticeFooterText: `Inviata automaticamente da ${APP_HOST}.`,
    requestSubject: (p, s, t) => `Richiesta di revisione: ${p} (${s} → ${t})`,
    requestHeading: 'Richiesta di revisione',
    introHtml:
      'abbiamo creato una traduzione automatica e saremmo molto grati se un/una **madrelingua** potesse darle un’occhiata.',
    introText: [
      'abbiamo creato una traduzione automatica e saremmo molto grati se',
      'un/una madrelingua potesse darle un’occhiata.',
    ],
    howItWorks: 'Come funziona:',
    stepsHtml: (r) => [
      'Fare clic sul pulsante qui sotto per accedere direttamente all’editor di revisione.',
      'Accedere con il proprio account Microsoft.',
      'Per ogni segmento: se la traduzione è corretta, **spuntare la casella** (diventa un segno di spunta verde). Se qualcosa non va, fare semplicemente clic sul testo e correggerlo.',
      'Con i **filtri in alto** è possibile concentrarsi sui segmenti abbreviati o su quelli da revisionare.',
      `Se tutto è corretto, fare clic in alto su **«Approva traduzione»**. Solo così ${r} saprà che la revisione è conclusa.`,
    ],
    stepsText: (r) => [
      'Aprire il link qui sotto.',
      'Accedere con il proprio account Microsoft.',
      'Per ogni segmento: se la traduzione è corretta, spuntare la casella.\nSe qualcosa non va, fare clic sul testo e correggerlo.',
      'Con i filtri in alto concentrarsi sui segmenti abbreviati / da revisionare.',
      `Se tutto è corretto, fare clic in alto su "Approva traduzione". Solo così ${r} saprà che la revisione è conclusa.`,
    ],
    otherReviewers: (n) =>
      `Questa richiesta è stata inviata a ${n} persone: chi ha tempo per primo esegue la revisione. Se qualcun altro approva prima, arriverà un breve messaggio.`,
    noteLabel: 'Nota:',
    noteHtml:
      'I termini con sottolineatura punteggiata ciano provengono dal nostro glossario aziendale interno (ad es. nomi di marchi, denominazioni di prodotti). Se possibile, lasciarli invariati, a meno che la traduzione non funzioni davvero dal punto di vista grammaticale.',
    noteText: [
      'Nota: i termini con sottolineatura punteggiata ciano provengono dal',
      'glossario aziendale (nomi di marchi, denominazioni di prodotti). Se',
      'possibile, lasciarli invariati.',
    ],
    keyboardLabel: '⌨ Più veloce con la tastiera:',
    spaceKey: 'Barra spaziatrice',
    kbNextPrev: 'segmento successivo/precedente',
    kbSpace: 'conferma + avanti (modalità flusso)',
    kbEdit: 'modifica',
    kbAsk: 'fare una domanda',
    kbFullListHtml: 'Elenco completo in alto a destra in **«⌨ Scorciatoie»**.',
    keyboardText: [
      'Suggerimento: J/K = segmento successivo/precedente, barra spaziatrice = conferma + avanti,',
      'E = modifica, ? = domanda. Elenco completo in alto a destra in "⌨ Scorciatoie".',
    ],
    cta: 'Verificare ora la traduzione',
    fallbackLink: 'Se il pulsante non funziona, copiare questo link nel browser:',
    thanks: 'Grazie mille per il supporto!',
    toTranslation: 'Alla traduzione',
    footerSentHtml: `Questa e-mail è stata inviata automaticamente da **${APP_HOST}**.`,
    footerReplyHtml: 'Per domande, rispondere direttamente a',
    footerText: (e) => `Inviata automaticamente da ${APP_HOST}. Domande a ${e}.`,
    doneSubject: (p, s, t) => `Già completata: ${p} (${s} → ${t})`,
    doneHeading: 'Revisione già completata',
    doneParagraph: (r) => `${r} ha già verificato e approvato questa traduzione. Non è necessario fare altro.`,
    doneCta: 'Visualizzare l’approvazione',
  },

  fr: {
    colon: ' :',
    greeting: (name) => `Bonjour ${name},`,
    documentLabel: 'Document',
    languagesLabel: 'Langues',
    segmentsLabel: 'Segments',
    segmentCount: (n) => (n <= 1 ? `${n} segment` : `${n} segments`),
    noticeFooterHtml: `Cet e-mail a été envoyé automatiquement par **${APP_HOST}**.`,
    noticeFooterText: `Envoyé automatiquement par ${APP_HOST}.`,
    requestSubject: (p, s, t) => `Demande de relecture : ${p} (${s} → ${t})`,
    requestHeading: 'Demande de relecture',
    introHtml:
      'nous avons réalisé une traduction automatique et vous serions très reconnaissants de bien vouloir la relire en tant que **locuteur natif**.',
    introText: [
      'nous avons réalisé une traduction automatique et vous serions très',
      'reconnaissants de bien vouloir la relire en tant que locuteur natif.',
    ],
    howItWorks: 'Voici comment procéder :',
    stepsHtml: (r) => [
      'Cliquez sur le bouton ci-dessous : vous accédez directement à l’éditeur de relecture.',
      'Connectez-vous avec votre compte Microsoft.',
      'Pour chaque segment : si la traduction est correcte, **cochez la case** (elle devient une coche verte). Si quelque chose ne va pas, cliquez simplement dans le texte et corrigez-le.',
      'Les **filtres en haut** vous permettent de vous concentrer sur les segments abrégés ou à relire.',
      `Si tout est correct, cliquez en haut sur **« Valider la traduction »**. Ce n’est qu’alors que ${r} saura que vous avez terminé.`,
    ],
    stepsText: (r) => [
      'Ouvrez le lien ci-dessous.',
      'Connectez-vous avec votre compte Microsoft.',
      'Pour chaque segment : si la traduction est correcte, cochez la case.\nSi quelque chose ne va pas, cliquez dans le texte et corrigez-le.',
      'Utilisez les filtres en haut pour cibler les segments abrégés / à relire.',
      `Si tout est correct, cliquez en haut sur « Valider la traduction ». Ce n’est qu’alors que ${r} saura que vous avez terminé.`,
    ],
    otherReviewers: (n) =>
      `Cette demande a été envoyée à ${n} personnes : la première disponible effectue la relecture. Si quelqu’un d’autre valide avant vous, vous recevrez un court message.`,
    noteLabel: 'Remarque :',
    noteHtml:
      'Les termes soulignés en pointillés cyan proviennent de notre glossaire interne (p. ex. noms de marques, désignations de produits). Veuillez si possible les laisser inchangés, sauf si la traduction ne fonctionne vraiment pas sur le plan grammatical.',
    noteText: [
      'Remarque : les termes soulignés en pointillés cyan proviennent du',
      'glossaire de l’entreprise (noms de marques, désignations de produits).',
      'Veuillez si possible les laisser inchangés.',
    ],
    keyboardLabel: '⌨ Plus rapide au clavier :',
    spaceKey: 'Espace',
    kbNextPrev: 'segment suivant/précédent',
    kbSpace: 'valider + suivant (mode flux)',
    kbEdit: 'modifier',
    kbAsk: 'poser une question',
    kbFullListHtml: 'Liste complète en haut à droite sous **« ⌨ Raccourcis »**.',
    keyboardText: [
      'Astuce clavier : J/K = segment suivant/précédent, Espace = valider + suivant,',
      'E = modifier, ? = question. Liste complète en haut à droite sous « ⌨ Raccourcis ».',
    ],
    cta: 'Relire la traduction',
    fallbackLink: 'Si le bouton ne fonctionne pas, veuillez copier ce lien dans votre navigateur :',
    thanks: 'Merci beaucoup pour votre aide !',
    toTranslation: 'Accéder à la traduction',
    footerSentHtml: `Cet e-mail a été envoyé automatiquement par **${APP_HOST}**.`,
    footerReplyHtml: 'Pour toute question, répondez simplement à',
    footerText: (e) => `Envoyé automatiquement par ${APP_HOST}. Questions : ${e}.`,
    doneSubject: (p, s, t) => `Déjà traité : ${p} (${s} → ${t})`,
    doneHeading: 'Relecture déjà effectuée',
    doneParagraph: (r) => `${r} a déjà relu et validé cette traduction. Vous n’avez plus rien à faire.`,
    doneCta: 'Voir la validation',
  },

  // Ungarisch: formelle „Ön"-Form; nach „Kedves …!" beginnt der Text groß.
  hu: {
    colon: ':',
    greeting: (name) => `Kedves ${name}!`,
    documentLabel: 'Dokumentum',
    languagesLabel: 'Nyelvek',
    segmentsLabel: 'Szegmensek',
    segmentCount: (n) => `${n} szegmens`,
    noticeFooterHtml: `Ezt az e-mailt a **${APP_HOST}** küldte automatikusan.`,
    noticeFooterText: `Automatikusan küldte: ${APP_HOST}.`,
    requestSubject: (p, s, t) => `Lektorálási kérés: ${p} (${s} → ${t})`,
    requestHeading: 'Lektorálási kérés',
    introHtml:
      'Gépi fordítást készítettünk, és nagyon hálásak lennénk, ha **anyanyelvi lektorként** átnézné.',
    introText: [
      'Gépi fordítást készítettünk, és nagyon hálásak lennénk, ha',
      'anyanyelvi lektorként átnézné.',
    ],
    howItWorks: 'Így működik:',
    stepsHtml: (r) => [
      'Kattintson az alábbi gombra – ezzel közvetlenül a lektoráló szerkesztőbe jut.',
      'Jelentkezzen be Microsoft-fiókjával.',
      'Minden szegmensnél: ha a fordítás megfelelő, **jelölje be a jelölőnégyzetet** (zöld pipa lesz belőle). Ha valami nem stimmel, egyszerűen kattintson a szövegbe, és javítsa ki.',
      'A **fenti szűrőkkel** célzottan a rövidített vagy lektorálást igénylő szegmensekre koncentrálhat.',
      `Ha minden rendben van, kattintson fent a **„Fordítás jóváhagyása”** gombra. ${r} csak ebből tudja meg, hogy Ön végzett.`,
    ],
    stepsText: (r) => [
      'Nyissa meg az alábbi linket.',
      'Jelentkezzen be Microsoft-fiókjával.',
      'Minden szegmensnél: ha a fordítás megfelelő, jelölje be a jelölőnégyzetet.\nHa valami nem stimmel, kattintson a szövegbe, és javítsa ki.',
      'A fenti szűrőkkel koncentráljon a rövidített / lektorálandó szegmensekre.',
      `Ha minden rendben van, kattintson fent a „Fordítás jóváhagyása” gombra. ${r} csak ebből tudja meg, hogy Ön végzett.`,
    ],
    otherReviewers: (n) =>
      `Ez a kérés ${n} személynek ment ki – aki előbb ráér, az lektorál. Ha valaki más előbb jóváhagyja, erről rövid értesítést kap.`,
    noteLabel: 'Megjegyzés:',
    noteHtml:
      'A pontozott ciánkék aláhúzással jelölt kifejezések belső vállalati glosszáriumunkból származnak (pl. márkanevek, termékmegnevezések). Ezeket lehetőleg hagyja változatlanul – kivéve, ha a fordítás nyelvtanilag valóban nem helyes.',
    noteText: [
      'Megjegyzés: a pontozott ciánkék aláhúzással jelölt kifejezések a vállalati',
      'glosszáriumból származnak (márkanevek, termékmegnevezések). Lehetőleg',
      'hagyja őket változatlanul.',
    ],
    keyboardLabel: '⌨ Gyorsabban billentyűzettel:',
    spaceKey: 'Szóköz',
    kbNextPrev: 'következő/előző szegmens',
    kbSpace: 'jóváhagyás + tovább (folyamatos mód)',
    kbEdit: 'szerkesztés',
    kbAsk: 'kérdés feltevése',
    kbFullListHtml: 'A teljes lista jobbra fent, a **„⌨ Billentyűk”** alatt található.',
    keyboardText: [
      'Billentyűzet-tipp: J/K = következő/előző szegmens, Szóköz = jóváhagyás + tovább,',
      'E = szerkesztés, ? = kérdés. Teljes lista jobbra fent: „⌨ Billentyűk”.',
    ],
    cta: 'Fordítás ellenőrzése',
    fallbackLink: 'Ha a gomb nem működik, másolja be ezt a linket a böngészőjébe:',
    thanks: 'Köszönjük szépen a segítségét!',
    toTranslation: 'A fordításhoz',
    footerSentHtml: `Ezt az e-mailt a **${APP_HOST}** küldte automatikusan.`,
    footerReplyHtml: 'Kérdés esetén válaszoljon közvetlenül erre a címre:',
    footerText: (e) => `Automatikusan küldte: ${APP_HOST}. Kérdések: ${e}.`,
    doneSubject: (p, s, t) => `Már elintézve: ${p} (${s} → ${t})`,
    doneHeading: 'A lektorálás már megtörtént',
    doneParagraph: (r) => `${r} már ellenőrizte és jóváhagyta ezt a fordítást. Önnek nincs további teendője.`,
    doneCta: 'Jóváhagyás megtekintése',
  },

  // Slowakisch: Vykanie, „Vám" in der Anrede groß.
  sk: {
    colon: ':',
    greeting: (name) => `Dobrý deň, ${name},`,
    documentLabel: 'Dokument',
    languagesLabel: 'Jazyky',
    segmentsLabel: 'Segmenty',
    segmentCount: (n) => (n === 1 ? '1 segment' : n >= 2 && n <= 4 ? `${n} segmenty` : `${n} segmentov`),
    noticeFooterHtml: `Tento e-mail bol odoslaný automaticky zo systému **${APP_HOST}**.`,
    noticeFooterText: `Automaticky odoslané zo systému ${APP_HOST}.`,
    requestSubject: (p, s, t) => `Žiadosť o revíziu: ${p} (${s} → ${t})`,
    requestHeading: 'Žiadosť o revíziu',
    introHtml:
      'vytvorili sme strojový preklad a boli by sme Vám veľmi vďační, keby ste sa naň ako **rodený hovorca** pozreli.',
    introText: [
      'vytvorili sme strojový preklad a boli by sme Vám veľmi vďační, keby ste',
      'sa naň ako rodený hovorca pozreli.',
    ],
    howItWorks: 'Ako to funguje:',
    stepsHtml: (r) => [
      'Kliknite na tlačidlo nižšie – dostanete sa priamo do editora revízie.',
      'Prihláste sa svojím kontom Microsoft.',
      'Pri každom segmente: ak je preklad správny, **začiarknite políčko** (zmení sa na zelenú fajku). Ak niečo nesedí, jednoducho kliknite do textu a opravte ho.',
      'Pomocou **filtrov hore** sa môžete zamerať na skrátené segmenty alebo segmenty, ktoré potrebujú revíziu.',
      `Ak je všetko v poriadku, kliknite hore na **„Schváliť preklad“**. Až potom bude ${r} vedieť, že ste skončili.`,
    ],
    stepsText: (r) => [
      'Otvorte odkaz nižšie.',
      'Prihláste sa svojím kontom Microsoft.',
      'Pri každom segmente: ak je preklad správny, začiarknite políčko.\nAk niečo nesedí, kliknite do textu a opravte ho.',
      'Pomocou filtrov hore sa zamerajte na skrátené segmenty / segmenty na revíziu.',
      `Ak je všetko v poriadku, kliknite hore na „Schváliť preklad“. Až potom bude ${r} vedieť, že ste skončili.`,
    ],
    otherReviewers: (n) =>
      `Táto žiadosť bola odoslaná ${n} osobám – kto má čas skôr, urobí revíziu. Ak niekto iný schváli preklad pred Vami, dostanete krátku správu.`,
    noteLabel: 'Upozornenie:',
    noteHtml:
      'Výrazy s bodkovaným azúrovým podčiarknutím pochádzajú z nášho interného firemného glosára (napr. názvy značiek, označenia produktov). Ak je to možné, ponechajte ich bez zmeny – pokiaľ preklad naozaj nesedí gramaticky.',
    noteText: [
      'Upozornenie: výrazy s bodkovaným azúrovým podčiarknutím pochádzajú z',
      'firemného glosára (názvy značiek, označenia produktov). Ak je to možné,',
      'ponechajte ich bez zmeny.',
    ],
    keyboardLabel: '⌨ Rýchlejšie s klávesnicou:',
    spaceKey: 'Medzerník',
    kbNextPrev: 'ďalší/predchádzajúci segment',
    kbSpace: 'potvrdiť + ďalej (plynulý režim)',
    kbEdit: 'upraviť',
    kbAsk: 'položiť otázku',
    kbFullListHtml: 'Úplný zoznam nájdete vpravo hore pod **„⌨ Skratky“**.',
    keyboardText: [
      'Tip: J/K = ďalší/predchádzajúci segment, Medzerník = potvrdiť + ďalej,',
      'E = upraviť, ? = otázka. Úplný zoznam vpravo hore pod „⌨ Skratky“.',
    ],
    cta: 'Skontrolovať preklad',
    fallbackLink: 'Ak tlačidlo nefunguje, skopírujte tento odkaz do prehliadača:',
    thanks: 'Ďakujeme veľmi pekne za pomoc!',
    toTranslation: 'Na preklad',
    footerSentHtml: `Tento e-mail bol odoslaný automaticky zo systému **${APP_HOST}**.`,
    footerReplyHtml: 'S otázkami odpovedzte priamo na adresu',
    footerText: (e) => `Automaticky odoslané zo systému ${APP_HOST}. Otázky na ${e}.`,
    doneSubject: (p, s, t) => `Už vybavené: ${p} (${s} → ${t})`,
    doneHeading: 'Revízia je už hotová',
    doneParagraph: (r) => `Tento preklad už skontroloval(a) a schválil(a) ${r}. Nemusíte už nič robiť.`,
    doneCta: 'Zobraziť schválenie',
  },
};

/** Escaped Text, `**…**` wird zu `<strong>…</strong>`. */
function richHtml(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/** Beschriftung auf gemeinsame Breite bringen: „Dokument:    Wert". */
function textLabels(labels: string[], colon: string): (label: string) => string {
  const width = Math.max(13, ...labels.map((l) => l.length + colon.length + 2));
  return (label) => `${label}${colon}`.padEnd(width);
}

/**
 * Template fuer Native-Speaker-Reviewer-Anfrage.
 *
 * Layout: schlicht, Cyan als Akzent (#00B9F1), gut auf mobile lesbar.
 * Kein Footer-Logo-Bild, weil noreply@-Mails sonst oft als Spam markiert
 * werden — nur Text-Branding.
 */
export function buildReviewRequestEmail(params: {
  speakerName: string;
  requesterName: string;
  requesterEmail: string;
  projectName: string;
  sourceLang: string;
  targetLang: string;
  segmentCount: number;
  reviewUrl: string;
  message?: string | null;
  /** Anzahl weiterer Personen, die dieselbe Anfrage erhalten haben. */
  otherReviewerCount?: number;
  /** Sprache der Mail; ohne Angabe aus `targetLang` abgeleitet. */
  lang?: MailLang;
}): { subject: string; html: string; text: string } {
  const {
    speakerName,
    requesterName,
    requesterEmail,
    projectName,
    sourceLang,
    targetLang,
    segmentCount,
    reviewUrl,
    message,
    otherReviewerCount = 0,
  } = params;
  const lang = params.lang ?? mailLangFor(targetLang);
  const T = REVIEWER_MAIL_TEXTS[lang];

  // Bei mehreren Angefragten klarstellen, dass eine Freigabe genügt.
  const otherReviewersNote = otherReviewerCount > 0
    ? T.otherReviewers(otherReviewerCount + 1)
    : null;
  const otherReviewersHtml = otherReviewersNote
    ? `<p style="margin:0 0 18px 0;font-size:13px;line-height:1.5;color:#374151;">${escapeHtml(otherReviewersNote)}</p>`
    : '';

  const subject = T.requestSubject(projectName, sourceLang, targetLang);

  // Die persönliche Nachricht der anfragenden Person bleibt, wie sie ist.
  const messageBlockHtml = message
    ? `<p style="margin:16px 0;padding:12px 14px;background:#f6f8fa;border-left:3px solid #00B9F1;color:#1f2937;font-style:italic;">${escapeHtml(message)}</p>`
    : '';

  const messageBlockText = message ? `\n\n„${message}"\n` : '';

  const kbd = (k: string) =>
    `<code style="background:#fff;border:1px solid #d1d5db;border-radius:3px;padding:1px 5px;font-size:11px;">${escapeHtml(k)}</code>`;

  const stepsHtml = T.stepsHtml(requesterName)
    .map((s) => `<li>${richHtml(s)}</li>`)
    .join('\n            ');

  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">

        <!-- Header -->
        <tr><td style="background:#1f2937;padding:18px 28px;">
          <div style="color:#ffffff;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.7;">${escapeHtml(MAIL_KOPF)}</div>
          <div style="color:#ffffff;font-size:20px;font-weight:600;margin-top:2px;">${escapeHtml(T.requestHeading)}</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;">${escapeHtml(T.greeting(speakerName))}</p>

          <p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;">
            ${richHtml(T.introHtml)}
          </p>

          ${messageBlockHtml}

          <!-- Projekt-Karte -->
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:18px 0;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;">
            <tr><td style="padding:14px 16px;">
              <div style="font-size:13px;color:#6b7280;margin-bottom:4px;">${escapeHtml(T.documentLabel)}</div>
              <div style="font-size:15px;font-weight:600;color:#111827;word-break:break-word;">${escapeHtml(projectName)}</div>
              <div style="margin-top:10px;font-size:13px;color:#374151;">
                <span style="display:inline-block;padding:2px 8px;background:#00B9F1;color:#ffffff;border-radius:3px;font-weight:600;font-size:12px;letter-spacing:0.5px;">${escapeHtml(sourceLang)} → ${escapeHtml(targetLang)}</span>
                <span style="margin-left:10px;color:#6b7280;">${escapeHtml(T.segmentCount(segmentCount))}</span>
              </div>
            </td></tr>
          </table>

          <p style="margin:18px 0 8px 0;font-size:15px;line-height:1.55;">
            ${escapeHtml(T.howItWorks)}
          </p>
          <ol style="margin:0 0 18px 20px;padding:0;font-size:14px;line-height:1.7;color:#374151;">
            ${stepsHtml}
          </ol>
          ${otherReviewersHtml}
          <p style="margin:14px 0 12px 0;font-size:13px;line-height:1.5;color:#6b7280;padding:10px 14px;background:#f0f9ff;border-left:3px solid #00B9F1;border-radius:0 4px 4px 0;">
            <strong style="color:#0c4a6e;">${escapeHtml(T.noteLabel)}</strong> ${richHtml(T.noteHtml)}
          </p>

          <p style="margin:0 0 18px 0;font-size:13px;line-height:1.6;color:#6b7280;padding:10px 14px;background:#fafafa;border:1px solid #e5e7eb;border-radius:6px;">
            <strong style="color:#374151;">${escapeHtml(T.keyboardLabel)}</strong>
            ${kbd('J')}/${kbd('K')} = ${escapeHtml(T.kbNextPrev)},
            ${kbd(T.spaceKey)} = ${escapeHtml(T.kbSpace)},
            ${kbd('E')} = ${escapeHtml(T.kbEdit)},
            ${kbd('?')} = ${escapeHtml(T.kbAsk)}.
            ${richHtml(T.kbFullListHtml)}
          </p>

          <!-- CTA -->
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
            <tr><td style="border-radius:6px;background:#00B9F1;">
              <a href="${escapeAttr(reviewUrl)}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">${escapeHtml(T.cta)} →</a>
            </td></tr>
          </table>

          <p style="margin:14px 0 0 0;font-size:12px;color:#6b7280;line-height:1.5;">
            ${escapeHtml(T.fallbackLink)}<br>
            <a href="${escapeAttr(reviewUrl)}" style="color:#00B9F1;word-break:break-all;">${escapeHtml(reviewUrl)}</a>
          </p>

          <p style="margin:24px 0 0 0;font-size:14px;color:#374151;line-height:1.55;">
            ${escapeHtml(T.thanks)}<br>
            <span style="color:#6b7280;">${escapeHtml(requesterName)}</span>
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:14px 28px;border-top:1px solid #e5e7eb;">
          <div style="font-size:11px;color:#9ca3af;line-height:1.5;">
            ${richHtml(T.footerSentHtml)}
            ${escapeHtml(T.footerReplyHtml)}
            <a href="mailto:${escapeAttr(requesterEmail)}" style="color:#6b7280;">${escapeHtml(requesterEmail)}</a>.
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const label = textLabels([T.documentLabel, T.languagesLabel, T.segmentsLabel], T.colon);
  const text = [
    T.greeting(speakerName),
    '',
    ...T.introText,
    messageBlockText.trim() ? messageBlockText.trim() : null,
    '',
    `${label(T.documentLabel)}${projectName}`,
    `${label(T.languagesLabel)}${sourceLang} → ${targetLang}`,
    `${label(T.segmentsLabel)}${segmentCount}`,
    '',
    T.howItWorks,
    ...T.stepsText(requesterName).map((s, i) => `  ${i + 1}. ${s.split('\n').join('\n     ')}`),
    otherReviewersNote ? '' : null,
    otherReviewersNote,
    '',
    ...T.noteText,
    '',
    ...T.keyboardText,
    '',
    `${T.toTranslation}${T.colon} ${reviewUrl}`,
    '',
    T.thanks,
    requesterName,
    '',
    '---',
    T.footerText(requesterEmail),
  ]
    .filter((l) => l !== null)
    .join('\n');

  return { subject, html, text };
}

/** Beschriftungen des Notice-Layouts; die internen Mails nutzen Deutsch. */
interface NoticeLabels {
  lang: MailLang;
  colon: string;
  documentLabel: string;
  languagesLabel: string;
  footerHtml: string;
  footerText: string;
}

function noticeLabels(lang: MailLang): NoticeLabels {
  const T = REVIEWER_MAIL_TEXTS[lang];
  return {
    lang,
    colon: T.colon,
    documentLabel: T.documentLabel,
    languagesLabel: T.languagesLabel,
    footerHtml: T.noticeFooterHtml,
    footerText: T.noticeFooterText,
  };
}

/**
 * Schlichte Benachrichtigung im selben Look wie die Review-Anfrage — für die
 * Freigabe-Meldungen, die nur einen Sachverhalt und einen Link tragen.
 */
function buildNoticeEmail(params: {
  subject: string;
  heading: string;
  greeting: string;
  paragraphs: string[];
  projectName: string;
  sourceLang: string;
  targetLang: string;
  ctaLabel: string;
  ctaUrl: string;
  labels?: NoticeLabels;
}): { subject: string; html: string; text: string } {
  const { subject, heading, greeting, paragraphs, projectName, sourceLang, targetLang, ctaLabel, ctaUrl } = params;
  const L = params.labels ?? noticeLabels('de');

  const paragraphsHtml = paragraphs
    .map((p) => `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;">${escapeHtml(p)}</p>`)
    .join('\n          ');

  const html = `<!doctype html>
<html lang="${L.lang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <tr><td style="background:#1f2937;padding:18px 28px;">
          <div style="color:#ffffff;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.7;">${escapeHtml(MAIL_KOPF)}</div>
          <div style="color:#ffffff;font-size:20px;font-weight:600;margin-top:2px;">${escapeHtml(heading)}</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;">${escapeHtml(greeting)}</p>
          ${paragraphsHtml}
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:18px 0;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;">
            <tr><td style="padding:14px 16px;">
              <div style="font-size:13px;color:#6b7280;margin-bottom:4px;">${escapeHtml(L.documentLabel)}</div>
              <div style="font-size:15px;font-weight:600;color:#111827;word-break:break-word;">${escapeHtml(projectName)}</div>
              <div style="margin-top:10px;">
                <span style="display:inline-block;padding:2px 8px;background:#00B9F1;color:#ffffff;border-radius:3px;font-weight:600;font-size:12px;letter-spacing:0.5px;">${escapeHtml(sourceLang)} → ${escapeHtml(targetLang)}</span>
              </div>
            </td></tr>
          </table>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 0 0;">
            <tr><td style="border-radius:6px;background:#00B9F1;">
              <a href="${escapeAttr(ctaUrl)}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">${escapeHtml(ctaLabel)} →</a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:14px 28px;border-top:1px solid #e5e7eb;">
          <div style="font-size:11px;color:#9ca3af;line-height:1.5;">
            ${richHtml(L.footerHtml)}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const label = textLabels([L.documentLabel, L.languagesLabel], L.colon);
  const text = [
    greeting,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    `${label(L.documentLabel)}${projectName}`,
    `${label(L.languagesLabel)}${sourceLang} → ${targetLang}`,
    '',
    `${ctaLabel}${L.colon} ${ctaUrl}`,
    '',
    '---',
    L.footerText,
  ].join('\n');

  return { subject, html, text };
}

interface NoticeProject {
  projectName: string;
  sourceLang: string;
  targetLang: string;
  projectUrl: string;
}

/** An die Person, die die Prüfung angefragt hat: ein Reviewer hat freigegeben. */
export function buildReleaseConfirmedEmail(params: NoticeProject & {
  recipientName: string;
  reviewerName: string;
  segmentCount: number;
}): { subject: string; html: string; text: string } {
  return buildNoticeEmail({
    subject: `Freigegeben: ${params.projectName} (${params.sourceLang} → ${params.targetLang})`,
    heading: 'Übersetzung freigegeben',
    greeting: `Hallo ${params.recipientName},`,
    paragraphs: [
      `${params.reviewerName} hat die Übersetzung geprüft und freigegeben. Alle ${params.segmentCount} übersetzten Segmente sind abgehakt, Rückfragen stehen keine mehr offen.`,
      'Ändert sich der Text danach noch, fällt die Freigabe automatisch weg, und du bekommst eine Nachricht.',
    ],
    ...params,
    ctaLabel: 'Zum Projekt',
    ctaUrl: params.projectUrl,
  });
}

/**
 * An die übrigen Angefragten (Native Speaker): jemand anderes hat schon
 * freigegeben. Geht in deren Sprache, siehe `mailLangFor`.
 */
export function buildReleaseDoneByOtherEmail(params: NoticeProject & {
  recipientName: string;
  reviewerName: string;
  /** Sprache der Mail; ohne Angabe aus `targetLang` abgeleitet. */
  lang?: MailLang;
}): { subject: string; html: string; text: string } {
  const lang = params.lang ?? mailLangFor(params.targetLang);
  const T = REVIEWER_MAIL_TEXTS[lang];
  return buildNoticeEmail({
    subject: T.doneSubject(params.projectName, params.sourceLang, params.targetLang),
    heading: T.doneHeading,
    greeting: T.greeting(params.recipientName),
    paragraphs: [T.doneParagraph(params.reviewerName)],
    projectName: params.projectName,
    sourceLang: params.sourceLang,
    targetLang: params.targetLang,
    ctaLabel: T.doneCta,
    ctaUrl: params.projectUrl,
    labels: noticeLabels(lang),
  });
}

export const REVOKE_REASON_LABELS: Record<string, string> = {
  text_changed: 'der übersetzte Text wurde nach der Freigabe geändert',
  unapproved: 'bei einem Segment wurde der Haken wieder entfernt',
  clarification: 'zu einem Segment wurde eine Rückfrage gestellt',
};

/** An die Person, die die Prüfung angefragt hat: die Freigabe gilt nicht mehr. */
export function buildReleaseRevokedEmail(params: NoticeProject & {
  recipientName: string;
  reviewerName: string;
  releasedAt: Date;
  reason: string;
  changedByName: string | null;
}): { subject: string; html: string; text: string } {
  const when = params.releasedAt.toLocaleString('de-AT', {
    timeZone: 'Europe/Vienna',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const reasonLabel = REVOKE_REASON_LABELS[params.reason] || params.reason;
  const by = params.changedByName ? ` (durch ${params.changedByName})` : '';
  return buildNoticeEmail({
    subject: `Freigabe aufgehoben: ${params.projectName} (${params.sourceLang} → ${params.targetLang})`,
    heading: 'Freigabe aufgehoben',
    greeting: `Hallo ${params.recipientName},`,
    paragraphs: [
      `Die Freigabe von ${params.reviewerName} vom ${when} gilt nicht mehr: ${reasonLabel}${by}.`,
      'Bitte die Übersetzung vor der Verwendung erneut prüfen lassen.',
    ],
    ...params,
    ctaLabel: 'Zum Projekt',
    ctaUrl: params.projectUrl,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
