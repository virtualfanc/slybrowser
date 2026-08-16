import type { Profile } from "../siteData";
import { Icon, type IconName } from "./Icons";

const fields: Array<{ icon: IconName; label: string; key: keyof Profile }> = [
  { icon: "globe", label: "Locale", key: "locale" },
  { icon: "time", label: "Timezone", key: "timezone" },
  { icon: "screen", label: "Screen", key: "screen" },
  { icon: "geo", label: "Geolocation", key: "coordinates" },
  { icon: "proxy", label: "Proxy", key: "proxy" },
  { icon: "webrtc", label: "WebRTC", key: "webrtc" },
];

function ProductPage({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="example-page">
        <div className="example-card">
          <div className="example-mark">S</div>
          <span>Automation workspace</span>
          <h3>Browser context ready.</h3>
          <p>This page is rendered inside the SlyBrowser product preview.</p>
          <div className="example-lines"><i /><i /><i /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="docs-page">
      <aside>
        <strong>SlyBrowser Docs</strong>
        <span>Overview</span><span>Quickstart</span><span className="selected">Profiles</span><span>SDKs</span><span>Security</span>
      </aside>
      <article>
        <span className="docs-path">GUIDE / PROFILES</span>
        <h3>Profiles</h3>
        <p>One launch contract shapes how the browser instance presents to the web.</p>
        <div className="profile-json">
          <span>{`{`}</span>
          <span>&nbsp;&nbsp;<b>"locale"</b>: "fr-FR",</span>
          <span>&nbsp;&nbsp;<b>"timezone"</b>: "Europe/Paris",</span>
          <span>&nbsp;&nbsp;<b>"screen"</b>: {`{ "width": 1440, "height": 900 }`},</span>
          <span>&nbsp;&nbsp;<b>"webrtc"</b>: "proxy"</span>
          <span>{`}`}</span>
        </div>
        <div className="surface-strip"><span>Page</span><span>Iframe</span><span>Worker</span><span>Network</span></div>
      </article>
    </div>
  );
}

export function BrowserPreview({ profile, compact = false }: { profile: Profile; compact?: boolean }) {
  return (
    <div className={`browser-window ${compact ? "browser-window-compact" : ""}`}>
      <div className="browser-tabs">
        <div className="traffic-lights"><i /><i /><i /></div>
        <div className="browser-tab active-tab"><span className="tab-favicon">S</span>{compact ? "Automation workspace" : "SlyBrowser Documentation"}<button aria-label="Close tab">×</button></div>
        <div className="browser-tab muted-tab">New tab</div>
        <button className="new-tab" aria-label="New tab">+</button>
      </div>
      <div className="browser-toolbar">
        <div className="toolbar-controls" aria-hidden="true"><span>‹</span><span>›</span><span>↻</span></div>
        <div className="address-bar"><span className="address-lock">◆</span>{compact ? "example.com/workspace" : "docs.slybrowser.dev/guide/profiles"}</div>
        <div className="toolbar-menu" aria-hidden="true">⋮</div>
      </div>
      <div className="browser-content">
        <ProductPage compact={compact} />
        <aside className="profile-inspector" aria-label={`${profile.name} profile settings`}>
          <div className="inspector-title">
            <span><Icon name="profile" size={18} /> Profile</span>
            <span className="inspector-status"><i /> applied</span>
          </div>
          {!compact && <div className="profile-name"><span>Active profile</span><strong>{profile.name}</strong></div>}
          <div className="inspector-fields">
            {fields.filter((field) => !compact || field.key !== "coordinates").map((field) => (
              <div className="inspector-row" key={field.label}>
                <Icon name={field.icon} size={18} />
                <span><small>{field.label}</small><strong>{profile[field.key]}</strong></span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
