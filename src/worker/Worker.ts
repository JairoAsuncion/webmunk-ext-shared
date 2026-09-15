// dont remove next line, all webmunk modules use messenger utility
// @ts-ignore
// import { messenger } from '@webmunk/utils';
import { NotificationService } from './NotificationService';
import { UNINSTALL_URL } from '../config';
import { EventService } from './EventService';
import { FirebaseAppService } from './FirebaseAppService';
import { ConfigService } from './ConfigService';
import { SurveyService } from './SurveyService';
import { Event } from '../enums';
import { getStoredArm } from './ArmService';
import { debug } from '../utils/log';

// `@firebase/remote-config` reads `window.FIREBASE_REMOTE_CONFIG_URL_BASE` with no
// `typeof window` guard (it's the endpoint-override hook). An MV3 service worker
// has no `window`, so the first Remote Config fetch throws
// `ReferenceError: window is not defined` (confirmed from the stack trace on
// 2026-08-31). Alias `window` to the worker global so the lookup resolves to
// `undefined` and RC falls back to its default endpoint.
//
// `document` is deliberately left undefined: @jitsu/js checks `window && document`
// to detect a browser and, seeing no `document`, runs in its DOM-free runtime
// (no cookies / localStorage). This is a compatibility shim for an unguarded
// lookup in a Google library - not remote code and not eval.
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as { window?: unknown }).window = globalThis;
}

// new Webmunk study worker logic
const firebaseAppService = new FirebaseAppService();
const configService = new ConfigService(firebaseAppService);
const eventService = new EventService(firebaseAppService, configService);
const notificationService = new NotificationService();
const surveyService = new SurveyService(firebaseAppService, notificationService, eventService);

// restore any stored surveys on startup
surveyService.initSurveysIfExists().catch((e) => {
  console.warn('[wm] failed to init stored surveys', e);
});

// Feature flags to reduce event volume for the current experiment
// Disabled PAGE_VIEW because NAV_COMMITTED provides same signal with better structure
const ENABLE_PAGE_VIEW_EVENTS = false;
const ENABLE_HEARTBEAT = false;
const ENABLE_URL_TRACKING = false;
const ENABLE_NAV_COMMITTED = true;

debug('[wm] worker entry initialized');

async function sendPopupLoginResponse(prolificId?: string) {
  const response: any = { action: 'webmunkExt.popup.loginRes' };

  try {
    const userData = await firebaseAppService.login(prolificId);
    response.data = userData;
  } catch (error: any) {
    response.error = error?.message || String(error);
  }

  chrome.runtime.sendMessage(response);
}

async function sendPopupInstructionsResponse() {
  const response: any = { action: 'webmunkExt.popup.getInstructionsRes' };

  try {
    response.instructions = await configService.getConfigByKey('shopping_instructions');
  } catch (error) {
    console.warn('[wm] failed to load shopping_instructions from Remote Config', error);
  }

  chrome.runtime.sendMessage(response);
}

async function handleSuccessfulRegistration() {
  try {
    const user = await firebaseAppService.getUser();

    if (user?.prolificId && UNINSTALL_URL) {
      chrome.runtime.setUninstallURL(`${UNINSTALL_URL}?key=webmunk&userId=${user.prolificId}`);
    }

    if (user?.prolificId) {
      await eventService.track(Event.USER_MAPPING, { prolificId: user.prolificId });
    }

    // Same transition tryAutoRegisterFromRedirect() uses for the Qualtrics-redirect path. This
    // is the popup's manual-entry fallback (participant typed their Prolific ID in because the
    // automatic redirect didn't register them) - it previously only called startWeekTiming() +
    // initSurveysIfNeeded() here without ever setting taskStage to 'shopping', which left
    // cart-reached and the shopping-start notification permanently unreachable for anyone who
    // went through this path.
    await surveyService.startShoppingTask('manual_entry');
  } catch (err) {
    console.error('failed to complete registration flow', err);
  }
}

// for now the study is limited to Amazon domains
function isStudyUrl(rawUrl: string | undefined | null): boolean {
  if (!rawUrl) return false;

  try {
    const url = new URL(rawUrl);
    return url.hostname.includes('amazon.');
  } catch {
    return false;
  }
}

// Whether the shopping task has genuinely started: registered (taskStage past its 'initial'
// default) AND signed into Amazon. Gates every behavioral counter/event below (nav_count,
// dwell_ms, product_page_view_count, etc.) that otherwise accumulates regardless of whether
// EventService.track() actually sends anything - browsing before registration completes (e.g.
// Qualtrics failed to hand off the Prolific ID) or before Content.ts's login-required block is
// cleared doesn't represent real task engagement, and would otherwise inflate the
// session_summary counts that feed the Engagement & Exploration construct and gold/
// session_metrics tables downstream with pre-task noise.
async function isShoppingTaskActive(): Promise<boolean> {
  const { taskStage, amazonLoginConfirmed } = await chrome.storage.local.get(['taskStage', 'amazonLoginConfirmed']);
  return Boolean(taskStage) && taskStage !== 'initial' && Boolean(amazonLoginConfirmed);
}

// Control/vulnerability evidence events are exempt from the isShoppingTaskActive() gate below -
// their entire point is to fire precisely when that check is false (blocked/not registered), so
// gating them the same way as ordinary engagement telemetry would silently erase the evidence
// they exist to capture.
const CONTROL_EVIDENCE_EVENTS: Set<Event> = new Set([Event.AMAZON_LOGIN_BLOCK_SHOWN, Event.PRE_TASK_ACTIVITY_SUPPRESSED]);

// installed event
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const arm = await getStoredArm();

    await eventService.track(Event.INSTALLED, {
      url: 'chrome://extensions',
      install_reason: details.reason,
      arm,
    });
    debug('[wm] installed event sent');
  } catch (e) {
    console.warn('[wm] failed to track installed event', e);
  }
});

// page view based on tab updates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status !== 'complete') return;
    if (!tab.url) return;

    const url = tab.url;
    if (!isStudyUrl(url)) return;

    // dwell tracking must run regardless of ENABLE_PAGE_VIEW_EVENTS - same-tab navigation
    // (not just tab switches) is the primary way dwell time accrues in a single-tab session
    if (tab.active) {
      await handleActiveTabUrlChange(tabId, url);
    }

    if (!ENABLE_PAGE_VIEW_EVENTS) return;

    const summary = getOrCreateSummary(tabId, url);
    summary.page_view_count += 1;

    const arm = await getStoredArm();

    await eventService.track(Event.PAGE_VIEW, {
      url,
      tabId,
      arm,
    });
  } catch (e) {
    console.error('failed to track page_view', e);
  }
});

// navigation committed event
chrome.webNavigation.onCommitted.addListener(async (details) => {
  try {
    const url = details.url;
    if (!isStudyUrl(url)) return;
    if (details.frameId !== 0) return; // only top-frame

    // check cart reached to advance survey flow for any Amazon locale
    try {
      const parsed = new URL(url);
      if (parsed.pathname.includes('/gp/cart') || parsed.pathname.includes('/cart')) {
        await surveyService.handleCartReached(details.tabId);
      }
    } catch {
      // ignore malformed URL from browser event
    }

    // Don't let pre-login (or pre-registration) navigation inflate nav_count/session_summary -
    // this page may be sitting behind Content.ts's login-required block, or the participant
    // isn't registered yet, neither of which is real task engagement. handleCartReached() above
    // still runs regardless, since it's what surfaces the "you need to sign in" notice.
    if (!(await isShoppingTaskActive())) return;

    const summary = getOrCreateSummary(details.tabId, url);
    summary.nav_count += 1;

    const arm = await getStoredArm();

    await eventService.track(Event.NAV_COMMITTED, {
      url,
      tabId: details.tabId,
      arm,
    });
    debug('[wm] tracked amazon visit:', details.url);
  } catch (e) {
    console.warn('[wm] failed to track nav_committed', e);
  }
});

// simple heartbeat every minute for the active tab in scope
let studyStartTs = Date.now();
const HEARTBEAT_INTERVAL_MS = 300_000; // 5 minutes
const HEARTBEAT_FORCE_SEND_MS = 600_000; // force at least every 10 minutes
const lastHeartbeatByTab = new Map<number, { url: string; ts: number }>();
type ActiveTabContext = {
  tabId: number | null;
  url: string | null;
  startedAt: number | null;
};
const activeTab: ActiveTabContext = {
  tabId: null,
  url: null,
  startedAt: null,
};

type TabSummary = {
  start_ts: number;
  last_url: string | null;
  nav_count: number;
  page_view_count: number;
  heartbeat_count: number;
  dwell_ms: number;
  add_to_cart_count: number;
  search_count: number;
  remove_count: number;
  filter_count: number;
  backtrack_count: number;
  decision_count: number;
  first_decision_latency_ms: number | null;
  product_result_click_count: number;
  product_page_view_count: number;
  unique_product_asins: string[];
  assistant_interaction_count: number;
  assistant_hidden_count: number;
  assistant_leak_count: number;
  assistant_available: boolean;
  last_subtotal: string | null;
  last_subtotal_amount: number | null;
  final_subtotal: string | null;
  final_subtotal_amount: number | null;
  pre_existing_cart_count: number | null;
  final_cart_item_count: number | null;
  final_cart_items: Array<{ asin?: string; title?: string; price?: string; brand?: string }> | null;
};
const summaries = new Map<number, TabSummary>();

function getOrCreateSummary(tabId: number, url: string | null): TabSummary {
  let summary = summaries.get(tabId);
  if (!summary) {
    summary = {
      start_ts: Date.now(),
      last_url: url,
      nav_count: 0,
      page_view_count: 0,
      heartbeat_count: 0,
      dwell_ms: 0,
      add_to_cart_count: 0,
      search_count: 0,
      remove_count: 0,
      filter_count: 0,
      backtrack_count: 0,
      decision_count: 0,
      first_decision_latency_ms: null,
      product_result_click_count: 0,
      product_page_view_count: 0,
      unique_product_asins: [],
      assistant_interaction_count: 0,
      assistant_hidden_count: 0,
      assistant_leak_count: 0,
      assistant_available: false,
      last_subtotal: null,
      last_subtotal_amount: null,
      final_subtotal: null,
      final_subtotal_amount: null,
      pre_existing_cart_count: null,
      final_cart_item_count: null,
      final_cart_items: null,
    };
    summaries.set(tabId, summary);
  } else if (url) {
    summary.last_url = url;
  }
  return summary;
}

async function sendSessionSummary(tabId: number): Promise<void> {
  const summary = summaries.get(tabId);
  if (!summary) return;

  const now = Date.now();
  const durationMs = Math.max(0, now - summary.start_ts);
  const arm = await getStoredArm();

  await eventService.track(Event.SESSION_SUMMARY, {
    tabId,
    start_ts: summary.start_ts,
    end_ts: now,
    duration_ms: durationMs,
    last_url: summary.last_url,
    nav_count: summary.nav_count,
    page_view_count: summary.page_view_count,
    heartbeat_count: summary.heartbeat_count,
    dwell_ms: summary.dwell_ms,
    add_to_cart_count: summary.add_to_cart_count,
    search_count: summary.search_count,
    remove_count: summary.remove_count,
    filter_count: summary.filter_count,
    backtrack_count: summary.backtrack_count,
    decision_count: summary.decision_count,
    first_decision_latency_ms: summary.first_decision_latency_ms,
    product_result_click_count: summary.product_result_click_count,
    product_page_view_count: summary.product_page_view_count,
    unique_product_asin_count: summary.unique_product_asins.length,
    assistant_interaction_count: summary.assistant_interaction_count,
    assistant_hidden_count: summary.assistant_hidden_count,
    assistant_leak_count: summary.assistant_leak_count,
    assistant_available: summary.assistant_available,
    last_subtotal: summary.last_subtotal,
    last_subtotal_amount: summary.last_subtotal_amount,
    final_subtotal: summary.final_subtotal,
    final_subtotal_amount: summary.final_subtotal_amount,
    pre_existing_cart_count: summary.pre_existing_cart_count,
    final_cart_item_count: summary.final_cart_item_count,
    final_cart_items: summary.final_cart_items,
    arm,
  });

  summaries.delete(tabId);
}

async function recordTabDwell(now: number): Promise<void> {
  if (activeTab.tabId === null || !activeTab.url || activeTab.startedAt === null || !isStudyUrl(activeTab.url)) {
    return;
  }

  const { taskStage, amazonLoginConfirmed, shoppingTaskStartedAt } = await chrome.storage.local.get([
    'taskStage',
    'amazonLoginConfirmed',
    'shoppingTaskStartedAt',
  ]);
  if (!taskStage || taskStage === 'initial' || !amazonLoginConfirmed) {
    // Time spent behind the login-required block (or before registration) isn't genuine
    // engagement - would otherwise inflate session_summary.dwell_ms with pre-task idle time.
    return;
  }

  // Clip the window to when login was actually confirmed, in case this dwell interval started
  // earlier (e.g. the participant landed on Amazon, spent time behind the login-required block,
  // then signed in without switching tabs or navigating) - otherwise the pre-login portion would
  // still be counted just because the *end* of the interval happens to land after the gate above.
  const dwellStartedAt = Math.max(activeTab.startedAt, Number(shoppingTaskStartedAt) || 0);
  const dwellMs = now - dwellStartedAt;
  if (dwellMs <= 0) {
    return;
  }

  const summary = getOrCreateSummary(activeTab.tabId, activeTab.url);
  summary.dwell_ms += dwellMs;

  const arm = await getStoredArm();

  await eventService.track(Event.TAB_DWELL, {
    url: activeTab.url,
    tabId: activeTab.tabId,
    dwell_ms: dwellMs,
    arm,
  });
}

async function setActiveTab(tabId: number | null, url: string | null, now: number): Promise<void> {
  if (tabId !== null && url && isStudyUrl(url)) {
    activeTab.tabId = tabId;
    activeTab.url = url;
    activeTab.startedAt = now;
    getOrCreateSummary(tabId, url);
  } else {
    activeTab.tabId = null;
    activeTab.url = null;
    activeTab.startedAt = null;
  }
}

async function handleTabSwitch(newTabId: number): Promise<void> {
  const now = Date.now();
  await recordTabDwell(now);

  const tab = await chrome.tabs.get(newTabId);
  const newUrl = tab?.url || null;

  await setActiveTab(newTabId, newUrl, now);
}

async function handleActiveTabUrlChange(tabId: number, newUrl: string): Promise<void> {
  if (!tabId || !newUrl) return;

  const now = Date.now();

  // activeTab never gets populated by chrome.tabs.onActivated when the tab was already
  // focused before this (MV3, ephemeral) service worker instance started - which is the
  // common case for a participant who opens one tab and never switches. Bootstrap the
  // clock here instead of bailing out, so single-tab sessions still accrue dwell time.
  if (activeTab.tabId === null) {
    await setActiveTab(tabId, newUrl, now);
    return;
  }

  if (activeTab.tabId !== tabId) {
    // active tab changed without onActivated firing - defensive fallback
    await recordTabDwell(now);
    await setActiveTab(tabId, newUrl, now);
    return;
  }

  if (activeTab.url && activeTab.url !== newUrl && isStudyUrl(activeTab.url)) {
    await recordTabDwell(now);
  }

  await setActiveTab(tabId, newUrl, now);
}

setInterval(async () => {
  if (!ENABLE_HEARTBEAT) return;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = tabs[0];
    if (!active || !active.url) return;

    const url = active.url;
    if (!isStudyUrl(url)) return;

    const now = Date.now();
    const last = active.id ? lastHeartbeatByTab.get(active.id) : undefined;
    const minutes = (now - studyStartTs) / 60000;
    const arm = await getStoredArm();

    const shouldSend = !last || last.url !== url || now - last.ts >= HEARTBEAT_FORCE_SEND_MS;

    if (!shouldSend) return;

    if (active.id !== undefined) {
      lastHeartbeatByTab.set(active.id, { url, ts: now });
      const summary = getOrCreateSummary(active.id, url);
      summary.heartbeat_count += 1;
    }

    await eventService.track(Event.HEARTBEAT, {
      url,
      tabId: active.id,
      minutes,
      arm,
    });
  } catch (e) {
    console.error('failed to track heartbeat', e);
  }
}, HEARTBEAT_INTERVAL_MS);

chrome.tabs.onActivated.addListener((activeInfo) => {
  handleTabSwitch(activeInfo.tabId).catch((e) => {
    console.error('failed to handle tab switch', e);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // capture final dwell for the removed tab if it was active
  if (activeTab.tabId === tabId) {
    recordTabDwell(Date.now()).catch(() => {});
  }

  sendSessionSummary(tabId).catch((e) => {
    console.error('failed to send session summary', e);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return;
  }

  if (message.action === 'webmunkExt.popup.loginReq') {
    sendPopupLoginResponse(message.prolificId);
    return;
  }

  if (message.action === 'webmunkExt.popup.successRegister') {
    handleSuccessfulRegistration();
    return;
  }

  if (message.action === 'webmunkExt.popup.getInstructionsReq') {
    sendPopupInstructionsResponse();
    return;
  }

  // content script reports whether the participant is currently signed into Amazon
  if (message.type === 'amazon_login_status') {
    debug('[wm] received amazon_login_status', { loggedIn: message.loggedIn, tabId: sender.tab?.id });
    if (message.loggedIn) {
      surveyService.confirmAmazonLogin().catch((e) => {
        console.warn('[wm] failed to confirm Amazon login', e);
      });
    } else {
      surveyService.maybeShowLoginNudge(sender.tab?.id).catch((e) => {
        console.warn('[wm] failed to show Amazon login nudge', e);
      });
    }

    return;
  }

  // request from content script to know the assigned arm
  if (message.type === 'get_arm') {
    getStoredArm()
      .then((arm) => {
        sendResponse({ arm });
      })
      .catch((err) => {
        console.error('failed to get arm', err);
        sendResponse({ arm: null, error: String(err) });
      });

    return true; // keep channel open
  }

  // telemetry from content scripts
  if (message.type !== 'telemetry') {
    return;
  }

  const { event, properties = {} } = message as {
    event: Event;
    properties?: Record<string, any>;
  };

  const tabId = sender.tab?.id;
  const urlFromSender = sender.tab?.url;

  isShoppingTaskActive()
    .then((active) => {
      if (!active && !CONTROL_EVIDENCE_EVENTS.has(event)) {
        // The shopping task hasn't genuinely started yet - not registered, or registered but
        // still behind Content.ts's login-required block. Telemetry from this window doesn't
        // represent real task engagement, and would inflate session_summary's counts
        // (nav_count, product_page_view_count, search_count, etc. below) which feed the
        // Engagement & Exploration construct and gold/session_metrics tables downstream.
        // Dropped here rather than leaving EventService.track() as the only gate, since that
        // only decides whether the *raw* event reaches Jitsu - the local per-tab summary this
        // function mutates below would still get bumped either way.
        return Promise.resolve();
      }

      return getStoredArm().then((arm) => {
        const payload = {
          ...properties,
          url: urlFromSender || properties.url || '',
          tabId: tabId ?? properties.tabId,
          arm,
        };

        if (payload.tabId !== undefined && payload.tabId !== null) {
          const summary = getOrCreateSummary(payload.tabId, payload.url);
          if (event === Event.ADD_TO_CART_CLICK) {
            summary.add_to_cart_count += 1;
          } else if (event === Event.SEARCH_SUBMITTED) {
            summary.search_count += 1;
          } else if (event === Event.CART_REMOVE) {
            summary.remove_count += 1;
            if ((payload as any).subtotal) {
              summary.last_subtotal = (payload as any).subtotal;
            }
            if ((payload as any).subtotal_amount !== undefined) {
              summary.last_subtotal_amount = Number((payload as any).subtotal_amount);
            }
            summary.final_subtotal = summary.last_subtotal;
            summary.final_subtotal_amount = summary.last_subtotal_amount;
          } else if (event === Event.CART_SUBTOTAL) {
            if ((payload as any).subtotal) {
              summary.last_subtotal = (payload as any).subtotal;
            }
            if ((payload as any).subtotal_amount !== undefined) {
              summary.last_subtotal_amount = Number((payload as any).subtotal_amount);
            }
            summary.final_subtotal = summary.last_subtotal;
            summary.final_subtotal_amount = summary.last_subtotal_amount;
          } else if (event === Event.FILTER_USED) {
            summary.filter_count += 1;
          } else if (event === Event.BACKTRACK_NAVIGATION) {
            summary.backtrack_count += 1;
          } else if (event === Event.DECISION_MADE) {
            summary.decision_count += 1;
            const latency = Number((payload as any).decision_latency_ms);
            if (Number.isFinite(latency) && summary.first_decision_latency_ms === null) {
              summary.first_decision_latency_ms = latency;
            }
          } else if (event === Event.PRODUCT_RESULT_CLICK) {
            summary.product_result_click_count += 1;
            const asin = String((payload as any).asin || '').trim();
            if (asin && !summary.unique_product_asins.includes(asin)) {
              summary.unique_product_asins.push(asin);
            }
          } else if (event === Event.PRODUCT_PAGE_VIEW) {
            summary.product_page_view_count += 1;
            const asin = String((payload as any).asin || '').trim();
            if (asin && !summary.unique_product_asins.includes(asin)) {
              summary.unique_product_asins.push(asin);
            }
          } else if (event === Event.ASSISTANT_TEXT) {
            summary.assistant_interaction_count += 1;
          } else if (event === Event.ASSISTANT_HIDDEN) {
            summary.assistant_hidden_count += 1;
          } else if (event === Event.ASSISTANT_LEAK_DETECTED) {
            summary.assistant_leak_count += 1;
          } else if (event === Event.ASSISTANT_AVAILABLE) {
            summary.assistant_available = true;
          } else if (event === Event.CART_BASELINE_COUNT) {
            summary.pre_existing_cart_count = Number((payload as any).count);
          } else if (event === Event.CART_SNAPSHOT) {
            summary.final_cart_item_count = Number((payload as any).item_count);
            summary.final_cart_items = Array.isArray((payload as any).items) ? (payload as any).items : null;

            // This - not the /cart navigation itself (handleCartReached(), which only
            // still fires the "please sign in" nudge) - is what actually advances to the
            // final survey, gated on a positive item count so a participant who merely
            // visits an empty cart can't complete the task with nothing chosen.
            if (summary.final_cart_item_count >= 1) {
              surveyService.handleCartHasItem(payload.tabId).catch((e) => {
                console.warn('[wm] failed to handle cart-has-item transition', e);
              });
            }
          }
        }

        return eventService.track(event, payload);
      });
    })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => {
      console.error('failed to track event from content', err);
      sendResponse({ ok: false, error: String(err) });
    });

  return true;
});

// Installation handshake for the Qualtrics enrollment page (see
// `externally_connectable` in the manifest, scoped to *.qualtrics.com). The
// survey pings `{ type: 'webmunk_ping' }` before letting the participant
// continue, so a participant who hasn't installed the extension is stopped at
// the enrollment step rather than reaching the shopping task uninstrumented.
// Only replies to the ping; exposes nothing the manifest doesn't already make
// public (id + version).
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'webmunk_ping') {
    sendResponse({
      ok: true,
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
    });
  }
  return true;
});

