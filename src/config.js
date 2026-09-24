export const JITSU_WRITE_KEY = process.env?.JITSU_WRITE_KEY;
export const JITSU_INGEST_URL = process.env?.JITSU_INGEST_URL;
export const FIREBASE_CONFIG = {
  apiKey: process.env?.FIREBASE_API_KEY,
  authDomain: `${process.env?.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: process.env?.FIREBASE_PROJECT_ID,
  storageBucket: `${process.env?.FIREBASE_PROJECT_ID}.appspot.com`,
  messagingSenderId: process.env?.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env?.FIREBASE_APP_ID,
};
// 1 hour
export const REMOTE_CONFIG_FETCH_INTERVAL = process.env?.REMOTE_CONFIG_FETCH_INTERVAL;
// 1 hour
export const USER_FETCH_INTERVAL = process.env?.USER_FETCH_INTERVAL;

export const STUDY_ID = process.env?.STUDY_ID || "uva_webmunk_rufus_v1";
