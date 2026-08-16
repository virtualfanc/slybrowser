import { useEffect, useState } from "react";
import { Icon } from "./Icons";

const githubUrl = "https://github.com/virtualfanc/slybrowser";

export function Brand() {
  return (
    <a className="brand" href="#top" aria-label="SlyBrowser home">
      <img src="/brand/mark.svg" alt="" />
      <span>SlyBrowser</span>
    </a>
  );
}

export function Header() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);

  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <nav className={open ? "nav-open" : ""} aria-label="Primary navigation">
          <a href="#quickstart" onClick={() => setOpen(false)}>Quickstart</a>
          <a href="#browser" onClick={() => setOpen(false)}>Browser</a>
          <a href="#capabilities" onClick={() => setOpen(false)}>Capabilities</a>
          <a href="#evidence" onClick={() => setOpen(false)}>Evidence</a>
          <a href="#sdks" onClick={() => setOpen(false)}>SDKs</a>
          <a href="#pricing" onClick={() => setOpen(false)}>Pricing</a>
          <a href="#security" onClick={() => setOpen(false)}>Security</a>
          <a className="nav-github" href={githubUrl} target="_blank" rel="noreferrer">GitHub <Icon name="external" size={14} /></a>
        </nav>
        <a className="header-cta" href="#pricing">
          View pricing <Icon name="arrow" size={15} />
        </a>
        <button
          className="menu-button"
          type="button"
          aria-label="Toggle navigation"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="menu" size={22} />
        </button>
      </div>
    </header>
  );
}
