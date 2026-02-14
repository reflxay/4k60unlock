// Fluxin remote plugin: Unlock 1080p+/60fps for non-premium users.
//
// Removes the premium gate from the Screen Share Settings modal so that all
// resolution / frame-rate options are selectable regardless of subscription status.
//
// Uses both webpack-level patching (via Fluxin API) and CSS fallback.
//
// Install via Fluxin Plugins UI by hosting this file somewhere reachable over HTTP(S).
// Example local-dev server is provided in ./server.js

(function (fluxin) {
  "use strict";

  const PLUGIN_ID = "fluxin-auto-4k60-unlock";

  function log(...args) {
    console.log(`[${PLUGIN_ID}]`, ...args);
  }

  // ---------------------------------------------------------------------------
  // 1. CSS overrides — instant visual unlock (no DOM mutation = no React crash)
  // ---------------------------------------------------------------------------

  const style = document.createElement("style");
  style.id = PLUGIN_ID + "-styles";
  style.textContent = `
    /* Hide crown/lock icons inside option buttons */
    button[class*="optionButton"] svg[class*="lock"],
    button[class*="optionButton"] svg[class*="Lock"] { display: none !important; }

    /* Make locked buttons look/behave like normal unlocked ones */
    button[class*="Locked"] {
      opacity: 1 !important;
      pointer-events: auto !important;
      cursor: pointer !important;
    }

    /* Hide the "Unlock HD Video with Plutonium" upsell banner */
    div[class*="premiumBanner"] { display: none !important; }
  `;
  document.head.appendChild(style);
  log("Injected unlock CSS");

  // ---------------------------------------------------------------------------
  // 2. Webpack-level patching via Fluxin API
  //
  //    The Fluxin web preload hooks webpack chunk loading and exposes
  //    `fluxin.patches.register()` which does regex find-and-replace on
  //    module source code BEFORE it executes.
  //
  //    We also do runtime patching for modules that already loaded.
  // ---------------------------------------------------------------------------

  // --- 2a. Patch VoiceSettingsStore: make hasPremium always true for our checks
  //
  //    sanitizePremiumSettings() and validateSettings() both guard on
  //    `this.hasPremium`.  We patch the store singleton at runtime.

  let storePatchApplied = false;

  function patchStoreRuntime() {
    if (storePatchApplied) return;
    if (!fluxin) return;

    // Search every loaded webpack module for the VoiceSettingsStore singleton
    const modules = fluxin.getWebpackModules ? fluxin.getWebpackModules() : fluxin.webpackModules;
    if (!modules) return;

    for (const [, mod] of modules) {
      if (!mod.exports) continue;
      const exp = mod.exports.default || mod.exports;
      if (
        exp &&
        typeof exp === "object" &&
        "screenshareResolution" in exp &&
        "hasPremium" in exp &&
        "videoFrameRate" in exp
      ) {
        exp.hasPremium = true;
        storePatchApplied = true;
        log("Patched VoiceSettingsStore.hasPremium = true (runtime)");
        return;
      }
    }
  }

  // The modules might not be populated yet if the plugin loads early.
  // Retry a few times.
  function patchStoreWithRetry(attempts = 20, interval = 500) {
    if (storePatchApplied) return;
    patchStoreRuntime();
    if (storePatchApplied) return;
    if (attempts <= 0) {
      log("Could not find VoiceSettingsStore in webpack modules — store-level bypass unavailable");
      return;
    }
    setTimeout(() => patchStoreWithRetry(attempts - 1, interval), interval);
  }

  patchStoreWithRetry();

  // --- 2b. Patch the modal utilities module: set isPremium to false on options
  //         and remove the premium-modal-open guard in click handlers.
  //
  //    These are webpack source patches that apply to modules before execution.
  //    They only work for modules that haven't loaded yet (or on reload).

  if (fluxin && fluxin.patches && fluxin.patches.register) {
    // Patch RESOLUTION_OPTIONS / FRAMERATE_OPTIONS: isPremium: true → false
    fluxin.patches.register({
      id: PLUGIN_ID + "-options-res",
      type: "replace",
      match: "isPremium:\\s*true",
      replacement: "isPremium: false",
      predicate: "RESOLUTION_OPTIONS|FRAMERATE_OPTIONS",
    });

    // Patch handleResolutionClick / handleFrameRateClick: remove premium modal guard
    // Original: if (isPremium && !hasPremium) { PremiumModalActionCreators.open(); return; }
    fluxin.patches.register({
      id: PLUGIN_ID + "-click-guard",
      type: "replace",
      match: "if\\s*\\(isPremium\\s*&&\\s*!hasPremium\\)\\s*\\{[^}]*PremiumModalActionCreators[^}]*\\}",
      replacement: "/* premium check removed by fluxin-auto-4k60-unlock */",
      predicate: "handleResolutionClick|handleFrameRateClick",
    });

    // Patch initial state: don't clamp to 'medium'/30 for non-premium
    // Original: !hasPremium && (voiceSettings.screenshareResolution === 'high' || ...)
    fluxin.patches.register({
      id: PLUGIN_ID + "-initial-state",
      type: "replace",
      match: "!hasPremium\\s*&&[\\s\\S]*?\\?\\s*['\"]medium['\"]\\s*:\\s*voiceSettings\\.screenshareResolution",
      replacement: "false ? 'medium' : voiceSettings.screenshareResolution",
      predicate: "screenshareResolution",
    });

    fluxin.patches.register({
      id: PLUGIN_ID + "-initial-fps",
      type: "replace",
      match: "!hasPremium\\s*&&\\s*voiceSettings\\.videoFrameRate\\s*>\\s*30\\s*\\?\\s*30\\s*:",
      replacement: "false ?  30 :",
      predicate: "videoFrameRate",
    });

    // Patch VoiceSettingsStore validateSettings: remove premium clamping
    fluxin.patches.register({
      id: PLUGIN_ID + "-validate-clamp",
      type: "replace",
      match: "if\\s*\\(!this\\.hasPremium\\)\\s*\\{",
      replacement: "if (false) {",
      predicate: "validateSettings|sanitizePremiumSettings",
    });

    // Patch sanitizePremiumSettings: make it a no-op
    fluxin.patches.register({
      id: PLUGIN_ID + "-sanitize-noop",
      type: "replace",
      match: "sanitizePremiumSettings\\(\\)\\s*\\{",
      replacement: "sanitizePremiumSettings() { return;",
      predicate: "sanitizePremiumSettings",
    });

    // Patch the modal: option.isPremium && !hasPremium → always false
    fluxin.patches.register({
      id: PLUGIN_ID + "-modal-lock",
      type: "replace",
      match: "option\\.isPremium\\s*&&\\s*!hasPremium",
      replacement: "false",
      predicate: "optionButton|ScreenShareSettings",
    });

    log("Registered webpack patches via Fluxin API");
  } else {
    log("Fluxin patches API not available — webpack patches skipped");
  }

  // ---------------------------------------------------------------------------
  // 3. DOM-level click interception (fallback for already-loaded modules)
  //
  //    If the webpack patches didn't apply (modules already loaded), we use
  //    a capturing click listener on the document to intercept premium button
  //    clicks and dispatch React state changes directly.
  // ---------------------------------------------------------------------------

  function getReactFiberKey(el) {
    return Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  }

  function isOptionButton(el) {
    if (el.tagName !== "BUTTON") return false;
    const text = (el.textContent || "").trim();
    return /^(480p|720p|1080p|1440p|4K|\d+\s*fps)$/.test(text);
  }

  function isInsideScreenShareModal(el) {
    let node = el;
    while (node) {
      if (node.textContent && node.textContent.includes("Screen Share Settings")) {
        return true;
      }
      // Don't walk too far up
      if (node === document.body) break;
      node = node.parentElement;
    }
    return false;
  }

  function dispatchStateChange(btn) {
    const text = (btn.textContent || "").trim();
    const resMatch = text.match(/^(480p|720p|1080p|1440p|4K)$/);
    const fpsMatch = text.match(/^(\d+)\s*fps$/);
    if (!resMatch && !fpsMatch) return false;

    // Walk fiber tree from button to find the component with useState hooks
    const fiberKey = getReactFiberKey(btn);
    if (!fiberKey) return false;

    let fiber = btn[fiberKey];
    for (let depth = 0; depth < 40 && fiber; depth++) {
      // Count hooks to find the right component
      let hs = fiber.memoizedState;
      const dispatchers = [];
      while (hs) {
        if (hs.queue && typeof hs.queue.dispatch === "function") {
          dispatchers.push({ state: hs.memoizedState, dispatch: hs.queue.dispatch });
        }
        hs = hs.next;
      }

      // We need at least 3 useState dispatchers (isSharing, resolution, framerate)
      if (dispatchers.length >= 3) {
        if (resMatch) {
          const map = { "480p": "low", "720p": "medium", "1080p": "high", "1440p": "ultra", "4K": "4k" };
          const value = map[resMatch[1]];
          for (const d of dispatchers) {
            if (typeof d.state === "string" && ["low", "medium", "high", "ultra", "4k"].includes(d.state)) {
              d.dispatch(value);
              log(`Set resolution → ${value}`);
              return true;
            }
          }
        }
        if (fpsMatch) {
          const value = parseInt(fpsMatch[1], 10);
          for (const d of dispatchers) {
            if (typeof d.state === "number" && [15, 24, 30, 60].includes(d.state)) {
              d.dispatch(value);
              log(`Set framerate → ${value}`);
              return true;
            }
          }
        }
      }

      fiber = fiber.return;
    }

    return false;
  }

  // Capturing listener on document — fires BEFORE React's delegated handler.
  // We only intercept clicks on premium option buttons inside the modal.
  document.addEventListener(
    "click",
    (e) => {
      // Find the actual button (click might be on inner text/span)
      let target = e.target;
      while (target && target.tagName !== "BUTTON" && target !== document.body) {
        target = target.parentElement;
      }
      if (!target || target.tagName !== "BUTTON") return;
      if (!isOptionButton(target)) return;
      if (!isInsideScreenShareModal(target)) return;

      const text = (target.textContent || "").trim();
      const isPremiumOption =
        text === "1080p" || text === "1440p" || text === "4K" || text === "60 fps";

      if (!isPremiumOption) return;

      // Try to dispatch the state change ourselves
      const dispatched = dispatchStateChange(target);
      if (dispatched) {
        // Prevent React's handler from firing (which would open premium modal)
        e.stopPropagation();
      }
    },
    true, // capture phase
  );

  log("Installed click interceptor for premium option buttons");

  // ---------------------------------------------------------------------------
  // 4. Re-patch store when modal opens (in case it reset)
  // ---------------------------------------------------------------------------

  const observer = new MutationObserver(() => {
    if (!storePatchApplied) {
      patchStoreRuntime();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  log("Loaded — premium screen-share options will be unlocked");

  // If the fluxin argument was passed, also patch the store through the
  // passed-in reference in case `window.fluxin` differs.
  if (fluxin && fluxin !== window.fluxin) {
    log("Plugin received fluxin context arg (distinct from window.fluxin)");
  }
})(typeof fluxin !== "undefined" ? fluxin : window.fluxin);
