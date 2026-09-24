# Changelog

## v2.1.0: Fixes from the pilot (testing release, September 2026)

Tested with the automated tests and live on Amazon; not yet submitted to the
Chrome Web Store. Details, verification and data changes:
[docs/v2.1.0-pilot-fixes.md](docs/v2.1.0-pilot-fixes.md).

- Re-taking the intake survey keeps the original session and assignment
  instead of stopping it; the ignored assignment is logged.
- Product-page views and dwell time are recorded for quick visits and for
  `/gp/aw/d/` product URLs.
- Filter and sort actions are derived from the search URL; sort changes are
  now recorded and list expanders no longer count as filters.
- The sign-in state no longer flips between tabs; `amazon_login_confirmed`
  is sent once per session.
- Sign-in diagnostics (`amazon_login_block_shown`,
  `pre_task_activity_suppressed`) are recorded.
- One cart baseline per session.
- Event schema version 4.

## v2.0.0: Pilot version (September 2026)

Version used in the September 2026 pilot.

- Study flow reworked around a Chrome side panel: task instructions, cart
  review and explicit confirmation of one final product.
- Three study arms: `classic` (assistant hidden), `chat_no_guide` (assistant
  available) and `chat` (assistant available and encouraged).
- Study assignment (arm, product category, budget) read from the intake-survey
  link; recording starts only after Amazon sign-in is confirmed and is capped
  at one hour.
- Events are queued locally and retried until uploaded; each event has a
  unique identifier for de-duplication (schema version 3).
- The follow-up survey address is not stored in the source: production builds
  obtain it from remote configuration, and local preview builds receive it at
  build time.
