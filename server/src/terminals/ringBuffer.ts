/**
 * Bounded text buffer of a console's output, for re-attaching. Past the cap it
 * drops the oldest text and restarts at a line boundary: a snapshot that began
 * mid-line could begin mid escape sequence and garble the terminal.
 */
export class RingBuffer {
  private text = '';

  constructor(private readonly maxChars: number) {}

  append(s: string): void {
    this.text += s;
    if (this.text.length <= this.maxChars) return;
    const tail = this.text.slice(this.text.length - this.maxChars);
    const nl = tail.indexOf('\n');
    // No newline in the kept window: one huge line, keep its tail as is.
    this.text = nl === -1 ? tail : tail.slice(nl + 1);
  }

  read(): string {
    return this.text;
  }
}
