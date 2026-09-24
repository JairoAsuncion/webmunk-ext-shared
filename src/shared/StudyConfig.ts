// Preview-build fallback only. Production builds resolve the final survey URL from
// Firebase Remote Config's `surveys` entry instead (see Backend.ts's surveyUrl()),
// so the URL can be updated from the Firebase console without a new Store review.
// The preview build injects it from PREVIEW_P2_URL (see scripts/build-preview.mjs);
// when empty, a preview completion stays local and opens no survey.
export const FINAL_SURVEY_URL: string = (globalThis as any).__WEBMUNK_PREVIEW_P2_URL__ || '';
