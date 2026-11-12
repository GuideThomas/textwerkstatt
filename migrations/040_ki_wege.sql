-- Textwerkstatt Phase 2: KI-Wege als Einstellung, Freischaltung der Cloud-KI je Nutzer.
--
-- Plan `PLAN-textwerkstatt.md` §4 Phase 2 (Cockpit #1838).
--
-- Ein KI-Weg ist ein OpenAI-kompatibler Endpunkt mit Modell, Schlüssel und Zeitlimit. Die Textwerkstatt ruft je Aufruf genau
-- einen Weg und springt bei einem Fehler NIE auf einen anderen (Grundsatz G2) — anders als `callLlm` in `services/llm.ts`.
--
-- 🔐 In der Tabelle stehen nur die NAMEN der Umgebungsvariablen, nie Werte (G5). Die CHECKs begrenzen die Namen auf ein eigenes
-- Präfix: Sonst könnte ein Admin `schluessel_variable = 'DB_PASSWORD'` und als Endpunkt eine andere URL-Variable eintragen, und die
-- App schickte ein fremdes Geheimnis als Bearer-Token an einen fremden Dienst. `services/ki-weg.ts` prüft dieselben Muster.
--
-- Diese Datei enthält keine Füllung. Die Wege einer Installation kommen aus `041_ki_wege_seed.sql`; für die leere Fassung
-- des öffentlichen Repos lässt man die Seed-Datei weg und legt die Wege in der Verwaltung an.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

CREATE TABLE IF NOT EXISTS ki_wege (
  id                  TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,31}$'),
  name                TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  art                 TEXT NOT NULL CHECK (art IN ('lokal', 'cloud')),
  modell              TEXT NOT NULL CHECK (length(btrim(modell)) BETWEEN 1 AND 120),
  endpunkt_variable   TEXT NOT NULL CHECK (endpunkt_variable ~ '^(LLM_BASE_URL|KI_WEG_[A-Z0-9_]{1,40}_URL)$'),
  schluessel_variable TEXT NOT NULL CHECK (schluessel_variable ~ '^KI_WEG_[A-Z0-9_]{1,40}_KEY$'),
  zeitlimit_s         INTEGER NOT NULL CHECK (zeitlimit_s BETWEEN 1 AND 900),
  -- Felder, die wörtlich in den Anfragekörper gehen (etwa Denken aus, Protokoll aus). `model` und `messages` setzt immer der Code.
  zusatz_parameter    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(zusatz_parameter) = 'object'),
  -- Budget über `/key/info` des Endpunkts lesen. Das kann nur LiteLLM; für andere Endpunkte aus lassen.
  budget_lesen        BOOLEAN NOT NULL DEFAULT FALSE,
  aktiv               BOOLEAN NOT NULL DEFAULT TRUE,
  reihenfolge         INTEGER NOT NULL DEFAULT 0,
  geaendert_von       UUID REFERENCES users(id) ON DELETE SET NULL,
  geaendert_am        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Lokal heißt: Schlüssel KI_WEG_LOKAL…, Cloud heißt: jeder andere. Sonst wäre „lokal“ nur eine Beschriftung, und ein auf
  -- den Cloud-Schlüssel umgestellter Weg `lokal` schickte Text ohne Freischaltung in die Cloud. Art und Variablen sind nach
  -- dem Anlegen fest (`routes/textwerkstatt.ts`).
  CONSTRAINT ki_wege_art_passt_zum_schluessel CHECK ((art = 'lokal') = (left(schluessel_variable, 12) = 'KI_WEG_LOKAL'))
);

-- Verlauf jeder Anlage und Änderung eines Wegs: wer, wann, welche Felder mit welchem Wert.
CREATE TABLE IF NOT EXISTS ki_wege_verlauf (
  id      BIGSERIAL PRIMARY KEY,
  weg_id  TEXT NOT NULL,
  aktion  TEXT NOT NULL CHECK (aktion IN ('angelegt', 'geaendert')),
  felder  JSONB NOT NULL,
  von     UUID REFERENCES users(id) ON DELETE SET NULL,
  am      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ki_wege_verlauf_weg ON ki_wege_verlauf (weg_id, am DESC);

-- Freischaltung: Die lokale KI darf jeder Angemeldete, die Cloud-KI nur, wer hier TRUE hat. Geprüft je Aufruf am Server (G3).
ALTER TABLE users ADD COLUMN IF NOT EXISTS darf_cloud_ki BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS darf_cloud_ki_von UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS darf_cloud_ki_am TIMESTAMPTZ;

-- Verlauf jeder Änderung der Freischaltung: wer, wann, für wen, an oder aus.
CREATE TABLE IF NOT EXISTS ki_freischaltung_verlauf (
  id        BIGSERIAL PRIMARY KEY,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  erlaubt   BOOLEAN NOT NULL,
  von       UUID REFERENCES users(id) ON DELETE SET NULL,
  am        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ki_freischaltung_verlauf_user ON ki_freischaltung_verlauf (user_id, am DESC);
