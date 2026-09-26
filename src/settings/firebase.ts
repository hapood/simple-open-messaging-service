/**
 * Firebase client config — the 4 fields the Android client needs to initialize `FirebaseApp` at runtime,
 * parsed from the operator's `google-services.json` file. This is a federated / self-hosted chat app — each
 * operator runs their own backend AND their own Firebase project — so the APK ships WITHOUT
 * google-services.json; the operator places theirs at data/google-services.json — the same file-on-disk
 * model as the send-side data/firebase-service-account.json
 * service-account key, NOT the DB-backed model the VAPID keypair uses), the server folds these 4 fields
 * into GET /client/compat (the connect-time payload), and the native shell applies them at server setup so
 * the client initializes `FirebaseApp.initializeApp` at process start.
 *
 * The 4 fields are the only values the client needs from google-services.json, and all of them are "public"
 * (they ship inside the APK in the usual baked model), so serving them unauthenticated is safe: they
 * identify a Firebase project, they do not authenticate anything.
 */
export interface FirebaseClientConfig {
  /** `client[].api_key[0].current_key` — the Firebase Android API key. Public; identifies the project. */
  apiKey: string;
  /** `project_info.project_id` — the Firebase project ID (e.g. "my-chat-app"). */
  projectId: string;
  /** `client[].client_info.mobilesdk_app_id` — the Android app's Firebase App ID (1:<sender>:android:<hex>). */
  appId: string;
  /** `project_info.project_number` — the FCM/GCM sender ID (numeric). The SDK uses it to register tokens. */
  gcmSenderId: string;
}

/** The Android applicationId the operator's google-services.json must target. The APK ships one fixed
 *  package (tauri.conf.json `identifier` + gen/android/app/build.gradle.kts `applicationId`), so every
 *  operator's Firebase project must register an Android app with THIS package — a mismatch is rejected at
 *  parse, catching the common error of registering the wrong package (which would silently break FCM token
 *  retrieval on the device). */
export const EXPECTED_ANDROID_PACKAGE = 'com.soms.client';

/** The subset of the google-services.json shape that this parser reads. */
interface GoogleServicesJson {
  project_info?: {
    project_number?: string;
    project_id?: string;
  };
  client?: Array<{
    client_info?: {
      mobilesdk_app_id?: string;
      android_client_info?: { package_name?: string };
    };
    api_key?: Array<{ current_key?: string }>;
  }>;
}

/**
 * Parse a google-services.json file and extract the 4 client fields. Throws a descriptive Error when: the
 * input is not valid JSON, project_info is missing, no `client` targets the expected Android package, or any
 * of the 4 fields is absent. The package-name match is the key guardrail. Callers (SettingsService at boot
 * read) catch this and log + treat the config as unconfigured.
 */
export function parseGoogleServicesJson(raw: string): FirebaseClientConfig {
  let json: GoogleServicesJson;
  try {
    json = JSON.parse(raw) as GoogleServicesJson;
  } catch {
    throw new Error('google-services.json is not valid JSON');
  }
  const projectNumber = json.project_info?.project_number;
  const projectId = json.project_info?.project_id;
  if (!projectNumber || !projectId) {
    throw new Error(
      'google-services.json is missing project_info.project_number / project_id',
    );
  }
  const client = (json.client ?? []).find(
    (c) =>
      c.client_info?.android_client_info?.package_name ===
      EXPECTED_ANDROID_PACKAGE,
  );
  if (!client) {
    throw new Error(
      `google-services.json has no Android client for package "${EXPECTED_ANDROID_PACKAGE}" — register an Android app with this exact package in your Firebase project`,
    );
  }
  const appId = client.client_info?.mobilesdk_app_id;
  const apiKey = client.api_key?.[0]?.current_key;
  if (!appId || !apiKey) {
    throw new Error(
      'google-services.json client is missing mobilesdk_app_id / api_key.current_key',
    );
  }
  const cfg: FirebaseClientConfig = {
    apiKey,
    projectId,
    appId,
    gcmSenderId: projectNumber,
  };
  assertValidFirebaseConfig(cfg);
  return cfg;
}

/**
 * Soft structural validation. The real authority is Firebase itself (it rejects a bad config at token
 * registration); these checks catch gross mistakes at upload time so misconfiguration is surfaced to the
 * operator immediately rather than as a silent on-device failure.
 */
export function assertValidFirebaseConfig(cfg: FirebaseClientConfig): void {
  if (!isValidApiKey(cfg.apiKey))
    throw new Error('apiKey is missing or malformed');
  if (!isValidProjectId(cfg.projectId))
    throw new Error('projectId is missing or malformed');
  if (!isValidAppId(cfg.appId))
    throw new Error('appId is missing or malformed');
  if (!isValidSenderId(cfg.gcmSenderId))
    throw new Error('gcmSenderId is missing or malformed');
}

/** Firebase Android API keys are long base64url-ish tokens (typically starting "AIzaSy"). */
export function isValidApiKey(v: string): boolean {
  return typeof v === 'string' && v.length >= 20 && /^[A-Za-z0-9_-]+$/.test(v);
}

/** Firebase project IDs are lowercase alphanumeric with hyphens. */
export function isValidProjectId(v: string): boolean {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(v);
}

/** Firebase Android App IDs follow `1:<project-number>:android:<hex>`. */
export function isValidAppId(v: string): boolean {
  return typeof v === 'string' && /^1:\d+:android:[0-9a-f]+$/.test(v);
}

/** The GCM/FCM sender ID is the numeric project number. */
export function isValidSenderId(v: string): boolean {
  return typeof v === 'string' && /^\d+$/.test(v);
}

/** Admin read view. projectId / appId / gcmSenderId are shown as proof of configuration; apiKey is omitted
 *  from the descriptor (it is the most key-like of the four and is not needed for the admin display) —
 *  parallel to how the VAPID descriptor omits privateKey. All 4 fields are also folded into GET /client/compat
 *  for the Android client's runtime init (the client needs them). */
export interface FirebaseConfigDescriptor {
  configured: boolean;
  projectId?: string;
  appId?: string;
  gcmSenderId?: string;
}
