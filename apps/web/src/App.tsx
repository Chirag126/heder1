import { useState } from "react";

type HealthResult = { status: string; service: string; network: string };
type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};
declare global {
  interface Window { ethereum?: Eip1193Provider }
}

const HEDERA_TESTNET_CHAIN_ID = "0x128"; // 296
const MAX_PAYMENT_HBAR = "0.001";
const ALLOWED_RESOURCE = "/api/x402/paid-resource";

function shortenAccount(account: string) {
  return account.length > 18 ? `${account.slice(0, 10)}…${account.slice(-6)}` : account;
}

export default function App() {
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [walletAccount, setWalletAccount] = useState("");
  const [walletChain, setWalletChain] = useState("");
  const [walletMessage, setWalletMessage] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [permissionApproved, setPermissionApproved] = useState(false);
  const [authorizationToken, setAuthorizationToken] = useState("");
  const [authorizing, setAuthorizing] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);

  async function checkBackend() {
    setChecking(true); setError("");
    try {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
      setHealth((await response.json()) as HealthResult);
    } catch {
      setError("Backend not reachable yet. Start both apps with pnpm dev.");
      setHealth(null);
    } finally { setChecking(false); }
  }

  async function connectWallet() {
    setError(""); setWalletMessage(""); setConnecting(true);
    try {
      if (!window.ethereum) {
        throw new Error("No EVM-compatible wallet was detected. Install or open a Hedera-compatible wallet with EVM support, then try again.");
      }
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("Wallet did not return an account.");
      setWalletAccount(accounts[0]);
      setWalletChain(String(chainId));
      setPermissionApproved(false);
      setWalletMessage(String(chainId).toLowerCase() === HEDERA_TESTNET_CHAIN_ID
        ? "Wallet connected on Hedera Testnet. No transaction was requested."
        : "Wallet connected, but the network is not Hedera Testnet. Payment authorization remains unavailable.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection failed.");
      setWalletAccount(""); setWalletChain(""); setPermissionApproved(false); setAuthorizationToken("");
    } finally { setConnecting(false); }
  }

  async function switchToTestnet() {
    setError(""); setWalletMessage("");
    try {
      if (!window.ethereum) throw new Error("No compatible wallet is available.");
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: HEDERA_TESTNET_CHAIN_ID }],
      });
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      setWalletChain(String(chainId));
      setPermissionApproved(false);
      setWalletMessage(String(chainId).toLowerCase() === HEDERA_TESTNET_CHAIN_ID
        ? "Hedera Testnet verified. Review the limited permission below before authorizing."
        : "The wallet is still on an unsupported network.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not switch wallet network.");
    }
  }

  function disconnectWallet() {
    setWalletAccount(""); setWalletChain(""); setPermissionApproved(false);
    setWalletMessage("Wallet disconnected from this page. Any wallet-level session may need to be disconnected in the wallet.");
  }

  async function authorizeOneRun() {
    setError(""); setWalletMessage(""); setAuthorizing(true); setAuthorizationToken("");
    try {
      if (!window.ethereum || !walletAccount || !isTestnet || !permissionApproved) {
        throw new Error("Connect a wallet, verify Hedera Testnet, and approve the limited permission first.");
      }
      const challengeResponse = await fetch("/api/authorization/challenge", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: walletAccount, chainId: 296 }),
      });
      const challenge = await challengeResponse.json() as { nonce?: string; message?: string; error?: string };
      if (!challengeResponse.ok || !challenge.nonce || !challenge.message) throw new Error(challenge.error ?? "Could not create authorization challenge.");
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [challenge.message, walletAccount],
      });
      if (typeof signature !== "string") throw new Error("Wallet did not return a signature.");
      const verifyResponse = await fetch("/api/authorization/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: challenge.nonce, signature }),
      });
      const verified = await verifyResponse.json() as { authorizationToken?: string; expiresAt?: string; error?: string };
      if (!verifyResponse.ok || !verified.authorizationToken) throw new Error(verified.error ?? "Wallet signature verification failed.");
      setAuthorizationToken(verified.authorizationToken);
      setWalletMessage(`One-time server authorization issued until ${verified.expiresAt}. No payment has been made.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not authorize the agent.");
    } finally { setAuthorizing(false); }
  }

  async function runAuthorizedAgent() {
    setError(""); setAgentRunning(true);
    try {
      if (!authorizationToken) throw new Error("Authorize one agent invocation first.");
      const response = await fetch("/api/agent/run", {
        method: "POST", headers: { "x-heder1-authorization": authorizationToken },
      });
      const result = await response.json() as { error?: string; decision?: string; response?: { status?: number }; authorization?: { consumed?: boolean } };
      setAuthorizationToken("");
      setPermissionApproved(false);
      if (!response.ok) throw new Error(result.error ?? `Agent request failed with HTTP ${response.status}.`);
      setWalletMessage(`Authorized agent invocation completed (HTTP ${result.response?.status ?? response.status}). The one-time authorization has been consumed.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authorized agent run failed.");
    } finally { setAgentRunning(false); }
  }

  const isTestnet = walletChain.toLowerCase() === HEDERA_TESTNET_CHAIN_ID;

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="heder1 home">
          <span className="brand-mark">h1</span><span>heder<span className="accent">1</span></span>
        </a>
        <span className="network-pill"><span className={isTestnet ? "pulse online" : "pulse"} /> {walletAccount ? (isTestnet ? "HEDERA TESTNET · VERIFIED" : "NETWORK NOT VERIFIED") : "HEDERA TESTNET · WALLET DISCONNECTED"}</span>
      </header>

      <section className="hero">
        <p className="eyebrow">AUTONOMOUS PAYMENTS · BUILT WITH GUARDRAILS</p>
        <h1>Let agents pay.<br /><span className="muted">Never let them overspend.</span></h1>
        <p className="intro">heder1 is a security-first payment layer for AI agents. Connect a compatible wallet to view its account and verify the network. Payment permissions remain bounded and explicit.</p>
        <div className="hero-actions">
          <button onClick={checkBackend} disabled={checking}>{checking ? "Checking backend…" : "Check backend connection"}</button>
          <span className="quiet">Testnet only · No payment executed</span>
        </div>
        {health && <div className="notice success" role="status">API status: {health.status} · Service: {health.service} · Network: {health.network}</div>}
      </section>

      <section className="wallet-panel" aria-labelledby="wallet-heading">
        <div className="section-heading"><div><p className="eyebrow">PHASE 4 · WALLET & AUTHORIZATION</p><h2 id="wallet-heading">Wallet connection</h2></div><span className="tag">{walletAccount ? "CONNECTED" : "NOT CONNECTED"}</span></div>
        <p className="panel-copy">Connect through your wallet's EVM provider. heder1 never asks for or stores your seed phrase or private key.</p>
        {!walletAccount ? <button onClick={connectWallet} disabled={connecting}>{connecting ? "Waiting for wallet…" : "Connect wallet"}</button> : (
          <div className="account-row">
            <div><span className="field-label">Connected account</span><strong title={walletAccount}>{shortenAccount(walletAccount)}</strong><span className="field-label">Chain ID: {walletChain}</span></div>
            <button className="secondary" onClick={disconnectWallet}>Disconnect</button>
          </div>
        )}
        {walletAccount && !isTestnet && <div className="notice warning" role="alert">Wrong network. Authorization is blocked until Hedera Testnet (chain ID 296) is verified.</div>}
        {walletAccount && !isTestnet && <button className="secondary switch-button" onClick={switchToTestnet}>Switch to Hedera Testnet</button>}
        {walletMessage && <p className="quiet wallet-message" role="status">{walletMessage}</p>}
        <div className="permission-box">
          <div className="permission-title"><span className="permission-icon">✓</span><div><strong>Limited payment permission</strong><p>One explicit approval · One allowlisted resource · No background spending</p></div></div>
          <dl className="limits">
            <div><dt>Network</dt><dd>Hedera Testnet only</dd></div>
            <div><dt>Maximum per invocation</dt><dd>{MAX_PAYMENT_HBAR} HBAR</dd></div>
            <div><dt>Resource</dt><dd><code>{ALLOWED_RESOURCE}</code></dd></div>
            <div><dt>Private-key access</dt><dd>Never granted to the frontend or AI</dd></div>
          </dl>
          <label className={`consent ${!isTestnet ? "disabled" : ""}`}>
            <input type="checkbox" checked={permissionApproved} disabled={!walletAccount || !isTestnet} onChange={(e) => setPermissionApproved(e.target.checked)} />
            <span>I approve this limited permission for a single task on Hedera Testnet.</span>
          </label>
          <div className="authorization-actions">
            <button className="secondary" onClick={authorizeOneRun} disabled={!walletAccount || !isTestnet || !permissionApproved || authorizing || Boolean(authorizationToken)}>
              {authorizing ? "Waiting for wallet signature…" : authorizationToken ? "One-time authorization ready" : "Sign & authorize one run"}
            </button>
            <button onClick={runAuthorizedAgent} disabled={!authorizationToken || agentRunning}>
              {agentRunning ? "Running agent…" : "Run authorized agent"}
            </button>
          </div>
          <p className="security-note">{authorizationToken ? "A short-lived, server-verified, single-use grant is ready. Running the agent may spend up to 0.001 HBAR on Hedera Testnet if the backend agent is enabled." : permissionApproved ? "Next, sign a one-time server challenge with your wallet. This signature does not itself transfer funds." : "Connect a wallet and verify Hedera Testnet before this permission can be selected."}</p>
        </div>
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}

      <section className="grid" aria-label="Project capabilities">
        <article className="feature-card"><span className="number">01</span><h2>Autonomous x402</h2><p>A client discovers a price and completes a paid HTTP request through the configured facilitator.</p><span className="status">TESTNET DEMO</span></article>
        <article className="feature-card"><span className="number">02</span><h2>Spending firewall</h2><p>Per-payment caps, a daily budget, and attempt limits are checked before the agent signs.</p><span className="status">IMPLEMENTED · LOCAL LEDGER</span></article>
        <article className="feature-card"><span className="number">03</span><h2>Explicit authorization</h2><p>Wallet identity and network are checked before the UI permits limited consent. No unrestricted wallet access.</p><span className="status">PHASE 4 · SIGNED ONE-TIME GRANT</span></article>
      </section>

      <footer><span>heder1 · ETHGlobal Mumbai preparation</span><span>Testnet only · Never put secrets in frontend code</span></footer>
    </main>
  );
}
