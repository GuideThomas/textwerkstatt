-- Hausschreibweise (Deutsch → Deutsch) des Beispiel-Ladens: welches Wort er vermeidet und welches er stattdessen schreibt.
-- Wiederholbar über den eindeutigen Index auf lower(avoid_term).

INSERT INTO house_terms (avoid_term, preferred_term, note) VALUES
  ('Ebike',     'E-Bike',  'mit Bindestrich und großem B'),
  ('Velo',      'Fahrrad', 'im Laden sagt man Fahrrad'),
  ('Akkupack',  'Akku',    NULL),
  ('Fahrradreparatur', 'Werkstatt', 'kurz und wie auf dem Schild')
ON CONFLICT DO NOTHING;
