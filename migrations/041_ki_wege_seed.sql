-- Füllung der KI-Wege für diese Installation (Textwerkstatt Phase 2, Cockpit #1838).
--
-- ⚠️ Für die leere Fassung des öffentlichen Repos diese Datei WEGLASSEN (Plan §3 G5). Die Wege legt man dann in der
-- Verwaltung „KI-Anbindung“ an; jeder OpenAI-kompatible Endpunkt reicht.
--
-- Nur Erstanlage (`ON CONFLICT DO NOTHING`): Was ein Admin in der Verwaltung ändert, überschreibt der nächste Deploy nicht.
--
-- Warum je Weg ein eigener Schlüssel (gemessen 10.11.2026 an LiteLLM v1.91.0, Plan §4 Phase 2 „Befund“):
--   - `no-log: true` hält den Text aus Tempo heraus, schreibt aber auch keine SpendLogs-Zeile.
--   - Die Schwärzungsschalter (`turn_off_message_logging`, Kopfzeile `x-litellm-enable-message-redaction`,
--     `x-litellm-disable-callbacks`) ließen das Kennwort ganz oder teilweise in Tempo.
--   Der Nachweis „blieb lokal“ ist deshalb die Positivliste des lokalen Schlüssels (nur `station-lokal`, Gegenprobe 403).
--
-- Lokal: Denken aus (sonst 16–26 s für drei Sätze) und ohne Protokoll in Tempo (Entscheid Thomas 10.11.2026: nur Cloud).
-- Cloud: `gpt-5.6-luna` (Entscheid Thomas 10.11.2026 nach dem Blindtest), Denken knapp wie im Modellvergleich.
-- `extra_body` steht wörtlich im Körper: Felder auf oberster Ebene verwirft LiteLLM wegen `drop_params` still.
-- `num_retries: 0` in beiden: Der Proxy wiederholt sonst nach `router_settings.num_retries: 3` denselben Text, bei der
-- Station mit 240 s Zeitlimit bis zu 16 Minuten. Der Wert der Anfrage gewinnt (`router.py`: kwargs.get("num_retries", …)),
-- angenommen mit HTTP 200 am 10.11.2026; die Wirkung bei einem Ausfall ist ungeprüft.

INSERT INTO ki_wege (id, name, art, modell, endpunkt_variable, schluessel_variable, zeitlimit_s, zusatz_parameter, budget_lesen, reihenfolge)
VALUES
  ('lokal', 'Lokal (Station)', 'lokal', 'station-lokal', 'LLM_BASE_URL', 'KI_WEG_LOKAL_KEY', 240,
   '{"no-log": true, "num_retries": 0, "cache": {"no-cache": true}, "extra_body": {"chat_template_kwargs": {"enable_thinking": false}}}'::jsonb,
   FALSE, 1),
  ('cloud', 'Cloud (gpt-5.6-luna)', 'cloud', 'gpt-5.6-luna', 'LLM_BASE_URL', 'KI_WEG_CLOUD_KEY', 60,
   '{"num_retries": 0, "cache": {"no-cache": true}, "extra_body": {"reasoning_effort": "low"}}'::jsonb,
   TRUE, 2)
ON CONFLICT (id) DO NOTHING;
