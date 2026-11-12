-- Neutrale Channels für die Testskripte (scripts/*.test.mjs). Nie in einer echten Installation einspielen.
INSERT INTO channels (code, name, sort_order) VALUES
  ('SHOPA', 'Shop A', 1),
  ('SHOPB', 'Shop B', 2),
  ('SHOPC', 'Shop C', 3),
  ('B2C', 'B2C', 4)
ON CONFLICT (code) DO NOTHING;
