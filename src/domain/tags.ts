const TAG = /#([\p{L}\p{N}_-]+)/gu;

/** `#words` in a text, lowercased and unique, in order of appearance. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(TAG)) {
    const tag = match[1]!.toLowerCase();
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

export function mergeTags(...lists: readonly string[][]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const tag = raw.trim().toLowerCase().replace(/^#/, "");
      if (tag && !out.includes(tag)) out.push(tag);
    }
  }
  return out;
}

/** Lowercase, no diacritics, no emoji or punctuation: "🔥 TO-DO" -> "todo". */
export function slug(text: string): string {
  return fold(text).replace(/[^a-z0-9]/g, "");
}

/** Lowercase without diacritics: "Compañía" -> "compania". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
