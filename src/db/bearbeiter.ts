/**
 * Wer schreibt: Jeder Schreibweg der Wortliste nennt sich in seiner Transaktion, den Verlauf schreibt dann der Trigger aus Migration
 * 037 (Plan `PLAN-wortliste.md` §2.6, Cockpit #1830).
 *
 * 🚨 `set_config(…, true)` gilt nur bis zum Ende der Transaktion. Außerhalb einer Transaktion wäre die Angabe nach der Anweisung
 * schon wieder weg, und der Verlauf trüge `unbekannt`. Deshalb gibt es `alsBearbeiter`, das die Transaktion selbst öffnet, und
 * `nenneBearbeiter` nur für Wege, die schon in einer stehen.
 */
import type { PoolClient } from 'pg';
import { pool } from './connection';

export interface Bearbeiter {
  /** `users.id` der angemeldeten Person, sonst null. */
  id: string | null;
  /** Anzeigename, E-Mail oder der Name eines Skripts. Leer heißt im Verlauf `unbekannt`. */
  name: string | null;
}

type Abfrage = Pick<PoolClient, 'query'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Der Bearbeiter aus einer Anfrage mit angemeldeter Person (`requireAuth` setzt `req.user`): Anzeigename vor Name vor E-Mail. */
export function bearbeiterAusAnfrage(req: unknown): Bearbeiter {
  const u = (req as { user?: { id?: string | null; email?: string | null; display_name?: string | null; name?: string | null } }).user;
  return { id: u?.id ?? null, name: u?.display_name || u?.name || u?.email || null };
}

/** Setzt den Bearbeiter für die laufende Transaktion. Nur innerhalb von BEGIN … COMMIT aufrufen. */
export async function nenneBearbeiter(c: Abfrage, wer: Bearbeiter): Promise<void> {
  await c.query(`SELECT set_config('wortliste.von_id', $1, true), set_config('wortliste.von', $2, true)`, [
    wer.id && UUID.test(wer.id) ? wer.id : '',
    (wer.name ?? '').trim(),
  ]);
}

/** Führt `arbeit` in einer eigenen Transaktion aus, in der der Bearbeiter genannt ist. */
export async function alsBearbeiter<T>(wer: Bearbeiter, arbeit: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await nenneBearbeiter(c, wer);
    const ergebnis = await arbeit(c);
    await c.query('COMMIT');
    return ergebnis;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
