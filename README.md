# Textwerkstatt

A writing and translation workbench for organisations that care about their wording. Check a German text, improve it with an
AI model under hard checks, and translate it with DeepL using your own glossary, your own channels and the form of address you
want. Whole documents too: InDesign (IDML), Word, Excel, PDF and Illustrator.

[Deutsch](README.de.md)

## Set it up with your AI

You do not need to know Node.js or Docker. Hand this repository to the AI tool you already use (Claude Code, Codex, Cursor,
Gemini CLI …) and let it do the installation and the adjustments for your organisation. [docs/setup-with-ai.md](docs/setup-with-ai.md)
has sentences to copy, what the AI should ask you first and what only you can do. The AI finds its instructions in
[AGENTS.md](AGENTS.md).

## What it does

### Check

LanguageTool finds spelling and grammar mistakes. Your house style (words you avoid and what you write instead) is checked on
the same page. Brand names you list are never "corrected".

### Optimise

An AI model rewrites the text in one of several ways: correct, clearer, simpler, shorter, persuasive, informal, formal, or in the
style profile of a channel. The instruction asks; a check afterwards decides. A result is rejected if a number or unit changed,
a placeholder or a name disappeared, a word you avoid crept in, the form of address flipped or the length left its band. You
take over the whole result or single paragraphs.

Before a text goes to a cloud model, names, companies, e-mail addresses, phone and bank numbers, addresses and your own
protected terms are replaced by placeholders, and the answer is checked against them. Local models get the text as it is.

### Translate

DeepL translates with your glossary, per channel and with the form of address you choose (formal, informal or default, where
DeepL supports it). Markup, placeholders and tags survive the round trip. A glossary only holds deliberate deviations: terms
DeepL would translate differently from how you want them.

### Glossary and house style

One glossary per language pair, with a history of every change. A term can read differently per channel. Who writes directly
is a switch: only admins (default), or everybody signed in. Non-admins propose, admins approve.

### Documents

IDML, DOCX, XLSX, PDF (via Docling), XML, HTML, CSV, Markdown and plain text are translated segment by segment and rebuilt in
their own format; CSV exports from Magento keep their store-view links. A segment cache reuses
earlier translations, a character limit per text frame keeps layouts intact, and native speakers can review and approve a
translation before it is released. An Illustrator panel exchanges texts with open documents.

## Installation

You need Docker with Docker Compose, a DeepL API key and, for Optimise, access to an OpenAI-compatible model endpoint.

```bash
git clone https://github.com/GuideThomas/textwerkstatt.git
cd textwerkstatt
cp .env.example .env
```

Open `.env` in an editor and set at least `DB_PASSWORD` and `SESSION_SECRET` to long random values, and `DEEPL_API_KEY` to your
key. Docker can make the random values for you (copy each into `.env`, run it once per value):

```bash
docker run --rm alpine:3.20 sh -c "tr -dc a-f0-9 </dev/urandom | head -c 64; echo"
```

Then:

```bash
docker compose up -d
```

If Docker reports `ports are not available` (Windows reserves some ports), add `APP_PORT=3106` to `.env`, run the command again
and use that port in the address below. Without a DeepL key the tool starts as well; checking and house style work, translating
does not, and the log shows `API key is invalid` until the key is set.

The interface runs on http://localhost:3006, only on this machine (another port: `APP_PORT` in `.env`). On every start the container brings the database schema up to date and
loads the example content from `seeds/demo/` (a small bicycle shop with two channels, a glossary DE→EN and DE→FR, house style
and style profiles). Whatever you delete from the example is therefore back after a restart. Set `SEED=` in `.env` to start
empty, or put your own content into `seeds/<name>/`, set `SEED=<name>` and run `docker compose up -d --build` once (seeds and
themes live in the image).

Create the first admin account in a terminal of your own (PowerShell, Terminal); the command asks for the password (at least 12
characters), so an AI tool cannot type it for you, and it only works while there is no admin yet. Further accounts are created by an admin under Administration › Users, or on first Microsoft sign-in (`AZURE_*`).

```bash
docker compose exec -it app node dist/db/erster-admin.js you@example.com "Your Name"
```

To expose it on a domain, put a reverse proxy with TLS in front (nginx, Caddy) and set `APP_URL`.

## Services and settings

All settings live in `.env`; [.env.example](.env.example) explains each one.

| Service | Needed for | Settings |
|---|---|---|
| PostgreSQL 16 | everything | `DB_*` (Compose starts it) |
| DeepL API | translating, glossaries | `DEEPL_API_KEY` |
| OpenAI-compatible endpoint (e.g. LiteLLM) | Optimise, shortening, name forms | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_*_MODEL`, one key per AI route `KI_WEG_<NAME>_KEY` |
| LanguageTool | Check | `LANGUAGETOOL_URL` (Compose starts it) |
| Docling | PDF | `DOCLING_URL` |
| Microsoft Entra ID | single sign-on | `AZURE_*` |
| Mail server | review invitations | `MAIL_FROM` (SMTP on 127.0.0.1:25 of the machine the server runs on; the Compose container has none there) |
| Your organisation | names in the interface | `ORGANISATION_NAME`, `APP_NAME`, `GESCHUETZTE_WOERTER` |
| Appearance | colours, logo, font | build argument `THEMA`, folder `client/themes/<name>/` |

## Security model

- Keys only in `.env`, never in the code or the repository. The server listens on 127.0.0.1; the way out is a reverse proxy.
- Machine routes (batch translation, shortening, translation check, chat access, Illustrator panel) are closed to the outside
  while their key is empty. An empty key never means "open": without `TRANSLATION_SERVICE_KEY`, batch translation, shortening
  and the translation check accept calls made directly on the same machine only, not through the reverse proxy.
- Switches close when they are missing: an unknown `GLOSSAR_FREIGABE` means "admins only", `DEMO_MODUS=an` without a password
  refuses to start.
- Free text reaches a cloud model only through the pseudonymisation and its check afterwards. Its limits: it recognises the
  classes above and your protected list, not every confidential fact in a sentence. Meaning words around a number ("at least"
  → "up to") are not checked. Do not send texts that must not leave the house to a cloud route at all; use a local model.
- Each AI route has its own key, so a budget can stop it alone. Optimise never falls back to another model. Only shortening
  and name forms use `LLM_FALLBACK_MODEL` when the primary model fails.

## Demo

A public demo with example content runs at https://textwerkstatt.thomaswinkler.art. It is protected by a password
(`DEMO_MODUS=an`, the same application as in this repository) and is reset to the example content every ten days; the date is
shown in the notice above every page. Please do not enter confidential texts there. The reset itself is an operations script
on the server and not part of this repository.

## Development

```bash
npm ci && (cd client && npm ci)
npm run dev
```

Checks run against a throwaway database (they rebuild its schema):

```bash
npm run build:server
node scripts/oeffentlich/pruefen.mjs
```

The header of [scripts/oeffentlich/pruefen.mjs](scripts/oeffentlich/pruefen.mjs) shows how to start that database with Docker.

## Licence

All rights reserved for now. A licence will follow. Issues are welcome.
