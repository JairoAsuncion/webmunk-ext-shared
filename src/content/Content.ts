import { NotificationService } from './NotificationService';
import { Event } from '../enums';
import { debug } from '../utils/log';
import { isShoppingUrl, isCartUrl, parseAssignment } from '../shared/StudyPolicy';
import { AssistantControl, ASSISTANT_SELECTORS, isVisible } from './AssistantControl';

declare const chrome: any;

// `chat_no_guide` and `chat` both leave the assistant available. Only the panel's
// guidance differs. Unknown assignments never enable assistant capture.
type Arm = 'chat' | 'classic' | 'chat_no_guide';

export class Content {
  private readonly notificationService: NotificationService;
  // The manifest now injects this script into every same-origin Amazon iframe too (all_frames),
  // so a classic-arm assistant panel rendered inside an iframe - rather than the top document -
  // can still be found and hidden (see checkAssistantLeak()'s comment for why this was added).
  // Every OTHER piece of this class (telemetry, the login hard-lock, cart tracking, etc.) stays
  // top-frame-only below - none of that should run once per iframe.
  private readonly isTopFrame: boolean = window === window.top;
  private arm: Arm | null = null;
  private readonly assistantControl = new AssistantControl();
  private contextOrigin: string | null = null;
  private contextExpiresAt = 0;
  private hasStudyContext = false;
  private assistantObserver: MutationObserver | null = null;
  private banner: HTMLElement | null = null;
  private pageCaptured = false;
  private lastAssistantCapture = 0;
  private readonly RUFUS_CAPTURE_THROTTLE_MS = 1500;
  private lastAssistantPayloadHash: string | null = null;
  // Fired at most once per page load (per content-script instance); the worker folds it into
  // session_summary.assistant_available.
  private assistantAvailableSent = false;
  private lastSearchSent = 0;
  private readonly SEARCH_THROTTLE_MS = 2000;
  // Diagnostic signal for the classic arm: an assistant entry point/panel matched our
  // selectors but was still visible right after we tried to hide it - see checkAssistantLeak().
  private lastAssistantLeakTs: number = 0;
  private readonly ASSISTANT_LEAK_THROTTLE_MS = 10000;
  private lastFilterSent = 0;
  private readonly FILTER_THROTTLE_MS = 1200;
  private lastCartSnapshotTs = 0;
  private lastCartSnapshotHash = '';
  private readonly CART_SNAPSHOT_THROTTLE_MS = 3000;

  // Amazon login hard-lock state. `taskStage` / `amazonLoginConfirmed` are cached from
  // chrome.storage.local (kept fresh via storage.onChanged) so the periodic re-check below
  // never has to wait on an async read. `loginBlockActive` gates the one-per-episode
  // AMAZON_LOGIN_BLOCK_SHOWN telemetry so the interval doesn't spam it.
  private taskStage: string | null = null;
  private amazonLoginConfirmed = false;
  private loginBlockActive = false;
  private loginGuardTimer: ReturnType<typeof setInterval> | null = null;
  private readonly LOGIN_GUARD_INTERVAL_MS = 1200;

  private normalizePrice(raw: string): string {
    return raw.replace(/\s+/g, '').replace(/(\.\.)+/g, '.').trim();
  }

  private extractProductInfoFromDocument(): { title?: string; price?: string; brand?: string } {
    const titleEl =
      (document.querySelector('#productTitle') as HTMLElement | null) ||
      (document.querySelector('.product-title-word-break') as HTMLElement | null) ||
      (document.querySelector('h1.a-size-large') as HTMLElement | null);
    const rawTitle = titleEl?.innerText || '';
    const title = rawTitle.replace(/\s+/g, ' ').trim() || undefined;

    const priceContainer =
      (document.querySelector('.reinventPricePriceToPayMargin') as HTMLElement | null) ||
      (document.querySelector('.a-price') as HTMLElement | null);
    let price: string | undefined;
    if (priceContainer) {
      const symbol = (priceContainer.querySelector('.a-price-symbol') as HTMLElement | null)?.innerText?.trim() || '';
      const whole = (priceContainer.querySelector('.a-price-whole') as HTMLElement | null)?.innerText?.trim() || '';
      const fraction =
        (priceContainer.querySelector('.a-price-fraction') as HTMLElement | null)?.innerText?.trim() || '';
      const combined = this.normalizePrice(`${symbol}${whole}${fraction ? '.' + fraction : ''}`);
      const offscreen = this.normalizePrice(
        (priceContainer.querySelector('.a-offscreen') as HTMLElement | null)?.innerText?.trim() || '',
      );
      price = combined || offscreen || undefined;
    } else {
      price =
        (document.querySelector('.a-price .a-offscreen') as HTMLElement | null)?.innerText?.trim() ||
        (document.querySelector('#priceblock_ourprice') as HTMLElement | null)?.innerText?.trim() ||
        (document.querySelector('#price_inside_buybox') as HTMLElement | null)?.innerText?.trim() ||
        undefined;
    }

    const brand =
      (document.querySelector('#bylineInfo') as HTMLElement | null)?.innerText?.trim() ||
      (document.querySelector('.po-brand') as HTMLElement | null)?.innerText?.trim() ||
      undefined;

    return { title, price, brand };
  }

  private extractProductInfoFromCartItem(container: HTMLElement): {
    title?: string;
    price?: string;
    brand?: string;
    asin?: string;
  } {
    const title =
      (container.querySelector('.sc-product-title') as HTMLElement | null)?.innerText?.trim() ||
      (container.querySelector('.sc-product-link') as HTMLElement | null)?.innerText?.trim() ||
      undefined;

    let price: string | undefined;
    const priceContainer = container.querySelector('.a-price') as HTMLElement | null;
    if (priceContainer) {
      const symbol = (priceContainer.querySelector('.a-price-symbol') as HTMLElement | null)?.innerText?.trim() || '';
      const whole = (priceContainer.querySelector('.a-price-whole') as HTMLElement | null)?.innerText?.trim() || '';
      const fraction =
        (priceContainer.querySelector('.a-price-fraction') as HTMLElement | null)?.innerText?.trim() || '';
      const combined = this.normalizePrice(`${symbol}${whole}${fraction ? '.' + fraction : ''}`);
      price = combined || undefined;
    } else {
      price =
        (container.querySelector('.sc-product-price') as HTMLElement | null)?.innerText?.trim() ||
        (container.querySelector('.sc-price') as HTMLElement | null)?.innerText?.trim() ||
        undefined;
    }

    const brand = (container.querySelector('.sc-product-brand') as HTMLElement | null)?.innerText?.trim() || undefined;

    const asin = container.getAttribute('data-asin') || undefined;

    return { title, price, brand, asin };
  }

  constructor() {
    this.notificationService = new NotificationService();
    // Capture the assigned classic arm at document_start; storage changes below
    // reconcile it with the validated worker context.
    const handoff = parseAssignment(location.href);
    if (handoff?.arm === 'classic') this.assistantControl.setEnabled(true);
    this.initStudyState();
    if (this.isTopFrame) this.addContentLoadedListener();
  }

  public initialize(): void {
    if (!this.isTopFrame) return;
    this.addClickListener();
    this.addFilterListener();
    this.addSortListener();
    this.addResultClickListener();
    this.addCartRemoveListener();
    this.addBfcacheRestoreListener();
    chrome.runtime.onMessage.addListener((message:any, _sender:any, reply:any) => {
      if (message?.type !== 'study_read_cart') return;
      reply(this.readCart());
    });
    if (document.readyState !== 'loading') this.onReady();
    else document.addEventListener('DOMContentLoaded', () => this.onReady(), {once:true});
    if (isShoppingUrl(location.href)) {
      chrome.runtime.sendMessage({type:'study_context'}, () => { void chrome.runtime.lastError; });
    }
  }

  private initStudyState(): void {
    const refresh = () => chrome.storage.local.get(
      ['taskStage','amazonLoginConfirmed','studyContext','studyError'], (s:any) => {
        this.taskStage = s.taskStage || 'initial';
        this.amazonLoginConfirmed = s.amazonLoginConfirmed === true;
        this.hasStudyContext = !!s.studyContext;
        this.contextOrigin = s.studyContext?.origin || null;
        this.contextExpiresAt = Number(s.studyContext?.expiresAt) || 0;
        this.arm = s.studyContext?.arm || null;
        const assignedPage = this.contextOrigin === location.origin;
        const pendingClassic = !s.studyContext && parseAssignment(location.href)?.arm === 'classic';
        this.assistantControl.setEnabled(pendingClassic || (assignedPage &&
          (this.taskStage === 'shopping' || this.taskStage === 'registering') && this.arm === 'classic'));
        if (this.isTopFrame) {
          this.reassertLoginGate();
          this.updateStudyBanner(s.studyError || '');
          if (this.trackingActive()) {
            this.capturePageOnce();
            this.captureCartBaselineIfNeeded();
            this.captureAssistantText();
            this.checkAssistantAvailability();
          }
        }
      });
    refresh();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh, {once:true});
    chrome.storage.onChanged.addListener((changes:any, area:string) => {
      if (area === 'local' && ['taskStage','amazonLoginConfirmed','studyContext','studyError'].some(k => k in changes)) refresh();
    });
    if (this.isTopFrame) {
      this.loginGuardTimer = setInterval(() => {
        if (this.taskStage === 'shopping' && this.contextExpiresAt <= Date.now()) {
          chrome.runtime.sendMessage({type:'study_expired'}, () => { void chrome.runtime.lastError; });
        }
        this.reassertLoginGate();
        if (this.trackingActive()) {
          this.captureCartBaselineIfNeeded();
          this.captureCartSnapshot();
          this.captureAssistantText();
          this.checkAssistantAvailability();
        }
      }, this.LOGIN_GUARD_INTERVAL_MS);
    }
  }
  private trackingActive(): boolean {
    return this.taskStage === 'shopping' && this.amazonLoginConfirmed && this.contextExpiresAt > Date.now() &&
      this.contextOrigin === location.origin && !!this.arm && isShoppingUrl(location.href);
  }
  private onReady(): void {
    this.updateStudyBanner('');
    if (!this.assistantObserver) {
      this.assistantObserver = new MutationObserver(() => {
        if (!this.trackingActive()) return;
        this.captureAssistantText();
        this.checkAssistantAvailability();
      });
      this.assistantObserver.observe(document.documentElement, {childList:true,subtree:true,characterData:true});
    }
    this.capturePageOnce();
  }
  private updateStudyBanner(error: string): void {
    if (!document.body || !isShoppingUrl(location.href)) return;
    const show = this.hasStudyContext || !!parseAssignment(location.href) || !!error;
    if (!show || ['final','stopped','done'].includes(this.taskStage || '')) {
      this.banner?.remove(); this.banner = null; return;
    }
    if (!this.banner?.isConnected) {
      const box = document.createElement('aside');
      box.id = 'webmunk-study-banner';
      box.setAttribute('aria-label','Webmunk shopping study');
      // Normal document flow: never cover an assistant composer or Amazon control.
      box.style.cssText = 'position:relative;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:.75rem;padding:.5rem 1rem;background:#fff;color:#222;border-bottom:2px solid #a41b33;';
      const label = document.createElement('p');
      label.style.cssText = 'margin:0;font:14px/1.4 system-ui,sans-serif;';
      label.textContent = 'Shopping study: instructions and final product confirmation';
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Open study panel';
      button.style.cssText = 'font:inherit;padding:.6em 1em;cursor:pointer;';
      button.addEventListener('click', () => {
        chrome.runtime.sendMessage({type:'study_open_panel'}, (result:any) => {
          if (chrome.runtime.lastError || !result?.ok) label.textContent = 'Click the Webmunk icon in Chrome’s toolbar to open the study panel.';
          else label.textContent = 'You can close the study panel while shopping and reopen it here or from the Webmunk toolbar icon.';
        });
      });
      box.append(label,button); document.body.prepend(box); this.banner = box;
    }
  }
  private capturePageOnce(): void {
    if (this.pageCaptured || document.readyState === 'loading' || !this.trackingActive()) return;
    this.pageCaptured = true;
    this.captureNavigationType(location.href);
    if (this.isProductDetailPage(location.href)) this.sendTelemetry(Event.PRODUCT_PAGE_VIEW, {asin:this.getAsinFromUrl(location.href)});
    this.captureCartSnapshot();
  }

  // `#nav-link-accountList` is the wrapping `<div class="nav-div">`, not the link itself -
  // the actual `<a href=...>` is a child of it. Reading `.getAttribute('href')` off the div
  // (as this used to) always returns null, which silently broke every href-based signal below.
  private getAccountLink(): HTMLAnchorElement | null {
    return document.querySelector('a#nav-link-accountList, #nav-link-accountList a') as HTMLAnchorElement | null;
  }

  // Three states, not two. The old code returned `false` (= "locked, sign in") whenever the
  // account-nav link wasn't found - which locks a genuinely-signed-in participant whenever the
  // top nav hasn't rendered yet, or the page isn't a normal Amazon page (bot / cookie / region
  // interstitial), or their account is on a different Amazon marketplace than the tab. Only a
  // *definitive* signed-out signal (nav link present AND pointing at the sign-in flow, or the
  // English greeting reading "sign in") should lock the page; anything else is `unknown` and
  // the gate keeps re-checking instead of trapping them.
  private getAmazonLoginState(): 'in' | 'out' | 'unknown' {
    const link = this.getAccountLink();
    const href = link?.getAttribute('href') || '';

    if (href.includes('/ap/signin') || href.includes('/gp/sign-in')) return 'out';

    const greeting = (
      document.getElementById('nav-link-accountList-nav-line-1')?.textContent ||
      link?.textContent ||
      ''
    ).toLowerCase();
    // English-only: trusted only as a positive "out", never to override an "in".
    if (/sign in|identify yourself/.test(greeting)) return 'out';

    if (link && href) return 'in';

    return 'unknown';
  }

  private checkAmazonLoginStatus(): void {
    if (this.taskStage !== 'shopping' || this.contextOrigin !== location.origin || !isShoppingUrl(location.href)) return;
    const state = this.getAmazonLoginState();
    debug('[wm] checkAmazonLoginStatus', {
      state,
      href: this.getAccountLink()?.getAttribute('href') || null,
      url: window.location.href,
    });
    // Don't flip the worker's login state on a non-signal - only report a definitive in/out.
    if (state === 'unknown') return;
    try {
      chrome.runtime.sendMessage({ type: 'amazon_login_status', loggedIn: state === 'in' });
    } catch (err) {
      // Extension reloaded (dev testing) while this tab's content script is still the old
      // instance - its messaging channel is dead until the tab itself reloads. Swallow
      // rather than let it throw out of the 1.2s interval tick that calls this.
      console.warn('[wm] failed to report amazon login status', err);
    }
  }

  // A sign-in URL that actually renders Amazon's sign-in form. Prefer the signed-out nav
  // link's own href - that's the exact URL Amazon generated for this page (full OpenID param
  // set, correct marketplace). Only fall back to a hand-built one, and it must carry the full
  // OpenID `checkid_setup` set: a bare `/ap/signin` (with or without just `return_to`) is not
  // a real page and shows Amazon's "Looking for Something?" error.
  private buildSignInUrl(): string {
    const navHref = this.getAccountLink()?.getAttribute('href') || '';
    if (navHref.includes('/ap/signin') || navHref.includes('/gp/sign-in')) {
      try {
        const candidate = new URL(navHref, window.location.href);
        if (candidate.origin === location.origin && candidate.protocol === 'https:') return candidate.href;
      } catch {
        /* fall through */
      }
    }

    const origin = window.location.origin; // US study -> https://www.amazon.com
    const idSelect = 'http://specs.openid.net/auth/2.0/identifier_select';
    const params = new URLSearchParams({
      'openid.pape.max_auth_age': '0',
      'openid.return_to': `${origin}/`,
      'openid.identity': idSelect,
      'openid.assoc_handle': 'usflex',
      'openid.mode': 'checkid_setup',
      'openid.claimed_id': idSelect,
      'openid.ns': 'http://specs.openid.net/auth/2.0',
    });
    return `${origin}/ap/signin?${params.toString()}`;
  }

  // The Amazon sign-in / account-recovery / MFA pages themselves must never be blocked -
  // otherwise the participant can't sign in and is trapped behind the overlay.
  private isAmazonAuthPage(): boolean {
    const p = window.location.pathname;
    return (
      p.startsWith('/ap/') ||
      p.startsWith('/gp/sign-in') ||
      p.startsWith('/gp/css/homepage.html/sign-out') ||
      p.includes('/signin') ||
      p.includes('/register')
    );
  }



  private dismissLoginBlockIfActive(): void {
    if (!this.loginBlockActive) return;
    this.loginBlockActive = false;
    this.notificationService.clearLoginBlock();
  }

  // Single source of truth for the hard lock. Alexa for Shopping (chat arm) can't be used
  // signed out, and any data collected before sign-in is unrepresentative of the task, so the
  // page must be fully blocked - not just nudged - until the participant is signed in.
  // handleCartReached()'s server-side gate stays as a backstop.
  private reassertLoginGate(): void {
    // Never block the auth pages themselves, and never block outside the shopping stage.
    if (!isShoppingUrl(location.href) || this.contextOrigin !== location.origin || this.taskStage !== 'shopping') {
      this.dismissLoginBlockIfActive();
      return;
    }

    const state = this.getAmazonLoginState();
    // Lock ONLY on a definitive signed-out signal. `unknown` (nav not rendered, non-standard
    // page, other marketplace) must not lock - the gate re-runs on the interval, and
    // handleCartReached()'s server-side gate is the backstop for the critical checkpoint.
    const lock = state === 'out';
    if (state === 'out' && this.amazonLoginConfirmed) this.checkAmazonLoginStatus();

    if (lock) {
      this.notificationService.showLoginBlock(this.buildSignInUrl());

      if (!this.loginBlockActive) {
        this.loginBlockActive = true;
        // One row per block episode (not per interval tick), so how often and how long this
        // control is actually needed stays queryable against amazon_login_confirmed's stamp.
        this.sendTelemetry(Event.AMAZON_LOGIN_BLOCK_SHOWN, { url: window.location.href });
      }
      return;
    }

    // Not definitively signed out - unlock.
    this.dismissLoginBlockIfActive();

    // Tell the worker whenever we can positively confirm sign-in and it doesn't know yet -
    // not just on the "was locked, now unlocked" transition. The page may never have been
    // locked at all (e.g. at DOMContentLoaded the nav's "Hello, Name" greeting hadn't
    // rendered yet, so the very first check read `unknown` - not `out` - and nothing was
    // ever sent), in which case this periodic check is the only thing that ever reports
    // sign-in. Cheap and self-limiting: `this.amazonLoginConfirmed` flips true (via
    // storage.onChanged) within one round trip of the worker persisting it, so this stops
    // re-sending on the next tick.
    if (state === 'in' && !this.amazonLoginConfirmed) {
      this.checkAmazonLoginStatus();
    }
  }

  // Kept as the DOMContentLoaded / pageshow entry point; routes through the shared gate.
  private enforceLoginRequirement(): void {
    chrome.storage.local.get(['taskStage', 'amazonLoginConfirmed'], (r: any) => {
      this.taskStage = (r && r.taskStage) || null;
      this.amazonLoginConfirmed = Boolean(r && r.amazonLoginConfirmed);
      this.reassertLoginGate();
    });
  }

  private addContentLoadedListener(): void {
    document.addEventListener('DOMContentLoaded', () => {
      this.checkAmazonLoginStatus();
      this.reassertLoginGate();
      this.capturePageOnce();
    });
  }

  private addClickListener(): void {
    window.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const addToCartButton = target.closest(
        '#add-to-cart-button, button#add-to-cart-button, input#add-to-cart-button',
      ) as HTMLElement | null;

      if (addToCartButton) {
        const url = window.location.href;
        const asin = this.getAsinFromUrl(url);
        const productInfo = this.extractProductInfoFromDocument();
        this.sendTelemetry(Event.ADD_TO_CART_CLICK, { url, asin, ...productInfo });
        this.trackDecisionIfNeeded(url, asin, productInfo);
      }
    });
  }

  private captureNavigationType(url: string): void {
    try {
      const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (!navEntry) return;

      if (navEntry.type === 'back_forward') {
        this.sendTelemetry(Event.BACKTRACK_NAVIGATION, {
          url,
          navigation_type: navEntry.type,
        });
        return;
      }

      // only treat this as a new search on a genuine forward navigation - a back/forward
      // return to a previous search-results page is already covered above and shouldn't
      // also count as a fresh search.
      this.captureSearchFromUrl(url);
    } catch (err) {
      console.warn('failed to read navigation timing', err);
    }
  }

  // Detecting a search from the resulting URL instead of the triggering interaction: two
  // rounds of listening for the search form's submit/click/Enter never fired a single time
  // across many live tests with confirmed real search attempts, most likely because Amazon's
  // search-suggestions dropdown (visible in the input's aria-controls/aria-expanded
  // attributes) intercepts Enter to pick a suggestion instead of letting the form submit
  // natively. Every path to a search - typed query, autocomplete suggestion click, even the
  // "Ask Alexa" related-question pills - lands on a /s path with the query in either the
  // 'k' or 'field-keywords' parameter (see captureSearchFromUrl) regardless of which
  // interaction triggered it, the same URL-based approach that already makes
  // product_page_view reliable.
  private isSearchResultsUrl(url: string): URL | null {
    try {
      const parsed = new URL(url);
      return parsed.pathname === '/s' || parsed.pathname.startsWith('/s/') ? parsed : null;
    } catch {
      return null;
    }
  }

  private captureSearchFromUrl(url: string): void {
    const parsed = this.isSearchResultsUrl(url);
    if (!parsed) return;

    // The search bar's own <form> submits the query under 'field-keywords' (per its
    // <input name="field-keywords">), not 'k' - 'k' is what Amazon's own JS uses when
    // building links elsewhere (e.g. the "Ask Alexa" pills), a different code path. Whichever
    // one shows up in the landed URL, read it - backtrack_count firing correctly in the same
    // sessions where this stayed silent confirms the surrounding pipeline works, so this was
    // the wrong parameter name, not a broken navigation/DOMContentLoaded path.
    const query = (parsed.searchParams.get('k') || parsed.searchParams.get('field-keywords') || '').trim();
    if (!query) return;

    const now = Date.now();
    if (now - this.lastSearchSent < this.SEARCH_THROTTLE_MS) return;
    this.lastSearchSent = now;

    this.sendTelemetry(Event.SEARCH_SUBMITTED, {
      url,
      query,
    });
  }

  // Chrome usually serves a browser back/forward navigation from the back/forward cache
  // (bfcache) rather than a real page load - the page resumes from a frozen snapshot
  // instead of firing DOMContentLoaded again, so captureNavigationType() (which only runs
  // from the DOMContentLoaded handler) never sees it and backtrack_navigation undercounts.
  // 'pageshow' fires on both a normal load AND a bfcache resume; event.persisted is true
  // only for the latter, which is otherwise indistinguishable from any other page view.
  private addBfcacheRestoreListener(): void {
    window.addEventListener('pageshow', (event: PageTransitionEvent) => {
      if (!event.persisted) return;

      const url = window.location.href;

      this.checkAmazonLoginStatus();
      this.enforceLoginRequirement();
      this.checkAssistantAvailability();

      this.sendTelemetry(Event.BACKTRACK_NAVIGATION, {
        url,
        navigation_type: 'bfcache_restore',
      });

      // a bfcache-restored product page is a real revisit (e.g. comparing back and forth
      // between products) and would otherwise never be counted, same gap as backtrack above.
      if (this.isProductDetailPage(url)) {
        const asin = this.getAsinFromUrl(url);
        this.sendTelemetry(Event.PRODUCT_PAGE_VIEW, { url, asin });
      }
    });
  }

  private addFilterListener(): void {
    document.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const now = Date.now();
      if (now - this.lastFilterSent < this.FILTER_THROTTLE_MS) return;

      const filterElement = target.closest(
        '#s-refinements a, #s-refinements input[type="checkbox"], #s-refinements li, #s-refinements span',
      ) as HTMLElement | null;

      if (!filterElement) return;

      const rawText =
        filterElement.innerText ||
        filterElement.getAttribute('aria-label') ||
        filterElement.getAttribute('data-a-size') ||
        '';
      const filterText = rawText.replace(/\s+/g, ' ').trim();
      if (!filterText) return;

      this.lastFilterSent = now;
      this.sendTelemetry(Event.FILTER_USED, {
        url: window.location.href,
        filter_type: 'refinement',
        filter_text: filterText,
      });
    });
  }

  private addSortListener(): void {
    document.addEventListener('change', (event) => {
      const select = event.target as HTMLSelectElement;
      if (!select.matches?.('select#s-result-sort-select')) return;
      this.sendTelemetry(Event.FILTER_USED, {filter_type:'sort',
        filter_text:select.options[select.selectedIndex]?.text?.trim(), filter_value:select.value});
    });
  }

  private addResultClickListener(): void {
    document.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const link = target.closest('a[href*="/dp/"]') as HTMLAnchorElement | null;
      if (!link) return;

      const container = link.closest('[data-component-type="s-search-result"]') as HTMLElement | null;
      if (!container) return;

      const href = link.getAttribute('href') || '';
      const absoluteUrl = href.startsWith('http') ? href : `${window.location.origin}${href}`;
      const asin = this.getAsinFromUrl(absoluteUrl);
      const title =
        (container.querySelector('h2 span') as HTMLElement | null)?.innerText?.trim() ||
        (link.innerText || '').trim() ||
        undefined;

      this.sendTelemetry(Event.PRODUCT_RESULT_CLICK, {
        url: window.location.href,
        target_url: absoluteUrl,
        asin,
        title,
      });
    });
  }

  private trackDecisionIfNeeded(
    url: string,
    asin: string | null,
    productInfo: { title?: string; price?: string; brand?: string },
  ): void {
    chrome.storage.local.get(
      ['decisionTracked', 'shoppingTaskStartedAt', 'amazonLoginConfirmed', 'taskStage'],
      (result: {
        decisionTracked?: boolean;
        shoppingTaskStartedAt?: number;
        amazonLoginConfirmed?: boolean;
        taskStage?: string;
      }) => {
      const alreadyTracked = Boolean(result.decisionTracked);
      if (alreadyTracked) {
        return;
      }

      // Amazon allows adding to a guest cart before signing in - if that happened to trigger
      // here first, it would consume the one decisionTracked slot with a meaningless latency
      // and permanently mask the participant's real, post-login decision. Wait for login.
      //
      // Also require the shopping task to have actually started (taskStage past its 'initial'
      // default - i.e. registration genuinely completed). amazonLoginConfirmed can flip true
      // from ordinary Amazon browsing before registration finishes (e.g. Qualtrics failed to
      // hand off the Prolific ID and the participant is stuck on the popup's manual-entry
      // fallback) - without this check, a decision made in that window would send an event
      // EventService silently drops (no registered user yet) while still burning this one-shot
      // flag, permanently losing the participant's real decision data once they do register.
      const taskStarted = result.taskStage === 'shopping' && this.trackingActive();
      if (!taskStarted || !result.amazonLoginConfirmed) {
        // Evidence this exact guard fired - proof the earlier data-loss bug (this flag getting
        // silently burned on an event EventService would have dropped anyway) can't recur,
        // since a decision attempt in this state is now visible instead of just vanishing.
        this.sendTelemetry(Event.PRE_TASK_ACTIVITY_SUPPRESSED, {
          suppressed_event: Event.DECISION_MADE,
          reason: !taskStarted ? 'not_registered' : 'not_logged_in',
          url,
          asin,
        });
        return;
      }

      const startedAt = Number(result.shoppingTaskStartedAt || 0);
      const now = Date.now();
      const latencyMs = startedAt > 0 ? Math.max(0, now - startedAt) : null;

      this.sendTelemetry(Event.DECISION_MADE, {
        url,
        asin,
        decision_latency_ms: latencyMs,
        decision_definition: 'first_add_to_cart_click_not_final_choice',
        ...productInfo,
      });

      chrome.storage.local.set({
        decisionTracked: true,
        decisionMadeAt: now,
      });
      },
    );
  }

  private addCartRemoveListener(): void {
    document.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const deleteButton = target.closest(
        "input[name^='submit.delete'], button[data-action='a-stepper-decrement']",
      ) as HTMLElement | null;
      if (!deleteButton) return;

      const container = deleteButton.closest('#sc-active-cart .sc-list-item') as HTMLElement | null;
      if (!container) return;

      const info = this.extractProductInfoFromCartItem(container);
      setTimeout(() => {
        const { text: subtotal, amount: subtotal_amount } = this.extractCartSubtotalDetails();
        this.sendTelemetry(Event.CART_REMOVE, {
          url: window.location.href,
          ...info,
          subtotal,
          subtotal_amount,
        });
      }, 300);
    });
  }

  private extractCartSubtotal(): string | null {
    const el =
      (document.querySelector('#sc-subtotal-amount-activecart') as HTMLElement | null) ||
      (document.querySelector('.sc-subtotal-activecart') as HTMLElement | null) ||
      (document.querySelector("[data-name='Subtotals'] .a-size-medium") as HTMLElement | null);
    const txt = el?.innerText?.trim() || '';
    return txt || null;
  }

  private extractCartSubtotalDetails(): { text: string | null; amount: number | null } {
    const text = this.extractCartSubtotal();
    if (!text) {
      return { text: null, amount: null };
    }
    // Do not parse the count in "Subtotal (2 items)" as a monetary amount.
    // Keep non-US formats as display text instead of guessing a decimal locale.
    const match = text.match(/^\s*\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)\s*$/);
    return { text, amount: match ? Number(match[1].replace(/,/g, '')) : null };
  }

  // Reward-integrity baseline: how many items were already in the cart before this
  // shopping task started, so analysis can separate pre-existing items from ones
  // added/removed during the experiment. Read from the header cart-count badge
  // (present on every Amazon page) rather than the /cart page, since the participant
  // may not visit /cart until after they've already started adding items.
  private extractCartItemCountBadge(): number | null {
    const el =
      (document.querySelector('#nav-cart-count') as HTMLElement | null) ||
      (document.querySelector('#nav-cart-count-container') as HTMLElement | null) ||
      (document.querySelector('[data-csa-c-content-id="nav-cart-count"]') as HTMLElement | null);
    const raw = el?.innerText?.trim() || el?.getAttribute('aria-label') || '';
    const match = raw.match(/\d+/);
    if (!match) return null;
    const count = parseInt(match[0], 10);
    return Number.isFinite(count) ? count : null;
  }

  private captureCartBaselineIfNeeded(): void {
    chrome.storage.local.get(
      ['cartBaselineCaptured', 'amazonLoginConfirmed', 'taskStage', 'cartBaselineSuppressionLogged'],
      (result: {
        cartBaselineCaptured?: boolean;
        amazonLoginConfirmed?: boolean;
        taskStage?: string;
        cartBaselineSuppressionLogged?: boolean;
      }) => {
      if (result.cartBaselineCaptured) {
        return;
      }

      // Capturing before login would read the logged-out guest cart (effectively always
      // empty), not the participant's real cart - wait for confirmed login. Also require the
      // shopping task to have actually started (see trackDecisionIfNeeded's matching comment) -
      // otherwise a premature amazonLoginConfirmed flip before registration completes would
      // burn this one-shot flag on an event EventService silently drops, permanently losing the
      // real baseline once the participant does register.
      const taskStarted = result.taskStage === 'shopping' && this.trackingActive();
      if (!taskStarted || !result.amazonLoginConfirmed) {
        // This branch re-runs on every page load until the gate clears - log the evidence once
        // per suppressed episode (not once per page load) so it stays meaningful rather than
        // just counting how many pages were viewed while blocked.
        if (!result.cartBaselineSuppressionLogged) {
          this.sendTelemetry(Event.PRE_TASK_ACTIVITY_SUPPRESSED, {
            suppressed_event: Event.CART_BASELINE_COUNT,
            reason: !taskStarted ? 'not_registered' : 'not_logged_in',
          });
          chrome.storage.local.set({ cartBaselineSuppressionLogged: true });
        }
        return;
      }

      const count = this.extractCartItemCountBadge();
      if (count === null) {
        // badge not present/parseable on this page load - retry on the next page load;
        // the flag only gets set once a real reading succeeds.
        return;
      }

      this.sendTelemetry(Event.CART_BASELINE_COUNT, {
        url: window.location.href,
        count,
      });

      chrome.storage.local.set({ cartBaselineCaptured: true });
    });
  }

  // A live, item-level snapshot is required for confirmation. No fallback from
  // a count alone: an unreadable cart must not silently pick the wrong product.
  private readCart(): any {
    if (!this.trackingActive() || !isCartUrl(location.href)) return {ok:false,items:[]};
    const root = document.querySelector('#sc-active-cart');
    if (!root) return {ok:false,items:[]};
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.sc-list-item[data-asin], [data-itemtype="active"][data-asin]'));
    const items = rows.filter(row => isVisible(row) && row.getAttribute('data-removed') !== 'true')
      .filter(row => !Array.from(row.querySelectorAll('.sc-list-item-removed-msg')).some(el => isVisible(el)))
      .map(row => this.extractProductInfoFromCartItem(row))
      .filter(item => item.asin && /^[A-Z0-9]{10}$/i.test(item.asin) && item.title);
    const {text:subtotal,amount:subtotal_amount} = this.extractCartSubtotalDetails();
    return {ok:true,loggedIn:this.getAmazonLoginState() === 'in',items,item_count:items.length,subtotal,subtotal_amount};
  }
  private captureCartSnapshot(): void {
    if (!this.trackingActive() || Date.now() - this.lastCartSnapshotTs < this.CART_SNAPSHOT_THROTTLE_MS) return;
    const cart = this.readCart();
    if (!cart.ok) return;
    this.lastCartSnapshotTs = Date.now();
    const hash = JSON.stringify(cart);
    if (hash === this.lastCartSnapshotHash) return;
    this.lastCartSnapshotHash = hash;
    this.sendTelemetry(Event.CART_SNAPSHOT, cart);
  }
  private hideAssistantIfNeeded(): void {
    this.assistantControl.setEnabled(this.contextOrigin === location.origin &&
      this.taskStage === 'shopping' && this.arm === 'classic');
  }
  private checkAssistantAvailability(): void {
    if (!this.trackingActive()) return;
    const matches = Array.from(document.querySelectorAll<HTMLElement>(ASSISTANT_SELECTORS.join(','))).filter(isVisible);
    if (this.arm === 'classic') {
      if (matches.length && Date.now() - this.lastAssistantLeakTs > this.ASSISTANT_LEAK_THROTTLE_MS) {
        this.lastAssistantLeakTs = Date.now();
        this.sendTelemetry(Event.ASSISTANT_LEAK_DETECTED, {count:matches.length});
      }
    } else if (matches.length && !this.assistantAvailableSent) {
      this.assistantAvailableSent = true;
      this.sendTelemetry(Event.ASSISTANT_AVAILABLE);
    }
  }

  private captureAssistantText(): void {
    if (!this.trackingActive() || (this.arm !== 'chat' && this.arm !== 'chat_no_guide')) {
      return;
    }

    const normalizeText = (val: string): string => val.replace(/\s+/g, ' ').trim();

    const now = Date.now();
    if (now - this.lastAssistantCapture < this.RUFUS_CAPTURE_THROTTLE_MS) {
      return;
    }

    // Each AI turn (customer question + assistant reply) is wrapped in one of these container
    // elements. The old `.rufus-sections-container` class only wraps the customer's own text
    // bubble, not the assistant's markdown/product response, so scoping to it here misses all
    // product suggestions entirely.
    const matches = document.querySelectorAll<HTMLElement>(
      '.rufus-papyrus-turn, .rufus-papyrus-active-turn, .alexa-papyrus-turn, .alexa-papyrus-active-turn, .rufus-sections-container, .alexa-sections-container',
    );
    if (!matches.length) {
      return;
    }

    const userTexts: string[] = [];
    const productSuggestions: Array<{ title: string; price?: string; asin?: string; brand?: string }> = [];
    const turns: Array<{
      sequence_id?: string | null;
      blocks: Array<{
        kind: 'markdown' | 'header' | 'product' | 'footnote' | 'cta';
        text?: string;
        product?: { title: string; price?: string; asin?: string; brand?: string; rating?: string; review_count?: string; url?: string; badge?: string; footnote?: string };
        action?: { text?: string; url?: string | null; action_type?: string | null };
      }>;
    }> = [];

    // Capture submitted chat bubbles only, never arbitrary inputs or draft text.

    // explicit chat bubbles for user
    const userBubbles = document.querySelectorAll<HTMLElement>(
      '.rufus-customer-text-wrap, .alexa-customer-text-wrap, .rufus-speech-bubble, .alexa-speech-bubble',
    );
    userBubbles.forEach((b) => {
      const t = (b.innerText || '').trim();
      if (t && t !== '[thinking]') {
        userTexts.push(t);
      }
    });

    matches.forEach((section) => {
      const sequenceId =
        section.id ||
        section.getAttribute('data-rufus-sequenceid') ||
        section.getAttribute('data-alexa-sequenceid') ||
        section.getAttribute('data-csa-c-sequence-id');

      type CandidateKind = 'markdown' | 'header' | 'product' | 'footnote' | 'cta';
      const candidates: Array<{ el: Element; kind: CandidateKind; payload: any }> = [];

      // markdown blocks
      section
        .querySelectorAll<HTMLElement>(
          'p.rufus-markdown-paragraph, p.alexa-markdown-paragraph, [data-csa-c-content-id*="-markdownSection-"]',
        )
        .forEach((el) => {
          const text = normalizeText(el.innerText || '');
          if (text) {
            candidates.push({ el, kind: 'markdown', payload: { text } });
          }
        });

      // headers above product lists
      section
        .querySelectorAll<HTMLElement>(
          '.rufus-asin-faceout-header .rufus-color-onyx, .alexa-asin-faceout-header .alexa-color-onyx, [data-csa-c-content-id*="-categoryHeader-"]',
        )
        .forEach((el) => {
        const text = normalizeText(el.innerText || '');
        if (text) {
          candidates.push({ el, kind: 'header', payload: { text } });
        }
        });

      // product cards (faceouts)
      const productEls = new Set<HTMLElement>();
      section.querySelectorAll<HTMLElement>('.rufus-asin-faceout-wrapper, .alexa-asin-faceout-wrapper').forEach((el) => productEls.add(el));
      section
        .querySelectorAll<HTMLElement>('[data-section-class*="AsinFaceout"] [data-csa-c-asin], [data-section-class*="AsinFaceout"] [data-asin]')
        .forEach((el) => productEls.add(el));
      // Current renderer: cards are role="button" divs identified by data-csa-c-content-id
      // (e.g. "rufus-dsk-section-asinCard-<uuid>"); no semantic classes on the card itself.
      section.querySelectorAll<HTMLElement>('[data-csa-c-content-id*="-asinCard-"]').forEach((el) => productEls.add(el));

      productEls.forEach((card) => {
        const titleEl =
          (card.querySelector('h2.a-size-base.a-spacing-none.a-color-base.a-text-normal > span') as HTMLElement | null) ||
          (card.querySelector('[style*="line-clamp"]') as HTMLElement | null) ||
          (card.querySelector('.a-color-base') as HTMLElement | null);
        // The card image's alt text carries the full (untruncated) product title in the
        // current renderer, where the visible title div is line-clamped.
        const imgAlt = normalizeText((card.querySelector('img[alt]') as HTMLImageElement | null)?.alt || '');
        const rawTitle = imgAlt || titleEl?.innerText || '';
        const title = normalizeText(rawTitle);
        if (!title || title.length < 2) return;

        const href = (
          titleEl?.closest('a')?.getAttribute('href') ||
          card.closest('a')?.getAttribute('href') ||
          card.querySelector('a[href]')?.getAttribute('href') ||
          card.getAttribute('href') ||
          ''
        ).trim();
        // Live query 2026-07-06: 390/390 assistant-suggested products came back with a
        // missing ASIN despite title/price extracting correctly every time (not a payload
        // truncation issue - a specific, total extraction gap). This only checked the '/dp/'
        // URL pattern; getAsinFromUrl() already handles '/gp/product/' too (confirmed that
        // pattern is what Amazon actually uses on the cart page), but was never reused here.
        const asinMatch =
          card.getAttribute('data-csa-c-asin') ||
          card.getAttribute('data-asin') ||
          this.getAsinFromUrl(href) ||
          undefined;

        let price: string | undefined;
        const priceContainer = card.querySelector('.a-price') as HTMLElement | null;
        if (priceContainer) {
          const symbol = (priceContainer.querySelector('.a-price-symbol') as HTMLElement | null)?.textContent?.trim() || '';
          const whole = (priceContainer.querySelector('.a-price-whole') as HTMLElement | null)?.textContent?.trim() || '';
          const fraction =
            (priceContainer.querySelector('.a-price-fraction') as HTMLElement | null)?.textContent?.trim() || '';
          const combined = this.normalizePrice(`${symbol}${whole}${fraction ? '.' + fraction : ''}`);
          const offscreen = (priceContainer.querySelector('.a-offscreen') as HTMLElement | null)?.textContent?.trim() || '';
          price = combined || this.normalizePrice(offscreen) || undefined;
        } else {
          // Current renderer splits price into sibling leaf divs: "$", whole, fraction, with
          // no distinguishing class. Anchor on the literal "$" text node to reconstruct it.
          const dollarEl = Array.from(card.querySelectorAll<HTMLElement>('div')).find(
            (el) => el.children.length === 0 && el.textContent?.trim() === '$',
          );
          const priceParts = dollarEl?.parentElement ? (Array.from(dollarEl.parentElement.children) as HTMLElement[]) : [];
          const whole = normalizeText(priceParts[1]?.textContent || '');
          const fraction = normalizeText(priceParts[2]?.textContent || '');
          if (whole) {
            price = this.normalizePrice(`$${whole}${fraction ? '.' + fraction : ''}`) || undefined;
          }
        }

        const ratingLabel = (card.querySelector('[aria-label*="out of 5 stars"]') as HTMLElement | null)?.getAttribute('aria-label') || '';
        const ratingLabelMatch = ratingLabel.match(/([\d.]+)\s+out of 5 stars\.?\s*([\d,]+)?\s*ratings?\.?/i);
        const rating =
          ratingLabelMatch?.[1] || normalizeText((card.querySelector('.a-icon-alt') as HTMLElement | null)?.innerText || '') || undefined;
        const reviewCount =
          ratingLabelMatch?.[2] ||
          normalizeText((card.querySelector('.a-size-small .a-size-base') as HTMLElement | null)?.innerText || '') ||
          undefined;
        const badge = normalizeText((card.querySelector('.a-badge-text') as HTMLElement | null)?.innerText || '') || undefined;
        const footnote =
          normalizeText(
            (card.querySelector('.rufus-asin-faceout-footer .a-color-base, .alexa-asin-faceout-footer .a-color-base') as HTMLElement | null)?.innerText || '',
          ) || undefined;

        const url =
          (titleEl?.closest('a')?.getAttribute('href') || card.querySelector('a[href]')?.getAttribute('href') || href || '') ||
          undefined;

        const product = { title, price, asin: asinMatch, rating, review_count: reviewCount, url, badge, footnote };
        productSuggestions.push({ title, price, asin: asinMatch });
        candidates.push({ el: card, kind: 'product', payload: { product } });
      });

      // footnotes (keep in order even if captured above)
      section
        .querySelectorAll<HTMLElement>('.rufus-asin-faceout-footer .a-color-base, .alexa-asin-faceout-footer .a-color-base')
        .forEach((el) => {
        const text = normalizeText(el.innerText || '');
        if (text) {
          candidates.push({ el, kind: 'footnote', payload: { text } });
        }
        });

      // CTA / quick replies / links inside the turn
      section
        .querySelectorAll<HTMLElement>('[data-rufus-action], [data-alexa-action], .rufus-action, .alexa-action, [data-action-type]')
        .forEach((el) => {
        const text = normalizeText(el.innerText || '');
        if (!text) return;
        const url = (el.getAttribute('href') || el.getAttribute('data-url') || el.getAttribute('data-rufus-url') || el.getAttribute('data-alexa-url') || '').trim();
        const actionType = el.getAttribute('data-rufus-action') || el.getAttribute('data-alexa-action') || el.getAttribute('data-action-type') || null;
        candidates.push({
          el,
          kind: 'cta',
          payload: { text, action: { text, url: url || null, action_type: actionType } },
        });
        });

      // sort by DOM order to preserve sequence
      candidates.sort((a, b) => {
        if (a.el === b.el) return 0;
        const pos = a.el.compareDocumentPosition(b.el);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

      const blocks: Array<{
        kind: 'markdown' | 'header' | 'product' | 'footnote' | 'cta';
        text?: string;
        product?: {
          title: string;
          price?: string;
          asin?: string;
          brand?: string;
          rating?: string;
          review_count?: string;
          url?: string;
          badge?: string;
          footnote?: string;
        };
        action?: { text?: string; url?: string | null; action_type?: string | null };
      }> = [];

      candidates.forEach((c) => {
        if (c.kind === 'product') {
          blocks.push({ kind: 'product', product: c.payload.product });
        } else if (c.kind === 'cta') {
          blocks.push({ kind: 'cta', text: c.payload.text, action: c.payload.action });
        } else {
          if (c.payload.text) {
            blocks.push({ kind: c.kind, text: c.payload.text });
          }
        }
      });

      if (blocks.length) {
        turns.push({ sequence_id: sequenceId, blocks });
      }
    });

    const uniqueUserTexts = Array.from(new Set(userTexts.filter(Boolean)));
    const uniqueProducts = productSuggestions
      .filter((p, idx, arr) => {
        const key = `${p.title}|${p.price || ''}|${p.asin || ''}`;
        return arr.findIndex((q) => `${q.title}|${q.price || ''}|${q.asin || ''}` === key) === idx;
      })
      .slice(0, 10);

    const meaningfulTurns = turns.filter((t) => t.blocks.length);

    if (!uniqueUserTexts.length && !uniqueProducts.length && !meaningfulTurns.length) {
      return;
    }

    // Cap turns to last 10 for efficiency
    const cappedTurns = meaningfulTurns.slice(-10);

    // also provide a flattened view for the first few products
    const flattened: Record<string, string | undefined> = {};
    uniqueProducts.forEach((p, i) => {
      const idx = i + 1;
      flattened[`product_${idx}_title`] = p.title;
      flattened[`product_${idx}_price`] = p.price;
      flattened[`product_${idx}_asin`] = p.asin;
      flattened[`product_${idx}_brand`] = p.brand;
    });

    // Truncate long text fields to 500 chars and cap product suggestions to 5
    const truncatedUserTexts = uniqueUserTexts.map((t) => t.slice(0, 500));
    const cappedProducts = uniqueProducts.slice(0, 5);

    const payload = {
      url: window.location.href,
      user_texts: truncatedUserTexts,
      product_suggestions: cappedProducts,
      turns: cappedTurns,
      ...flattened,
    };

    const payloadHash = JSON.stringify({
      url: payload.url,
      user_texts: payload.user_texts,
      product_suggestions: payload.product_suggestions,
      turns: payload.turns,
    });

    if (payloadHash === this.lastAssistantPayloadHash) {
      return;
    }

    this.lastAssistantCapture = now;
    this.lastAssistantPayloadHash = payloadHash;
    this.sendTelemetry(Event.ASSISTANT_TEXT, payload);
  }

  private sendTelemetry(event: Event, properties: Record<string, any> = {}): void {
    if (!this.trackingActive()) return;
    try {
      chrome.runtime.sendMessage(
        {
          type: 'telemetry',
          event,
          properties,
        },
        () => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            console.warn('telemetry send error', lastError.message);
          }
        },
      );
    } catch (err) {
      console.error('failed to send telemetry from content', err);
    }
  }

  private getAsinFromUrl(url: string): string | null {
    const dpMatch = url.match(/\/dp\/([A-Z0-9]{10})/i);
    if (dpMatch && dpMatch[1]) return dpMatch[1];

    const gpMatch = url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
    if (gpMatch && gpMatch[1]) return gpMatch[1];

    return null;
  }

  private isProductDetailPage(url: string): boolean {
    return /\/dp\/[A-Z0-9]{10}/i.test(url) || /\/gp\/product\/([A-Z0-9]{10})/i.test(url);
  }
}
