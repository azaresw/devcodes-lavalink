import type { Track } from './types';

/**
 * Queue with history tracking, shuffle, positional insert/remove,
 * and a 50-item history ring buffer.
 */
export class LavalinkQueue {
  private _tracks: Track[] = [];

  /**
   * The 50 most recently finished tracks (newest first).
   * Useful for "previous track" features.
   */
  readonly history: Track[] = [];

  // ── Accessors ────────────────────────────────────────────────

  get size(): number { return this._tracks.length; }

  get isEmpty(): boolean { return this._tracks.length === 0; }

  /** Read-only view of the upcoming track list */
  get tracks(): ReadonlyArray<Track> { return this._tracks; }

  // ── Mutation ────────────────────────────────────────────────

  /**
   * Add one or more tracks to the queue.
   * @param tracks  Track or array of tracks to add.
   * @param position  0-based position to insert at. Omit to append.
   */
  add(tracks: Track | Track[], position?: number): void {
    const arr = Array.isArray(tracks) ? tracks : [tracks];
    if (position !== undefined && position >= 0 && position <= this._tracks.length) {
      this._tracks.splice(position, 0, ...arr);
    } else {
      this._tracks.push(...arr);
    }
  }

  /** Remove and return the first track in the queue */
  shift(): Track | undefined {
    return this._tracks.shift();
  }

  /**
   * Remove track(s) by position.
   * @param start  0-based start index.
   * @param end    0-based end index (exclusive). Omit to remove one track.
   * @returns Removed tracks.
   */
  remove(start: number, end?: number): Track[] {
    return this._tracks.splice(start, end !== undefined ? end - start : 1);
  }

  /** Fisher-Yates in-place shuffle */
  shuffle(): void {
    for (let i = this._tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this._tracks[i], this._tracks[j]] = [this._tracks[j]!, this._tracks[i]!];
    }
  }

  /** Remove all upcoming tracks (does not affect history) */
  clear(): void {
    this._tracks = [];
  }

  // ── History ──────────────────────────────────────────────────

  /** Called internally when a track finishes — pushes to history ring */
  addToHistory(track: Track): void {
    this.history.unshift(track);
    if (this.history.length > 50) this.history.pop();
  }

  // ── Iteration ────────────────────────────────────────────────

  [Symbol.iterator](): Iterator<Track> {
    return this._tracks[Symbol.iterator]();
  }
}
