-- Textwerkstatt Phase 4: Arten der Optimierung als Einstellung, Protokoll je Lauf ohne Text.
--
-- Plan `PLAN-textwerkstatt.md` §4 Phase 4 (Cockpit #1840). Der Ablauf steht in `services/optimieren/`.
--
-- Eine Art ist eine Anweisung an das Modell und die Prüfungen, die NACH der Antwort im Code laufen (Grundsatz G1): Zahlen und
-- Einheiten, Platzhalter, Hausschreibweise, Anrede, Länge. Die Bitte im Prompt ist keine Schranke; die Spalten hier sagen nur,
-- welche Schranke wie streng gilt. Dass Zahlen geprüft werden, Platzhalter und Hausschreibweise, legt der Code fest, nicht die
-- Tabelle: Eine Art kann eine Prüfung lockern (Kürzen darf eine Zahl weglassen), aber nicht abschalten.
--
-- Diese Datei enthält keine Füllung. Die Arten einer Installation kommen aus `045_textwerkstatt_arten_seed.sql`; für die leere
-- Fassung des öffentlichen Repos lässt man die Seed-Datei weg und legt die Arten in der Verwaltung an (G5).
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

CREATE TABLE IF NOT EXISTS textwerkstatt_arten (
  id                         TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,31}$'),
  name                       TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  beschreibung               TEXT NOT NULL DEFAULT '' CHECK (length(beschreibung) <= 300),
  -- Geht wörtlich als Teil der Systemanweisung an das Modell. Den Rahmen (nur den Text zurück, Absätze bleiben) setzt der Code.
  anweisung                  TEXT NOT NULL CHECK (length(btrim(anweisung)) BETWEEN 10 AND 4000),
  -- 'alle': jede Zahl des Originals steht wieder da, keine neue. 'keine_neuen': weglassen erlaubt (Kürzen), ändern und
  -- hinzufügen nie.
  zahlen                     TEXT NOT NULL DEFAULT 'alle' CHECK (zahlen IN ('alle', 'keine_neuen')),
  -- Fehlt ein Platzhalter der Pseudonymisierung in der Antwort, ist das ein Verstoß; mit TRUE nur ein Hinweis (Kürzen).
  platzhalter_fehlen_erlaubt BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'beibehalten': Die Anrede des Originals darf nicht wechseln. 'du'/'sie': Das Ergebnis darf die andere Form nicht enthalten.
  anrede                     TEXT NOT NULL DEFAULT 'beibehalten' CHECK (anrede IN ('beibehalten', 'du', 'sie')),
  -- FALSE: Die Reihenfolge der Angaben muss bleiben („230 V Eingang, 24 V Ausgang“ darf nicht getauscht werden). Für Arten,
  -- die nichts umstellen sollen (Korrigieren, du/Sie); bei den übrigen fiele jede Umformulierung auf.
  umstellen_erlaubt          BOOLEAN NOT NULL DEFAULT TRUE,
  -- Länge des Ergebnisses im Verhältnis zum Original (Zeichen).
  laenge_min                 NUMERIC(4, 2) NOT NULL CHECK (laenge_min >= 0.05),
  laenge_max                 NUMERIC(4, 2) NOT NULL CHECK (laenge_max <= 5),
  -- Der Nutzer darf eine Zielzahl an Zeichen angeben (Kürzen).
  zielzeichen                BOOLEAN NOT NULL DEFAULT FALSE,
  aktiv                      BOOLEAN NOT NULL DEFAULT TRUE,
  reihenfolge                INTEGER NOT NULL DEFAULT 0,
  geaendert_von              UUID REFERENCES users(id) ON DELETE SET NULL,
  geaendert_am               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT textwerkstatt_arten_laenge CHECK (laenge_min <= laenge_max)
);

-- Nachgezogen, falls eine frühere Fassung dieser Datei die Tabelle ohne die Spalte angelegt hat (Review 11.11.2026). Wiederholbar.
ALTER TABLE textwerkstatt_arten ADD COLUMN IF NOT EXISTS umstellen_erlaubt BOOLEAN NOT NULL DEFAULT TRUE;

-- Verlauf jeder Anlage und Änderung einer Art: wer, wann, welche Felder mit welchem Wert.
CREATE TABLE IF NOT EXISTS textwerkstatt_arten_verlauf (
  id      BIGSERIAL PRIMARY KEY,
  art_id  TEXT NOT NULL,
  aktion  TEXT NOT NULL CHECK (aktion IN ('angelegt', 'geaendert')),
  felder  JSONB NOT NULL,
  von     UUID REFERENCES users(id) ON DELETE SET NULL,
  am      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_textwerkstatt_arten_verlauf ON textwerkstatt_arten_verlauf (art_id, am DESC);

-- Eine Zeile je Lauf von `/optimieren`, OHNE Text (Plan §0 „Texte aufbewahren“: keine Texte in der App-Datenbank). Was
-- hinausging, belegt LiteLLM (Cloud: Tempo und SpendLogs), nicht diese Tabelle. Kosten stehen zusätzlich in `token_usage`
-- (Zweck `textwerkstatt`).
CREATE TABLE IF NOT EXISTS textwerkstatt_laeufe (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  weg_id            TEXT NOT NULL,
  weg_art           TEXT CHECK (weg_art IN ('lokal', 'cloud')),
  modell            TEXT,
  optimier_art      TEXT NOT NULL,
  zeichen_ein       INTEGER NOT NULL,
  zeichen_aus       INTEGER,
  -- Cloud: Platzhalter im gesendeten Text je Klasse, und wie viele Wörter der Nutzer selbst verdeckt (+) bzw. aufgedeckt (−) hat.
  platzhalter       JSONB,
  masken_verdeckt   INTEGER,
  masken_aufgedeckt INTEGER,
  ergebnis          TEXT NOT NULL CHECK (ergebnis IN ('ok', 'hinweis', 'verworfen', 'fehler')),
  -- Codes der Prüfungen, die nicht bestanden haben (ZAHL_NEU, ANREDE_DU …), nie ein Wert aus dem Text.
  pruefgruende      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pruefgruende) = 'array'),
  fehler_code       TEXT,
  dauer_ms          INTEGER,
  eingabe_token     INTEGER,
  ausgabe_token     INTEGER,
  denk_token        INTEGER,
  kosten_usd        NUMERIC(12, 6),
  am                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_textwerkstatt_laeufe_am ON textwerkstatt_laeufe (am DESC);
CREATE INDEX IF NOT EXISTS idx_textwerkstatt_laeufe_user ON textwerkstatt_laeufe (user_id, am DESC);
