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
// ASIN of a product detail page URL (absolute or relative): /dp/, /gp/product/ or /gp/aw/d/.
export function productAsin(raw: unknown): string | null {
  const m = String(raw ?? '').split(/[?#]/)[0].match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$)/i);
  return m ? m[1].toUpperCase() : null;
}
// Assistant product cards link nowhere; their ASIN appears only in the card button's action ID,
// e.g. "asin_cards_B0FDDBGSR5_open_url_3_1". "asin_cards_oam_sd_..." are offers from other
// shops ("Available from the Web", "Shop direct"), which cannot be added to the Amazon cart.
// "asin_cards_tbl_..." are rows of a comparison table; Amazon has been seen giving every row of
// a table the first row's ID (capture C3), so callers accept those only via tableCardAsins().
export function assistantCardAsin(actionId: unknown): { asin: string; external: boolean; table: boolean } | null {
  const m = /^asin_cards_(?:(oam_[a-z]+_)|(tbl_))?([A-Z0-9]{10})_/i.exec(String(actionId ?? ''));
  return m ? { asin: m[3].toUpperCase(), external: !!m[1], table: !!m[2] } : null;
}
// Table row ASINs in row order (null for rows without a button, i.e. without a price), or null
// for the whole table when two rows carry the same ID.
export function tableCardAsins(rowActionIds: unknown[]): Array<string | null> | null {
  const asins = rowActionIds.map((id) => assistantCardAsin(id)?.asin ?? null);
  const present = asins.filter(Boolean);
  if (!present.length || new Set(present).size !== present.length) return null;
  return asins;
}
// An assistant control's action attribute is Amazon's full action JSON (~500 bytes). Keep only
// its type, and whether the control asks one of the assistant's ready-made questions (these
// pills are nested twice: a DISMISS wrapper and the INVOKE action, both "related_questions").
export function assistantAction(raw: unknown): { type: string | null; suggestedQuestion: boolean; query: string | null } {
  const s = String(raw ?? '');
  let type: string | null = null, query: string | null = null;
  try {
    const parsed = JSON.parse(s);
    type = typeof parsed?.action?.actionType === 'string' ? parsed.action.actionType : null;
    const q = parsed?.query ?? parsed?.action?.payload?.query;
    query = typeof q === 'string' && q.trim() ? q.trim() : null;
  } catch {
    type = s && s.length <= 64 ? s : null;
  }
  return { type, suggestedQuestion: /RelatedQuestionsPayload|related_questions/.test(s), query };
}
// The assistant panel re-renders earlier conversations (from other pages, or from before the
// study) without the participant asking anything. A question text counts as asked only when a
// submit action (Enter in the panel, its send button, a ready-made question) preceded it.
// Submits carry the submitted text and are matched to question texts by it: the old
// conversation can finish rendering after the submit (T7 re-run), so order alone misleads.
// Only a submit whose text could not be read pairs by order, with the newest remaining text.
export type AssistantSubmit = { at: number; via: 'typed' | 'suggested'; text?: string };
export const ASSISTANT_SUBMIT_WINDOW_MS = 60000;
const sameQuestion = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
export function classifyAssistantQueries(fresh: string[], submits: AssistantSubmit[], now: number):
  { queries: Array<{ text: string; via: 'typed' | 'suggested' | 'history' }>; remaining: AssistantSubmit[] } {
  const live = submits.filter((s) => now - s.at <= ASSISTANT_SUBMIT_WINDOW_MS).sort((a, b) => a.at - b.at);
  const via: Array<'typed' | 'suggested' | 'history'> = fresh.map(() => 'history');
  const used = new Set<AssistantSubmit>();
  fresh.forEach((text, i) => {
    const s = live.find((x) => !used.has(x) && x.text && sameQuestion(x.text, text));
    if (s) { used.add(s); via[i] = s.via; }
  });
  const textless = live.filter((x) => !x.text);
  for (let i = fresh.length - 1; i >= 0 && textless.length; i--) {
    if (via[i] !== 'history') continue;
    const s = textless.shift()!;
    used.add(s); via[i] = s.via;
  }
  return { queries: fresh.map((text, i) => ({ text, via: via[i] })), remaining: live.filter((x) => !used.has(x)) };
}
// Every assistant snapshot repeats the whole conversation, re-rendered on each page. Turns are
// identified by their content (Amazon renumbers turn IDs per page); only new or changed ones
// need recording. FNV-1a, 32 bit: collisions are irrelevant at a few dozen turns per session.
export function assistantTurnKey(turn: unknown): string {
  const s = JSON.stringify((turn as any)?.blocks ?? turn ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0') + ':' + s.length;
}
export function newAssistantTurns(turns: unknown, known: string[]): { turns: any[]; keys: string[]; omitted: number } {
  const list = Array.isArray(turns) ? turns : [];
  const seen = new Set(known), keys: string[] = [], fresh: any[] = [];
  for (const t of list) {
    const key = assistantTurnKey(t);
    if (seen.has(key)) continue;
    seen.add(key); keys.push(key); fresh.push(t);
  }
  return { turns: fresh, keys, omitted: list.length - fresh.length };
}
// Search-results state that filter and sort actions change. Refinements are Amazon's
// rh tokens (department filters appear there as n:...) plus custom price bounds, sorted
// for comparison. The search box's department scope (i=, e.g. i=aps) belongs to the
// search itself, and Amazon drops it from the URL right after loading the results.
export type SearchState = { query: string; refinements: string[]; sort: string };
export function searchState(raw: unknown): SearchState | null {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return null; }
  if (!isShoppingUrl(u.href) || !/^\/s(?:\/|$)/.test(u.pathname)) return null;
  const p = u.searchParams;
  const query = (p.get('k') || p.get('field-keywords') || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const rh = (p.get('rh') || '').split(',').map(t => t.trim()).filter(Boolean);
  const extra = ['low-price', 'high-price'].filter(k => p.get(k)).map(k => `${k}:${p.get(k)}`);
  return { query, refinements: [...new Set([...rh, ...extra])].sort(), sort: p.get('s') || '' };
}
export const SORT_LABELS: Record<string, string> = {
  '': 'Featured', 'relevanceblender': 'Featured', 'price-asc-rank': 'Price: Low to High',
  'price-desc-rank': 'Price: High to Low', 'review-rank': 'Avg. Customer Review',
  'date-desc-rank': 'Newest Arrivals', 'exact-aware-popularity-rank': 'Best Sellers',
};
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
export type SessionLookup =
  | { status: 'new' | 'conflict' }
  | { status: 'closed'; stage: string }
  | { status: 'resume'; url: string }
  | { status: 'invalid' };
// Answers the intake survey before it assigns a task, mirroring StudyService.enroll: 'resume'
// only when the Amazon link it returns would continue this browser's session, not re-assign it.
export function lookupSession(state: Record<string, any>, rawPid: unknown, now = Date.now()): SessionLookup {
  const pid = typeof rawPid === 'string' ? rawPid.trim().toLowerCase() : '';
  if (!/^[a-f\d]{24}$/.test(pid)) return { status: 'invalid' };
  const c = state.studyContext as StudyContext | undefined, user = state.user;
  if ((user && !c) || (c && c.prolificId !== pid) || (user?.prolificId && user.prolificId !== pid)) {
    return { status: 'conflict' };
  }
  const stage = String(state.taskStage || 'initial');
  if (!c) return stage === 'initial' ? { status: 'new' } : { status: 'closed', stage };
  // A failed registration keeps the assignment at 'initial' without a user; the same link retries it.
  const open = stage === 'shopping' ? !!user : (stage === 'initial' || stage === 'registering') && !user;
  if (!open || user?.active === false || !(Number(c.expiresAt) > now) || !isShoppingUrl(c.origin)) {
    return { status: 'closed', stage };
  }
  const url = new URL(c.origin);
  url.searchParams.set('PROLIFIC_PID', c.prolificId);
  url.searchParams.set('arm', c.arm);
  url.searchParams.set('category', c.category);
  return { status: 'resume', url: url.href };
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
