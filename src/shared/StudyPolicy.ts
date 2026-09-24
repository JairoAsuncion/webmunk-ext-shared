// Pure policy functions shared by the worker, content script, panel and tests.
export type Arm = 'classic' | 'chat_no_guide' | 'chat';
export type StudyContext = {
  prolificId: string; arm: Arm; category: string; budget: number;
  origin: string; sessionId: string; expiresAt: number;
};
export type CartItem = { asin: string; title: string; price?: string; brand?: string };
export const AMAZON_DOMAINS = [
  'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.nl', 'amazon.fr',
  'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.com.au', 'amazon.co.jp',
  'amazon.in', 'amazon.com.mx', 'amazon.com.br',
];
export function isAmazonUrl(raw: unknown): boolean {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'https:' && !u.username && !u.password &&
      AMAZON_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith(`.${d}`));
  } catch { return false; }
}
export function isShoppingUrl(raw: unknown): boolean {
  if (!isAmazonUrl(raw)) return false;
  const path = new URL(String(raw)).pathname;
  // Never collect account, sign-in, payment or order pages.
  return !/^\/(ap|ax|cpe|hz\/contact-us)\b/i.test(path) &&
    !/signin|sign-in|signout|sign-out|register|checkout|buy\/|your-account|your-orders|order-history|gp\/css|gp\/help|gp\/yourstore|hz\/mycd/i.test(path);
}
export function isCartUrl(raw: unknown): boolean {
  return isShoppingUrl(raw) && /\/(?:gp\/)?cart(?:\/|$)/i.test(new URL(String(raw)).pathname);
}
export function parseArm(raw: unknown): Arm | null {
  return raw === 'classic' || raw === 'chat_no_guide' || raw === 'chat' ? raw : null;
}
export const SESSION_MAX_MS = 60 * 60 * 1000; // Abandonment/privacy safety cap; not the advertised task duration.
export function parseAssignment(raw: string): Omit<StudyContext, 'sessionId' | 'expiresAt'> | null {
  if (!isShoppingUrl(raw)) return null;
  const u = new URL(raw), p = u.searchParams;
  const pid = p.get('PROLIFIC_PID') || '';
  const arm = parseArm(p.get('arm'));
  const rawCategory = (p.get('category') || '').trim();
  const normalized = rawCategory.toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').replace(/^(?:a )?new /, '');
  const budgets: Record<string, number> = { headphones: 350, backpack: 150, 'robot vacuum': 500 };
  if (!/^[a-f\d]{24}$/i.test(pid) || !arm || !budgets[normalized]) return null;
  const category = ({headphones:'Headphones', backpack:'Backpack', 'robot vacuum':'Robot Vacuum'} as Record<string,string>)[normalized];
  return { prolificId: pid.toLowerCase(), arm, category, budget: budgets[normalized], origin: u.origin };
}
export function hasAssignment(raw: string): boolean {
  try { const p = new URL(raw).searchParams; return ['PROLIFIC_PID','arm','category'].some(k => p.has(k)); }
  catch { return false; }
}
export function canTrack(state: Record<string, any>, raw: string): boolean {
  const c = state.studyContext;
  return state.taskStage === 'shopping' && state.amazonLoginConfirmed === true &&
    !!c?.sessionId && Number(c.expiresAt) > Date.now() && !!parseArm(c.arm) && state.user?.prolificId === c.prolificId &&
    state.user?.active !== false && isShoppingUrl(raw) && new URL(raw).origin === c.origin;
}
export function cleanUrl(raw: string): string {
  if (!isShoppingUrl(raw)) return '';
  const u = new URL(raw);
  // Preserve research-relevant search/filter fields, never handoff IDs/tokens.
  const p = new URLSearchParams();
  for (const key of ['k','field-keywords','rh','s','page','node']) {
    if (u.searchParams.has(key)) p.set(key, u.searchParams.get(key)!.slice(0, 500));
  }
  const query = p.toString();
  return `${u.origin}${u.pathname}${query ? `?${query}` : ''}`;
}
export function makeSurveyUrl(base: string, c: StudyContext): string {
  const u = new URL(base);
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('The final survey URL must use HTTPS.');
  for (const [k,v] of Object.entries({ PROLIFIC_PID: c.prolificId, arm: c.arm,
    category: c.category, budget: String(c.budget), session_id: c.sessionId })) u.searchParams.set(k, v);
  return u.href;
}
export function validateQualtricsUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== 'https:' || u.username || u.password ||
      !(u.hostname === 'qualtrics.com' || u.hostname.endsWith('.qualtrics.com')) ||
      !/^\/jfe\/form\/SV_[a-zA-Z0-9]+\/?$/.test(u.pathname)) {
    throw new Error('Enter the HTTPS Qualtrics respondent link containing /jfe/form/SV_ (not the editor link).');
  }
  return u.href;
}
export function validateChoice(items: CartItem[], asin: unknown): CartItem {
  if (typeof asin !== 'string' || !/^[A-Z0-9]{10}$/i.test(asin)) throw new Error('Select a product from your current cart.');
  const matches = items.filter(i => i.asin === asin && i.title?.trim());
  if (matches.length !== 1) throw new Error('Your cart changed or could not be read. Refresh the cart and select your product again.');
  return matches[0];
}
