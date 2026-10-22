export type SafeAgentTool = {
  name: string; description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  access: "read-only";
};
export const HEDERA_READONLY_TOOLS: readonly SafeAgentTool[] = Object.freeze([{
  name: "hedera_testnet_account_context",
  description: "Read public Hedera Testnet account context. Never signs, submits, or transfers.",
  inputSchema: { type: "object", properties: { accountId: { type: "string", pattern: "^0\\.0\\.[0-9]+$" } }, required: ["accountId"], additionalProperties: false },
  access: "read-only",
}]);
export function validateReadonlyToolCall(name: unknown, args: unknown): { accountId: string } {
  if (name !== "hedera_testnet_account_context") throw new Error("Tool is not on the read-only allowlist.");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object.");
  const input = args as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "accountId")) throw new Error("Unexpected tool argument.");
  if (typeof input.accountId !== "string" || !/^0\\.0\\.[0-9]+$/.test(input.accountId)) throw new Error("accountId must be a Hedera account ID such as 0.0.123.");
  return { accountId: input.accountId };
}
