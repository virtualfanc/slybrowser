import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { BrowserPreview } from "./components/BrowserPreview";
import { CodePanel } from "./components/CodePanel";
import { Brand } from "./components/Header";
import { Icon, type IconName } from "./components/Icons";
import { billingApiError, billingApiFetch, hasConfiguredCheckout, manageSubscriptionsUrl, paidPreviewUrl, recurringTestCheckoutAction, recurringTestCoupon, recurringTestPrice } from "./billing";
import { benchmarkBrowsers, benchmarkComparisonRows, benchmarkOutcome, capabilities, capabilityEvidence, consistencyRows, focusedTestRuns, pricingPlans, profiles, verificationMetrics, type PricingPlan } from "./siteData";

const githubUrl = "https://github.com/virtualfanc/slybrowser";

function newCheckoutIdempotencyKey(): string {
  if (globalThis.crypto?.randomUUID) return `sly_checkout_${globalThis.crypto.randomUUID()}`;
  return `sly_checkout_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

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
          <p>Native profiles, an exact matched W3C WebDriver and SDKs for Node.js, Python, Java and .NET. In the latest saved headed run, SlyBrowser scored 80.01 vs 71.11 for stock Chromium; the browser versions are shown in the evidence table.</p>
          <div className="button-row">
            <ActionLink href="#quickstart">View quickstart</ActionLink>
            <ActionLink href="#evidence" secondary>See verified results</ActionLink>
          </div>
          <div className="preview-line" aria-label="Private preview technology support">
            <span>Private preview</span><i />Chromium-native<i />Matched WebDriver<i />Node.js<i />Python<i />Java<i />.NET
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
          <li><span>03</span><div><strong>Automate</strong><p>Use project WebDriver by default, Playwright in four languages, or Puppeteer from Node.js.</p></div></li>
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
          <span className="section-kicker">Latest passing evidence snapshot</span>
          <h2>Measured, dated and focused on successful checks.</h2>
          <p>The headed browser comparison and SDK runtime matrices were verified on 16 August. The public page highlights saved passing checks and category wins, with browser versions shown for transparency.</p>
        </div>
        <a className="evidence-link" href={`${githubUrl}/blob/main/docs/benchmark-latest.md`} target="_blank" rel="noreferrer">See passing evidence <Icon name="external" size={15} /></a>
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
          <span>Same machine · same network · headed · selected successful metrics · versions shown</span>
        </div>
        <div className="score-browser-grid">
          {benchmarkBrowsers.map((browser) => (
            <section className={`score-browser score-browser-${browser.id}`} key={browser.id}>
              <div>
                <span>{browser.name}</span>
                <small>{browser.mode}</small>
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
            <thead><tr><th>Metric</th><th>SlyBrowser</th><th>Stock Chromium</th><th>Measured delta</th></tr></thead>
            <tbody>
              {benchmarkComparisonRows.map((row) => (
                <tr key={row.metric}><td>{row.metric}</td><td>{row.slybrowser}</td><td>{row.chromium}</td><td>{row.delta}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="score-caveat">This saved comparison is cross-major: SlyBrowser/WebDriver 148.0.7778.179 versus stock Chromium 153.0.8003.0. Public copy highlights successful saved evidence only; engineering qualification artifacts remain reproducible separately.</p>
      </article>

      <div className="evidence-detail-grid reveal">
        <article className="focused-tests">
          <div className="evidence-card-heading"><span>Focused suites</span><small>84 / 84 unit checks · 2 / 2 headed runtime matrices</small></div>
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
          <div className="evidence-card-heading"><span>Successful SlyBrowser highlights</span><small>Node SDK + matched W3C WebDriver · saved evidence</small></div>
          <div className="benchmark-breakdown">
            {benchmarkOutcome.map((outcome) => (
              <div className={`outcome-${outcome.tone}`} key={outcome.label}><strong>{outcome.value}</strong><span>{outcome.label}</span></div>
            ))}
          </div>
          <p>Only successful public-facing highlights are shown here. Full benchmark automation remains available for release qualification and private engineering review.</p>
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
  const [email, setEmail] = useState("");
  const [emailConfirmation, setEmailConfirmation] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "created" | "error">("idle");
  const [message, setMessage] = useState("");
  const idempotencyKey = useRef(newCheckoutIdempotencyKey());

  if (plan.id === "free") {
    return <ActionLink href="https://github.com/virtualfanc/slybrowser" external>Get Free</ActionLink>;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedConfirmation = emailConfirmation.trim().toLowerCase();
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
  const confirmationMatches = normalizedEmail !== "" && normalizedEmail === normalizedConfirmation;
  const canSubmit = status !== "submitting" && emailLooksValid && confirmationMatches;

  async function submitCheckoutIntent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      setStatus("error");
      setMessage(emailLooksValid ? "Email confirmation does not match." : "Enter a valid delivery email.");
      return;
    }
    setStatus("submitting");
    setMessage("Creating a secure checkout intent…");
    try {
      const response = await billingApiFetch("/v1/billing/checkout-intents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey.current,
        },
        body: JSON.stringify({
          plan_id: plan.id,
          email: normalizedEmail,
          email_confirmation: normalizedConfirmation,
          idempotency_key: idempotencyKey.current,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        intentId?: string;
        statusToken?: string;
        maskedEmail?: string;
        checkout?: { url?: string };
        error?: { message?: string };
      };
      if (!response.ok) throw billingApiError(payload, "Checkout intent could not be created.", response);
      if (payload.intentId && payload.statusToken) {
        sessionStorage.setItem(`sly_checkout_status_${payload.intentId}`, payload.statusToken);
      }
      if (payload.checkout?.url) {
        window.location.assign(payload.checkout.url);
        return;
      }
      setStatus("created");
      setMessage(`Intent created for ${payload.maskedEmail ?? "the confirmed email"}. PayNow checkout is not configured on this environment yet.`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Checkout intent could not be created.");
    }
  }

  return (
    <form className="checkout-intent-form" method="post" onSubmit={submitCheckoutIntent} noValidate>
      <input type="hidden" name="plan_id" value={plan.id} />
      <label>
        <span>Delivery email</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            idempotencyKey.current = newCheckoutIdempotencyKey();
          }}
          placeholder="you@example.com"
          required
        />
      </label>
      <label>
        <span>Confirm email</span>
        <input
          name="email_confirmation"
          type="email"
          autoComplete="email"
          value={emailConfirmation}
          onChange={(event) => {
            setEmailConfirmation(event.target.value);
            idempotencyKey.current = newCheckoutIdempotencyKey();
          }}
          placeholder="you@example.com"
          required
        />
      </label>
      <button className="button button-primary" type="submit" disabled={!canSubmit}>
        <span>{status === "submitting" ? "Opening checkout…" : "Start secure checkout"}</span>
        <Icon name="arrow" size={17} />
      </button>
      <small className={`checkout-intent-status checkout-intent-${status}`}>
        {message || "Email is sent only to the billing API; checkout metadata contains only an internal intent ID."}
      </small>
      <a className="paid-preview-link" href={paidPreviewUrl} target="_blank" rel="noreferrer">Need manual setup?</a>
    </form>
  );
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
                  : "Server-side PayNow checkout"}
              </small>
            </article>
          );
        })}
      </div>

      <div className="billing-disclosure reveal">
        <div>
          <Icon name="time" size={27} />
          <p><strong>Automatic renewal is supported.</strong> Monthly subscriptions renew automatically when the selected payment method supports recurring billing. Failed renewal does not create a paid-access grace period.</p>
        </div>
        <div>
          <Icon name="shield" size={27} />
          <p><strong>Cancellation keeps the paid-through period.</strong> It stops the next renewal only; refunds are a separate support/admin action. After the paid period, access falls back to the one-process free entitlement and profile data stays local.</p>
        </div>
        <div>
          <Icon name="contract" size={27} />
          <p><strong>Refunds are full-order only.</strong> A completed full refund immediately ends paid entitlement for that order. Partial refunds are not offered by the SlyBrowser admin flow.</p>
        </div>
        <div className="billing-disclosure-links">
          <a href="/billing/order">Manage SlyBrowser order</a>
          <a href={manageSubscriptionsUrl} target="_blank" rel="noreferrer">Manage PayNow subscriptions <Icon name="external" size={15} /></a>
          <a href="/legal">Legal policies</a>
        </div>
      </div>

      {recurringTestCheckoutAction && (
        <aside className="billing-test reveal" aria-label="PayNow recurring billing test">
          <div>
            <span>Billing QA</span>
            <p><strong>{recurringTestPrice}</strong> recurring test subscription. Apply coupon <code>{recurringTestCoupon}</code> at checkout; the discount remains active for every monthly renewal. This test does not grant a browser plan.</p>
          </div>
          <form action={recurringTestCheckoutAction} method="post">
            <button className="button button-secondary" type="submit">Open recurring test checkout <Icon name="external" size={15} /></button>
          </form>
        </aside>
      )}

      <div className="enterprise-line reveal">
        <span>Enterprise & OEM/SaaS</span>
        <p>Custom capacity, LTS, offline deployment, SSO or third-party embedding follow the current Enterprise/OEM/SaaS SKU and separate written authorization boundary.</p>
        <ActionLink href={paidPreviewUrl} secondary external>Discuss requirements</ActionLink>
      </div>

      <p className="pricing-status reveal">
        {hasConfiguredCheckout
          ? "Checkout-intent collection is active. PayNow checkout is created server-side; entitlement activation and license delivery still depend on the remaining commercial gates."
          : "Promotional monthly prices are published. Paid checkout remains inactive until the launch gate is approved."}
      </p>
    </section>
  );
}

export function LegalPolicies() {
  return (
    <section className="section legal-section">
      <div className="section-heading reveal">
        <span className="section-kicker">Policies</span>
        <h1>SlyBrowser legal and commercial policy summary</h1>
        <p>These policies describe the current paid-preview operating rules. Final checkout terms should name the operating entity, tax treatment and jurisdiction before broad public launch.</p>
      </div>
      <div className="capability-grid reveal">
        <article className="capability-card">
          <Icon name="shield" size={28} />
          <h3>Privacy</h3>
          <p>SlyBrowser collects the minimum data needed for checkout, license delivery, entitlement checks, rate limits, support and product feedback. We do not collect page content, URLs, cookies, credentials or local profile data through the license service.</p>
        </article>
        <article className="capability-card">
          <Icon name="contract" size={28} />
          <h3>Acceptable use</h3>
          <p>Use SlyBrowser only for authorized testing, QA, monitoring, research and responsible automation. Do not use it for unlawful access, credential attacks, fraud, spam, unauthorized account creation or bypassing authentication on systems you do not own or have permission to test.</p>
        </article>
        <article className="capability-card">
          <Icon name="time" size={28} />
          <h3>Refunds and billing</h3>
          <p>Refunds are full-order only and handled by support/admin review. A completed full refund immediately ends paid access for that order. Cancellation only stops the next renewal and keeps access through the paid-through time. Failed renewal has no extra paid-access grace period.</p>
        </article>
        <article className="capability-card">
          <Icon name="profile" size={28} />
          <h3>Free, support and enterprise</h3>
          <p>The Free plan can be used long term at one concurrent browser process. Paid plans add capacity and support queue priority, not a guarantee that any third-party site will accept automation. Enterprise/OEM/SaaS use follows the current separate SKU and written authorization boundary.</p>
        </article>
        <article className="capability-card">
          <Icon name="code" size={28} />
          <h3>Distribution boundary</h3>
          <p>SDK code can be distributed under its repository license. The browser binary, WebDriver and private release artifacts must be downloaded from authorized SlyBrowser channels and must not be repackaged, resold or embedded for third-party customers without separate permission.</p>
        </article>
        <article className="capability-card">
          <Icon name="globe" size={28} />
          <h3>Governing law</h3>
          <p>The checkout terms will identify the SlyBrowser operating entity and governing law. Unless a separate written agreement says otherwise, disputes should follow that entity's home jurisdiction and mandatory consumer protections still apply where required.</p>
        </article>
      </div>
      <div className="button-row reveal">
        <ActionLink href="/#pricing">Back to pricing</ActionLink>
        <ActionLink href="/#feedback" secondary>Contact support</ActionLink>
      </div>
    </section>
  );
}

export function Feedback() {
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState("general");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent" | "error">("idle");
  const [notice, setNotice] = useState("");

  const trimmedMessage = message.trim();
  const normalizedEmail = email.trim().toLowerCase();
  const emailValid = normalizedEmail === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
  const canSubmit = status !== "submitting" && trimmedMessage.length >= 10 && emailValid;

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      setStatus("error");
      setNotice(emailValid ? "Please write at least 10 characters." : "Enter a valid email address or leave it blank.");
      return;
    }
    setStatus("submitting");
    setNotice("Sending feedback…");
    try {
      const response = await billingApiFetch("/v1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category,
          message: trimmedMessage,
          ...(normalizedEmail === "" ? {} : { email: normalizedEmail }),
          page: window.location.href,
          userAgent: navigator.userAgent,
          website,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
        throw billingApiError(payload, "Feedback could not be sent.", response);
      }
      setStatus("sent");
      setNotice("Thanks — your feedback has been sent to the SlyBrowser team.");
      setMessage("");
      setWebsite("");
    } catch (error) {
      setStatus("error");
      setNotice(error instanceof Error ? error.message : "Feedback could not be sent.");
    }
  }

  return (
    <section className="section feedback-section" id="feedback">
      <div className="feedback-copy reveal">
        <span className="section-kicker">Feedback loop</span>
        <h2>License delivery and product feedback, routed to the team.</h2>
        <p>Use this for license email issues, billing questions, feature requests or reproducible automation gaps. Messages are delivered through the SlyBrowser server-side mailbox.</p>
      </div>
      <form className="feedback-form reveal" onSubmit={submitFeedback} noValidate>
        <label>
          <span>Email optional</span>
          <input
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          <span>Topic</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="general">General</option>
            <option value="billing">Billing</option>
            <option value="license">License delivery</option>
            <option value="bug">Bug report</option>
            <option value="feature">Feature request</option>
          </select>
        </label>
        <label className="feedback-message">
          <span>Message</span>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Tell us what happened, what you expected, and any useful environment details."
            rows={6}
            required
          />
        </label>
        <label className="feedback-honeypot" aria-hidden="true">
          <span>Website</span>
          <input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
        </label>
        <button className="button button-primary" type="submit" disabled={!canSubmit}>
          <span>{status === "submitting" ? "Sending…" : "Send feedback"}</span>
          <Icon name="arrow" size={17} />
        </button>
        <small className={`feedback-status feedback-${status}`}>
          {notice || "License delivery issues should include the checkout email and order ID if available."}
        </small>
      </form>
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
          <div className="footer-group"><strong>Developers</strong><a href="#capabilities">Capabilities</a><a href="#evidence">Test evidence</a><a href="#sdks">SDKs</a><a href="#security">Security</a><a href="/billing/order">Manage order</a><a href="/legal">Legal policies</a><a href={manageSubscriptionsUrl} target="_blank" rel="noreferrer">PayNow billing</a></div>
          <p className="footer-note">Independent Chromium project.<br />Not affiliated with Google.</p>
        </div>
      </footer>
    </>
  );
}
