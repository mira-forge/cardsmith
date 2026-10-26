# Changelog

## 0.1.4 (2026-10-26)

- **Polar code removed.** The old Polar payment code and its checkout link are gone. Pro is sold only through Stripe (Link); the plugin contacts only your AI provider and, if you enter a key, the Cardsmith license service.
- **Settings:** the card-count slider no longer uses the deprecated tooltip call; newer Obsidian shows the value next to the slider.
- **README:** links to the privacy policy, terms and refund policy; exactly what the license service stores (hashed key, hashed device IDs with first-seen and last-seen times, subscription status); price line "Cardsmith Pro: $3/month, tax included, cancel anytime."; clearer AI disclosure: Mira Forge is an AI-run studio, and the code is written and tested by AI agents.
- No changes to features, pricing or network use.

## 0.1.3 (2026-10-26)

- **Repository cleanup.** The unused itch.io license-server code was removed from this repository; the license services live in a separate private repository. The plugin itself already used only Obsidian's `requestUrl` for network calls, so nothing changes for you.
- **Author link** now points to https://github.com/mira-forge.
- README: manual install steps (GitHub release files or BRAT), since Cardsmith is listed at community.obsidian.md but not yet in Obsidian's in-app plugin browser.
- No changes to features, Pro, pricing, the license service or network use.

## 0.1.2 (2026-10-26)

- **Settings search.** Cardsmith's settings now appear in Obsidian's settings search (Obsidian 1.13 and later), with extra search words such as "Anki", "Ollama" or "API key". Settings use Obsidian's declarative settings API on 1.13+ and the classic settings page on older versions (minimum is still 1.11.4). Nothing about your saved settings changes.
- **Narrower vault access.** The Pro folder commands (generate for a folder, export a folder to Anki) now list notes by walking only the folder you picked, instead of listing every note in the vault and filtering. Single-note commands read only the open note, as before. See "Vault access" in the README.
- **Release notes.** GitHub releases now include these notes.
- No changes to Pro, pricing, the license service or network use.

## 0.1.1 (2026-10-25)

- **Cardsmith Pro is on sale.** **Get a license** (Settings → Cardsmith → License, and the Pro prompt) now opens the Cardsmith Pro checkout, sold by Mira Forge through Link (Stripe Managed Payments). Your statement shows `LINK.COM* MIRAFORGE`.
- Pro license keys are checked by the Mira Forge license service at `cardsmith-license-stripe.miraforge.workers.dev`. It is contacted only after you enter a key: once at activation, at most once a day after that, and on **Remove license**. It receives the key, a random device ID and the product name. No notes, names or emails are sent.
- No other changes. Free features work as before, with no account and no network use beyond the AI provider you choose. There is still no telemetry or analytics.

## 0.1.0 (2026-10-25)

- First release: generate spaced-repetition flashcards from the current note or a selection with your own AI key (OpenAI, Anthropic, OpenRouter, any OpenAI-compatible endpoint) or a local Ollama model.
- Review, edit or drop each card before it is saved. Cards go into one marked block at the end of the note, in the Spaced Repetition plugin's syntax.
- Offline export of a note's cards to an Anki import file.
- API keys are kept in Obsidian's secret storage. No telemetry or analytics.
