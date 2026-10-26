# Cardsmith

**Turn any note into flashcards you can study tonight, with your own AI key or a local Ollama model. Nothing is saved until you approve it.**

*Made by Mira Forge, an AI-run studio: Cardsmith's code is written and tested by AI agents ([details](#disclosures)).*

![Cardsmith demo: a note becomes cards, you review them, then they are saved into the note](docs/cardsmith-demo.gif)

[Docs](#how-to-use) · [Pricing](https://miraforge-site.pages.dev/cardsmith/#pricing) · [Support](#support) · [Listing](https://community.obsidian.md/plugins/cardsmith)

**Install from Obsidian:** Settings → Community plugins → Browse, search for “Cardsmith”, select **Install**, then **Enable**. Listing: https://community.obsidian.md/plugins/cardsmith

Free covers single notes (up to 10 cards each) with your own AI key or Ollama, including Anki export of that note; Pro is $3/month (tax included, cancel anytime) and adds whole folders, cloze and reversed cards, vault-wide Anki export, custom instructions and up to 50 cards per note. Cardsmith connects only to the AI provider you pick and, if you add Pro, our license service; see [Disclosures](#disclosures).

## Features

- **Cards from the note you are reading.** Run one command (or select the layers icon) on a note or a selection.
- **You approve every card.** A review window lets you edit, untick or keep each card. Nothing touches your note until you select **Insert**.
- **Your AI, your account.** OpenAI, Anthropic, OpenRouter, any OpenAI-compatible endpoint, or **Ollama on your own computer**, so nothing leaves your machine.
- **Your note stays yours.** Cards go into one clearly marked block at the end of the note. Running it again replaces only that block.
- **Anki export, offline.** Export a note's cards, including ones you wrote by hand, to an Anki import file. No AI and no network needed.

## Works with Spaced Repetition and Anki

Cardsmith doesn't replace your review tool; it fills it. Cards are written in the format used by the [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) plugin, so you keep reviewing in Obsidian exactly as you do now. Prefer Anki? Export the same cards to an Anki import file.

## How to use

1. **Pick a model.** In **Settings → Cardsmith**, choose a provider.
   - **Ollama (local, free):** install [Ollama](https://ollama.com), run `ollama pull llama3.1`, and keep the base URL `http://localhost:11434`. Nothing leaves your computer.
   - **OpenAI, Anthropic or OpenRouter:** pick the provider and select **Link…** next to *API key* to store your key in Obsidian's keychain.

   ![Cardsmith settings with Ollama selected](docs/step-1-provider.png)

2. **Generate.** Open a note (or select part of it) and run **Cardsmith: Generate flashcards from this note or selection** from the command palette, or select the layers icon in the ribbon.

   ![Running Cardsmith from the ribbon](docs/step-2-generate.png)

3. **Review.** Edit or untick cards in the review window, then select **Insert**.

   ![Review window with one card unticked](docs/step-3-review.png)

4. **Study.** Cards go into a block at the end of the note, ready for the Spaced Repetition plugin:

   ```markdown
   %% cardsmith:start hash=1a1ac837 %%
   #flashcards

   What does the mitochondrion produce?::ATP
   %% cardsmith:end %%
   ```

   ![Cards saved at the end of the note](docs/step-4-cards-in-note.png)

   Running it again replaces that block; the rest of your note is never touched.

5. **Or export to Anki.** Run **Export this note's flashcards to Anki** and import the `.txt` file in Anki with **File → Import**. Note type, deck and tags are set automatically (Anki 2.1.55 or later).

   ![Anki export notice](docs/step-5-anki-export.png)

### Card syntax written

`Question::Answer` (basic), `Term:::Definition` (reversed), multi-line cards separated by `?` or `??`, and cloze cards using `==highlights==`, all as described in the Spaced Repetition plugin's documentation. The deck tag (default `#flashcards`) is configurable.

## Install

Cardsmith is in Obsidian's in-app Community plugins browser:

1. In Obsidian, open **Settings → Community plugins** (turn on community plugins if asked).
2. Select **Browse**, search for **Cardsmith**, and select **Install**.
3. Select **Enable**.

You can also install it manually, one of these two ways:

- **From the GitHub release:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/mira-forge/cardsmith/releases/latest). Put them in a new folder `<your vault>/.obsidian/plugins/cardsmith/`. Then, in Obsidian, open **Settings → Community plugins**, select the reload button next to *Installed plugins*, and enable **Cardsmith**.
- **With BRAT:** install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, run BRAT's **Add a beta plugin for testing** command, enter `mira-forge/cardsmith`, then enable **Cardsmith** under **Settings → Community plugins**.

Every release is built by GitHub Actions with a signed build provenance attestation.

## Free and Pro

Free covers single notes (up to 10 cards each) with your own AI key or Ollama, including Anki export of that note; Pro is $3/month (tax included, cancel anytime) and adds whole folders, cloze and reversed cards, vault-wide Anki export, custom instructions and up to 50 cards per note.

| | Free | Pro |
|---|---|---|
| Generate cards from the current note or a selection | ✓ | ✓ |
| Review, edit and drop cards before they are saved | ✓ | ✓ |
| Basic question/answer cards | ✓ | ✓ |
| Cards per note | up to 10 | up to 50 |
| Export a note's cards to Anki (offline) | ✓ | ✓ |
| Ollama, OpenAI, Anthropic, OpenRouter, custom endpoints | ✓ | ✓ |
| Cloze and reversed cards | | ✓ |
| Generate for a whole folder in one run | | ✓ |
| Refresh only notes that changed since their cards were made | | ✓ |
| Export a folder or the whole vault to Anki, with decks from folders | | ✓ |
| Custom instructions for the model | | ✓ |

If your subscription ends, Pro features switch off and your existing cards stay exactly where they are. If you are offline, Pro keeps working for 7 days after the last successful license check.

## Pro license

Buy Pro from the link in **Settings → Cardsmith → License**, then paste your key and select **Activate**. **Remove license** frees the device. Each key works on up to 3 devices. Manage or cancel your subscription from Link's order management, linked from your receipt email (Link handles receipts, renewals and refunds). If you lose your key, use the recovery page linked from the purchase confirmation page, with the email address and invoice number from your receipt.

## Privacy

Mira Forge runs one server for Cardsmith: the license service described under **Network use**. It stores no names, emails, payment details or note content; for each device it keeps only a hashed device ID with first-seen and last-seen times. Full details: [privacy policy](https://miraforge-site.pages.dev/privacy/), [terms](https://miraforge-site.pages.dev/terms/), [refund policy](https://miraforge-site.pages.dev/refunds/). Stripe and Link process purchases as merchant of record under the [Link privacy policy](https://link.com/privacy) and [Stripe privacy policy](https://stripe.com/privacy). Your AI provider processes the text you send under its own terms.

## Vault access

Cardsmith never scans your whole vault on its own.

- **This note or selection:** reads only the active note.
- **Export this note to Anki:** reads only the active note and its tags from Obsidian's metadata cache.
- **Generate or export a folder (Pro):** lists Markdown notes only inside the folder you choose, by walking that folder's children (subfolders included). Files outside it are not listed or read.
- **When the whole vault is involved:** only if you pick **/ (whole vault)** in the folder picker. Then every note except those in the Anki export folder is in scope, because that is what you asked for. The folder picker itself lists folder names (not files or contents) so you can choose one.

## Disclosures

- **Payment is required for full access.** Cardsmith is free to use for single notes. Some features (listed below) need a paid **Cardsmith Pro** license. Pro is sold by Mira Forge through Link, Stripe's merchant-of-record service ([Stripe Managed Payments](https://docs.stripe.com/payments/managed-payments)). Your card statement shows **LINK.COM\* MIRAFORGE**. Nothing is locked behind an account in Obsidian, and the free features never stop working.
- **Network use.** Cardsmith only connects to:
  1. **The AI provider you choose** (OpenAI, Anthropic, OpenRouter, any OpenAI-compatible endpoint, or Ollama on your own machine). This happens only when you ask it to generate cards. It sends the note or selection you picked plus instructions. Requests go straight from your device to that provider under your own account. Mira Forge never receives your notes or your API key.
  2. **The Cardsmith license service** (a Mira Forge Cloudflare Worker at `cardsmith-license-stripe.miraforge.workers.dev`), only if you enter a Pro license key. It sends the key, a random device ID generated on your device, and the product name `cardsmith`. This happens once when you activate, then at most once a day to check the subscription is still active, and once when you select **Remove license**. No note content, vault names, names or email addresses are sent, and the device ID is not derived from your hardware or account. The service stores only: a SHA-256 hash of the key (never the key itself); for each activated device, a SHA-256 hash of its device ID with the time it was first seen and last seen; the Stripe subscription and customer IDs; and the subscription's status, renewal or end date, and whether it was refunded or disputed; plus the IDs of Stripe payment events it has already processed (deleted after 30 days). See the [privacy policy](https://miraforge-site.pages.dev/privacy/), [terms](https://miraforge-site.pages.dev/terms/) and [refund policy](https://miraforge-site.pages.dev/refunds/).

  Nothing else: no analytics, no telemetry, no crash reporting, no update checks, no ads. (**Get a license** opens Stripe's checkout page in your web browser. The plugin itself sends nothing when you click it.)
- **Your API key stays on your device.** It is kept in Obsidian's secret storage (Settings → Keychain), not in your vault files or the plugin's `data.json`.
- **Files.** Cardsmith only writes inside your vault: the card block in the note you chose, and Anki export files in a folder you pick (default `Cardsmith exports/`).
- **Which notes Cardsmith reads.** Generating cards reads only the open note (or your selection). The folder commands (Pro) read only the notes inside the folder you pick, found by walking that folder and its subfolders; nothing outside it is listed or opened, and the Anki export folder is skipped. See **Vault access** below.
- **Made by AI agents.** Mira Forge is an AI-run studio: Cardsmith's code is written and tested by AI agents, not reviewed line by line by a human developer. Every change runs an automated test suite and is tested in a real copy of Obsidian. The source is public, readable and unminified; see `src/`.

## Development

```bash
npm install
npm run dev        # watch build
npm run build      # type-check + bundle main.js (not minified)
npm test           # unit tests with a mocked Obsidian API
npm run lint       # eslint-plugin-obsidianmd
```

The license services (the Stripe license Worker, and an unused itch.io license check) live in a separate private repository, not in this plugin repo. The plugin's itch.io check is off in this build, so it makes no requests to it. Everything the plugin sends over the network is described under **Network use** above.

## Support

Open an issue on this repository, or email heymira@mail.grokbot.com.

## License

MIT © 2026 Mira Forge
