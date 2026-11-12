-- Channel-Fassung (Deutsch → Deutsch), 27.10.2026 — PLAN-channel-fassung.md
--
-- Ein Dokument mit Quelle und Ziel Deutsch und einem Channel wird nicht von
-- DeepL übersetzt, sondern anhand der Hausschreibweise des Channels
-- umgeschrieben (services/channel-fassung.ts). Je Segment wird festgehalten,
-- wie das geschah, damit die Review-Ansicht es zeigen kann:
--
--   {"herkunft": "sprachmodell" | "regel",
--    "treffer": [{"original": "LED-Trafo", "ersatz": "Netzteil"}],
--    "pruefen": "Nach Regel ersetzt (…) — Artikel und Endungen prüfen" | null}
--
-- NULL = kein Begriff gefunden, Segment unverändert (oder kein DE→DE-Segment).
-- Veraltung: jede Änderung der Hausschreibweise markiert die DE→DE-Segmente
-- als is_stale (routes/house-terms.ts), wie ein Glossar-Update es für seine tut.

ALTER TABLE segments ADD COLUMN IF NOT EXISTS channel_rewrite JSONB;
