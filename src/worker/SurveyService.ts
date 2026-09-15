import { SurveyItem } from '../types';
import { ConfigService } from './ConfigService';
import { WEBMUNK_URL, UNINSTALL_URL } from '../config';
import { NotificationService } from './NotificationService';
import { NotificationText, UrlParameters, Event } from '../enums';
import { DELAY_BETWEEN_SURVEY, DELAY_BETWEEN_FILL_OUT_NOTIFICATION, DELAY_WHILE_AD_BLOCKER } from '../config';
import { EventService } from './EventService';
import { getActiveTabId, isNeedToDisableSurveyLoading } from './utils';
import { FirebaseAppService } from './FirebaseAppService';
import { parseArm, persistArm } from './ArmService';
import { persistCategory } from './CategoryService';
import { debug } from '../utils/log';

enum events {
  SURVEY_COMPLETED = 'survey_completed',
  SURVEY_STARTED = 'survey_started',
}

// Same format Popup.ts validates on manual entry - guards the auto-registration path against
// treating an unrelated query param as a Prolific ID.
const PROLIFIC_ID_PATTERN = /^[a-fA-F0-9]{24}$/;

// How often to re-show the "please sign in to Amazon" nudge while a participant keeps
// browsing logged out - short enough to catch someone who missed it, not so short it spams
// a single browsing session.
const LOGIN_NUDGE_COOLDOWN_MS = 60_000;

// Fixed id so a new task-update notification replaces rather than stacks on any previous one,
// and so a click on it can be routed back to the right handler below.
const TASK_NOTIFICATION_ID = 'webmunk-task-notification';

// Separate fixed id for the "you're blocked, sign in" OS notification - kept distinct from
// TASK_NOTIFICATION_ID so the two never clobber each other, and so a click on this one can be
// routed to "focus the blocked tab" instead of "open a survey".
const LOGIN_BLOCK_NOTIFICATION_ID = 'webmunk-login-block-notification';

export class SurveyService {
  private surveys: SurveyItem[] = [];
  private completedSurveys: SurveyItem[] = [];
  private readonly configService: ConfigService;
  private taskStage: 'initial' | 'shopping' | 'final' | 'done' = 'initial';

  constructor(
    private readonly firebaseAppService: FirebaseAppService,
    private readonly notificationService: NotificationService,
    private readonly eventService: EventService,
  ) {
    chrome.tabs.onUpdated.addListener(this.surveyCompleteListener.bind(this));
    chrome.tabs.onRemoved.addListener((tabId: number) => {
      chrome.storage.session.remove(this.lastTabUrlKey(tabId)).catch(() => {});
    });
    chrome.notifications.onClicked.addListener(this.onTaskNotificationClicked.bind(this));
    this.configService = new ConfigService(this.firebaseAppService);
  }

  // Tracks each tab's last seen URL so we can tell "this tab just navigated away from the
  // survey it was on" apart from "the user is browsing Amazon normally". Stored in
  // chrome.storage.session (not an in-memory Map) because it must survive the background
  // service worker being restarted mid-survey — e.g. while the user is still filling out a
  // long survey — otherwise the completion redirect that wakes the worker back up would find
  // no history and fail to match, leaving taskStage stuck.
  private lastTabUrlKey(tabId: number): string {
    return `lastTabUrl_${tabId}`;
  }

  private async getLastKnownTabUrl(tabId: number): Promise<string | undefined> {
    const key = this.lastTabUrlKey(tabId);
    const result = await chrome.storage.session.get(key);
    return result[key];
  }

  private async setLastKnownTabUrl(tabId: number, url: string): Promise<void> {
    await chrome.storage.session.set({ [this.lastTabUrlKey(tabId)]: url });
  }

  public async initSurveysIfNeeded(): Promise<void> {
    debug('[wm] initSurveysIfNeeded entry');
    if (await isNeedToDisableSurveyLoading()) return;
    if (this.taskStage === 'shopping' || this.taskStage === 'done') return;

    if (this.surveys.length) {
      await this.showFillOutNotification();
      return;
    }

    const isWeekPassed = await this.isWeekPassed();
    if (!isWeekPassed) return;

    await this.loadSurveys();
  }

  private async showFillOutNotification(): Promise<void> {
    const currentDate = Date.now();
    const delayBetweenFillOutNotification = Number(DELAY_BETWEEN_FILL_OUT_NOTIFICATION);
    const { fillOutModalShowed = 0 } = await chrome.storage.local.get('fillOutModalShowed');

    if (currentDate < fillOutModalShowed + delayBetweenFillOutNotification) return;

    const tabId = await getActiveTabId(true);
    if (!tabId) return;

    try {
      await this.notificationService.showNotification(tabId, NotificationText.FILL_OUT);
      await chrome.storage.local.set({ fillOutModalShowed: currentDate });
    } catch (error) {
      console.error('Failed to show notification:', error);
    }
  }

  public async initSurveysIfExists(): Promise<void> {
    const existingSurveys = await chrome.storage.local.get(['surveys', 'taskStage']);
    this.surveys = existingSurveys.surveys || [];
    this.taskStage = existingSurveys.taskStage || 'initial';

    const existingCompletedSurveys = await chrome.storage.local.get('completedSurveys');
    this.completedSurveys = existingCompletedSurveys.completedSurveys || [];

    await this.repairStuckRegistration();

    await this.updateTaskIndicators(this.taskStage, this.surveys.length, 'init');
  }

  // Repairs participants left stuck by a since-fixed bug in the popup's manual Prolific-ID
  // fallback: their Firebase user was created (they successfully typed an ID in), but
  // registration never advanced taskStage past its 'initial' default, so cart-reached could
  // never fire and they'd be stuck shopping forever with no notification and no path to the
  // final survey. "User exists but taskStage never left 'initial'" is otherwise impossible now
  // that both registration paths call startShoppingTask() below, so it's a safe repair signal.
  private async repairStuckRegistration(): Promise<void> {
    if (this.taskStage !== 'initial') return;

    const user = await this.firebaseAppService.getUser();
    if (!user) return;

    console.warn('[wm] repairStuckRegistration: registered user stuck on taskStage=initial, advancing to shopping');
    await this.startShoppingTask('repaired_stuck');
  }

  // Transitions a freshly-registered participant into the shopping stage. Shared by all three
  // registration paths - the Qualtrics auto-redirect (tryAutoRegisterFromRedirect()), the
  // popup's manual-entry fallback (Worker.ts's handleSuccessfulRegistration()), and the
  // self-heal above - so they can't silently drift out of sync with each other again the way
  // the manual path once did. `source` is control/vulnerability evidence: a nonzero count of
  // 'manual_entry' means the Qualtrics->extension handoff needed its fallback, and any
  // 'repaired_stuck' means a participant was actually caught and recovered by that self-heal -
  // both otherwise invisible outside a live console.
  public async startShoppingTask(source: 'auto_redirect' | 'manual_entry' | 'repaired_stuck'): Promise<void> {
    this.taskStage = 'shopping';
    await chrome.storage.local.set({
      taskStage: this.taskStage,
      weekEndTime: 0,
      // The participant isn't necessarily signed into Amazon yet at this point - starting the
      // decision-latency clock now would bake login time into it. confirmAmazonLogin() stamps
      // shoppingTaskStartedAt instead, once login is actually confirmed.
      amazonLoginConfirmed: false,
      decisionTracked: false,
      decisionMadeAt: null,
      cartBaselineCaptured: false,
      cartBaselineSuppressionLogged: false,
    });

    await this.startWeekTiming();
    await this.updateTaskIndicators(this.taskStage, 0, 'shopping-start');
    await this.eventService.track(Event.REGISTRATION_COMPLETED, { source });
  }

  private async loadSurveys(): Promise<void> {
    try {
      const { user } = await chrome.storage.local.get('user');
      const prolificId = user?.prolificId;

      const jsonSurveys = await this.configService.getConfigByKey('surveys');
      debug('[wm] loadSurveys: raw surveys RC', jsonSurveys);

      if (!jsonSurveys) {
        console.warn('[wm] loadSurveys: no surveys in RC');
        return;
      }

      let surveys: SurveyItem[] = [];
      try {
        surveys = JSON.parse(jsonSurveys);
      } catch (e) {
        console.warn('[wm] loadSurveys: failed to parse surveys JSON', e);
        return;
      }

      // Registration (tryAutoRegisterFromRedirect) now jumps straight from "no user" to
      // 'shopping' - the only survey the extension itself still opens is the final one, once
      // handleCartReached() sets taskStage to 'final'. Reading the *last* RC entry (rather than
      // assuming index 0) keeps this working whether or not the now-unused leading "initial
      // survey" entry is still present in Remote Config.
      if (this.taskStage !== 'final' || !surveys.length) {
        return;
      }

      const additionalParams = await this.makeSearchParametersByAdsConfigs();
      const surveyData = surveys[surveys.length - 1];
      const separator = surveyData.url.includes('?') ? '&' : '?';
      const newSurvey: SurveyItem = {
        name: surveyData.name,
        url: `${surveyData.url}${separator}PROLIFIC_PID=${prolificId}${additionalParams || ''}`,
      };

      if (
        !this.surveys.some((survey) => survey.url === newSurvey.url) &&
        !this.completedSurveys.some((survey) => survey.url === newSurvey.url)
      ) {
        this.surveys.push(newSurvey);
      }

      await this.updateTaskIndicators(this.taskStage, this.surveys.length, 'surveys');
      await chrome.storage.local.set({ surveys: this.surveys });
      debug('[wm] loadSurveys: saved surveys', this.surveys);
    } catch (e) {
      console.warn('[wm] loadSurveys: unexpected error', e);
    }
  }

  private async saveParamsToStorage(params: Record<string, boolean | string>): Promise<void> {
    await chrome.storage.local.set({ personalizationConfigs: params });
  }

  private async makeSearchParametersByAdsConfigs(): Promise<string | undefined> {
    const specifiedItemResult = await chrome.storage.local.get('personalizationConfigs');
    const specifiedItem = specifiedItemResult.personalizationConfigs || {};

    if (!Object.keys(specifiedItem).length) return;

    const result = Object.entries(specifiedItem)
      .sort(([, valueA], [, valueB]) => {
        const isBooleanA = typeof valueA === 'boolean';
        const isBooleanB = typeof valueB === 'boolean';

        if (isBooleanA && !isBooleanB) return -1;
        if (!isBooleanA && isBooleanB) return 1;
        return 0;
      })
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    return `&${result}`;
  }

  private extractQueryParams(url: string): Record<string, boolean | string> {
    const params: Record<string, boolean | string> = {};
    const queryString = url.split('?')[1];

    if (queryString) {
      const urlParams = new URLSearchParams(queryString);

      urlParams.forEach((value, key) => {
        if (value === 'true') {
          params[key] = true;
        } else if (value === 'false') {
          params[key] = false;
        } else {
          params[key] = value;
        }
      });
    }

    return params;
  }

  private async adBlockerManipulations(url: string): Promise<void> {
    if (await isNeedToDisableSurveyLoading()) return;

    const queryParams = this.extractQueryParams(url);
    await this.saveParamsToStorage(queryParams);

    await this.startWeekTiming(true);
  }

  private async configurationManipulation(url: string): Promise<void> {
    const adPersonalizationConfiguration = [
      UrlParameters.FACEBOOK,
      UrlParameters.GOOGLE_AND_YOUTUBE,
      UrlParameters.AMAZON,
    ];

    const isAdPersonalizationConfiguration = adPersonalizationConfiguration.some((param) => url.includes(param));

    if (isAdPersonalizationConfiguration) await this.clearCheckedAdPersonalizationIfExists();
  }

  public async surveyCompleteListener(
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ): Promise<void> {
    // chrome.tabs.onUpdated fires multiple times per navigation ('loading' then 'complete').
    // Only record the "settled" URL once a navigation actually completes — otherwise the
    // 'loading' event for THIS SAME navigation would overwrite the record before the paired
    // 'complete' event (the one we act on) gets to compare against the tab's true prior page.
    const previousUrl = await this.getLastKnownTabUrl(tabId);
    if (changeInfo.status === 'complete' && tab.url) {
      await this.setLastKnownTabUrl(tabId, tab.url);
    }

    const user = await this.firebaseAppService.getUser();

    if (!user) {
      // No stored user yet - this may be the Qualtrics initial-survey redirect carrying a
      // freshly-issued PROLIFIC_PID, landing directly on Amazon (same mechanism `arm` already
      // uses). If it matches, this registers the participant and starts shopping right away
      // without ever going through the popup's manual-entry form.
      await this.tryAutoRegisterFromRedirect(changeInfo, tab, previousUrl);
      return;
    }

    // The service worker may have just been woken (and this instance freshly constructed) by
    // the very navigation event that triggered this listener, in which case taskStage/surveys
    // still hold their class defaults rather than the persisted state. Resync before acting.
    await this.initSurveysIfExists();

    if (!WEBMUNK_URL) return;
    const baseUrl = new URL(WEBMUNK_URL).origin;

    if (!tab.url) {
      return;
    }

    // Only treat "landed back on Amazon" as a survey completion if this exact tab was just on
    // a pending survey's domain (e.g. Qualtrics) — otherwise every ordinary Amazon page load
    // during shopping would falsely look like the pending (e.g. final) survey was completed.
    const wasOnPendingSurveyDomain = this.wasPreviouslyOnSurveyDomain(previousUrl);
    const isCompletionUrl = tab.url.startsWith(baseUrl) || (wasOnPendingSurveyDomain && this.isAmazonCompletion(tab.url));

    if (changeInfo.status === 'complete') {
      debug('[wm] surveyCompleteListener check', {
        tabId,
        url: tab.url,
        previousUrl,
        wasOnPendingSurveyDomain,
        isCompletionUrl,
        taskStage: this.taskStage,
        pendingSurveys: this.surveys,
      });
    }

    if (changeInfo.status !== 'complete' || !isCompletionUrl) {
      return;
    }

    if (tab.url?.startsWith(`${WEBMUNK_URL}?${UrlParameters.AD_BLOCKER}`)) {
      await this.adBlockerManipulations(tab.url);
      return;
    }

    // openerTabId can reference a tab the user has since closed (very plausible after several
    // minutes filling out a survey) — chrome.tabs.get/remove reject in that case, and since
    // nothing here was previously guarded, that exception used to abort the rest of this
    // function, silently skipping the completion logic below.
    const openerTabId = tab.openerTabId;
    let openerTabUrl: string | undefined;
    if (openerTabId) {
      try {
        openerTabUrl = (await chrome.tabs.get(openerTabId)).url;
      } catch {
        openerTabUrl = undefined;
      }
    }

    const matchedSurvey = this.surveys.find((survey) => openerTabUrl === survey.url) || this.surveys[0];

    debug('[wm] surveyCompleteListener matching', { openerTabId, openerTabUrl, matchedSurvey });

    if (matchedSurvey) {
      const queryParams = this.extractQueryParams(tab.url!);
      await this.saveParamsToStorage(queryParams);

      // Qualtrics randomizes the arm in the initial survey's Survey Flow and passes it back
      // as an embedded-data field on the End-of-Survey redirect URL, same mechanism as `stage`.
      const arm = parseArm(queryParams[UrlParameters.ARM]);
      if (arm) await persistArm(arm);

      if (openerTabId) {
        try {
          await chrome.tabs.remove(openerTabId);
        } catch {
          // opener tab already closed — not fatal, still mark the survey complete below
        }
      }

      if (!this.completedSurveys.some((completedSurvey) => completedSurvey.url === matchedSurvey.url)) {
        this.completedSurveys.push(matchedSurvey);
      }

      this.surveys = this.surveys.filter((survey) => survey.url !== matchedSurvey.url);

      // Registration (and the 'shopping' transition) now happens in tryAutoRegisterFromRedirect,
      // off the Qualtrics initial-survey redirect - this listener only ever tracks completion of
      // the one remaining survey the extension itself opens (the final survey), so it always
      // finishes the study rather than needing to branch on "which survey was this".
      this.taskStage = 'done';
      await chrome.storage.local.set({ taskStage: this.taskStage });

      await chrome.storage.local.set({ surveys: this.surveys, completedSurveys: this.completedSurveys });
      await this.configurationManipulation(tab.url);

      await this.startWeekTiming();
      await this.eventService.track(events.SURVEY_COMPLETED, { surveyUrl: matchedSurvey.url });
      await this.updateTaskIndicators(this.taskStage, this.surveys.length, 'completion');

      // attempt to load the next survey immediately
      await this.initSurveysIfNeeded();
    }
  }

  // Handles the Qualtrics initial-survey End-of-Survey redirect for a participant who has no
  // stored user yet: it lands directly on Amazon carrying PROLIFIC_PID (and arm) as query
  // params, the same mechanism the arm randomizer already round-trips. Registers the
  // participant via the same signIn path Popup.ts's manual entry uses, then jumps straight to
  // 'shopping' - there's no "initial survey" left for the extension itself to track, since
  // Qualtrics was the entry point this time, not the popup.
  private async tryAutoRegisterFromRedirect(
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
    previousUrl: string | undefined,
  ): Promise<void> {
    if (changeInfo.status !== 'complete' || !tab.url) return;
    if (!this.isAmazonCompletion(tab.url)) return;
    if (!this.wasPreviouslyOnQualtrics(previousUrl)) return;

    const queryParams = this.extractQueryParams(tab.url);
    const prolificId = queryParams[UrlParameters.PROLIFIC_ID];

    if (typeof prolificId !== 'string' || !PROLIFIC_ID_PATTERN.test(prolificId)) {
      // The one scenario this whole codepath exists to catch: Qualtrics landed the participant
      // on Amazon right after its initial survey (confirmed by wasPreviouslyOnQualtrics above)
      // but didn't hand off a usable PROLIFIC_PID - a misconfigured embedded-data field, not a
      // participant error. Deliberately not logging the raw param value (could be anything a
      // misconfigured field leaked); just enough to know it happened and roughly how.
      await this.eventService.track(Event.AUTO_REGISTRATION_FAILED, {
        had_param: prolificId !== undefined,
        param_length: typeof prolificId === 'string' ? prolificId.length : null,
        redirect_url: tab.url,
      });
      return;
    }

    debug('[wm] tryAutoRegisterFromRedirect: registering participant from Qualtrics redirect');

    try {
      const user = await this.firebaseAppService.login(prolificId);
      if (!user) return;

      const arm = parseArm(queryParams[UrlParameters.ARM]);
      if (arm) await persistArm(arm);

      const category = queryParams[UrlParameters.PRODUCT_CATEGORY];
      if (typeof category === 'string' && category) await persistCategory(category);

      if (UNINSTALL_URL) {
        chrome.runtime.setUninstallURL(`${UNINSTALL_URL}?key=webmunk&userId=${prolificId}`);
      }

      await this.startShoppingTask('auto_redirect');
      await this.eventService.track(events.SURVEY_COMPLETED, { surveyUrl: tab.url });
    } catch (e) {
      // Most likely a duplicate Prolific ID (e.g. this redirect firing twice, or a Firestore
      // doc already existing without a local user record) - not auto-recoverable here. The
      // popup's manual-entry fallback is the recovery path for a participant stuck like this.
      console.warn('[wm] tryAutoRegisterFromRedirect: registration failed', e);
    }
  }

  // Called (via Worker.ts's message listener) whenever a content script observes the
  // participant is signed into Amazon. Idempotent - only the first confirmation stamps
  // shoppingTaskStartedAt, which anchors decision-latency measurement; a participant already
  // signed in before the study (common) gets this stamped on their very first Amazon page load.
  public async confirmAmazonLogin(): Promise<void> {
    const { amazonLoginConfirmed } = await chrome.storage.local.get('amazonLoginConfirmed');
    debug('[wm] confirmAmazonLogin entry', { alreadyConfirmed: Boolean(amazonLoginConfirmed) });
    if (amazonLoginConfirmed) return;

    await chrome.storage.local.set({
      amazonLoginConfirmed: true,
      shoppingTaskStartedAt: Date.now(),
    });
    debug('[wm] confirmAmazonLogin: amazonLoginConfirmed set to true');

    // Clear whatever "you need to sign in" signal notifyLoginRequiredBlocking() left behind -
    // otherwise a stale OS notification/tooltip could linger after the participant has already
    // fixed the problem.
    chrome.notifications.clear(LOGIN_BLOCK_NOTIFICATION_ID);
    await chrome.action.setTitle({ title: '' });

    await this.eventService.track(Event.AMAZON_LOGIN_CONFIRMED, {});
  }

  // Shared cooldown-throttled display for both flavors of the "please sign in" notice below,
  // so a participant bouncing between ordinary browsing and reaching /cart while logged out
  // doesn't get double-spammed within the same window.
  private async showLoginNotice(tabId: number | undefined, text: string): Promise<void> {
    if (!tabId) return;

    const { lastLoginNudgeShownAt = 0 } = await chrome.storage.local.get('lastLoginNudgeShownAt');
    const now = Date.now();
    if (now - lastLoginNudgeShownAt < LOGIN_NUDGE_COOLDOWN_MS) return;

    try {
      await this.notificationService.showNotification(tabId, text);
      await chrome.storage.local.set({ lastLoginNudgeShownAt: now });
    } catch (error) {
      console.warn('[wm] failed to show Amazon login notice', error);
    }
  }

  // Called (via Worker.ts's message listener) whenever a content script observes the
  // participant is NOT signed into Amazon yet. Cooldown-throttled like showFillOutNotification,
  // since this can fire on every page load while the participant browses logged out.
  public async maybeShowLoginNudge(tabId: number | undefined): Promise<void> {
    const { amazonLoginConfirmed, taskStage } = await chrome.storage.local.get(['amazonLoginConfirmed', 'taskStage']);
    if (amazonLoginConfirmed) return;

    // Once the shopping task has actually started, Content.ts's enforceLoginRequirement()
    // already shows the hard, non-dismissible full-page block on the page itself - but that's
    // only visible if the participant is actually looking at this tab. Fire an OS-level
    // notification too, so someone who alt-tabbed away or has the tab in the background still
    // gets pinged, instead of the study silently stalling with no signal anywhere.
    if (taskStage === 'shopping') {
      await this.notifyLoginRequiredBlocking(tabId);
      return;
    }

    await this.showLoginNotice(tabId, NotificationText.AMAZON_LOGIN);
  }

  // Called from handleCartReached() when a participant reaches /cart without a confirmed
  // Amazon login. Alexa for Shopping (the chat arm) requires being signed in, so a logged-out
  // cart visit can't represent a genuinely completed shopping task either way - rather than
  // silently doing nothing (the exact class of dead-end the original participant feedback
  // flagged), this tells them explicitly what's blocking them and how to unblock it.
  private async notifyLoginRequiredAtCart(tabId: number | undefined): Promise<void> {
    // Evidence the gate actually engaged - tracked unconditionally (not cooldown-throttled like
    // the notice itself), so repeated cart visits while still logged out are all visible for
    // measuring how long a participant stayed blocked before signing in.
    await this.eventService.track(Event.AMAZON_LOGIN_BLOCKED_AT_CART, {});
    await this.showLoginNotice(tabId, NotificationText.AMAZON_LOGIN_REQUIRED_AT_CART);
  }

  // OS-level counterpart to Content.ts's on-page login-required block - reaches the participant
  // even when the blocked tab isn't the one they're currently looking at. requireInteraction
  // keeps it visible until they act on it rather than auto-dismissing after a few seconds, and
  // the badge title change gives a second, passive cue visible just from glancing at the
  // toolbar. Cooldown-throttled the same way as the dismissible nudge, sharing its timestamp so
  // the two flavors of this notice don't stack within the same window.
  private async notifyLoginRequiredBlocking(tabId: number | undefined): Promise<void> {
    if (!tabId) return;

    const { lastLoginNudgeShownAt = 0 } = await chrome.storage.local.get('lastLoginNudgeShownAt');
    const now = Date.now();
    if (now - lastLoginNudgeShownAt < LOGIN_NUDGE_COOLDOWN_MS) return;

    try {
      await chrome.notifications.create(LOGIN_BLOCK_NOTIFICATION_ID, {
        type: 'basic',
        iconUrl: 'images/UvA.png',
        title: 'Sign-in required',
        message: "You're on Amazon but not signed in - the shopping task is paused until you sign in. Click here to go back to that tab.",
        requireInteraction: true,
      });
      await chrome.action.setTitle({ title: 'Sign in to Amazon to continue the study' });
      await chrome.storage.local.set({ lastLoginNudgeShownAt: now, lastLoginBlockTabId: tabId });
    } catch (error) {
      console.warn('[wm] failed to show login-required notification', error);
    }
  }

  // Brings the blocked tab back into view when the participant clicks the OS notification
  // above, rather than just clearing the notification and leaving them to hunt for the tab.
  private async focusLoginBlockedTab(): Promise<void> {
    const { lastLoginBlockTabId } = await chrome.storage.local.get('lastLoginBlockTabId');
    if (typeof lastLoginBlockTabId !== 'number') return;

    try {
      const tab = await chrome.tabs.get(lastLoginBlockTabId);
      await chrome.tabs.update(lastLoginBlockTabId, { active: true });
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch {
      // tab no longer exists (closed since) - nothing to focus
    }
  }

  private async clearCheckedAdPersonalizationIfExists(): Promise<void> {
    const checkedAdPersonalizationResult = await chrome.storage.local.get('adPersonalization.checkedItems');
    const checkedAdPersonalization = checkedAdPersonalizationResult['adPersonalization.checkedItems'] || {};

    if (!Object.keys(checkedAdPersonalization).length) return;

    await chrome.storage.local.set({ 'adPersonalization.checkedItems': {} });
    await chrome.storage.local.set({ personalizationTime: 0 });
  }

  public async startWeekTiming(isAdBlockSituation?: boolean): Promise<void> {
    const currentDate = Date.now();
    let delay: number;

    if (isAdBlockSituation) {
      delay = Number(DELAY_WHILE_AD_BLOCKER);
    } else {
      const rcDelay = await this.configService.getConfigByKey('delay_between_survey');
      const parsedDelay = Number(rcDelay ?? DELAY_BETWEEN_SURVEY);
      delay = Number.isFinite(parsedDelay) ? parsedDelay : 0;
    }

    const endTime = currentDate + delay;

    await chrome.storage.local.set({ weekEndTime: endTime });
  }

  /**
   * Update action badge and optionally show a notification when tasks change.
   * Signal helps dedupe repeated notifications for the same state.
   */
  private async updateTaskIndicators(taskStage: string, pendingSurveys: number, signal: string): Promise<void> {
    const badgeText = pendingSurveys > 0 ? String(pendingSurveys) : taskStage === 'shopping' ? '!' : '';

    await chrome.action.setBadgeText({ text: badgeText });
    if (badgeText) {
      await chrome.action.setBadgeBackgroundColor({ color: '#a41b33' });
      await chrome.action.setTitle({ title: 'New study task available' });
    } else {
      await chrome.action.setTitle({ title: '' });
    }

    const key = `${signal}:${taskStage}:${badgeText || 'none'}`;
    const stored = await chrome.storage.local.get('lastTaskIndicator');
    if (stored.lastTaskIndicator === key) return;

    const title = 'Study task update';
    const message =
      pendingSurveys > 0
        ? taskStage === 'final'
          ? "You're almost done! Click here to open the final survey."
          : 'New survey task available. Click here to open it.'
        : taskStage === 'shopping'
          ? 'Shopping task ready—please continue on Amazon.'
          : '';

    if (message) {
      try {
        // Fixed id (rather than an auto-generated one) so onTaskNotificationClicked below can
        // recognize and act on a click; requireInteraction keeps it on screen instead of
        // auto-dismissing after a few seconds, since missing this one leaves the participant
        // with no other cue that the final survey is ready.
        await chrome.notifications.create(TASK_NOTIFICATION_ID, {
          type: 'basic',
          iconUrl: 'images/UvA.png',
          title,
          message,
          requireInteraction: pendingSurveys > 0,
        });
      } catch (err) {
        console.warn('[wm] failed to show notification', err);
      }
    }

    await chrome.storage.local.set({ lastTaskIndicator: key });
  }

  // Clicking the task-update notification should take the participant straight to whatever
  // it was announcing, rather than leaving them to go find the popup themselves - the exact
  // gap that let a participant get stuck at checkout with no obvious next step.
  private async onTaskNotificationClicked(notificationId: string): Promise<void> {
    if (notificationId === LOGIN_BLOCK_NOTIFICATION_ID) {
      chrome.notifications.clear(notificationId);
      await this.focusLoginBlockedTab();
      return;
    }

    if (notificationId !== TASK_NOTIFICATION_ID) return;

    chrome.notifications.clear(notificationId);
    await this.initSurveysIfExists();

    const survey = this.surveys[0];
    if (survey) {
      chrome.tabs.create({ url: survey.url });
    } else if (this.taskStage === 'shopping') {
      chrome.tabs.create({ url: 'https://www.amazon.com' });
    }
  }

  public async isWeekPassed(): Promise<boolean> {
    const { weekEndTime } = await chrome.storage.local.get('weekEndTime');
    const currentTime = Date.now();

    return currentTime >= weekEndTime;
  }

  public async isThisSurveyUrl(url: URL): Promise<void> {
    if (!this.surveys.some((survey) => survey.url === url.href)) return;

    await this.recordCookiesIfNeeded();
    await this.eventService.track(events.SURVEY_STARTED, { surveyUrl: url.href });
  }

  public async recordCookiesIfNeeded(): Promise<void> {
    if (!this.completedSurveys.length) return;

    const tabId = await getActiveTabId();
    if (!tabId) return;

    await chrome.tabs.sendMessage(tabId, { action: 'webmunkExt.worker.notifyCookiesModule' }, { frameId: 0 });
  }

  // Fires immediately on /cart navigation (webNavigation.onCommitted, URL-based - no
  // dependency on any cart-content selector, so it stays reliable even if Amazon's cart
  // markup changes). Only responsible for the "you need to sign in" nudge now - it no
  // longer advances taskStage itself. See handleCartHasItem() for that: whether the cart
  // actually has anything in it is only known once the content script's cart_snapshot
  // lands, which can be a beat after this navigation event.
  public async handleCartReached(tabId: number | undefined): Promise<void> {
    // Cart-reached navigation can itself be what wakes a terminated MV3 service worker, in
    // which case this instance's taskStage/surveys are still class defaults rather than the
    // persisted state. Resync before deciding whether to act.
    await this.initSurveysIfExists();

    if (this.taskStage !== 'shopping') return;

    // Hard gate: both registration (taskStage === 'shopping', checked above) and a confirmed
    // Amazon login are required - Alexa for Shopping can't be used signed out, so a
    // logged-out cart visit isn't a real completed shopping task for either arm. Blocked rather
    // than silently ignored, since a silent no-op here is exactly the dead-end the original
    // participant feedback described (reached cart, nothing happened, no idea why).
    const { amazonLoginConfirmed } = await chrome.storage.local.get('amazonLoginConfirmed');
    if (!amazonLoginConfirmed) {
      await this.notifyLoginRequiredAtCart(tabId);
    }
  }

  // Called from Worker.ts when a cart_snapshot event reports at least one item while the
  // shopping task is active. This - not the /cart navigation itself - is what actually
  // advances to the final survey, so a participant who merely visits an empty cart (never
  // added anything) can't complete the shopping task with nothing chosen.
  public async handleCartHasItem(tabId: number | undefined): Promise<void> {
    await this.initSurveysIfExists();

    if (this.taskStage !== 'shopping') return;

    const { amazonLoginConfirmed } = await chrome.storage.local.get('amazonLoginConfirmed');
    if (!amazonLoginConfirmed) {
      // Not signed in yet - handleCartReached() above already surfaces that nudge from the
      // navigation event; nothing more to do here until they sign in and revisit /cart.
      return;
    }

    this.taskStage = 'final';
    await chrome.storage.local.set({ taskStage: this.taskStage, weekEndTime: 0 });

    await this.initSurveysIfNeeded();
  }

  // Unlike wasPreviouslyOnSurveyDomain (which matches against this.surveys), an unregistered
  // participant has no pending surveys to compare against - the extension never opened the
  // Qualtrics initial survey itself, Qualtrics was the entry point. Origin-check against
  // qualtrics.com directly instead.
  private wasPreviouslyOnQualtrics(previousUrl: string | undefined): boolean {
    if (!previousUrl) return false;

    try {
      return new URL(previousUrl).hostname.includes('qualtrics.com');
    } catch {
      return false;
    }
  }

  private wasPreviouslyOnSurveyDomain(previousUrl: string | undefined): boolean {
    if (!previousUrl) return false;

    try {
      const previousOrigin = new URL(previousUrl).origin;
      return this.surveys.some((survey) => {
        try {
          return new URL(survey.url).origin === previousOrigin;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  private isAmazonCompletion(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname.includes('amazon.');
    } catch {
      return false;
    }
  }
}
