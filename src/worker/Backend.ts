import { FirebaseAppService } from './FirebaseAppService';
import { ConfigService } from './ConfigService';
import { EventService } from './EventService';
import { validateQualtricsUrl } from '../shared/StudyPolicy';

// Production transport only. The preview build replaces this module at build time.
export class Backend {
  readonly preview = false;
  private app = new FirebaseAppService();
  private config = new ConfigService(this.app);
  private events = new EventService(this.app, this.config);
  register(pid: string) { return this.app.login(pid); }
  track(event: string, properties: Record<string, any>) { return this.events.track(event, properties); }
  async surveyUrl(): Promise<string> {
    // Read from Firebase Remote Config, not a hardcoded URL, so the researcher can update
    // the final survey link from the Firebase console without a new Chrome Web Store review.
    // Convention carried over from the old SurveyService.loadSurveys(): the `surveys` Remote
    // Config value is a JSON array; the last entry is the final survey, regardless of whether
    // an unused leading "initial survey" entry is still present.
    const jsonSurveys = await this.config.getConfigByKey('surveys');
    if (!jsonSurveys) throw new Error('No surveys configured in Remote Config.');
    let surveys: { name: string; url: string }[];
    try {
      surveys = JSON.parse(jsonSurveys);
    } catch {
      throw new Error('Malformed surveys Remote Config value.');
    }
    if (!Array.isArray(surveys) || !surveys.length) throw new Error('Empty surveys array in Remote Config.');
    return validateQualtricsUrl(surveys[surveys.length - 1].url);
  }
}
