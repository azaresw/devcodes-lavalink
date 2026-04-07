// ============================================================
//  devcodes-lavalink — Type Definitions
//  Full Lavalink v4 protocol + manager types
// ============================================================

// ── Search & Load ─────────────────────────────────────────────

/** Search platform prefix used when the query isn't a URL */
export type SearchPlatform =
  | 'ytsearch'   // YouTube
  | 'ytmsearch'  // YouTube Music
  | 'scsearch'   // SoundCloud
  | 'spsearch'   // Spotify  (requires LavaSrc plugin on server)
  | 'dzsearch'   // Deezer   (requires LavaSrc plugin on server)
  | 'amsearch'   // Apple Music (requires LavaSrc plugin on server)
  | string;      // any custom provider

export type LoadType = 'track' | 'playlist' | 'search' | 'empty' | 'error';

export type TrackEndReason =
  | 'finished'
  | 'loadFailed'
  | 'stopped'
  | 'replaced'
  | 'cleanup';

export type LoopMode = 'none' | 'track' | 'queue';

export type Severity = 'common' | 'suspicious' | 'fault';

// ── Track ─────────────────────────────────────────────────────

export interface Track {
  encoded:    string;
  info:       TrackInfo;
  pluginInfo: Record<string, unknown>;
  userData:   Record<string, unknown>;
}

export interface TrackInfo {
  identifier: string;
  isSeekable: boolean;
  author:     string;
  length:     number;
  isStream:   boolean;
  position:   number;
  title:      string;
  uri?:       string;
  artworkUrl?: string;
  isrc?:      string;
  sourceName: string;
}

export interface SearchResult {
  loadType: LoadType;
  tracks:   Track[];
  playlist?: {
    name:          string;
    selectedTrack: number;
    duration:      number;
  };
  error?: string;
}

// ── Node ──────────────────────────────────────────────────────

export interface NodeOptions {
  /** Lavalink server hostname or IP */
  host: string;
  /** Lavalink server port */
  port: number;
  /** Lavalink server password */
  password: string;
  /** Use secure WebSocket / HTTPS (default: false) */
  secure?: boolean;
  /** Human-readable node identifier — defaults to `host:port` */
  identifier?: string;
  /** Milliseconds between reconnect attempts (default: 5000) */
  retryDelay?: number;
  /** Max reconnect attempts: -1 = infinite (default: -1) */
  retryAmount?: number;
}

export interface NodeStats {
  players:       number;
  playingPlayers: number;
  uptime:        number;
  memory: {
    free:        number;
    used:        number;
    allocated:   number;
    reservable:  number;
  };
  cpu: {
    cores:         number;
    systemLoad:    number;
    lavalinkLoad:  number;
  };
  frameStats?: {
    sent:    number;
    nulled:  number;
    deficit: number;
  };
}

// ── Manager ───────────────────────────────────────────────────

export interface ManagerOptions {
  /** Lavalink node(s) to connect to */
  nodes: NodeOptions[];
  /** Discord bot client ID — can also be passed to `manager.init()` */
  clientId?: string;
  /** Name reported to Lavalink (default: 'devcodes-lavalink/1.0.0') */
  clientName?: string;
  /** Default search platform when the query is not a URL (default: 'ytsearch') */
  defaultSearchPlatform?: SearchPlatform;
  /**
   * Path to the JSON file used for player persistence.
   * Set to `false` to disable persistence entirely.
   * Default: `'./devcodes-lavalink.json'`
   */
  persistencePath?: string | false;
  /**
   * Automatically restore players from persistence on node connect.
   * Default: true
   */
  autoResume?: boolean;
  /**
   * Function that sends a raw voice-state payload to the Discord gateway.
   *
   * @example
   * // discord.js
   * send: (guildId, payload) => {
   *   const guild = client.guilds.cache.get(guildId);
   *   guild?.shard.send(payload);
   * }
   */
  send: (guildId: string, payload: VoiceStatePayload) => void;
}

// ── Player ────────────────────────────────────────────────────

export interface PlayerOptions {
  /** Guild ID this player belongs to */
  guildId: string;
  /** Voice channel ID to connect to */
  voiceChannelId: string;
  /** Text channel ID for bot replies (informational — not used internally) */
  textChannelId?: string;
  /** Initial volume 0–1000 (default: 100) */
  volume?: number;
  /** Self-deafen in voice channel (default: true) */
  selfDeaf?: boolean;
  /** Self-mute in voice channel (default: false) */
  selfMute?: boolean;
}

// ── REST Payloads ─────────────────────────────────────────────

export interface PlayerUpdatePayload {
  track?: {
    encoded?:    string | null;
    identifier?: string;
    userData?:   Record<string, unknown>;
  };
  position?: number;
  endTime?:  number | null;
  volume?:   number;
  paused?:   boolean;
  filters?:  Partial<Filters>;
  voice?:    VoiceServerPayload;
}

export interface VoiceServerPayload {
  token:     string;
  endpoint:  string;
  sessionId: string;
  /** Required for DAVE (Discord E2EE audio/video encryption). Lavalink v4.0.8+ */
  channelId?: string;
}

// ── Voice ─────────────────────────────────────────────────────

export interface VoiceStatePayload {
  op: 4;
  d: {
    guild_id:   string;
    channel_id: string | null;
    self_deaf:  boolean;
    self_mute:  boolean;
  };
}

export interface VoiceStateData {
  guild_id:   string;
  user_id:    string;
  channel_id: string | null;
  session_id: string;
}

export interface VoiceServerUpdateData {
  token:     string;
  guild_id:  string;
  endpoint:  string | null;
}

// ── Filters ───────────────────────────────────────────────────

export interface Filters {
  volume?:      number;
  equalizer?:   EqualizerBand[];
  karaoke?:     KaraokeFilter    | null;
  timescale?:   TimescaleFilter  | null;
  tremolo?:     FreqDepthFilter  | null;
  vibrato?:     FreqDepthFilter  | null;
  rotation?:    RotationFilter   | null;
  distortion?:  DistortionFilter | null;
  channelMix?:  ChannelMixFilter | null;
  lowPass?:     LowPassFilter    | null;
}

export interface EqualizerBand {
  /** Band index 0–14 */
  band: number;
  /** Gain -0.25 to 1.0 */
  gain: number;
}

export interface KaraokeFilter {
  level?:       number;
  monoLevel?:   number;
  filterBand?:  number;
  filterWidth?: number;
}

export interface TimescaleFilter {
  speed?: number;
  pitch?: number;
  rate?:  number;
}

export interface FreqDepthFilter {
  frequency?: number;
  depth?:     number;
}

export interface RotationFilter {
  rotationHz?: number;
}

export interface DistortionFilter {
  sinOffset?: number;
  sinScale?:  number;
  cosOffset?: number;
  cosScale?:  number;
  tanOffset?: number;
  tanScale?:  number;
  offset?:    number;
  scale?:     number;
}

export interface ChannelMixFilter {
  leftToLeft?:   number;
  leftToRight?:  number;
  rightToLeft?:  number;
  rightToRight?: number;
}

export interface LowPassFilter {
  smoothing?: number;
}

// ── WebSocket Payloads (incoming from Lavalink) ───────────────

export interface LavalinkReadyOp {
  op:        'ready';
  resumed:   boolean;
  sessionId: string;
}

export interface LavalinkPlayerUpdateOp {
  op:      'playerUpdate';
  guildId: string;
  state: {
    time:      number;
    position:  number;
    connected: boolean;
    ping:      number;
  };
}

export interface LavalinkStatsOp extends NodeStats {
  op: 'stats';
}

export interface LavalinkTrackStartEvent {
  op:      'event';
  type:    'TrackStartEvent';
  guildId: string;
  track:   Track;
}

export interface LavalinkTrackEndEvent {
  op:      'event';
  type:    'TrackEndEvent';
  guildId: string;
  track:   Track;
  reason:  TrackEndReason;
}

export interface LavalinkTrackExceptionEvent {
  op:      'event';
  type:    'TrackExceptionEvent';
  guildId: string;
  track:   Track;
  exception: {
    message:  string | null;
    severity: Severity;
    cause:    string;
  };
}

export interface LavalinkTrackStuckEvent {
  op:          'event';
  type:        'TrackStuckEvent';
  guildId:     string;
  track:       Track;
  thresholdMs: number;
}

export interface LavalinkWebSocketClosedEvent {
  op:       'event';
  type:     'WebSocketClosedEvent';
  guildId:  string;
  code:     number;
  reason:   string;
  byRemote: boolean;
}

export type LavalinkEventPayload =
  | LavalinkTrackStartEvent
  | LavalinkTrackEndEvent
  | LavalinkTrackExceptionEvent
  | LavalinkTrackStuckEvent
  | LavalinkWebSocketClosedEvent;

export type LavalinkPayload =
  | LavalinkReadyOp
  | LavalinkPlayerUpdateOp
  | LavalinkStatsOp
  | LavalinkEventPayload;

// ── Persistence ───────────────────────────────────────────────

export interface PersistedPlayerState {
  guildId:        string;
  nodeIdentifier: string;
  voiceChannelId: string;
  textChannelId?: string;
  volume:         number;
  loop:           LoopMode;
  paused:         boolean;
  filters:        Filters;
  currentTrack:   Track | null;
  /** Approximate playback position in ms at the time of saving */
  savedPosition:  number;
  queue:          Track[];
  /** Unix timestamp of when this state was saved */
  timestamp:      number;
}

// ── Manager Event Map ─────────────────────────────────────────

export interface ManagerEventMap {
  // Node
  nodeConnect:    [node: import('./node').LavalinkNode];
  nodeDisconnect: [node: import('./node').LavalinkNode, code: number, reason: string];
  nodeError:      [node: import('./node').LavalinkNode, error: Error];
  nodeReady:      [node: import('./node').LavalinkNode, sessionId: string, resumed: boolean];
  nodeStats:      [node: import('./node').LavalinkNode, stats: NodeStats];
  // Player
  playerCreate:   [player: import('./player').LavalinkPlayer];
  playerDestroy:  [player: import('./player').LavalinkPlayer];
  playerRestore:  [player: import('./player').LavalinkPlayer];
  playerMove:     [player: import('./player').LavalinkPlayer, oldChannel: string, newChannel: string | null];
  // Track
  trackStart:     [player: import('./player').LavalinkPlayer, track: Track];
  trackEnd:       [player: import('./player').LavalinkPlayer, track: Track, reason: TrackEndReason];
  trackError:     [player: import('./player').LavalinkPlayer, track: Track, exception: unknown];
  trackStuck:     [player: import('./player').LavalinkPlayer, track: Track, thresholdMs: number];
  queueEnd:       [player: import('./player').LavalinkPlayer];
}
