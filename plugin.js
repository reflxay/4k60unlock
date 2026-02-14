// Fluxin remote plugin: Unlock 1080p+/60fps for non-premium users.
//
// Removes the premium gate from the Screen Share Settings modal so that all
// resolution / frame-rate options are selectable regardless of subscription status.
//
// Strategy:
//   1. Obtain webpack's internal `require` via the chunk-push trick.
//   2. Walk the live module cache to find and mutate:
//      - RESOLUTION_OPTIONS / FRAMERATE_OPTIONS → set every isPremium to false
//      - VoiceSettingsStore singleton → set hasPremium = true
//   3. Inject CSS to hide any leftover premium UI chrome.
//
// Install via Fluxin Plugins UI by hosting this file somewhere reachable over HTTP(S).

(function () {
  "use strict";

  const PLUGIN_ID = "fluxin-auto-4k60-unlock";

  function log(...args) {
    console.log(`[${PLUGIN_ID}]`, ...args);
  }

  // ---------------------------------------------------------------------------
  // 1. CSS overrides — cosmetic cleanup (no DOM mutation = no React crash)
  // ---------------------------------------------------------------------------

  const style = document.createElement("style");
  style.id = PLUGIN_ID + "-styles";
  style.textContent = `
    /* Hide crown/lock icons inside option buttons (Phosphor CrownIcon) */
    button[class*="optionButton"] svg { display: none !important; }

    /* Make any residual locked-style buttons look normal */
    button[class*="Locked"] {
      opacity: 1 !important;
      pointer-events: auto !important;
      cursor: pointer !important;
    }

    /* Hide the premium upsell banner */
    div[class*="premiumBanner"] { display: none !important; }
  `;
  document.head.appendChild(style);
  log("Injected unlock CSS");

  // ---------------------------------------------------------------------------
  // 2. Obtain webpack require via the chunk-push trick
  // ---------------------------------------------------------------------------

  function getWebpackRequire() {
    // Find the webpack chunk array (webpackChunkfluxer_app or similar)
    let chunkArray = window.webpackChunkfluxer_app;
    if (!chunkArray) {
      for (const key of Object.keys(window)) {
        if (key.startsWith("webpackChunk") && Array.isArray(window[key])) {
          chunkArray = window[key];
          break;
        }
      }
    }
    if (!chunkArray) return null;

    // Push a fake chunk whose "runtime" entry callback receives __webpack_require__
    let webpackRequire = null;
    try {
      chunkArray.push([
        [`${PLUGIN_ID}_${Date.now()}`],
        {},
        (req) => {
          webpackRequire = req;
        },
      ]);
    } catch (e) {
      log("Chunk-push trick failed:", e);
    }

    return webpackRequire;
  }

  // ---------------------------------------------------------------------------
  // 3. Walk the live module cache and patch
  // ---------------------------------------------------------------------------

  function patchModules(webpackRequire) {
    const cache = webpackRequire.c;
    if (!cache) {
      log("webpack require.c (module cache) not found");
      return;
    }

    let patchedOptions = false;
    let patchedStore = false;

    for (const moduleId of Object.keys(cache)) {
      const mod = cache[moduleId];
      if (!mod || !mod.exports) continue;

      const exports = mod.exports;

      // --- Patch RESOLUTION_OPTIONS / FRAMERATE_OPTIONS ---
      if (Array.isArray(exports.RESOLUTION_OPTIONS)) {
        for (const opt of exports.RESOLUTION_OPTIONS) {
          if (opt && typeof opt === "object" && "isPremium" in opt) {
            opt.isPremium = false;
          }
        }
        log("Patched RESOLUTION_OPTIONS → all isPremium = false");
        patchedOptions = true;
      }

      if (Array.isArray(exports.FRAMERATE_OPTIONS)) {
        for (const opt of exports.FRAMERATE_OPTIONS) {
          if (opt && typeof opt === "object" && "isPremium" in opt) {
            opt.isPremium = false;
          }
        }
        log("Patched FRAMERATE_OPTIONS → all isPremium = false");
      }

      // --- Patch VoiceSettingsStore singleton ---
      const defaultExp = exports.default;
      if (
        defaultExp &&
        typeof defaultExp === "object" &&
        "screenshareResolution" in defaultExp &&
        "videoFrameRate" in defaultExp &&
        "hasPremium" in defaultExp
      ) {
        defaultExp.hasPremium = true;
        log("Patched VoiceSettingsStore.hasPremium = true");
        patchedStore = true;
      }
    }

    if (!patchedOptions) {
      log("WARNING: Could not find RESOLUTION_OPTIONS/FRAMERATE_OPTIONS in module cache");
    }
    if (!patchedStore) {
      log("WARNING: Could not find VoiceSettingsStore in module cache");
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Execute
  // ---------------------------------------------------------------------------

  function tryPatch() {
    const webpackRequire = getWebpackRequire();
    if (!webpackRequire) {
      log("Could not obtain webpack require — will retry");
      return false;
    }

    log("Obtained webpack require — scanning module cache");
    patchModules(webpackRequire);
    return true;
  }

  // The app may still be loading modules. Retry a few times.
  if (!tryPatch()) {
    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(() => {
      attempts++;
      if (tryPatch() || attempts >= maxAttempts) {
        clearInterval(interval);
        if (attempts >= maxAttempts) {
          log("Gave up waiting for webpack require after " + maxAttempts + " attempts");
        }
      }
    }, 500);
  }

  log("Loaded — premium screen-share options will be unlocked");
})();
