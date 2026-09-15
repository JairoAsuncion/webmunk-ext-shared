export class NotificationService {
  constructor() {
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
  }

  private handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void): void {
    if (message.action === 'webmunkExt.notificationService.removeExtension') {
      try {
        chrome.management.uninstallSelf({ showConfirmDialog: true });
      } catch (error) {
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
      }
    }
  }

  public async showNotification(tabId: number, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        chrome.runtime.onMessage.removeListener(messageListener);
        chrome.tabs.onRemoved.removeListener(tabCloseListener);
      };
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const settleReject = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const messageListener = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
        if (message.action === 'webmunkExt.notificationService.extensionNotificationResponse') {
          settleResolve();
        }
      };

      const tabCloseListener = (closedTabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => {
        if (closedTabId === tabId) {
          settleReject(new Error('tab closed before notification response'));
        }
      };

      chrome.runtime.onMessage.addListener(messageListener);
      chrome.tabs.onRemoved.addListener(tabCloseListener);

      // chrome.tabs.sendMessage() returns a Promise (MV3, no callback passed) that rejects if
      // there's no receiving end in that tab/frame (e.g. content script not yet injected, page
      // mid-navigation). That used to be an unhandled rejection here - the caller's
      // await showNotification() would just hang forever instead of ever seeing the real
      // failure reason. Route it into the same reject path.
      chrome.tabs
        .sendMessage(tabId, { action: 'webmunkExt.notificationService.extensionNotificationRequest', text }, { frameId: 0 })
        .catch((err: unknown) => settleReject(err));
    });
  }
}