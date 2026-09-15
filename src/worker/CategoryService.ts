const CATEGORY_STORAGE_KEY = 'uva_study_product_category';

export function getStoredCategory(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([CATEGORY_STORAGE_KEY], (result) => {
      resolve((result[CATEGORY_STORAGE_KEY] as string | undefined) ?? null);
    });
  });
}

export function persistCategory(category: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CATEGORY_STORAGE_KEY]: category }, () => resolve());
  });
}
