import type { LavalinkManager } from './manager';
import type { LavalinkNode }    from './node';
import type {
  PlayerOptions,
  Track,
  Filters,
  LoopMode,
  TrackEndReason,
  PersistedPlayerState,
  VoiceServerPayload,
  VoiceStatePayload,
  SponsorBlockCategory,
} from './types';
import { LavalinkQueue } from './queue';
import { FilterPresets } from './filters';

/** Real-time state updated from Lavalink `playerUpdate` ops */
export interface PlayerState {
  position:  number;
  ping:      number;
  connected: boolean;
  time:      number;
}

/**
 * Controls audio playback for a single Discord guild.
 *
 * Create via `manager.create()` — do not construct directly.
 *
 * Key features:
 * - Chainable async API (`await player.play(track).then(p => p.setVolume(80))`)
 * - Built-in loop modes: none / track / queue
 * - Auto-advance on track end, error, and stuck
 * - 50-track history ring in `player.queue.history`
 * - Filter presets: `bassBoost`, `nightcore`, `vaporwave`, `eightD`, `karaoke`, …
 * - State auto-saved to disk after every meaningful change
 */
export class LavalinkPlayer {
  readonly manager: LavalinkManager;
  readonly guildId: string;

  /** The Lavalink node this player is attached to */
  node: LavalinkNode;

  readonly queue: LavalinkQueue;

  voiceChannelId: string;
  textChannelId:  string | undefined;
  selfDeaf:       boolean;
  selfMute:       boolean;

  /** Current volume 0–1000 */
  volume:  number;
  paused:  boolean;
  playing: boolean;
  loop:    LoopMode;
  /** Automatically queue a related track when the queue runs out (default: false) */
  autoplay: boolean;
  filters: Filters;

  /** Currently playing track, or null if idle */
  current: Track | null = null;

  /** @internal — updated by LavalinkNode on `playerUpdate` */
  _state: PlayerState = { position: 0, ping: 0, connected: false, time: 0 };

  /** @internal — collected from Discord VOICE_STATE_UPDATE */
  _voiceSessionId: string | null = null;

  /** @internal — collected from Discord VOICE_SERVER_UPDATE */
  _voiceServer: VoiceServerPayload | null = null;

  /** @internal — track to replay after voice WS reconnect (set when cleanup fires) */
  _reconnectTrack: Track | null = null;

  /** @internal — interval handle for periodic position saves */
  private _positionInterval: ReturnType<typeof setInterval> | null = null;

  constructor(manager: LavalinkManager, node: LavalinkNode, options: PlayerOptions) {
    this.manager        = manager;
    this.node           = node;
    this.guildId        = options.guildId;
    this.voiceChannelId = options.voiceChannelId;
    this.textChannelId  = options.textChannelId;
    this.selfDeaf       = options.selfDeaf ?? true;
    this.selfMute       = options.selfMute ?? false;
    this.volume         = options.volume   ?? 100;
    this.paused         = false;
    this.playing        = false;
    this.loop           = 'none';
    this.autoplay       = false;
    this.filters        = {};
    this.queue          = new LavalinkQueue();
  }

  // ── Computed ─────────────────────────────────────────────────

  /**
   * Interpolated playback position in milliseconds.
   * More accurate than `_state.position` because it accounts for
   * elapsed time since the last Lavalink `playerUpdate` op.
   */
  get position(): number {
    if (!this.playing || this.paused || !this._state.time) return this._state.position;
    return Math.min(
      this._state.position + (Date.now() - this._state.time),
      this.current?.info.length ?? this._state.position,
    );
  }

  // ── Voice ────────────────────────────────────────────────────

  /** Send a voice-state payload to Discord to join the configured voice channel */
  async connect(): Promise<this> {
    const payload: VoiceStatePayload = {
      op: 4,
      d: {
        guild_id:   this.guildId,
        channel_id: this.voiceChannelId,
        self_deaf:  this.selfDeaf,
        self_mute:  this.selfMute,
      },
    };
    this.manager.options.send!(this.guildId, payload);
    return this;
  }

  /** Leave the voice channel (does not destroy the player) */
  async disconnect(): Promise<this> {
    this.voiceChannelId = '';
    this.playing = false;
    this.paused  = false;

    // Pause Lavalink — non-fatal if the player isn't initialised yet
    await this.node.updatePlayer(this.guildId, { paused: true }).catch(() => { /* ok */ });

    this.manager.options.send!(this.guildId, {
      op: 4,
      d: { guild_id: this.guildId, channel_id: null, self_deaf: false, self_mute: false },
    });
    return this;
  }

  /**
   * Destroy the player — disconnects, removes from manager, and clears persistence.
   * @param disconnect  Also leave the voice channel (default: true).
   */
  async destroy(disconnect = true): Promise<void> {
    if (disconnect) await this.disconnect().catch(() => { /* ok */ });
    this._clearPositionInterval();
    await this.node.destroyPlayer(this.guildId).catch(() => { /* ok */ });
    this.manager._removePlayer(this);
  }

  // ── Playback ─────────────────────────────────────────────────

  /**
   * Play a track.
   * If no track is supplied, shifts the first track from the queue.
   * Throws if there's nothing to play.
   */
  async play(track?: Track): Promise<this> {
    const toPlay = track ?? this.queue.shift();
    if (!toPlay) throw new Error('[Player] Nothing to play — add tracks to the queue first');

    this.current = toPlay;
    this.playing = true;
    this.paused  = false;

    await this.node.updatePlayer(this.guildId, {
      track:  { encoded: toPlay.encoded },
      volume: this.volume,
      paused: false,
    });

    this._save();
    return this;
  }

  /**
   * Skip the current track.
   * Lavalink will send a `TrackEndEvent` with reason `'replaced'`,
   * and the next track in the queue will start automatically.
   */
  async skip(): Promise<this> {
    await this.node.updatePlayer(this.guildId, { track: { encoded: null } });
    return this;
  }

  /** Stop playback and clear the current track */
  async stop(): Promise<this> {
    this.playing = false;
    this.paused  = false;
    this.current = null;
    this._clearPositionInterval();
    await this.node.updatePlayer(this.guildId, { track: { encoded: null } });
    this._save();
    return this;
  }

  /**
   * Pause or un-pause playback.
   * Calling with no argument pauses; pass `false` to resume.
   */
  async pause(state = true): Promise<this> {
    if (this.paused === state) return this;
    this.paused = state;
    await this.node.updatePlayer(this.guildId, { paused: state });
    this._save();
    return this;
  }

  /** Resume playback (alias for `pause(false)`) */
  async resume(): Promise<this> {
    return this.pause(false);
  }

  /**
   * Seek to an absolute position in milliseconds.
   * Throws if the current track isn't seekable.
   */
  async seek(position: number): Promise<this> {
    if (!this.current?.info.isSeekable) {
      throw new Error('[Player] Current track is not seekable');
    }
    await this.node.updatePlayer(this.guildId, { position });
    return this;
  }

  /**
   * Set the player volume (0–1000).
   * 100 is 100 %, 200 is 200 %, etc.
   */
  async setVolume(volume: number): Promise<this> {
    if (volume < 0 || volume > 1_000) throw new RangeError('[Player] Volume must be 0–1000');
    this.volume = volume;
    await this.node.updatePlayer(this.guildId, { volume });
    this._save();
    return this;
  }

  // ── Queue / Loop ─────────────────────────────────────────────

  /**
   * Set the loop mode: `'none'` | `'track'` | `'queue'`
   * - `'track'`  — repeat the current track indefinitely
   * - `'queue'`  — repeat the whole queue indefinitely
   */
  setLoop(mode: LoopMode): this {
    this.loop = mode;
    this._save();
    return this;
  }

  // ── Filters ───────────────────────────────────────────────────

  /** Apply a partial filter object (merges with current filters) */
  async setFilters(filters: Partial<Filters>): Promise<this> {
    this.filters = { ...this.filters, ...filters };
    await this.node.updatePlayer(this.guildId, { filters: this.filters });
    this._save();
    return this;
  }

  /** Reset all active filters */
  async clearFilters(): Promise<this> {
    this.filters = {};
    await this.node.updatePlayer(this.guildId, { filters: FilterPresets.clear() });
    this._save();
    return this;
  }

  // ── Filter presets ────────────────────────────────────────────

  async bassBoost(level: 'low' | 'medium' | 'high' | 'extreme' = 'medium'): Promise<this> {
    return this.setFilters(FilterPresets.bassBoost(level));
  }

  async nightcore(enabled = true): Promise<this> {
    return enabled ? this.setFilters(FilterPresets.nightcore()) : this.clearFilters();
  }

  async vaporwave(enabled = true): Promise<this> {
    return enabled ? this.setFilters(FilterPresets.vaporwave()) : this.clearFilters();
  }

  async eightD(enabled = true): Promise<this> {
    return enabled ? this.setFilters(FilterPresets.eightD()) : this.clearFilters();
  }

  async karaoke(enabled = true): Promise<this> {
    return enabled ? this.setFilters(FilterPresets.karaoke()) : this.clearFilters();
  }

  async softFilter(enabled = true): Promise<this> {
    return enabled ? this.setFilters(FilterPresets.soft()) : this.clearFilters();
  }

  async trebleBass(enabled = true): Promise<this> {
    return enabled ? this.setFilters(FilterPresets.trebleBass()) : this.clearFilters();
  }

  async tremolo(enabled = true): Promise<this> {
    return enabled ? this.setFilters(FilterPresets.tremolo()) : this.clearFilters();
  }

  async vibrato(enabled = true): Promise<this> {
    return enabled ? this.setFilters(FilterPresets.vibrato()) : this.clearFilters();
  }

  // ── Internal event handlers (called by LavalinkNode) ─────────

  /** @internal */
  _handleTrackStart(track: Track): void {
    this.current = track;
    this.playing = true;
    this.paused  = false;
    this._startPositionInterval();
    this.manager.emit('trackStart', this, track);
    this._save();
  }

  /** @internal */
  _handleTrackEnd(track: Track, reason: TrackEndReason): void {
    this._clearPositionInterval();

    // Push finished track to history
    if (this.current) this.queue.addToHistory(this.current);
    this.current = null;

    this.manager.emit('trackEnd', this, track, reason);

    // Don't auto-advance if the track was explicitly stopped or replaced  
    if (reason === 'replaced' || reason === 'stopped') {
      this._save();
      return;
    }

    // Voice WS closed mid-play — preserve the track so voice reconnect can replay it
    if (reason === 'cleanup') {
      this._reconnectTrack = track;
      this.playing = false;
      this._clearPositionInterval();
      this._save();
      return;
    }

    // Loop: track
    if (this.loop === 'track') {
      this.play(track).catch(() => { /* swallow */ });
      return;
    }

    // Loop: queue — re-add track to end before advancing
    if (this.loop === 'queue') {
      this.queue.add(track);
    }

    // Advance queue
    if (this.queue.isEmpty) {
      if (this.autoplay) {
        // Keep playing=true while we search so the player stays "active"
        this._triggerAutoplay(track).catch(() => {
          this.playing = false;
          this.manager.emit('queueEnd', this);
        });
      } else {
        this.playing = false;
        this.manager.emit('queueEnd', this);
      }
      this._save();
      return;
    }

    this.play().catch(() => { /* swallow */ });
  }

  /** @internal */
  _handleTrackException(track: Track, exception: unknown): void {
    this.manager.emit('trackError', this, track, exception);
    this._clearPositionInterval();

    // Auto-advance — skip broken track
    if (!this.queue.isEmpty) {
      this.play().catch(() => { /* swallow */ });
    } else {
      this.playing = false;
      this._save();
    }
  }

  /** @internal */
  _handleTrackStuck(track: Track, thresholdMs: number): void {
    this.manager.emit('trackStuck', this, track, thresholdMs);
    this._clearPositionInterval();

    if (!this.queue.isEmpty) {
      this.play().catch(() => { /* swallow */ });
    } else {
      this.playing = false;
      this._save();
    }
  }

  // ── Persistence helpers ───────────────────────────────────────

  /** @internal — trigger a persistence write */
  _save(): void {
    this.manager._savePlayer(this);
  }

  /** Serialize the player's full state for disk persistence */
  toJSON(): PersistedPlayerState {
    return {
      guildId:        this.guildId,
      nodeIdentifier: this.node.identifier,
      voiceChannelId: this.voiceChannelId,
      textChannelId:  this.textChannelId,
      volume:         this.volume,
      loop:           this.loop,
      paused:         this.paused,
      filters:        this.filters,
      currentTrack:   this.current,
      savedPosition:  this.position,
      queue:          [...this.queue.tracks],
      timestamp:      Date.now(),
    };
  }

  // ── Private ───────────────────────────────────────────────────

  private _startPositionInterval(): void {
    this._clearPositionInterval();
    // Save position every 5 s while actively playing so seek-on-restore is close
    this._positionInterval = setInterval(() => {
      if (this.playing && !this.paused) {
        this.manager.emit('positionUpdate', this, this._state.position);
        this._save();
      }
    }, 5_000);
  }

  private _clearPositionInterval(): void {
    if (this._positionInterval) {
      clearInterval(this._positionInterval);
      this._positionInterval = null;
    }
  }

  // ── SponsorBlock ─────────────────────────────────────────────

  /**
   * Enable SponsorBlock segment skipping for this player.
   * Requires the SponsorBlock Lavalink plugin to be installed on the server.
   *
   * @param categories - Segment categories to skip (e.g. `['sponsor', 'selfpromo']`)
   */
  async setSponsorBlock(categories: SponsorBlockCategory[]): Promise<this> {
    await this.node.setSponsorBlock(this.guildId, categories);
    return this;
  }

  /**
   * Disable all SponsorBlock segment skipping for this player.
   */
  async clearSponsorBlock(): Promise<this> {
    await this.node.clearSponsorBlock(this.guildId);
    return this;
  }

  // ── Autoplay ─────────────────────────────────────────────────

  /**
   * @internal — called when `autoplay` is true and the queue runs out.
   * Searches for a related track using the seed track's title + author.
   */
  private async _triggerAutoplay(seedTrack: Track): Promise<void> {
    // Use a clean author-based query — the full video title has noise like
    // '(Official Video)', 'ft. X', that makes searches return nothing.
    const cleanTitle = seedTrack.info.title
      .replace(/\(.*?\)/g, '')          // remove (Official Video) etc.
      .replace(/\[.*?\]/g, '')          // remove [Lyrics] etc.
      .replace(/\bfeat?\.?\b.*/i, '')   // remove "ft. Artist" tails
      .trim();
    const author = seedTrack.info.author.replace(/\s*-\s*Topic$/, ''); // strip YouTube "-  Topic" suffix
    const query  = `${author} ${cleanTitle} mix`;

    const result = await this.manager.search(query).catch(() => null);
    const tracks = result?.tracks ?? [];

    // Prefer any track that isn't identical to the seed; fall back to [0]
    const next = tracks.find(t => t.encoded !== seedTrack.encoded) ?? tracks[0] ?? null;

    if (!next) {
      this.manager.emit('autoplayFail', this, query);
      this.playing = false;
      this.manager.emit('queueEnd', this);
      return;
    }
    this.queue.add(next);
    await this.play();
  }
}
