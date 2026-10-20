import { useState } from "react";

type HealthResult = {
  status: string;
  service: string;
  network: string;
};

export default function App() {
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  async function checkBackend() {
    setChecking(true);
    setError("");
    try {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
      setHealth((await response.json()) as HealthResult);
    } catch {
      setError("Backend not reachable yet. Start both apps with pnpm dev.");
      setHealth(null);
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="heder1 home">
          <span className="brand-mark">h1</span>
          <span>heder<span className="accent">1</span></span>
        </a>
        <span className="network-pill"><span className="pulse" /> HEDERA TESTNET · PLANNED</span>
      </header>

      <section className="hero">
        <p className="eyebrow">AUTONOMOUS PAYMENTS · BUILT WITH GUARDRAILS</p>
        <h1>Let agents pay.<br /><span className="muted">Never let them overspend.</span></h1>
        <p className="intro">
          heder1 is a security-first payment layer for AI agents. Agents will discover paid
          services and settle x402 requests on Hedera, with explicit budgets and an auditable trail.
        </p>
        <div className="hero-actions">
          <button onClick={checkBackend} disabled={checking}>
            {checking ? "Checking backend…" : "Check backend connection"}
          </button>
          <span className="quiet">Foundation scaffold · No payment executed</span>
        </div>
        {health && (
          <div className="notice success" role="status">
            API status: {health.status} · Service: {health.service} · Network: {health.network}
          </div>
        )}
        {error && <div className="notice error" role="alert">{error}</div>}
      </section>

      <section className="grid" aria-label="Project capabilities">
        <article className="feature-card">
          <span className="number">01</span>
          <h2>Autonomous x402</h2>
          <p>A client discovers a price and completes a paid HTTP request without a checkout page.</p>
          <span className="status">NEXT: PAYMENT PROOF</span>
        </article>
        <article className="feature-card">
          <span className="number">02</span>
          <h2>Spending firewall</h2>
          <p>Budgets, provider allowlists, and per-request caps are checked before the agent pays.</p>
          <span className="status">PLANNED</span>
        </article>
        <article className="feature-card">
          <span className="number">03</span>
          <h2>Verifiable audit</h2>
          <p>Payment receipts and policy decisions will be linked to verifiable Hedera evidence.</p>
          <span className="status">PLANNED</span>
        </article>
      </section>

      <footer>
        <span>heder1 · ETHGlobal Mumbai preparation</span>
        <span>Testnet only · Never put secrets in frontend code</span>
      </footer>
    </main>
  );
}
