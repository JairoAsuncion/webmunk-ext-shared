import { jitsuAnalytics } from '@jitsu/js';
import { JITSU_WRITE_KEY, JITSU_INGEST_URL, STUDY_ID } from '../config';
import { FirebaseAppService } from './FirebaseAppService';
import { ConfigService } from './ConfigService';
import { Event } from '../enums';
import { getStoredCategory } from './CategoryService';
import { getOrCreateInstallId } from './utils';
import { debug } from '../utils/log';

const DROP_EVENTS: Set<string> = new Set([
  // legacy Ad Study events, no thesis construct
  Event.URL_TRACKING,
  Event.EXCLUDED_DOMAINS_VISIT,
  Event.INSTALLED_EXTENSIONS,
  Event.USER_MAPPING, // redundant: user_id (prolificId) already rides on every event payload
  Event.SCREEN_ANALYSIS,
  Event.ADS_RATED,
  Event.CONTENT_LOADED,
  // high-frequency signals kept as session_summary aggregates only (see PROGRESS.md "Data Collection Cleanup")
  Event.CART_SUBTOTAL,
  Event.ASSISTANT_HIDDEN,
  // fires ~once per page on the chat arms; the signal that matters is the per-session boolean
  // session_summary.assistant_available
  Event.ASSISTANT_AVAILABLE,
]);

// Control/vulnerability evidence that must still reach Jitsu even with no registered user -
// exactly the state some of these fire in (e.g. AUTO_REGISTRATION_FAILED, by definition, means
// registration didn't happen). Tagged with an anonymous per-install id instead of a prolificId
// (see the user_id/install_id split below) so it stays traceable without a real participant id.
const DIAGNOSTIC_EVENTS: Set<string> = new Set([
  Event.AUTO_REGISTRATION_FAILED,
  Event.REGISTRATION_COMPLETED,
  Event.AMAZON_LOGIN_BLOCK_SHOWN,
  Event.AMAZON_LOGIN_BLOCKED_AT_CART,
  Event.PRE_TASK_ACTIVITY_SUPPRESSED,
  Event.ASSISTANT_LEAK_DETECTED,
]);

type JitsuClient =
  | {
      track: (eventName: string, payload?: any) => Promise<void> | void;
      identify: (id: string, traits?: any) => void;
    }
  | null;

const SCHEMA_VERSION = '2';
const MAX_PAYLOAD_BYTES = 64_000; // 64 KB soft limit per event
const RETRY_QUEUE_MAX = 20;

export class EventService {
  private client: JitsuClient;
  private retryQueue: Array<{ event: string; properties: Record<string, any>; attempt: number }> = [];

  constructor(
    private readonly firebaseAppService: FirebaseAppService,
    private readonly configService: ConfigService,
  ) {
    if (JITSU_WRITE_KEY && JITSU_INGEST_URL) {
      try {
        this.client = jitsuAnalytics({
          writeKey: JITSU_WRITE_KEY,
          host: JITSU_INGEST_URL,
          // Explicit worker-global fetch. @jitsu/js's transport is already
          // fetch-based (POST {host}/api/s/track with an X-Write-Key header);
          // passing it here means the SDK never has to probe for a browser
          // environment, and it runs in its DOM-free "empty runtime" (no
          // window/document/localStorage) - see docs/store-version.md 3.1.
          fetch: (input: any, init?: any) => globalThis.fetch(input, init),
        });
      } catch (err) {
        // eslint disable next line no console
        console.error('Failed to initialise Jitsu client', err);
        this.client = null;
      }
    } else {
      console.warn('Jitsu write key or ingest url missing, events will only be logged to console');
      this.client = null;
    }

    // Periodically attempt retry queue
    setInterval(() => this.flushRetryQueue(), 30_000); // every 30s
  }

  private estimatePayloadBytes(obj: any): number {
    try {
      return JSON.stringify(obj).length;
    } catch {
      return 0;
    }
  }

  private trimOversizedPayload(properties: Record<string, any>): Record<string, any> {
    const trimmed = { ...properties };
    const bytes = this.estimatePayloadBytes(trimmed);

    if (bytes <= MAX_PAYLOAD_BYTES) {
      return trimmed;
    }

    // Trim assistant turn payloads if oversized
    if (trimmed.turns && Array.isArray(trimmed.turns)) {
      trimmed.turns_count = trimmed.turns.length;
      trimmed.turns = trimmed.turns.slice(0, 3); // keep only last 3
      trimmed.turns_trimmed = true;
    }

    // Truncate product suggestion list
    if (trimmed.product_suggestions && Array.isArray(trimmed.product_suggestions)) {
      trimmed.product_suggestions_count = trimmed.product_suggestions.length;
      trimmed.product_suggestions = trimmed.product_suggestions.slice(0, 2);
      trimmed.product_suggestions_trimmed = true;
    }

    // Remove large nested objects if still oversized
    if (this.estimatePayloadBytes(trimmed) > MAX_PAYLOAD_BYTES) {
      delete trimmed.turns;
      delete trimmed.user_texts;
    }

    console.warn('[wm] EventService: payload trimmed to fit size limit', {
      original_bytes: bytes,
      trimmed_bytes: this.estimatePayloadBytes(trimmed),
    });

    return trimmed;
  }

  private async flushRetryQueue(): Promise<void> {
    if (!this.client || this.retryQueue.length === 0) {
      return;
    }

    const toRetry = [...this.retryQueue];
    this.retryQueue = [];

    for (const item of toRetry) {
      if (item.attempt >= 3) {
        console.warn('[wm] EventService: retry exhausted for event', item.event);
        continue;
      }

      try {
        await this.client.track(item.event, { event: item.event, ...item.properties });
        debug('[wm] EventService: retry succeeded for event', item.event);
      } catch (err) {
        console.warn('[wm] EventService: retry failed, re-queueing', item.event);
        this.retryQueue.push({ ...item, attempt: item.attempt + 1 });
      }
    }
  }

  async track(event: Event | string, properties: Record<string, any> = {}): Promise<void> {
    const eventName = typeof event === 'string' ? event : String(event);

    if (!eventName) {
      console.warn('EventService.track called without an event name', properties);
      return;
    }

    if (DROP_EVENTS.has(eventName as Event)) {
      return;
    }

    if (
      (properties as any).context_page_title &&
      (properties as any).title &&
      (properties as any).context_page_title === (properties as any).title
    ) {
      delete (properties as any).context_page_title;
    }

    if (
      (properties as any).context_page_url &&
      (properties as any).url &&
      (properties as any).context_page_url === (properties as any).url
    ) {
      delete (properties as any).context_page_url;
    }

    const [user, config, productCategory] = await Promise.all([
      this.firebaseAppService.getUser(),
      this.configService.getConfig(),
      getStoredCategory(),
    ]);

    const isDiagnostic = DIAGNOSTIC_EVENTS.has(eventName as Event);

    // Every other event requires a registered user - but a diagnostic event's entire point can
    // be that registration hasn't happened (AUTO_REGISTRATION_FAILED) or hasn't finished being
    // confirmed yet (PRE_TASK_ACTIVITY_SUPPRESSED) - dropping it here the same way would erase
    // exactly the evidence it exists to capture.
    if (!user && !isDiagnostic) {
      return;
    }

    const trackInactive =
      (config as any)?.trackInactiveUsers === true || (config as any)?.trackInactiveUsers === 'true';

    if (user && user.active === false && !trackInactive) {
      return;
    }

    // Trim oversized payloads before envelope
    const trimmedProperties = this.trimOversizedPayload(properties);

    const payload = {
      event_type: event,
      study_id: STUDY_ID,
      schema_version: SCHEMA_VERSION,
      ts: Date.now(),
      user_id: user ? user.prolificId || user.uid : null,
      // Only populated when there's no registered user to attach instead - lets a diagnostic
      // event fired before/without registration still be correlated to "the same browser,
      // later" without ever standing in for a real participant identifier.
      install_id: user ? undefined : await getOrCreateInstallId(),
      session_id: user?.sessionUid,
      // Assigned category from Qualtrics' "Product Category" embedded data, attached here
      // (rather than threaded through every track() call site like `arm` currently is) so it
      // can't silently go missing from an event - it's needed downstream to verify a
      // participant's purchase actually matched their assigned category.
      product_category: productCategory,
      ...trimmedProperties,
    };

    if (!this.client) {
      // eslint disable next line no console
      debug('Jitsu disabled, would send event', payload);
      return;
    }

    if (user) {
      this.client.identify(user.uid, { $doNotSend: true });
    }

    try {
      await this.client.track(eventName, { event: eventName, ...payload });
    } catch (err) {
      // eslint disable next line no console
      console.error('Failed to send event to Jitsu', err);

      // Add to retry queue for later attempt
      if (this.retryQueue.length < RETRY_QUEUE_MAX) {
        this.retryQueue.push({ event: eventName, properties: payload, attempt: 1 });
        console.warn('[wm] EventService: queued event for retry', eventName);
      } else {
        console.error('[wm] EventService: retry queue full, dropping event', eventName);
      }
    }
  }
}
