import { jitsuAnalytics } from '@jitsu/js';
import { JITSU_WRITE_KEY, JITSU_INGEST_URL, STUDY_ID } from '../config';
import type { FirebaseAppService } from './FirebaseAppService';
import type { ConfigService } from './ConfigService';
const AGGREGATES_ONLY = new Set(['cart_subtotal','assistant_hidden','assistant_available','content_loaded']);

// Persist prepared envelopes: retries must not acquire a different session/PID.
export class EventService {
  private client: any;
  private flushing = false;
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(_app: FirebaseAppService, _config: ConfigService) {
    if (!JITSU_WRITE_KEY || !JITSU_INGEST_URL) throw new Error('Production analytics configuration is missing.');
    this.client = jitsuAnalytics({ writeKey:JITSU_WRITE_KEY, host:JITSU_INGEST_URL,
      fetch:(input:any, init:any) => globalThis.fetch(input, init) });
    void this.flush();
  }
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(fn, fn);
    this.mutations = result.catch(() => {});
    return result;
  }
  async track(event: string, properties: Record<string, any> = {}): Promise<void> {
    if (AGGREGATES_ONLY.has(event)) return;
    const { studyContext:c, user } = await chrome.storage.local.get(['studyContext','user']);
    if (!c?.sessionId || user?.prolificId !== c.prolificId || user?.active === false) return;
    const eventId = event === 'final_choice_confirmed' || event === 'session_summary' ? c.sessionId + ':' + event : crypto.randomUUID();
    const payload: Record<string, any> = { ...properties, event, event_type:event, event_id:eventId,
      study_id:STUDY_ID, schema_version:'5', ts:Date.now(), user_id:c.prolificId,
      session_id:c.sessionId, arm:c.arm, product_category:c.category, budget:c.budget };
    if (JSON.stringify(payload).length > 64000) {
      payload.turns = Array.isArray(payload.turns) ? payload.turns.slice(-3) : undefined;
      payload.payload_trimmed = true;
    }
    await this.mutate(async () => {
      const { eventOutbox = [] } = await chrome.storage.local.get('eventOutbox');
      if (eventOutbox.some((e:any) => e.event_id === eventId)) return;
      if (eventOutbox.length >= 1000) {
        await chrome.storage.local.set({ dataUploadError:'Study data storage is full. Stop and contact the researcher.' });
        throw new Error('Study data could not be uploaded. Stop and contact the researcher.');
      }
      await chrome.storage.local.set({ eventOutbox:[...eventOutbox,payload] });
    });
    void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (true) {
        const { eventOutbox = [] } = await chrome.storage.local.get('eventOutbox');
        const payload = eventOutbox[0];
        if (!payload) break;
        await this.client.track(payload.event_type, payload);
        await this.mutate(async () => {
          const { eventOutbox:current = [] } = await chrome.storage.local.get('eventOutbox');
          await chrome.storage.local.set({ eventOutbox:current.filter((e:any) => e.event_id !== payload.event_id), dataUploadError:'' });
        });
      }
    } catch {
      await chrome.storage.local.set({ dataUploadError:'Some study data is waiting to upload. Keep Chrome online.' });
    } finally { this.flushing = false; }
    // Retry on the next event / worker wake. A locally empty queue means the SDK
    // accepted each call, NOT proof that rows reached the research warehouse.
  }
}
