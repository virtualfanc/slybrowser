import { useState } from "react";
import { snippets, type Language } from "../siteData";
import { Icon } from "./Icons";

const languages: Language[] = ["Node.js", "Python", ".NET"];

function ColorizedCode({ code }: { code: string }) {
  const tokenPattern = /(\/\/.*|#.*|\b(?:import|from|const|await|new|var|profile|screen)\b|"[^"\n]*"|\b\d+\b)/g;

  return (
    <code>
      {code.split("\n").map((line, index) => (
        <span className="code-line" key={`${index}-${line}`}>
          {line.split(tokenPattern).filter(Boolean).map((token, tokenIndex) => {
            let className = "";
            if (token.startsWith("//") || token.startsWith("#")) className = "token-comment";
            else if (token.startsWith('"')) className = "token-string";
            else if (/^\d+$/.test(token)) className = "token-number";
            else if (/^(import|from|const|await|new|var|profile|screen)$/.test(token)) className = "token-keyword";
            return <span className={className} key={`${tokenIndex}-${token}`}>{token}</span>;
          })}
        </span>
      ))}
    </code>
  );
}

export function CodePanel() {
  const [language, setLanguage] = useState<Language>("Node.js");
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    await navigator.clipboard.writeText(snippets[language]);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="code-panel">
      <div className="code-tabs" role="tablist" aria-label="SDK language">
        <div className="code-tab-list">
          {languages.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={language === item}
              onClick={() => setLanguage(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <button className="copy-button" type="button" onClick={copyCode} aria-label={`Copy ${language} example`}>
          <Icon name="copy" size={16} />
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre><ColorizedCode code={snippets[language]} /></pre>
      <div className="code-caption">
        <span>Source-level preview</span>
        <span>APIs may change before public preview</span>
      </div>
    </div>
  );
}
