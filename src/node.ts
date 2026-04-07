import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { LavalinkManager } from './manager';
import type {
  NodeOptions,
  NodeStats,
  LavalinkPayload,
  LavalinkStatsOp,
  LavalinkEventPayload,
  PlayerUpdatePayload,
  SearchResult,
  Track,
  SponsorBlockCategory,
} from './types';

// ── Internal raw Lavalink v4 response shapes ─────────────────

interface RawLoadResult {
  loadType: 'track' | 'playlist' | 'search' | 'empty' | 'error';
  data:     unknown;
}

interface RawPlaylistData {
  info:       { name: string; selectedTrack: number };
  pluginInfo: Record<string, unknown>;
  tracks:     Track[];
}

interface RawErrorData {
  message:   string;
  severity:  string;
  cause:     string;
}

// ── Defaults ─────────────────────────────────────────────────

const EMPTY_STATS: NodeStats = {
  players:       0,
  playingPlayers: 0,
  uptime:        0,
  memory: { free: 0, used: 0, allocated: 0, reservable: 0 },
  cpu:    { cores: 0, systemLoad: 0, lavalinkLoad: 0 },
};

/**
 * Represents a single Lavalink server connection.
 *
 * Handles:
 * - WebSocket lifecycle (connect / reconnect / destroy)
 * - REST API calls to Lavalink v4 (`/v4/*`)
 * - Routing incoming ops/events to the manager and players
 * - Load-penalty scoring for multi-node load balancing
 */
export class LavalinkNode extends EventEmitter {
  readonly manager:  LavalinkManager;
  readonly options:  Required<NodeOptions>;

  /** Session ID assigned by Lavalink on `ready`. Used for REST calls and resuming. */
  sessionId:  string | null = null;
  stats:      NodeStats     = { ...EMPTY_STATS };
  connected:  boolean       = false;

  private _ws:                WebSocket | null                        = null;
  private _reconnectAttempts: number                                  = 0;
  private _reconnectTimeout:  ReturnType<typeof setTimeout> | null    = null;

  constructor(manager: LavalinkManager, options: NodeOptions) {
    super();
    this.manager = manager;
    this.options = {
      host:        options.host,
      port:        options.port,
      password:    options.password,
      secure:      options.secure      ?? false,
      identifier:  options.identifier  ?? `${options.host}:${options.port}`,
      retryDelay:  options.retryDelay  ?? 5_000,
      retryAmount: options.retryAmount ?? -1,
    };
  }

  // ── Computed props ────────────────────────────────────────────

  get identifier(): string { return this.options.identifier; }

  /** Base HTTP URL for REST calls */
  get baseUrl(): string {
    const proto = this.options.secure ? 'https' : 'http';
    return `${proto}://${this.options.host}:${this.options.port}`;
  }

  /** WebSocket endpoint */
  get wsUrl(): string {
    const proto = this.options.secure ? 'wss' : 'ws';
    return `${proto}://${this.options.host}:${this.options.port}/v4/websocket`;
  }

  /**
   * Load-balancing penalty score — lower is better.
   * Accounts for CPU load, frame deficits/nulls, and current player count.
   */
  get penalties(): number {
    if (!this.connected) return Infinity;
    const cpu = Math.pow(1.05, 100 * this.stats.cpu.systemLoad) * 10 - 10;
    const deficit = this.stats.frameStats
      ? Math.pow(1.03, 500 * (this.stats.frameStats.deficit / 3_000)) * 600 - 600
      : 0;
    const nulled = this.stats.frameStats
      ? Math.pow(1.03, 500 * (this.stats.frameStats.nulled / 3_000)) * 300 - 300
      : 0;
    return cpu + deficit + nulled + this.stats.players;
  }

  // ── WebSocket lifecycle ───────────────────────────────────────

  connect(): void {
    if (this._ws?.readyState === WebSocket.OPEN) return;

    const headers: Record<string, string> = {
      'Authorization': this.options.password,
      'User-Id':       this.manager.clientId,
      'Client-Name':   this.manager.clientName,
    };

    // Pass session ID if we have one — enables Lavalink-side session resuming
    if (this.sessionId) headers['Session-Id'] = this.sessionId;

    this._ws = new WebSocket(this.wsUrl, { headers });
    this._ws.on('open',    ()     => this._onOpen());
    this._ws.on('message', (data) => this._onMessage(String(data)));
    this._ws.on('close',   (code, reason) => this._onClose(code, String(reason)));
    this._ws.on('error',   (err)  => this._onError(err));
  }

  /** Disconnect and stop reconnecting */
  destroy(code = 1_000): void {
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }
    this.connected = false;
    this._ws?.removeAllListeners();
    this._ws?.close(code);
    this._ws = null;
    this._reconnectAttempts = 0;
  }

  // ── REST API ──────────────────────────────────────────────────

  /** Load tracks or search by identifier / URL */
  async loadTracks(identifier: string): Promise<SearchResult> {
    const raw = await this._request<RawLoadResult>(
      `/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`
    );
    return this._parseLoadResult(raw);
  }

  /** Decode a single Base64-encoded track string into a Track object */
  async decodeTrack(encoded: string): Promise<Track> {
    return this._request<Track>(
      `/v4/decodetrack?encodedTrack=${encodeURIComponent(encoded)}`
    );
  }

  /** Decode multiple encoded track strings at once */
  async decodeTracks(encodedTracks: string[]): Promise<Track[]> {
    return this._request<Track[]>('/v4/decodetracks', {
      method: 'POST',
      body:   encodedTracks,
    });
  }

  /** Get all players for the current session from Lavalink's perspective */
  async getPlayers(): Promise<unknown[]> {
    if (!this.sessionId) return [];
    return this._request<unknown[]>(`/v4/sessions/${this.sessionId}/players`);
  }

  /**
   * Create or update a player on Lavalink.
   * @param noReplace  If true, don't replace the currently playing track.
   */
  async updatePlayer(
    guildId:   string,
    payload:   PlayerUpdatePayload,
    noReplace: boolean = false,
  ): Promise<void> {
    if (!this.sessionId) {
      throw new Error(`[Node:${this.identifier}] No session — node not ready`);
    }
    await this._request(
      `/v4/sessions/${this.sessionId}/players/${guildId}?noReplace=${noReplace}`,
      { method: 'PATCH', body: payload },
    );
  }

  /** Destroy a player on Lavalink */
  async destroyPlayer(guildId: string): Promise<void> {
    if (!this.sessionId) return;
    await this._request(
      `/v4/sessions/${this.sessionId}/players/${guildId}`,
      { method: 'DELETE' },
    );
  }

  /** Configure Lavalink-side session resuming for this session */
  async updateSession(resuming: boolean, timeout = 60): Promise<void> {
    if (!this.sessionId) return;
    await this._request(`/v4/sessions/${this.sessionId}`, {
      method: 'PATCH',
      body:   { resuming, timeout },
    });
  }

  /**
   * Enable SponsorBlock segment skipping for a player.
   * Requires the Lavalink SponsorBlock plugin to be installed server-side.
   */
  async setSponsorBlock(guildId: string, categories: SponsorBlockCategory[]): Promise<void> {
    if (!this.sessionId) return;
    await this._request(
      `/v4/sessions/${this.sessionId}/players/${guildId}/sponsorblock/categories`,
      { method: 'PUT', body: categories },
    );
  }

  /**
   * Disable all SponsorBlock segment skipping for a player.
   */
  async clearSponsorBlock(guildId: string): Promise<void> {
    if (!this.sessionId) return;
    await this._request(
      `/v4/sessions/${this.sessionId}/players/${guildId}/sponsorblock/categories`,
      { method: 'DELETE' },
    );
  }

  // ── Private helpers ───────────────────────────────────────────

  private async _request<T = void>(
    path: string,
    opts: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = opts.method ?? 'GET';
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': this.options.password,
        'Content-Type':  'application/json',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (res.status === 204 || method === 'DELETE') return undefined as T;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`[Node:${this.identifier}] REST ${method} ${path} → ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  private _onOpen(): void {
    this.connected = true;
    this._reconnectAttempts = 0;
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }
    this.manager.emit('nodeConnect', this);
  }

  private _onMessage(raw: string): void {
    let payload: LavalinkPayload;
    try {
      payload = JSON.parse(raw) as LavalinkPayload;
    } catch {
      return;
    }

    switch (payload.op) {
      case 'ready': {
        const { resumed, sessionId } = payload;
        this.sessionId = sessionId;

        // Tell Lavalink to keep this session alive for 60 s after disconnect
        this.updateSession(true, 60).catch(() => { /* non-fatal */ });

        this.manager.emit('nodeReady', this, sessionId, resumed);

        // If Lavalink did NOT resume (it was restarted), restore our persisted players
        if (!resumed) {
          this.manager._restorePlayers(this).catch(() => { /* non-fatal */ });
        }
        break;
      }

      case 'playerUpdate': {
        const player = this.manager.players.get(payload.guildId);
        if (player) {
          player._state.position  = payload.state.position;
          player._state.ping      = payload.state.ping;
          player._state.connected = payload.state.connected;
          player._state.time      = payload.state.time;
        }
        break;
      }

      case 'stats': {
        const { op: _op, ...stats } = payload as LavalinkStatsOp;
        this.stats = stats as NodeStats;
        this.manager.emit('nodeStats', this, this.stats);
        break;
      }

      case 'event': {
        const ev     = payload as LavalinkEventPayload;
        const player = this.manager.players.get(ev.guildId);
        if (!player) break;

        switch (ev.type) {
          case 'TrackStartEvent':     player._handleTrackStart(ev.track);                           break;
          case 'TrackEndEvent':       player._handleTrackEnd(ev.track, ev.reason);                  break;
          case 'TrackExceptionEvent': player._handleTrackException(ev.track, ev.exception);         break;
          case 'TrackStuckEvent':     player._handleTrackStuck(ev.track, ev.thresholdMs);           break;
          case 'WebSocketClosedEvent':
            // Voice WS closed unexpectedly — attempt reconnect unless intentional (1000)
            if (ev.code !== 1_000) {
              player.connect().catch(() => { /* reconnect attempt */ });
            }
            break;
          case 'LyricsFoundEvent':
            this.manager.emit('lyricsFound', player, ev.lyrics);
            break;
          case 'LyricsLineEvent':
            this.manager.emit('lyricsLine', player, ev.line);
            break;
          case 'LyricsNotFoundEvent':
            this.manager.emit('lyricsNotFound', player);
            break;
          case 'SegmentSkippedEvent':
            this.manager.emit('segmentSkipped', player, ev.segment);
            break;
        }
        break;
      }
    }
  }

  private _onClose(code: number, reason: string): void {
    this.connected = false;
    this.manager.emit('nodeDisconnect', this, code, reason);
    if (code !== 1_000) this._scheduleReconnect();
  }

  private _onError(error: Error): void {
    this.manager.emit('nodeError', this, error);
    this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    const { retryAmount, retryDelay } = this.options;
    if (retryAmount !== -1 && this._reconnectAttempts >= retryAmount) {
      this.manager.emit(
        'nodeError',
        this,
        new Error(`[Node:${this.identifier}] Max reconnect attempts (${retryAmount}) reached`),
      );
      return;
    }
    this._reconnectAttempts++;
    this._reconnectTimeout = setTimeout(() => this.connect(), retryDelay);
  }

  private _parseLoadResult(raw: RawLoadResult): SearchResult {
    switch (raw.loadType) {
      case 'track':
        return { loadType: 'track', tracks: [raw.data as Track] };

      case 'playlist': {
        const pl = raw.data as RawPlaylistData;
        return {
          loadType: 'playlist',
          tracks:   pl.tracks,
          playlist: {
            name:          pl.info.name,
            selectedTrack: pl.info.selectedTrack,
            duration:      pl.tracks.reduce((acc, t) => acc + t.info.length, 0),
          },
        };
      }

      case 'search':
        return { loadType: 'search', tracks: raw.data as Track[] };

      case 'empty':
        return { loadType: 'empty', tracks: [] };

      case 'error':
        return {
          loadType: 'error',
          tracks:   [],
          error:    (raw.data as RawErrorData)?.message ?? 'Unknown load error',
        };

      default:
        return { loadType: 'empty', tracks: [] };
    }
  }
}
