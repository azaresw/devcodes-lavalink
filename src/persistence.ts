import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { PersistedPlayerState } from './types';

/**
 * Disk-based player state persistence.
 *
 * Writes a JSON file every time state changes and reads it back on startup.
 * This means player queues, volume, loop mode, filters, and approximate
 * playback position are recovered even after a full system reboot.
 *
 * `LavalinkManager` uses one `PlayerPersistence` instance internally;
 * you normally never need to touch this class directly.
 */
export class PlayerPersistence {
  private readonly _path: string;
  private _data: Record<string, PersistedPlayerState> = {};

  constructor(filePath: string) {
    this._path = filePath;
    this._read();
  }

  /** Save or overwrite the state for a single guild */
  save(guildId: string, state: PersistedPlayerState): void {
    this._data[guildId] = state;
    this._write();
  }

  /** Get all saved states */
  getAll(): Record<string, PersistedPlayerState> {
    return { ...this._data };
  }

  /** Get the saved state for a single guild */
  get(guildId: string): PersistedPlayerState | undefined {
    return this._data[guildId];
  }

  /** Remove the state for a guild (called when a player is destroyed) */
  delete(guildId: string): void {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this._data[guildId];
    this._write();
  }

  /** Wipe all saved states */
  clear(): void {
    this._data = {};
    this._write();
  }

  // ── internal ────────────────────────────────────────────────

  private _write(): void {
    try {
      const dir = dirname(this._path);
      if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
      writeFileSync(this._path, JSON.stringify(this._data, null, 2), 'utf8');
    } catch {
      // Non-fatal — if the disk write fails, state just won't persist this tick
    }
  }

  private _read(): void {
    try {
      if (existsSync(this._path)) {
        const raw = readFileSync(this._path, 'utf8');
        this._data = JSON.parse(raw) as Record<string, PersistedPlayerState>;
      }
    } catch {
      this._data = {};
    }
  }
}
