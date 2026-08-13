// eslint-disable-next-line @typescript-eslint/no-var-requires
const { applyReleaseSigning } = require('../../plugins/with-release-signing');

/**
 * Expo's android template, reduced to the parts the plugin anchors on.
 *
 * Note what the stock output does: there is no release signing config at all,
 * and the release BUILD TYPE is signed with the debug key. A release build off
 * this template therefore succeeds and produces a debug-signed artifact. These
 * tests exist so that an upstream template change fails here, loudly, instead
 * of at the point where a wrongly-signed AAB has already been uploaded.
 */
const STOCK_TEMPLATE = `android {
    namespace 'com.podv2.driver'
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

describe('release signing plugin', () => {
  const patched = applyReleaseSigning(STOCK_TEMPLATE);

  it('adds a release signing config', () => {
    const configs = patched.slice(
      patched.indexOf('signingConfigs {'),
      patched.indexOf('buildTypes {'),
    );
    expect(configs).toContain('release {');
    expect(configs).toContain('POD_V2_STORE_FILE');
  });

  it('repoints the release build type away from the debug key', () => {
    const buildTypes = patched.slice(patched.indexOf('buildTypes {'));
    expect(buildTypes).toContain('signingConfig signingConfigs.release');
    // The debug build type keeps the debug key; only one reference may remain.
    expect(buildTypes.match(/signingConfig signingConfigs\.debug/g)).toHaveLength(1);
  });

  it('fails a store build rather than falling back to the debug key', () => {
    expect(patched).toContain('podStoreBuild');
    expect(patched).toContain('throw new GradleException');
  });

  it('keeps a clean checkout buildable without the keystore', () => {
    expect(patched).toContain("storeFile file('debug.keystore')");
  });

  it('is idempotent', () => {
    expect(applyReleaseSigning(patched)).toBe(patched);
  });

  it('refuses to guess when the template no longer matches', () => {
    expect(() => applyReleaseSigning('android {\n}\n')).toThrow(/signingConfigs/);
    expect(() =>
      applyReleaseSigning(STOCK_TEMPLATE.replace('signingConfig signingConfigs.debug\n            minifyEnabled', 'minifyEnabled')),
    ).toThrow(/signingConfigs\.debug/);
  });
});
