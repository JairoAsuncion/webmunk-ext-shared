export class NotificationService {
  // Login hard-lock state. `loginBlockWanted` is the single flag the self-healing
  // observer checks: while true the overlay is re-mounted the instant anything
  // (Amazon's own scripts, a browser extension, devtools) removes it.
  private loginBlockWanted = false;
  private loginBlockEl: HTMLElement | null = null;
  private loginBlockStyleEl: HTMLStyleElement | null = null;
  private loginBlockObserver: MutationObserver | null = null;
  private loginBlockKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  // Latest sign-in URL. The overlay's card is built once, but the URL improves over the first
  // few ticks (the real Amazon nav link renders after the overlay first appears), so the
  // button href is refreshed on every mount instead of frozen at build time.
  private loginBlockSignInUrl = '';

  // Only the local login block is used by the shopping study. Do not register
  // the legacy all-message listener: it can steal replies from live-cart reads.
  constructor() {}

  private async handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void): Promise<void> {
    if (message.action === 'webmunkExt.notificationService.extensionNotificationRequest') {
      this.showNotification(message.text);
    } else if (message.action === 'webmunkExt.worker.notifyAdPersonalization') {
      await chrome.runtime.sendMessage({ action: 'webmunkExt.popup.checkSettingsReq', data: message.data })
    } else if (message.action === 'webmunkExt.worker.notifyCookiesModule') {
      await chrome.runtime.sendMessage({ action: 'webmunkExt.worker.recordCookies' });
    } else if (message.action === 'webmunkExt.screenshotService.isThereNotificationReq') {
      this.checkIfWebmunkNotificationExists();
    }
  }

  // Full-page hard lock shown when the shopping task has started but the participant isn't
  // signed into Amazon yet. Unlike showNotification()'s dismissible banner this one has no
  // close button, captures all pointer and keyboard input, and self-heals: a MutationObserver
  // re-mounts it the instant anything removes it from the DOM. Called directly by Content.ts
  // (not round-tripped through the background) so it appears as early as the content script
  // can tell it's needed, and Content.ts's periodic re-check keeps it in sync with login
  // state without waiting for a page reload. Idempotent - safe to call every tick.
  public showLoginBlock(signInUrl: string): void {
    this.loginBlockWanted = true;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.mountLoginBlock(signInUrl), { once: true });
    } else {
      this.mountLoginBlock(signInUrl);
    }
  }

  // Tears the lock down completely - element, injected style, key handler, observer, and the
  // <html> overflow override. Content.ts calls this the moment it detects the participant is
  // signed in (or the task is no longer in the shopping stage), so the page unlocks without
  // needing a reload.
  public clearLoginBlock(): void {
    this.loginBlockWanted = false;

    if (this.loginBlockObserver) {
      this.loginBlockObserver.disconnect();
      this.loginBlockObserver = null;
    }
    if (this.loginBlockKeyHandler) {
      window.removeEventListener('keydown', this.loginBlockKeyHandler, true);
      window.removeEventListener('keypress', this.loginBlockKeyHandler, true);
      window.removeEventListener('keyup', this.loginBlockKeyHandler, true);
      this.loginBlockKeyHandler = null;
    }
    this.loginBlockEl?.remove();
    this.loginBlockStyleEl?.remove();
    this.loginBlockEl = null;
    this.loginBlockStyleEl = null;

    document.documentElement.style.overflow = '';
  }

  private buildLoginBlockElements(signInUrl: string): void {
    const styles = document.createElement('style');
    styles.textContent = `
      .webmunk-block-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483647;

        display: flex;
        justify-content: center;
        align-items: center;

        background: rgba(17, 17, 17, 0.85);
        pointer-events: all;
      }

      .webmunk-block-card {
        width: 420px;
        max-width: 90vw;
        padding: 28px 24px;

        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        text-align: center;
      }

      .webmunk-block-signin-button {
        display: inline-block;
        margin-top: 18px;
        padding: 12px 24px;

        background: #a41b33;
        color: #ffffff !important;
        text-decoration: none !important;
        border-radius: 6px;
        font-weight: 700;
        font-size: 15px;
      }

      .webmunk-block-signin-button:hover {
        background: #7f1527;
      }

      .webmunk-block-recheck {
        display: block;
        margin-top: 14px;
        background: none;
        border: none;
        color: #555 !important;
        font-size: 13px;
        text-decoration: underline;
        cursor: pointer;
      }
    `;

    const backdrop = document.createElement('div');
    backdrop.id = 'webmunk-login-block';
    backdrop.classList.add('webmunk-block-backdrop');
    backdrop.innerHTML = `
      <div class="webmunk-block-card">
        <img style="width: 32px; height: 32px;" src="${chrome.runtime.getURL('images/UvA.png')}" alt="logo">
        <h2 style="font-size: 20px; color: #111; margin: 12px 0 8px;">Sign in required</h2>
        <p style="font-size: 15px; color: #333; margin: 0; line-height: 1.5;">
          You must be signed in to your Amazon account (on this Amazon site) to do the
          shopping task. Sign in and this page unlocks on its own.
        </p>
        <a class="webmunk-block-signin-button">Sign in to Amazon</a>
        <button type="button" class="webmunk-block-recheck">Already signed in? Reload this page</button>
      </div>
    `;

    // Safety valve: if login detection is briefly wrong (slow nav render, an interstitial
    // page), a reload re-runs the check. It never bypasses the lock - a genuinely signed-out
    // participant just sees it again.
    backdrop.querySelector('.webmunk-block-recheck')?.addEventListener('click', () => {
      window.location.reload();
    });

    this.loginBlockStyleEl = styles;
    this.loginBlockEl = backdrop;
  }

  private mountLoginBlock(signInUrl: string): void {
    if (!this.loginBlockWanted) return;

    if (signInUrl) {
      this.loginBlockSignInUrl = signInUrl;
    }

    if (!this.loginBlockEl || !this.loginBlockStyleEl) {
      this.buildLoginBlockElements(this.loginBlockSignInUrl);
    }

    if (this.loginBlockStyleEl && !this.loginBlockStyleEl.isConnected) {
      (document.head || document.documentElement).appendChild(this.loginBlockStyleEl);
    }
    if (this.loginBlockEl && !this.loginBlockEl.isConnected) {
      document.documentElement.appendChild(this.loginBlockEl);
    }
    document.documentElement.style.overflow = 'hidden';

    // Keep the button pointing at the best URL we have now (see loginBlockSignInUrl).
    const btn = this.loginBlockEl?.querySelector('.webmunk-block-signin-button') as HTMLAnchorElement | null;
    if (btn && this.loginBlockSignInUrl && btn.getAttribute('href') !== this.loginBlockSignInUrl) {
      btn.setAttribute('href', this.loginBlockSignInUrl);
    }

    // Swallow every key event that isn't aimed at the sign-in card, in the capture phase, so
    // page shortcuts / typing behind the backdrop can't reach Amazon while the lock is up.
    if (!this.loginBlockKeyHandler) {
      this.loginBlockKeyHandler = (e: KeyboardEvent): void => {
        if (!this.loginBlockWanted) return;
        const card = this.loginBlockEl?.querySelector('.webmunk-block-card') || null;
        const path = (typeof e.composedPath === 'function' && e.composedPath()) || [];
        if (card && (path.indexOf(card) !== -1 || card.contains(e.target as Node))) return;
        e.stopImmediatePropagation();
        e.preventDefault();
      };
      window.addEventListener('keydown', this.loginBlockKeyHandler, true);
      window.addEventListener('keypress', this.loginBlockKeyHandler, true);
      window.addEventListener('keyup', this.loginBlockKeyHandler, true);
    }

    // Re-mount if anything strips the overlay out of the DOM while it's still wanted. The
    // overlay is a direct child of <html>, so watching only <html>'s child list (not the
    // whole subtree) is enough and far cheaper on a busy Amazon page; Content.ts's interval
    // is the backstop for anything exotic this misses.
    if (!this.loginBlockObserver) {
      this.loginBlockObserver = new MutationObserver(() => {
        if (!this.loginBlockWanted) return;
        if (!document.getElementById('webmunk-login-block')) {
          this.mountLoginBlock(this.loginBlockSignInUrl);
        }
      });
      this.loginBlockObserver.observe(document.documentElement, { childList: true });
    }
  }

  private showNotification(text: string): void {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.displayNotification(text));
    } else {
      this.displayNotification(text);
    }
  }

  private displayNotification(text: string): void {
    if (document.getElementById('webmunk-rate-notification')) return;
    // A still-showing, undismissed notification used to silently drop the new request without
    // ever calling sendResponseToService() - which left the worker's showNotification() Promise
    // hanging forever (it only resolves on that response, or rejects if the tab closes), so a
    // later, unrelated notification attempt on the same tab would just never settle. Replace the
    // stale one and always respond instead.
    document.getElementById('webmunk-notification')?.remove();
    this.sendResponseToService();

    const styles = document.createElement('style');
    styles.textContent = `
      .notification-wrapper {
        position: fixed;
        top: 0;
        left: 0;
        z-index: 10000;

        display: flex;
        justify-content: center;
        align-items: center;
        width: 100%;
        height: 100%;

        pointer-events: none;
      }

      .notification-container {
        position: fixed;
        z-index: 10000;

        display: flex;
        flex-direction: column;
        gap: 15px;
        width: 480px;
        padding: 15px 20px;

        background-color: #ffffff;
        border: 1px solid transparent;
        color: black;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        font-weight: 700 !important;
        border-radius: 10px;
        opacity: 0;
        box-shadow: 0 0 10px rgba(0,0,0,0.2);
        animation: appear 0.5s linear forwards;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        pointer-events: all;
      }

      @keyframes appear {
        0% { opacity: 0; }
        100% { opacity: 1; }
      }

      .close-button {
        background-color: transparent;
        cursor: pointer;
        fill: rgb(175, 175, 175);

        &:hover {
          fill: black;
        }
      }

      .open-extensions-link {
        color: blue !important;
        text-decoration: none !important;

        &:hover {
          text-decoration: underline !important;
        }
      }
    `;

    document.head.appendChild(styles);
    const wrapper = document.createElement('div');
    wrapper.classList.add('notification-wrapper');
    wrapper.id = 'webmunk-notification';

    const notificationContainer = document.createElement('div');
    notificationContainer.classList.add('notification-container');

    const notificationContent = `
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <img style="width: 25px; height: 25px;" src="${chrome.runtime.getURL('images/UvA.png')}" alt="logo">
          <p style="font-size: 22px; color: black; margin: 0; line-height: 1.3;">Webmunk Study</p>
        </div>
        <svg id="close-button" class="close-button" height="20px" viewBox="0 0 384 512">
          <path d="M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3 297.4 406.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256 342.6 150.6z">
          </path>
        </svg>
      </div>
      <p style="font-size: 18px; color: black; margin: 0; line-height: 1.3; text-align: center; white-space: break-spaces;">${text}</p>
    `;

    notificationContainer.innerHTML = notificationContent;
    wrapper.appendChild(notificationContainer);
    document.documentElement.appendChild(wrapper);

    document.getElementById('close-button')!.addEventListener('click', () => {
      wrapper.remove();
    });

    document.querySelector('.open-extensions-link')?.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.runtime.sendMessage({ action: 'webmunkExt.notificationService.removeExtension' });
      wrapper.remove();
    });
  }

  private sendResponseToService(): void {
    chrome.runtime.sendMessage({
      action: 'webmunkExt.notificationService.extensionNotificationResponse',
    });
  }

  private checkIfWebmunkNotificationExists(): void {
    const notifications = Array.from(document.querySelectorAll('[id="webmunk-notification"], [id="webmunk-rate-notification"], [id="webmunk-login-block"]'));

    const isExist = !!notifications.length;

    chrome.runtime.sendMessage({ action: 'webmunkExt.notificationService.isThereNotificationRes', result: isExist });
  }
}
