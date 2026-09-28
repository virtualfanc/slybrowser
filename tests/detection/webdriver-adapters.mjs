const DEVICE_DETAIL_FLAGS = [
  "hasBotUserAgent",
  "hasWebdriverTrue",
  "hasWebdriverInFrameTrue",
  "isPlaywright",
  "hasInconsistentChromeObject",
  "isPhantom",
  "isNightmare",
  "isSequentum",
  "isSeleniumChromeDefault",
  "isHeadlessChrome",
  "isWebGLInconsistent",
  "hasInconsistentWebGLShaderLang",
  "hasInconsistentTimingResolution",
  "isAutomatedWithCDP",
  "isAutomatedWithCDPInWebWorker",
  "hasInconsistentClientHints",
  "hasInconsistentGPUFeatures",
  "isIframeOverridden",
  "hasInconsistentWorkerValues",
  "hasHighHardwareConcurrency",
  "hasHeadlessChromeDefaultScreenResolution",
  "hasSuspiciousWeakSignals",
];
const DEVICE_FLAGS = ["isBot", ...DEVICE_DETAIL_FLAGS];
const DEVICE_INTERACTION_FLAGS = [
  "isBot",
  "suspiciousClientSideBehavior",
  "superHumanSpeed",
  "hasCDPMouseLeak",
  ...DEVICE_DETAIL_FLAGS,
];

export function evaluateCoreSignals(common) {
  const checks = {
    navigatorWebdriver: common.webdriver === false,
    plugins: common.pluginsLength >= 5,
    windowChrome: common.windowChromeType === "object",
    userAgent: common.userAgent.includes("Chrome/") && !common.userAgent.includes("HeadlessChrome"),
    cdpGlobals: common.cdpGlobals.length === 0,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const score = passed / Object.keys(checks).length * 100;
  return { status: score === 100 ? "PASS" : "FAIL", score, metrics: { checks, common } };
}

export function parseIncolumitas(bodyText) {
  const passed = [...bodyText.matchAll(/"([^"\r\n]+)"\s*:\s*"OK"/g)].map((match) => match[1]);
  const failed = [...bodyText.matchAll(/"([^"\r\n]+)"\s*:\s*"FAIL"/g)].map((match) => match[1]);
  const behavioral = Number(bodyText.match(/behavioralClassificationScore[^0-9]+([01](?:\.\d+)?)/i)?.[1] ?? NaN);
  const total = passed.length + failed.length;
  return {
    status: total && !failed.length ? "PASS" : "FAIL",
    score: total ? passed.length / total * 100 : 0,
    metrics: { passed, failed, behavioralScore: Number.isFinite(behavioral) ? behavioral : null },
  };
}

export function parseBrowserScan(bodyText) {
  const labels = ["Webdriver", "User-Agent", "CDP", "Navigator"];
  const mainVerdict = bodyText.match(/Test Results:\s*(Normal|Abnormal|Robot)\b/i)?.[1] ?? null;
  if (mainVerdict) {
    const isNormal = mainVerdict.toLowerCase() === "normal";
    return {
      status: isNormal ? "PASS" : "FAIL",
      score: isNormal ? 100 : 0,
      metrics: {
        normal: isNormal ? labels.length : 0,
        abnormal: isNormal ? 0 : labels.length,
        expected: labels.length,
        results: Object.fromEntries(labels.map((label) => [label, isNormal])),
        mainVerdict,
        source: "main-verdict",
      },
    };
  }
  const results = {};
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const near = bodyText.match(new RegExp(`${escaped}[\\s\\S]{0,160}?(Normal|Abnormal)`, "i"));
    results[label] = near ? near[1].toLowerCase() === "normal" : null;
  }
  const known = Object.values(results).filter((value) => value !== null);
  const normal = known.filter(Boolean).length;
  const abnormal = known.filter((value) => !value).length;
  return {
    status: known.length === labels.length && abnormal === 0 ? "PASS" : "FAIL",
    score: known.length ? normal / known.length * 100 : 0,
    metrics: { normal, abnormal, expected: labels.length, results, source: "details" },
  };
}

export function parseDeviceInfo(bodyText) {
  const flags = Object.fromEntries(DEVICE_FLAGS.map((name) => {
    const pattern = new RegExp(`(?:"${name}"|\\b${name}\\b)\\s*[:=]\\s*(true|false)\\b(?!\\s+if\\b)`, "i");
    const match = bodyText.match(pattern);
    return [name, match ? match[1].toLowerCase() === "true" : null];
  }));
  const known = Object.values(flags).filter((value) => value !== null);
  const trueCount = known.filter(Boolean).length;
  const knownDetails = DEVICE_DETAIL_FLAGS
    .map((name) => flags[name])
    .filter((value) => value !== null);
  const trueDetails = DEVICE_DETAIL_FLAGS.filter((name) => flags[name] === true);
  const detailScore = knownDetails.length
    ? (knownDetails.length - trueDetails.length) / knownDetails.length * 100
    : null;
  if (!known.length) {
    return {
      status: "EVIDENCE",
      score: null,
      metrics: {
        flags,
        knownCount: 0,
        trueCount: 0,
        detailKnownCount: 0,
        detailTrueCount: 0,
        trueDetails: [],
        detailScore: null,
        reason: "No machine-readable detection result was rendered",
      },
    };
  }
  return {
    status: flags.isBot === false && trueCount === 0 ? "PASS" : "FAIL",
    score: (known.length - trueCount) / known.length * 100,
    metrics: {
      flags,
      knownCount: known.length,
      trueCount,
      detailKnownCount: knownDetails.length,
      detailTrueCount: trueDetails.length,
      trueDetails,
      detailScore,
    },
  };
}

export function parseDeviceInteractions(bodyText) {
  const flags = Object.fromEntries(DEVICE_INTERACTION_FLAGS.map((name) => {
    const pattern = new RegExp(`(?:"${name}"|\\b${name}\\b)\\s*[:=]\\s*(true|false)\\b(?!\\s+if\\b)`, "i");
    const match = bodyText.match(pattern);
    return [name, match ? match[1].toLowerCase() === "true" : null];
  }));
  const known = Object.values(flags).filter((value) => value !== null);
  const trueCount = known.filter(Boolean).length;
  const trueDetails = DEVICE_INTERACTION_FLAGS
    .filter((name) => name !== "isBot" && flags[name] === true);
  if (!known.length) {
    return {
      status: "EVIDENCE",
      score: null,
      metrics: {
        flags,
        knownCount: 0,
        trueCount: 0,
        trueDetails: [],
        reason: "The interaction test did not render a machine-readable result after submission",
      },
    };
  }
  return {
    status: flags.isBot === false && trueCount === 0 ? "PASS" : "FAIL",
    score: (known.length - trueCount) / known.length * 100,
    metrics: { flags, knownCount: known.length, trueCount, trueDetails },
  };
}

export function parseRecaptcha(bodyText, threshold = 0.7, expectedAction = null) {
  const score = Number(bodyText.match(/"score"\s*:\s*([01](?:\.\d+)?)/i)?.[1] ?? NaN);
  const successMatch = bodyText.match(/"success"\s*:\s*(true|false)/i);
  const action = bodyText.match(/"action"\s*:\s*"([^"]+)"/i)?.[1] ?? null;
  const success = successMatch ? successMatch[1].toLowerCase() === "true" : null;
  if (!Number.isFinite(score)) {
    return { status: "EVIDENCE", score: null, metrics: { recaptchaScore: null, success, action, threshold, expectedAction } };
  }
  const actionMatches = !expectedAction || action === expectedAction;
  const passed = success !== false && score >= threshold && actionMatches;
  return {
    status: passed ? "PASS" : "FAIL",
    score: score * 100,
    metrics: { recaptchaScore: score, success, action, threshold, expectedAction, actionMatches },
  };
}

export function parseConfiguredVerdict(bodyText, passPatterns = [], failPatterns = []) {
  const matchingPassPattern = passPatterns.find((pattern) => new RegExp(pattern, "i").test(bodyText)) ?? null;
  const matchingFailPattern = failPatterns.find((pattern) => new RegExp(pattern, "i").test(bodyText)) ?? null;
  const passed = Boolean(matchingPassPattern) && !matchingFailPattern;
  return {
    status: passed ? "PASS" : "FAIL",
    score: passed ? 100 : 0,
    metrics: { matchingPassPattern, matchingFailPattern },
  };
}

export function extractTlsFingerprints(document) {
  if (!document || typeof document !== "object") return null;
  return {
    ja3: document.tls?.ja3_hash ?? document.tls?.ja3 ?? null,
    ja4: document.tls?.ja4 ?? null,
    peetprint: document.tls?.peetprint_hash ?? document.tls?.peetprint ?? null,
    akamai: document.http2?.akamai_fingerprint_hash ?? document.http2?.akamai_fingerprint ?? null,
  };
}
