const { withProjectBuildGradle } = require('@expo/config-plugins');

/**
 * Pin androidx.recyclerview back to 1.3.2 for the whole Android build.
 *
 * WHY: something in the dependency graph (a transitive androidx pull) upgraded
 * recyclerview to 1.4.0, and 1.4.0 refuses to be consumed unless the app compiles
 * against Android SDK 35. But Expo SDK 51's expo-modules-core does NOT compile
 * against 35 (its PermissionsService.kt hits a nullability change in the 35 APIs).
 * So the two requirements are mutually exclusive on this Expo version.
 *
 * Forcing recyclerview down to 1.3.2 — which is API-compatible for every consumer
 * here and only asks for SDK 34 — lets the app stay on compileSdk 34, where
 * expo-modules-core builds cleanly. Remove this once the app moves to an Expo SDK
 * whose expo-modules-core supports compileSdk 35.
 */
module.exports = function withRecyclerViewPin(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withRecyclerViewPin: expected a groovy build.gradle');
    }
    const marker = 'androidx.recyclerview:recyclerview:1.3.2';
    if (cfg.modResults.contents.includes(marker)) return cfg;

    cfg.modResults.contents += `

// Added by withRecyclerViewPin config plugin — see plugins/withRecyclerViewPin.js
allprojects {
    configurations.all {
        resolutionStrategy {
            force 'androidx.recyclerview:recyclerview:1.3.2'
        }
    }
}
`;
    return cfg;
  });
};
