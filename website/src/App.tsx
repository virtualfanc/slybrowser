import { useEffect } from "react";
import { AdminOrders } from "./AdminOrders";
import { BillingOrder } from "./BillingOrder";
import { BillingResult } from "./BillingResult";
import { CookieConsent } from "./components/CookieConsent";
import { Header } from "./components/Header";
import { BrowserProduct, Capabilities, Closing, Consistency, Feedback, Hero, LegalPolicies, Pricing, Quickstart, TestEvidence, Trust } from "./sections";

export default function App() {
  const billingResult = window.location.pathname === "/billing/result";
  const billingOrder = window.location.pathname === "/billing/order";
  const adminOrders = window.location.pathname === "/admin/orders";
  const legalPolicies = window.location.pathname === "/legal";

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
    <>
      <div id="top">
        <Header />
        <main>
          {adminOrders ? (
            <AdminOrders />
          ) : legalPolicies ? (
            <LegalPolicies />
          ) : billingOrder ? (
            <BillingOrder />
          ) : billingResult ? (
            <BillingResult />
          ) : (
            <>
              <Hero />
              <Quickstart />
              <BrowserProduct />
              <Capabilities />
              <TestEvidence />
              <Consistency />
              <Pricing />
              <Feedback />
              <Trust />
              <Closing />
            </>
          )}
        </main>
      </div>
      <CookieConsent />
    </>
  );
}
