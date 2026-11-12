-- Je Sprachpaar ein Glossar (Wunsch Thomas 05.11.2026, `PLAN-glossar-nur-abweichungen.md`, Nachtrag zu Phase 2).
--
-- Jeder Lookup sucht mit `source_lang`/`target_lang` und `LIMIT 1`: Bei zwei Glossaren wüsste er nicht, welches gilt. Die Schranke
-- steht in der Datenbank, damit auch Quickadd, Review, Scan und Import nicht daran vorbeikommen. Der Import sucht zusätzlich nach
-- dem Namen: Trägt ein Glossar einen anderen, bricht er jetzt ab und rollt zurück, statt ein zweites anzulegen.
--
-- 🚨 Gefahrlos für den Deploy: `migrate.js` bricht bei einem Fehler ab, und der Dienst bliebe mit neuer Oberfläche auf altem Prozess
-- stehen. Gemessen sind nur die acht Paare DE→X als eindeutig, andere Paare nicht. Führt der Bestand eine Dublette, gibt es
-- statt eines Abbruchs eine Warnung, und der nächste Deploy versucht es erneut. `POST /api/glossaries` prüft deshalb auch selbst,
-- die Route hängt nicht an diesem Index.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM glossaries GROUP BY source_lang, target_lang HAVING count(*) > 1) THEN
    RAISE WARNING 'Glossare: Ein Sprachpaar steht mehrfach im Bestand, uq_glossaries_sprachpaar wird nicht angelegt';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_glossaries_sprachpaar ON glossaries (source_lang, target_lang);
  END IF;
END $$;
