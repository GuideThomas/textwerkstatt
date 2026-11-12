# AGENTS.md — instructions for AI coding tools

You are helping someone install or adapt **Textwerkstatt**, a web tool to check, improve and translate texts (Node.js + Express +
PostgreSQL on the server, React + Vite + Tailwind in `client/`). The person may not be a developer. Ask before you decide
anything that costs money or changes what their colleagues see; explain in plain words what you did. The user-facing guide with
sentences to copy is [docs/setup-with-ai.md](docs/setup-with-ai.md) ([German](docs/mit-ki-einrichten.md)).

## Layout

| Path | What it is |
|---|---|
| `src/` | server: routes in `src/routes/`, logic in `src/services/`, settings in `src/config.ts` (read from `.env`) |
| `client/` | interface; texts in six languages under `client/src/i18n/locales/<lang>/*.json` |
| `client/themes/<name>/` | appearance: `index.tsx` (logo, header, footer), `thema.css` (colours as `--pal-*`), `tailwind.json`, `public/` (favicon, fonts) |
| `migrations/` | database schema only, applied in order on every start, each file safe to run again |
| `seeds/<name>/` | content of one installation: channels, glossary, house style, style profiles. `seeds/demo/` is the example |
| `scripts/*.test.mjs`, `scripts/oeffentlich/*.test.mjs` | checks, run all with `scripts/oeffentlich/pruefen.mjs` |
| `cep-panel/`, `illustrator-scripts/` | Adobe Illustrator panel and scripts |

## Where to change what

| Wish | Where |
|---|---|
| Name of the organisation, of the tool, protected brand names | `.env`: `ORGANISATION_NAME`, `APP_NAME`, `GESCHUETZTE_WOERTER` (comma list) |
| Sales channels | new seed `seeds/<name>/010_channels.sql` (pattern: `seeds/demo/010_channels.sql`), or Administration in the interface |
| Glossary from a spreadsheet | turn the rows into `seeds/<name>/020_glossar.sql` (pattern: `seeds/demo/020_glossar.sql`): only terms DeepL would translate differently, `approved TRUE`, **never** a `deepl_glossary_id` |
| House style (words to avoid) | `seeds/<name>/030_hausschreibweise.sql` or the interface |
| Style profiles per channel | `seeds/<name>/040_stilprofile.sql` or Administration › Style profiles |
| Colours, logo, font | copy `client/themes/atelier/` to `client/themes/<name>/`, change it, build with `THEMA=<name>` (Docker: `docker compose build --build-arg THEMA=<name>`) |
| AI models | `.env`: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_*_MODEL`; per route a key `KI_WEG_<NAME>_KEY`; routes are rows in table `ki_wege` (Administration › AI connection) |
| Who may write the glossary | `.env`: `GLOSSAR_FREIGABE=admin` (default) or `alle` |

A seed is loaded with `SEED=<name>` (Docker) or `node dist/db/seed.js <name>`; several names are loaded in the given order
(`SEED="base mine"`). Every seed file must be safe to run again (`ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS`),
because the container loads it on every start.

## After a change

```bash
npm run build                        # client and server; must stay green
node scripts/oeffentlich/pruefen.mjs # all checks, needs a throwaway Postgres (see the file header)
```

If you changed colours: `node scripts/oeffentlich/thema.test.mjs` (every `--pal-*` the interface reads must be set in every theme).

## Hard rules

1. **Keys only in `.env`.** Never write a key, password or token into a file in the repository, a commit, an issue or your
   chat output. `.env` is in `.gitignore`; keep it there. The person types keys into `.env` themselves, in an editor.
2. **Listen on 127.0.0.1.** The server binds to 127.0.0.1; only the container sets `BIND_ADDRESS=0.0.0.0`, and Compose publishes
   on `127.0.0.1:3006`. Do not publish on `0.0.0.0`. For a domain, put a reverse proxy with TLS in front.
3. **Free text to cloud models only through the pseudonymisation** (`src/services/pseudonym/`). Do not add a new route that
   sends text to a cloud model directly; use the existing helpers and their checks.
4. **Migrations stay repeatable.** `migrations/*.sql` run on every start: `IF NOT EXISTS`, no data that belongs to one
   installation (that goes into a seed).
5. **Switches close when missing.** An unknown `GLOSSAR_FREIGABE` means admins only; `DEMO_MODUS=an` without `DEMO_PASSWORT`
   refuses to start. Keep that behaviour when you add a switch.
6. **Costs.** DeepL and cloud models cost money. Tell the person before a bulk translation, and suggest a budget on their model
   key.

## Installing for someone

- `DB_PASSWORD` and `SESSION_SECRET`: generate long random values and write them **directly into `.env`**, never print them, e.g.
  `docker run --rm alpine:3.20 sh -c "tr -dc a-f0-9 </dev/urandom | head -c 64"` piped into your edit of `.env`.
- `ports are not available` on Windows: set `APP_PORT=<free port>` in `.env` and tell the person the new address.
- The tool starts without a DeepL key (log: `API key is invalid`); tell the person what works without it (check, house style) and
  what does not (translate).
- `APP_URL` stays empty for a local installation.

## First admin

```bash
docker compose exec -it app node dist/db/erster-admin.js name@example.com "Name"
```

It asks for the password on its input (at least 12 characters) and only works while no admin exists. It needs an interactive
terminal: give the person the command to run themselves; do not choose or type the password for them.
