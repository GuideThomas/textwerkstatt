-- Beispiel-Glossar eines erfundenen Fahrradladens, DE → EN und DE → FR.
--
-- Ein Glossar führt nur GEWOLLTE Abweichungen: Begriffe, die DeepL von sich aus anders übersetzen würde, als der Laden es will
-- (README §Glossar). Dazu ein Wort, das im Katalog anders heißt als im Shop (glossary_entry_channels).
--
-- 🚨 Ohne deepl_glossary_id: Den legt erst der erste Abgleich an. Eine ID im Seed zeigte auf ein fremdes DeepL-Glossar, und der
-- nächste Abgleich löschte es dort. Einträge ohne angelegt_von gelten als Beispiel und sind in der Demo vor dem Löschen geschützt.
-- Wiederholbar: Glossar und Einträge nur, wenn es sie noch nicht gibt.

INSERT INTO glossaries (name, source_lang, target_lang)
VALUES ('Beispiel DE→EN', 'DE', 'EN'), ('Beispiel DE→FR', 'DE', 'FR')
ON CONFLICT (source_lang, target_lang) DO NOTHING;

INSERT INTO glossary_entries (glossary_id, source_term, target_term, context, approved, source)
SELECT g.id, v.de, v.ziel, v.kontext, TRUE, 'manual'
FROM (VALUES
  ('EN', 'Werkstatt',      'service centre',  'Laden-Sprache: nicht „workshop“'),
  ('EN', 'Inspektion',     'service',         'nicht „inspection“'),
  ('EN', 'Rahmenhöhe',     'frame size',      'so steht es auf der Größentabelle'),
  ('EN', 'Lastenrad',      'cargo bike',      NULL),
  ('EN', 'Probefahrt',     'test ride',       NULL),
  ('EN', 'Pedelec',        'e-bike',          'Kundinnen sagen e-bike'),
  ('FR', 'Werkstatt',      'atelier vélo',    NULL),
  ('FR', 'Inspektion',     'révision',        'nicht „inspection“'),
  ('FR', 'Rahmenhöhe',     'taille de cadre', NULL),
  ('FR', 'Lastenrad',      'vélo cargo',      NULL),
  ('FR', 'Probefahrt',     'essai',           NULL),
  ('FR', 'Pedelec',        'VAE',             'vélo à assistance électrique')
) AS v (ziel_sprache, de, ziel, kontext)
JOIN glossaries g ON g.source_lang = 'DE' AND g.target_lang = v.ziel_sprache
WHERE NOT EXISTS (SELECT 1 FROM glossary_entries e WHERE e.glossary_id = g.id AND btrim(e.source_term) = v.de);

-- Im Katalog heißt die Werkstatt auf Englisch „workshop“: ein Channel-Wort statt eines zweiten Glossars.
INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term)
SELECT e.id, 'KATALOG', 'workshop'
FROM glossary_entries e JOIN glossaries g ON g.id = e.glossary_id
WHERE g.source_lang = 'DE' AND g.target_lang = 'EN' AND e.source_term = 'Werkstatt'
  AND EXISTS (SELECT 1 FROM channels WHERE code = 'KATALOG')
ON CONFLICT (entry_id, channel_code) DO NOTHING;
