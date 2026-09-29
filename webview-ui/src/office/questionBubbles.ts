/**
 * Open questions per CHARACTER (spec §3 "Personaje"): which AskUserQuestion
 * tools keep a character's "?" bubble up. Keyed by the character that asks —
 * a root or derived agent by its own id, a legacy Subtask by its sub-character
 * id — unlike the "Te esperan" tracker, which keys a sub-agent's question by
 * the root that answers it. DOM-free.
 */
export class QuestionBubbles {
  private readonly open = new Map<number, Set<string>>();

  /** A question started on `charId`. True when it is new (show the bubble and
   *  chime); false for a replay of a question already open. */
  start(charId: number, toolId: string): boolean {
    let tools = this.open.get(charId);
    if (!tools) this.open.set(charId, (tools = new Set()));
    if (tools.has(toolId)) return false;
    tools.add(toolId);
    return true;
  }

  /** A tool of `charId` finished. True when it closed that character's last
   *  open question (hide the bubble). */
  done(charId: number, toolId: string): boolean {
    const tools = this.open.get(charId);
    if (!tools || !tools.delete(toolId)) return false;
    if (tools.size > 0) return false;
    this.open.delete(charId);
    return true;
  }

  /** Forget every open question of `charId` (tools cleared, sub-agent gone).
   *  True when it had any. */
  clear(charId: number): boolean {
    return this.open.delete(charId);
  }

  /** Forget everything (a reconnect snapshot: the server replays the open
   *  questions). Returns the characters that had any. */
  reset(): number[] {
    const ids = [...this.open.keys()];
    this.open.clear();
    return ids;
  }

  has(charId: number): boolean {
    return this.open.has(charId);
  }
}
