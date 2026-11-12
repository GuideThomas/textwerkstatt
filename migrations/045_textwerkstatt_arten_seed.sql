-- Füllung der Optimierungsarten (Textwerkstatt Phase 4, Cockpit #1840).
--
-- Die sieben Arten sind allgemein gehalten und enthalten keine Werte dieser Installation. Für die leere Fassung des
-- öffentlichen Repos kann die Datei trotzdem wegbleiben (Plan §3 G5); dann legt man die Arten in der Verwaltung an.
--
-- Nur Erstanlage (`ON CONFLICT DO NOTHING`): Was ein Admin in der Verwaltung ändert, überschreibt der nächste Deploy nicht.
--
-- Längenband: Verhältnis Zeichen Ergebnis / Original. Korrigieren ist eng, weil Rechtschreibung und Satzbau die Länge kaum
-- ändern; ein längeres Ergebnis heißt dort, das Modell hat umformuliert oder ergänzt. Gemessen 11.11.2026 am Korpus
-- (`messung/textwerkstatt-phase4/`): Korrigieren blieb bei 0,97–1,01. Ein absichtlich geschwätziges Original kam nach
-- „Verständlicher“ und „Verkaufsfördernd“ auf 0,62–0,67 und war gut, im dritten Lauf nach „Vereinfachen“ auf 0,58; die untere
-- Grenze aller drei steht deshalb bei 0,50 (vorher 0,75, 0,80 und 0,60). Angepasst am selben Korpus, also nicht unabhängig. Dass dabei nichts verloren geht, prüfen Zahlen- und Werteprüfung, nicht die Länge.
--
-- umstellen_erlaubt FALSE: Korrigieren, Informell, Formell sollen die Reihenfolge der Angaben nicht ändern.

INSERT INTO textwerkstatt_arten
  (id, name, beschreibung, anweisung, zahlen, platzhalter_fehlen_erlaubt, anrede, umstellen_erlaubt, laenge_min, laenge_max, zielzeichen,
   reihenfolge)
VALUES
  ('korrigieren', 'Korrigieren', 'Nur Rechtschreibung, Grammatik, Zeichensetzung und Satzbau. Stil und Inhalt bleiben.',
   'Korrigiere ausschließlich Rechtschreibung, Grammatik, Zeichensetzung und Satzbau. Stil, Wortwahl, Ton und Inhalt bleiben, wie sie sind. Formuliere nichts um, was richtig ist. Ergänze nichts und lass nichts weg.',
   'alle', FALSE, 'beibehalten', FALSE, 0.85, 1.20, FALSE, 1),
  ('verstaendlicher', 'Verständlicher', 'Klarere Sätze und eindeutige Bezüge, alle Aussagen bleiben.',
   'Formuliere den Text verständlicher: klare Sätze, eindeutige Bezüge, die wichtigste Aussage zuerst. Fachbegriffe bleiben stehen. Alle Aussagen und Angaben bleiben vollständig erhalten.',
   'alle', FALSE, 'beibehalten', TRUE, 0.50, 1.60, FALSE, 2),
  ('vereinfachen', 'Vereinfachen', 'Einfache Sprache: kurze Sätze, geläufige Wörter.',
   'Schreibe den Text in einfacher Sprache: kurze Sätze, geläufige Wörter, aktive Formulierungen, ein Gedanke je Satz. Alle Aussagen und Angaben bleiben erhalten.',
   'alle', FALSE, 'beibehalten', TRUE, 0.50, 1.50, FALSE, 3),
  ('kuerzen', 'Kürzen', 'Das Wichtigste behalten, Wiederholungen und Nebensächliches streichen.',
   'Kürze den Text. Behalte die wichtigsten Aussagen und Angaben. Streiche Wiederholungen, Füllwörter und Nebensächliches.',
   'keine_neuen', TRUE, 'beibehalten', TRUE, 0.20, 0.95, TRUE, 4),
  ('verkaufsfoerdernd', 'Verkaufsfördernd', 'Nutzen für den Kunden vorn, lebendige Sprache, sachlich richtig.',
   'Schreibe den Text verkaufsfördernder: den Nutzen für den Kunden in den Vordergrund stellen, aktive und lebendige Sprache, ein klarer Abschluss. Bleib sachlich richtig: keine Übertreibungen, keine Versprechen und keine Eigenschaften, die nicht im Text stehen.',
   'alle', FALSE, 'beibehalten', TRUE, 0.50, 1.80, FALSE, 5),
  ('informell', 'Informell (du)', 'Den Leser duzen, sonst bleibt der Text.',
   'Schreibe den Text in die Du-Form um: Sprich den Leser mit „du“ an, klein geschrieben, und passe Verben und Pronomen an. Sonst bleibt der Text, wie er ist.',
   'alle', FALSE, 'du', FALSE, 0.85, 1.25, FALSE, 6),
  ('formell', 'Formell (Sie)', 'Den Leser siezen, sonst bleibt der Text.',
   'Schreibe den Text in die Sie-Form um: Sprich den Leser mit „Sie“ an und passe Verben und Pronomen an. Sonst bleibt der Text, wie er ist.',
   'alle', FALSE, 'sie', FALSE, 0.85, 1.25, FALSE, 7)
ON CONFLICT (id) DO NOTHING;
