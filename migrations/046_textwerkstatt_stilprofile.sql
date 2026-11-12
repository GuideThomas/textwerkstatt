-- Textwerkstatt Phase 5: Stilprofile je Channel und aus Referenzen.
--
-- Plan `PLAN-textwerkstatt.md` §4 Phase 5 (Cockpit #1841). Der Ablauf steht in `services/optimieren/stilprofile.ts` und
-- `services/optimieren/referenz.ts`.
--
-- Ein Stilprofil ist eine Beschreibung des Schreibstils und ein paar Beispielsätze. Beides geht im Schritt „Optimieren“ als
-- Teil der Anweisung an das Modell; die harte Prüfung danach (Zahlen, Platzhalter, Hausschreibweise, Anrede, Länge) gilt
-- unverändert. Ein Profil mit Channel verlangt, dass der Lauf diesen Channel nimmt; danach läuft die Channel-Fassung über das
-- Ergebnis.
--
-- Der eingelesene Referenztext wird NICHT gespeichert, nur woher er kam (Adresse oder „eingefügter Text“) und wie lang er war
-- (Plan §0 „Texte aufbewahren“). Gespeichert ist, was der Admin aus ihm gemacht hat.
--
-- Jede inhaltliche Änderung (Beschreibung, Beispiele, Channel, Quelle) zählt die Fassung hoch und steht vollständig im Verlauf.
-- Jede Laufzeile nennt Profil und Fassung, mit der optimiert wurde.
--
-- In die Cloud geht ein Profil nur in der Fassung, die ein Admin dafür freigegeben hat (`cloud_freigabe_fassung = fassung`).
-- Die Regeln der Pseudonymisierung erkennen nicht jeden Namen (Plan §5 R1), und das Profil sieht der Nutzer in der Vorschau
-- nicht: Ohne einen Menschen, der die Fassung gelesen hat, ginge ein nicht erkannter Name 30 Tage nach Tempo (Review M4,
-- 11.11.2026). Eine neue Fassung braucht eine neue Freigabe; das ergibt sich, weil die Zahl nicht mehr passt.
--
-- Diese Datei enthält keine Füllung. Die Profile einer Installation kommen aus `047_textwerkstatt_stilprofile_seed.sql`; für
-- die leere Fassung des öffentlichen Repos lässt man die Seed-Datei weg (G5).
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

CREATE TABLE IF NOT EXISTS textwerkstatt_stilprofile (
  id             TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,31}$'),
  name           TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  -- Optional. Gesetzt heißt: Der Lauf muss diesen Channel nehmen, die Channel-Fassung läuft danach über das Ergebnis.
  channel_code   VARCHAR(20) REFERENCES channels(code) ON DELETE SET NULL,
  -- Geht wörtlich als Teil der Anweisung an das Modell.
  beschreibung   TEXT NOT NULL DEFAULT '' CHECK (length(beschreibung) <= 3000),
  -- Vorbild für Ton und Satzbau, je Zeile ein Satz. Der Rahmen im Code sagt dem Modell, dass es den Inhalt nicht übernimmt.
  beispiele      TEXT NOT NULL DEFAULT '' CHECK (length(beispiele) <= 2000),
  quelle_art     TEXT NOT NULL DEFAULT 'hand' CHECK (quelle_art IN ('hand', 'url', 'text')),
  quelle_url     TEXT CHECK (quelle_url IS NULL OR (length(quelle_url) <= 500 AND quelle_url ~ '^https?://')),
  -- Länge des eingelesenen Textes in Zeichen; der Text selbst steht nirgends.
  quelle_zeichen INTEGER CHECK (quelle_zeichen IS NULL OR quelle_zeichen >= 0),
  fassung        INTEGER NOT NULL DEFAULT 1 CHECK (fassung >= 1),
  -- Vorgabe aus: Ein Profil ohne Beschreibung darf nicht eingeschaltet sein (Prüfregel unten), und der Code legt ebenso aus an.
  aktiv          BOOLEAN NOT NULL DEFAULT FALSE,
  reihenfolge    INTEGER NOT NULL DEFAULT 0,
  cloud_freigabe_fassung INTEGER,
  cloud_freigabe_von     UUID REFERENCES users(id) ON DELETE SET NULL,
  cloud_freigabe_am      TIMESTAMPTZ,
  geaendert_von  UUID REFERENCES users(id) ON DELETE SET NULL,
  geaendert_am   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Ein leeres Profil lässt sich anlegen (Seed), aber nicht einschalten: Es gäbe dem Modell nichts mit.
  CONSTRAINT textwerkstatt_stilprofile_aktiv_braucht_beschreibung CHECK (NOT aktiv OR length(btrim(beschreibung)) >= 20),
  CONSTRAINT textwerkstatt_stilprofile_quelle CHECK (
    (quelle_art = 'url' AND quelle_url IS NOT NULL) OR (quelle_art <> 'url' AND quelle_url IS NULL)
  ),
  CONSTRAINT textwerkstatt_stilprofile_freigabe CHECK (cloud_freigabe_fassung IS NULL OR cloud_freigabe_fassung BETWEEN 1 AND fassung)
);

-- Nachgezogen, falls eine frühere Fassung dieser Datei die Tabelle ohne Freigabe angelegt hat (Nachprüfung 11.11.2026). Wiederholbar.
ALTER TABLE textwerkstatt_stilprofile ADD COLUMN IF NOT EXISTS cloud_freigabe_fassung INTEGER;
ALTER TABLE textwerkstatt_stilprofile ADD COLUMN IF NOT EXISTS cloud_freigabe_von UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE textwerkstatt_stilprofile ADD COLUMN IF NOT EXISTS cloud_freigabe_am TIMESTAMPTZ;

-- Jede Fassung vollständig: wer, wann, mit welchem Stand. „Fassungswechsel sichtbar“ (Fertig-Bedingung) liest von hier.
CREATE TABLE IF NOT EXISTS textwerkstatt_stilprofile_verlauf (
  id         BIGSERIAL PRIMARY KEY,
  profil_id  TEXT NOT NULL,
  fassung    INTEGER NOT NULL,
  aktion     TEXT NOT NULL CHECK (aktion IN ('angelegt', 'geaendert', 'cloud_freigegeben', 'cloud_entzogen')),
  felder     JSONB NOT NULL,
  von        UUID REFERENCES users(id) ON DELETE SET NULL,
  am         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_textwerkstatt_stilprofile_verlauf ON textwerkstatt_stilprofile_verlauf (profil_id, am DESC);

-- Die Laufzeile nennt, mit welchem Profil in welcher Fassung optimiert wurde und was die Channel-Fassung danach tat.
ALTER TABLE textwerkstatt_laeufe ADD COLUMN IF NOT EXISTS stilprofil_id TEXT;
ALTER TABLE textwerkstatt_laeufe ADD COLUMN IF NOT EXISTS stilprofil_fassung INTEGER;
ALTER TABLE textwerkstatt_laeufe ADD COLUMN IF NOT EXISTS channel_code TEXT;
ALTER TABLE textwerkstatt_laeufe ADD COLUMN IF NOT EXISTS channel_schritt TEXT;
ALTER TABLE textwerkstatt_laeufe DROP CONSTRAINT IF EXISTS textwerkstatt_laeufe_channel_schritt;
ALTER TABLE textwerkstatt_laeufe ADD CONSTRAINT textwerkstatt_laeufe_channel_schritt
  CHECK (channel_schritt IS NULL OR channel_schritt IN ('unverändert', 'sprachmodell', 'regel', 'offen'));
