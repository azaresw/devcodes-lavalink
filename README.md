# devcodes-lavalink

A full-featured **Lavalink v4** client for **discord.js v14** — TypeScript-first, zero config, auto-reconnect, and built-in player persistence that survives full system reboots.

```bash
npm install devcodes-lavalink
```

---

## Why devcodes-lavalink?

| Feature | devcodes-lavalink | erela.js | moonlink | shoukaku |
|---|:---:|:---:|:---:|:---:|
| Player persistence (survives reboots) | ✅ | ❌ | ❌ | ❌ |
| Lavalink v4 REST API (full) | ✅ | ❌ | ✅ | ✅ |
| Lavalink session resuming | ✅ auto | ❌ | ⚠️ manual | ⚠️ manual |
| Auto-reconnect (WS + voice) | ✅ | ⚠️ | ✅ | ✅ |
| Load balancing (penalty score) | ✅ CPU + frames | ⚠️ basic | ⚠️ basic | ✅ |
| Filter presets built-in | ✅ 10 presets | ❌ | ❌ | ❌ |
| TypeScript strict mode | ✅ | ❌ | ⚠️ | ✅ |
| Runtime dependencies | **1** (`ws`) | 3 | 3 | 2 |

---

## Requirements

- **Node.js** 18+
- **discord.js** v14
- **Lavalink** v4.0.0+ ([download](https://github.com/lavalink-devs/Lavalink/releases))

> **DAVE encryption**: Lavalink v4.0.8+ handles Discord's DAVE audio encryption natively. Just keep your Lavalink server up to date — no changes needed in this library.

---

## Quick Start

```ts
import { LavalinkManager } from 'devcodes-lavalink';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const manager = new LavalinkManager({
  nodes: [
    {
      host:     'localhost',
      port:     2333,
      password: 'youshallnotpass',
    },
  ],
  // Forward voice state to Discord gateway
  send: (guildId, payload) => {
    client.guilds.cache.get(guildId)?.shard.send(payload);
  },
  // Where to save player state (default: './devcodes-lavalink.json')
  // Players are automatically restored after a reboot
  persistencePath: './players.json',
});

// 1. Connect nodes once the bot is ready
client.once('ready', () => {
  console.log(`Logged in as ${client.user!.tag}`);
  manager.init(client.user!.id);
});

// 2. Forward raw Discord voice packets to the manager
client.on('raw', (packet) => manager.handleRawPacket(packet));

client.login('BOT_TOKEN');
```

---

## Playing Music

```ts
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith('!play ')) return;

  const query      = message.content.slice(6).trim();
  const voiceChannel = message.member?.voice.channel;
  if (!voiceChannel) return message.reply('Join a voice channel first!');

  // Create or get the existing player for this guild
  const player = manager.create({
    guildId:        message.guild.id,
    voiceChannelId: voiceChannel.id,
    textChannelId:  message.channel.id,
    selfDeaf:       true,
  });

  // Connect to voice
  await player.connect();

  // Search and play
  const result = await manager.search(query, message.member?.voice.channel?.guild.name);

  if (result.loadType === 'empty' || result.loadType === 'error') {
    return message.reply('Nothing found.');
  }

  if (result.loadType === 'playlist') {
    player.queue.add(result.tracks);
    message.reply(`Added playlist **${result.playlist?.name}** (${result.tracks.length} tracks)`);
  } else {
    player.queue.add(result.tracks[0]!);
    message.reply(`Added **${result.tracks[0]!.info.title}**`);
  }

  if (!player.playing) await player.play();
});
```

---

## API

### `LavalinkManager`

The main class. Create one per bot process.

```ts
const manager = new LavalinkManager(options: ManagerOptions);
```

#### `ManagerOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `nodes` | `NodeOptions[]` | required | Lavalink node(s) to connect to |
| `send` | `(guildId, payload) => void` | required | Sends voice state to Discord |
| `clientId` | `string` | — | Bot user ID (can pass via `init()`) |
| `clientName` | `string` | `'devcodes-lavalink/1.0.0'` | Name reported to Lavalink |
| `defaultSearchPlatform` | `SearchPlatform` | `'ytsearch'` | Platform used for non-URL queries |
| `persistencePath` | `string \| false` | `'./devcodes-lavalink.json'` | Path for player state file. `false` disables persistence |
| `autoResume` | `boolean` | `true` | Restore players from file on node connect |

#### Methods

```ts
manager.init(clientId: string): this               // Connect all nodes
manager.create(options: PlayerOptions): LavalinkPlayer
manager.get(guildId: string): LavalinkPlayer | undefined
manager.destroy(guildId: string): Promise<void>
manager.search(query: string, node?: LavalinkNode): Promise<SearchResult>
manager.addNode(options: NodeOptions): LavalinkNode
manager.removeNode(identifier: string): void
manager.leastLoadNode(): LavalinkNode
manager.handleRawPacket(packet): void
```

#### Events

```ts
manager.on('nodeConnect',    (node) => {})
manager.on('nodeDisconnect', (node, code, reason) => {})
manager.on('nodeReady',      (node, sessionId, resumed) => {})
manager.on('nodeError',      (node, error) => {})
manager.on('nodeStats',      (node, stats) => {})
manager.on('playerCreate',   (player) => {})
manager.on('playerDestroy',  (player) => {})
manager.on('playerRestore',  (player) => {})   // fired on reboot restore
manager.on('playerMove',     (player, oldChannel, newChannel) => {})
manager.on('trackStart',     (player, track) => {})
manager.on('trackEnd',       (player, track, reason) => {})
manager.on('trackError',     (player, track, exception) => {})
manager.on('trackStuck',     (player, track, thresholdMs) => {})
manager.on('queueEnd',       (player) => {})
```

---

### `LavalinkPlayer`

Controls playback for a single guild.

#### Playback

```ts
await player.play(track?)        // Play a track (or shift from queue)
await player.skip()              // Skip current track
await player.stop()              // Stop and clear current track
await player.pause()             // Pause
await player.resume()            // Resume
await player.seek(positionMs)    // Seek to position (seekable tracks only)
await player.setVolume(100)      // 0–1000 (100 = 100%)
await player.destroy()           // Disconnect + remove + clear persistence
```

#### Queue

```ts
player.queue.add(track)          // Append a track
player.queue.add(tracks)         // Append multiple tracks
player.queue.add(track, 0)       // Insert at position 0 (plays next)
player.queue.remove(0)           // Remove track at index 0
player.queue.shuffle()           // Fisher-Yates in-place shuffle
player.queue.clear()             // Clear upcoming tracks
player.queue.history             // Last 50 finished tracks (newest first)
player.queue.size                // Number of upcoming tracks
player.queue.tracks              // ReadonlyArray of upcoming tracks
```

#### Loop

```ts
player.setLoop('none')           // No looping (default)
player.setLoop('track')          // Repeat the current track forever
player.setLoop('queue')          // Repeat the whole queue forever
```

#### Properties

```ts
player.current      // Currently playing Track | null
player.position     // Interpolated position in ms (more accurate than raw state)
player.playing      // boolean
player.paused       // boolean
player.volume       // number
player.loop         // LoopMode
player.filters      // active Filters object
player.queue        // LavalinkQueue
player.node         // LavalinkNode this player is on
```

---

### Filter Presets

Apply a preset directly via the player convenience methods:

```ts
await player.bassBoost('medium')   // 'low' | 'medium' | 'high' | 'extreme'
await player.nightcore()
await player.vaporwave()
await player.eightD()
await player.karaoke()
await player.softFilter()
await player.trebleBass()
await player.tremolo()
await player.vibrato()
await player.clearFilters()        // Reset all filters
```

Or build custom filters with `player.setFilters()`:

```ts
await player.setFilters({
  timescale: { speed: 1.2, pitch: 1.2 },
  equalizer: [{ band: 0, gain: 0.5 }, { band: 1, gain: 0.3 }],
});
```

Or use `FilterPresets` directly:

```ts
import { FilterPresets } from 'devcodes-lavalink';

await player.setFilters(FilterPresets.bassBoost('high'));
await player.setFilters(FilterPresets.nightcore());
```

---

### Search Platforms

| Prefix | Platform | Plugin required |
|---|---|---|
| `ytsearch:` | YouTube | — |
| `ytmsearch:` | YouTube Music | — |
| `scsearch:` | SoundCloud | — |
| `spsearch:` | Spotify | LavaSrc |
| `dzsearch:` | Deezer | LavaSrc |
| `amsearch:` | Apple Music | LavaSrc |

```ts
// YouTube (default)
const result = await manager.search('never gonna give you up');

// Specify platform
const result = await manager.search('spsearch:blinding lights');

// Load a direct URL
const result = await manager.search('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
```

---

### Multi-Node

```ts
const manager = new LavalinkManager({
  nodes: [
    { host: 'us.lavalink.example.com', port: 2333, password: 'pass', identifier: 'US' },
    { host: 'eu.lavalink.example.com', port: 2333, password: 'pass', identifier: 'EU' },
  ],
  send,
});

// Automatically picks the node with the lowest penalty score
const player = manager.create({ guildId, voiceChannelId });

// Manual node selection for search
const result = await manager.search('query', manager.nodes.get('EU'));
```

---

## Player Persistence

Players are automatically saved to disk after every meaningful state change (play, pause, volume, filters, queue update) and every 5 seconds while actively playing.

On startup — or whenever a Lavalink node reconnects after a full restart — all saved players are restored: voice channel reconnected, queue rebuilt, and playback resumed from the saved position.

```ts
// Disable persistence entirely
const manager = new LavalinkManager({
  persistencePath: false,
  // ...
});

// Custom path
const manager = new LavalinkManager({
  persistencePath: './data/lavalink-players.json',
  // ...
});
```

The persistence file stores: guild ID, voice/text channel IDs, volume, loop mode, filters, the full queue, the current track, and the approximate playback position.

---

## Full Example Bot

```ts
import { LavalinkManager } from 'devcodes-lavalink';
import { Client, GatewayIntentBits } from 'discord.js';

const client  = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const manager = new LavalinkManager({
  nodes: [{ host: 'localhost', port: 2333, password: 'youshallnotpass' }],
  send: (guildId, payload) => client.guilds.cache.get(guildId)?.shard.send(payload),
});

client.once('ready', () => manager.init(client.user!.id));
client.on('raw',     (p) => manager.handleRawPacket(p));

manager.on('trackStart', (player, track) => {
  console.log(`Now playing: ${track.info.title} in guild ${player.guildId}`);
});
manager.on('queueEnd', (player) => {
  console.log(`Queue finished in guild ${player.guildId}`);
});
manager.on('nodeReady', (node, sessionId, resumed) => {
  console.log(`Node ${node.identifier} ready (resumed: ${resumed})`);
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  const [cmd, ...args] = msg.content.split(' ');

  if (cmd === '!play') {
    const vc = msg.member?.voice.channel;
    if (!vc) return msg.reply('Join a voice channel!').then(() => {});
    const player = manager.create({ guildId: msg.guild.id, voiceChannelId: vc.id });
    await player.connect();
    const res = await manager.search(args.join(' '));
    if (!res.tracks.length) return msg.reply('Not found.').then(() => {});
    player.queue.add(res.tracks[0]!);
    if (!player.playing) await player.play();
    msg.reply(`Queued **${res.tracks[0]!.info.title}**`);
  }

  if (cmd === '!skip')        manager.get(msg.guild.id)?.skip();
  if (cmd === '!pause')       manager.get(msg.guild.id)?.pause();
  if (cmd === '!resume')      manager.get(msg.guild.id)?.resume();
  if (cmd === '!stop')        manager.get(msg.guild.id)?.stop();
  if (cmd === '!loop')        manager.get(msg.guild.id)?.setLoop(args[0] as 'none'|'track'|'queue' ?? 'none');
  if (cmd === '!volume')      manager.get(msg.guild.id)?.setVolume(Number(args[0]));
  if (cmd === '!bassboost')   manager.get(msg.guild.id)?.bassBoost(args[0] as 'low'|'medium'|'high'|'extreme');
  if (cmd === '!nightcore')   manager.get(msg.guild.id)?.nightcore();
  if (cmd === '!8d')          manager.get(msg.guild.id)?.eightD();
  if (cmd === '!clearfx')     manager.get(msg.guild.id)?.clearFilters();
  if (cmd === '!disconnect')  manager.get(msg.guild.id)?.destroy();
});

client.login(process.env.BOT_TOKEN!);
```

---

## Links

- **npm**: https://www.npmjs.com/package/devcodes-lavalink
- **GitHub**: https://github.com/azaresw/devcodes-lavalink
- **Support**: https://discord.gg/ESh2Dp2xX9
- **Lavalink**: https://github.com/lavalink-devs/Lavalink

---

## License

MIT © [azaresw](https://github.com/azaresw)
