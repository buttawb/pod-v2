const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Teaches `prebuild` how this app is signed for release.
 *
 * Two things have to happen, and the second is the one that bites. Expo's
 * template ships no release signing config at all: `buildTypes.release` is
 * wired to `signingConfigs.debug`, so a release build succeeds and produces a
 * debug-signed artifact. Play rejects that on upload, and if it did not, an
 * AAB signed with the wrong key could never be corrected. So this plugin adds
 * a real release config AND repoints the release build type at it.
 *
 * The signing config used to be a hand edit to android/app/build.gradle. That
 * directory is generated and gitignored, so `prebuild --clean` threw the edit
 * away and the next release build fell back to the debug key with no warning.
 *
 * Credentials stay outside the repo, in ~/.pod-v2-signing/keystore.properties.
 * A clean checkout without them still compiles (debug key) so a reviewer never
 * needs our private key, but a build invoked with -PpodStoreBuild=true refuses
 * to fall back and fails instead.
 */

const RELEASE_SIGNING_CONFIG = `        release {
            // Credentials live outside the repository; see README.
            def podPropsFile = file(System.properties['user.home'] + "/.pod-v2-signing/keystore.properties")
            if (podPropsFile.exists()) {
                def podProps = new Properties()
                podPropsFile.withInputStream { podProps.load(it) }
                storeFile file(podProps['POD_V2_STORE_FILE'])
                storePassword podProps['POD_V2_STORE_PASSWORD']
                keyAlias podProps['POD_V2_KEY_ALIAS']
                keyPassword podProps['POD_V2_KEY_PASSWORD']
            } else if (project.hasProperty('podStoreBuild')) {
                // Play accepts an upload key exactly once. Failing loudly is
                // the only safe outcome.
                throw new GradleException(
                    "Store build requested but ~/.pod-v2-signing/keystore.properties is missing. " +
                    "Restore the keystore backup; do NOT generate a new one, Play will reject it.")
            } else {
                storeFile file('debug.keystore')
                storePassword 'android'
                keyAlias 'androiddebugkey'
                keyPassword 'android'
            }
        }
`;

/** Index of the brace closing the block whose `{` is at or after `from`. */
function endOfBlock(source, from) {
  const open = source.indexOf('{', from);
  if (open === -1) throw new Error('no block found');
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced braces in build.gradle');
}

function addReleaseSigningConfig(contents) {
  const configs = contents.indexOf('signingConfigs {');
  if (configs === -1) throw new Error('no signingConfigs block in build.gradle');
  const close = endOfBlock(contents, configs);
  const lineStart = contents.lastIndexOf('\n', close) + 1;
  return contents.slice(0, lineStart) + RELEASE_SIGNING_CONFIG + contents.slice(lineStart);
}

function useReleaseSigningInReleaseBuild(contents) {
  const buildTypes = contents.indexOf('buildTypes {');
  if (buildTypes === -1) throw new Error('no buildTypes block in build.gradle');
  const buildTypesEnd = endOfBlock(contents, buildTypes);

  const release = contents.indexOf('release {', buildTypes);
  if (release === -1 || release > buildTypesEnd) {
    throw new Error('no release buildType in build.gradle');
  }
  const releaseEnd = endOfBlock(contents, release);

  const body = contents.slice(release, releaseEnd);
  const rewired = body.replace('signingConfig signingConfigs.debug', 'signingConfig signingConfigs.release');
  if (rewired === body) {
    throw new Error('release buildType did not reference signingConfigs.debug as expected');
  }
  return contents.slice(0, release) + rewired + contents.slice(releaseEnd);
}

function applyReleaseSigning(contents) {
  // Idempotent: prebuild regenerates from the template, but a re-run over
  // already-patched output must not duplicate the block.
  if (contents.includes('podStoreBuild')) return contents;
  return useReleaseSigningInReleaseBuild(addReleaseSigningConfig(contents));
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error(`with-release-signing expects Groovy, got ${mod.modResults.language}`);
    }
    mod.modResults.contents = applyReleaseSigning(mod.modResults.contents);
    return mod;
  });
};

module.exports.applyReleaseSigning = applyReleaseSigning;
