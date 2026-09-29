import type { MachineProject } from '../../../core/src/messages.js';

/** Case- and accent-insensitive folding for the launch dialog's search box. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Machine projects whose `name` or `cwd` contains `query`, case- and
 *  accent-insensitively. An empty (or whitespace-only) query returns every
 *  project unchanged — including their order (most recently used first, as
 *  the server sends them). */
export function filterProjects(projects: MachineProject[], query: string): MachineProject[] {
  const q = fold(query.trim());
  if (!q) return projects;
  return projects.filter((p) => fold(p.name).includes(q) || fold(p.cwd).includes(q));
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long ago `lastUsed` was, in Spanish, for the "Sesiones recientes" tab.
 *  `lastUsed === 0` means unknown (never resolved) and renders as "". */
export function timeAgo(lastUsed: number, now: number): string {
  if (!lastUsed) return '';
  const diffMs = Math.max(0, now - lastUsed);
  if (diffMs < HOUR_MS) return `hace ${Math.max(1, Math.round(diffMs / MINUTE_MS))} min`;
  if (diffMs < DAY_MS) return `hace ${Math.round(diffMs / HOUR_MS)} h`;
  return `hace ${Math.round(diffMs / DAY_MS)} d`;
}
