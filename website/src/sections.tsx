import { useState, type ReactNode } from "react";
import { BrowserPreview } from "./components/BrowserPreview";
import { CodePanel } from "./components/CodePanel";
import { Brand } from "./components/Header";
import { Icon, type IconName } from "./components/Icons";
import { getCheckoutUrl, getSubscriptionCheckoutAction, hasConfiguredCheckout, manageSubscriptionsUrl, paidPreviewUrl } from "./billing";
import { benchmarkBrowsers, benchmarkComparisonRows, benchmarkOutcome, capabilities, capabilityEvidence, consistencyRows, focusedTestRuns, pricingPlans, profiles, verificationMetrics, type PricingPlan } from "./siteData";

const githubUrl = "https://github.com/virtualfanc/slybrowser";

function ActionLink({ href, children, secondary = false, external = false }: { href: string; children: ReactNode; secondary?: boolean; external?: boolean }) {
  return (
    <a className={`button ${secondary ? "button-secondary" : "button-primary"}`} href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      <span>{children}</span>
      <Icon name={external ? "external" : "arrow"} size={17} />
    </a>
  );
}

export function Hero() {
  return (
    <section className="hero" id="product">
      <div className="hero-grid">
        <div className="hero-copy reveal">
          <h1>A real Chromium browser for reliable automation.</h1>
          <p>Ship browser automation as one versioned system: native Chromium profiles, a matched W3C WebDriver and test evidence that includes the failures.</p>
          <div className="button-row">
            <ActionLink href="#quickstart">View quickstart</ActionLink>
            <ActionLink href="#evidence" secondary>See verified results</ActionLink>
          </div>
          <div className="preview-line" aria-label="Private preview technology support">
            <span>Private preview</span><i />Chromium 148<i />Matched WebDriver<i />Node.js<i />Python<i />.NET source preview
          </div>
        </div>
        <div className="hero-product reveal">
          <BrowserPreview profile={profiles[0]} compact />
        </div>
      </div>
      <div className="proof-rail reveal" aria-label="Product capabilities">
        <div><Icon name="globe" /><span>Matched Chromium + driver</span></div>
        <div><Icon name="profile" /><span>Isolated profiles</span></div>
        <div><Icon name="contract" /><span>Humanized W3C input</span></div>
        <div><Icon name="shield" /><span>Signed release verification</span></div>
      </div>
    </section>
  );
}

export function Quickstart() {
  return (
    <section className="section quickstart" id="quickstart">
      <div className="quickstart-copy reveal">
        <h2>From config to browser in three moves.</h2>
        <p>Create a profile, launch the matched browser and driver, then automate through the SDK or an explicit framework adapter.</p>
        <ol className="step-list">
          <li><span>01</span><div><strong>Profile</strong><p>Define the runtime environment with one validated contract.</p></div></li>
          <li><span>02</span><div><strong>Launch</strong><p>Prepare the SlyBrowser executable and profile handoff.</p></div></li>
          <li><span>03</span><div><strong>Automate</strong><p>Use the native W3C client or opt into Playwright and Puppeteer adapters.</p></div></li>
        </ol>
      </div>
      <div className="reveal" id="sdks"><CodePanel /></div>
    </section>
  );
}

export function BrowserProduct() {
  const [activeProfile, setActiveProfile] = useState(profiles[0]);

  return (
    <section className="section browser-section" id="browser">
      <div className="browser-heading reveal" id="profiles">
        <div>
          <h2>One profile. Every browser surface.</h2>
          <p>The same runtime settings follow the page, iframe, worker and network route.</p>
        </div>
        <div className="profile-switcher" role="tablist" aria-label="Sample browser profiles">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              role="tab"
              aria-selected={activeProfile.id === profile.id}
              onClick={() => setActiveProfile(profile)}
            >
              <span>{profile.name}</span>
              {activeProfile.id === profile.id && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      </div>
      <div className="reveal browser-stage">
        <BrowserPreview profile={activeProfile} />
      </div>
      <div className="surface-proof reveal">
        <span>Page</span><i /><span>Iframe</span><i /><span>Worker</span><i /><span>WebRTC</span><strong>One launch contract</strong>
      </div>
    </section>
  );
}

export function Capabilities() {
  return (
    <section className="section capability-section" id="capabilities">
      <div className="capability-intro reveal">
        <h2>Browser behavior, controlled at the browser layer.</h2>
        <p>Configure the environment once and launch it the same way across languages and frameworks.</p>
      </div>
      <div className="capability-list reveal">
        {capabilities.map((item) => (
          <article key={item.title}>
            <Icon name={item.icon as IconName} size={31} />
            <div><span className={`capability-status status-${item.status.toLowerCase()}`}>{item.status}</span><h3>{item.title}</h3><p>{item.body}</p></div>
          </article>
        ))}
      </div>
      <div className="evidence-rail reveal" aria-label="Current engineering evidence">
        {capabilityEvidence.map((item) => (
          <div key={item.label}><strong>{item.value}</strong><span>{item.label}</span></div>
        ))}
        <p>Measured project scope, not a promise of acceptance by any third-party site.</p>
      </div>
    </section>
  );
}

export function TestEvidence() {
  return (
    <section className="section evidence-section" id="evidence">
      <div className="evidence-heading reveal">
        <div>
          <span className="section-kicker">Latest verification snapshot</span>
          <h2>Measured, dated and shown with its limits.</h2>
          <p>The browser benchmark is saved evidence from 15 August. SDK and harness suites were rerun on 16 August. Live services can change, so these results are engineering evidence—not a promise that every site will accept a session.</p>
        </div>
        <a className="evidence-link" href={`${githubUrl}/blob/main/docs/benchmark-results-2026-08-15.md`} target="_blank" rel="noreferrer">Read the audit <Icon name="external" size={15} /></a>
      </div>

      <div className="verification-metrics reveal" aria-label="Latest browser verification metrics">
        {verificationMetrics.map((metric) => (
          <article key={metric.label}>
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
            <small>{metric.note}</small>
          </article>
        ))}
      </div>

      <article className="browser-score-comparison reveal" aria-labelledby="browser-score-title">
        <div className="score-comparison-heading">
          <div>
            <span className="section-kicker">Paired comparison</span>
            <h3 id="browser-score-title">SlyBrowser and stock Chromium, side by side.</h3>
          </div>
          <span>Same machine · same time window · headless</span>
        </div>
        <div className="score-browser-grid">
          {benchmarkBrowsers.map((browser) => (
            <section className={`score-browser score-browser-${browser.id}`} key={browser.id}>
              <div>
                <span>{browser.name}</span>
                <small>Chromium {browser.version}</small>
              </div>
              <strong>{browser.score}</strong>
              <dl>
                <div><dt>Raw score</dt><dd>{browser.rawScore}</dd></div>
                <div><dt>Required coverage</dt><dd>{browser.coverage}</dd></div>
              </dl>
              <p>{browser.counts}</p>
            </section>
          ))}
        </div>
        <div className="score-table-wrap">
          <table>
            <thead><tr><th>Metric</th><th>SlyBrowser 148</th><th>Stock Chromium 153</th><th>Measured delta</th></tr></thead>
            <tbody>
              {benchmarkComparisonRows.map((row) => (
                <tr key={row.metric}><td>{row.metric}</td><td>{row.slybrowser}</td><td>{row.chromium}</td><td>{row.delta}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="score-caveat">Version caveat: the saved stock Playwright executable is Chromium 153 while SlyBrowser is Chromium 148. The run is useful operational evidence, but TLS and version-sensitive fingerprint checks are not a strict same-major comparison.</p>
      </article>

      <div className="evidence-detail-grid reveal">
        <article className="focused-tests">
          <div className="evidence-card-heading"><span>Focused suites</span><small>93 / 93 passed across the dated runs</small></div>
          <div className="test-run-list">
            {focusedTestRuns.map((run) => (
              <div key={run.name}>
                <span><Icon name="check" size={17} /><span><strong>{run.name}</strong><small>{run.detail}</small></span></span>
                <b>{run.result}</b>
              </div>
            ))}
          </div>
        </article>

        <article className="benchmark-card">
          <div className="evidence-card-heading"><span>40-entry SlyBrowser run</span><small>W3C WebDriver · 90.16% required coverage</small></div>
          <div className="benchmark-breakdown">
            {benchmarkOutcome.map((outcome) => (
              <div className={`outcome-${outcome.tone}`} key={outcome.label}><strong>{outcome.value}</strong><span>{outcome.label}</span></div>
            ))}
          </div>
          <p>Runner and network errors reduce confidence; they are never converted into invented zero scores. Three owner-authorized endpoints were not configured and remain skipped.</p>
        </article>
      </div>
    </section>
  );
}

export function Consistency() {
  return (
    <section className="section consistency-section">
      <div className="consistency-heading reveal"><h2>Consistency you can inspect.</h2></div>
      <div className="consistency-layout reveal">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Surface</th><th>Applied where</th><th>Outcome</th></tr></thead>
            <tbody>
              {consistencyRows.map((row) => (
                <tr key={row[0]}><td><Icon name={row[0] === "WebRTC" ? "webrtc" : row[0] === "Worker" ? "code" : "contract"} size={19} />{row[0]}</td><td>{row[1]}</td><td>{row[2]}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <aside className="why-native">
          <span className="target-icon"><i /><i /></span>
          <h3>Why below JavaScript?</h3>
          <p>Runtime behavior stays aligned before page scripts execute.</p>
          <a href={`${githubUrl}/blob/main/docs/profile-configuration.md`} target="_blank" rel="noreferrer">Read configuration status <Icon name="external" size={15} /></a>
        </aside>
      </div>
    </section>
  );
}

function PlanAction({ plan }: { plan: PricingPlan }) {
  if (plan.id === "free") {
    return <ActionLink href="https://github.com/virtualfanc/slybrowser" external>Get Free</ActionLink>;
  }

  const checkoutUrl = getCheckoutUrl(plan.id, "monthly");
  const checkoutAction = getSubscriptionCheckoutAction(plan.id, "monthly");
  if (checkoutAction) {
    return (
      <form className="checkout-form" action={checkoutAction} method="post">
        <button className="button button-primary" type="submit">
          <span>Continue with PayNow</span>
          <Icon name="external" size={17} />
        </button>
      </form>
    );
  }
  if (checkoutUrl) {
    return <ActionLink href={checkoutUrl} external>Continue with PayNow</ActionLink>;
  }

  return <ActionLink href={paidPreviewUrl} secondary external>Request paid preview</ActionLink>;
}

export function Pricing() {
  return (
    <section className="section pricing-section" id="pricing">
      <div className="pricing-heading reveal">
        <div>
          <span className="section-kicker">Launch promotion</span>
          <h2>Scale browser processes, not profile files.</h2>
          <p>Five monthly plans share the same browser-quality baseline. Choose by peak concurrency, from one free process to a 2,000-process grid.</p>
        </div>
        <div className="pricing-promo-note"><strong>Monthly promo pricing</strong><span>Same browser. Lower unit cost as concurrency grows.</span></div>
      </div>

      <div className="pricing-grid reveal">
        {pricingPlans.map((plan) => {
          const price = plan.price.monthly;
          return (
            <article className={`pricing-card ${plan.featured ? "pricing-card-featured" : ""}`} key={plan.id}>
              <div className="plan-topline"><span>{plan.name}</span><small>{plan.availability}</small></div>
              <p className="plan-audience">{plan.audience}</p>
              <div className="plan-price"><strong>{price.amount}</strong><span>{price.cadence}</span></div>
              <div className="plan-capacity"><Icon name="globe" size={18} />{plan.concurrency}</div>
              <div className="plan-unit-price">{plan.unitPrice}</div>
              <ul>
                {plan.features.map((feature) => <li key={feature}><Icon name="check" size={16} />{feature}</li>)}
              </ul>
              <PlanAction plan={plan} />
              <small className="checkout-note">
                {plan.id === "free"
                  ? "No payment method required"
                  : getCheckoutUrl(plan.id, "monthly")
                    ? "Recurring checkout handled by PayNow"
                    : "PayNow checkout opens after launch approval"}
              </small>
            </article>
          );
        })}
      </div>

      <div className="billing-disclosure reveal">
        <div>
          <Icon name="time" size={27} />
          <p><strong>Automatic renewal is supported.</strong> Monthly subscriptions renew automatically when the selected payment method supports recurring billing.</p>
        </div>
        <div>
          <Icon name="shield" size={27} />
          <p><strong>Cancellation keeps the paid-through period.</strong> After that, access falls back to the one-process free entitlement and profile data stays local.</p>
        </div>
        <a href={manageSubscriptionsUrl} target="_blank" rel="noreferrer">Manage PayNow subscriptions <Icon name="external" size={15} /></a>
      </div>

      <div className="enterprise-line reveal">
        <span>Enterprise & OEM/SaaS</span>
        <p>Custom capacity, LTS, offline deployment, SSO or third-party embedding are separately scoped and only sold when the required delivery controls are ready.</p>
        <ActionLink href={paidPreviewUrl} secondary external>Discuss requirements</ActionLink>
      </div>

      <p className="pricing-status reveal">
        {hasConfiguredCheckout
          ? "Configured PayNow product links are active. Entitlement activation still depends on the production webhook and license authority."
          : "Promotional monthly prices are published. Hosted PayNow product links remain inactive until the paid-preview launch gate is approved."}
      </p>
    </section>
  );
}

function ReleaseStep({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return <div className="release-step"><span><Icon name={icon} size={34} /></span><strong>{title}</strong><small>{detail}</small></div>;
}

export function Trust() {
  return (
    <section className="section trust-section" id="security">
      <div className="trust-layout">
        <div className="trust-copy reveal">
          <h2>Built to ship as one verified system.</h2>
          <p>Browser artifacts and SDKs share one release manifest. Release signing and clearance remain gates before public preview.</p>
          <div className="release-chain">
            <ReleaseStep icon="contract" title="Build" detail="Browser + SDKs" />
            <Icon name="arrow" className="release-arrow" />
            <ReleaseStep icon="code" title="Sign" detail="Release manifest" />
            <Icon name="arrow" className="release-arrow" />
            <ReleaseStep icon="shield" title="Verify" detail="SHA-256 before launch" />
          </div>
        </div>
        <div className="manifest-panel reveal">
          <div className="manifest-title"><span><i /><i /><i /></span><code>manifest.json</code></div>
          <pre><code>{`{
  "version": "0.1.0",
  "artifacts": [
    { "name": "<artifact>",
      "sha256": "<sha256>" }
  ],
  "signature": "<signature>"
}`}</code></pre>
          <div className="manifest-note"><Icon name="shield" size={16} /> Canonical manifest · offline verification</div>
        </div>
      </div>
      <div className="responsible reveal">
        <Icon name="shield" size={42} />
        <div><h3>Automation with clear boundaries.</h3><p>SlyBrowser is intended for authorized testing, repeatable QA and responsible automation.</p></div>
        <a href={`${githubUrl}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">Responsible use <Icon name="external" size={15} /></a>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <>
      <section className="section closing-section reveal">
        <div className="closing-visual" aria-hidden="true"><span /><i>{`</>`}</i></div>
        <div>
          <h2>Choose the capacity your automation actually needs.</h2>
          <p>Start with one browser process, validate a real workflow and expand only when the signed delivery and entitlement gates are ready.</p>
          <div className="button-row">
            <ActionLink href="#pricing">Compare plans</ActionLink>
            <ActionLink href={githubUrl} secondary external>View on GitHub</ActionLink>
          </div>
        </div>
      </section>
      <footer>
        <div className="footer-inner">
          <div className="footer-brand"><Brand /><p>Chromium browser infrastructure<br />for responsible automation.</p></div>
          <div className="footer-group"><strong>Product</strong><a href="#quickstart">Quickstart</a><a href="#browser">Browser</a><a href="#pricing">Pricing</a></div>
          <div className="footer-group"><strong>Developers</strong><a href="#capabilities">Capabilities</a><a href="#evidence">Test evidence</a><a href="#sdks">SDKs</a><a href="#security">Security</a><a href={manageSubscriptionsUrl} target="_blank" rel="noreferrer">Manage billing</a></div>
          <p className="footer-note">Independent Chromium project.<br />Not affiliated with Google.</p>
        </div>
      </footer>
    </>
  );
}
