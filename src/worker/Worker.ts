import { Backend } from './Backend';
import { StudyService } from './StudyService';
import { canTrack, cleanUrl, isShoppingUrl, isCartUrl, hasAssignment, validateQualtricsUrl, searchState, lookupSession, classifyAssistantQueries, newAssistantTurns, SORT_LABELS } from '../shared/StudyPolicy';
import type { SearchState } from '../shared/StudyPolicy';

// Firebase Remote Config's endpoint-override hook expects a window global.
if (typeof (globalThis as any).window === 'undefined') (globalThis as any).window = globalThis;
const backend = new Backend();
const study = new StudyService(backend, reason => finishSummary(reason));
let work: Promise<unknown> = Promise.resolve();
// Serialize transitions and counters to prevent races across tabs and double-clicks.
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = work.then(fn, fn);
  work = next.catch(() => {});
  return next;
}
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

const BEHAVIOR_EVENTS = new Set([
  'product_page_view', 'add_to_cart_click', 'cart_remove', 'cart_subtotal',
  'assistant_text', 'search_submitted', 'filter_used', 'backtrack_navigation',
  'decision_made', 'product_result_click', 'cart_baseline_count', 'cart_snapshot',
  'assistant_hidden', 'assistant_available', 'assistant_leak_detected', 'assistant_query_submitted',
]);
// Diagnostics about the sign-in gate itself: recorded during the shopping task even
// before Amazon sign-in is confirmed (all other tracking conditions still apply).
const PRE_LOGIN_EVENTS = new Set(['amazon_login_block_shown', 'pre_task_activity_suppressed']);
async function record(event: string, props: Record<string, any>, tabId: number, url: string) {
  const s = await chrome.storage.local.get(null);
  if (!canTrack(PRE_LOGIN_EVENTS.has(event) ? { ...s, amazonLoginConfirmed: true } : s, url)) return;
  const summary = s.studySummary || {};
  // One baseline per session: several tabs/timers can race to capture it; messages are
  // serialized here, so the first one wins.
  if (event === 'cart_baseline_count' && summary.pre_existing_cart_count != null) return;
  const counters: Record<string,string> = { nav_committed:'nav_count', product_page_view:'product_page_view_count',
    add_to_cart_click:'add_to_cart_count', cart_remove:'remove_count', search_submitted:'search_count',
    filter_used:'filter_count', backtrack_navigation:'backtrack_count', decision_made:'decision_count',
    product_result_click:'product_result_click_count', assistant_text:'assistant_interaction_count',
    assistant_query_submitted:'assistant_query_count', assistant_history_query:'assistant_history_query_count',
    assistant_hidden:'assistant_hidden_count', assistant_leak_detected:'assistant_leak_count',
    amazon_login_block_shown:'login_block_shown_count', pre_task_activity_suppressed:'pre_task_suppressed_count' };
  if (counters[event] && props.document_lifecycle !== 'prerender') summary[counters[event]] = (summary[counters[event]] || 0) + 1;
  if (event === 'tab_dwell') summary.dwell_ms = (summary.dwell_ms || 0) + props.dwell_ms;
  if (event === 'assistant_available') summary.assistant_available = true;
  if (event === 'decision_made' && summary.first_decision_latency_ms == null) summary.first_decision_latency_ms = props.decision_latency_ms;
  if (event === 'cart_baseline_count') summary.pre_existing_cart_count = props.count;
  if (event === 'product_result_click' || event === 'product_page_view') {
    const asins = new Set<string>(summary.unique_product_asins || []);
    if (props.asin) asins.add(props.asin);
    summary.unique_product_asins = [...asins];
    summary.unique_product_asin_count = asins.size;
  }
  const extra: Record<string, any> = {};
  if (event === 'add_to_cart_click' && props.asin) extra.addedAsins = [...new Set([...(s.addedAsins || []), props.asin])];
  if (event === 'cart_snapshot' && isCartUrl(url)) {
    extra.currentCart = { ...props, tabId, capturedAt: Date.now(), url: cleanUrl(url) };
    summary.final_cart_item_count = props.item_count;
    summary.final_cart_items = props.items;
    summary.final_subtotal = props.subtotal;
    summary.final_subtotal_amount = props.subtotal_amount;
    // A nonempty cart never advances the task; explicit panel confirmation does.
  }
  summary.last_url = cleanUrl(url);
  await chrome.storage.local.set({ studySummary: summary, ...extra });
  const payload: Record<string, any> = { ...props, url: cleanUrl(url), tabId, arm: s.studyContext.arm };
  if (typeof payload.target_url === 'string') payload.target_url = cleanUrl(payload.target_url);
  await backend.track(event, payload);
}

// Session-persisted dwell survives MV3 suspension. No unrelated-site URLs are saved.
async function endDwell(now = Date.now()) {
  const { dwellContext: d } = await chrome.storage.session.get('dwellContext');
  await chrome.storage.session.remove('dwellContext');
  if (!d) return;
  const s = await chrome.storage.local.get(null);
  if (!canTrack(s, d.url) || d.sessionId !== s.studyContext.sessionId) return;
  const start = Math.max(d.since, Number(s.shoppingTaskStartedAt) || now);
  if (now > start) await record('tab_dwell', { dwell_ms: now - start }, d.tabId, d.url);
}
// committedUrl: the URL from webNavigation.onCommitted, which tab.url may not show yet.
async function beginDwell(tabId: number, committedUrl?: string) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = committedUrl || tab?.url;
  if (!tab?.active || !url) return;
  const win = await chrome.windows.get(tab.windowId);
  const s = await chrome.storage.local.get(null);
  if (!win.focused || !canTrack(s, url)) return;
  await chrome.storage.session.set({ dwellContext: { tabId, url: cleanUrl(url), since: Date.now(), sessionId: s.studyContext.sessionId } });
}
async function finishSummary(reason: string) {
  const s = await chrome.storage.local.get(null);
  if (!s.studyContext || s.summarySent) return;
  const summary = { ...s.studySummary };
  delete summary.unique_product_asins;
  await backend.track('session_summary', { ...summary, reason, summary_scope: 'study_session',
    start_ts: s.shoppingTaskStartedAt, end_ts: s.shoppingTaskStoppedAt || Date.now(),
    duration_ms: s.shoppingTaskStartedAt ? (s.shoppingTaskStoppedAt || Date.now()) - s.shoppingTaskStartedAt : null,
    final_choice: s.finalChoice || null });
  await chrome.storage.local.set({ summarySent: true });
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && change.status !== 'loading' && change.status !== 'complete') return;
  void enqueue(async () => {
    // A new URL in the tab ends the current page's dwell and starts the next one. The
    // navigation-commit handler below does the same and skips a page already being timed,
    // so the two notifications Chrome sends for one navigation produce one dwell row.
    if (change.url) {
      const { dwellContext } = await chrome.storage.session.get('dwellContext');
      if (dwellContext?.tabId === tabId && dwellContext.url !== cleanUrl(change.url)) {
        await endDwell();
        await beginDwell(tabId, change.url);
      }
    }
    if (tab.url && isShoppingUrl(tab.url) && hasAssignment(tab.url)) await study.enroll(tab.url, tabId);
    if (change.status === 'complete') {
      const { dwellContext } = await chrome.storage.session.get('dwellContext');
      if (dwellContext?.tabId !== tabId) await beginDwell(tabId);
    }
  }).catch(console.error);
});
chrome.tabs.onActivated.addListener(({tabId}) => {
  void enqueue(async () => { await endDwell(); await beginDwell(tabId); }).catch(console.error);
});
chrome.windows.onFocusChanged.addListener(windowId => {
  void enqueue(async () => {
    await endDwell();
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [tab] = await chrome.tabs.query({ active:true, windowId });
    if (tab?.id != null) await beginDwell(tab.id);
  }).catch(console.error);
});
async function forgetLoginReport(tabId: number) {
  const { loginReports = {} } = await chrome.storage.session.get('loginReports');
  if (!(tabId in loginReports)) return;
  delete loginReports[tabId];
  await chrome.storage.session.set({ loginReports });
}
chrome.tabs.onRemoved.addListener(tabId => {
  void enqueue(async () => {
    const { dwellContext } = await chrome.storage.session.get('dwellContext');
    if (dwellContext?.tabId === tabId) await endDwell();
    await forgetLoginReport(tabId);
    // Closing a tab is not completion; the study can be resumed.
  }).catch(console.error);
});
// Filter and sort actions are derived from consecutive search-results URLs in a tab: the
// URL records exactly what Amazon applied, which click listeners could not (the sort menu
// fires no change event; list expanders looked like filters). Amazon applies most filters
// in place (history.pushState, no page load), so this also runs on onHistoryStateUpdated.
// Back/forward navigation and a new query are not filter actions. The clicked filter's
// label arrives as a hint.
async function recordSearchChange(tabId: number, url: string, qualifiers: string[]) {
  const next = searchState(url);
  if (!next) return;
  const { searchStates = {}, filterHints = {} } = await chrome.storage.session.get(['searchStates', 'filterHints']);
  const prev: SearchState | undefined = searchStates[tabId];
  searchStates[tabId] = next;
  const hint = filterHints[tabId];
  delete filterHints[tabId];
  await chrome.storage.session.set({ searchStates, filterHints });
  if (!prev || prev.query !== next.query || qualifiers.includes('forward_back')) return;
  if (prev.sort !== next.sort) {
    await record('filter_used', { filter_type: 'sort', filter_value: next.sort || 'default',
      filter_text: SORT_LABELS[next.sort] || next.sort, source: 'url' }, tabId, url);
  }
  const added = next.refinements.filter(r => !prev.refinements.includes(r));
  const removed = prev.refinements.filter(r => !next.refinements.includes(r));
  if (added.length || removed.length) {
    const text = hint && Date.now() - hint.at < 15000 ? hint.text : undefined;
    await record('filter_used', { filter_type: 'refinement', added, removed,
      ...(text ? { filter_text: text } : {}), source: 'url' }, tabId, url);
  }
}

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0 || !isShoppingUrl(details.url)) return;
  // Prerendered pages (speculative loads) are flagged and not counted: they may never be seen.
  const prerender = (details as any).documentLifecycle === 'prerender';
  void enqueue(async () => {
    await record('nav_committed', prerender ? { document_lifecycle: 'prerender' } : {}, details.tabId, details.url);
    if (prerender) return;
    await recordSearchChange(details.tabId, details.url, (details as any).transitionQualifiers || []);
    // Time the page from commit, not from the full page load: quick visits were lost.
    const { dwellContext } = await chrome.storage.session.get('dwellContext');
    if (dwellContext?.tabId === details.tabId && dwellContext.url === cleanUrl(details.url)) return;
    if (dwellContext?.tabId === details.tabId) await endDwell();
    await beginDwell(details.tabId, details.url);
  }).catch(console.error);
});

// Questions put to the assistant, one event per distinct text per session: the panel shows the
// whole conversation again on every page. Panel texts are matched to the participant's submit
// actions (classifyAssistantQueries); texts without one were re-rendered from an earlier
// conversation (other pages, or before the study) and are recorded as assistant_history_query,
// which does not count as use. Questions from the product page's inline "Ask Alexa" box arrive
// already classified (surface inline_widget): they never appear in the panel.
async function recordAssistantQueries(props: any, tabId: number, url: string) {
  const s = await chrome.storage.local.get(null);
  if (!canTrack(s, url)) return;
  const seen: string[] = s.assistantQueries || [];
  const clean = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const items: Array<{ text: string; via: string; surface: string }> = [];
  const add = (text: string, via: string, surface: string) => {
    if (text && !seen.includes(text) && !items.some(q => q.text === text)) items.push({ text, via, surface });
  };
  for (const q of Array.isArray(props?.queries) ? props.queries : []) {
    add(clean(q?.text), q?.via === 'suggested' ? 'suggested' : 'typed', q?.surface === 'inline_widget' ? 'inline_widget' : 'panel');
  }
  const texts: string[] = [...new Set<string>((Array.isArray(props?.texts) ? props.texts : []).map(clean))]
    .filter(t => t && !seen.includes(t) && !items.some(q => q.text === t));
  const { queries, remaining } = classifyAssistantQueries(texts, s.assistantSubmits || [], Date.now());
  for (const q of queries) add(q.text, q.via, 'panel');
  if (!items.length) return;
  await chrome.storage.local.set({ assistantQueries: [...seen, ...items.map(q => q.text)], assistantSubmits: remaining });
  for (const q of items) {
    if (q.via === 'history') await record('assistant_history_query', { query: q.text, surface: q.surface }, tabId, url);
    else await record('assistant_query_submitted', { query: q.text, via: q.via, surface: q.surface, in_first_capture: seen.length === 0 }, tabId, url);
  }
}

// A snapshot keeps only conversation turns not recorded before in this session; one with
// nothing new is dropped (the panel re-rendered on another page).
async function newAssistantSnapshot(props: any, url: string): Promise<Record<string, any> | null> {
  const s = await chrome.storage.local.get(null);
  if (!canTrack(s, url)) return null;
  const known: string[] = s.assistantTurnKeys || [];
  const { turns, keys, omitted } = newAssistantTurns(props?.turns, known);
  if (!turns.length) return null;
  await chrome.storage.local.set({ assistantTurnKeys: [...known, ...keys] });
  return { ...props, turns, turns_omitted: omitted };
}

// An add to cart outside the product page's button (search-result tile, assistant card, ...),
// detected by the content script as a rise of the cart count badge. It is attributed to the
// last "Add to cart" control clicked in the tab, and marks the first decision if none yet.
const ADD_ATTRIBUTION_MS = 15000;
async function recordCountedAdd(tabId: number, url: string, from: number, to: number) {
  const now = Date.now();
  const { addContexts = {}, explicitAdds = {} } = await chrome.storage.session.get(['addContexts', 'explicitAdds']);
  const context = addContexts[tabId];
  delete addContexts[tabId];
  await chrome.storage.session.set({ addContexts });
  if (explicitAdds[tabId] && now - explicitAdds[tabId] < ADD_ATTRIBUTION_MS) return;
  const recent = context && now - context.at < ADD_ATTRIBUTION_MS ? context : null;
  const props = { asin: recent?.asin ?? null, surface: recent?.surface ?? 'unknown', detection: 'cart_count',
    cart_count_from: from, cart_count_to: to, ...(recent?.title ? { title: recent.title } : {}) };
  await record('add_to_cart_click', props, tabId, url);
  const s = await chrome.storage.local.get(null);
  if (s.decisionTracked || !canTrack(s, url)) return;
  await chrome.storage.local.set({ decisionTracked: true, decisionMadeAt: now });
  await record('decision_made', { ...props, decision_definition: 'first_add_to_cart_click_not_final_choice',
    decision_latency_ms: s.shoppingTaskStartedAt ? now - s.shoppingTaskStartedAt : null }, tabId, url);
}

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0 || !isShoppingUrl(details.url)) return;
  void enqueue(() => recordSearchChange(details.tabId, details.url, (details as any).transitionQualifiers || []))
    .catch(console.error);
});

async function activeStudyTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active:true, lastFocusedWindow:true });
  const { studyContext: c } = await chrome.storage.local.get('studyContext');
  if (tab?.id == null || !isShoppingUrl(tab.url) || new URL(tab.url!).origin !== c?.origin) {
    throw new Error('Switch to your Amazon study tab first.');
  }
  return tab;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;
  // Do not await storage/network before open(): Chrome requires the click gesture.
  if (message.type === 'study_open_panel' && sender.tab?.id != null && sender.frameId === 0 && isShoppingUrl(sender.url)) {
    chrome.sidePanel.open({ windowId: sender.tab.windowId })
      .then(() => sendResponse({ok:true}), e => sendResponse({ok:false,error:String(e)}));
    return true;
  }
  const fromPanel = (!sender.tab && sender.url === chrome.runtime.getURL('popup/popup.html')) ||
    (backend.preview && sender.url === chrome.runtime.getURL('popup/preview-tools.html'));
  const tabId = sender.tab?.id;
  const content = tabId != null && isShoppingUrl(sender.url);
  const top = content && sender.frameId === 0;
  const types = new Set(['study_context','amazon_login_status','telemetry','filter_hint','cart_add_context','assistant_submit',
    'cart_count_increased','study_retry','study_cart',
    'study_refresh_cart','study_confirm','study_continue','study_stop','study_preview_reset','study_preview_p2','study_expired']);
  if (!types.has(message.type)) return;
  void enqueue(async () => {
    if (top || fromPanel) {
      const current = await chrome.storage.local.get(['taskStage','studyContext']);
      if (current.taskStage === 'shopping' && !(current.studyContext?.expiresAt > Date.now())) {
        await endDwell();
        await chrome.storage.local.set({taskStage:'stopped',amazonLoginConfirmed:false,shoppingTaskStoppedAt:Date.now(),
          studyError:'The study session has timed out and shopping tracking has stopped. Contact the researcher.'});
        await finishSummary('session_timeout');
      }
    }
    if (message.type === 'study_expired') return {ok:true};
    if (message.type === 'study_context' && top) {
      await study.enroll(sender.url!, tabId!);
      return {ok:true};
    }
    if (message.type === 'amazon_login_status' && top) {
      const s = await chrome.storage.local.get('studyContext');
      if (s.studyContext?.origin !== new URL(sender.url!).origin) return {ok:false};
      // Each tab reports what its own page shows. A tab rendered before sign-in keeps showing
      // "signed out"; letting it override a signed-in tab made the tabs flip the state back and
      // forth on every storage change (1,409 login events in one pilot session). Signed in =
      // any study tab currently reports signed in.
      const { loginReports = {} } = await chrome.storage.session.get('loginReports');
      loginReports[tabId!] = message.loggedIn === true;
      await chrome.storage.session.set({ loginReports });
      const loggedIn = Object.values(loginReports).some(Boolean);
      if (!loggedIn) await endDwell();
      await study.login(loggedIn);
      if (loggedIn) {
        const { dwellContext } = await chrome.storage.session.get('dwellContext');
        if (!dwellContext) await beginDwell(tabId!);
      }
      return {ok:true};
    }
    if (message.type === 'telemetry' && content && (BEHAVIOR_EVENTS.has(message.event) || PRE_LOGIN_EVENTS.has(message.event))) {
      if (!top && !['assistant_hidden','assistant_leak_detected'].includes(message.event)) return {ok:false};
      if (message.event === 'assistant_query_submitted') {
        await recordAssistantQueries(message.properties, tabId!, sender.url!);
        return {ok:true};
      }
      if (message.event === 'assistant_text') {
        const snapshot = await newAssistantSnapshot(message.properties, sender.url!);
        if (snapshot) await record('assistant_text', snapshot, tabId!, sender.url!);
        return {ok:true};
      }
      await record(message.event, message.properties || {}, tabId!, sender.url!);
      if (message.event === 'add_to_cart_click') {
        // Recorded by the product page's button: the badge increase that follows is the same add.
        const { explicitAdds = {} } = await chrome.storage.session.get('explicitAdds');
        explicitAdds[tabId!] = Date.now();
        await chrome.storage.session.set({ explicitAdds });
      }
      return {ok:true};
    }
    if (message.type === 'assistant_submit' && top) {
      const s = await chrome.storage.local.get(null);
      if (!canTrack(s, sender.url!)) return {ok:false};
      const text = typeof message.text === 'string' ? message.text.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
      const submits = [...(s.assistantSubmits || []), { at: Date.now(), via: message.via === 'suggested' ? 'suggested' : 'typed', ...(text ? { text } : {}) }];
      await chrome.storage.local.set({ assistantSubmits: submits.slice(-5) });
      return {ok:true};
    }
    if (message.type === 'cart_add_context' && tabId != null && isShoppingUrl(sender.tab?.url)) {
      // Any frame of a study tab: the assistant's cards may render in a frame.
      if (!canTrack(await chrome.storage.local.get(null), sender.tab?.url || '')) return {ok:false};
      const { addContexts = {} } = await chrome.storage.session.get('addContexts');
      const asin = typeof message.asin === 'string' && /^[A-Z0-9]{10}$/.test(message.asin) ? message.asin : null;
      const title = typeof message.title === 'string' ? message.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      addContexts[tabId!] = { asin, surface: String(message.surface || 'other').slice(0, 40), at: Date.now(), ...(title ? { title } : {}) };
      await chrome.storage.session.set({ addContexts });
      return {ok:true};
    }
    if (message.type === 'cart_count_increased' && top) {
      await recordCountedAdd(tabId!, sender.url!, Number(message.from), Number(message.to));
      return {ok:true};
    }
    if (message.type === 'filter_hint' && top) {
      if (!canTrack(await chrome.storage.local.get(null), sender.url!)) return {ok:false};
      const { filterHints = {} } = await chrome.storage.session.get('filterHints');
      filterHints[tabId!] = { text: String(message.text || '').slice(0, 200), at: Date.now() };
      await chrome.storage.session.set({ filterHints });
      return {ok:true};
    }
    if (!fromPanel) throw new Error('This action is only available in the study panel.');
    if (message.type === 'study_retry') {
      const [tab] = await chrome.tabs.query({ active:true, lastFocusedWindow:true });
      if (!tab?.url || tab.id == null || !hasAssignment(tab.url)) throw new Error('Return to the survey’s original Amazon link to retry registration.');
      await study.enroll(tab.url, tab.id);
    } else if (message.type === 'study_cart') {
      const tab = await activeStudyTab();
      await chrome.storage.local.set({ studyTabId: tab.id, currentCart: null });
      await chrome.tabs.update(tab.id!, { url: new URL(tab.url!).origin + '/gp/cart/view.html', active:true });
    } else if (message.type === 'study_refresh_cart') {
      const tab = await activeStudyTab();
      if (!isCartUrl(tab.url)) throw new Error('Click “Review my cart” first.');
      const cart = await chrome.tabs.sendMessage(tab.id!, {type:'study_read_cart'}, {frameId:0});
      if (!cart?.ok) throw new Error('Cart rows are not readable yet. Reload Amazon and try again.');
      await record('cart_snapshot', cart, tab.id!, tab.url!);
    } else if (message.type === 'study_confirm') {
      const s = await chrome.storage.local.get('taskStage');
      if (s.taskStage !== 'final') {
        if (message.confirmed !== true) throw new Error('Please confirm that this is your final study choice.');
        const tab = await activeStudyTab();
        await endDwell();
        try { await study.confirm(message.asin, tab.id!); }
        catch (e) { await beginDwell(tab.id!); throw e; }
      }
      await study.ensureFinalChoiceEvent();
      await finishSummary('confirmed');
      await study.openSurvey();
    } else if (message.type === 'study_continue') {
      await study.ensureFinalChoiceEvent();
      await finishSummary('confirmed');
      await study.openSurvey();
    } else if (message.type === 'study_stop') {
      await endDwell();
      await chrome.storage.local.set({ taskStage:'stopped', amazonLoginConfirmed:false, shoppingTaskStoppedAt:Date.now() });
      await finishSummary('participant_stopped');
    } else if (message.type === 'study_preview_p2' && backend.preview) {
      const url = message.url ? validateQualtricsUrl(String(message.url)) : '';
      await chrome.storage.local.set({ previewP2Url: url });
    } else if (message.type === 'study_preview_reset' && backend.preview) {
      // Explicit tester-only reset. No production counterpart.
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      await chrome.storage.local.set({ buildMode:'preview' });
    } else throw new Error('Unknown study action.');
    return {ok:true};
  }).then(sendResponse, e => sendResponse({ok:false,error:e instanceof Error ? e.message : String(e)}));
  return true;
});

// Qualtrics checks the installation and, before assigning a new task, looks up this browser's
// study session. Neither request changes stored state; no script injection or new host access.
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  const version = chrome.runtime.getManifest().version;
  if (message?.type === 'webmunk_ping') {
    sendResponse({ok:true,id:chrome.runtime.id,version});
    return;
  }
  if (message?.type !== 'webmunk_lookup') return;
  chrome.storage.local.get(['studyContext','taskStage','user']).then(s => {
    const result = lookupSession(s, message.prolificId);
    sendResponse(result.status === 'invalid' ? {ok:false,version,error:'Invalid participant ID.'} : {ok:true,version,...result});
  }, e => sendResponse({ok:false,version,error:String(e)}));
  return true;
});
