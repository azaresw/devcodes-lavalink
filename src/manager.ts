import { EventEmitter } from 'events';
import { LavalinkNode }       from './node';
import { LavalinkPlayer }     from './player';
import { PlayerPersistence }  from './persistence';
import type {
  ManagerOptions,
  ManagerEventMap,
  NodeOptions,
  PlayerOptions,
  SearchResult,
  VoiceStateData,
  VoiceServerUpdateData,
  PersistedPlayerState,
} from './types';

/**
 * Central manager for the devcodes-lavalink client.
 *
 * Responsibilities:
 * - Owns all nodes and players
 * - Routes Discord voice-state / voice-server-update packets
 * - Coordinates player persistence save + restore
 * - Load-balances new players across nodes by penalty score
 *
 * @example
 * ```ts
 * const manager = new LavalinkManager({
 *   nodes: [{ host: 'localhost', port: 2333, password: 'youshallnotpass' }],
 *   send: (guildId, payload) => {
 *     client.guilds.cache.get(guildId)?.shard.send(payload);
 *   },
 * });
 *
 * client.once('ready', () => manager.init(client.user!.id));
 *
 * // Forward raw gateway packets so the manager can handle voice
 * client.on('raw', (packet) => manager.handleRawPacket(packet));
 * ```
 */
export class LavalinkManager extends EventEmitter {
  readonly nodes:   Map<string, LavalinkNode>   = new Map();
  readonly players: Map<string, LavalinkPlayer> = new Map();
  readonly options: ManagerOptions;

  /** The bot's Discord user ID — set via `init()` or `ManagerOptions.clientId` */
  clientId:   string;
  /** Name reported to Lavalink in the WebSocket handshake */
  clientName: string;

  private readonly _persistence:    PlayerPersistence | null;
  private readonly _voiceStates:    Map<string, VoiceStateData>        = new Map();
  private readonly _voiceServers:   Map<string, VoiceServerUpdateData> = new Map();
  private readonly _pendingRestores: Map<string, PersistedPlayerState> = new Map();

  constructor(options: ManagerOptions) {
    super();

    if (typeof options.send !== 'function') {
      throw new TypeError('[LavalinkManager] `options.send` must be a function');
    }
    if (!options.nodes?.length) {
      throw new TypeError('[LavalinkManager] At least one node must be provided');
    }

    this.options    = options;
    this.clientId   = options.clientId  ?? '';
    this.clientName = options.clientName ?? 'devcodes-lavalink/1.0.0';

    // Register nodes
    for (const nodeOpts of options.nodes) this.addNode(nodeOpts);

    // Persistence
    const pPath = options.persistencePath ?? './devcodes-lavalink.json';
    this._persistence = pPath !== false ? new PlayerPersistence(pPath as string) : null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Connect all nodes.  Call this once the Discord client is ready.
   * @param clientId  The bot's Discord user ID (overrides `options.clientId`).
   */
  init(clientId: string): this {
    this.clientId = clientId;
    for (const node of this.nodes.values()) node.connect();

    // Save all player states on graceful shutdown
    process.once('SIGINT',  () => { this._onShutdown(); process.exit(0); });
    process.once('SIGTERM', () => { this._onShutdown(); process.exit(0); });
    process.once('exit',    () => this._onShutdown());

    return this;
  }

  // ── Node management ───────────────────────────────────────────

  /** Add (and optionally connect) a new node at runtime */
  addNode(options: NodeOptions): LavalinkNode {
    const node = new LavalinkNode(this, options);
    this.nodes.set(node.identifier, node);
    return node;
  }

  /** Disconnect and remove a node */
  removeNode(identifier: string): void {
    const node = this.nodes.get(identifier);
    if (!node) return;
    node.destroy();
    this.nodes.delete(identifier);
  }

  /** The connected node with the lowest load-penalty score */
  leastLoadNode(): LavalinkNode {
    const connected = [...this.nodes.values()].filter((n) => n.connected);
    if (!connected.length) throw new Error('[LavalinkManager] No connected Lavalink nodes');
    return connected.reduce((a, b) => (a.penalties <= b.penalties ? a : b));
  }

  // ── Player management ─────────────────────────────────────────

  /**
   * Create a player for the given guild, or return the existing one.
   * The player is NOT connected to voice until you call `player.connect()`.
   */
  create(options: PlayerOptions): LavalinkPlayer {
    const existing = this.players.get(options.guildId);
    if (existing) return existing;

    const node   = this.leastLoadNode();
    const player = new LavalinkPlayer(this, node, options);
    this.players.set(options.guildId, player);
    this.emit('playerCreate', player);
    return player;
  }

  /** Get the player for a guild, or `undefined` if none exists */
  get(guildId: string): LavalinkPlayer | undefined {
    return this.players.get(guildId);
  }

  /** Destroy the player for a guild (disconnects voice + clears persistence) */
  async destroy(guildId: string): Promise<void> {
    await this.players.get(guildId)?.destroy();
  }

  // ── Track search ─────────────────────────────────────────────

  /**
   * Search for tracks or load a URL.
   *
   * @param query  URL or search terms. If not a URL, the `defaultSearchPlatform`
   *               prefix is prepended (e.g. `ytsearch:never gonna give you up`).
   * @param node   Override which node handles this request.
   */
  async search(query: string, node?: LavalinkNode): Promise<SearchResult> {
    const n          = node ?? this.leastLoadNode();
    const platform   = this.options.defaultSearchPlatform ?? 'ytsearch';
    const identifier = /^https?:\/\//i.test(query)
      ? query
      : `${platform}:${query}`;
    return n.loadTracks(identifier);
  }

  // ── Discord voice gateway ─────────────────────────────────────

  /**
   * Feed raw Discord gateway packets into the manager.
   *
   * Wire this up in your bot with:
   * ```ts
   * client.on('raw', (packet) => manager.handleRawPacket(packet));
   * ```
   *
   * The manager only acts on `VOICE_STATE_UPDATE` and `VOICE_SERVER_UPDATE`.
   */
  handleRawPacket(packet: { t?: string; d?: unknown }): void {
    if (packet.t === 'VOICE_STATE_UPDATE') {
      this._handleVoiceStateUpdate(packet.d as VoiceStateData);
    } else if (packet.t === 'VOICE_SERVER_UPDATE') {
      this._handleVoiceServerUpdate(packet.d as VoiceServerUpdateData);
    }
  }

  // ── Internal — called by LavalinkNode ─────────────────────────

  /** @internal */
  _removePlayer(player: LavalinkPlayer): void {
    this._persistence?.delete(player.guildId);
    this.players.delete(player.guildId);
    this.emit('playerDestroy', player);
  }

  /** @internal */
  _savePlayer(player: LavalinkPlayer): void {
    if (!this._persistence) return;
    try {
      this._persistence.save(player.guildId, player.toJSON());
    } catch { /* non-fatal */ }
  }

  /**
   * @internal
   * Called by `LavalinkNode` after a `ready` op with `resumed: false`,
   * meaning Lavalink was fully restarted and all player state was lost there.
   * We restore from our own disk-based persistence file.
   */
  async _restorePlayers(node: LavalinkNode): Promise<void> {
    if (!this._persistence || this.options.autoResume === false) return;

    const saved   = this._persistence.getAll();
    const entries = Object.values(saved);
    if (!entries.length) return;

    for (const state of entries) {
      try {
        await this._restorePlayer(state, node);
      } catch { /* skip broken entries gracefully */ }
    }
  }

  // ── Private ───────────────────────────────────────────────────

  private async _restorePlayer(
    state: PersistedPlayerState,
    node:  LavalinkNode,
  ): Promise<void> {
    // Re-create the player object (don't use `create()` to avoid duplicate emit)
    const player = new LavalinkPlayer(this, node, {
      guildId:        state.guildId,
      voiceChannelId: state.voiceChannelId,
      textChannelId:  state.textChannelId,
      volume:         state.volume,
    });

    player.loop    = state.loop;
    player.paused  = state.paused;
    player.filters = state.filters;

    // Queue: put current track at front so it plays first
    if (state.currentTrack) {
      player.queue.add(state.queue);
      player.queue.add(state.currentTrack, 0);
    } else {
      player.queue.add(state.queue);
    }

    this.players.set(state.guildId, player);

    // Park the restore data — we'll pick it up once voice is established
    this._pendingRestores.set(state.guildId, state);

    // Ask Discord to reconnect to the voice channel
    await player.connect();

    this.emit('playerCreate', player);
    this.emit('playerRestore', player);
  }

  private _handleVoiceStateUpdate(data: VoiceStateData): void {
    if (!data?.guild_id) return;

    const player = this.players.get(data.guild_id);
    if (!player) return;

    // Only care about the bot itself
    if (data.user_id !== this.clientId) return;

    const oldChannel = player.voiceChannelId;

    if (!data.channel_id) {
      // Bot was disconnected from voice
      this.emit('playerMove', player, oldChannel, null);
      player.voiceChannelId = '';
    } else if (data.channel_id !== player.voiceChannelId) {
      // Bot moved to a different channel
      this.emit('playerMove', player, oldChannel, data.channel_id);
      player.voiceChannelId = data.channel_id;
    }

    player._voiceSessionId = data.session_id;
    this._voiceStates.set(data.guild_id, data);
    this._checkVoice(data.guild_id);
  }

  private _handleVoiceServerUpdate(data: VoiceServerUpdateData): void {
    if (!data?.guild_id || !data.endpoint) return;

    const player = this.players.get(data.guild_id);
    if (!player) return;

    player._voiceServer = {
      token:     data.token,
      endpoint:  data.endpoint,
      sessionId: player._voiceSessionId ?? '',
    };
    this._voiceServers.set(data.guild_id, data);
    this._checkVoice(data.guild_id);
  }

  /**
   * Once we have both voice-session-ID and voice-server data, send the
   * combined voice update to Lavalink, then handle any pending restore.
   */
  private _checkVoice(guildId: string): void {
    const player = this.players.get(guildId);
    if (!player?._voiceSessionId || !player?._voiceServer) return;

    // Always rebuild with the latest sessionId — avoids stale-empty-session bug
    // (VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE can arrive in either order)
    player._voiceServer = {
      ...player._voiceServer,
      sessionId: player._voiceSessionId,
    };

    player.node.updatePlayer(guildId, { voice: player._voiceServer })
      .then(async () => {
        const pending = this._pendingRestores.get(guildId);
        if (!pending) {
          // If voice WS dropped mid-play (cleanup TrackEndReason), replay the track
          const reconnectTrack = player._reconnectTrack;
          if (reconnectTrack) {
            player._reconnectTrack = null;
            await new Promise<void>((resolve) => setTimeout(resolve, 800));
            player.queue.add(reconnectTrack, 0);
            await player.play().catch(() => { /* swallow */ });
          }
          return;
        }

        this._pendingRestores.delete(guildId);

        // Brief pause to let the voice connection stabilise
        await new Promise<void>((resolve) => setTimeout(resolve, 600));

        if (player.queue.isEmpty) return;

        const track = player.queue.shift()!;
        await player.play(track);

        // Seek to saved position if meaningful (>3 s and not a stream)
        if (
          pending.savedPosition > 3_000 &&
          track.info.isSeekable &&
          !track.info.isStream
        ) {
          await player.seek(pending.savedPosition).catch(() => { /* ok */ });
        }

        if (pending.paused) {
          await player.pause(true).catch(() => { /* ok */ });
        }
      })
      .catch(() => { /* non-fatal — voice update failure */ });
  }

  private _onShutdown(): void {
    for (const player of this.players.values()) {
      this._savePlayer(player);
    }
  }

  // ── Typed EventEmitter overloads ─────────────────────────────

  emit<K extends keyof ManagerEventMap>(
    event: K,
    ...args: ManagerEventMap[K]
  ): boolean {
    return super.emit(event as string, ...args);
  }

  on<K extends keyof ManagerEventMap>(
    event: K,
    listener: (...args: ManagerEventMap[K]) => void,
  ): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return super.on(event as string, listener as (...args: any[]) => void);
  }

  once<K extends keyof ManagerEventMap>(
    event: K,
    listener: (...args: ManagerEventMap[K]) => void,
  ): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return super.once(event as string, listener as (...args: any[]) => void);
  }

  off<K extends keyof ManagerEventMap>(
    event: K,
    listener: (...args: ManagerEventMap[K]) => void,
  ): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return super.off(event as string, listener as (...args: any[]) => void);
  }
}
