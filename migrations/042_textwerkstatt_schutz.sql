-- Textwerkstatt Phase 3: Schutzregeln der Pseudonymisierung (Klassen an/aus, Muster der Artikelnummer, Schutzliste).
--
-- Plan `PLAN-textwerkstatt.md` §4 Phase 3 (Cockpit #1839). Die Erkennung selbst steht in `services/pseudonym/`.
--
-- Pflichtklassen: Bankverbindung (BANK), Mail (MAIL) und Telefon (TELEFON) lassen sich nicht abschalten (Entscheid Thomas
-- 10.11.2026). Das prüfen drei Stellen unabhängig voneinander: der CHECK hier, die Route `PUT /schutz/klassen/:k` und der
-- Code der Vorschau, der eine Pflichtklasse aus der Tabelle übergeht.
--
-- Diese Datei enthält keine Füllung einer Installation (G5). Die Füllung kommt aus `043_textwerkstatt_schutz_seed.sql`;
-- für die leere Fassung des öffentlichen Repos lässt man die Seed-Datei weg.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

CREATE TABLE IF NOT EXISTS textwerkstatt_schutzklassen (
  klasse        TEXT PRIMARY KEY CHECK (klasse IN ('BANK', 'MAIL', 'TELEFON', 'PERSON', 'ANSCHRIFT', 'URL', 'FIRMA', 'PROJEKT',
                                                   'PREIS', 'ARTIKELNR', 'BELEGNR')),
  aktiv         BOOLEAN NOT NULL DEFAULT TRUE,
  -- Muster einer Artikelnummer ohne Kennwort davor (regulärer Ausdruck). Leer: Artikelnummern fallen nur hinter einem
  -- Kennwort wie „Art.-Nr.“ oder „EAN“.
  muster        TEXT,
  geaendert_von UUID REFERENCES users(id) ON DELETE SET NULL,
  geaendert_am  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT textwerkstatt_pflichtklasse_bleibt_an CHECK (aktiv OR klasse NOT IN ('BANK', 'MAIL', 'TELEFON')),
  CONSTRAINT textwerkstatt_muster_nur_artikelnr CHECK (muster IS NULL OR (klasse = 'ARTIKELNR' AND length(muster) BETWEEN 1 AND 200))
);

INSERT INTO textwerkstatt_schutzklassen (klasse)
VALUES ('BANK'), ('MAIL'), ('TELEFON'), ('PERSON'), ('ANSCHRIFT'), ('URL'), ('FIRMA'), ('PROJEKT'), ('PREIS'), ('ARTIKELNR'),
       ('BELEGNR')
ON CONFLICT (klasse) DO NOTHING;

-- Begriffe, die immer verdeckt werden (Kunden, Projekte, Personen). Die Art bestimmt den Platzhalter ([FIRMA_1] …), damit
-- das Modell weiß, wovon die Rede ist. Eckige Klammern sind verboten: Sie sähen aus wie ein Platzhalter.
CREATE TABLE IF NOT EXISTS textwerkstatt_schutzliste (
  id           BIGSERIAL PRIMARY KEY,
  begriff      TEXT NOT NULL,
  art          TEXT NOT NULL DEFAULT 'BEGRIFF' CHECK (art IN ('PERSON', 'FIRMA', 'PROJEKT', 'BEGRIFF')),
  angelegt_von UUID REFERENCES users(id) ON DELETE SET NULL,
  angelegt_am  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT textwerkstatt_schutzliste_begriff CHECK (char_length(btrim(begriff)) BETWEEN 2 AND 200 AND begriff !~ '[][]')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_textwerkstatt_schutzliste_begriff ON textwerkstatt_schutzliste (lower(btrim(begriff)));

-- Verlauf jeder Änderung an Klassen und Schutzliste: wer, wann, was.
CREATE TABLE IF NOT EXISTS textwerkstatt_schutz_verlauf (
  id         BIGSERIAL PRIMARY KEY,
  bereich    TEXT NOT NULL CHECK (bereich IN ('klasse', 'liste')),
  schluessel TEXT NOT NULL,
  aktion     TEXT NOT NULL CHECK (aktion IN ('angelegt', 'geaendert', 'geloescht')),
  felder     JSONB NOT NULL,
  von        UUID REFERENCES users(id) ON DELETE SET NULL,
  am         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_textwerkstatt_schutz_verlauf ON textwerkstatt_schutz_verlauf (bereich, schluessel, am DESC);
