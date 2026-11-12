import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { loadHouseTerms } from '../services/house-terms';

/**
 * Hausschreibweise zum Mitnehmen — NUR lesend, für den Mitarbeiter-Chat.
 *
 * Das Chat-Werkzeug „Textprüfung" auf den KI-Stationen garantiert „Der
 * Text verlässt den Server nicht". Es schickt deshalb keinen Text hierher,
 * sondern holt nur die Begriffsliste und sucht auf der Station selbst
 * (Cockpit #1247). Übermittelt wird höchstens ein Channel-Kürzel.
 *
 * Eigener Router statt einer Route im Pflege-Router: Der Chat-Schlüssel öffnet
 * über `sessionOrChatKey(['/'])` genau diesen einen Pfad. Andere Methoden auf
 * denselben Pfad fallen in `server.ts` an den Pflege-Router mit `requireAuth`
 * durch — mit dem Schlüssel allein kommt man dort nicht hinein.
 *
 * Unbekannter Channel → 404 samt Liste, nicht still die Standardliste: Ein
 * Tippfehler im Kürzel sähe sonst genauso aus wie ein Channel ohne Abweichung.
 */
const router = Router();

const CHANNEL_CODE = /^[A-Z0-9_-]{1,20}$/;

router.get('/', async (req: Request, res: Response) => {
  const rawChannel = typeof req.query.channel === 'string' ? req.query.channel.trim().toUpperCase() : '';

  try {
    let channelCode: string | null = null;
    if (rawChannel) {
      if (!CHANNEL_CODE.test(rawChannel)) {
        res.status(400).json({ error: 'channel ist kein gültiges Kürzel' });
        return;
      }
      const known = await pool.query(`SELECT code FROM channels ORDER BY sort_order, code`);
      const codes = known.rows.map((r: { code: string }) => r.code);
      if (!codes.includes(rawChannel)) {
        res.status(404).json({ error: `Unbekannter Channel ${rawChannel}`, availableChannels: codes });
        return;
      }
      channelCode = rawChannel;
    }

    const terms = await loadHouseTerms(channelCode);
    res.json({ channelCode, terms });
  } catch (err) {
    console.error('[HouseTerms] export failed:', err);
    res.status(500).json({ error: 'Hausschreibweise konnte nicht geladen werden' });
  }
});

export default router;
