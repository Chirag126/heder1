import { randomUUID } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { getX402Configuration } from "./x402.js";
import { reserveAgentV2Spend } from "./spending-firewall.js";
import { DEFAULT_USER_SPENDING_POLICY, simulateSpendingPolicy, validateUserSpendingPolicy, type UserSpendingPolicy } from "./spending-policy.js";
import {
  DEFAULT_AGENT_V2_LIMITS,
  getApprovedServiceRegistry,
  isSafeRegisteredUrl,
  parseX402Requirements,
  selectCheapestEligibleService,
  summarizeTaskPlan,
  type AgentV2Limits,
} from "./agent-v2.js";

type JsonRecord = Record<string, unknown>;

export type AgentV2TaskInput = {
  goal: string;
  budgetTinybars?: number;
  maxPaidCalls?: number;
  allowedServiceIds?: string[];
  policy?: UserSpendingPolicy;
};

export type AgentV2TaskResult = {
  runId: string;
  status: "completed";
  plan: ReturnType<typeof summarizeTaskPlan>;
  discovery: { servicesChecked: number; httpCalls: number };
  selection: { serviceId: string; description: string; amountTinybars: string; amountHbar: string; network: string; asset: string };
  result: { resource: string; message: string; body: JsonRecord };
  expenditure: { reservedTinybars: string; reservedHbar: string; paidCalls: number; budgetTinybars: string; budgetHbar: string };
  receipts: Array<{ serviceId: string; transactionId: string; explorerUrl: string; amountTinybars: string; amountHbar: string; status: "settled" }>;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseChallenge(response: Response, body: unknown) {
  const encoded = response.headers.get("payment-required");
  if (encoded) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      if (isRecord(parsed)) return parsed;
    } catch {
      // Fall through to the protocol-compatible JSON body, then fail closed below.
    }
  }
  return isRecord(body) ? body : null;
}

function amountHbar(tinybars: number): string {
  return (tinybars / 100_000_000).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

export type AgentV2PreviewInput = { goal: string; policy?: UserSpendingPolicy; budgetTinybars?: number };

export async function previewAgentV2Plan(input: AgentV2PreviewInput) {
  const policy = input.policy ?? { ...DEFAULT_USER_SPENDING_POLICY, mode: "preview" as const, expiresAt: Date.now() + 120_000 };
  const policyErrors = validateUserSpendingPolicy(policy);
  if (policyErrors.length) throw new Error(policyErrors.join(" "));
  if (!input.goal.trim() || input.goal.length > 2_000) throw new Error("Goal is required and must be at most 2000 characters.");
  if (policy.expiresAt <= Date.now()) throw new Error("Policy expired; request a fresh wallet-signed policy.");
  const budget = Math.min(policy.taskBudgetTinybars, input.budgetTinybars ?? policy.taskBudgetTinybars);
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Preview budget must be a positive safe integer.");
  const registry = getApprovedServiceRegistry().filter(service => service.allowed && service.trust === "approved" && policy.allowedServiceIds.includes(service.id));
  const requirementsByService = new Map<string, ReturnType<typeof parseX402Requirements>>();
  const checks: Array<{ serviceId: string; status: "quoted" | "no-quote" | "rejected"; amountTinybars?: number; reason: string }> = [];
  let httpCalls = 0;
  for (const service of registry) {
    if (!isSafeRegisteredUrl(service.url)) {
      checks.push({ serviceId: service.id, status: "rejected", reason: "Registered URL failed the local endpoint safety check." });
      requirementsByService.set(service.id, []);
      continue;
    }
    try {
      const response = await fetch(service.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
      httpCalls += 1;
      if (response.status !== 402) {
        requirementsByService.set(service.id, []);
        checks.push({ serviceId: service.id, status: "no-quote", reason: `Service returned HTTP ${response.status}, not a payment quote.` });
        continue;
      }
      const body: unknown = await response.json().catch(() => null);
      const requirements = parseX402Requirements(parseChallenge(response, body));
      requirementsByService.set(service.id, requirements);
      const valid = requirements.filter(r => r.scheme === "exact" && r.network === policy.network && policy.allowedAssets.includes(r.asset) && r.asset === "0.0.0" && Number.isSafeInteger(Number(r.amount)) && Number(r.amount) > 0 && Number(r.amount) <= policy.maxPaymentTinybars && Number(r.amount) <= budget);
      const cheapest = valid.sort((a,b) => Number(a.amount)-Number(b.amount))[0];
      checks.push(cheapest
        ? { serviceId: service.id, status: "quoted", amountTinybars: Number(cheapest.amount), reason: "Quote fits the per-payment, asset, network, and budget limits; approval is still required before payment." }
        : { serviceId: service.id, status: "rejected", reason: "No quote fits the signed network, asset, per-payment cap, and task budget." });
    } catch (error) {
      requirementsByService.set(service.id, []);
      checks.push({ serviceId: service.id, status: "rejected", reason: error instanceof Error ? error.message : "Quote discovery failed." });
    }
  }
  const configReceiver = process.env.HEDERA_RECEIVER_ACCOUNT_ID;
  const decision = selectCheapestEligibleService({
    services: registry, requirementsByService, budgetTinybars: budget,
    allowedServiceIds: policy.allowedServiceIds,
    allowedReceiverIds: configReceiver ? [configReceiver] : [],
    network: policy.network,
  });
  return {
    mode: "preview" as const,
    paymentAttempted: false as const,
    goal: input.goal.trim(),
    network: policy.network,
    budgetTinybars: budget,
    discoveryHttpCalls: httpCalls,
    candidates: checks,
    selected: decision.selected ? {
      serviceId: decision.selected.service.id,
      description: decision.selected.service.description,
      amountTinybars: decision.selected.amountTinybars,
      amountHbar: amountHbar(decision.selected.amountTinybars),
      asset: decision.selected.requirement.asset,
      receiverAccountId: decision.selected.requirement.payTo,
    } : null,
    rejectionReasons: decision.rejected,
    note: "Preview performs only HTTP quote discovery. It never reserves funds, constructs a signer, or sends payment.",
  };
}

export function isAgentV2Enabled(): boolean {
  return process.env.HEDERA_AGENT_V2_ENABLED === "true" &&
    process.env.NODE_ENV !== "production" &&
    process.env.HEDERA_NETWORK === "testnet";
}

/**
 * Deterministic local testnet runner. It discovers only code-registered services,
 * inspects their real HTTP 402 requirements, reserves spend, and lets the x402
 * SDK construct the payment payload. No model or caller can supply a URL.
 */
export async function runAgentV2Task(
  input: AgentV2TaskInput,
  options: { signal: AbortSignal; runId?: string },
): Promise<AgentV2TaskResult> {
  if (!isAgentV2Enabled()) throw new Error("Agent v2 is disabled. Enable HEDERA_AGENT_V2_ENABLED=true for local Hedera Testnet development only.");
  if (process.env.HEDERA_AGENT_KILL_SWITCH === "true") throw new Error("Emergency kill switch is enabled; agent payments are stopped.");
  const policy = input.policy ?? { ...DEFAULT_USER_SPENDING_POLICY, expiresAt: Date.now() + 120_000 };
  if (policy.expiresAt <= Date.now()) throw new Error("Wallet authorization or user policy expired before task execution.");
  if (policy.mode !== "autonomous") throw new Error(policy.mode === "preview" ? "Preview mode never signs or sends payments." : "Approval-required mode needs an explicit approval flow; no payment was signed or sent.");
  const config = getX402Configuration();
  if (!config) throw new Error("Set HEDERA_CLIENT_ACCOUNT_ID and HEDERA_CLIENT_PRIVATE_KEY in services/api/.env.");

  const limits: AgentV2Limits = {
    ...DEFAULT_AGENT_V2_LIMITS,
    budgetTinybars: Math.min(policy.taskBudgetTinybars, typeof input.budgetTinybars === "number" ? input.budgetTinybars : policy.taskBudgetTinybars),
    maxPaidCalls: Math.min(policy.maxPaidCallsPerTask, typeof input.maxPaidCalls === "number" ? input.maxPaidCalls : policy.maxPaidCallsPerTask),
  };
  const plan = summarizeTaskPlan(input.goal, limits);
  if (!plan.accepted) throw new Error(plan.errors.join(" "));
  if (limits.maxPaidCalls < 1) throw new Error("At least one paid call must be permitted to complete a paid-resource task.");
  if (limits.maxRetries < 1 || limits.maxAttemptsPerService < 1) throw new Error("At least one x402 challenge/retry attempt per selected service is required.");

  const runId = options.runId ?? randomUUID();
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(limits.maxRuntimeMs)]);
  const requestedServices = input.allowedServiceIds ? input.allowedServiceIds.filter((id) => policy.allowedServiceIds.includes(id)) : policy.allowedServiceIds;
  const registry = getApprovedServiceRegistry().filter((service) => requestedServices.includes(service.id));
  if (!registry.length) throw new Error("No registered service is inside the user's service allowlist.");

  const requirementsByService = new Map<string, ReturnType<typeof parseX402Requirements>>();
  let httpCalls = 0;
  for (const service of registry) {
    if (signal.aborted) throw new Error("Agent v2 task was cancelled or exceeded its runtime limit.");
    if (httpCalls >= limits.maxSteps) throw new Error("Agent v2 reached its maximum total HTTP-call/step limit during discovery.");
    if (!isSafeRegisteredUrl(service.url)) throw new Error(`Registered service ${service.id} failed URL policy.`);
    const response = await fetch(service.url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      headers: { accept: "application/json" },
    });
    httpCalls += 1;
    if (response.status !== 402) {
      requirementsByService.set(service.id, []);
      continue;
    }
    const body: unknown = await response.json().catch(() => null);
    const challenge = parseChallenge(response, body);
    requirementsByService.set(service.id, parseX402Requirements(challenge));
  }

  const decision = selectCheapestEligibleService({
    services: registry,
    requirementsByService,
    budgetTinybars: limits.budgetTinybars,
    allowedServiceIds: input.allowedServiceIds,
    allowedReceiverIds: [config.receiverAccountId],
    network: "hedera:testnet",
  });
  if (!decision.selected) {
    throw new Error("No approved service advertises an x402 requirement that fits the user's budget and payment policy. No payment was attempted.");
  }
  if (limits.maxPaidCalls < 1) throw new Error("Paid-call limit reached before payment.");
  if (httpCalls + 2 > limits.maxSteps) throw new Error("Insufficient remaining steps for the x402 payment challenge/retry flow.");

  // The task budget is reserved logically for the whole run; the persistent
  // firewall reservation below is written before the signer is constructed.
  const selected = decision.selected;
  const simulation = simulateSpendingPolicy(policy, { serviceId: selected.service.id, network: selected.requirement.network, asset: selected.requirement.asset, amountTinybars: selected.amountTinybars, taskSpentTinybars: 0, paidCallsThisTask: 0 });
  if (!simulation.allowed) throw new Error(simulation.reason);
  if (process.env.HEDERA_AGENT_KILL_SWITCH === "true") throw new Error("Emergency kill switch is enabled; agent payments are stopped.");
  const reservation = await reserveAgentV2Spend({
    amountTinybars: String(selected.amountTinybars),
    receiverAccountId: selected.requirement.payTo,
    resourceUrl: selected.service.url,
  }, { maxPaymentTinybars: policy.maxPaymentTinybars, dailyBudgetTinybars: policy.dailyBudgetTinybars, maxAttemptsPerDay: policy.maxPaidCallsPerDay, taskId: runId, taskBudgetTinybars: limits.budgetTinybars, maxPaidCallsPerTask: limits.maxPaidCalls });
  if (!reservation.allowed) throw new Error(reservation.reason);
  if (signal.aborted) throw new Error("Agent v2 task was cancelled before payment execution.");

  if (signal.aborted || process.env.HEDERA_AGENT_KILL_SWITCH === "true" || policy.expiresAt <= Date.now()) throw new Error("Task cancelled, authorization expired, or emergency kill switch enabled before signing. Reservation is retained conservatively.");

  const signer = createClientHederaSigner(
    config.accountId,
    PrivateKey.fromStringECDSA(config.privateKey),
    { network: config.network },
  );
  const client = new x402Client()
    .register("hedera:*", new ExactHederaScheme(signer))
    .setSpendControls({ allowedAssets: true })
    .registerPolicy((_version, accepts) => accepts.filter((item) =>
      item.scheme === selected.requirement.scheme &&
      item.network === selected.requirement.network &&
      item.asset === selected.requirement.asset &&
      item.payTo === selected.requirement.payTo &&
      item.amount === selected.requirement.amount
    ));

  const paidFetch = wrapFetchWithPayment(fetch, client);
  let response: Response;
  try {
    if (signal.aborted || process.env.HEDERA_AGENT_KILL_SWITCH === "true" || policy.expiresAt <= Date.now()) throw new Error("Task cancelled, authorization expired, or emergency kill switch enabled before payment delivery. Reservation is retained conservatively.");
    response = await paidFetch(selected.service.url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    if (signal.aborted) {
      throw new Error("Agent v2 was cancelled or timed out during payment delivery. Settlement may already have occurred; inspect audit records and HashScan before retrying.");
    }
    throw error;
  }
  httpCalls += 2; // One challenge request and one payment-bearing retry.
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || !isRecord(body.payment)) {
    throw new Error(`Selected service did not return a successful response and settlement receipt (HTTP ${response.status}).`);
  }
  const payment = body.payment;
  if (body.resource !== selected.service.expectedResource ||
      payment.status !== "settled" ||
      typeof payment.transaction !== "string" || !payment.transaction.trim() ||
      body.amountTinybars !== selected.requirement.amount) {
    throw new Error("Selected service response failed resource, amount, or settlement-receipt validation.");
  }

  const transactionId = payment.transaction.trim();
  const actual = selected.amountTinybars;
  return {
    runId,
    status: "completed",
    plan,
    discovery: { servicesChecked: registry.length, httpCalls },
    selection: {
      serviceId: selected.service.id,
      description: selected.service.description,
      amountTinybars: String(actual),
      amountHbar: amountHbar(actual),
      network: selected.requirement.network,
      asset: "HBAR",
    },
    result: {
      resource: String(body.resource),
      message: typeof body.message === "string" ? body.message : "Service returned a valid paid resource.",
      body,
    },
    expenditure: {
      reservedTinybars: String(actual),
      reservedHbar: amountHbar(actual),
      paidCalls: 1,
      budgetTinybars: String(limits.budgetTinybars),
      budgetHbar: amountHbar(limits.budgetTinybars),
    },
    receipts: [{
      serviceId: selected.service.id,
      transactionId,
      explorerUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(transactionId)}`,
      amountTinybars: String(actual),
      amountHbar: amountHbar(actual),
      status: "settled",
    }],
  };
}
