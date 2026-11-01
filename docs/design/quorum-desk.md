# Quorum — "Desk" design spec (binding; supersedes the broadsheet spec)

Who it is for (PROJECT_SOUL.md): professional individual investors and small asset managers who need institutional-grade
decision support without a $25k/yr terminal. Quorum never trades; it helps the user make money decisions.
So every screen answers one question first: **"What is moving my portfolio, and how sure are we?"**

References (static mockups, open in a browser):
- `reference/I08-structure.html` — structure and voice: portfolio summary first, then "What's moving your portfolio",
  each news item expressed as impact on holdings, plain-language rationale, provenance, compliance note.
- `reference/I05-palette.html` — colour and density: navy workspace, quiet blue accent, provenance table, preview pane.
Final look = I08's structure on I05's dark navy (option A). A light theme exists for print/reports only.

## Tokens (names `--q-*` are kept; only values change, in `index.css`)
| Role | Dark (default) | Light (print / `@media print` and `[data-theme=light]`) |
|---|---|---|
| bg-base / surface / elevated / hover | `#0B1420` / `#101B2A` / `#152235` / `#1A2A40` | `#FFFFFF` / `#F5F6F8` / `#FFFFFF` / `#EEF1F5` |
| border / border-bright | `#223349` / `#34496A` | `#DDE2E9` / `#B8C2D0` |
| accent (one) / dim | `#5AA9E6` / `rgba(90,169,230,.14)` | `#0F2747` / `rgba(15,39,71,.08)` |
| up / down / pending | `#46B98A` ▲ / `#F58C86` ▼ / `#E0B04F` ◌ | `#1E6B3C` / `#A3302A` / `#8A5A00` |
| text primary / secondary / muted / heading | `#F2F6FA` / `#C9D5E3` / `#93A3B8` / `#FFFFFF` | `#1A2233` / `#4F5868` / `#5E6776` / `#0F2747` |
| font sans / mono | `'Source Sans 3'` / `'Source Code Pro'` (self-hosted via @fontsource) | same |

## Rules
1. No hard-coded colours in `.tsx`; charts read tokens at runtime (`getComputedStyle`).
2. Body 14–15px, tables 13px with 32px rows, tabular numerals, numbers right-aligned. Headings sans 600, no serif, no display fonts.
3. Every scored item shows provenance: source, reliability, "AI simulation" or "live", as-of time. Up/down always with ▲/▼ and sign.
4. Depth by surface tone and 1px borders; no shadows, gradients, glows, left-border accent cards, emoji, uppercase letter-spaced kicker labels.
5. Keep every visible label, role and `data-testid` used by `e2e/`, `e2e-demo/`, `tests/frontend/`. Never loosen a test.
6. Motion: route and panel transitions with the View Transitions API (fallback: none), 160–220 ms, opacity/transform only, honour `prefers-reduced-motion`.

## Screen intents
- **Dashboard**: portfolio summary strip (5 positions, value, unrealised P&L) → "What's moving your portfolio" (scored news joined to holdings,
  impact first, rationale, provenance) → remaining feed. Heading "Live Intelligence Feed" and "Fetch Latest" stay.
- **Portfolio & Risk**: same voice — exposure and risk explained in plain language next to the numbers; chart in token colours.
- **Strategy Boardroom**: agents' views as a structured decision record with a quorum meter (filed / threshold), synthesis box.
- **Compliance**: audit trail and restricted list as a calm, auditable ledger; status always in text.
