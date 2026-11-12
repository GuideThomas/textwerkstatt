-- Einleseprotokoll der Prüftabellen für die Namensbausteine.
--
-- Bauplan `Artikelanlage-Assistent/docs/BAUPLAN-Bausteine-Phase2.md` §7 und §10 Schritt 4, Cockpit #1767. Je Wortpaar einer
-- Prüftabelle steht hier, was beim Einlesen daraus wurde: freigegebener Baustein, Vorschlag, schon bekannt, Rückfrage, oder
-- bewusst nicht in der Tabelle (Wertform, Regel, Form noch offen). Die Rückfrageliste ist eine Abfrage auf diese Tabelle.
--
-- Ein Lauf ist eine Datei einer Sprache (`lauf`). Der Prüfwert der Datei (`datei_sha256`) bindet jede Zeile an genau die
-- Fassung, die der Prüfer beantwortet hat.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

CREATE TABLE IF NOT EXISTS namens_einlesen_protokoll (
  id            BIGSERIAL PRIMARY KEY,
  lauf          UUID NOT NULL,
  datei         TEXT NOT NULL,
  datei_sha256  TEXT NOT NULL CHECK (datei_sha256 ~ '^[0-9a-f]{64}$'),
  sprache       TEXT NOT NULL CHECK (sprache IN ('EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ')),
  blatt_zeile   INTEGER NOT NULL,
  nummer        INTEGER NOT NULL,
  thema         TEXT NOT NULL,
  deutsch       TEXT NOT NULL,
  vorschlag     TEXT NOT NULL,
  antwort       TEXT,
  ergebnis      TEXT NOT NULL CHECK (ergebnis IN (
                  'freigegeben', 'vorlaeufig', 'bekannt', 'doppelt', 'rueckfrage', 'wertform', 'regel', 'form_offen')),
  grund         TEXT,
  baustein_id   UUID,
  von           TEXT NOT NULL CHECK (btrim(von) <> ''),
  am            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_namens_einlesen_protokoll_lauf ON namens_einlesen_protokoll (lauf);
CREATE INDEX IF NOT EXISTS idx_namens_einlesen_protokoll_offen ON namens_einlesen_protokoll (sprache, ergebnis)
  WHERE ergebnis IN ('rueckfrage', 'form_offen');
-- Eine beantwortete Datei wird einmal eingelesen; ein zweiter Lauf derselben Fassung hält an. Das Deutsch gehört zum Schlüssel,
-- weil ein Paar mit zwei deutschen Formen („beidseitig (beids.)“) zu zwei Zeilen mit derselben Nummer wird.
CREATE UNIQUE INDEX IF NOT EXISTS uq_namens_einlesen_protokoll_paar
  ON namens_einlesen_protokoll (datei_sha256, blatt_zeile, nummer, deutsch);
COMMENT ON TABLE namens_einlesen_protokoll IS
  'Je Wortpaar einer eingelesenen Prüftabelle: was daraus wurde. rueckfrage und form_offen sind die offene Liste.';
