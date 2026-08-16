import { useEffect } from "react";
import { Header } from "./components/Header";
import { BrowserProduct, Capabilities, Closing, Consistency, Hero, Pricing, Quickstart, TestEvidence, Trust } from "./sections";

export default function App() {
  useEffect(() => {
    const items = document.querySelectorAll<HTMLElement>(".reveal");
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 });

    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);

  return (
    <div id="top">
      <Header />
      <main>
        <Hero />
        <Quickstart />
        <BrowserProduct />
        <Capabilities />
        <TestEvidence />
        <Consistency />
        <Pricing />
        <Trust />
        <Closing />
      </main>
    </div>
  );
}
