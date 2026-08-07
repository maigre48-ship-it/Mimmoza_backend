// supabase/functions/_shared/providers/hash.ts
// Minimal hash helper for edge functions (Deno compatible)

// --------------------------------------------------
// SHA-256 helper
// --------------------------------------------------
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input ?? "");
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --------------------------------------------------
// Stable stringify helper (deterministic JSON)
// --------------------------------------------------
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: any): any {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeysDeep(value[k]);
    }
    return out;
  }

  return value;
}
