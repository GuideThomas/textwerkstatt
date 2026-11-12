/**
 * Legt in einer frischen Installation das erste Admin-Konto an (Anmeldung mit E-Mail und Passwort).
 *
 *   node dist/db/erster-admin.js <email> [<name>]        Passwort danach über STDIN (eine Zeile, mindestens 12 Zeichen)
 *   docker compose exec -it app node dist/db/erster-admin.js admin@example.com "Vorname Name"
 *
 * Sonst legt nur ein Admin Konten an (Verwaltung › Benutzer), oder sie entstehen bei der ersten Microsoft-Anmeldung als `user`.
 * Ohne diesen Weg käme eine Installation ohne Microsoft nie hinein.
 *
 * Läuft nur, solange es KEIN aktives Admin-Konto gibt; danach bricht es ab, statt ein zweites anzulegen oder ein Passwort zu
 * überschreiben. Das Passwort kommt nie als Argument (es stünde sonst in der Prozessliste und im Shell-Verlauf).
 */
import bcrypt from 'bcryptjs';
import readline from 'readline';
import { pool } from './connection';

async function passwortLesen(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  if (process.stdin.isTTY) process.stdout.write('Passwort (mindestens 12 Zeichen): ');
  for await (const zeile of rl) {
    rl.close();
    return zeile.replace(/\r$/, '');
  }
  return '';
}

async function main(): Promise<void> {
  const [email, name] = process.argv.slice(2);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Aufruf: node dist/db/erster-admin.js <email> [<name>]   (Passwort über STDIN)');
    process.exit(1);
  }
  const vorhanden = await pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`);
  if (vorhanden.rows[0].n > 0) {
    console.error('Es gibt schon ein aktives Admin-Konto. Weitere Konten legt ein Admin in der Verwaltung an.');
    process.exit(1);
  }
  const passwort = await passwortLesen();
  if (passwort.length < 12) {
    console.error('Passwort fehlt oder ist kürzer als 12 Zeichen, nichts angelegt.');
    process.exit(1);
  }
  const r = await pool.query(
    `INSERT INTO users (email, name, display_name, password_hash, role)
     VALUES ($1, $2, $2, $3, 'admin')
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email.trim(), name?.trim() || null, bcrypt.hashSync(passwort, 10)],
  );
  if (r.rowCount === 0) {
    console.error(`Ein Konto mit ${email} gibt es schon (nicht Admin). Nichts geändert.`);
    process.exit(1);
  }
  console.log(`Admin angelegt: ${email.trim()} (Anmeldung mit genau dieser Schreibweise)`);
  await pool.end();
}

main().catch((err) => {
  console.error('Fehler:', err instanceof Error ? err.message : err);
  process.exit(1);
});
