import { Backend } from './Backend';
import { hasAssignment, parseAssignment, makeSurveyUrl, validateChoice, isCartUrl, isShoppingUrl, SESSION_MAX_MS, validateQualtricsUrl } from '../shared/StudyPolicy';
import type { StudyContext, CartItem } from '../shared/StudyPolicy';
import { FINAL_SURVEY_URL } from '../shared/StudyConfig';

export class StudyService {
  // onStopped lets the worker close the session (session_summary) when enrolment stops it.
  constructor(private backend: Backend, private onStopped: (reason: string) => Promise<void> = async () => {}) {}

  async enroll(url: string, tabId: number): Promise<void> {
    if (!isShoppingUrl(url) || !hasAssignment(url)) return;
    let assignment = parseAssignment(url);
    const s = await chrome.storage.local.get(null);
    if (!assignment) {
      // Invalid handoffs never become a default chat condition or reuse an old assignment.
      if (s.taskStage !== 'final' && s.taskStage !== 'stopped') {
        await chrome.storage.local.set({ taskStage: 'initial', amazonLoginConfirmed: false,
          studyError: 'Study details are missing or invalid. Return to the study survey and use its Amazon link again.' });
      }
      return;
    }
    const old = s.studyContext as StudyContext | undefined;
    if (s.user && !old) {
      await chrome.storage.local.set({ taskStage:'stopped', amazonLoginConfirmed:false,
        studyError:'This installation has a registration from an older study session. Contact the researcher before continuing.' });
      return;
    }
    if (old && old.prolificId !== assignment.prolificId) {
      await this.stop(s, 'different_participant',
        'This browser already has a different study session. Do not continue; contact the researcher.');
      return;
    }
    if (old && (old.arm !== assignment.arm || old.origin !== assignment.origin ||
        old.category.toLowerCase() !== assignment.category.toLowerCase())) {
      // Re-taking the intake survey re-randomizes the assignment. The first assignment
      // stays authoritative; the offered one is logged (once per distinct offer - one link
      // reaches enrolment several times while its page loads) so affected sessions can be flagged.
      const offer = [assignment.arm, assignment.category, assignment.origin].join('|');
      const ignored: string[] = s.ignoredHandoffs || [];
      if (!ignored.includes(offer)) {
        await chrome.storage.local.set({ ignoredHandoffs: [...ignored, offer] });
        await this.backend.track('repeat_handoff_ignored', { offered_arm: assignment.arm,
          offered_category: assignment.category, offered_budget: assignment.budget, offered_origin: assignment.origin });
      }
      await chrome.storage.local.set({ studyNotice: 'You are already taking part in this study, so the new survey ' +
        `link was ignored. Your task has not changed: ${old.category}, budget $${old.budget}. Please continue with it.` });
      assignment = { prolificId: old.prolificId, arm: old.arm, category: old.category, budget: old.budget, origin: old.origin };
    }
    if (s.user?.prolificId && s.user.prolificId !== assignment.prolificId) {
      await this.stop(s, 'different_participant',
        'The participant ID does not match this browser’s registration. Contact the researcher.');
      return;
    }
    if (old && ['shopping','final','done','stopped'].includes(s.taskStage)) return;
    const context: StudyContext = { ...assignment, sessionId: old?.sessionId || crypto.randomUUID(),
      expiresAt: old?.expiresAt || Date.now() + SESSION_MAX_MS };
    // Persist assignment BEFORE contacting Firebase, so document-start observers cannot
    // miss the classic assignment. Content listens for changes, not a one-shot get_arm.
    await chrome.storage.local.set({ studyContext: context, studyTabId: tabId,
      uva_study_arm: context.arm, uva_study_product_category: context.category,
      taskStage: 'registering', amazonLoginConfirmed: false, studyError: '',
      buildMode: this.backend.preview ? 'preview' : 'production' });
    try {
      const user = s.user || await this.backend.register(context.prolificId);
      if (!user || user.prolificId !== context.prolificId || user.active === false) {
        throw new Error('Registration is unavailable for this participant. Contact the researcher.');
      }
      // The server session ID remains canonical when supplied (existing dataset joins).
      context.sessionId = user.sessionUid || context.sessionId;
      await chrome.storage.local.set({ user, studyContext: context, taskStage: 'shopping',
        shoppingTaskStartedAt: null, shoppingTaskStoppedAt: null, finalChoice: null, finalChoiceEventQueued: false,
        surveyOpenedAt: null, surveyTabId: null, panelCloseStatus: null,
        decisionTracked: false, decisionMadeAt: null, cartBaselineCaptured: false,
        cartBaselineSuppressionLogged: false, currentCart: null, surveys: [], studySummary: {},
        addedAsins: [], summarySent: false, studyError: '', registrationCompletedAt: Date.now() });
      await this.backend.track('registration_completed', { source: 'amazon_handoff' });
    } catch (e) {
      await chrome.storage.local.set({ taskStage: 'initial', amazonLoginConfirmed: false,
        studyError: e instanceof Error ? e.message : 'Registration failed. Check your connection and retry.' });
    }
  }

  private async stop(s: Record<string, any>, reason: string, studyError: string): Promise<void> {
    const wasShopping = s.taskStage === 'shopping';
    await chrome.storage.local.set({ taskStage: 'stopped', amazonLoginConfirmed: false, studyError,
      ...(wasShopping ? { shoppingTaskStoppedAt: Date.now() } : {}) });
    await this.onStopped(reason);
  }

  async login(loggedIn: boolean): Promise<void> {
    const s = await chrome.storage.local.get(['taskStage','amazonLoginConfirmed','shoppingTaskStartedAt']);
    if (s.taskStage !== 'shopping' || s.amazonLoginConfirmed === loggedIn) return;
    await chrome.storage.local.set({ amazonLoginConfirmed: loggedIn,
      ...(loggedIn ? { shoppingTaskStartedAt: s.shoppingTaskStartedAt || Date.now() } : {}) });
    // Only the first confirmation marks the task start; later re-confirmations are not events.
    if (loggedIn && !s.shoppingTaskStartedAt) await this.backend.track('amazon_login_confirmed', {});
  }

  async confirm(asin: string, tabId: number): Promise<void> {
    const s = await chrome.storage.local.get(null);
    if (s.taskStage === 'final' && s.finalChoice) { await this.ensureFinalChoiceEvent(); return; }
    if (s.taskStage !== 'shopping' || !s.amazonLoginConfirmed || !s.studyContext || s.studyContext.expiresAt <= Date.now()) {
      throw new Error('The shopping task must be active and you must be signed into Amazon.');
    }
    const tab = await chrome.tabs.get(tabId);
    if (!isCartUrl(tab.url) || new URL(tab.url!).origin !== s.studyContext.origin) {
      throw new Error('Open your Amazon cart in the study tab first.');
    }
    // Re-read the LIVE cart, not a stale panel list or the header item count.
    const cart = await chrome.tabs.sendMessage(tabId, { type: 'study_read_cart' }, { frameId: 0 });
    if (!cart?.ok || cart.loggedIn !== true) throw new Error('Your cart could not be verified. Sign in and refresh the cart.');
    const selected = validateChoice(cart.items as CartItem[], asin);
    const now = Date.now();
    // Stop collection locally before any network work or P2 navigation. No dependency
    // on a Qualtrics callback, and no silent auto-completion of pre-existing carts.
    const choice = { ...selected, confirmedAt: now, source: 'explicit_panel_confirmation',
      add_click_observed: (s.addedAsins || []).includes(asin),
      selection_latency_ms: s.shoppingTaskStartedAt ? now - s.shoppingTaskStartedAt : null };
    await chrome.storage.local.set({ taskStage: 'final', amazonLoginConfirmed: false,
      shoppingTaskStoppedAt: now, finalChoice: choice, studyTabId: tabId, studyError: '' });
    await this.ensureFinalChoiceEvent();
  }

  async ensureFinalChoiceEvent(): Promise<void> {
    const s = await chrome.storage.local.get(['finalChoice','finalChoiceEventQueued','taskStage']);
    if (s.taskStage !== 'final' || !s.finalChoice || s.finalChoiceEventQueued) return;
    await this.backend.track('final_choice_confirmed', s.finalChoice);
    await chrome.storage.local.set({ finalChoiceEventQueued: true });
  }

  async openSurvey(): Promise<void> {
    const s = await chrome.storage.local.get(null);
    if (s.taskStage !== 'final' || !s.finalChoice) throw new Error('Confirm your chosen product first.');
    if (s.surveyOpenedAt) return;
    await this.ensureFinalChoiceEvent();
    if (this.backend.preview) {
      await chrome.storage.local.set({ previewSurveyReady: true });
      // The researcher authorized this P2 link. Empty override disables navigation.
      const base = s.previewP2Url ?? FINAL_SURVEY_URL;
      if (base) {
        const url = new URL(makeSurveyUrl(validateQualtricsUrl(base), s.studyContext));
        url.searchParams.set('webmunk_test', '1');
        await this.navigateToSurvey(url.href, s.studyTabId);
      }
      return;
    }
    const url = makeSurveyUrl(await this.backend.surveyUrl(), s.studyContext);
    await chrome.storage.local.set({ surveys: [{ name: 'Follow-up survey', url }] });
    // New tab avoids overwriting any unrelated page the participant switched to.
    // A failed/repeated click can reopen P2 without restarting shopping telemetry.
    await this.navigateToSurvey(url, s.studyTabId);
  }

  private async navigateToSurvey(url: string, studyTabId?: number): Promise<void> {
    const source = studyTabId == null ? null : await chrome.tabs.get(studyTabId).catch(() => null);
    const tab = await chrome.tabs.create({ url, active: true,
      ...(source?.windowId != null ? {windowId: source.windowId} : {}) });
    // Mark successful navigation before closing the panel. Failed navigation keeps
    // the retry button; unsupported/failed close leaves only the completion message.
    await chrome.storage.local.set({ surveyOpenedAt: Date.now(), surveyTabId: tab.id });
    const panel = chrome.sidePanel as typeof chrome.sidePanel & {
      close?: (options: {windowId: number}) => Promise<void>;
    };
    const windowId = tab.windowId ?? source?.windowId;
    if (typeof panel.close !== 'function' || windowId == null) {
      await chrome.storage.local.set({panelCloseStatus:'unavailable'});
      return;
    }
    try {
      await panel.close({windowId});
      await chrome.storage.local.set({panelCloseStatus:'closed'});
    } catch {
      // Closing the panel is best-effort and must never undo completion or P2.
      await chrome.storage.local.set({panelCloseStatus:'failed'});
    }
  }
}
