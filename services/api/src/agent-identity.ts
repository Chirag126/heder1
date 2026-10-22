import { createHash } from "node:crypto";

export type AgentIdentityInput = {
  registry: string; name: string; version: string; protocol: string; nativeId: string;
  skills: number[]; uid?: string;
};

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Buffer): string {
  let value = BigInt("0x" + bytes.toString("hex"));
  let output = "";
  while (value > 0n) { const remainder = Number(value % 58n); output = ALPHABET[remainder] + output; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; output = "1" + output; }
  return output || "1";
}

export function createHcs14AgentId(input: AgentIdentityInput): string {
  const registry = input.registry.trim().toLowerCase();
  const protocol = input.protocol.trim().toLowerCase();
  const name = input.name.trim();
  const version = input.version.trim();
  const nativeId = input.nativeId.trim();
  if (!registry || !protocol || !name || !version || !nativeId) throw new Error("HCS-14 identity requires registry, name, version, protocol and nativeId.");
  if (!Array.isArray(input.skills) || input.skills.some((skill) => !Number.isSafeInteger(skill) || skill < 0 || (skill >= 40 && skill <= 99))) {
    throw new Error("HCS-14 skills must be integers in [0,39] or [100+].");
  }
  const skills = [...new Set(input.skills)].sort((a, b) => a - b);
  const canonical = JSON.stringify({ skills, name, nativeId, protocol, registry, version });
  const digest = createHash("sha384").update(canonical, "utf8").digest();
  const uid = (input.uid?.trim() || "0").replace(/[;=?#]/g, "");
  return `uaid:aid:${base58(digest)};uid=${uid};registry=${registry};proto=${protocol};nativeId=${nativeId}`;
}

export function getHcs14IdentityCards() {
  return [
    { agentId: "heder1:buyer", name: "Heder1 Buyer Agent", registry: "heder1", version: "1.0.0", protocol: "a2a", nativeId: "hedera:testnet:0.0.11044329", skills: [0, 17, 32, 33] },
    { agentId: "heder1:provider:full-report", name: "Research Provider Agent", registry: "heder1", version: "1.0.0", protocol: "rest", nativeId: "heder1-full-report", skills: [0, 17, 20] },
    { agentId: "heder1:provider:summary", name: "Summary Provider Agent", registry: "heder1", version: "1.0.0", protocol: "rest", nativeId: "heder1-short-summary", skills: [0, 17, 20] },
  ].map((agent) => ({ ...agent, uaid: createHcs14AgentId(agent) }));
}
