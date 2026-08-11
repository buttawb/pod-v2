/**
 * Deliberately dependency-free: the version gate and other pure logic
 * import these without dragging in native modules, which keeps that logic
 * unit-testable off-device.
 */
export const API_BASE_URL = 'https://18.139.240.68.sslip.io';

/** Must match app.json's version; the server compares against it. */
export const APP_VERSION = '2.0.0';

export const APK_DOWNLOAD_URL =
  'https://pod-v2-apk-856942459927.s3.ap-southeast-1.amazonaws.com/pod-v2.apk';
