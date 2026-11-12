-- Stilprofile des Beispiel-Ladens, je Channel eines, eingeschaltet (ein Profil braucht dafür eine Beschreibung ab 20 Zeichen) und
-- für die Cloud freigegeben: Die Texte sind erfunden, und in der Demo gibt es nur den Cloud-Weg (sonst wären Stilprofile dort nutzlos).
-- Ein Profil, das es schon gibt, bleibt, wie der Admin es zuletzt gespeichert hat.

INSERT INTO textwerkstatt_stilprofile (id, name, channel_code, beschreibung, beispiele, aktiv, reihenfolge, cloud_freigabe_fassung, cloud_freigabe_am)
SELECT v.id, v.name, v.channel_code, v.beschreibung, v.beispiele, TRUE, v.reihenfolge, 1, NOW()
FROM (VALUES
  ('shop', 'Onlineshop', 'SHOP',
   'Kurze Sätze, Anrede mit Sie, der Nutzen zuerst, dann die Technik. Keine Superlative, keine Ausrufezeichen. Zahlen mit Einheit.',
   'Mit dem Lastenrad bringen Sie zwei Kinder und den Wocheneinkauf sicher nach Hause. Der Akku reicht für rund 80 km.', 10),
  ('katalog', 'Katalog', 'KATALOG',
   'Sachlich und knapp, ohne Anrede. Ein Absatz je Produkt, Merkmale als Aufzählung, keine Werbesprache.',
   'Lastenrad mit Kindersitzbank für zwei. Akku 625 Wh, Reichweite rund 80 km. Rahmenhöhe 50 cm.', 20)
) AS v (id, name, channel_code, beschreibung, beispiele, reihenfolge)
WHERE EXISTS (SELECT 1 FROM channels c WHERE c.code = v.channel_code)
ON CONFLICT (id) DO NOTHING;

INSERT INTO textwerkstatt_stilprofile_verlauf (profil_id, fassung, aktion, felder)
SELECT p.id, 1, 'angelegt', jsonb_build_object('name', p.name, 'channel_code', p.channel_code, 'beschreibung', p.beschreibung, 'beispiele', p.beispiele, 'quelle_art', 'hand')
FROM textwerkstatt_stilprofile p
WHERE p.id IN ('shop', 'katalog')
  AND NOT EXISTS (SELECT 1 FROM textwerkstatt_stilprofile_verlauf h WHERE h.profil_id = p.id);

INSERT INTO textwerkstatt_stilprofile_verlauf (profil_id, fassung, aktion, felder)
SELECT p.id, p.fassung, 'cloud_freigegeben', jsonb_build_object('cloud_freigabe_fassung', p.cloud_freigabe_fassung, 'grund', 'Beispieltexte, angelegt mit dem Seed')
FROM textwerkstatt_stilprofile p
WHERE p.id IN ('shop', 'katalog') AND p.cloud_freigabe_fassung IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM textwerkstatt_stilprofile_verlauf h WHERE h.profil_id = p.id AND h.aktion = 'cloud_freigegeben');
