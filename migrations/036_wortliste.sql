-- Eine Wortliste je Sprache: das Glossar DE→X trägt künftig auch die Namensbausteine.
--
-- Plan `PLAN-wortliste.md` §2 und Phase 1 (Cockpit #1829), Entscheide Thomas 10.11.2026 (Cockpit #1625). Glossar und Bausteintabelle
-- (Migration 033) werden zu einer Liste je Sprache. `bildeName` im Assistenten nimmt alles Freigegebene daraus, das DeepL-Glossar ist
-- eine abgeleitete Teilmenge (`an_deepl`).
--
-- 🚨 DIESE DATEI ÄNDERT KEINE ZEILE. Die Vorgaben lassen den Bestand, wie er ist: jede Zeile bleibt ein Wort (`art = 'wort'`) und geht
-- weiter an DeepL (`an_deepl = TRUE`). Die Bausteine zieht erst Phase 3 herüber, mit eigenem Werkzeug, Trockenlauf und Sicherung.
--
-- 🚨 DREI SICHTEN STATT EINES FILTERS IN JEDEM LESER.
--   glossar_an_deepl       was an DeepL und in die Fließtext-Schritte geht: freigegeben, mit Ziel, `an_deepl`
--   wortliste_freigegeben  was `bildeName` sehen darf: freigegeben, mit Ziel. Ersetzt den Schutz der eigenen Tabelle aus Migration 033
--   wortliste_offen        Vorschläge und offene Zeilen, für die getrennte Route `…/vorlaeufig`
-- Die Bedingung steht so an einer Stelle in der Datenbank, nicht in jedem Leser, und ein Test hält sie fest (Plan §2.2).
--
-- Der Schlüssel je exakter Schreibung (Plan §2.1, `COVER` neben `Cover` gewollt) kommt erst mit Phase 3: Der Bestand führt 2 exakte
-- Dubletten (HU, IT, gemessen 10.11.2026), die das Werkzeug dort zusammenlegt, und zwei Testläufe bauen bis dahin solche Dubletten.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

ALTER TABLE glossary_entries ADD COLUMN IF NOT EXISTS art TEXT NOT NULL DEFAULT 'wort';
ALTER TABLE glossary_entries ADD COLUMN IF NOT EXISTS an_deepl BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE glossary_entries ADD COLUMN IF NOT EXISTS wortart TEXT;
ALTER TABLE glossary_entries ADD COLUMN IF NOT EXISTS genus TEXT;
ALTER TABLE glossary_entries ADD COLUMN IF NOT EXISTS formen JSONB;
ALTER TABLE glossary_entries ADD COLUMN IF NOT EXISTS merkmalsklasse TEXT;
ALTER TABLE glossary_entries ADD COLUMN IF NOT EXISTS ziel_name TEXT;
ALTER TABLE glossary_entries ADD COLUMN IF NOT EXISTS namensfassung INTEGER;

COMMENT ON COLUMN glossary_entries.art IS
  'wort, muster (Kommateil mit # für eine Zahl), wendung (ganze Wendung, z. B. nach „mit“), fest (Serie oder Blockwort, bleibt). Migration 036.';
COMMENT ON COLUMN glossary_entries.an_deepl IS
  'Geht die Zeile ins DeepL-Glossar und in die Fließtext-Schritte (Sicht glossar_an_deepl)? FALSE für reine Namenswörter und für Wörter mit zweiter Bedeutung im Satz (Rolle, rund).';
COMMENT ON COLUMN glossary_entries.ziel_name IS
  'Nur im Artikelnamen, wenn die Fremdsprache dort stilistisch etwas anderes verlangt (Entscheid Thomas 10.11.2026). NULL = wie target_term. Nie an DeepL.';
COMMENT ON COLUMN glossary_entries.namensfassung IS
  'Fassung der Sprache (namens_bausteine_fassung), in der die Zeile zuletzt für Namen geändert wurde. Setzt ab Phase 3 ein Trigger, nie der Schreibweg.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'glossary_entries_art_gueltig') THEN
    ALTER TABLE glossary_entries ADD CONSTRAINT glossary_entries_art_gueltig
      CHECK (art IN ('wort', 'muster', 'wendung', 'fest'));
  END IF;
  -- Ein Muster trägt `#` für eine Zahl. Im Satz träfe es nie, im DeepL-Glossar wäre es nur Ballast.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'glossary_entries_muster_nie_an_deepl') THEN
    ALTER TABLE glossary_entries ADD CONSTRAINT glossary_entries_muster_nie_an_deepl
      CHECK (art <> 'muster' OR an_deepl IS FALSE);
  END IF;
  -- Eine Serie oder ein Blockwort bleibt, wie es ist (wie Migration 033).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'glossary_entries_fest_bleibt') THEN
    ALTER TABLE glossary_entries ADD CONSTRAINT glossary_entries_fest_bleibt
      CHECK (art <> 'fest' OR ((target_term IS NULL OR target_term = source_term) AND ziel_name IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'glossary_entries_wortart_gueltig') THEN
    ALTER TABLE glossary_entries ADD CONSTRAINT glossary_entries_wortart_gueltig
      CHECK (wortart IS NULL OR wortart IN ('hauptwort', 'adjektiv', 'sonstiges'));
  END IF;
  -- Genus trägt das Hauptwort, Formen trägt das Adjektiv (Plan Bausteine §1 Punkt 3). 🚨 IS NOT DISTINCT FROM, nicht `=`: Bei leerer
  -- Wortart ergäbe `wortart = 'hauptwort'` NULL, und ein CHECK lässt NULL durch (Test 10.11.2026; Migration 033 hat diese Lücke).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'glossary_entries_genus_am_hauptwort') THEN
    ALTER TABLE glossary_entries ADD CONSTRAINT glossary_entries_genus_am_hauptwort
      CHECK (genus IS NULL OR (genus IN ('m', 'f', 'n') AND wortart IS NOT DISTINCT FROM 'hauptwort'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'glossary_entries_formen_am_adjektiv') THEN
    ALTER TABLE glossary_entries ADD CONSTRAINT glossary_entries_formen_am_adjektiv
      CHECK (formen IS NULL OR (jsonb_typeof(formen) = 'object' AND wortart IS NOT DISTINCT FROM 'adjektiv'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'glossary_entries_ziel_name_nicht_leer') THEN
    ALTER TABLE glossary_entries ADD CONSTRAINT glossary_entries_ziel_name_nicht_leer
      CHECK (ziel_name IS NULL OR btrim(ziel_name) <> '');
  END IF;
END $$;

-- Ziel je Produktgruppe (`U_klasse`, Entscheid Thomas 06.11.2026): FR `Cover` am Profil `diffuseur`, am Spot `collerette`. Nie an DeepL,
-- DeepL kennt je Begriff ein Ziel. Genus und Formen gehören dazu, weil das Ziel ein anderes Wort sein kann.
CREATE TABLE IF NOT EXISTS glossary_entry_gruppen (
  entry_id      UUID NOT NULL REFERENCES glossary_entries(id) ON DELETE CASCADE,
  produktgruppe INTEGER NOT NULL CHECK (produktgruppe >= 0),
  target_term   TEXT NOT NULL CHECK (btrim(target_term) <> ''),
  genus         TEXT CHECK (genus IS NULL OR genus IN ('m', 'f', 'n')),
  formen        JSONB CHECK (formen IS NULL OR jsonb_typeof(formen) = 'object'),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entry_id, produktgruppe)
);
COMMENT ON TABLE glossary_entry_gruppen IS
  'Ziel eines Worts je Produktgruppe (U_klasse). Gilt nur in Artikelnamen, vor dem Channel-Wert und dem Standard (Plan Wortliste §2.4).';

-- Die Herkunft eines offenen Vorschlags. Ersetzt die Zusatzspalten von `namens_bausteine_vorlaeufig` (Migration 033 und 035).
CREATE TABLE IF NOT EXISTS wortliste_vorschlag (
  entry_id           UUID PRIMARY KEY REFERENCES glossary_entries(id) ON DELETE CASCADE,
  vorschlag_pruefung TEXT CHECK (vorschlag_pruefung IS NULL OR btrim(vorschlag_pruefung) <> ''),
  vorschlag_glossar  TEXT CHECK (vorschlag_glossar IS NULL OR btrim(vorschlag_glossar) <> ''),
  vorschlag_markt    TEXT CHECK (vorschlag_markt IS NULL OR btrim(vorschlag_markt) <> ''),
  vorschlag_deepl    TEXT CHECK (vorschlag_deepl IS NULL OR btrim(vorschlag_deepl) <> ''),
  quelle             TEXT NOT NULL CHECK (quelle IN ('pruefung', 'glossar', 'markt', 'deepl', 'gemeldet')),
  stelle             TEXT CHECK (stelle IS NULL OR stelle IN ('kopf', 'teil')),
  kopfwort           TEXT,
  beispiele          TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(beispiele) <= 2),
  artikel_anzahl     INTEGER CHECK (artikel_anzahl IS NULL OR artikel_anzahl >= 0),
  rueckfrage         TEXT CHECK (rueckfrage IS NULL OR btrim(rueckfrage) <> ''),
  rueckfrage_von     TEXT,
  rueckfrage_am      TIMESTAMPTZ,
  angelegt_am        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geaendert_am       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE wortliste_vorschlag IS
  'Herkunft einer offenen Zeile der Wortliste: Vorschläge je Quelle, Beispiele, Artikelzahl, Rückfrage. Die Zeile selbst steht in glossary_entries mit approved = FALSE.';
COMMENT ON COLUMN wortliste_vorschlag.rueckfrage IS
  'Offene Rückfrage mit Text. „Seite freigeben“ lässt Zeilen mit Rückfrage aus.';

-- Das Ziel einer offenen Zeile folgt ihren Vorschlägen: Prüftabelle, dann Glossar, dann Markt, dann DeepL (Entscheid Thomas 06.11.2026).
-- Nur solange die Zeile offen ist und niemand das Ziel von Hand geändert hat: Steht dort noch der vorige Vorschlag (oder nichts), wird
-- er ersetzt, sonst bleibt die Hand.
CREATE OR REPLACE FUNCTION wortliste_vorschlag_ziel() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  alt TEXT;
  neu TEXT;
BEGIN
  neu := COALESCE(NEW.vorschlag_pruefung, NEW.vorschlag_glossar, NEW.vorschlag_markt, NEW.vorschlag_deepl);
  IF TG_OP = 'UPDATE' THEN
    alt := COALESCE(OLD.vorschlag_pruefung, OLD.vorschlag_glossar, OLD.vorschlag_markt, OLD.vorschlag_deepl);
  END IF;
  IF neu IS DISTINCT FROM alt THEN
    UPDATE glossary_entries
       SET target_term = neu
     WHERE id = NEW.entry_id
       AND approved IS NOT TRUE
       AND (target_term IS NULL OR target_term IS NOT DISTINCT FROM alt);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_wortliste_vorschlag_ziel ON wortliste_vorschlag;
CREATE TRIGGER trg_wortliste_vorschlag_ziel
  AFTER INSERT OR UPDATE ON wortliste_vorschlag
  FOR EACH ROW EXECUTE FUNCTION wortliste_vorschlag_ziel();

-- Abgelehnte Vorschläge als Spur: `POST /api/namens-bausteine/unbekannt` schlägt sie nicht neu vor. Ohne Fremdschlüssel auf die Zeile,
-- die beim Ablehnen entfällt.
CREATE TABLE IF NOT EXISTS wortliste_abgelehnt (
  id          BIGSERIAL PRIMARY KEY,
  glossary_id UUID NOT NULL REFERENCES glossaries(id) ON DELETE CASCADE,
  art         TEXT NOT NULL CHECK (art IN ('wort', 'muster', 'wendung', 'fest')),
  source_term TEXT NOT NULL CHECK (btrim(source_term) <> ''),
  ziel        TEXT,
  anmerkung   TEXT,
  von         TEXT NOT NULL CHECK (btrim(von) <> ''),
  am          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wortliste_abgelehnt ON wortliste_abgelehnt (glossary_id, btrim(source_term));

-- Was an DeepL und in die Fließtext-Schritte geht. Jeder Leser, der ein Glossar auf Text anwendet, liest nur diese Sicht.
CREATE OR REPLACE VIEW glossar_an_deepl WITH (security_barrier) AS
  SELECT e.id, e.glossary_id, e.source_term, e.target_term, e.context, e.category, e.created_at
    FROM glossary_entries e
   WHERE e.approved = TRUE AND e.target_term IS NOT NULL AND e.an_deepl;
COMMENT ON VIEW glossar_an_deepl IS
  'Teilmenge der Wortliste für DeepL und Fließtext: freigegeben, mit Ziel, an_deepl. Ziele je Produktgruppe, ziel_name und Formen gehen nie an DeepL.';

-- Was `bildeName` sehen darf. 🚨 Die Route `GET /api/namens-bausteine` liest allein diese Sicht (Plan §2.2).
CREATE OR REPLACE VIEW wortliste_freigegeben WITH (security_barrier) AS
  SELECT e.id, g.target_lang AS sprache, e.art, e.source_term AS deutsch, e.target_term AS ziel, e.ziel_name,
         e.wortart, e.genus, e.formen, e.merkmalsklasse, e.namensfassung, e.an_deepl,
         COALESCE((SELECT jsonb_object_agg(c.channel_code, c.target_term ORDER BY c.channel_code)
                     FROM glossary_entry_channels c WHERE c.entry_id = e.id), '{}'::jsonb) AS kanaele,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('produktgruppe', p.produktgruppe, 'ziel', p.target_term,
                                                       'genus', p.genus, 'formen', p.formen) ORDER BY p.produktgruppe)
                     FROM glossary_entry_gruppen p WHERE p.entry_id = e.id), '[]'::jsonb) AS gruppen
    FROM glossary_entries e
    JOIN glossaries g ON g.id = e.glossary_id
   WHERE e.approved = TRUE AND e.target_term IS NOT NULL
     AND g.source_lang = 'DE' AND g.target_lang IN ('EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ');
COMMENT ON VIEW wortliste_freigegeben IS
  'Freigegebene Wörter je Sprache für bildeName. Ersetzt den Schutz der eigenen Tabelle namens_bausteine (Migration 033): Offenes kennt diese Sicht nicht.';

-- Offene Zeilen mit ihrer Herkunft, für `GET /api/namens-bausteine/vorlaeufig` und die Pflege. Nie für den Bestandslauf.
CREATE OR REPLACE VIEW wortliste_offen WITH (security_barrier) AS
  SELECT e.id, g.target_lang AS sprache, e.art, e.source_term AS deutsch, e.target_term AS ziel, e.ziel_name,
         e.wortart, e.genus, e.formen, e.merkmalsklasse, e.an_deepl,
         v.vorschlag_pruefung, v.vorschlag_glossar, v.vorschlag_markt, v.vorschlag_deepl, v.quelle, v.stelle, v.kopfwort,
         COALESCE(v.beispiele, '{}') AS beispiele, v.artikel_anzahl, v.rueckfrage, v.rueckfrage_von, v.rueckfrage_am,
         CASE WHEN v.rueckfrage IS NOT NULL THEN 'rueckfrage' ELSE 'vorschlag' END AS status
    FROM glossary_entries e
    JOIN glossaries g ON g.id = e.glossary_id
    LEFT JOIN wortliste_vorschlag v ON v.entry_id = e.id
   WHERE e.approved IS NOT TRUE
     AND g.source_lang = 'DE' AND g.target_lang IN ('EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ');
COMMENT ON VIEW wortliste_offen IS
  'Offene Zeilen der Wortliste (Vorschlag, Rückfrage, leer). Liest die Neuanlage und das Messskript, nie der Bestandslauf.';
