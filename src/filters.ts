import type { Filters, EqualizerBand } from './types';

/** Build an equalizer array from [band, gain] pairs */
function eq(pairs: [band: number, gain: number][]): EqualizerBand[] {
  return pairs.map(([band, gain]) => ({ band, gain }));
}

/** Zero-out all 15 bands */
function flatEq(): EqualizerBand[] {
  return Array.from({ length: 15 }, (_, band) => ({ band, gain: 0 }));
}

/**
 * Ready-made filter presets for `LavalinkPlayer`.
 *
 * Each preset returns a `Filters` object you can pass directly to
 * `player.setFilters()`, or use the convenience methods built into the player:
 * `player.bassBoost()`, `player.nightcore()`, `player.vaporwave()`, etc.
 */
export const FilterPresets = {

  /**
   * Bass boost — amplifies low-frequency bands.
   * @param level  'low' | 'medium' | 'high' | 'extreme'
   */
  bassBoost(level: 'low' | 'medium' | 'high' | 'extreme' = 'medium'): Filters {
    const table: Record<string, number[]> = {
      low:     [0.15, 0.15, 0.10, 0.05, 0.00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      medium:  [0.30, 0.25, 0.20, 0.10, 0.05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      high:    [0.50, 0.40, 0.35, 0.20, 0.10, 0.05, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      extreme: [1.00, 0.80, 0.60, 0.40, 0.20, 0.10, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    return {
      equalizer: (table[level] ?? table['medium']!).map((gain, band) => ({ band, gain })),
    };
  },

  /** Nightcore — increases speed and pitch for the classic effect */
  nightcore(): Filters {
    return {
      timescale: { speed: 1.3, pitch: 1.3, rate: 1.0 },
    };
  },

  /** Vaporwave — slows and lowers pitch, adds warm low-end */
  vaporwave(): Filters {
    return {
      timescale: { speed: 0.8, pitch: 0.8, rate: 1.0 },
      equalizer: eq([[0, 0.3], [1, 0.3]]),
    };
  },

  /** Soft — gentle low-pass filter, smooths out harsh highs */
  soft(): Filters {
    return { lowPass: { smoothing: 20 } };
  },

  /** Pop — boosts low-mids, cuts high-mids for a punchy pop sound */
  pop(): Filters {
    return {
      equalizer: eq([
        [0, 0.65], [1, 0.45], [2, -0.45], [3, 0.65], [4, 0.45],
        [5, -0.25], [6, -0.25], [7, -0.25], [8, -0.25], [9, -0.25],
        [10, -0.25], [11, -0.25], [12, -0.25], [13, -0.25], [14, -0.25],
      ]),
    };
  },

  /** Treble & bass — boosts both ends, cuts mids */
  trebleBass(): Filters {
    return {
      equalizer: eq([
        [0, 0.6], [1, 0.67], [2, 0.67], [3, 0], [4, -0.5],
        [5, 0.15], [6, -0.45], [7, 0.23], [8, 0.35], [9, 0.45],
        [10, 0.55], [11, 0.6], [12, 0.55], [13, 0], [14, 0],
      ]),
    };
  },

  /** 8D audio — stereo rotation for a spatial "all-around" effect */
  eightD(): Filters {
    return { rotation: { rotationHz: 0.2 } };
  },

  /** Karaoke — attempts to remove centre-panned vocals */
  karaoke(): Filters {
    return {
      karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 },
    };
  },

  /** Tremolo — volume oscillation (wavering effect) */
  tremolo(): Filters {
    return { tremolo: { frequency: 4.0, depth: 0.75 } };
  },

  /** Vibrato — pitch oscillation */
  vibrato(): Filters {
    return { vibrato: { frequency: 4.0, depth: 0.75 } };
  },

  /** Earrape — extreme distortion / clipping */
  earrape(): Filters {
    return {
      equalizer: flatEq().map((band) => ({ ...band, gain: 1.0 })),
      distortion: {
        sinOffset: 0, sinScale: 1,
        cosOffset: 1, cosScale: 0,
        tanOffset: 0, tanScale: 1,
        offset: 0,   scale: 1.3,
      },
    };
  },

  /**
   * Reset all filters to their defaults.
   * Sends explicit null for every optional filter so Lavalink clears them.
   */
  clear(): Filters {
    return {
      equalizer:   flatEq(),
      karaoke:     null,
      timescale:   null,
      tremolo:     null,
      vibrato:     null,
      rotation:    null,
      distortion:  null,
      channelMix:  null,
      lowPass:     null,
    };
  },
} as const;
