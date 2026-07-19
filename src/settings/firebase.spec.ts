import { describe, it, expect } from 'vitest';
import {
  parseGoogleServicesJson,
  assertValidFirebaseConfig,
  isValidApiKey,
  isValidProjectId,
  isValidAppId,
  isValidSenderId,
  EXPECTED_ANDROID_PACKAGE,
} from './firebase.js';

/**
 * parseGoogleServicesJson: derives the 4 Firebase client fields from an operator-uploaded
 * google-services.json. The package-name match is the key guardrail (an operator who registers the wrong
 * package in their Firebase project would otherwise silently fail FCM token retrieval on the device), so
 * the picker + rejection paths are the focus. Validators get a basic shape check each.
 */
describe('parseGoogleServicesJson', () => {
  // A realistic, well-formed google-services.json for the expected package. A second client with a
  // different package is included to prove the picker selects com.soms.client, not client[0].
  const validJson = JSON.stringify({
    project_info: {
      project_number: '987654321098',
      project_id: 'soms-example',
      storage_bucket: 'soms-example.appspot.com',
    },
    client: [
      {
        client_info: {
          mobilesdk_app_id: '1:987654321098:android:0123456789abcdef',
          android_client_info: { package_name: 'com.example.wrong' },
        },
        api_key: [{ current_key: 'WRONGKEY_wrongpackage_do_not_pick' }],
      },
      {
        client_info: {
          mobilesdk_app_id: '1:987654321098:android:fedcba9876543210',
          android_client_info: { package_name: EXPECTED_ANDROID_PACKAGE },
        },
        oauth_client: [],
        api_key: [{ current_key: 'AIzaSyabcdefghijklmnopqrstuvwxyz1234567890' }],
        services: {},
      },
    ],
    configuration_version: '1',
  });

  it('extracts the 4 fields from the client matching the expected package', () => {
    const cfg = parseGoogleServicesJson(validJson);
    expect(cfg).toEqual({
      apiKey: 'AIzaSyabcdefghijklmnopqrstuvwxyz1234567890',
      projectId: 'soms-example',
      appId: '1:987654321098:android:fedcba9876543210',
      gcmSenderId: '987654321098',
    });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseGoogleServicesJson('{not json')).toThrow(/valid JSON/);
  });

  it('rejects missing project_info fields', () => {
    const noNumber = JSON.stringify({ project_info: { project_id: 'x' }, client: [] });
    expect(() => parseGoogleServicesJson(noNumber)).toThrow(/project_number/);
    const noId = JSON.stringify({ project_info: { project_number: '123' }, client: [] });
    expect(() => parseGoogleServicesJson(noId)).toThrow(/project_id/);
  });

  it('rejects when no client targets the expected package', () => {
    const wrongPkg = JSON.stringify({
      project_info: { project_number: '123', project_id: 'x' },
      client: [
        {
          client_info: {
            mobilesdk_app_id: '1:123:android:abcd',
            android_client_info: { package_name: 'com.example.other' },
          },
          api_key: [{ current_key: 'AIzaSyabcdefghijklmnopqrstuvwxyz1234567890' }],
        },
      ],
    });
    expect(() => parseGoogleServicesJson(wrongPkg)).toThrow(/com\.soms\.client/);
  });

  it('rejects when the matched client is missing api_key / mobilesdk_app_id', () => {
    const noAppId = JSON.stringify({
      project_info: { project_number: '123', project_id: 'x' },
      client: [
        {
          client_info: { android_client_info: { package_name: EXPECTED_ANDROID_PACKAGE } },
          api_key: [{ current_key: 'AIzaSyabcdefghijklmnopqrstuvwxyz1234567890' }],
        },
      ],
    });
    expect(() => parseGoogleServicesJson(noAppId)).toThrow(/mobilesdk_app_id/);
    const noApiKey = JSON.stringify({
      project_info: { project_number: '123', project_id: 'x' },
      client: [
        {
          client_info: {
            mobilesdk_app_id: '1:123:android:abcd',
            android_client_info: { package_name: EXPECTED_ANDROID_PACKAGE },
          },
          api_key: [],
        },
      ],
    });
    expect(() => parseGoogleServicesJson(noApiKey)).toThrow(/current_key/);
  });
});

describe('firebase field validators', () => {
  it('apiKey: long base64url-ish token', () => {
    expect(isValidApiKey('AIzaSyabcdefghijklmnopqrstuvwxyz1234567890')).toBe(true);
    expect(isValidApiKey('short')).toBe(false); // too short
    expect(isValidApiKey('has space in it and that is bad!!!')).toBe(false);
  });

  it('projectId: lowercase alnum + hyphen', () => {
    expect(isValidProjectId('soms-example')).toBe(true);
    expect(isValidProjectId('My_Project')).toBe(false); // uppercase / underscore
    expect(isValidProjectId('')).toBe(false);
  });

  it('appId: 1:<number>:android:<hex>', () => {
    expect(isValidAppId('1:987654321098:android:0123456789abcdef')).toBe(true);
    expect(isValidAppId('1:abc:android:0123456789abcdef')).toBe(false); // non-numeric project
    expect(isValidAppId('987654321098')).toBe(false);
  });

  it('senderId: numeric', () => {
    expect(isValidSenderId('987654321098')).toBe(true);
    expect(isValidSenderId('12a3')).toBe(false);
  });

  it('assertValidFirebaseConfig throws on any bad field', () => {
    const good = { apiKey: 'AIzaSyabcdefghijklmnopqrstuvwxyz1234567890', projectId: 'x-y', appId: '1:9:android:abcd', gcmSenderId: '9' };
    expect(() => assertValidFirebaseConfig(good)).not.toThrow();
    expect(() => assertValidFirebaseConfig({ ...good, projectId: 'BAD' })).toThrow(/projectId/);
  });
});
