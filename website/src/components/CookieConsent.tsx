import { useEffect, useState } from "react";
import {
  getAnalyticsConsent,
  getVisitorConsentRegion,
  updateAnalyticsConsent,
  type AnalyticsConsent,
  type VisitorConsentRegion,
} from "../analytics";

export function CookieConsent() {
  const [consent, setConsent] = useState<AnalyticsConsent>(() => getAnalyticsConsent());
  const [region, setRegion] = useState<VisitorConsentRegion | "loading">("loading");
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    let active = true;

    void getVisitorConsentRegion().then((nextRegion) => {
      if (!active) {
        return;
      }

      if (nextRegion !== "unregulated") {
        if (consent === null) {
          // A failed region lookup is treated conservatively until the visitor decides.
          if (nextRegion === "unknown") {
            updateAnalyticsConsent("denied", { persist: false });
          }
          setIsOpen(true);
        } else {
          updateAnalyticsConsent(consent, { persist: false });
        }
      }

      setRegion(nextRegion);
    });

    return () => {
      active = false;
    };
  }, [consent]);

  const chooseConsent = (nextConsent: Exclude<AnalyticsConsent, null>) => {
    updateAnalyticsConsent(nextConsent);
    setConsent(nextConsent);
    setIsOpen(false);
  };

  if (region === "loading" || region === "unregulated") {
    return null;
  }

  if (!isOpen) {
    return (
      <button
        className="cookie-settings-trigger"
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label={`Cookie settings. Analytics ${consent === "granted" ? "on" : "off"}.`}
      >
        <span>Cookie settings</span>
        <small>Analytics {consent === "granted" ? "on" : "off"}</small>
      </button>
    );
  }

  return (
    <section
      className="cookie-consent"
      role="region"
      aria-labelledby="cookie-consent-title"
      aria-live="polite"
    >
      <div className="cookie-consent-copy">
        <span>Privacy controls</span>
        <h2 id="cookie-consent-title">Choose how analytics may be used.</h2>
        <p>
          Essential storage remembers your choice. With permission, Google Analytics measures page views and
          interactions. Advertising storage, ad user data and ad personalization remain disabled.
        </p>
        <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">
          Google privacy details
        </a>
      </div>
      <div className="cookie-consent-actions">
        <button type="button" onClick={() => chooseConsent("denied")}>Reject optional cookies</button>
        <button type="button" onClick={() => chooseConsent("granted")}>Accept analytics</button>
      </div>
    </section>
  );
}
