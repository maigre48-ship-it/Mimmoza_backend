export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function stableStringify(obj: any): string {
  // stringify déterministe (tri des clés) pour des cache keys stables
  const seen = new WeakSet();

  const sorter = (x: any): any => {
    if (x === null || typeof x !== "object") return x;
    if (seen.has(x)) return "[Circular]";
    seen.add(x);

    if (Array.isArray(x)) return x.map(sorter);

    return Object.keys(x).sort().reduce((acc: any, k: string) => {
      acc[k] = sorter(x[k]);
      return acc;
    }, {});
  };

  return JSON.stringify(sorter(obj));
}
