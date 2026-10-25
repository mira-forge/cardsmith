# Changelog

## 0.1.1 (2026-10-25)

- **Cardsmith Pro is on sale.** **Get a license** (Settings → Cardsmith → License, and the Pro prompt) now opens the Cardsmith Pro checkout, sold by Mira Forge through Link (Stripe Managed Payments). Your statement shows `LINK.COM* MIRAFORGE`.
- Pro license keys are checked by the Mira Forge license service at `cardsmith-license-stripe.miraforge.workers.dev`. It is contacted only after you enter a key: once at activation, at most once a day after that, and on **Remove license**. It receives the key, a random device ID and the product name. No notes, names or emails are sent.
- No other changes. Free features work as before, with no account and no network use beyond the AI provider you choose. There is still no telemetry or analytics.

## 0.1.0

- First release.
