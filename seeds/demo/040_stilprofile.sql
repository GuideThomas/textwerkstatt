-- Stilprofile des Beispiel-Ladens, je Channel eines, eingeschaltet (ein Profil braucht dafür eine Beschreibung ab 20 Zeichen).
-- Ein Profil, das es schon gibt, bleibt, wie der Admin es zuletzt gespeichert hat.

INSERT INTO textwerkstatt_stilprofile (id, name, channel_code, beschreibung, beispiele, aktiv, reihenfolge)
SELECT v.id, v.name, v.channel_code, v.beschreibung, v.beispiele, TRUE, v.reihenfolge
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
