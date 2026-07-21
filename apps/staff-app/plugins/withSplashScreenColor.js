const { withAndroidColors } = require('@expo/config-plugins');

/**
 * Define the `splashscreen_background` Android color.
 *
 * WHY: Expo SDK 51's prebuild template unconditionally ships
 * `res/drawable/splashscreen.xml` (referenced by Theme.App.SplashScreen), and it
 * points at `@color/splashscreen_background`. That color is only written to
 * colors.xml when a splash is actually configured — this app configures none, so
 * the reference dangles and `:app:processReleaseResources` fails AAPT linking with
 * "resource color/splashscreen_background not found", failing the EAS build.
 *
 * Rather than pull in expo-splash-screen just to define one color (and since the
 * generated android/ is thrown away and rebuilt on every EAS run, a hand-edited
 * colors.xml would not survive), this plugin injects the color at prebuild time.
 * Brand navy to match colorPrimary. Listed last so it wins over any earlier
 * colors mod.
 */
const SPLASH_BACKGROUND = '#023c69';

module.exports = function withSplashScreenColor(config) {
  return withAndroidColors(config, (cfg) => {
    const resources = cfg.modResults.resources ?? (cfg.modResults.resources = {});
    const colors = resources.color ?? (resources.color = []);
    const existing = colors.find((c) => c.$ && c.$.name === 'splashscreen_background');
    if (existing) {
      existing._ = SPLASH_BACKGROUND;
    } else {
      colors.push({ $: { name: 'splashscreen_background' }, _: SPLASH_BACKGROUND });
    }
    return cfg;
  });
};
