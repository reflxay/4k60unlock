// Fluxin remote plugin: Unlock 1080p+/60fps for non-premium users AND auto-pick 4K + 60fps.
//
// This is a superset of fluxin-auto-4k60.  It removes the premium gate from the
// Screen Share Settings modal so that all resolution / frame-rate options are
// selectable regardless of subscription status, then auto-selects 4K + 60 fps.
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
  // Utility helpers
  // ---------------------------------------------------------------------------

  function textOf(el) {
    return (el && typeof el.textContent === "string" ? el.textContent : "").trim();
  }

  function findButtonByLabel(root, label) {
    const buttons = root.querySelectorAll("button");
    for (const btn of buttons) {
      if (textOf(btn) === label) return btn;
    }
    return null;
  }

  function findButtonContainingLabel(root, label) {
    // Some buttons have an icon + text.  textContent will include both, so we
    // look for buttons whose textContent *contains* the label.
    const buttons = root.querySelectorAll("button");
    for (const btn of buttons) {
      if (textOf(btn).includes(label)) return btn;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // React fiber helpers — used to reach into React component state / handlers
  // ---------------------------------------------------------------------------

  /** Walk up the fiber tree starting from the DOM node's fiber and return the
   *  first fiber whose stateNode or memoizedProps satisfy `predicate`. */
  function findFiber(domNode, predicate, maxDepth = 30) {
    const key = Object.keys(domNode).find((k) => k.startsWith("__reactFiber$"));
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

  /** Retrieve the React internal props attached to a DOM node. */
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

    // Strategy: find a React fiber inside the modal that references
    // VoiceSettingsStore (the hook `useScreenShareSettingsModal` reads from it).
    // The hook exposes `hasPremium` which is derived from UserStore, but the
    // *store-level* clamping is on VoiceSettingsStore.hasPremium.
    //
    // We walk the fiber tree from any element inside the modal and look for the
    // MobX-observed store object that has `screenshareResolution` & `hasPremium`.

    const anyEl = modalRoot.querySelector("button") || modalRoot;
    const fiber = findFiber(anyEl, (f) => {
      // Look for the observer wrapper or the hook state that references the store
      const props = f.memoizedProps;
      const state = f.memoizedState;

      // Check pendingProps / memoizedProps for the store reference
      if (props && props.voiceSettings && "hasPremium" in props.voiceSettings) {
        return true;
      }

      return false;
    });

    // Alternative: iterate over globals. MobX stores created with
    // `new VoiceSettingsStore()` and exported as a default singleton are often
    // reachable through the webpack module cache.
    try {
      // Electron/webpack exposes `webpackChunkfluxer_app` or similar.
      const chunks =
        window.webpackChunkfluxer_app ||
        window.webpackChunkfluxer ||
        window.webpackChunk_N_E;

      if (chunks) {
        // The webpack require function is often available via the first chunk's
        // module factory. We search the module cache directly.
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
              const store = mod.exports.default;
              store.hasPremium = true;
              storePatched = true;
              log("Patched VoiceSettingsStore.hasPremium = true (via webpack cache)");
              return;
            }
          }
        }
      }
    } catch (e) {
      // Not fatal — we fall back to DOM-only unlocking.
    }

    // Fallback: walk the fiber tree from the modal to find any component state
    // that holds the `hasPremium` value from the custom hook.
    try {
      const el = modalRoot.querySelector("div") || modalRoot;
      let fiberNode = el[Object.keys(el).find((k) => k.startsWith("__reactFiber$"))];

      for (let i = 0; i < 50 && fiberNode; i++) {
        // The useScreenShareSettingsModal hook stores its return value in
        // memoizedState as a linked list of hook states.
        let hookState = fiberNode.memoizedState;
        for (let j = 0; j < 30 && hookState; j++) {
          const q = hookState.queue;
          if (q && q.lastRenderedState && typeof q.lastRenderedState === "object") {
            const s = q.lastRenderedState;
            if (
              "hasPremium" in s &&
              "selectedResolution" in s &&
              "handleResolutionClick" in s
            ) {
              // Found the hook return object — but we can't easily mutate the
              // React state from outside.  Instead we note the fiber and use
              // the handler bypass approach below.
              break;
            }
          }
          hookState = hookState.next;
        }

        // Check for MobX store on the fiber's stateNode
        if (fiberNode.stateNode && typeof fiberNode.stateNode === "object") {
          const inst = fiberNode.stateNode;
          if ("screenshareResolution" in inst && "hasPremium" in inst) {
            inst.hasPremium = true;
            storePatched = true;
            log("Patched VoiceSettingsStore.hasPremium = true (via fiber stateNode)");
            return;
          }
        }

        fiberNode = fiberNode.return;
      }
    } catch (e) {
      // Not fatal.
    }

    if (!storePatched) {
      log("Could not locate VoiceSettingsStore to patch hasPremium — falling back to DOM-only unlock");
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 1 — Unlock the UI (remove lock icons, fix CSS classes, bypass clicks)
  // ---------------------------------------------------------------------------

  function unlockUI(modalRoot) {
    // 1a. Remove crown / lock icons
    const lockIcons = modalRoot.querySelectorAll('svg[class*="lockIcon"], svg[class*="crown"]');
    lockIcons.forEach((icon) => icon.remove());

    // Also remove any icon that is a CrownIcon (Phosphor icons render as <svg>
    // with a specific viewBox).  We look for SVG elements inside buttons that
    // are siblings of text nodes.
    modalRoot.querySelectorAll("button svg").forEach((svg) => {
      // Phosphor crown icon has a 256x256 viewBox
      if (svg.getAttribute("viewBox") === "0 0 256 256") {
        // Check if the parent button also has text (the label).  If so, this
        // SVG is likely the lock icon — remove it.
        const btn = svg.closest("button");
        if (btn && textOf(btn).match(/\d+(p|K|fps)/)) {
          svg.remove();
        }
      }
    });

    // 1b. Fix CSS classes: replace "Locked" class variants with unlocked ones
    modalRoot.querySelectorAll("button").forEach((btn) => {
      for (const cls of [...btn.classList]) {
        if (cls.includes("Locked") || cls.includes("locked")) {
          // Replace e.g. "optionButtonSelectedLocked" → "optionButtonSelected"
          //              "optionButtonUnselectedLocked" → "optionButtonUnselected"
          const unlocked = cls.replace(/Locked/gi, "");
          if (unlocked !== cls) {
            btn.classList.remove(cls);
            btn.classList.add(unlocked);
          }
        }
      }

      // Remove aria-disabled if present
      btn.removeAttribute("aria-disabled");
      btn.disabled = false;
    });

    // 1c. Hide the premium upsell banner
    modalRoot.querySelectorAll("div").forEach((div) => {
      // The banner contains "Unlock HD Video with Plutonium"
      if (
        textOf(div).includes("Unlock HD Video with Plutonium") ||
        textOf(div).includes("Plutonium")
      ) {
        // Find the outermost banner container — it has a class containing "premiumBanner"
        let banner = div;
        for (const cls of div.classList) {
          if (cls.includes("premiumBanner") || cls.includes("premium")) {
            banner = div;
            break;
          }
        }
        // Walk up to find the direct child of the main content container
        while (banner.parentElement && !banner.parentElement.classList.toString().includes("content")) {
          if (banner.parentElement.classList.toString().includes("premium")) {
            banner = banner.parentElement;
          } else {
            break;
          }
        }
        banner.style.display = "none";
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 1b — Bypass React click handlers for premium options
  // ---------------------------------------------------------------------------

  function bypassClickHandlers(modalRoot) {
    const optionButtons = modalRoot.querySelectorAll("button");

    for (const btn of optionButtons) {
      const label = textOf(btn);

      // Resolution buttons: 1080p, 1440p, 4K
      // Framerate buttons: 60 fps
      const resMatch = label.match(/^(480p|720p|1080p|1440p|4K)$/);
      const fpsMatch = label.match(/^(\d+)\s*fps$/);

      if (!resMatch && !fpsMatch) continue;

      // Get React props to intercept the onClick
      const reactProps = getReactProps(btn);
      if (!reactProps || !reactProps.onClick) continue;

      const originalOnClick = reactProps.onClick;

      // Replace the onClick with one that calls the state-setter directly,
      // bypassing the isPremium check.
      const patchedOnClick = function (e) {
        // Try to find the fiber for the modal component that holds the
        // setSelectedResolution / setSelectedFrameRate state setters.
        const modalFiber = findFiber(btn, (f) => {
          // Look for the component that has the resolution/framerate state
          let hs = f.memoizedState;
          let hookCount = 0;
          while (hs) {
            hookCount++;
            hs = hs.next;
          }
          // The useScreenShareSettingsModal hook typically has 8+ hooks
          return hookCount >= 6;
        });

        if (modalFiber) {
          // Walk the hook linked list to find useState hooks.
          // Hook order from useScreenShareSettingsModal:
          //   0: useMemo (hasPremium)
          //   1: useState (isSharing)
          //   2: useState (selectedResolution)
          //   3: useState (selectedFrameRate)
          //   4: useState (includeAudio)
          //   5+: useCallback hooks
          let hs = modalFiber.memoizedState;
          let hookIndex = 0;
          const stateSetters = [];

          while (hs) {
            if (hs.queue && typeof hs.queue.dispatch === "function") {
              stateSetters.push({
                index: hookIndex,
                state: hs.memoizedState,
                dispatch: hs.queue.dispatch,
              });
            }
            hookIndex++;
            hs = hs.next;
          }

          if (resMatch && stateSetters.length >= 2) {
            // The resolution state setter — map label to value
            const valueMap = {
              "480p": "low",
              "720p": "medium",
              "1080p": "high",
              "1440p": "ultra",
              "4K": "4k",
            };
            const value = valueMap[resMatch[1]];
            if (value) {
              // Find the setter that currently holds a string resolution value
              for (const s of stateSetters) {
                if (
                  typeof s.state === "string" &&
                  ["low", "medium", "high", "ultra", "4k"].includes(s.state)
                ) {
                  s.dispatch(value);
                  log(`Set resolution to ${value} via React state dispatch`);
                  return;
                }
              }
            }
          }

          if (fpsMatch && stateSetters.length >= 2) {
            const value = parseInt(fpsMatch[1], 10);
            // Find the setter that currently holds a numeric framerate value
            for (const s of stateSetters) {
              if (typeof s.state === "number" && [15, 24, 30, 60].includes(s.state)) {
                s.dispatch(value);
                log(`Set framerate to ${value} via React state dispatch`);
                return;
              }
            }
          }
        }

        // Fallback: call original handler (may open premium modal, but at least try)
        originalOnClick(e);
      };

      // Patch the React props onClick
      reactProps.onClick = patchedOnClick;

      // Also set a native event listener as backup
      btn.addEventListener(
        "click",
        (e) => {
          // If the React handler opened a premium modal, prevent it
          // by stopping propagation early and using our patched handler.
          e.stopPropagation();
          patchedOnClick(e);
        },
        true,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — Auto-select 4K + 60fps (from original plugin)
  // ---------------------------------------------------------------------------

  function tryAutoSelect(modalRoot) {
    const fourK = findButtonContainingLabel(modalRoot, "4K");
    const sixty = findButtonContainingLabel(modalRoot, "60 fps") || findButtonContainingLabel(modalRoot, "60fps");

    if (fourK) {
      fourK.click();
    }
    if (sixty) {
      sixty.click();
    }

    if (fourK || sixty) {
      log("Auto-selected 4K + 60fps");
    }
  }

  // ---------------------------------------------------------------------------
  // Modal detection & orchestration
  // ---------------------------------------------------------------------------

  /** Returns true if the node looks like the Screen Share Settings modal. */
  function isScreenShareSettingsModal(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.textContent && node.textContent.includes("Screen Share Settings");
  }

  // Debounce: don't re-process the same modal root more than once per render cycle.
  const processed = new WeakSet();

  function processModal(modalRoot) {
    if (processed.has(modalRoot)) return;

    // Phase 0: patch the MobX store so validateSettings() won't clamp
    tryPatchStore(modalRoot);

    // Phase 1: unlock UI
    unlockUI(modalRoot);

    // Phase 1b: bypass React click handlers for premium options
    // (wait a tick for React to finish rendering after our DOM mutations)
    setTimeout(() => {
      bypassClickHandlers(modalRoot);

      // Phase 2: auto-select 4K + 60fps
      // (another tick to let React process state updates from Phase 1b)
      setTimeout(() => {
        tryAutoSelect(modalRoot);
      }, 50);
    }, 50);

    processed.add(modalRoot);
  }

  function scanForModal() {
    const candidates = document.querySelectorAll("div");
    for (const el of candidates) {
      if (!isScreenShareSettingsModal(el)) continue;

      // Find the topmost modal container to avoid processing inner divs
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
  // MutationObserver — watch for the modal appearing
  // ---------------------------------------------------------------------------

  let scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        scanForModal();
      } catch (e) {
        console.error(`[${PLUGIN_ID}] scan failed`, e);
      }
    }, 50);
  }

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Initial pass (for cases where the modal is already open).
  scheduleScan();

  log("Loaded — premium screen-share options will be unlocked");
})();
