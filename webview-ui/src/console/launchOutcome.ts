/** A `launchResult` message, tagged with a monotonic sequence number so a
 *  launch dialog can tell "this is MY attempt's answer" apart from a stale
 *  result belonging to an attempt it never made — a launch cancelled mid-way,
 *  or one sent by a dialog that has since been closed and reopened. The wire
 *  protocol carries no per-request id, so `seq` (bumped once per received
 *  `launchResult`, never reused) is the only identity available. */
export interface LaunchOutcome {
  seq: number;
  ok: boolean;
  error?: string;
}

/** What a launch dialog should render, given the `seq` it captured when IT
 *  sent its own `launchAgent` (`attemptMarker`, or `null` if it hasn't sent
 *  one yet this open) and the latest known `LaunchOutcome`.
 *
 *  - No attempt sent yet (`attemptMarker === null`) → never busy, never shows
 *    an error: a stale outcome — from before this dialog opened, or from an
 *    earlier attempt this same dialog cancelled by never re-launching — is
 *    ignored outright.
 *  - An attempt sent, but no outcome newer than the marker → still busy.
 *  - An outcome newer than the marker → not busy; its error, if any.
 *
 *  Resetting busy is driven entirely by `seq`, never by comparing message
 *  text: two consecutive failures with the identical error string must both
 *  resolve busy, not leave the dialog stuck on the first one. */
export function launchDialogView(
  attemptMarker: number | null,
  outcome: LaunchOutcome | null,
): { busy: boolean; error: string | null } {
  if (attemptMarker === null) return { busy: false, error: null };
  if (!outcome || outcome.seq <= attemptMarker) return { busy: true, error: null };
  if (outcome.ok) return { busy: false, error: null };
  return { busy: false, error: outcome.error ?? 'No se pudo lanzar' };
}
