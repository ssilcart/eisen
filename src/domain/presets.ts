// S20: quadrant presets. Only the labels (and their emoji) change between
// presets, never the stored flags. Each emoji is a single code point with
// default emoji presentation (no VS16), so it is 2 columns wide everywhere.
import type { Bucket, Quadrant } from "./task.ts";

export type PresetId = "classic" | "priority" | "focus";

export interface Preset {
  id: PresetId;
  /** Shown in the settings screen. */
  name: string;
  labels: Record<Quadrant, string>;
}

export const INBOX_LABEL = "📥 Inbox";

export const PRESETS: readonly Preset[] = [
  {
    id: "classic",
    name: "Classic",
    labels: { 1: "✅ Do", 2: "📅 Schedule", 3: "🤝 Delegate", 4: "🧹 Delete" },
  },
  {
    id: "priority",
    name: "Priority",
    labels: {
      1: "🔴 Urgent & Important",
      2: "🟠 Not Urgent & Important",
      3: "🔵 Urgent & Unimportant",
      4: "🟢 Not Urgent & Unimportant",
    },
  },
  {
    id: "focus",
    name: "Focus",
    labels: { 1: "🔥 Urgent", 2: "⭐ Important", 3: "⚡ Needs attention", 4: "🧊 Someday" },
  },
];

export const PRESET_IDS: readonly PresetId[] = PRESETS.map((p) => p.id);

export const DEFAULT_PRESET: PresetId = "classic";

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

export function getPreset(id: PresetId): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
}

/** `✅ Do` for Q1 in `classic`; `📥 Inbox` in every preset. */
export function labelFor(preset: PresetId, bucket: Bucket): string {
  return bucket === "inbox" ? INBOX_LABEL : getPreset(preset).labels[bucket];
}

/**
 * `Q1 · ✅ Do`, or `📥 Inbox`: used by `eisen ls` and `eisen export`. The
 * importer reads only the `Q{n}` prefix, so any preset's export imports into
 * any other.
 */
export function headingFor(preset: PresetId, bucket: Bucket): string {
  return bucket === "inbox" ? INBOX_LABEL : `Q${bucket} · ${labelFor(preset, bucket)}`;
}
