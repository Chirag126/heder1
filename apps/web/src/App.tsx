import { useCallback, useEffect, useState } from "react";
import "./dashboard.css";

type Eip1193Provider = { request(args: { method: string; params?: unknown[] | object }): Promise<unknown> };
declare global { interface Window { ethereum?: Eip1193Provider } }
type AuditRecord = { id: string; sequence: number; timestamp: string; event: string; outcome: string; hash: string; details: Record<string, unknown> };
type DashboardData = {
  health?: { status: string; service: string; network: string };
  x402?: { network: string; sdkConfigured: boolean; accountId: string | null; receiverAccountId: string | null; paymentExecutionEnabled: boolean; reason: string };
  agentV2?: { enabled: boolean; killSwitchEnabled?: boolean; paymentExecutionEnabled: boolean };
  agent?: { enabled: boolean; policy: { maxAmountHbar: string; allowedResource: string; note: string }; spendingFirewall: { maxPaymentTinybars: string; dailyBudgetTinybars: string; maxAttemptsPerUtcDay: number; ledger: string; multiInstanceSafe: boolean } };
  audit?: { valid: boolean; records: number; headHash?: string; ledger: string; independentlyAnchored: boolean; error?: string };
  anchors?: { enabled: boolean; anchors: Array<{ topicId: string; sequenceNumber: number; transactionId: string; auditSequence: number; auditRecordHash: string; mirrorNodeUrl: string }> };
  history?: AuditRecord[];
};
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
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
  const [agentMode, setAgentMode] = useState<"preview" | "autonomous" | "approval-required">("preview");
  const [maxPaymentTinybars, setMaxPaymentTinybars] = useState("50000");
  const [taskBudgetTinybars, setTaskBudgetTinybars] = useState("200000");
  const [dailyBudgetTinybars, setDailyBudgetTinybars] = useState("500000");
  const [maxPaidCallsPerDay, setMaxPaidCallsPerDay] = useState("5");
  const [maxPaidCallsPerTask, setMaxPaidCallsPerTask] = useState("2");
  const [approvalThresholdTinybars, setApprovalThresholdTinybars] = useState("50000");
  const [policySimulation, setPolicySimulation] = useState<{ allowed: boolean; requiresApproval?: boolean; reason: string } | null>(null);
  const [activeRunId, setActiveRunId] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [taskReceipts, setTaskReceipts] = useState<Array<{ serviceId: string; transactionId: string; explorerUrl: string; amountHbar: string }>>([]);
  const [taskWarnings, setTaskWarnings] = useState<string[]>([]);
  const [visibleAnchorCount, setVisibleAnchorCount] = useState(7);
  const [visibleRecordCount, setVisibleRecordCount] = useState(10);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    const get = async <T,>(url: string): Promise<T> => {
      const response = await fetch(apiUrl(url));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status} from ${url}`);
      return body as T;
    };
    try {
      const [health, x402, agent, agentV2, audit, anchors, history] = await Promise.all([
        get<NonNullable<DashboardData["health"]>>("/api/health"),
        get<NonNullable<DashboardData["x402"]>>("/api/x402/status"),
        get<NonNullable<DashboardData["agent"]>>("/api/agent/status"),
        get<NonNullable<DashboardData["agentV2"]>>("/api/agent/v2/status"),
        get<NonNullable<DashboardData["audit"]>>("/api/audit/status"),
        get<NonNullable<DashboardData["anchors"]>>("/api/audit/anchors"),
        get<{ records: AuditRecord[] }>("/api/audit/records?limit=100"),
      ]);
      setData({ health, x402, agent, agentV2, audit, anchors, history: history.records });
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
  const buildUserPolicy = () => ({ mode: agentMode, network: "hedera:testnet" as const, maxPaymentTinybars: Number(maxPaymentTinybars), taskBudgetTinybars: Number(taskBudgetTinybars), dailyBudgetTinybars: Number(dailyBudgetTinybars), maxPaidCallsPerTask: Number(maxPaidCallsPerTask), maxPaidCallsPerDay: Number(maxPaidCallsPerDay), allowedServiceIds: ["heder1-full-report", "heder1-short-summary"], allowedAssets: ["0.0.0"], expiresAt: Date.now() + 120_000, approvalThresholdTinybars: Number(approvalThresholdTinybars) });
  async function simulatePolicy() {
    setBusy("simulate"); setError(""); setPolicySimulation(null);
    try {
      if (agentMode === "preview") {
        const response = await fetch(apiUrl("/api/agent/v2/plan"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "Compare approved service quotes for a short report", policy: buildUserPolicy(), budgetTinybars: Number(taskBudgetTinybars) }) });
        const result = await response.json() as { selected?: { serviceId: string; amountTinybars: number; amountHbar: string }; candidates?: Array<{ serviceId: string; status: string; reason: string }>; error?: string; paymentAttempted?: boolean };
        if (!response.ok) throw new Error(result.error ?? "Quote preview failed.");
        setPolicySimulation({ allowed: Boolean(result.selected), reason: result.selected ? `Preview only: ${result.selected.serviceId} quoted ${result.selected.amountTinybars} tinybars (${result.selected.amountHbar} HBAR). No funds were reserved and no payment was attempted. ${(result.candidates ?? []).map(item => `${item.serviceId}: ${item.status} — ${item.reason}`).join(" | ")}` : `No eligible quote found. No payment was attempted. ${(result.candidates ?? []).map(item => `${item.serviceId}: ${item.reason}`).join(" | ")}` });
      } else {
        const response = await fetch(apiUrl("/api/agent/v2/policy/simulate"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: buildUserPolicy(), quote: { serviceId: "heder1-short-summary", network: "hedera:testnet", asset: "0.0.0", amountTinybars: 50_000 } }) });
        const result = await response.json() as { allowed: boolean; requiresApproval?: boolean; reason: string };
        setPolicySimulation(result);
        if (!response.ok) setError(result.reason ?? "Policy simulation failed.");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Policy simulation failed."); }
    finally { setBusy(""); }
  }
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
      const challengeResponse = await fetch(apiUrl("/api/authorization/challenge"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: wallet, chainId: 296, scope: "heder1:agent-v2:bounded-task", policy: buildUserPolicy() }) });
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
  async function revokeGrant() {
    if (!token) return;
    setBusy("revoke"); setError("");
    try {
      const response = await fetch(apiUrl("/api/authorization/revoke"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorizationToken: token }) });
      const result = await response.json() as { revoked?: boolean; reason?: string };
      if (!response.ok || !result.revoked) throw new Error(result.reason ?? "Grant could not be revoked.");
      setToken(""); setConsent(false); setNotice("Unused authorization grant revoked.");
    } catch (e) { setError(e instanceof Error ? e.message : "Grant revocation failed."); }
    finally { setBusy(""); }
  }
  async function cancelActiveRun() {
    if (!activeRunId) return;
    setCancelBusy(true);
    try {
      const response = await fetch(apiUrl("/api/agent/v2/cancel"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: activeRunId }) });
      const result = await response.json() as { cancelled?: boolean; note?: string; error?: string };
      if (!response.ok || !result.cancelled) throw new Error(result.error ?? "Task is no longer active.");
      setNotice(result.note ?? "Cancellation requested. Check the final receipt before retrying.");
    } catch (e) { setError(e instanceof Error ? e.message : "Task cancellation failed."); }
    finally { setCancelBusy(false); }
  }
  async function runAgent() {
    setBusy("agent"); setError(""); setNotice(""); setTaskReceipts([]); setTaskWarnings([]);
    try {
      if (!window.ethereum || !wallet || !isTestnet || !consent) throw new Error("Connect your wallet on Hedera Testnet and confirm consent before continuing.");
      if (agentMode === "preview") throw new Error("Preview mode never pays. Use the preview control to inspect quotes.");
      const policy = buildUserPolicy();
      const goal = "Find the cheapest approved source for a short report and return its receipt";
      const planResponse = await fetch(apiUrl("/api/agent/v2/plan"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal, policy, budgetTinybars: policy.taskBudgetTinybars }) });
      const plan = await planResponse.json() as { error?: string; selected?: { serviceId: string; amountTinybars: number; amountHbar: string; asset: string; receiverAccountId: string }; paymentAttempted?: boolean };
      if (!planResponse.ok || !plan.selected) throw new Error(plan.error ?? "No eligible quote was found. No payment was attempted.");
      setNotice(`Quote selected: ${plan.selected.serviceId}, ${plan.selected.amountTinybars} tinybars (${plan.selected.amountHbar} HBAR). Review the exact quote in your wallet signature request.`);
      const requiresApproval = agentMode === "approval-required" || plan.selected.amountTinybars > policy.approvalThresholdTinybars;
      let headers: Record<string, string> = { "content-type": "application/json" };
      if (requiresApproval) {
        const challengeResponse = await fetch(apiUrl("/api/agent/v2/approval/challenge"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: wallet, policy, quote: { serviceId: plan.selected.serviceId, network: policy.network, asset: plan.selected.asset, amountTinybars: plan.selected.amountTinybars, receiverAccountId: plan.selected.receiverAccountId } }) });
        const challenge = await challengeResponse.json() as { nonce?: string; message?: string; error?: string };
        if (!challengeResponse.ok || !challenge.nonce || !challenge.message) throw new Error(challenge.error ?? "Could not create quote-specific approval challenge.");
        const signature = await window.ethereum.request({ method: "personal_sign", params: [challenge.message, wallet] });
        if (typeof signature !== "string") throw new Error("Wallet did not return a signature.");
        const verifyResponse = await fetch(apiUrl("/api/agent/v2/approval/verify"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: challenge.nonce, signature }) });
        const approval = await verifyResponse.json() as { approvalToken?: string; error?: string };
        if (!verifyResponse.ok || !approval.approvalToken) throw new Error(approval.error ?? "Payment approval verification failed.");
        headers["x-heder1-payment-approval"] = approval.approvalToken;
      } else {
        if (!token) throw new Error("Sign the one-time agent authorization first. The discovered quote is below your approval threshold.");
        headers["x-heder1-authorization"] = token;
      }
      const runId = crypto.randomUUID();
      setActiveRunId(runId);
      const response = await fetch(apiUrl("/api/agent/v2/run"), { method: "POST", headers, body: JSON.stringify({ runId, goal, budgetTinybars: policy.taskBudgetTinybars, maxPaidCalls: policy.maxPaidCallsPerTask, allowedServiceIds: policy.allowedServiceIds }) });
      const result = await response.json() as { error?: string; status?: string; selection?: { serviceId?: string; amountHbar?: string }; receipts?: Array<{ serviceId?: string; transactionId?: string; explorerUrl?: string; amountHbar?: string }>; expenditure?: { reservedHbar?: string; paidCalls?: number }; warnings?: string[]; note?: string };
      setToken(""); setConsent(false);
      if (!response.ok) throw new Error(result.error ?? result.note ?? `Agent failed with HTTP ${response.status}.`);
      setNotice(`Agent ${result.status ?? "completed"}: ${result.receipts?.length ?? 1} payment(s), ${result.expenditure?.reservedHbar ?? result.selection?.amountHbar ?? "quoted price"} HBAR total. ${result.warnings?.join(" ") ?? ""} Review each transaction receipt and audit history.`);
      setTaskReceipts((result.receipts ?? []).flatMap(receipt => receipt.transactionId && receipt.explorerUrl ? [{ serviceId: receipt.serviceId ?? "approved service", transactionId: receipt.transactionId, explorerUrl: receipt.explorerUrl, amountHbar: receipt.amountHbar ?? "unknown" }] : []));
      setTaskWarnings(result.warnings ?? []);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Agent run failed."); await refresh(); }
    finally { setBusy(""); setActiveRunId(""); }
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
  const visibleAnchors = anchors.slice(0, visibleAnchorCount);
  const visibleRecords = records.slice(0, visibleRecordCount);

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
    {taskReceipts.length > 0 && <section className="panel wide-panel task-receipts" aria-label="Latest task receipts"><div className="panel-head"><div><p className="dash-kicker">LATEST TASK</p><h2>Payment receipts</h2></div><span className="chip good-chip">{taskReceipts.length} SETTLED</span></div><div className="limit-list">{taskReceipts.map((receipt, index) => <div key={receipt.transactionId}><span>{receipt.serviceId} · {receipt.amountHbar} HBAR</span><strong><a href={receipt.explorerUrl} target="_blank" rel="noreferrer">HashScan receipt #{index + 1} ↗</a></strong></div>)}</div>{taskWarnings.length > 0 && <div className="verify-result invalid" role="status"><strong>Task stopped with warnings</strong><span>{taskWarnings.join(" ")}</span></div>}</section>}
    <section className="metric-grid" aria-label="Live system status">
      <article className="metric"><span>NETWORK</span><strong>{data.x402?.network ?? "—"}</strong><small>{data.x402?.sdkConfigured ? "Payer configuration detected" : "Payer not configured"}</small></article>
      <article className="metric"><span>AGENT</span><strong className={data.agentV2?.killSwitchEnabled ? "text-danger" : data.agent?.enabled ? "text-good" : "text-warn"}>{data.agentV2?.killSwitchEnabled ? "Kill switch ON" : data.agent?.enabled ? "Enabled" : "Disabled"}</strong><small>{data.agentV2?.killSwitchEnabled ? "Payments stopped by server policy" : "Disabled by default · local testnet only"}</small></article>
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
        <div className="user-policy-box">
          <strong>User spending policy</strong>
          <label>Mode<select value={agentMode} onChange={e => { setAgentMode(e.target.value as "preview" | "autonomous" | "approval-required"); setPolicySimulation(null); setToken(""); }}><option value="preview">Preview — no payment</option><option value="autonomous">Autonomous — within limits</option><option value="approval-required">Approval required — fail closed</option></select></label>
          <div className="policy-fields"><label>Max payment (tinybars)<input inputMode="numeric" value={maxPaymentTinybars} onChange={e => { setMaxPaymentTinybars(e.target.value); setToken(""); setPolicySimulation(null); }}/></label><label>Task budget (tinybars)<input inputMode="numeric" value={taskBudgetTinybars} onChange={e => { setTaskBudgetTinybars(e.target.value); setToken(""); setPolicySimulation(null); }}/></label><label>Daily budget (tinybars)<input inputMode="numeric" value={dailyBudgetTinybars} onChange={e => { setDailyBudgetTinybars(e.target.value); setToken(""); setPolicySimulation(null); }}/></label><label>Paid calls per task (max 3)<input inputMode="numeric" value={maxPaidCallsPerTask} onChange={e => { setMaxPaidCallsPerTask(e.target.value); setToken(""); setPolicySimulation(null); }}/></label><label>Daily paid-call cap<input inputMode="numeric" value={maxPaidCallsPerDay} onChange={e => { setMaxPaidCallsPerDay(e.target.value); setToken(""); setPolicySimulation(null); }}/></label><label>Approval threshold (tinybars)<input inputMode="numeric" value={approvalThresholdTinybars} onChange={e => { setApprovalThresholdTinybars(e.target.value); setToken(""); setPolicySimulation(null); }}/></label></div>
          <p className="panel-footnote">Hard ceilings: 100,000 tinybars/payment, 500,000/task, 1,000,000/day. HBAR on Hedera Testnet and approved services only.</p>
          <div className="action-row"><button className="button secondary" onClick={() => void simulatePolicy()} disabled={Boolean(busy)}>{busy === "simulate" ? "Checking quotes…" : agentMode === "preview" ? "Preview registered services" : "Simulate 0.0005 HBAR quote"}</button></div>
          {policySimulation && <div className={policySimulation.allowed ? "verify-result valid" : "verify-result invalid"} role="status"><strong>{agentMode === "preview" ? (policySimulation.allowed ? "Preview plan ready" : "No eligible quote") : policySimulation.allowed ? "Policy permits quote" : policySimulation.requiresApproval ? "Approval required" : "Quote blocked"}</strong><span>{policySimulation.reason}</span></div>}
        </div>
        <label className="consent-row"><input type="checkbox" checked={consent} disabled={!wallet || !isTestnet || Boolean(busy)} onChange={e => setConsent(e.target.checked)}/><span>Approve one task under the policy shown above. Your wallet signature binds these limits and expires within two minutes.</span></label>
        <div className="action-row"><button className="button secondary" onClick={() => void authorize()} disabled={!wallet || !isTestnet || !consent || Boolean(token) || Boolean(busy) || agentMode === "approval-required"}>{busy === "authorize" ? "Waiting for signature…" : token ? "Authorization ready" : "Sign authorization"}</button><button className="button primary" onClick={() => void runAgent()} disabled={!consent || agentMode === "preview" || (!token && agentMode === "autonomous" && !wallet) || Boolean(busy) || Boolean(data.agentV2?.killSwitchEnabled)}>{busy === "agent" ? "Running…" : agentMode === "approval-required" ? "Plan & approve payment" : "Run agent"}</button>{token && <button className="button secondary" onClick={() => void revokeGrant()} disabled={Boolean(busy)}>{busy === "revoke" ? "Revoking…" : "Revoke grant"}</button>}{busy === "agent" && activeRunId && <button className="button secondary" onClick={() => void cancelActiveRun()} disabled={cancelBusy}>{cancelBusy ? "Cancelling…" : "Cancel task"}</button>}</div>
        <p className="panel-footnote">Agent execution can spend testnet HBAR. If disabled by the server, the request is rejected; the frontend cannot override that policy.</p>
      </section>
    </div>
    <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">03 / PUBLIC EVIDENCE</p><h2>HCS anchors & receipts</h2></div><span className="chip">{Math.min(visibleAnchorCount, anchors.length)} / {anchors.length} ANCHORS</span></div>
      {anchors.length ? <><div className="table-wrap"><table><thead><tr><th>Topic / sequence</th><th>Audit sequence</th><th>Hash</th><th>Evidence</th></tr></thead><tbody>{visibleAnchors.map(a => <tr key={a.topicId + ":" + a.sequenceNumber}><td><strong>{a.topicId}</strong><small>Sequence #{a.sequenceNumber}</small></td><td>#{a.auditSequence}</td><td><code>{shorten(a.auditRecordHash, 12, 8)}</code></td><td><a href={a.mirrorNodeUrl} target="_blank" rel="noreferrer">Mirror Node ↗</a><button className="link-button" onClick={() => { setVerifyInput({ topicId: a.topicId, sequenceNumber: String(a.sequenceNumber), auditHash: a.auditRecordHash }); setVerification(null); }}>Verify this hash</button><a href={hashscanTx(a.transactionId)} target="_blank" rel="noreferrer">Transaction ↗</a></td></tr>)}</tbody></table></div>{visibleAnchorCount < anchors.length && <div className="show-more-row"><button className="button secondary" onClick={() => setVisibleAnchorCount(count => Math.min(count + 7, anchors.length))}>Show 7 more anchors <span>({anchors.length - visibleAnchorCount} remaining)</span></button></div>}</> : <div className="empty-state"><strong>No indexed HCS anchors yet</strong><p>Enable HCS anchoring on the API and generate an audit event to add an anchor.</p></div>}
      <div className="verify-box"><div><strong>Verify a hash against the public Mirror Node</strong><p>Checks the selected topic message against the expected SHA-256 audit hash.</p></div><div className="verify-fields"><input aria-label="HCS topic ID" placeholder="Topic ID (0.0.x)" value={verifyInput.topicId} onChange={e => setVerifyInput({ ...verifyInput, topicId: e.target.value })}/><input aria-label="HCS sequence number" placeholder="Sequence" inputMode="numeric" value={verifyInput.sequenceNumber} onChange={e => setVerifyInput({ ...verifyInput, sequenceNumber: e.target.value })}/><input aria-label="Expected audit hash" placeholder="64-character SHA-256 hash" value={verifyInput.auditHash} onChange={e => setVerifyInput({ ...verifyInput, auditHash: e.target.value })}/><button className="button primary" disabled={busy === "verify" || !verifyInput.topicId || !verifyInput.sequenceNumber || !verifyInput.auditHash} onClick={() => void verifyAnchor()}>{busy === "verify" ? "Verifying…" : "Verify anchor"}</button></div>
      {verification && <div className={verification.valid ? "verify-result valid" : "verify-result invalid"} role="status"><strong>{verification.valid ? "✓ Hash verified against Mirror Node" : "Verification failed"}</strong>{verification.anchoredAuditHash && <code>{verification.anchoredAuditHash}</code>}{verification.url && <a href={verification.url} target="_blank" rel="noreferrer">Open public message ↗</a>}{verification.error && <span>{verification.error}</span>}</div>}</div>
    </section>
    <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">04 / AUDIT JOURNAL</p><h2>Recent activity</h2></div><span className="chip">{Math.min(visibleRecordCount, records.length)} / {records.length} EVENTS</span></div>
      {records.length ? <><div className="table-wrap"><table><thead><tr><th>Event</th><th>Outcome</th><th>Time</th><th>Receipt / reference</th></tr></thead><tbody>{visibleRecords.map(r => { const details = r.details ?? {}; const tx = typeof details.transactionId === "string" ? details.transactionId : typeof details.transaction === "string" ? details.transaction : ""; return <tr key={r.id}><td><strong>{r.event.replaceAll(".", " · ")}</strong><small>Sequence #{r.sequence}</small></td><td><span className={r.outcome === "rejected" || r.outcome === "failed" ? "outcome bad" : "outcome"}>{r.outcome}</span></td><td>{new Date(r.timestamp).toLocaleString()}</td><td>{tx ? <a href={hashscanTx(tx)} target="_blank" rel="noreferrer">{shorten(tx)} ↗</a> : <code>{shorten(r.hash, 12, 8)}</code>}</td></tr>; })}</tbody></table></div>{visibleRecordCount < records.length && <div className="show-more-row"><button className="button secondary" onClick={() => setVisibleRecordCount(count => Math.min(count + 10, records.length))}>Show 10 more events <span>({records.length - visibleRecordCount} remaining)</span></button></div>}</> : <div className="empty-state"><strong>No audit events recorded</strong><p>Events will appear here as authorization, agent and payment flows run.</p></div>}
      <p className="panel-footnote">History is read from the local hash-chained audit log. Transaction links are shown only when the backend recorded a transaction reference; facilitator claims should still be checked on HashScan.</p>
    </section>
    <footer className="dash-footer"><span>heder1 / Security-first autonomous payments on Hedera</span><span>Testnet only · Never expose secrets · Local ledger is single-instance</span></footer>
  </main>;
}
