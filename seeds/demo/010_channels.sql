-- Demo und öffentliches Repo: zwei Verkaufskanäle eines erfundenen Fahrradladens. Nur Erstanlage (ON CONFLICT DO NOTHING).
-- Eigene Kanäle legt ein Admin unter Verwaltung an, oder man schreibt einen eigenen Seed (seeds/<name>/, AGENTS.md).

INSERT INTO channels (code, name, sort_order) VALUES
  ('SHOP', 'Onlineshop', 1),
  ('KATALOG', 'Katalog', 2)
ON CONFLICT (code) DO NOTHING;
