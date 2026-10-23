import { useCallback, useEffect, useState } from "react";
import "./dashboard.css";

type Eip1193Provider = { request(args: { method: string; params?: unknown[] | object }): Promise<unknown> };
declare global { interface Window { ethereum?: Eip1193Provider } }
type AuditRecord = { id: string; sequence: number; timestamp: string; event: string; outcome: string; hash: string; details: Record<string, unknown> };
type PageId = "overview" | "playground" | "marketplace" | "permissions" | "payments" | "audit";
type PlanPreview = {
  goal?: string;
  selected?: { serviceId: string; description?: string; amountTinybars: number; amountHbar: string; asset?: string; receiverAccountId?: string } | null;
  candidates?: Array<{ serviceId: string; status: string; reason: string; amountTinybars?: number }>;
  paymentAttempted?: boolean;
  note?: string;
  error?: string;
};
type MarketplaceNegotiation = {
  negotiationId: string; decision: string; rounds: number;
  selected?: { agentId: string; agentName: string; serviceId: string; amountTinybars: number | null; amountHbar: string | null; reason: string } | null;
  offers: Array<{ agentId: string; agentName: string; serviceId: string; description: string; capabilities: string[]; amountTinybars: number | null; amountHbar: string | null; status: string; reason: string; identityStatus: string; negotiation: { response: string; reason: string; counterOfferTinybars: number | null } }>;
  negotiationLog: Array<{ round: number; agentId: string; agentName: string; action: string; amountTinybars: number | null; reason: string }>;
  paymentAttempted: boolean; nextStep: string; error?: string;
};
type DashboardData = {
  health?: { status: string; service: string; network: string };
  networks?: { selectedNetwork: string; enabledNetworks: string[]; mainnet: { availableForReadinessReview: boolean; paymentExecutionEnabled: boolean; reason: string } };
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
  const [networkMode, setNetworkMode] = useState("hedera:testnet");
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
  const [taskReceipts, setTaskReceipts] = useState<Array<{ serviceId: string; transactionId: string; explorerUrl: string; amountHbar: string; status: string }>>([]);
  const [taskWarnings, setTaskWarnings] = useState<string[]>([]);
  const [visibleAnchorCount, setVisibleAnchorCount] = useState(7);
  const [visibleRecordCount, setVisibleRecordCount] = useState(10);
  const [sessionPaused, setSessionPaused] = useState(false);
  const [page, setPage] = useState<PageId>(() => {
    const route = window.location.hash.replace("#", "");
    return (["overview", "playground", "marketplace", "permissions", "payments", "audit"] as string[]).includes(route) ? route as PageId : "overview";
  });
  const [taskGoal, setTaskGoal] = useState("Find the cheapest approved source for a short report and return its receipt");
  const [planDetails, setPlanDetails] = useState<PlanPreview | null>(null);
  const [marketplaceGoal, setMarketplaceGoal] = useState("Create a detailed full report");
  const [marketplaceBudget, setMarketplaceBudget] = useState("100000");
  const [marketplaceResult, setMarketplaceResult] = useState<MarketplaceNegotiation | null>(null);
  const [selectedMarketplaceServiceId, setSelectedMarketplaceServiceId] = useState<string>("");
  const [allowedServiceIds, setAllowedServiceIds] = useState<string[]>(["heder1-full-report", "heder1-short-summary"]);
  const navigate = (next: PageId) => {
    window.location.hash = next;
    setPage(next);
  };
  useEffect(() => {
    const syncRoute = () => {
      const route = window.location.hash.replace("#", "");
      setPage((["overview", "playground", "marketplace", "permissions", "payments", "audit"] as string[]).includes(route) ? route as PageId : "overview");
    };
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    const get = async <T,>(url: string): Promise<T> => {
      const response = await fetch(apiUrl(url));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status} from ${url}`);
      return body as T;
    };
    try {
      const [health, networks, x402, agent, agentV2, audit, anchors, history] = await Promise.all([
        get<NonNullable<DashboardData["health"]>>("/api/health"),
        get<NonNullable<DashboardData["networks"]>>("/api/networks"),
        get<NonNullable<DashboardData["x402"]>>("/api/x402/status"),
        get<NonNullable<DashboardData["agent"]>>("/api/agent/status"),
        get<NonNullable<DashboardData["agentV2"]>>("/api/agent/v2/status"),
        get<NonNullable<DashboardData["audit"]>>("/api/audit/status"),
        get<NonNullable<DashboardData["anchors"]>>("/api/audit/anchors"),
        get<{ records: AuditRecord[] }>("/api/audit/records?limit=100"),
      ]);
      setData({ health, networks, x402, agent, agentV2, audit, anchors, history: history.records });
      if (networks.enabledNetworks.includes(networkMode)) setNetworkMode(networks.selectedNetwork);
      if (!verifyInput.topicId && anchors.anchors[0]) {
        const latest = anchors.anchors[anchors.anchors.length - 1];
        setVerifyInput({ topicId: latest.topicId, sequenceNumber: String(latest.sequenceNumber), auditHash: latest.auditRecordHash });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dashboard refresh failed. Is the API running?");
    } finally { setLoading(false); }
  }, [verifyInput.topicId, networkMode]);

  useEffect(() => { void refresh(); }, [refresh]);

  const isTestnet = chain.toLowerCase() === CHAIN_ID;
  const buildUserPolicy = () => ({ mode: agentMode, network: "hedera:testnet" as const, maxPaymentTinybars: Number(maxPaymentTinybars), taskBudgetTinybars: Number(taskBudgetTinybars), dailyBudgetTinybars: Number(dailyBudgetTinybars), maxPaidCallsPerTask: Number(maxPaidCallsPerTask), maxPaidCallsPerDay: Number(maxPaidCallsPerDay), allowedServiceIds, allowedAssets: ["0.0.0"], expiresAt: Date.now() + 120_000, approvalThresholdTinybars: Number(approvalThresholdTinybars) });
  async function simulatePolicy(forcePreview = false) {
    setBusy("simulate"); setError(""); setPolicySimulation(null);
    try {
      if (forcePreview || agentMode === "preview") {
        const response = await fetch(apiUrl("/api/agent/v2/plan"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: taskGoal.trim(), policy: forcePreview ? { ...buildUserPolicy(), mode: "preview" as const } : buildUserPolicy(), budgetTinybars: Number(taskBudgetTinybars) }) });
        const result = await response.json() as PlanPreview;
        if (!response.ok) throw new Error(result.error ?? "Quote preview failed.");
        setPlanDetails(result);
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
      if (sessionPaused) throw new Error("New task authorizations are paused in this browser. Resume them in Spending & Permissions first.");
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
    let executionSubmitted = false;
    setBusy("agent"); setError(""); setNotice(""); setTaskReceipts([]); setTaskWarnings([]);
    try {
      if (sessionPaused) throw new Error("New task runs are paused in this browser. Resume them in Spending & Permissions first.");
      if (!window.ethereum || !wallet || !isTestnet || !consent) throw new Error("Connect your wallet on Hedera Testnet and confirm consent before continuing.");
      if (agentMode === "preview") throw new Error("Preview mode never pays. Use the preview control to inspect quotes.");
      const policy = buildUserPolicy();
      setNotice("Checking live service quotes. No payment has been confirmed.");
      const goal = taskGoal.trim();
      if (!goal || goal.length > 2000) throw new Error("Enter a task between 1 and 2,000 characters.");
      if (allowedServiceIds.length === 0) throw new Error("Approve at least one registered service in Spending & Permissions before running a task.");
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
      setNotice("Task submitted — waiting for the agent API and settlement receipt. Do not retry while settlement is unresolved.");
      executionSubmitted = true;
      const response = await fetch(apiUrl("/api/agent/v2/run"), { method: "POST", headers, body: JSON.stringify({ runId, goal, budgetTinybars: policy.taskBudgetTinybars, maxPaidCalls: policy.maxPaidCallsPerTask, allowedServiceIds: policy.allowedServiceIds }) });
      const result = await response.json() as { error?: string; status?: string; selection?: { serviceId?: string; amountHbar?: string }; receipts?: Array<{ serviceId?: string; transactionId?: string; explorerUrl?: string; amountHbar?: string; status?: string }>; expenditure?: { reservedHbar?: string; paidCalls?: number }; warnings?: string[]; note?: string };
      setToken(""); setConsent(false);
      if (!response.ok) throw new Error(result.error ?? result.note ?? `Agent failed with HTTP ${response.status}.`);
      setNotice(`Task returned a result. Receipts reported by the API: ${result.receipts?.length ?? 0}; reported spend ${result.expenditure?.reservedHbar ?? result.selection?.amountHbar ?? "unknown"} HBAR. Verify each receipt on HashScan. ${result.warnings?.join(" ") ?? ""}`);
      setTaskReceipts((result.receipts ?? []).flatMap(receipt => receipt.transactionId && receipt.explorerUrl ? [{ serviceId: receipt.serviceId ?? "approved service", transactionId: receipt.transactionId, explorerUrl: receipt.explorerUrl, amountHbar: receipt.amountHbar ?? "unknown", status: receipt.status ?? "unknown" }] : []));
      setTaskWarnings(result.warnings ?? []);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Agent run failed."); if (executionSubmitted) setNotice("Settlement status unknown — reconciling. Do not retry until you inspect Payments & Receipts and verify any transaction on HashScan."); await refresh(); }
    finally { setBusy(""); setActiveRunId(""); }
  }
  async function negotiateMarketplace() {
    setBusy("marketplace"); setError(""); setNotice(""); setMarketplaceResult(null); setSelectedMarketplaceServiceId("");
    try {
      const budgetTinybars = Number(marketplaceBudget);
      if (!Number.isSafeInteger(budgetTinybars) || budgetTinybars < 1 || budgetTinybars > 500000) throw new Error("Marketplace budget must be between 1 and 500000 tinybars.");
      const paymentCap = Number(maxPaymentTinybars);
      const taskCap = Number(taskBudgetTinybars);
      if (!Number.isSafeInteger(paymentCap) || paymentCap < 1 || !Number.isSafeInteger(taskCap) || taskCap < 1) throw new Error("Set valid per-payment and task spending limits in Spending & Permissions first.");
      const effectiveBudgetTinybars = Math.min(budgetTinybars, paymentCap, taskCap);
      if (effectiveBudgetTinybars < 1) throw new Error("No marketplace budget remains under the current spending limits.");
      const response = await fetch(apiUrl("/api/marketplace/negotiate"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: marketplaceGoal.trim(), budgetTinybars: effectiveBudgetTinybars }) });
      const result = await response.json() as MarketplaceNegotiation;
      if (!response.ok) throw new Error(result.error ?? "Marketplace negotiation failed.");
      setMarketplaceResult(result);
      setNotice(result.offers.length ? "Offers discovered. The buyer agent recommendation is advisory: choose an eligible provider below. No payment was attempted." : "No provider offers were returned. No payment was attempted.");
    } catch (e) { setError(e instanceof Error ? e.message : "Marketplace negotiation failed."); }
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
  const visibleAnchors = anchors.slice(0, visibleAnchorCount);
  const visibleRecords = records.slice(0, visibleRecordCount);

  const recentRuns = records.filter(record => record.event.startsWith("agent.run_")).slice(0, 6);
  const latestReceipt = taskReceipts[0];
  const dailyBudgetHbar = firewall ? (Number(firewall.dailyBudgetTinybars) / 100_000_000).toFixed(3) : "0.005";
  const pageTitles: Record<PageId, { eyebrow: string; title: string; description: string }> = {
    overview: { eyebrow: "YOUR PAYMENT WORKSPACE", title: "Agent payments, under control.", description: "A clear view of readiness, limits, task activity and verifiable evidence." },
    playground: { eyebrow: "AGENT PLAYGROUND", title: "Give your agent a task.", description: "Preview real registered-service quotes first. Nothing is paid during preview." },
    marketplace: { eyebrow: "AGENT MARKETPLACE", title: "Let agents compete for the task.", description: "Discover provider agents, compare live x402 quotes, and select a bounded offer before authorizing any payment." },
    permissions: { eyebrow: "SPENDING & PERMISSIONS", title: "You set the boundaries.", description: "Choose the test network, set hard limits, approve services and control each authorization." },
    payments: { eyebrow: "PAYMENTS & RECEIPTS", title: "Follow every payment.", description: "See the receipt returned by the API and verify transaction evidence independently." },
    audit: { eyebrow: "AUDIT & HCS EVIDENCE", title: "Evidence, not assumptions.", description: "Inspect the local hash chain and verify anchored audit hashes against the public Mirror Node." },
  };
  const title = pageTitles[page];

  return <main className="dashboard product-shell">
    <header className="dash-topbar">
      <a className="dash-brand" href="#overview" onClick={() => setPage("overview")}><span className="dash-mark">h1</span>heder<span>1</span></a>
      <div className="topbar-right">
        <span className="network-badge"><i className={data.health?.status === "ok" ? "dot good" : "dot"} />Hedera Testnet</span>
        <button className="button secondary small" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
      </div>
    </header>
    <nav className="product-nav" aria-label="Main navigation">
      {([
        ["overview", "Overview", "⌂"],
        ["playground", "Agent Playground", "✳"],
        ["marketplace", "Agent Marketplace", "⇄"],
        ["permissions", "Spending & Permissions", "◈"],
        ["payments", "Payments & Receipts", "↗"],
        ["audit", "Audit & HCS Evidence", "◇"],
      ] as Array<[PageId, string, string]>).map(([id, label, symbol]) =>
        <a key={id} href={"#" + id} className={page === id ? "product-nav-link active" : "product-nav-link"} aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>
          <span aria-hidden="true">{symbol}</span>{label}
        </a>
      )}
    </nav>
    <section className="product-page-heading">
      <div><p className="dash-kicker">{title.eyebrow}</p><h1>{title.title}</h1><p className="dash-intro">{title.description}</p></div>
      <div className="hero-status"><span className={data.health?.status === "ok" ? "status-light live" : "status-light"}></span><div><strong>{data.health?.status === "ok" ? "API connected" : "Waiting for API"}</strong><small>{data.health?.status === "ok" ? "Live backend status" : "Start the API and refresh"}</small></div><span className="mono">TESTNET</span></div>
    </section>
    {error && <div className="dash-alert error-alert" role="alert">{error}</div>}
    {notice && <div className="dash-alert success-alert" role="status">{notice}</div>}

    {page === "overview" && <>
      <section className="metric-grid" aria-label="Live system status">
        <article className="metric"><span>PAYMENT NETWORK</span><strong>Hedera Testnet</strong><small>{data.x402?.sdkConfigured ? "Payer configuration detected" : "Payment account not configured"}</small></article>
        <article className="metric"><span>AGENT READINESS</span><strong className={data.agentV2?.killSwitchEnabled ? "text-danger" : data.agentV2?.enabled ? "text-good" : "text-warn"}>{data.agentV2?.killSwitchEnabled ? "Paused by safety switch" : data.agentV2?.enabled ? "Available locally" : "Not enabled"}</strong><small>{data.agentV2?.paymentExecutionEnabled ? "Server permits local testnet execution" : "Server-side execution is disabled"}</small></article>
        <article className="metric"><span>DAILY SPENDING CAP</span><strong>{dailyBudgetHbar} HBAR</strong><small>API-enforced limit · not a balance</small></article>
        <article className="metric"><span>AUDIT INTEGRITY</span><strong className={data.audit?.valid ? "text-good" : "text-danger"}>{data.audit ? data.audit.valid ? "Hash chain valid" : "Check failed" : "Unavailable"}</strong><small>{data.audit?.records ?? 0} local audit records</small></article>
      </section>
      <section className="overview-grid">
        <article className="panel overview-card"><div className="panel-head"><div><p className="dash-kicker">START HERE</p><h2>Guided task flow</h2></div><span className="chip good-chip">TESTNET ONLY</span></div>
          <ol className="guided-steps">
            <li><span>1</span><div><strong>Connect your wallet</strong><small>Use a compatible EVM wallet on Hedera Testnet.</small></div><button className="text-action" onClick={() => navigate("permissions")}>{wallet ? "Wallet connected" : "Set up →"}</button></li>
            <li><span>2</span><div><strong>Set your boundaries</strong><small>Choose approved services, task and daily caps.</small></div><button className="text-action" onClick={() => navigate("permissions")}>Review →</button></li>
            <li><span>3</span><div><strong>Preview a task</strong><small>Compare the live HTTP 402 quotes without paying.</small></div><button className="text-action" onClick={() => navigate("playground")}>Preview →</button></li>
            <li><span>4</span><div><strong>Authorize and run</strong><small>Sign a bounded policy or an exact quote when requested.</small></div><button className="text-action" onClick={() => navigate("playground")}>Open playground →</button></li>
            <li><span>5</span><div><strong>Check receipts</strong><small>Confirm any transaction on HashScan.</small></div><button className="text-action" onClick={() => navigate("payments")}>View receipts →</button></li>
          </ol>
        </article>
        <article className="panel overview-card"><div className="panel-head"><div><p className="dash-kicker">NETWORK SAFETY</p><h2>Current mode</h2></div><span className="chip good-chip">MAINNET OFF</span></div>
          <div className="network-summary"><span className="network-summary-icon">H</span><div><strong>Hedera Testnet</strong><small>Only enabled payment network</small></div><span className="status-pill">Selected</span></div>
          <p className="panel-footnote">{data.networks?.mainnet.reason ?? "Mainnet is disabled by default."}</p>
          <div className="safety-callout"><strong>Important</strong><p>A quote is not a payment. A task response is not proof of settlement. Verify a transaction ID on HashScan before treating a payment as final.</p></div>
          <button className="button secondary block-button" onClick={() => navigate("audit")}>Review audit evidence</button>
        </article>
      </section>
      <section className="overview-grid">
        <article className="panel overview-card"><div className="panel-head"><div><p className="dash-kicker">RECENT TASK ACTIVITY</p><h2>Latest runs</h2></div><button className="text-action" onClick={() => navigate("payments")}>All activity →</button></div>
          {recentRuns.length ? <div className="activity-list">{recentRuns.map(record => <div key={record.id}><span className={record.outcome === "failed" || record.outcome === "rejected" ? "activity-dot bad" : "activity-dot"}></span><div><strong>{record.event.replaceAll(".", " · ")}</strong><small>{new Date(record.timestamp).toLocaleString()}</small></div><span className={record.outcome === "failed" || record.outcome === "rejected" ? "outcome bad" : "outcome"}>{record.outcome}</span></div>)}</div> : <div className="empty-state"><strong>No task runs recorded yet</strong><p>Your task activity appears here after the API records it.</p></div>}
        </article>
        <article className="panel overview-card"><div className="panel-head"><div><p className="dash-kicker">LATEST RECEIPT</p><h2>Payment evidence</h2></div><button className="text-action" onClick={() => navigate("payments")}>View receipts →</button></div>
          {latestReceipt ? <div className="receipt-feature"><span className="receipt-check">↗</span><div><strong>{latestReceipt.serviceId}</strong><small>{latestReceipt.amountHbar} HBAR · {latestReceipt.status}</small><a href={latestReceipt.explorerUrl} target="_blank" rel="noreferrer">Open HashScan ↗</a></div></div> : <div className="empty-state"><strong>No task receipt in this session</strong><p>Receipts are shown when the API returns a transaction ID and explorer URL. Older transactions may still appear in audit records.</p></div>}
        </article>
      </section>
      <footer className="dash-footer"><span>heder1 / Security-first autonomous payments on Hedera</span><span>Testnet only · Mainnet payment execution is not implemented</span></footer>
    </>}

    {page === "playground" && <>
      <section className="panel playground-panel">
        <div className="page-purpose-banner playground-purpose"><span className="purpose-icon">▶</span><div><strong>Agent Playground · Execute a task</strong><p>Use this workspace when you already know what you want to do. Preview service quotes, choose authorization rules, and run a bounded Testnet task. To discover and compare providers before deciding who to hire, start in Agent Marketplace.</p><div className="purpose-actions"><button className="button secondary small" onClick={() => navigate("marketplace")}>Find a provider first →</button><button className="button secondary small" onClick={() => navigate("permissions")}>Review safety limits →</button></div></div></div>
        <div className="panel-head"><div><p className="dash-kicker">01 / TASK INPUT</p><h2>What should the agent do?</h2></div><span className="chip">MAX 2,000 CHARACTERS</span></div>
        <label className="form-label" htmlFor="task-goal">Task description</label>
        <textarea id="task-goal" className="task-textarea" maxLength={2000} value={taskGoal} onChange={event => { setTaskGoal(event.target.value); setPlanDetails(null); setPolicySimulation(null); }} placeholder="Describe the task you want the agent to perform…" />
        <div className="field-meta"><span>Use a specific, bounded request.</span><span>{taskGoal.length}/2000</span></div>
        <div className="playground-controls"><div><strong>Execution mode</strong><small>{agentMode === "preview" ? "Preview only — choose an execution mode below to run a task" : agentMode === "approval-required" ? "Wallet approval required for the exact quote" : "Bounded execution with a one-time policy grant"}</small></div><button className="button secondary" onClick={() => navigate("permissions")}>Review limits & permissions →</button></div>
        <div className="user-policy-box">
          <label>How should the agent be authorized?
            <select value={agentMode} onChange={event => { setAgentMode(event.target.value as "preview" | "autonomous" | "approval-required"); setToken(""); setPolicySimulation(null); setPlanDetails(null); }}>
              <option value="preview">Preview only — no payment</option>
              <option value="autonomous">Bounded execution — sign one-time policy</option>
              <option value="approval-required">Approve each exact quote in wallet</option>
            </select>
          </label>
          <div className="connected-wallet">
            <span className="mini-avatar">W</span>
            <div><strong>{wallet ? shorten(wallet) : "Wallet not connected"}</strong><small>{wallet ? isTestnet ? "Hedera Testnet verified" : "Wrong network — switch before running" : "Connect a compatible EVM wallet to authorize tasks"}</small></div>
            {!wallet ? <button className="button primary small" disabled={Boolean(busy)} onClick={() => void connectWallet()}>Connect wallet</button> : !isTestnet ? <button className="button secondary small" disabled={Boolean(busy)} onClick={() => void switchNetwork()}>Switch network</button> : <span className="status-pill">TESTNET</span>}
          </div>
          <label className="consent-row"><input type="checkbox" checked={consent} disabled={!wallet || !isTestnet || Boolean(busy) || sessionPaused} onChange={event => setConsent(event.target.checked)} /><span>I consent to one bounded testnet task under the configured spending limits and approved-service allowlist.</span></label>
          {agentMode === "autonomous" && <div className="action-row">
            <button className="button secondary" disabled={sessionPaused || !wallet || !isTestnet || !consent || Boolean(token) || Boolean(busy)} onClick={() => void authorize()}>{busy === "authorize" ? "Waiting for wallet signature…" : token ? "One-time authorization ready" : "Sign one-time authorization"}</button>
            {token && <button className="button secondary" disabled={Boolean(busy)} onClick={() => void revokeGrant()}>Revoke authorization</button>}
          </div>}
          {agentMode === "approval-required" && <p className="panel-footnote">You will review and sign the exact selected quote in your wallet when you run the task. A separate reusable grant is not required.</p>}
          {agentMode === "preview" && <p className="panel-footnote">Preview mode never pays. Choose one of the execution modes above to enable task execution.</p>}
        </div>
        <div className="action-row"><button className="button primary" disabled={Boolean(busy) || !taskGoal.trim()} onClick={() => void simulatePolicy(true)}>{busy === "simulate" ? "Checking service quotes…" : "Preview plan & compare services"}</button>
          <button className="button secondary" disabled={sessionPaused || Boolean(busy) || !taskGoal.trim() || !wallet || !isTestnet || !consent || (agentMode === "autonomous" && !token) || agentMode === "preview" || Boolean(data.agentV2?.killSwitchEnabled) || data.agentV2?.paymentExecutionEnabled === false} onClick={() => void runAgent()}>{busy === "agent" ? "Agent working…" : agentMode === "approval-required" ? "Review quote & run task" : "Run authorized task"}</button>
        </div>
        {agentMode !== "preview" && !token && agentMode === "autonomous" && <p className="panel-footnote">Sign the one-time authorization above before running. Your wallet signs a message, not a payment transaction.</p>}
        {data.agentV2?.paymentExecutionEnabled === false && <div className="safety-callout warning-callout"><strong>Payment execution is disabled by the API</strong><p>The server currently does not permit payment execution. The Playground cannot override this setting.</p></div>}
      </section>
      <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">02 / PLAN PREVIEW</p><h2>Service comparison</h2></div><span className="chip">{planDetails?.paymentAttempted === false ? "NO PAYMENT ATTEMPTED" : "LIVE QUOTES"}</span></div>
        {planDetails?.selected ? <div className="selected-quote"><div><span className="quote-label">LOWEST ELIGIBLE QUOTE</span><h3>{planDetails.selected.serviceId}</h3><p>{planDetails.selected.description ?? "Approved registered service"}</p></div><div className="quote-amount"><strong>{planDetails.selected.amountHbar} HBAR</strong><small>{planDetails.selected.amountTinybars.toLocaleString()} tinybars</small></div></div> : <div className="empty-state"><strong>{planDetails ? "No eligible quote found" : "Preview before authorizing"}</strong><p>{planDetails ? "The API did not find a quote that fits your network, asset, service allowlist and spending caps. Review the rejection reasons below." : "Run a preview to discover current HTTP 402 quotes from approved services and see why each one is eligible or rejected."}</p></div>}
        {planDetails?.candidates && <div className="service-comparison">{planDetails.candidates.map(candidate => <article key={candidate.serviceId} className="service-quote-card"><div><strong>{candidate.serviceId}</strong><span className={candidate.status === "quoted" ? "outcome" : "outcome bad"}>{candidate.status === "quoted" ? "Eligible quote" : candidate.status === "no-quote" ? "No quote" : /budget|cap|policy|allowlist|limit/i.test(candidate.reason) ? "Rejected by spending limit" : "Rejected"}</span></div><p>{candidate.reason}</p>{typeof candidate.amountTinybars === "number" && <small>{candidate.amountTinybars.toLocaleString()} tinybars · {(candidate.amountTinybars / 100_000_000).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} HBAR</small>}</article>)}</div>}
        {planDetails?.note && <p className="panel-footnote">{planDetails.note}</p>}
      </section>
      {taskReceipts.length > 0 && <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">03 / TASK RESULT</p><h2>Receipts returned by the API</h2></div><span className="chip">{taskReceipts.length} RECEIPT(S)</span></div><div className="receipt-list">{taskReceipts.map(receipt => <div key={receipt.transactionId}><div><strong>{receipt.serviceId}</strong><small>{receipt.amountHbar} HBAR · {receipt.status}</small><code>{receipt.transactionId}</code></div><a href={receipt.explorerUrl} target="_blank" rel="noreferrer">Verify on HashScan ↗</a></div>)}</div>{taskWarnings.length > 0 && <div className="safety-callout warning-callout"><strong>Task warnings</strong><p>{taskWarnings.join(" ")}</p></div>}</section>}
      <footer className="dash-footer"><span>Tasks run only against the code-registered local testnet services.</span><span>Never retry while settlement status is unknown.</span></footer>
    </>}

    {page === "marketplace" && <>
      <section className="panel wide-panel">
        <div className="page-purpose-banner marketplace-purpose"><span className="purpose-icon">⇄</span><div><strong>Agent Marketplace · Discover and hire</strong><p>Use this workspace when you need to decide which provider should handle a task. The buyer requests offers, compares capabilities and live prices, and recommends a provider. It does not execute work or move money. When you choose an offer, continue to Agent Playground to review the task and authorize execution.</p><div className="purpose-actions"><button className="button secondary small" onClick={() => navigate("playground")}>Go to direct task execution →</button><button className="button secondary small" onClick={() => navigate("audit")}>View audit evidence →</button></div></div></div>
        <div className="panel-head"><div><p className="dash-kicker">01 / BUYER AGENT</p><h2>Describe the job to hire</h2></div><span className="chip">NO PAYMENT DURING NEGOTIATION</span></div>
        <p className="panel-copy">A buyer agent asks each registered local provider to respond using its current x402 quote. The buyer can accept only an offer that matches task intent and remains inside your declared budget and Heder1's hard payment ceiling. Current providers are local demos, not independent third-party agents; their identity is not cryptographically verified.</p>
        <label className="form-label" htmlFor="marketplace-goal">Task requested</label>
        <textarea id="marketplace-goal" className="task-textarea" maxLength={2000} value={marketplaceGoal} onChange={event => setMarketplaceGoal(event.target.value)} placeholder="Describe the task a provider agent should complete…" />
        <label className="form-label" htmlFor="marketplace-budget">Maximum task budget (tinybars)</label>
        <input id="marketplace-budget" className="number-input" type="number" min="1" max="500000" value={marketplaceBudget} onChange={event => setMarketplaceBudget(event.target.value)} />
        <div className="button-row"><button className="button primary" onClick={() => void negotiateMarketplace()} disabled={busy === "marketplace" || !marketplaceGoal.trim()}>{busy === "marketplace" ? "Discovering and comparing…" : "Discover & negotiate offers"}</button><span className="panel-footnote">100,000 tinybars = 0.001 HBAR · Testnet only</span></div>
      </section>
      {marketplaceResult && <>
        <section className="panel wide-panel">
          <div className="panel-head"><div><p className="dash-kicker">02 / PROVIDER OFFERS</p><h2>{marketplaceResult.offers.length ? "Choose a provider" : "No provider offers"}</h2><p className="panel-copy">The buyer-agent recommendation is shown for comparison only. Select an eligible offer yourself before continuing.</p></div><span className="chip">{marketplaceResult.offers.length} OFFERS</span></div>
          <div className="permission-status-grid">
            {marketplaceResult.offers.map(offer => <article className="permission-stat" key={offer.agentId}>
              <span>{offer.agentName}</span><strong>{offer.amountHbar ? offer.amountHbar + " HBAR" : "No eligible quote"}</strong>
              <small>{offer.serviceId} · {offer.status}</small><p>{offer.description}</p><p>{offer.reason}</p>
              <small>Capabilities: {offer.capabilities.join(", ")}</small><small>Identity: {offer.identityStatus}</small>
              <button className={selectedMarketplaceServiceId === offer.serviceId ? "button primary small" : "button secondary small"} disabled={offer.status !== "eligible" || typeof offer.amountTinybars !== "number" || offer.negotiation.response === "rejected"} onClick={() => { const originalGoal = marketplaceGoal.trim(); const chosenGoal = offer.capabilityMatch ? originalGoal : offer.serviceId === "heder1-short-summary" ? `Create a concise summary of this request: ${originalGoal}` : `Create a detailed full report about this request: ${originalGoal}`; setSelectedMarketplaceServiceId(offer.serviceId); setTaskGoal(chosenGoal.slice(0, 2000)); setAllowedServiceIds([offer.serviceId]); setPlanDetails(null); setPolicySimulation(null); setToken(""); setConsent(false); setNotice(offer.capabilityMatch ? `${offer.agentName} selected at ${offer.amountHbar} HBAR. No payment was attempted. Review the task and re-consent/re-authorize in Agent Playground.` : `${offer.agentName} selected as an alternative at ${offer.amountHbar} HBAR. The task wording was adjusted to match this provider’s advertised capability; review it in Agent Playground. No payment was attempted. Re-consent and authorize again.`); }}>{selectedMarketplaceServiceId === offer.serviceId ? "Selected provider ✓" : offer.negotiation.response === "countered" ? "Choose alternative" : "Choose this provider"}</button>
              {(offer.status !== "eligible" || offer.negotiation.response === "rejected") && <small className="panel-footnote">Not selectable: this quote is outside the current effective budget/cap or was rejected by the provider.</small>}
              {offer.negotiation.response === "countered" && offer.status === "eligible" && <small className="panel-footnote">Alternative selection will adapt the task wording to this provider’s capability. Review the revised task before authorizing.</small>}
              <div className="offer-response"><span className={offer.negotiation.response === "accepted" ? "outcome" : offer.negotiation.response === "rejected" ? "outcome bad" : "outcome"}>{offer.negotiation.response === "accepted" ? "Provider accepts" : offer.negotiation.response === "rejected" ? "Provider rejects" : "Provider counteroffer"}</span><small>{offer.negotiation.reason}</small>{offer.negotiation.counterOfferTinybars !== null && <small>Counter-offer: {offer.negotiation.counterOfferTinybars.toLocaleString()} tinybars (advisory only; live x402 quote remains final).</small>}</div>
            </article>)}
          </div>
          {marketplaceResult.negotiationLog.length > 0 && <div className="negotiation-log"><div className="panel-head"><div><p className="dash-kicker">NEGOTIATION TRANSCRIPT</p><h3>Buyer and provider responses</h3></div><span className="chip">{marketplaceResult.rounds} ROUND(S)</span></div>{marketplaceResult.negotiationLog.map((entry, index) => <div className="negotiation-log-row" key={entry.round + "-" + entry.agentId + "-" + index}><span>R{entry.round}</span><strong>{entry.agentName}</strong><span>{entry.action}</span><code>{entry.amountTinybars === null ? "—" : entry.amountTinybars.toLocaleString() + " tinybars"}</code><small>{entry.reason}</small></div>)}</div>}
          {marketplaceResult.selected && <div className="safety-callout"><strong>Buyer-agent recommendation: {marketplaceResult.selected.agentName}</strong><p>{marketplaceResult.selected.reason} This is a recommendation, not your choice or payment authorization.</p></div>}
          {selectedMarketplaceServiceId && <div className="safety-callout"><strong>Your chosen provider: {marketplaceResult.offers.find(offer => offer.serviceId === selectedMarketplaceServiceId)?.agentName ?? selectedMarketplaceServiceId}</strong><p>The Playground will be restricted to this selected service for the next task. The API will still re-check live quote, wallet authorization, network, and spending policy before any payment.</p><div className="button-row"><button className="button primary" onClick={() => navigate("playground")}>Continue with chosen provider →</button><span className="panel-footnote">No payment has been attempted. You must still review limits and authorize execution.</span></div></div>}
          <p className="panel-footnote">Negotiation ID: <code>{marketplaceResult.negotiationId}</code>. Payment attempted: {marketplaceResult.paymentAttempted ? "yes" : "no"}. Current IDs are local and unverified; this deterministic workflow is not full A2A/ACP conformance.</p>
        </section>
      </>}
      <footer className="dash-footer"><span>Provider quotes are discovered from the live x402 HTTP 402 response.</span><span>No quote selection can bypass wallet authorization, spending policy, or the server kill switch.</span></footer>
    </>}

    {page === "permissions" && <>
      <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">01 / NETWORK & ACCOUNT</p><h2>Connect and confirm the network</h2></div><span className={wallet ? isTestnet ? "chip good-chip" : "chip" : "chip"}>{wallet ? isTestnet ? "TESTNET VERIFIED" : "WRONG NETWORK" : "WALLET DISCONNECTED"}</span></div>
        <p className="panel-copy">Connect a compatible EVM wallet. heder1 supports Hedera Testnet for payment execution; mainnet is not enabled.</p>
        {wallet ? <div className="connected-wallet"><span className="mini-avatar">W</span><div><strong>{shorten(wallet)}</strong><small>Chain ID {Number.parseInt(chain || "0", 16) || "unknown"}</small></div><button className="button secondary small" onClick={() => { setWallet(""); setChain(""); setConsent(false); setToken(""); }}>Disconnect</button></div> : <button className="button primary" onClick={() => void connectWallet()}>Connect EVM wallet</button>}
        {wallet && !isTestnet && <button className="button secondary block-button" onClick={() => void switchNetwork()}>Switch to Hedera Testnet</button>}
        <div className="network-summary"><span className="network-summary-icon">H</span><div><strong>Hedera Testnet</strong><small>Chain ID 296 · CAIP-2 network hedera:testnet</small></div><span className="status-pill">Only enabled</span></div>
        <div className="safety-callout"><strong>Mainnet payment execution is disabled</strong><p>{data.networks?.mainnet.reason ?? "The API reports testnet as the only enabled network. The UI cannot override this."} Readiness acknowledgement, if configured, is not transaction authorization.</p></div>
      </section>
      <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">02 / SPENDING LIMITS</p><h2>Define your boundaries</h2></div><span className="chip">SERVER-ENFORCED</span></div>
        <div className="user-policy-box">
          <label>Approval mode<select value={agentMode} onChange={event => { setAgentMode(event.target.value as "preview" | "autonomous" | "approval-required"); setPolicySimulation(null); setPlanDetails(null); setToken(""); }}><option value="preview">Preview only — no payment</option><option value="autonomous">Bounded agent — within signed limits</option><option value="approval-required">Approve each exact quote</option></select></label>
          <div className="policy-fields"><label>Maximum per payment (tinybars)<input inputMode="numeric" value={maxPaymentTinybars} onChange={event => { setMaxPaymentTinybars(event.target.value); setToken(""); setPolicySimulation(null); }} /></label><label>Maximum per task (tinybars)<input inputMode="numeric" value={taskBudgetTinybars} onChange={event => { setTaskBudgetTinybars(event.target.value); setToken(""); setPolicySimulation(null); }} /></label><label>Daily budget (tinybars)<input inputMode="numeric" value={dailyBudgetTinybars} onChange={event => { setDailyBudgetTinybars(event.target.value); setToken(""); setPolicySimulation(null); }} /></label><label>Paid calls per task (max 3)<input inputMode="numeric" value={maxPaidCallsPerTask} onChange={event => { setMaxPaidCallsPerTask(event.target.value); setToken(""); setPolicySimulation(null); }} /></label><label>Daily paid-call limit<input inputMode="numeric" value={maxPaidCallsPerDay} onChange={event => { setMaxPaidCallsPerDay(event.target.value); setToken(""); setPolicySimulation(null); }} /></label><label>Approval threshold (tinybars)<input inputMode="numeric" value={approvalThresholdTinybars} onChange={event => { setApprovalThresholdTinybars(event.target.value); setToken(""); setPolicySimulation(null); }} /></label></div>
          <div className="service-allowlist"><div><strong>Approved services</strong><small>Only these code-registered services can be selected.</small></div>
            {[
              ["heder1-full-report", "Full report", "Full demo report with settlement receipt."],
              ["heder1-short-summary", "Short summary", "Short summary report with settlement receipt."],
            ].map(([id, label, description]) => <label key={id} className="allowlist-option"><input type="checkbox" checked={allowedServiceIds.includes(id)} onChange={event => { setAllowedServiceIds(current => event.target.checked ? [...current, id] : current.filter(item => item !== id)); setToken(""); setPolicySimulation(null); setPlanDetails(null); }} /><span><strong>{label}</strong><small>{description}</small><code>{id}</code></span></label>)}
          </div>
          <p className="panel-footnote">Hard ceilings: 100,000 tinybars per payment, 500,000 per task, 1,000,000 per day. HBAR only, Hedera Testnet only. Tinybars: 100,000,000 = 1 HBAR.</p>
          <div className="action-row"><button className="button secondary" onClick={() => { setAgentMode("preview"); void simulatePolicy(true); }} disabled={Boolean(busy) || allowedServiceIds.length === 0}>{busy === "simulate" ? "Checking quotes…" : "Test these limits with a preview"}</button></div>
          {policySimulation && <div className={policySimulation.allowed ? "verify-result valid" : "verify-result invalid"} role="status"><strong>{policySimulation.allowed ? "Policy check passed" : "Policy check blocked"}</strong><span>{policySimulation.reason}</span></div>}
        </div>
      </section>
      <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">03 / AUTHORIZATION</p><h2>Authorize one bounded task</h2></div><span className={sessionPaused ? "chip" : token ? "chip good-chip" : "chip"}>{sessionPaused ? "NEW RUNS PAUSED" : token ? "ONE-TIME GRANT READY" : "EXPLICIT CONSENT REQUIRED"}</span></div>
        <div className={sessionPaused ? "pause-banner paused" : "pause-banner"}><div><strong>{sessionPaused ? "New runs are paused in this browser" : "Execution controls"}</strong><small>{sessionPaused ? "Resume when you are ready. This does not stop a task already submitted to the API." : "Pause here to block new runs from this browser session."}</small></div><button className={sessionPaused ? "button primary" : "button secondary"} onClick={() => { if (!sessionPaused) { setSessionPaused(true); setConsent(false); setNotice("New runs paused in this browser. This is not a server-wide kill switch; cancel any active task separately and check settlement status."); if (token) void revokeGrant(); } else { setSessionPaused(false); setNotice("Browser-side pause lifted. Review the policy and give consent again before running a task."); } }}>{sessionPaused ? "Resume new runs" : "Pause new runs"}</button></div>
        <label className="consent-row"><input type="checkbox" checked={consent} disabled={!wallet || !isTestnet || Boolean(busy)} onChange={event => setConsent(event.target.checked)} /><span>I understand this authorizes one bounded testnet task under the limits and allowlist above. My wallet signs a message; this is not a transaction signature by itself.</span></label>
        <div className="action-row"><button className="button primary" onClick={() => void authorize()} disabled={sessionPaused || !wallet || !isTestnet || !consent || Boolean(token) || Boolean(busy) || agentMode === "approval-required" || allowedServiceIds.length === 0}>{busy === "authorize" ? "Waiting for wallet signature…" : token ? "Authorization ready" : "Sign one-time authorization"}</button>
          {token && <button className="button secondary" onClick={() => void revokeGrant()} disabled={Boolean(busy)}>{busy === "revoke" ? "Revoking…" : "Revoke unused grant"}</button>}
          {busy === "agent" && activeRunId && <button className="button secondary" onClick={() => void cancelActiveRun()} disabled={cancelBusy}>{cancelBusy ? "Requesting cancellation…" : "Cancel active task"}</button>}
        </div>
        <div className="permission-status-grid"><div><span>Wallet</span><strong>{wallet ? shorten(wallet, 7, 5) : "Not connected"}</strong></div><div><span>Network</span><strong>{isTestnet ? "Hedera Testnet" : "Not verified"}</strong></div><div><span>Consent</span><strong>{consent ? "Granted for this session" : "Not granted"}</strong></div><div><span>Grant</span><strong>{token ? "Issued · single use" : "Not issued"}</strong></div></div>
        <p className="panel-footnote">The API consumes grants once. Changing policy settings clears the local grant. Server-side kill switch and hard caps cannot be overridden by the UI.</p>
      </section>
      <footer className="dash-footer"><span>Spending controls are sent to and validated by the API.</span><span>Never put private keys or facilitator secrets in this web app.</span></footer>
    </>}

    {page === "payments" && <>
      <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">LATEST TASK RECEIPTS</p><h2>Receipts from this session</h2></div><span className="chip">{taskReceipts.length} RECEIPT(S)</span></div>
        {taskReceipts.length ? <div className="receipt-list">{taskReceipts.map(receipt => <div key={receipt.transactionId}><div><strong>{receipt.serviceId}</strong><small>{receipt.amountHbar} HBAR · {receipt.status}</small><code>{receipt.transactionId}</code></div><a href={receipt.explorerUrl} target="_blank" rel="noreferrer">Open HashScan ↗</a></div>)}</div> : <div className="empty-state"><strong>No receipts from this session yet</strong><p>A receipt appears here only when the agent API returns a transaction ID and explorer URL. You can still inspect recent audit events below.</p><button className="button secondary" onClick={() => navigate("playground")}>Open Agent Playground</button></div>}
      </section>
      <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">PAYMENT & TASK EVENTS</p><h2>Recent payment history</h2></div><span className="chip">{records.length} AUDIT EVENTS</span></div>
        {records.length ? <div className="table-wrap"><table><thead><tr><th>Task / event</th><th>State</th><th>Amount / service</th><th>Transaction evidence</th><th>Time</th></tr></thead><tbody>{records.filter(record => /agent\.run|payment|settle|reservation/i.test(record.event)).map(record => { const details = record.details ?? {}; const tx = typeof details.transactionId === "string" ? details.transactionId : typeof details.transaction === "string" ? details.transaction : ""; const amount = typeof details.amountTinybars === "number" || typeof details.amountTinybars === "string" ? String(details.amountTinybars) + " tinybars" : "Not recorded"; const service = typeof details.serviceId === "string" ? details.serviceId : "—"; return <tr key={record.id}><td><strong>{record.event.replaceAll(".", " · ")}</strong><small>Sequence #{record.sequence}</small></td><td><span className={record.outcome === "rejected" || record.outcome === "failed" ? "outcome bad" : "outcome"}>{record.outcome}</span></td><td><strong>{amount}</strong><small>{service}</small></td><td>{tx ? <a href={hashscanTx(tx)} target="_blank" rel="noreferrer">{shorten(tx)} ↗</a> : <span className="unverified-label">No transaction ID in this audit event</span>}</td><td>{new Date(record.timestamp).toLocaleString()}</td></tr>; })}</tbody></table></div> : <div className="empty-state"><strong>No payment events found</strong><p>Run a preview or task to begin generating activity.</p></div>}
        <div className="safety-callout"><strong>Settlement rule</strong><p>Do not infer a payment from a successful agent response alone. Confirm the returned transaction ID on HashScan and treat missing or ambiguous transaction evidence as unresolved until reconciled.</p></div>
      </section>
      <footer className="dash-footer"><span>Explorer links are built only from transaction IDs returned by the API or recorded in the audit log.</span><span>HashScan is external evidence; this UI does not independently verify settlement.</span></footer>
    </>}

    {page === "audit" && <>
      <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">01 / LOCAL HASH CHAIN</p><h2>Audit integrity</h2></div><span className={data.audit?.valid ? "chip good-chip" : "chip"}>{data.audit ? data.audit.valid ? "HASH CHAIN VALID" : "INTEGRITY ERROR" : "NOT AVAILABLE"}</span></div>
        <div className="permission-status-grid"><div><span>Integrity</span><strong>{data.audit ? data.audit.valid ? "Valid" : "Failed" : "Unknown"}</strong></div><div><span>Records</span><strong>{data.audit?.records ?? 0}</strong></div><div><span>Storage</span><strong>{data.audit?.ledger ?? "Not reported"}</strong></div><div><span>HCS anchors</span><strong>{data.anchors?.anchors.length ?? 0}</strong></div></div>
        {data.audit?.headHash && <div className="hash-block"><span>Latest local chain head</span><code>{data.audit.headHash}</code></div>}
        <p className="panel-footnote">“Hash chain valid” means the local records are internally consistent. It does not mean every event was independently confirmed on-chain.</p>
      </section>
      <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">02 / HEDERA CONSENSUS SERVICE</p><h2>Anchored audit events</h2></div><span className="chip">{Math.min(visibleAnchorCount, anchors.length)} / {anchors.length} ANCHORS</span></div>
        {anchors.length ? <><div className="table-wrap"><table><thead><tr><th>Topic / sequence</th><th>Audit sequence</th><th>Audit hash</th><th>Public evidence</th></tr></thead><tbody>{visibleAnchors.map(anchor => <tr key={anchor.topicId + ":" + anchor.sequenceNumber}><td><strong>{anchor.topicId}</strong><small>Message #{anchor.sequenceNumber}</small></td><td>#{anchor.auditSequence}</td><td><code>{shorten(anchor.auditRecordHash, 12, 8)}</code></td><td><a href={anchor.mirrorNodeUrl} target="_blank" rel="noreferrer">Mirror Node ↗</a><button className="link-button" onClick={() => { setVerifyInput({ topicId: anchor.topicId, sequenceNumber: String(anchor.sequenceNumber), auditHash: anchor.auditRecordHash }); setVerification(null); }}>Verify this hash</button><a href={hashscanTx(anchor.transactionId)} target="_blank" rel="noreferrer">HashScan transaction ↗</a></td></tr>)}</tbody></table></div>{visibleAnchorCount < anchors.length && <div className="show-more-row"><button className="button secondary" onClick={() => setVisibleAnchorCount(count => Math.min(count + 7, anchors.length))}>Show more anchors <span>({anchors.length - visibleAnchorCount} remaining)</span></button></div>}</> : <div className="empty-state"><strong>No HCS anchors are indexed</strong><p>HCS anchoring may not be configured. An absent anchor is not proof that an event did or did not occur.</p></div>}
        <div className="verify-box"><div><strong>Verify an audit hash against Mirror Node</strong><p>Checks the selected topic message against the expected SHA-256 audit hash.</p></div><div className="verify-fields"><input aria-label="HCS topic ID" placeholder="Topic ID (0.0.x)" value={verifyInput.topicId} onChange={event => setVerifyInput({ ...verifyInput, topicId: event.target.value })}/><input aria-label="HCS sequence number" placeholder="Sequence" inputMode="numeric" value={verifyInput.sequenceNumber} onChange={event => setVerifyInput({ ...verifyInput, sequenceNumber: event.target.value })}/><input aria-label="Expected audit hash" placeholder="64-character SHA-256 hash" value={verifyInput.auditHash} onChange={event => setVerifyInput({ ...verifyInput, auditHash: event.target.value })}/><button className="button primary" disabled={busy === "verify" || !verifyInput.topicId || !verifyInput.sequenceNumber || !verifyInput.auditHash} onClick={() => void verifyAnchor()}>{busy === "verify" ? "Verifying…" : "Verify anchor"}</button></div>
          {verification && <div className={verification.valid ? "verify-result valid" : "verify-result invalid"} role="status"><strong>{verification.valid ? "Hash verified against Mirror Node" : "Verification failed"}</strong>{verification.anchoredAuditHash && <code>{verification.anchoredAuditHash}</code>}{verification.url && <a href={verification.url} target="_blank" rel="noreferrer">Open public message ↗</a>}{verification.error && <span>{verification.error}</span>}</div>}
        </div>
      </section>
      <section className="panel wide-panel"><div className="panel-head"><div><p className="dash-kicker">03 / AUDIT JOURNAL</p><h2>Recent audit records</h2></div><span className="chip">{Math.min(visibleRecordCount, records.length)} / {records.length} EVENTS</span></div>
        {records.length ? <><div className="table-wrap"><table><thead><tr><th>Event</th><th>Outcome</th><th>Time</th><th>Reference</th></tr></thead><tbody>{visibleRecords.map(record => { const details = record.details ?? {}; const tx = typeof details.transactionId === "string" ? details.transactionId : typeof details.transaction === "string" ? details.transaction : ""; return <tr key={record.id}><td><strong>{record.event.replaceAll(".", " · ")}</strong><small>Sequence #{record.sequence}</small></td><td><span className={record.outcome === "rejected" || record.outcome === "failed" ? "outcome bad" : "outcome"}>{record.outcome}</span></td><td>{new Date(record.timestamp).toLocaleString()}</td><td>{tx ? <a href={hashscanTx(tx)} target="_blank" rel="noreferrer">{shorten(tx)} ↗</a> : <code>{shorten(record.hash, 12, 8)}</code>}</td></tr>; })}</tbody></table></div>{visibleRecordCount < records.length && <div className="show-more-row"><button className="button secondary" onClick={() => setVisibleRecordCount(count => Math.min(count + 10, records.length))}>Show more events <span>({records.length - visibleRecordCount} remaining)</span></button></div>}</> : <div className="empty-state"><strong>No audit records yet</strong><p>Authorization, task, payment and readiness events appear here when recorded by the API.</p></div>}
      </section>
      <footer className="dash-footer"><span>Local hash-chain validation and public HCS verification are separate checks.</span><span>Never label an unverified claim as on-chain evidence.</span></footer>
    </>}
  </main>;
}
