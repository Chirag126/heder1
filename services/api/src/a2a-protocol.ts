export function parseA2aMessageRequest(body: unknown): { id: string | number; text: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A2A request must be a JSON object.");
  const request = body as Record<string, unknown>;
  if (request.jsonrpc !== "2.0" || (typeof request.id !== "string" && typeof request.id !== "number") || request.method !== "message/send") throw new Error("Expected A2A JSON-RPC 2.0 method message/send with an id.");
  const params = request.params as Record<string, unknown> | undefined;
  const message = params?.message as Record<string, unknown> | undefined;
  const parts = message?.parts;
  if (message?.role !== "user" || !Array.isArray(parts) || parts.length < 1 || parts.length > 10) throw new Error("A2A message must have role=user and 1-10 text parts.");
  const text = parts.map((part) => {
    if (!part || typeof part !== "object" || (part as Record<string, unknown>).kind !== "text" || typeof (part as Record<string, unknown>).text !== "string") throw new Error("Only text parts are supported by this bounded A2A adapter.");
    return ((part as Record<string, string>).text).trim();
  }).join("\n").trim();
  if (!text || text.length > 2000) throw new Error("A2A message text must be 1-2000 characters.");
  return { id: request.id, text };
}
export function createA2aMessageResponse(id: string | number, content: unknown) {
  return { jsonrpc: "2.0", id, result: { message: { messageId: crypto.randomUUID(), role: "agent", parts: [{ kind: "text", text: JSON.stringify(content) }] } } };
}
export function createA2aError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
