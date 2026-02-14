// Fluxin remote plugin: Unlock 1080p+/60fps for non-premium users.
//
// Removes the premium gate from the Screen Share Settings modal so that all
// resolution / frame-rate options are selectable regardless of subscription status.
//
// Install via Fluxin Plugins UI by hosting this file somewhere reachable over HTTP(S).
// Example local-dev server is provided in ./server.js

(function () {
  "use strict";

  const PLUGIN_ID = "fluxin-auto-4k60-unlock";

  function log(...args) {
    console.log(`[${PLUGIN_ID}]`, ...args);
  }

  // ---------------------------------------------------------------------------
  // CSS injection — hide lock icons & premium banner without touching the DOM
  // tree, which would break React reconciliation and unmount the modal.
  // ---------------------------------------------------------------------------

  const style = document.createElement("style");
  style.id = PLUGIN_ID + "-styles";
  style.textContent = `
    /* Hide crown/lock icons inside option buttons */
    button[class*="optionButton"] svg { display: none !important; }

    /* Make locked buttons look/behave like normal unlocked ones:
       Fluxer uses CSS-module hashed class names, but the substring
       "Locked" is always present in the source class name, so the
       generated hash still contains it. We target any class containing
       "Locked" and override the visual cues. */
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
  // Utility helpers
  // ---------------------------------------------------------------------------

  function textOf(el) {
    return (el && typeof el.textContent === "string" ? el.textContent : "").trim();
  }

  // ---------------------------------------------------------------------------
  // React fiber helpers
  // ---------------------------------------------------------------------------

  function getReactFiberKey(domNode) {
    return Object.keys(domNode).find((k) => k.startsWith("__reactFiber$"));
  }

  function findFiber(domNode, predicate, maxDepth = 30) {
    const key = getReactFiberKey(domNode);
    if (!key) return null;

    let fiber = domNode[key];
    for (let i = 0; i < maxDepth && fiber; i++) {
      try {
        if (predicate(fiber)) return fiber;
      } catch (_) {
        /* ignore */
      }
      fiber = fiber.return;
    }
    return null;
  }

  function getReactProps(domNode) {
    const key = Object.keys(domNode).find((k) => k.startsWith("__reactProps$"));
    return key ? domNode[key] : null;
  }

  // ---------------------------------------------------------------------------
  // Phase 0 — Patch MobX VoiceSettingsStore.hasPremium
  // ---------------------------------------------------------------------------

  let storePatched = false;

  function tryPatchStore(modalRoot) {
    if (storePatched) return;

    // Strategy 1: webpack module cache
    try {
      const cache = window.__fluxin_webpack_require__
        ? window.__fluxin_webpack_require__.c
        : null;

      if (cache) {
        for (const moduleId of Object.keys(cache)) {
          const mod = cache[moduleId];
          if (
            mod &&
            mod.exports &&
            mod.exports.default &&
            typeof mod.exports.default === "object" &&
            "screenshareResolution" in mod.exports.default &&
            "hasPremium" in mod.exports.default
          ) {
            mod.exports.default.hasPremium = true;
            storePatched = true;
            log("Patched VoiceSettingsStore.hasPremium = true (via webpack cache)");
            return;
          }
        }
      }
    } catch (_) {}

    // Strategy 2: walk fibers from modal looking for MobX store on stateNode
    try {
      const el = modalRoot.querySelector("button") || modalRoot.querySelector("div") || modalRoot;
      const fiberKey = getReactFiberKey(el);
      if (fiberKey) {
        let fiber = el[fiberKey];
        for (let i = 0; i < 50 && fiber; i++) {
          if (fiber.stateNode && typeof fiber.stateNode === "object") {
            const inst = fiber.stateNode;
            if ("screenshareResolution" in inst && "hasPremium" in inst) {
              inst.hasPremium = true;
              storePatched = true;
              log("Patched VoiceSettingsStore.hasPremium = true (via fiber stateNode)");
              return;
            }
          }
          fiber = fiber.return;
        }
      }
    } catch (_) {}

    if (!storePatched) {
      log("Could not locate VoiceSettingsStore — falling back to handler-bypass only");
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 1 — Bypass React click handlers for premium option buttons
  //
  // Instead of mutating the DOM (which breaks React), we patch the React
  // internal props onClick to call the state dispatcher directly, skipping
  // the isPremium && !hasPremium guard that opens the premium modal.
  // ---------------------------------------------------------------------------

  function bypassClickHandlers(modalRoot) {
    const optionButtons = modalRoot.querySelectorAll("button");

    for (const btn of optionButtons) {
      // Skip buttons we already patched
      if (btn._fluxinPatched) continue;

      const label = textOf(btn);

      const resMatch = label.match(/^(480p|720p|1080p|1440p|4K)$/);
      const fpsMatch = label.match(/^(\d+)\s*fps$/);

      if (!resMatch && !fpsMatch) continue;

      const reactProps = getReactProps(btn);
      if (!reactProps || !reactProps.onClick) continue;

      const originalOnClick = reactProps.onClick;

      // Build our replacement handler
      const patchedOnClick = function (e) {
        // Find the fiber that owns the useState hooks for resolution/framerate
        const modalFiber = findFiber(btn, (f) => {
          let hs = f.memoizedState;
          let count = 0;
          while (hs) { count++; hs = hs.next; }
          return count >= 6;
        });

        if (modalFiber) {
          // Collect all useState dispatchers
          let hs = modalFiber.memoizedState;
          const dispatchers = [];
          while (hs) {
            if (hs.queue && typeof hs.queue.dispatch === "function") {
              dispatchers.push({ state: hs.memoizedState, dispatch: hs.queue.dispatch });
            }
            hs = hs.next;
          }

          if (resMatch) {
            const valueMap = { "480p": "low", "720p": "medium", "1080p": "high", "1440p": "ultra", "4K": "4k" };
            const value = valueMap[resMatch[1]];
            if (value) {
              for (const d of dispatchers) {
                if (typeof d.state === "string" && ["low", "medium", "high", "ultra", "4k"].includes(d.state)) {
                  d.dispatch(value);
                  log(`Set resolution → ${value}`);
                  return;
                }
              }
            }
          }

          if (fpsMatch) {
            const value = parseInt(fpsMatch[1], 10);
            for (const d of dispatchers) {
              if (typeof d.state === "number" && [15, 24, 30, 60].includes(d.state)) {
                d.dispatch(value);
                log(`Set framerate → ${value}`);
                return;
              }
            }
          }
        }

        // Fallback: call original (may open premium modal)
        originalOnClick(e);
      };

      // Patch React's internal onClick — this is the handler React's
      // synthetic event system actually calls, so no native listener needed.
      reactProps.onClick = patchedOnClick;
      btn._fluxinPatched = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Modal detection & orchestration
  // ---------------------------------------------------------------------------

  function isScreenShareSettingsModal(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.textContent && node.textContent.includes("Screen Share Settings");
  }

  const processed = new WeakSet();

  function processModal(modalRoot) {
    if (processed.has(modalRoot)) return;
    processed.add(modalRoot);

    // Phase 0: patch the MobX store
    tryPatchStore(modalRoot);

    // Phase 1: bypass React click handlers
    // Wait a frame for React to finish rendering before we touch the fibers.
    requestAnimationFrame(() => {
      bypassClickHandlers(modalRoot);
      log("Modal processed — premium options unlocked");
    });
  }

  function scanForModal() {
    const candidates = document.querySelectorAll("div");
    for (const el of candidates) {
      if (!isScreenShareSettingsModal(el)) continue;

      // Walk up to the topmost container that still matches
      let modal = el;
      while (
        modal.parentElement &&
        isScreenShareSettingsModal(modal.parentElement) &&
        modal.parentElement !== document.body
      ) {
        modal = modal.parentElement;
      }

      processModal(modal);
    }
  }

  // ---------------------------------------------------------------------------
  // MutationObserver
  // ---------------------------------------------------------------------------

  let scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        scanForModal();
      } catch (e) {
        console.error(`[${PLUGIN_ID}] scan failed`, e);
      }
    });
  }

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Initial pass
  scheduleScan();

  log("Loaded — premium screen-share options will be unlocked");
})();
