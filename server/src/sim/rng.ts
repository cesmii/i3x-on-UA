/** Seeded PRNG (mulberry32) so simulation runs are reproducible. */
export class Rng {
  private s: number;
  constructor(seed = 42) { this.s = seed >>> 0; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Approximately normal noise with standard deviation sd. */
  noise(sd: number): number { return (this.next() + this.next() + this.next() - 1.5) * 2 * sd; }
}
