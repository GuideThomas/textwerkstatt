-- Namensbausteine: freigegebene Tabelle, vorläufige Tabelle, Fassung und Verlauf.
--
-- Plan `Artikelanlage-Assistent/docs/PLAN-Artikelnamen-Bausteine.md` §2 Phase 2, Bauplan `BAUPLAN-Bausteine-Phase2.md` §4,
-- Cockpit #1767. Ein Artikelname wird künftig aus Bausteinen gebildet statt von DeepL als Satz übersetzt; der Assistent holt die
-- freigegebenen Bausteine über `GET /api/namens-bausteine` und bildet den Namen selbst (`bildeName`, Entscheid Thomas 06.11.2026).
--
-- 🚨 ZWEI TABELLEN STATT EINES STATUS. Der Bestandslauf (Phase 6) darf nur Freigegebenes sehen. Vorschläge (Prüftabelle, Glossar,
-- Markt, DeepL, unbekannte Bausteine aus Neuanlagen) liegen in `namens_bausteine_vorlaeufig`, erst die Freigabe durch einen
-- Muttersprachler schreibt nach `namens_bausteine`. Der Schutz hängt so an der Tabelle, nicht an einem Filter auf eine Spalte,
-- den ein Leser vergessen kann.
--
-- 🚨 DIE FASSUNG ZÄHLT DIE DATENBANK. Jede Transaktion, die freigegebene Bausteine einer Sprache ändert, erhöht deren Fassung genau
-- einmal, gleich auf welchem Weg (Pflegeoberfläche, Einlesen, psql). Der Assistent erkennt daran eine geänderte Tabelle (ETag),
-- in Phase 5 trägt jeder gelieferte Name diese Nummer. Ein TRUNCATE umginge die Zeilentrigger, er ist deshalb gesperrt.
--
-- `produktgruppe` ist `U_klasse` (Entscheid Thomas 06.11.2026), deshalb INTEGER. Leer heißt: gilt in jeder Gruppe.
-- Die Reihenfolge der Quellen für das vorläufige Ziel (Prüftabelle, Glossar, Markt; Entscheid Thomas 06.11.2026) steht als
-- berechnete Spalte in der Tabelle, nicht im Code eines Schreibwegs.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

CREATE TABLE IF NOT EXISTS namens_bausteine_fassung (
  sprache     TEXT NOT NULL,
  nummer      INTEGER NOT NULL CHECK (nummer > 0),
  txid        BIGINT NOT NULL,
  von         TEXT NOT NULL,
  angelegt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sprache, nummer)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_namens_bausteine_fassung_txid ON namens_bausteine_fassung (sprache, txid);
COMMENT ON TABLE namens_bausteine_fassung IS
  'Fassung der freigegebenen Namensbausteine je Sprache. Eine Zeile je Transaktion, die freigegebene Bausteine dieser Sprache ändert; geschrieben nur von den Triggern auf namens_bausteine.';

CREATE TABLE IF NOT EXISTS namens_bausteine (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sprache         TEXT NOT NULL CHECK (sprache IN ('EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ')),
  art             TEXT NOT NULL CHECK (art IN ('muster', 'wort', 'wendung', 'fest')),
  deutsch         TEXT NOT NULL CHECK (btrim(deutsch) <> ''),
  ziel            TEXT NOT NULL CHECK (btrim(ziel) <> ''),
  produktgruppe   INTEGER,
  wortart         TEXT CHECK (wortart IN ('hauptwort', 'adjektiv', 'sonstiges')),
  genus           TEXT CHECK (genus IN ('m', 'f', 'n')),
  formen          JSONB CHECK (formen IS NULL OR jsonb_typeof(formen) = 'object'),
  merkmalsklasse  TEXT,
  quelle          TEXT NOT NULL CHECK (quelle IN ('pruefung', 'glossar', 'markt', 'deepl', 'pflege')),
  freigegeben_von TEXT NOT NULL CHECK (btrim(freigegeben_von) <> ''),
  freigegeben_am  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fassung         INTEGER NOT NULL DEFAULT 0,
  -- Eine Serie oder ein Blockwort bleibt, wie es ist.
  CONSTRAINT namens_bausteine_fest_bleibt CHECK (art <> 'fest' OR ziel = deutsch),
  -- Genus trägt das Hauptwort, Formen trägt das Adjektiv (Plan §1 Punkt 3).
  CONSTRAINT namens_bausteine_genus_am_hauptwort CHECK (genus IS NULL OR wortart = 'hauptwort'),
  CONSTRAINT namens_bausteine_formen_am_adjektiv CHECK (formen IS NULL OR wortart = 'adjektiv')
);
-- Gleiches Deutsch in gleicher Art und Produktgruppe hat in einer Sprache genau ein Ziel. Das Kopfwort ist kein Schlüssel: Es
-- bestimmt über das Genus nur die Form (Bauplan §4). -1 steht für „ohne Gruppe“, `U_klasse` ist nie negativ.
CREATE UNIQUE INDEX IF NOT EXISTS uq_namens_bausteine_schluessel
  ON namens_bausteine (sprache, art, lower(btrim(deutsch)), COALESCE(produktgruppe, -1));
COMMENT ON TABLE namens_bausteine IS
  'Freigegebene Namensbausteine je Sprache. Nur was ein Muttersprachler freigegeben hat; der Bestandslauf liest allein diese Tabelle. Vorschläge stehen in namens_bausteine_vorlaeufig.';
COMMENT ON COLUMN namens_bausteine.produktgruppe IS 'U_klasse des Artikels (Entscheid Thomas 06.11.2026). NULL = gilt in jeder Gruppe.';
COMMENT ON COLUMN namens_bausteine.merkmalsklasse IS 'Klasse aus der Zerlegung des Assistenten (artikelnameZerlegung.ts), z. B. FARBE, FORM. Die geschlossene Liste „Nie entfallen“ kommt mit Phase 3.';
COMMENT ON COLUMN namens_bausteine.fassung IS 'Fassung der Sprache, in der dieser Baustein zuletzt inhaltlich geändert wurde. Setzt der Trigger, nie der Schreibweg.';

CREATE TABLE IF NOT EXISTS namens_bausteine_verlauf (
  id          BIGSERIAL PRIMARY KEY,
  baustein_id UUID NOT NULL,
  sprache     TEXT NOT NULL,
  aktion      TEXT NOT NULL CHECK (aktion IN ('angelegt', 'geaendert', 'entfernt')),
  alt         JSONB,
  neu         JSONB,
  von         TEXT NOT NULL,
  fassung     INTEGER NOT NULL,
  am          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_namens_bausteine_verlauf_baustein ON namens_bausteine_verlauf (baustein_id, am);
COMMENT ON TABLE namens_bausteine_verlauf IS
  'Jede inhaltliche Änderung an namens_bausteine mit altem und neuem Stand. Ohne Fremdschlüssel, damit der Eintrag ein Entfernen überlebt.';

CREATE TABLE IF NOT EXISTS namens_bausteine_vorlaeufig (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sprache            TEXT NOT NULL CHECK (sprache IN ('EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ')),
  art                TEXT NOT NULL CHECK (art IN ('muster', 'wort', 'wendung', 'fest')),
  deutsch            TEXT NOT NULL CHECK (btrim(deutsch) <> ''),
  produktgruppe      INTEGER,
  stelle             TEXT CHECK (stelle IN ('kopf', 'teil')),
  kopfwort           TEXT,
  vorschlag_pruefung TEXT CHECK (vorschlag_pruefung IS NULL OR btrim(vorschlag_pruefung) <> ''),
  vorschlag_glossar  TEXT CHECK (vorschlag_glossar IS NULL OR btrim(vorschlag_glossar) <> ''),
  vorschlag_markt    TEXT CHECK (vorschlag_markt IS NULL OR btrim(vorschlag_markt) <> ''),
  vorschlag_deepl    TEXT CHECK (vorschlag_deepl IS NULL OR btrim(vorschlag_deepl) <> ''),
  -- Vorrang der Quellen, Entscheid Thomas 06.11.2026: Prüftabelle, dann Glossar, dann Markt; DeepL nur, wenn sonst nichts da ist.
  ziel               TEXT GENERATED ALWAYS AS (COALESCE(vorschlag_pruefung, vorschlag_glossar, vorschlag_markt, vorschlag_deepl)) STORED,
  wortart            TEXT CHECK (wortart IN ('hauptwort', 'adjektiv', 'sonstiges')),
  genus              TEXT CHECK (genus IN ('m', 'f', 'n')),
  formen             JSONB CHECK (formen IS NULL OR jsonb_typeof(formen) = 'object'),
  merkmalsklasse     TEXT,
  quelle             TEXT NOT NULL CHECK (quelle IN ('pruefung', 'glossar', 'markt', 'deepl', 'gemeldet')),
  beispiele          TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(beispiele) <= 2),
  artikel_anzahl     INTEGER CHECK (artikel_anzahl IS NULL OR artikel_anzahl >= 0),
  status             TEXT NOT NULL DEFAULT 'vorschlag' CHECK (status IN ('vorschlag', 'rueckfrage', 'abgelehnt', 'uebernommen')),
  uebernommen_als    UUID REFERENCES namens_bausteine(id) ON DELETE SET NULL,
  angelegt_am        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geaendert_am       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Je Schlüssel höchstens ein offener Vorschlag; abgelehnte und übernommene bleiben als Spur daneben stehen.
CREATE UNIQUE INDEX IF NOT EXISTS uq_namens_bausteine_vorlaeufig_offen
  ON namens_bausteine_vorlaeufig (sprache, art, lower(btrim(deutsch)), COALESCE(produktgruppe, -1))
  WHERE status IN ('vorschlag', 'rueckfrage');
CREATE INDEX IF NOT EXISTS idx_namens_bausteine_vorlaeufig_sprache ON namens_bausteine_vorlaeufig (sprache, status);
COMMENT ON TABLE namens_bausteine_vorlaeufig IS
  'Vorläufige Namensbausteine: Vorschläge, die noch kein Muttersprachler freigegeben hat. Liest die Neuanlage und das Messskript, nie der Bestandslauf.';

-- Die Fassung dieser Transaktion für eine Sprache: beim ersten Aufruf angelegt, danach wiederverwendet.
CREATE OR REPLACE FUNCTION namens_fassung_der_transaktion(p_sprache TEXT, p_von TEXT) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  n INTEGER;
BEGIN
  SELECT nummer INTO n FROM namens_bausteine_fassung WHERE sprache = p_sprache AND txid = txid_current();
  IF FOUND THEN
    RETURN n;
  END IF;
  -- Zwei Transaktionen derselben Sprache dürfen nicht dieselbe Nummer ziehen.
  PERFORM pg_advisory_xact_lock(711033, hashtext(p_sprache));
  SELECT COALESCE(max(nummer), 0) + 1 INTO n FROM namens_bausteine_fassung WHERE sprache = p_sprache;
  INSERT INTO namens_bausteine_fassung (sprache, nummer, txid, von) VALUES (p_sprache, n, txid_current(), p_von);
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION namens_bausteine_vorher() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sprache <> OLD.sprache THEN
      RAISE EXCEPTION 'Die Sprache eines Namensbausteins ist fest (Baustein %)', OLD.id;
    END IF;
    IF (NEW.art, NEW.deutsch, NEW.ziel, NEW.produktgruppe, NEW.wortart, NEW.genus, NEW.formen, NEW.merkmalsklasse)
       IS NOT DISTINCT FROM
       (OLD.art, OLD.deutsch, OLD.ziel, OLD.produktgruppe, OLD.wortart, OLD.genus, OLD.formen, OLD.merkmalsklasse) THEN
      NEW.fassung := OLD.fassung;
      RETURN NEW;
    END IF;
  END IF;
  NEW.fassung := namens_fassung_der_transaktion(NEW.sprache, NEW.freigegeben_von);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION namens_bausteine_nachher() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v TEXT;
  n INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO namens_bausteine_verlauf (baustein_id, sprache, aktion, alt, neu, von, fassung)
    VALUES (NEW.id, NEW.sprache, 'angelegt', NULL, to_jsonb(NEW), NEW.freigegeben_von, NEW.fassung);
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.art, NEW.deutsch, NEW.ziel, NEW.produktgruppe, NEW.wortart, NEW.genus, NEW.formen, NEW.merkmalsklasse)
       IS DISTINCT FROM
       (OLD.art, OLD.deutsch, OLD.ziel, OLD.produktgruppe, OLD.wortart, OLD.genus, OLD.formen, OLD.merkmalsklasse) THEN
      INSERT INTO namens_bausteine_verlauf (baustein_id, sprache, aktion, alt, neu, von, fassung)
      VALUES (NEW.id, NEW.sprache, 'geaendert', to_jsonb(OLD), to_jsonb(NEW), NEW.freigegeben_von, NEW.fassung);
    END IF;
  ELSE
    -- Wer löscht, nennt sich mit SET LOCAL namens_bausteine.von = '…'; sonst steht „unbekannt“ im Verlauf.
    v := COALESCE(NULLIF(btrim(current_setting('namens_bausteine.von', true)), ''), 'unbekannt');
    n := namens_fassung_der_transaktion(OLD.sprache, v);
    INSERT INTO namens_bausteine_verlauf (baustein_id, sprache, aktion, alt, neu, von, fassung)
    VALUES (OLD.id, OLD.sprache, 'entfernt', to_jsonb(OLD), NULL, v, n);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION namens_bausteine_kein_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'namens_bausteine wird nicht geleert: einzeln löschen, damit Fassung und Verlauf zählen';
END;
$$;

DROP TRIGGER IF EXISTS trg_namens_bausteine_vorher ON namens_bausteine;
CREATE TRIGGER trg_namens_bausteine_vorher
  BEFORE INSERT OR UPDATE ON namens_bausteine
  FOR EACH ROW EXECUTE FUNCTION namens_bausteine_vorher();

DROP TRIGGER IF EXISTS trg_namens_bausteine_nachher ON namens_bausteine;
CREATE TRIGGER trg_namens_bausteine_nachher
  AFTER INSERT OR UPDATE OR DELETE ON namens_bausteine
  FOR EACH ROW EXECUTE FUNCTION namens_bausteine_nachher();

DROP TRIGGER IF EXISTS trg_namens_bausteine_kein_truncate ON namens_bausteine;
CREATE TRIGGER trg_namens_bausteine_kein_truncate
  BEFORE TRUNCATE ON namens_bausteine
  FOR EACH STATEMENT EXECUTE FUNCTION namens_bausteine_kein_truncate();
