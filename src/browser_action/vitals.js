/*
 Copyright 2020 Google Inc. All Rights Reserved.
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at
     http://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

(async () => {
  const src = chrome.runtime.getURL('src/browser_action/web-vitals.js');
  const webVitals = await import(src);
  let overlayClosedForSession = false;
  let latestCLS = {};
  let enableLogging = localStorage.getItem('web-vitals-extension-debug')=='TRUE';
  let enableUserTiming = localStorage.getItem('web-vitals-extension-user-timing')=='TRUE';

  // Core Web Vitals thresholds
  const LCP_THRESHOLD = 2500;
  const FID_THRESHOLD = 100;
  const INP_THRESHOLD = 200;
  const CLS_THRESHOLD = 0.1;

  // CLS update frequency
  const DEBOUNCE_DELAY = 500;

  // Registry for badge metrics
  const badgeMetrics = initializeMetrics();

  function initializeMetrics() {
    let metricsState = localStorage.getItem('web-vitals-extension-metrics');
    if (metricsState) {
      metricsState = JSON.parse(metricsState);

      if (metricsState.navigationStart == performance.timing.navigationStart) {
        return metricsState;
      }
    }

    // Create a fresh state.
    // Default all metric values to null.
    return {
      lcp: {
        value: null,
        pass: true,
      },
      cls: {
        value: null,
        pass: true,
      },
      fid: {
        value: null,
        pass: true,
      },
      inp: {
        value: null,
        pass: true,
      },
      // This is used to distinguish between navigations.
      // TODO: Is there a cleaner way?
      navigationStart: performance.timing.navigationStart
    };

  }

  /**
    * Very simple classifier for metrics values
    * @param  {Object} metrics
    * @return {String} overall metrics score
  */
  function scoreBadgeMetrics(metrics) {
    // Note: overallScore is treated as a string rather than
    // a boolean to give us the flexibility of introducing a
    // 'NEEDS IMPROVEMENT' option here in the future.
    let overallScore = 'GOOD';
    if (metrics.lcp.value > LCP_THRESHOLD) {
      overallScore = 'POOR';
      metrics.lcp.pass = false;
    }
    if (metrics.cls.value > CLS_THRESHOLD) {
      overallScore = 'POOR';
      metrics.cls.pass = false;
    }
    if (metrics.fid.value > FID_THRESHOLD) {
      overallScore = 'POOR';
      metrics.fid.pass = false;
    }
    if (metrics.inp.value > INP_THRESHOLD) {
      // INP does not affect overall score
      metrics.inp.pass = false;
    }
    return overallScore;
  }

  /**
     *
     * Draw or update the HUD overlay to the page
     * @param {Object} metrics
     * @param {Number} tabId
     */
  function drawOverlay(metrics, tabId) {
    let tabLoadedInBackground = false;
    const key = tabId.toString();

    localStorage.setItem('web-vitals-extension-metrics', JSON.stringify(metrics));

    // Check if tab was loaded in background
    chrome.storage.local.get(key, (result) => {
      tabLoadedInBackground = result[key];
    });

    // Check for preferences set in options
    chrome.storage.sync.get({
      enableOverlay: false,
      debug: false,
      userTiming: false,
    }, ({
      enableOverlay, debug, userTiming,
    }) => {
      if (enableOverlay === true && overlayClosedForSession == false) {
        // Overlay
        const overlayElement = document.getElementById('web-vitals-extension-overlay');
        if (overlayElement === null) {
          const overlayElement = document.createElement('div');
          overlayElement.id = 'web-vitals-extension-overlay';
          overlayElement.classList.add('web-vitals-chrome-extension');
          overlayElement.innerHTML = buildOverlayTemplate(metrics, tabLoadedInBackground);
          document.body.appendChild(overlayElement);
        } else {
          overlayElement.innerHTML = buildOverlayTemplate(metrics, tabLoadedInBackground);
        }

        // Overlay close button
        const overlayClose = document.getElementById('web-vitals-close');
        if (overlayClose === null) {
          const overlayClose = document.createElement('button');
          overlayClose.innerText = 'Close';
          overlayClose.id = 'web-vitals-close';
          overlayClose.className = 'lh-overlay-close';
          overlayClose.addEventListener('click', () => {
            overlayElement.remove();
            overlayClose.remove();
            overlayClosedForSession = true;
          });
          document.body.appendChild(overlayClose);
        } else {
          overlayClose.addEventListener('click', () => {
            overlayElement.remove();
            overlayClose.remove();
            overlayClosedForSession = true;
          });
        }
      }
      if (debug) {
        localStorage.setItem('web-vitals-extension-debug', 'TRUE');
        enableLogging = true;
      } else {
        localStorage.removeItem('web-vitals-extension-debug');
        enableLogging = false;
      }
      if (debug) {
        localStorage.setItem('web-vitals-extension-user-timing', 'TRUE');
        enableUserTiming = true;
      } else {
        localStorage.removeItem('web-vitals-extension-user-timing');
        enableUserTiming = false;
      }
    });
  }

  /**
 * Return a short (host) and full URL for the measured page
 * @return {Object}
 */
  function getURL() {
    const url = document.location.href;
    const shortURL = document.location.origin;
    return {shortURL, url};
  }

  /**
   * Return a short timestamp (HH:MM:SS) for current time
   * @return {String}
   */
  function getTimestamp() {
    const date = new Date();
    return date.toLocaleTimeString('en-US', {hourCycle: 'h23'});
  }


  /**
     *
     * Broadcasts metrics updates using chrome.runtime(), triggering
     * updates to the badge. Will also update the overlay if this option
     * is enabled.
     * @param {String} metricName
     * @param {Object} body
     */
  function broadcastMetricsUpdates(metricName, body) {
    if (metricName === undefined || badgeMetrics === undefined) {
      return;
    }
    if (enableLogging) {
      console.log('[Web Vitals]', body.name, body.value.toFixed(2), body);
    }
    if (enableUserTiming) {
      addUserTimings(body);
    }
    badgeMetrics[metricName].value = body.value;
    badgeMetrics.location = getURL();
    badgeMetrics.timestamp = getTimestamp();
    const passes = scoreBadgeMetrics(badgeMetrics);
    // Broadcast metrics updates for badging
    chrome.runtime.sendMessage(
        {
          passesAllThresholds: passes,
          metrics: badgeMetrics,
        },
        (response) => drawOverlay(badgeMetrics, response.tabId),
    );
  }

  function addUserTimings(metric) {
    switch (metric.name) {
      case "LCP":
        // LCP has a loadTime/renderTime (startTime), but not a duration.
        // Could visualize relative to timeOrigin, or from loadTime -> renderTime.
        // Skip for now.
        break;
      case "CLS":
        // CLS has a startTime, but not a duration.
        // Could visualize the time between rendering tasks (Commit-to-Commit).
        // Skip for now.
        break;
      case "INP":
        if (metric.entries.length > 0) {
          const inpEntry = metric.entries[0];

          // RenderTime is an estimate, because duration is rounded, and may get rounded keydown
          // In rare cases it can be less than processingEnd and that breaks performance.measure().
          // Lets make sure its at least 4ms in those cases so you can just barely see it.
          const presentationTime = inpEntry.startTime + inpEntry.duration;
          const adjustedPresentationTime = Math.max(inpEntry.processingEnd + 4, presentationTime);

          performance.measure(`[Web Vitals] INP.duration (${inpEntry.name})`, {
            start: inpEntry.startTime,
            end: presentationTime,
          });
          performance.measure(`[Web Vitals] INP.inputDelay (${inpEntry.name})`, {
            start: inpEntry.startTime,
            end: inpEntry.processingStart,
          });
          performance.measure(`[Web Vitals] INP.processingTime (${inpEntry.name})`, {
            start: inpEntry.processingStart,
            end: inpEntry.processingEnd,
          });
          performance.measure(`[Web Vitals] INP.presentationDelay (${inpEntry.name})`, {
            start: inpEntry.processingEnd,
            end: adjustedPresentationTime,
          });
        }
        break;
      case "FID":
        if (metric.entries.length > 0) {
          const fidEntry = metric.entries[0]
          performance.measure(`[Web Vitals Extension] FID (${fidEntry.name})`, {
            start: fidEntry.startTime,
            end: fidEntry.processingStart,
          });
        }
    }
  }

  /**
   * Broadcasts the latest CLS value
   */
  function broadcastCLS() {
    broadcastMetricsUpdates('cls', latestCLS);
  }

  /**
 * Debounces the broadcast of CLS values for stability.
 * broadcastCLS is invoked on the trailing edge of the
 * DEBOUNCE_DELAY timeout if invoked more than once during
 * the wait timeout.
 */
  let debouncedCLSBroadcast = () => {};
  if (typeof _ !== 'undefined') {
    debouncedCLSBroadcast = _.debounce(broadcastCLS, DEBOUNCE_DELAY, {
      leading: true,
      trailing: true,
      maxWait: 1000});
  }
  /**
 *
 * Fetches Web Vitals metrics via WebVitals.js
 */
  function fetchWebPerfMetrics() {
    // web-vitals.js doesn't have a way to remove previous listeners, so we'll save whether
    // we've already installed the listeners before installing them again.
    // See https://github.com/GoogleChrome/web-vitals/issues/55.
    if (self._hasInstalledPerfMetrics) return;
    self._hasInstalledPerfMetrics = true;

    webVitals.getCLS((metric) => {
      // As CLS values can fire frequently in the case
      // of animations or highly-dynamic content, we
      // debounce the broadcast of the metric.
      latestCLS = metric;
      debouncedCLSBroadcast();
    }, true);
    webVitals.getLCP((metric) => {
      broadcastMetricsUpdates('lcp', metric);
    }, true);
    webVitals.getFID((metric) => {
      broadcastMetricsUpdates('fid', metric);
    }, true);
    webVitals.getINP((metric) => {
      broadcastMetricsUpdates('inp', metric);
    }, true);
  }

  /**
 * Build a template of metrics
 * @param {Object} metrics The metrics
 * @param {Boolean} tabLoadedInBackground
 * @return {String} a populated template of metrics
 */
  function buildOverlayTemplate(metrics, tabLoadedInBackground) {
    return `
    <div id="lh-overlay-container" class="lh-unset lh-root lh-vars dark" style="display: block;">
    <div class="lh-overlay">
    <div class="lh-audit-group lh-audit-group--metrics">
    <div class="lh-audit-group__header">
      <span class="lh-audit-group__title">Metrics</span>
    </div>
    <div class="lh-columns">
      <div class="lh-column">
        <div class="lh-metric lh-metric--${metrics.lcp.pass ? 'pass':'fail'}">
          <div class="lh-metric__innerwrap">
            <div>
              <span class="lh-metric__title">Largest Contentful Paint</span>
              ${tabLoadedInBackground ? '<span class="lh-metric__subtitle">Value inflated as tab was loaded in background</span>' : ''}
            </div>
            <div class="lh-metric__value">${((metrics.lcp.value || 0)/1000).toFixed(2)}&nbsp;s</div>
          </div>
        </div>
        <div class="lh-metric lh-metric--${metrics.cls.pass ? 'pass':'fail'}">
          <div class="lh-metric__innerwrap">
            <span class="lh-metric__title">Cumulative Layout Shift</span>
            <div class="lh-metric__value">${(metrics.cls.value || 0).toFixed(3)}</div>
          </div>
        </div>
        <div class="lh-metric lh-metric--${metrics.fid.pass ? 'pass':'fail'} lh-metric--${metrics.fid.value === null ? 'waiting' : 'ready'}">
          <div class="lh-metric__innerwrap">
            <span class="lh-metric__title">
              First Input Delay
              <span class="lh-metric-state">${metrics.fid.value === null ? '(waiting for input)' : ''}</span>
            </span>
            <div class="lh-metric__value">${
              metrics.fid.value === null ? '' :
              `${metrics.fid.value.toFixed(2)}&nbsp;ms`
            }</div>
          </div>
        </div>
        <div class="lh-metric lh-metric--${metrics.inp.pass ? 'pass':'fail'} lh-metric--${metrics.inp.value === null ? 'waiting' : 'ready'}">
          <div class="lh-metric__innerwrap">
            <span class="lh-metric__title">
              Interaction to Next Paint*
              <span class="lh-metric-state">${metrics.inp.value === null ? '(waiting for input)' : ''}</span>
            </span>
            <div class="lh-metric__value">${
              metrics.inp.value === null ? '' :
              `${metrics.inp.value.toFixed(2)}&nbsp;ms`
            }</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  </div>
  </div>`;
  }

  fetchWebPerfMetrics();
})();
