import { useCallback, useEffect, useState } from "react";
import "./dashboard.css";

type Eip1193Provider = { request(args: { method: string; params?: unknown[] | object }): Promise<unknown> };
declare global { interface Window { ethereum?: Eip1193Provider } }
type AuditRecord = { id: string; sequence: number; timestamp: string; event: string; outcome: string; hash: string; details: Record<string, unknown> };
type DashboardData = {
  health?: { status: string; service: string; network: string };
  x402?: { network: string; sdkConfigured: boolean; accountId: string | null; receiverAccountId: string | null; paymentExecutionEnabled: boolean; reason: string };
  agent?: { enabled: boolean; policy: { maxAmountHbar: string; allowedResource: string; note: string }; spendingFirewall: { maxPaymentTinybars: string; dailyBudgetTinybars: string; maxAttemptsPerUtcDay: number; ledger: string; multiInstanceSafe: boolean } };
  audit?: { valid: boolean; records: number; headHash?: string; ledger: string; independentlyAnchored: boolean; error?: string };
  anchors?: { enabled: boolean; anchors: Array<{ topicId: string; sequenceNumber: number; transactionId: string; auditSequence: number; auditRecordHash: string; mirrorNodeUrl: string }> };
  history?: AuditRecord[];
};
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\\/$/, "");
const apiUrl = (path: string) => API_BASE_URL + path;
const CHAIN_ID = "0x128";
const shorten = (value: string, start = 10, end = 7) => value.length > start + end + 3 ? value.slice(0, start) + "…" + value.slice(-end) : value;
const hashscanTx = (id: string) => "https://hashscan.io/testnet/transaction/" + encodeURIComponent(id);

export default function App() {
  const [data, setData] = useState<DashboardData>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [wallet, setWallet] = useState("");
  const [chain, setChain] = useState("");
  const [consent, setConsent] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [verifyInput, setVerifyInput] = useState({ topicId: "", sequenceNumber: "", auditHash: "" });
  const [verification, setVerification] = useState<{ valid: boolean; url?: string; error?: string; anchoredAuditHash?: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    const get = async <T,>(url: string): Promise<T> => {
      const response = await fetch(apiUrl(url));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status} from ${url}`);
      return body as T;
    };
    try {
      const [health, x402, agent, audit, anchors, history] = await Promise.all([
        get<NonNullable<DashboardData["health"]>>("/api/health"),
        get<NonNullable<DashboardData["x402"]>>("/api/x402/status"),
        get<NonNullable<DashboardData["agent"]>>("/api/agent/status"),
        get<NonNullable<DashboardData["audit"]>>("/api/audit/status"),
        get<NonNullable<DashboardData["anchors"]>>("/api/audit/anchors"),
        get<{ records: AuditRecord[] }>("/api/audit/records?limit=30"),
      ]);
      setData({ health, x402, agent, audit, anchors, history: history.records });
      if (!verifyInput.topicId && anchors.anchors[0]) {
        const latest = anchors.anchors[anchors.anchors.length - 1];
        setVerifyInput({ topicId: latest.topicId, sequenceNumber: String(latest.sequenceNumber), auditHash: latest.auditRecordHash });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dashboard refresh failed. Is the API running?");
    } finally { setLoading(false); }
  }, [verifyInput.topicId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const isTestnet = chain.toLowerCase() === CHAIN_ID;
  async function connectWallet() {
    setError(""); setNotice("");
    try {
      if (!window.ethereum) throw new Error("No EVM-compatible wallet detected. Open a Hedera-compatible wallet and try again.");
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("Wallet did not return an account.");
      setWallet(accounts[0]); setChain(String(chainId)); setConsent(false); setToken("");
      setNotice(String(chainId).toLowerCase() === CHAIN_ID ? "Wallet connected on Hedera Testnet." : "Wallet connected, but switch to Hedera Testnet before authorizing.");
    } catch (e) { setError(e instanceof Error ? e.message : "Wallet connection failed."); }
  }
  async function switchNetwork() {
    try {
      if (!window.ethereum) throw new Error("No wallet provider detected.");
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID }] });
      setChain(String(await window.ethereum.request({ method: "eth_chainId" })));
      setConsent(false); setToken("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not switch network."); }
  }
  async function authorize() {
    setBusy("authorize"); setError(""); setNotice(""); setToken("");
    try {
      if (!window.ethereum || !wallet || !isTestnet || !consent) throw new Error("Connect a wallet, verify Hedera Testnet, and approve the one-run consent first.");
      const challengeResponse = await fetch(apiUrl("/api/authorization/challenge"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: wallet, chainId: 296 }) });
      const challenge = await challengeResponse.json() as { nonce?: string; message?: string; error?: string };
      if (!challengeResponse.ok || !challenge.nonce || !challenge.message) throw new Error(challenge.error ?? "Could not create authorization challenge.");
      const signature = await window.ethereum.request({ method: "personal_sign", params: [challenge.message, wallet] });
      if (typeof signature !== "string") throw new Error("Wallet did not return a signature.");
      const verifyResponse = await fetch(apiUrl("/api/authorization/verify"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: challenge.nonce, signature }) });
      const grant = await verifyResponse.json() as { authorizationToken?: string; expiresAt?: string; error?: string };
      if (!verifyResponse.ok || !grant.authorizationToken) throw new Error(grant.error ?? "Signature verification failed.");
      setToken(grant.authorizationToken); setNotice(`One-time authorization issued until ${grant.expiresAt}. No payment has been made yet.`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Authorization failed."); }
    finally { setBusy(""); }
  }
  async function runAgent() {
    setBusy("agent"); setError(""); setNotice("");
    try {
      if (!token) throw new Error("Sign and authorize one invocation first.");
      const response = await fetch(apiUrl("/api/agent/run"), { method: "POST", headers: { "x-heder1-authorization": token } });
      const result = await response.json() as { error?: string; response?: { status?: number; body?: Record<string, unknown> }; note?: string };
      setToken(""); setConsent(false);
      if (!response.ok) throw new Error(result.error ?? result.note ?? `Agent failed with HTTP ${response.status}.`);
      setNotice(`Agent completed with resource HTTP status ${result.response?.status ?? response.status}. Review the audit history for the recorded outcome.`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Agent run failed."); await refresh(); }
    finally { setBusy(""); }
  }
  async function verifyAnchor() {
    setBusy("verify"); setError(""); setVerification(null);
    try {
      const q = new URLSearchParams(verifyInput);
      const response = await fetch(apiUrl("/api/audit/verify-hcs?" + q.toString()));
      const result = await response.json() as { valid: boolean; url?: string; error?: string; anchoredAuditHash?: string };
      setVerification(result);
      if (!response.ok && !result.error) setError("The requested anchor did not verify.");
    } catch (e) { setError(e instanceof Error ? e.message : "HCS verification failed."); }
    finally { setBusy(""); }
  }
  const firewall = data.agent?.spendingFirewall;
  const anchors = [...(data.anchors?.anchors ?? [])].reverse();
  const records = data.history ?? [];

  return <main className="dashboard">
    <header className="dash-topbar">
      <a className="dash-brand" href="/"><span className="dash-mark">h1</span>heder<span>1</span></a>
      <div className="topbar-right"><span className="network-badge"><i className={data.health?.status === "ok" ? "dot good" : "dot"} />{data.health?.network ?? "Hedera Testnet"}</span><button className="button secondary small" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh data"}</button></div>
    </header>
    <section className="dash-hero">
      <div><p className="dash-kicker">PHASE 06 / PRODUCT CONTROL PLANE</p><h1>Agent payments,<br/><em>under control.</em></h1><p className="dash-intro">Live backend state for authorization, policy enforcement, payment activity and public audit evidence.</p></div>
      <div className="hero-status"><span className={data.health?.status === "ok" ? "status-light live" : "status-light"}></span><div><strong>{data.health?.status === "ok" ? "API connected" : "API unavailable"}</strong><small>{data.health?.service ?? "Waiting for backend"}</small></div><span className="mono">TESTNET</span></div>
    </section>
    {error && <div className="dash-alert error-alert" role="alert">{error}</div>}
    {notice && <div className="dash-alert success-alert" role="status">{notice}</div>}
    <section className="metric-grid" aria-label="Live system status">
      <article className="metric"><span>NETWORK</span><strong>{data.x402?.network ?? "—"}</strong><small>{data.x402?.sdkConfigured ? "Payer configuration detected" : "Payer not configured"}</small></article>
      <article className="metric"><span>AGENT</span><strong className={data.agent?.enabled ? "text-good" : "text-warn"}>{data.agent?.enabled ? "Enabled" : "Disabled"}</strong><small>Disabled by default · local testnet only</small></article>
      <article className="metric"><span>AUDIT INTEGRITY</span><strong className={data.audit?.valid ? "text-good" : "text-danger"}>{data.audit ? data.audit.valid ? "Verified" : "Failed" : "—"}</strong><small>{data.audit?.records ?? 0} local records · hash-chain check</small></article>
      <article className="metric"><span>HCS ANCHORING</span><strong>{data.anchors?.enabled ? "Enabled" : "Not enabled"}</strong><small>{data.anchors?.anchors.length ?? 0} locally indexed anchors</small></article>
    </section>
    <div className="content-grid">
      <section className="panel"><div className="panel-head"><div><p className="dash-kicker">01 / SPENDING FIREWALL</p><h2>Policy & limits</h2></div><span className="chip">ENFORCED BY API</span></div>
        <div className="limit-list"><div><span>Max per payment</span><strong>0.001 HBAR</strong></div><div><span>Daily budget</span><strong>{firewall ? (Number(firewall.dailyBudgetTinybars) / 100_000_000).toFixed(3) : "0.010"} HBAR</strong></div><div><span>Daily attempts</span><strong>{firewall?.maxAttemptsPerUtcDay ?? 10}</strong></div><div><span>Allowed resource</span><code>{data.agent?.policy.allowedResource ?? "/api/x402/paid-resource"}</code></div><div><span>Ledger mode</span><strong>{firewall?.ledger ?? "—"}</strong></div></div>
        <p className="panel-footnote">Reservations persist locally. Multi-instance safety: {firewall?.multiInstanceSafe ? "yes" : "no"}.</p>
      </section>
      <section className="panel"><div className="panel-head"><div><p className="dash-kicker">02 / WALLET CONSENT</p><h2>Authorize one run</h2></div><span className={isTestnet ? "chip good-chip" : "chip"}>{wallet ? isTestnet ? "TESTNET VERIFIED" : "WRONG NETWORK" : "DISCONNECTED"}</span></div>
        {wallet ? <div className="connected-wallet"><span className="mini-avatar">W</span><div><strong>{shorten(wallet)}</strong><small>Chain ID {Number.parseInt(chain || "0", 16) || "unknown"}</small></div><button className="button secondary small" onClick={() => { setWallet(""); setChain(""); setConsent(false); setToken(""); }}>Disconnect</button></div> : <button className="button primary" onClick={() => void connectWallet()}>Connect EVM wallet</button>}
        {wallet && !isTestnet && <button className="button secondary block-button" onClick={() => void switchNetwork()}>Switch to Hedera Testnet</button>}
        <label className="consent-row"><input type="checkbox" checked={consent} disabled={!wallet || !isTestnet || Boolean(token)} onChange={e => setConsent(e.target.checked)}/><span>Approve one task, one allowlisted resource, max 0.001 HBAR per payment.</span></label>
        <div className="action-row"><button className="button secondary" onClick={() => void authorize()} disabled={!wallet || !isTestnet || !consent || Boolean(token) || Boolean(busy)}>{busy === "authorize" ? "Waiting for signature…" : token ? "Authorization ready" : "Sign authorization"}</button><button className="button primary" onClick={() => void runAgent()} disabled={!token || Boolean(busy)}>{busy === "agent" ? "Running…" : "Run agent"}</button></div>
        <p className="panel-footnote">Agent execution can spend testnet HBAR. If disabled by the server, the request is rejected; the frontend cannot override that policy.</p>
      </section>
    </div>
    <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">03 / PUBLIC EVIDENCE</p><h2>HCS anchors & receipts</h2></div><span className="chip">{anchors.length} ANCHORS</span></div>
      {anchors.length ? <div className="table-wrap"><table><thead><tr><th>Topic / sequence</th><th>Audit sequence</th><th>Hash</th><th>Evidence</th></tr></thead><tbody>{anchors.map(a => <tr key={a.topicId + ":" + a.sequenceNumber}><td><strong>{a.topicId}</strong><small>Sequence #{a.sequenceNumber}</small></td><td>#{a.auditSequence}</td><td><code>{shorten(a.auditRecordHash, 12, 8)}</code></td><td><a href={a.mirrorNodeUrl} target="_blank" rel="noreferrer">Mirror Node ↗</a><button className="link-button" onClick={() => { setVerifyInput({ topicId: a.topicId, sequenceNumber: String(a.sequenceNumber), auditHash: a.auditRecordHash }); setVerification(null); }}>Verify this hash</button><a href={hashscanTx(a.transactionId)} target="_blank" rel="noreferrer">Transaction ↗</a></td></tr>)}</tbody></table></div> : <div className="empty-state"><strong>No indexed HCS anchors yet</strong><p>Enable HCS anchoring on the API and generate an audit event to add an anchor.</p></div>}
      <div className="verify-box"><div><strong>Verify a hash against the public Mirror Node</strong><p>Checks the selected topic message against the expected SHA-256 audit hash.</p></div><div className="verify-fields"><input aria-label="HCS topic ID" placeholder="Topic ID (0.0.x)" value={verifyInput.topicId} onChange={e => setVerifyInput({ ...verifyInput, topicId: e.target.value })}/><input aria-label="HCS sequence number" placeholder="Sequence" inputMode="numeric" value={verifyInput.sequenceNumber} onChange={e => setVerifyInput({ ...verifyInput, sequenceNumber: e.target.value })}/><input aria-label="Expected audit hash" placeholder="64-character SHA-256 hash" value={verifyInput.auditHash} onChange={e => setVerifyInput({ ...verifyInput, auditHash: e.target.value })}/><button className="button primary" disabled={busy === "verify" || !verifyInput.topicId || !verifyInput.sequenceNumber || !verifyInput.auditHash} onClick={() => void verifyAnchor()}>{busy === "verify" ? "Verifying…" : "Verify anchor"}</button></div>
      {verification && <div className={verification.valid ? "verify-result valid" : "verify-result invalid"} role="status"><strong>{verification.valid ? "✓ Hash verified against Mirror Node" : "Verification failed"}</strong>{verification.anchoredAuditHash && <code>{verification.anchoredAuditHash}</code>}{verification.url && <a href={verification.url} target="_blank" rel="noreferrer">Open public message ↗</a>}{verification.error && <span>{verification.error}</span>}</div>}</div>
    </section>
    <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">04 / AUDIT JOURNAL</p><h2>Recent activity</h2></div><span className="chip">{records.length} EVENTS</span></div>
      {records.length ? <div className="table-wrap"><table><thead><tr><th>Event</th><th>Outcome</th><th>Time</th><th>Receipt / reference</th></tr></thead><tbody>{records.map(r => { const details = r.details ?? {}; const tx = typeof details.transactionId === "string" ? details.transactionId : typeof details.transaction === "string" ? details.transaction : ""; return <tr key={r.id}><td><strong>{r.event.replaceAll(".", " · ")}</strong><small>Sequence #{r.sequence}</small></td><td><span className={r.outcome === "rejected" || r.outcome === "failed" ? "outcome bad" : "outcome"}>{r.outcome}</span></td><td>{new Date(r.timestamp).toLocaleString()}</td><td>{tx ? <a href={hashscanTx(tx)} target="_blank" rel="noreferrer">{shorten(tx)} ↗</a> : <code>{shorten(r.hash, 12, 8)}</code>}</td></tr>; })}</tbody></table></div> : <div className="empty-state"><strong>No audit events recorded</strong><p>Events will appear here as authorization, agent and payment flows run.</p></div>}
      <p className="panel-footnote">History is read from the local hash-chained audit log. Transaction links are shown only when the backend recorded a transaction reference; facilitator claims should still be checked on HashScan.</p>
    </section>
    <footer className="dash-footer"><span>heder1 / Security-first autonomous payments on Hedera</span><span>Testnet only · Never expose secrets · Local ledger is single-instance</span></footer>
  </main>;
}
