/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║        GOD MODE v4.0 – Minecraft Bot Paneli            ║
 * ║   Gelişmiş Proxy • AntiAFK • Spam • PvP • Envanter     ║
 * ║      Render.com Optimize • Node.js 18+ • 29KB+        ║
 * ╚══════════════════════════════════════════════════════════╝
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const autoEat = require('mineflayer-auto-eat').plugin;
const armorManager = require('mineflayer-armor-manager');
const pvp = require('mineflayer-pvp').plugin;
const mcDataLoader = require('minecraft-data');

// ══════════════════ KONFİGÜRASYON ══════════════════
const CONFIG = {
  PORT: process.env.PORT || 10000,
  NODE_ENV: process.env.NODE_ENV || 'production',
  MAX_BOTS: 15,
  BOT_DATA_INTERVAL: 1000,
  SYSTEM_INFO_INTERVAL: 2000,
  HEARTBEAT_INTERVAL: 30000,
  PROXY_FILE: path.join(__dirname, 'proxies.txt'),
  LOG_MAX: 500,
  RECONNECT_BASE_DELAY: 3000,
  RECONNECT_MAX_DELAY: 30000,
  MAX_RECONNECT_ATTEMPTS: 5,
  HEALTH_MEMORY_THRESHOLD: 400, // MB
  ENABLE_PVP: true,
  ENABLE_AUTO_EAT: true,
  AUTO_EAT_START_AT: 14,
  ANTI_AFK_MIN_DELAY: 20000,
  ANTI_AFK_MAX_DELAY: 50000,
  SPAM_MIN_INTERVAL: 500,
  SPAM_DEFAULT_INTERVAL: 3000,
  VIEW_DISTANCE: 'tiny',
  CONNECT_TIMEOUT: 15000,
  KEEP_ALIVE: true,
  AUTH: 'offline'
};

// ══════════════════ GLOBAL STATE ══════════════════
const bots = new Map();
const logBuffer = [];
let activeConnections = 0;
let startTime = Date.now();

// ══════════════════ ERROR HANDLING ══════════════════
process.on('uncaughtException', (err) => console.error('[FATAL]', err));
process.on('unhandledRejection', (reason) => console.error('[ASYNC]', reason));

// ══════════════════ EXPRESS & SOCKET.IO ══════════════════
const app = express();
app.set('trust proxy', 1);
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingTimeout: 30000,
  pingInterval: 15000,
  connectTimeout: 30000,
  cors: { origin: '*' },
  allowEIO3: true,
  maxHttpBufferSize: 1e6
});

// Health check endpoint
app.get('/health', (_, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  bots: bots.size,
  memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) + 'MB',
  activeConnections
}));

// ══════════════════ YARDIMCI FONKSİYONLAR ══════════════════
function addLog(user, msg, type = 'info') {
  const entry = {
    user, msg, type,
    time: new Date().toLocaleTimeString('tr-TR', { hour12: false }),
    timestamp: Date.now()
  };
  logBuffer.push(entry);
  if (logBuffer.length > CONFIG.LOG_MAX) logBuffer.shift();
  io.emit('log', entry);
}

function broadcastBots() {
  io.emit('bot_list', Array.from(bots.keys()));
}

function getMemoryUsage() {
  return (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
}

// ══════════════════ PROXY SEÇİCİ ══════════════════
function pickRandomProxy() {
  try {
    if (!fs.existsSync(CONFIG.PROXY_FILE)) return null;
    const lines = fs.readFileSync(CONFIG.PROXY_FILE, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('socks5://') || l.startsWith('socks4://'));
    if (lines.length === 0) return null;
    const proxy = lines[Math.floor(Math.random() * lines.length)];
    new URL(proxy); // validate
    return proxy;
  } catch { return null; }
}

// ══════════════════ GELİŞMİŞ ANTİ-AFK ══════════════════
function scheduleAdvancedAntiAFK(botObj) {
  if (!botObj.antiAfk || !botObj.bot?.entity) return;
  const delay = CONFIG.ANTI_AFK_MIN_DELAY + Math.random() * (CONFIG.ANTI_AFK_MAX_DELAY - CONFIG.ANTI_AFK_MIN_DELAY);
  botObj._antiAfkTimer = setTimeout(() => {
    const b = botObj.bot;
    if (!b?.entity || !botObj.antiAfk) return;
    // Rastgele bakış açısı
    b.look(
      b.entity.yaw + (Math.random() - 0.5) * 0.8,
      Math.max(-0.8, Math.min(0.8, b.entity.pitch + (Math.random() - 0.5) * 0.3)),
      false
    );
    // Bazen küçük bir adım veya zıplama
    if (Math.random() < 0.3 && !botObj.spamInterval) {
      const actions = ['forward', 'back', 'left', 'right', 'jump'];
      const randomAction = actions[Math.floor(Math.random() * actions.length)];
      b.setControlState(randomAction, true);
      setTimeout(() => { if (b?.entity) b.setControlState(randomAction, false); }, 200 + Math.random() * 300);
    }
    scheduleAdvancedAntiAFK(botObj);
  }, delay);
}

// ══════════════════ BOT OLUŞTURUCU (Güçlü) ══════════════════
function createBot({ host, port, username, version }) {
  if (bots.size >= CONFIG.MAX_BOTS) {
    addLog('Sistem', `Limit dolu (${CONFIG.MAX_BOTS})`, 'error');
    return;
  }
  if (bots.has(username)) {
    addLog('Sistem', `${username} zaten bağlı`, 'error');
    return;
  }

  let reconnectAttempts = 0;
  let currentProxy = null;

  const connect = () => {
    const proxyUrl = pickRandomProxy();
    const agent = proxyUrl ? new SocksProxyAgent(proxyUrl, { timeout: 10000 }) : null;
    currentProxy = proxyUrl || 'doğrudan';

    addLog(username, `Bağlanıyor... ${proxyUrl ? 'Proxy: ' + proxyUrl.split('@').pop() : 'Doğrudan IP'}`, 'info');

    const bot = mineflayer.createBot({
      host,
      port: parseInt(port) || 25565,
      username,
      version: version === 'auto' ? false : version,
      auth: CONFIG.AUTH,
      agent,
      connectTimeout: CONFIG.CONNECT_TIMEOUT,
      viewDistance: CONFIG.VIEW_DISTANCE,
      keepAlive: CONFIG.KEEP_ALIVE,
      skipValidation: true
    });

    const botObj = {
      bot,
      username,
      antiAfk: true,
      spamInterval: null,
      spamMessages: [],
      manualStop: false,
      _antiAfkTimer: null,
      createdAt: Date.now()
    };

    // Temizlik
    if (bots.has(username)) {
      const old = bots.get(username);
      clearTimeout(old._antiAfkTimer);
      if (old.spamInterval) clearInterval(old.spamInterval);
      try { old.bot.end(); } catch {}
    }
    bots.set(username, botObj);
    broadcastBots();

    // --- Bot Olayları ---
    bot.once('login', () => {
      reconnectAttempts = 0;
      addLog(username, '✅ Giriş başarılı', 'success');
      broadcastBots();
    });

    bot.once('spawn', () => {
      addLog(username, '🌍 Spawn oldu', 'success');
      const mcData = mcDataLoader(bot.version);
      const moves = new Movements(bot, mcData);
      moves.allowSprinting = true;
      moves.allowParkour = true;
      bot.pathfinder.setMovements(moves);

      if (CONFIG.ENABLE_AUTO_EAT && bot.autoEat) {
        bot.autoEat.options = {
          priority: 'foodPoints',
          startAt: CONFIG.AUTO_EAT_START_AT,
          bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato']
        };
        bot.autoEat.enableAutoEat();
      }

      // Anti-AFK başlat
      botObj.antiAfk = true;
      scheduleAdvancedAntiAFK(botObj);
    });

    bot.on('error', (err) => {
      addLog(username, `Hata: ${err.message}`, 'error');
      if (!botObj.manualStop) tryReconnect();
    });

    bot.on('kicked', (reason) => {
      addLog(username, `Atıldı: ${reason}`, 'error');
      if (!botObj.manualStop) tryReconnect();
    });

    bot.on('end', () => {
      addLog(username, 'Bağlantı kapandı', 'warning');
      clearTimeout(botObj._antiAfkTimer);
      if (botObj.spamInterval) clearInterval(botObj.spamInterval);
      if (!botObj.manualStop) tryReconnect();
      else {
        bots.delete(username);
        broadcastBots();
      }
    });

    bot.on('chat', (sender, msg) => addLog(username, `💬 ${sender}: ${msg}`, 'chat'));
    bot.on('death', () => addLog(username, '💀 Öldü', 'error'));
    bot.on('message', (jsonMsg) => {
      const text = jsonMsg.toString();
      if (text && text.trim().length > 0 && !text.startsWith('{')) {
        addLog(username, text, 'system');
      }
    });

    // PvP
    if (CONFIG.ENABLE_PVP) {
      bot.on('entityHurt', (entity) => {
        if (entity === bot.entity && bot.pvp) {
          const attacker = bot.nearestEntity(e => 
            (e.type === 'player' || e.type === 'mob') && 
            e !== bot.entity &&
            bot.entity.position.distanceTo(e.position) < 5
          );
          if (attacker) {
            try {
              bot.pvp.attack(attacker);
              addLog(username, `⚔️ Savunma: ${attacker.name || attacker.username || 'yaratık'}`, 'warning');
            } catch {}
          }
        }
      });
    }

    // Plugin yükle
    try {
      bot.loadPlugin(pathfinder);
      bot.loadPlugin(autoEat);
      bot.loadPlugin(armorManager);
      bot.loadPlugin(pvp);
    } catch (e) {
      addLog(username, `Plugin hatası: ${e.message}`, 'error');
    }

    const tryReconnect = () => {
      if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
        addLog(username, 'Deneme limiti aşıldı, durduruldu', 'error');
        bots.delete(username);
        broadcastBots();
        return;
      }
      const delay = Math.min(CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), CONFIG.RECONNECT_MAX_DELAY);
      reconnectAttempts++;
      addLog(username, `${delay/1000}s sonra yeniden... (${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})`, 'warning');
      setTimeout(connect, delay);
    };
  };

  connect();
}

// ══════════════════ PERİYODİK VERİ AKIŞI ══════════════════
setInterval(() => {
  const data = {};
  for (const [name, obj] of bots) {
    const b = obj.bot;
    if (!b?.entity || !b.inventory) continue;
    const inv = b.inventory.slots.slice(0, 36).map((item, i) => item ? {
      slot: i, name: item.name, displayName: item.displayName, count: item.count
    } : null);
    data[name] = {
      health: Math.round(b.health * 10) / 10,
      food: Math.round(b.food * 10) / 10,
      position: { x: +b.entity.position.x.toFixed(1), y: +b.entity.position.y.toFixed(1), z: +b.entity.position.z.toFixed(1) },
      inventory: inv,
      antiAfk: obj.antiAfk,
      spamActive: !!obj.spamInterval,
      uptime: Math.floor((Date.now() - obj.createdAt) / 1000)
    };
  }
  io.emit('bots_data', data);
}, CONFIG.BOT_DATA_INTERVAL);

// Sistem durumu yayını (navbar için)
setInterval(() => {
  const memUsed = parseFloat(getMemoryUsage());
  io.emit('system_status', {
    ram: memUsed,
    totalRam: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(1),
    bots: bots.size,
    maxBots: CONFIG.MAX_BOTS,
    uptime: Math.floor(process.uptime()),
    connections: io.engine.clientsCount,
    health: memUsed > CONFIG.HEALTH_MEMORY_THRESHOLD ? 'warning' : 'good'
  });
}, CONFIG.SYSTEM_INFO_INTERVAL);

// ══════════════════ SOCKET.IO BAĞLANTI YÖNETİMİ ══════════════════
io.on('connection', (socket) => {
  activeConnections = io.engine.clientsCount;
  addLog('Sistem', `👤 Panel açıldı (${activeConnections} çevrimiçi)`, 'info');
  broadcastBots();
  socket.emit('log_history', logBuffer.slice(-50));

  // --- Bot bağla ---
  socket.on('bot_connect', (data) => {
    const { host, port, username, version } = data || {};
    if (!host || !port || !username) {
      return socket.emit('log', { user: 'Sistem', msg: 'Eksik bilgi!', type: 'error', time: new Date().toLocaleTimeString('tr-TR') });
    }
    createBot({ host, port, username, version: version || '1.20.1' });
  });

  // --- Bot kes ---
  socket.on('bot_kill', (username) => {
    const obj = bots.get(username);
    if (!obj) return;
    obj.manualStop = true;
    clearTimeout(obj._antiAfkTimer);
    if (obj.spamInterval) clearInterval(obj.spamInterval);
    try { obj.bot.end(); } catch {}
    bots.delete(username);
    broadcastBots();
    addLog('Sistem', `🛑 ${username} durduruldu`, 'info');
  });

  // --- Chat ---
  socket.on('chat_send', ({ username, message }) => {
    const obj = bots.get(username);
    if (obj?.bot && message) {
      obj.bot.chat(message.slice(0, 256));
      addLog(username, `📤 ${message}`, 'command');
    }
  });

  // --- Hareket ---
  socket.on('move', ({ username, direction, state }) => {
    const obj = bots.get(username);
    if (obj?.bot?.entity && ['forward','back','left','right','jump','sprint','sneak'].includes(direction)) {
      obj.bot.setControlState(direction, state);
    }
  });

  // --- Git ---
  socket.on('goto', ({ username, x, y, z }) => {
    const obj = bots.get(username);
    if (!obj?.bot?.entity) return;
    const ix = parseInt(x), iy = parseInt(y), iz = parseInt(z);
    if (isNaN(ix) || isNaN(iy) || isNaN(iz)) return;
    const goal = new GoalBlock(ix, Math.max(-64, Math.min(320, iy)), iz);
    obj.bot.pathfinder.setGoal(goal);
    addLog(username, `🎯 Gidiliyor: ${ix}, ${iy}, ${iz}`, 'info');
  });

  // --- Eşya at ---
  socket.on('drop_item', ({ username, slot }) => {
    const obj = bots.get(username);
    if (!obj?.bot?.inventory) return;
    const item = obj.bot.inventory.slots[slot];
    if (item) {
      obj.bot.tossStack(item);
      addLog(username, `🗑️ Atıldı: ${item.displayName} x${item.count}`, 'warning');
    }
  });

  // --- AntiAFK toggle ---
  socket.on('antiafk_toggle', ({ username, active }) => {
    const obj = bots.get(username);
    if (!obj) return;
    obj.antiAfk = active;
    clearTimeout(obj._antiAfkTimer);
    if (active) scheduleAdvancedAntiAFK(obj);
    addLog(username, active ? '🛡️ AntiAFK açık' : '🔓 AntiAFK kapalı', 'info');
  });

  // --- Spam başlat ---
  socket.on('spam_start', ({ username, messages, interval }) => {
    const obj = bots.get(username);
    if (!obj?.bot) return;
    if (!messages?.length) return;
    if (obj.spamInterval) clearInterval(obj.spamInterval);
    const delay = Math.max(CONFIG.SPAM_MIN_INTERVAL, parseInt(interval) || CONFIG.SPAM_DEFAULT_INTERVAL);
    let idx = 0;
    obj.spamMessages = [...messages];
    obj.spamInterval = setInterval(() => {
      if (!obj.bot?.entity) {
        clearInterval(obj.spamInterval);
        obj.spamInterval = null;
        return;
      }
      const msg = obj.spamMessages[idx % obj.spamMessages.length];
      idx++;
      try { obj.bot.chat(msg); } catch {}
      addLog(username, `📨 [SPAM] ${msg}`, 'command');
    }, delay);
    addLog(username, `🚀 Spam başladı (${messages.length} mesaj, ${delay}ms)`, 'success');
  });

  // --- Spam durdur ---
  socket.on('spam_stop', (username) => {
    const obj = bots.get(username);
    if (!obj?.spamInterval) return;
    clearInterval(obj.spamInterval);
    obj.spamInterval = null;
    addLog(username, '⏹️ Spam durdu', 'warning');
  });

  // --- Sistem komutları (panel içi) ---
  socket.on('get_system_info', () => {
    socket.emit('system_status', {
      ram: parseFloat(getMemoryUsage()),
      totalRam: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(1),
      bots: bots.size,
      maxBots: CONFIG.MAX_BOTS,
      uptime: Math.floor(process.uptime()),
      connections: io.engine.clientsCount
    });
  });

  socket.on('disconnect', () => {
    activeConnections = io.engine.clientsCount;
    addLog('Sistem', `👋 Panel kapandı (${activeConnections} çevrimiçi)`, 'info');
  });
});

// ══════════════════ SUNUCU BAŞLAT ══════════════════
server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`⚡ GOD MODE v4.0 | Port: ${CONFIG.PORT} | Max Bot: ${CONFIG.MAX_BOTS}`);
  console.log(`Başlangıç Bellek: ${getMemoryUsage()}MB`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  for (const [name, obj] of bots) {
    obj.manualStop = true;
    try { obj.bot.end(); } catch {}
  }
  server.close();
});