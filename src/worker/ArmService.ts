// `chat_no_guide` behaves identically to `chat` in the extension (assistant left
// visible, assistant text captured) - the only difference is the task
// instructions Qualtrics shows the participant. It exists so telemetry can tell
// "assistant available AND told to use it" apart from "assistant available but
// unprompted".
export type Arm = 'chat' | 'classic' | 'chat_no_guide';

const ARM_STORAGE_KEY = 'uva_study_arm';

const VALID_ARMS: readonly Arm[] = ['chat', 'classic', 'chat_no_guide'];

export function parseArm(value: unknown): Arm | null {
  return VALID_ARMS.includes(value as Arm) ? (value as Arm) : null;
}

export function getStoredArm(): Promise<Arm | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([ARM_STORAGE_KEY], (result) => {
      resolve((result[ARM_STORAGE_KEY] as Arm | undefined) ?? null);
    });
  });
}

export function persistArm(arm: Arm): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [ARM_STORAGE_KEY]: arm }, () => resolve());
  });
}
