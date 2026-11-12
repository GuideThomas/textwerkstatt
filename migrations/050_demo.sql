-- Demo-Modus (`PLAN-oeffentlich-und-demo.md` Phase 2): Zeichenzähler und Stand des Zurücksetzens.
--
-- Beide Tabellen bleiben leer, solange `DEMO_MODUS` nicht `an` ist; die Produktion schreibt nie hinein.
--
-- `demo_verbrauch`: Zeichen je Tag, Art (`deepl`, `ki`) und Sitzung. `wer = ''` ist die Summe der ganzen Demo — die DeepL-Grenze
-- schützt das Kontingent der Firma (Entscheid E5). Gezählt wird vor dem Aufruf (`src/demo/grenzen.ts`), also auch, was danach
-- scheitert: lieber zu früh an der Grenze als darüber.
--
-- `demo_stand`: eine Zeile, die das Zurücksetzen (Phase 6) schreibt und das Banner liest („nächster Reset am …“).
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

CREATE TABLE IF NOT EXISTS demo_verbrauch (
  tag      DATE   NOT NULL,
  art      TEXT   NOT NULL CHECK (art IN ('deepl', 'ki')),
  wer      TEXT   NOT NULL DEFAULT '',
  zeichen  BIGINT NOT NULL DEFAULT 0 CHECK (zeichen >= 0),
  PRIMARY KEY (tag, art, wer)
);

CREATE TABLE IF NOT EXISTS demo_stand (
  id               BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  letzter_reset    TIMESTAMPTZ,
  naechster_reset  TIMESTAMPTZ
);
