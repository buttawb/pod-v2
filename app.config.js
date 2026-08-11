/**
 * Wraps app.json so a Play build differs from a development build by an
 * environment variable rather than by remembering to hand-edit config.
 *
 * `expo-dev-client` bundles the development launcher, which must not ship to
 * the store. Removing it by hand before every release is exactly the kind of
 * step that gets forgotten once.
 */
const STORE_BUILD = process.env.POD_V2_STORE_BUILD === '1';

module.exports = ({ config }) => {
  const plugins = (config.plugins ?? []).filter(
    (plugin) => !(STORE_BUILD && plugin === 'expo-dev-client'),
  );

  return {
    ...config,
    plugins: [...plugins, './plugins/with-release-signing'],
  };
};
