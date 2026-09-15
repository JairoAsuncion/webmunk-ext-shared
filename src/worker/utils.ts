import { UrlParameters } from '../enums';

// if ab(ad blocker) parameter is true, then we disable the loading of all surveys except the first one
export const isNeedToDisableSurveyLoading = async (): Promise<boolean> => {
  const personalizationConfigsResult = await chrome.storage.local.get('personalizationConfigs');
  const personalizationConfigs = personalizationConfigsResult.personalizationConfigs || {};
  const specifiedItem = personalizationConfigs[UrlParameters.AD_BLOCKER] ?? false;

  if (specifiedItem) return true;

  return false;
}

export const getActiveTabId = async (isNeedToCheckUrl?: boolean): Promise<number> => {
  const excludedUrls = ['facebook.com/ad_preferences/ad_settings/data_from_partners', 'myadcenter.google.com', 'amazon.com/adprefs'];

  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];

      if (isNeedToCheckUrl) {
        if (excludedUrls.some((url) => tab.url?.includes(url))) {
          resolve(0);
          return;
        };
      }

      if (!tab || !tab.id || tab.url?.startsWith('chrome://')) {
        resolve(0);
      } else {
        resolve(tab.id);
      }
    });
  })
};

// A stable per-installation identifier, generated once and persisted independently of Prolific
// registration. Used only to correlate control/vulnerability evidence (see EventService's
// DIAGNOSTIC_EVENTS) fired in states where no registered user exists yet - e.g. Qualtrics
// failing to hand off PROLIFIC_PID - so that evidence isn't lost just because there's no
// prolificId to attach it to. Never used as a stand-in for the real participant identifier.
export const getOrCreateInstallId = async (): Promise<string> => {
  const { installId } = await chrome.storage.local.get('installId');
  if (typeof installId === 'string' && installId) return installId;

  // crypto.randomUUID() postdates the manifest's minimum_chrome_version (88 vs 92) - fall back
  // to a manual random id on the off chance it's unavailable, rather than throwing.
  const newId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `install-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await chrome.storage.local.set({ installId: newId });
  return newId;
};

export const getTabInfo = async (): Promise<chrome.tabs.Tab> => {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];

      tab && resolve(tab);
    });
  })
}