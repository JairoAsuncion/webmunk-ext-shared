// Centralized selector list; changing this list still requires a new package.
// Do not match every element mentioning Alexa: that hides ordinary Echo products.
export const ASSISTANT_SELECTORS = [
  '#nav-rufus', '#nav-rufus-plus', '#nav-alexa', '#nav-alexa-plus',
  '[id^="nav-rufus-disco"]', '[class^="nav-rufus-disco"]',
  '#rufus-container', '#rufus-docked-container', '#alexa-shopping-container',
  '.rufus-docked', '.rufus-sections-container', '.alexa-sections-container',
  '[role="dialog"][data-csa-c-content-id*="rufus" i]',
  '[role="dialog"][data-csa-c-content-id*="alexa" i]',
  'button[aria-label*="rufus" i]', '[role="button"][aria-label*="rufus" i]',
  'button[aria-label*="ask alexa" i]', '[role="button"][aria-label*="ask alexa" i]',
  'a[aria-label="Alexa Shopping" i]', 'a[aria-label="Alexa for Shopping" i]',
  'a[aria-label^="Ask Alexa" i]', 'button[aria-label="Alexa Shopping" i]',
  // Product-page inline Alexa widget: root uses nice, descendants use nile.
  '#dpx-rex-nice-widget-container',
  '#nile-inline_feature_div', '[data-feature-name="nile-inline"]',
  '[data-wm-assistant-control="true"]',
];
export function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  return el.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}
export class AssistantControl {
  private style: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  private enabled = false;
  private marked = new Set<HTMLElement>();
  private saved = new Map<HTMLElement, { value:string; priority:string }>();
  private bodySaved: { className: string; style: string } | null = null;
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.observer?.disconnect(); this.observer = null;
      this.style?.remove(); this.style = null;
      for (const [el, old] of this.saved) {
        if (el.style.getPropertyValue('display') === 'none') {
          if (old.value) el.style.setProperty('display', old.value, old.priority);
          else el.style.removeProperty('display');
        }
      }
      this.saved.clear();
      for (const el of this.marked) delete el.dataset.wmAssistantControl;
      this.marked.clear();
      if (this.bodySaved && document.body) {
        document.body.setAttribute('class', this.bodySaved.className);
        if (this.bodySaved.style) document.body.setAttribute('style', this.bodySaved.style);
        else document.body.removeAttribute('style');
        this.bodySaved = null;
      }
      return;
    }
    if (!document.documentElement) return;
    if (!this.style?.isConnected) {
      this.style = document.createElement('style');
      this.style.id = 'webmunk-assistant-policy';
      this.style.textContent = ASSISTANT_SELECTORS.join(',') + '{display:none!important;pointer-events:none!important;}';
      document.documentElement.append(this.style);
    }
    this.hide();
    if (!this.observer) {
      this.observer = new MutationObserver(() => { if (this.enabled) this.hide(); });
      this.observer.observe(document.documentElement, {subtree:true,childList:true,characterData:true,attributes:true,
        attributeFilter:['aria-label','style','class','id']});
    }
  }
  // Amazon docks Rufus by writing classes and a matching padding gutter onto
  // <body> itself (e.g. rufus-docked-left + inline padding-left), not into a
  // detectable descendant panel. A page-load script also restores this from
  // rufus:panel:dockedState in session/local storage, so the flag must be
  // cleared too or the gutter reappears on the next navigation.
  private clearBodyDock(): void {
    const body = document.body;
    if (!body) return;
    const dockClasses = ['rufus-docked-left', 'rufus-docked-right', 'rufus-docked-adjustable',
      'rufus-docked-only', 'rufus-docked-opening-transition', 'rufus-cl-alexa-plus'];
    if (!dockClasses.some(c => body.classList.contains(c))) return;
    if (!this.bodySaved) this.bodySaved = { className: body.className, style: body.getAttribute('style') || '' };
    for (const c of dockClasses) body.classList.remove(c);
    for (const prop of ['padding-left', 'padding-right', 'padding-top',
      '--rufus-docked-panel-width', '--total-rufus-panel-full-width', '--total-rufus-panel-half-width']) {
      body.style.removeProperty(prop);
    }
    try { sessionStorage.removeItem('rufus:panel:dockedState'); } catch {}
    try { localStorage.removeItem('rufus:panel:dockedState'); } catch {}
  }
  private hide(): void {
    if (!this.style?.isConnected && this.enabled) { this.setEnabled(true); return; }
    this.clearBodyDock();
    for (const el of document.querySelectorAll<HTMLElement>('button,[role="button"],#nav-main a,#nav-belt a')) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g,' ').trim();
      if (/^(?:ask alexa|alexa (?:for )?shopping|ask rufus|rufus|chat with (?:alexa|rufus)|open (?:alexa|rufus)(?: panel)?)(?:[.!?])?$/i.test(label)) {
        if (el.dataset.wmAssistantControl !== 'true') {
          el.dataset.wmAssistantControl = 'true'; this.marked.add(el);
        }
      }
    }
    const targets = new Set(document.querySelectorAll<HTMLElement>(ASSISTANT_SELECTORS.join(',')));
    // Inner sections may be hidden while the dock shell remains open. Climb only
    // from known assistant nodes to a narrow, tall edge panel. Never hide body,
    // a product listing, navigation, or a wide page wrapper by keyword alone.
    for (const seed of [...targets]) {
      // This is a complete inline widget, not a dock. Preserve its page ancestors.
      if (seed.id === "dpx-rex-nice-widget-container") continue;
      for (let parent = seed.parentElement, depth = 0; parent && depth < 7; parent = parent.parentElement, depth++) {
        if (parent === document.body || parent === document.documentElement || parent.matches('main,nav,header,#nav-main,#nav-belt')) break;
        const rect = parent.getBoundingClientRect();
        const edge = rect.left <= 8 || rect.right >= window.innerWidth - 8;
        if (edge && rect.width >= 180 && rect.width <= Math.min(560, window.innerWidth * .45) && rect.height >= window.innerHeight * .6) {
          targets.add(parent);
          // Use Amazon's own close action when clearly labelled; it can also
          // remove the page gutter. Unlabelled controls are not guessed.
          const close = parent.querySelector<HTMLElement>('button[aria-label="Close" i],button[aria-label^="Close Alexa" i],button[aria-label^="Close Rufus" i],[role="button"][aria-label="Close" i]');
          if (!this.saved.has(parent)) close?.click();
        }
      }
    }
    for (const el of targets) {
      if (!this.saved.has(el)) this.saved.set(el, {value:el.style.getPropertyValue('display'),priority:el.style.getPropertyPriority('display')});
      // Idempotent: avoid a MutationObserver loop caused by writing the same style.
      if (el.style.getPropertyValue('display') !== 'none' || el.style.getPropertyPriority('display') !== 'important') {
        el.style.setProperty('display','none','important');
      }
    }
  }
}
