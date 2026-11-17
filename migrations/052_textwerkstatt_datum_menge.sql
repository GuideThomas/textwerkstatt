-- Textwerkstatt: zwei weitere Schutzklassen, DATUM und MENGE (Entscheid Thomas 17.11.2026: vor der Cloud sollen „Namen,
-- Firmenbezeichnungen, Adressen, Datum und Mengen“ verdeckt sein). Die Erkennung steht in `services/pseudonym/pseudonymize.ts`.
-- Beide sind abschaltbar, keine Pflichtklasse. Die Stufe „streng“ (jedes Eigenname-Wort) ist keine Klasse dieser Tabelle,
-- sie wählt der Nutzer in der Vorschau.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus, 042 vorher. 042 legt die Tabelle mit dem alten
-- CHECK an (ohne Wirkung, wenn es sie gibt); hier wird er jedes Mal durch den neuen ersetzt.

ALTER TABLE textwerkstatt_schutzklassen DROP CONSTRAINT IF EXISTS textwerkstatt_schutzklassen_klasse_check;
ALTER TABLE textwerkstatt_schutzklassen ADD CONSTRAINT textwerkstatt_schutzklassen_klasse_check
  CHECK (klasse IN ('BANK', 'MAIL', 'TELEFON', 'PERSON', 'ANSCHRIFT', 'URL', 'FIRMA', 'PROJEKT', 'PREIS', 'ARTIKELNR', 'BELEGNR',
                    'DATUM', 'MENGE'));

INSERT INTO textwerkstatt_schutzklassen (klasse) VALUES ('DATUM'), ('MENGE')
ON CONFLICT (klasse) DO NOTHING;
