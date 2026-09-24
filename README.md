# Webmunk Shopping Study: Chrome Extension Source

Source code of the **Webmunk Shopping Study** Chrome extension, used in a
University of Amsterdam study of how people search for and choose products
on Amazon with and without an AI shopping assistant (Amazon's *Alexa for
Shopping*, previously *Rufus*).

This repository contains the files that are bundled into the package
published on the Chrome Web Store. Each commit corresponds to a tested
release; see [CHANGELOG.md](CHANGELOG.md). Build tooling, deployment
configuration and credentials are not included. Configuration values
(`src/config.js`) are read from environment variables at build time.

## Study flow

1. The participant completes an intake survey (Qualtrics). The survey assigns a
   study condition and a product category with a budget, then links to Amazon.
2. The extension reads the assignment from that link, registers the
   participant, and waits until they are signed into Amazon. Behavioural
   recording starts only after sign-in is confirmed.
3. The participant shops on Amazon. A study panel (Chrome side panel) shows the
   task instructions.
4. The participant opens their cart and confirms one product as their final
   choice in the study panel. Recording stops at that moment.
5. The extension opens the follow-up survey.

Recording is limited to the assigned Amazon site, runs only during the
shopping task, and stops after one hour at most.

## Study conditions

| Arm | Assistant | Instructions |
|---|---|---|
| `classic` | Hidden by the extension | Shop with the site's normal features |
| `chat_no_guide` | Available | No instruction to use it |
| `chat` | Available | Explicitly encouraged to use it |

## Recorded events

Every event carries the participant and session identifiers, the study arm,
the assigned product category and budget, a schema version and a client
timestamp. URLs are reduced to the path plus search-related parameters.

| Event | Recorded when |
|---|---|
| `registration_completed` | The study assignment is accepted |
| `repeat_handoff_ignored` | The intake-survey link is opened again with a different assignment; the first one is kept |
| `amazon_login_block_shown` | The sign-in prompt is shown (before sign-in) |
| `pre_task_activity_suppressed` | Cart activity before sign-in is not counted |
| `amazon_login_confirmed` | Sign-in to Amazon is first confirmed (task start) |
| `nav_committed` | A page on the study site is loaded (prerendered pages are flagged) |
| `tab_dwell` | Time spent on a page while its tab is active and focused |
| `search_submitted` | A search query is run |
| `filter_used` | A search filter or the sort order is changed (derived from the search URL) |
| `product_result_click` | A product in the search results is clicked |
| `product_page_view` | A product detail page is opened |
| `backtrack_navigation` | Back/forward navigation |
| `add_to_cart_click` | A product is added to the cart |
| `decision_made` | The first add-to-cart of the task |
| `cart_baseline_count` | Number of items already in the cart at task start |
| `cart_snapshot` | Cart contents when the cart page is viewed |
| `cart_remove` | An item is removed from the cart |
| `assistant_text` | Content of the assistant conversation (assistant arms only) |
| `assistant_leak_detected` | The assistant was visible despite being hidden (classic arm diagnostic) |
| `final_choice_confirmed` | The participant confirms their final product |
| `session_summary` | Aggregated counts and durations at the end of the task |

## Source layout

| Path | Contents |
|---|---|
| `src/chrome/baseManifest.json` | Extension manifest |
| `src/worker/` | Background service worker: registration, study state, event recording and upload |
| `src/content/` | Content script on Amazon pages: login check, behaviour capture, assistant control |
| `src/popup/` | Study panel shown in the Chrome side panel |
| `src/shared/` | Study policy shared by worker and content script (assignment parsing, URL handling) |
| `src/utils/`, `src/enums.ts`, `src/types.ts` | Utilities, event names and types |
| `src/config.js` | Build-time configuration (environment variables) |

## Documentation

- [CHANGELOG.md](CHANGELOG.md): changes per release.
- [docs/v2.1.0-pilot-fixes.md](docs/v2.1.0-pilot-fixes.md): problems found in the
  September 2026 pilot, how each was fixed and verified, and how the recorded
  data changed.

## Contributing

Please send changes as a fork or branch of this repository. They are
reviewed, tested against a live study build and then included in a
subsequent release. Commits to this repository are made only through the
release process.
