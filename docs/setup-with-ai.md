# Set up Textwerkstatt with your AI

No prior knowledge needed. An AI tool that may run commands on your computer (Claude Code, Codex, Cursor, Gemini CLI …) does the
installation and the adjustments. It reads [AGENTS.md](../AGENTS.md) for that. You copy one of the sentences below, answer its
questions and do the few things only you can do.

[Deutsch](mit-ki-einrichten.md)

## What only you do

- **Get and enter the keys.** A DeepL API key (deepl.com, "API" plan) and, if you want Optimise, a key for an AI model. Enter
  them yourself with an editor into the file `.env`. Do not paste them into the chat: whatever is in the chat counts as passed on.
- **Choose the admin password** and type it when the command asks for it.
- **Keep an eye on costs.** DeepL and cloud models charge per character. Set a budget with your model provider.

## Step 1: Install

> Install Textwerkstatt from this folder locally with Docker, following the README. Create `.env` from `.env.example`, but do
> not enter any keys; tell me which ones I have to enter myself. Then start it and check that http://localhost:3006 answers.
> Then help me create the first admin account.

The AI should first ask: whether Docker is already installed, whether the workbench runs only on this computer or later under an
address of its own, and whether you want to start with the example content (bicycle shop) or empty.

## Step 2: Set it up for your organisation

> Set up Textwerkstatt for my company ‹name›. Our sales channels are ‹online shop, catalogue, …›, we translate into ‹English,
> French, …›. Our brand and product names that must never be changed: ‹…›. Create a seed of our own for this instead of
> changing the example content.

The AI should first ask: whether the example content should go, who else becomes admin, and whether everybody signed in may write
to the glossary directly or only propose (`GLOSSAR_FREIGABE`).

## Step 3: Import a glossary

> Import my glossary from this Excel file ‹path›. Column A is German, the other columns are the target languages. Only take
> terms DeepL would translate differently without a glossary, and show me the list first.

The AI should first ask: which row is the header, what an empty cell means, and whether terms differ per sales channel. Expect
it to use some DeepL characters for the comparison: with 500 terms and three languages only a few thousand.

## Step 4: Adjust colours and logo

> Adapt the colours and logo of Textwerkstatt to our corporate design: main colour ‹…›, font ‹…›, the logo is at ‹path›. Create
> a theme of our own for this and check the contrasts afterwards.

The AI should first ask: whether the font may be served from your own server (no requests to other servers such as Google
Fonts) and whether the header should be light or dark.

## If something does not work

> Textwerkstatt does not start or shows an error. Read the logs with `docker compose logs app` and tell me in plain words what
> is wrong before you change anything.
