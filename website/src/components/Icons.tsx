export type IconName =
  | "arrow"
  | "check"
  | "code"
  | "contract"
  | "copy"
  | "external"
  | "geo"
  | "globe"
  | "menu"
  | "profile"
  | "proxy"
  | "puzzle"
  | "screen"
  | "settings"
  | "shield"
  | "time"
  | "webrtc";

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.65,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };

  if (name === "arrow") return <svg {...common}><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
  if (name === "check") return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
  if (name === "copy") return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
  if (name === "external") return <svg {...common}><path d="M14 5h5v5M19 5l-8 8" /><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>;
  if (name === "menu") return <svg {...common}><path d="M4 8h16M4 16h16" /></svg>;
  if (name === "globe") return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>;
  if (name === "time") return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
  if (name === "screen") return <svg {...common}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
  if (name === "geo") return <svg {...common}><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></svg>;
  if (name === "proxy") return <svg {...common}><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M6 16v-4h12v4" /></svg>;
  if (name === "webrtc") return <svg {...common}><path d="M2 12h4l2-6 4 13 3-9 2 5h5" /></svg>;
  if (name === "profile") return <svg {...common}><circle cx="12" cy="8" r="3.5" /><path d="M5 21c.5-5 3-7.5 7-7.5S18.5 16 19 21" /></svg>;
  if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></svg>;
  if (name === "puzzle") return <svg {...common}><path d="M8 3h4a2 2 0 1 1 4 0h5v6a2 2 0 1 0 0 4v8h-7a2 2 0 1 0-4 0H3v-7a2 2 0 1 0 0-4V3h5Z" /></svg>;
  if (name === "contract") return <svg {...common}><path d="M6 2h8l4 4v16H6zM14 2v5h5" /><path d="m10 12-2 2 2 2M14 12l2 2-2 2" /></svg>;
  if (name === "shield") return <svg {...common}><path d="M12 2 20 5v6c0 5-3 8.5-8 11-5-2.5-8-6-8-11V5z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></svg>;
  return <svg {...common}><path d="m9 7-5 5 5 5M15 7l5 5-5 5M13.5 4 10 20" /></svg>;
}
