export type LabelInput = {
  id: number;
  title: string;
  /** Tabs not opened from a table (e.g. "New tab") are never disambiguated. */
  fromTable: boolean;
  conn: string;
  db: string;
  lastRunAt: number | null;
};

const UID_LEN = 8;
const pad = (n: number) => String(n).padStart(2, "0");

function stamp(ms: number | null): string {
  if (ms === null) return "--/--/--:--:--";
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Index of the first character where the strings don't all agree (the shortest length if one is a prefix). */
function firstDiff(strs: string[]): number {
  const min = Math.min(...strs.map((s) => s.length));
  for (let i = 0; i < min; i++) {
    const c = strs[0][i];
    if (strs.some((s) => s[i] !== c)) return i;
  }
  return min;
}

/**
 * Tab labels. Tabs sharing a table title get a uid: from each tab's
 * `{conn}:{db}:{mm/dd/hh:mm:ss of last query}`, the 8 characters starting at the
 * first position where the group's strings differ, or the last 8 characters if
 * that's too close to the end (or the strings are identical).
 */
export function tabLabels(tabs: LabelInput[]): Map<number, string> {
  const labels = new Map<number, string>();
  const groups = new Map<string, LabelInput[]>();
  for (const t of tabs) {
    labels.set(t.id, t.title);
    if (!t.fromTable) continue;
    const g = groups.get(t.title);
    if (g) g.push(t);
    else groups.set(t.title, [t]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const full = group.map((t) => `${t.conn}:${t.db}:${stamp(t.lastRunAt)}`);
    const i = firstDiff(full);
    group.forEach((t, k) => {
      const s = full[k];
      const uid = i + UID_LEN <= s.length ? s.slice(i, i + UID_LEN) : s.slice(-UID_LEN);
      labels.set(t.id, `${t.title} (${uid})`);
    });
  }
  return labels;
}
