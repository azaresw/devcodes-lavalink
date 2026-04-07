// ============================================================
//  devcodes-lavalink — Public API
// ============================================================

// Classes
export { LavalinkManager }    from './manager';
export { LavalinkNode }       from './node';
export { LavalinkPlayer }     from './player';
export { LavalinkQueue }      from './queue';
export { PlayerPersistence }  from './persistence';
export { FilterPresets }      from './filters';

// Types
export type {
  // Config
  ManagerOptions,
  NodeOptions,
  PlayerOptions,

  // Search / tracks
  SearchPlatform,
  SearchResult,
  LoadType,
  Track,
  TrackInfo,

  // Playback
  LoopMode,
  TrackEndReason,

  // Filters
  Filters,
  EqualizerBand,
  KaraokeFilter,
  TimescaleFilter,
  FreqDepthFilter,
  RotationFilter,
  DistortionFilter,
  ChannelMixFilter,
  LowPassFilter,

  // Voice
  VoiceStatePayload,
  VoiceStateData,
  VoiceServerUpdateData,
  VoiceServerPayload,

  // Node
  NodeStats,

  // Persistence
  PersistedPlayerState,

  // Events
  ManagerEventMap,

  // Discord library adapters
  DiscordJSClientLike,
  ErisClientLike,
  OceanicClientLike,
} from './types';

export type { PlayerState } from './player';
