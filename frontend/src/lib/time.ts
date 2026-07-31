/** A player clock: m:ss, or h:mm:ss once there's an hour to show. */
export function formatTime(s: number): string {
  const t = Math.max(0, Math.floor(s))
  const mm = Math.floor(t / 60) % 60
  const ss = t % 60
  const hh = Math.floor(t / 3600)
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`
}
