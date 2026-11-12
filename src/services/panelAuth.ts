import crypto from 'crypto';
import { pool } from '../db/connection';
import { config } from '../config';

/**
 * Anmeldung des Illustrator-Panels mit dem eigenen Konto (28.10.2026).
 *
 * Das Panel koppelt sich einmal je Rechner über den Browser: Es legt eine
 * Kopplung an, öffnet die Web-App, die Person meldet sich dort wie gewohnt mit
 * Microsoft an und bestätigt. Danach holt das Panel EINMAL einen persönlichen
 * Schlüssel ab. Plan: PLAN-panel-anmeldung.md.
 *
 * Warum so und nicht über Microsoft direkt im Panel: Die Entra-Registrierung
 * teilt sich das Translationtool mit dem CAD-Tool, sie bleibt unverändert; und
 * Rücksprünge im eingebetteten Adobe-Browser sind ohne Illustrator nicht testbar.
 *
 * Gespeichert wird nur der SHA-256-Hash von Schlüssel und Abhol-Geheimnis. Bei
 * 32 Zufallsbytes ist ein langsamer Hash (bcrypt) unnötig — es gibt nichts zu
 * erraten, nur nachzuschlagen.
 */

export const PAIRING_TTL_MINUTES = 10;
/** Ein Panel-Schlüssel verfällt, wenn er so lange nicht benutzt wurde (Plan §5 F2). */
export const TOKEN_IDLE_DAYS = 180;
/** Obergrenzen offener Kopplungen — die Route zum Anlegen braucht keine Anmeldung. */
export const MAX_OPEN_PAIRINGS_TOTAL = 200;
export const MAX_OPEN_PAIRINGS_PER_CLIENT = 10;

const TOKEN_PREFIX = 'ttp_';
// Ohne 0/O, 1/I/L — der Code wird abgelesen und verglichen
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export class PanelAuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface PanelUser {
  id: string;
  email: string;
  name: string | null;
  display_name: string | null;
  role: string;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Grober, nicht rückrechenbarer Absender für Zählung und Obergrenzen. */
export function clientOf(ip: string | undefined): string {
  return sha256(`${ip || 'unbekannt'}|${config.auth.sessionSecret}`).slice(0, 16);
}

function randomCode(): string {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

function cleanLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const trimmed = label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

/** Vergleicht zwei Geheimnisse in konstanter Zeit (über ihre Hashes, damit die Längen gleich sind). */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

// === Kopplung anlegen (Panel, ohne Anmeldung) ================================

export async function createPairing(label: unknown, client: string): Promise<{
  pairingId: string;
  pollSecret: string;
  code: string;
  expiresInSeconds: number;
}> {
  // Abgelaufenes wegräumen, bevor gezählt wird — ein eigener Lauf lohnt dafür nicht.
  await pool.query(`DELETE FROM panel_pairings WHERE expires_at < NOW() - INTERVAL '1 day'`);

  const open = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE client = $1)::int AS mine
       FROM panel_pairings
      WHERE picked_up_at IS NULL AND expires_at > NOW()`,
    [client],
  );
  if (open.rows[0].mine >= MAX_OPEN_PAIRINGS_PER_CLIENT || open.rows[0].total >= MAX_OPEN_PAIRINGS_TOTAL) {
    throw new PanelAuthError(429, 'Zu viele offene Anmeldungen — bitte in einigen Minuten erneut versuchen');
  }

  const pollSecret = crypto.randomBytes(32).toString('base64url');
  const code = randomCode();
  const result = await pool.query(
    `INSERT INTO panel_pairings (code, poll_secret_hash, label, client, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))
     RETURNING id`,
    [code, sha256(pollSecret), cleanLabel(label), client, PAIRING_TTL_MINUTES],
  );
  return { pairingId: result.rows[0].id, pollSecret, code, expiresInSeconds: PAIRING_TTL_MINUTES * 60 };
}

// === Kopplung abholen (Panel, mit Abhol-Geheimnis) ===========================

export type PollResult =
  | { state: 'pending' }
  | { state: 'ready'; token: string; user: { name: string; email: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function pollPairing(pairingId: string, pollSecret: unknown): Promise<PollResult> {
  if (!UUID_RE.test(pairingId) || typeof pollSecret !== 'string' || pollSecret.length === 0) {
    throw new PanelAuthError(404, 'Kopplung nicht gefunden');
  }
  const found = await pool.query(
    `SELECT poll_secret_hash, confirmed_at, picked_up_at, expires_at < NOW() AS expired
       FROM panel_pairings WHERE id = $1`,
    [pairingId],
  );
  const p = found.rows[0];
  if (!p || !safeEqual(sha256(pollSecret), p.poll_secret_hash)) {
    throw new PanelAuthError(404, 'Kopplung nicht gefunden');
  }
  if (p.picked_up_at) throw new PanelAuthError(410, 'Kopplung wurde bereits verwendet');
  if (p.expired) throw new PanelAuthError(410, 'Kopplung abgelaufen');
  if (!p.confirmed_at) return { state: 'pending' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Genau ein Abholen: Zwei gleichzeitige Abfragen bekommen nicht beide einen Schlüssel.
    const claimed = await client.query(
      `UPDATE panel_pairings SET picked_up_at = NOW()
        WHERE id = $1 AND picked_up_at IS NULL AND confirmed_at IS NOT NULL AND expires_at > NOW()
        RETURNING user_id, label`,
      [pairingId],
    );
    if (claimed.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new PanelAuthError(410, 'Kopplung wurde bereits verwendet');
    }
    const { user_id: userId, label } = claimed.rows[0];
    const userRes = await client.query(
      `SELECT email, name, display_name, active FROM users WHERE id = $1`,
      [userId],
    );
    const u = userRes.rows[0];
    if (!u || !u.active) {
      await client.query('ROLLBACK');
      throw new PanelAuthError(403, 'Konto ist deaktiviert');
    }

    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const tokenRes = await client.query(
      `INSERT INTO panel_tokens (user_id, token_hash, label) VALUES ($1, $2, $3) RETURNING id`,
      [userId, sha256(token), label],
    );
    await client.query(`UPDATE panel_pairings SET token_id = $2 WHERE id = $1`, [pairingId, tokenRes.rows[0].id]);
    await client.query('COMMIT');
    return { state: 'ready', token, user: { name: u.display_name || u.name || u.email, email: u.email } };
  } catch (err) {
    if (!(err instanceof PanelAuthError)) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// === Kopplung ansehen und bestätigen (Web-App, mit Sitzung) ==================

export type PairingState = 'pending' | 'confirmed' | 'used' | 'expired';

export async function getPairing(pairingId: string, userId: string): Promise<{
  code: string;
  label: string | null;
  expiresAt: string;
  state: PairingState;
  confirmedByMe: boolean;
}> {
  if (!UUID_RE.test(pairingId)) throw new PanelAuthError(404, 'Kopplung nicht gefunden');
  const r = await pool.query(
    `SELECT code, label, expires_at, confirmed_at, picked_up_at, user_id, expires_at < NOW() AS expired
       FROM panel_pairings WHERE id = $1`,
    [pairingId],
  );
  const p = r.rows[0];
  if (!p) throw new PanelAuthError(404, 'Kopplung nicht gefunden');
  const state: PairingState = p.picked_up_at ? 'used' : p.confirmed_at ? 'confirmed' : p.expired ? 'expired' : 'pending';
  return {
    code: p.code,
    label: p.label,
    expiresAt: new Date(p.expires_at).toISOString(),
    state,
    confirmedByMe: !!p.confirmed_at && p.user_id === userId,
  };
}

export async function confirmPairing(pairingId: string, userId: string): Promise<void> {
  if (!UUID_RE.test(pairingId)) throw new PanelAuthError(404, 'Kopplung nicht gefunden');
  const r = await pool.query(
    `UPDATE panel_pairings SET user_id = $2, confirmed_at = NOW()
      WHERE id = $1 AND confirmed_at IS NULL AND expires_at > NOW()
      RETURNING id`,
    [pairingId, userId],
  );
  if (r.rows.length > 0) return;
  // Warum nicht? Für eine verständliche Meldung nachsehen.
  const state = await getPairing(pairingId, userId);
  if (state.state === 'expired') throw new PanelAuthError(410, 'Kopplung abgelaufen');
  throw new PanelAuthError(409, 'Kopplung wurde bereits bestätigt');
}

export async function cancelPairing(pairingId: string): Promise<void> {
  if (!UUID_RE.test(pairingId)) throw new PanelAuthError(404, 'Kopplung nicht gefunden');
  await pool.query(
    `UPDATE panel_pairings SET expires_at = NOW() WHERE id = $1 AND confirmed_at IS NULL`,
    [pairingId],
  );
}

// === Schlüssel prüfen (jede Panel-Anfrage) ===================================

export async function lookupPanelToken(token: string): Promise<{ tokenId: string; user: PanelUser } | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const r = await pool.query(
    `SELECT t.id AS token_id, u.id, u.email, u.name, u.display_name, u.role
       FROM panel_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1
        AND t.revoked_at IS NULL
        AND u.active
        AND COALESCE(t.last_used_at, t.created_at) > NOW() - make_interval(days => $2)`,
    [sha256(token), TOKEN_IDLE_DAYS],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Höchstens einmal je Minute schreiben — jede Statusabfrage des Panels käme sonst als UPDATE an.
  pool.query(
    `UPDATE panel_tokens SET last_used_at = NOW()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')`,
    [row.token_id],
  ).catch((err) => console.error('[Panel] last_used_at:', err));
  const { token_id: tokenId, ...user } = row;
  return { tokenId, user };
}

export async function recordSharedKeyUse(client: string): Promise<void> {
  await pool.query(
    `INSERT INTO cep_shared_key_uses (day, client, uses) VALUES (CURRENT_DATE, $1, 1)
     ON CONFLICT (day, client) DO UPDATE SET uses = cep_shared_key_uses.uses + 1, last_at = NOW()`,
    [client],
  );
}

// === Verbindungen ansehen und trennen ========================================

export async function listTokens(opts: { userId?: string }): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [TOKEN_IDLE_DAYS];
  let where = `t.revoked_at IS NULL`;
  if (opts.userId) {
    params.push(opts.userId);
    where += ` AND t.user_id = $2`;
  }
  const r = await pool.query(
    `SELECT t.id, t.label, t.created_at, t.last_used_at,
            COALESCE(t.last_used_at, t.created_at) + make_interval(days => $1) AS expires_at,
            COALESCE(t.last_used_at, t.created_at) + make_interval(days => $1) < NOW() AS expired,
            u.id AS user_id, COALESCE(u.display_name, u.name, u.email) AS user_name, u.email AS user_email
       FROM panel_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE ${where}
      ORDER BY COALESCE(t.last_used_at, t.created_at) DESC`,
    params,
  );
  return r.rows;
}

/** Trennt eine Verbindung. Wer nicht Admin ist, nur die eigene. */
export async function revokeToken(tokenId: string, by: { id: string; role: string }): Promise<void> {
  if (!UUID_RE.test(tokenId)) throw new PanelAuthError(404, 'Verbindung nicht gefunden');
  const params: unknown[] = [tokenId, by.id];
  const ownerClause = by.role === 'admin' ? '' : ' AND user_id = $2';
  const r = await pool.query(
    `UPDATE panel_tokens SET revoked_at = NOW(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL${ownerClause}
      RETURNING id`,
    params,
  );
  if (r.rows.length === 0) throw new PanelAuthError(404, 'Verbindung nicht gefunden');
}
