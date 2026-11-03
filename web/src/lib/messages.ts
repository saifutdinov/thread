// Server versions must only move forwards, even when decryption or a history
// request finishes after a newer socket event. Local sends have seq zero.
interface Versioned {
  id: number;
  cid: string;
  seq: number;
  local?: string;
}

export function latestMessage<T extends Versioned & { deleted?: boolean }>(candidates: T[], cleared = 0): T | undefined {
  return mergeMessages([], candidates)
    .filter((m) => !m.local && !m.deleted && m.id > cleared)
    .at(-1);
}

export function mergeMessages<T extends Versioned>(list: T[], incoming: T[]): T[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) {
    if (m.local && [...byId.values()].some((x) => !x.local && x.cid === m.cid)) continue;
    for (const [id, x] of byId) if (x.local && x.cid === m.cid) byId.delete(id);
    const previous = byId.get(m.id);
    if (!previous || previous.seq <= m.seq) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
