// ═══════════════════════════════════════════════════════════
// GOD MODE - Minecraft Bot Yönetim Paneli v2.0
// Render.com & Production Optimizasyonlu
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs = require('fs');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const autoEat = require('mineflayer-auto-eat').plugin;
const armorManager = require('mineflayer-armor-manager');
const pvp = require('mineflayer-pvp').plugin;
const mcDataLoader = require('minecraft-data');

// ═══════════════════════════════════════════════════════════
// KONFİGÜRASYON
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  PORT: process.env.PORT || 10000,
  NODE_ENV: process.env.NODE_ENV || 'production',
  MAX_BOTS: process.env.MAX_BOTS || 50,
  CONNECTION_TIMEOUT: 15000,
  RECONNECT_DELAY: 5000,
  HEALTH_CHECK_INTERVAL: 30000,
  BOT_DATA_INTERVAL: 1000,
  MAX_RECONNECT_ATTEMPTS: 10,
  PROXY_FILE: path.join(__dirname, 'proxies.txt'),
  LOG_RETENTION: 1000 // Maksimum log satırı
};

// ═══════════════════════════════════════════════════════════
// ÇÖKME KORUMASI & ERROR HANDLING
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error('[KRİTİK HATA]', new Date().toISOString(), err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ASYNC HATA]', new Date().toISOString(), reason);
});

process.on('SIGTERM', () => {
  console.log('[KAPATMA] Sunucu düzgün şekilde kapatılıyor...');
  gracefulShutdown();
});

process.on('SIGINT', () => {
  console.log('[KAPATMA] CTRL+C algılandı, kapatılıyor...');
  gracefulShutdown();
  process.exit(0);
});

// ═══════════════════════════════════════════════════════════
// EXPRESS & SOCKET.IO KURULUMU (Render.com Optimizasyonlu)
// ═══════════════════════════════════════════════════════════
const app = express();
const server = http.createServer(app);

// Render.com proxy güveni için
app.set('trust proxy', 1);

const io = new Server(server, {
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  maxHttpBufferSize: 1e6, // 1MB
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // Render.com WebSocket optimizasyonu
  allowEIO3: true
});

// Static dosyaları serve et (Render.com için absolute path)
app.use(express.static(__dirname));

// Health check endpoint (Render.com için)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    bots: bots.size,
    memory: process.memoryUsage().heapUsed / 1024 / 1024,
    timestamp: new Date().toISOString()
  });
});

// Ana sayfa
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ═══════════════════════════════════════════════════════════
// VERİ YAPILARI & STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════
const bots = new Map();
const logBuffer = [];
let activeConnections = 0;

// ═══════════════════════════════════════════════════════════
// YARDIMCI FONKSİYONLAR
// ═══════════════════════════════════════════════════════════

/**
 * Merkezi log sistemi
 */
function emitLog(kullaniciAdi, mesaj, tur = 'bilgi') {
  const logEntry = {
    kullaniciAdi,
    mesaj,
    tur,
    zaman: new Date().toLocaleTimeString('tr-TR', { 
      timeZone: 'Europe/Istanbul',
      hour12: false 
    })
  };

  // Log buffer'a ekle
  logBuffer.push(logEntry);
  if (logBuffer.length > CONFIG.LOG_RETENTION) {
    logBuffer.shift();
  }

  // Tüm clientlara gönder
  io.emit('log', logEntry);
}

/**
 * Aktif bot listesini güncelle
 */
function emitBotList() {
  const liste = Array.from(bots.keys());
  io.emit('bot_listesi', liste);
}

/**
 * Proxy listesini oku ve valide et
 */
function getRandomProxy() {
  try {
    if (!fs.existsSync(CONFIG.PROXY_FILE)) {
      console.warn('[PROXY] proxies.txt bulunamadı, normal IP kullanılacak');
      return null;
    }

    const content = fs.readFileSync(CONFIG.PROXY_FILE, 'utf8');
    const proxyList = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && line.startsWith('socks5://'));

    if (proxyList.length === 0) {
      console.warn('[PROXY] Geçerli proxy bulunamadı');
      return null;
    }

    const randomIndex = Math.floor(Math.random() * proxyList.length);
    const selectedProxy = proxyList[randomIndex];

    // Proxy formatını doğrula
    try {
      new URL(selectedProxy);
      return selectedProxy;
    } catch {
      console.warn(`[PROXY] Geçersiz format: ${selectedProxy}`);
      return null;
    }
  } catch (err) {
    console.error('[PROXY] Okuma hatası:', err.message);
    return null;
  }
}

/**
 * Memory usage checker
 */
function checkMemoryUsage() {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  if (used > 400) { // 400MB üzeri uyarı
    console.warn(`[MEMORY] Yüksek kullanım: ${used.toFixed(2)}MB`);
    emitLog('Sistem', `⚠️ Yüksek bellek kullanımı: ${used.toFixed(2)}MB`, 'uyari');
  }
}

// ═══════════════════════════════════════════════════════════
// ANTİ-AFK SİSTEMİ (Gelişmiş)
// ═══════════════════════════════════════════════════════════
function scheduleAntiAfk(kullaniciAdi, botObj) {
  if (!botObj.antiAfkEnabled || !botObj.bot?.entity) return;

  const delay = 25000 + Math.floor(Math.random() * 35000); // 25-60 saniye
  botObj.antiAfkTimeout = setTimeout(() => {
    const bot = botObj.bot;
    if (!bot?.entity || !botObj.antiAfkEnabled) return;

    try {
      // Doğal kamera hareketi
      const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.45;
      const pitch = Math.max(-0.7, Math.min(0.7, bot.entity.pitch + (Math.random() - 0.5) * 0.2));
      bot.look(yaw, pitch, false);

      // Spam yoksa bazen küçük adım
      if (Math.random() < 0.25 && !botObj.spamInterval) {
        const directions = ['forward', 'back', 'left', 'right'];
        const randomDir = directions[Math.floor(Math.random() * directions.length)];
        bot.setControlState(randomDir, true);
        setTimeout(() => {
          if (bot?.entity) bot.setControlState(randomDir, false);
        }, 150 + Math.floor(Math.random() * 250));
      }
    } catch (err) {
      // Sessizce devam et
    }

    scheduleAntiAfk(kullaniciAdi, botObj);
  }, delay);
}

function startAntiAfk(kullaniciAdi, botObj) {
  if (botObj.antiAfkTimeout) clearTimeout(botObj.antiAfkTimeout);
  botObj.antiAfkEnabled = true;
  scheduleAntiAfk(kullaniciAdi, botObj);
}

function stopAntiAfk(botObj) {
  botObj.antiAfkEnabled = false;
  if (botObj.antiAfkTimeout) {
    clearTimeout(botObj.antiAfkTimeout);
    botObj.antiAfkTimeout = null;
  }
}

// ═══════════════════════════════════════════════════════════
// BOT OLUŞTURUCU (Production Ready)
// ═══════════════════════════════════════════════════════════
function createBotInstance(ayarlar) {
  const { host, port, kullaniciAdi, surum } = ayarlar;
  let reconnectAttempts = 0;

  function startBot() {
    // Bot limiti kontrolü
    if (bots.size >= CONFIG.MAX_BOTS) {
      emitLog('Sistem', `Maksimum bot sayısına ulaşıldı (${CONFIG.MAX_BOTS})`, 'hata');
      return null;
    }

    // Proxy seçimi
    const selectedProxy = getRandomProxy();
    let proxyAgent = null;

    if (selectedProxy) {
      try {
        proxyAgent = new SocksProxyAgent(selectedProxy, {
          timeout: 10000,
          keepAlive: true
        });
        emitLog(kullaniciAdi, `🔄 Proxy: ${selectedProxy.split('@').pop() || selectedProxy}`, 'bilgi');
      } catch (err) {
        emitLog(kullaniciAdi, `Proxy hatası, normal IP deneniyor...`, 'uyari');
      }
    } else {
      emitLog(kullaniciAdi, '🌐 Normal IP ile bağlanılıyor...', 'bilgi');
    }

    // Bot oluşturma
    const bot = mineflayer.createBot({
      host: host,
      port: parseInt(port) || 25565,
      username: kullaniciAdi,
      version: surum === 'otomatik' || !surum ? false : surum,
      auth: 'offline',
      hideErrors: false,
      agent: proxyAgent,
      connectTimeout: CONFIG.CONNECTION_TIMEOUT,
      checkTimeoutInterval: 30000,
      keepAlive: true,
      viewDistance: 'tiny', // RAM optimizasyonu
      skipValidation: true
    });

    // Bot objesi oluştur
    const botObj = {
      bot,
      yenidenBaglanmaZamani: null,
      manuelDurdur: false,
      ayarlar,
      antiAfkEnabled: true,
      antiAfkTimeout: null,
      spamInterval: null,
      spamMesajlar: [],
      spamAralik: 3000,
      createdAt: Date.now(),
      reconnectAttempts: 0
    };

    // Eski bot varsa temizle
    if (bots.has(kullaniciAdi)) {
      const eskiBot = bots.get(kullaniciAdi);
      cleanupBot(eskiBot);
    }

    bots.set(kullaniciAdi, botObj);
    activeConnections++;

    // ═══════════════════════════════════════════════════════
    // BOT EVENT HANDLERS
    // ═══════════════════════════════════════════════════════

    bot.once('login', () => {
      reconnectAttempts = 0;
      botObj.reconnectAttempts = 0;
      emitLog(kullaniciAdi, '✅ Sunucuya başarıyla giriş yapıldı!', 'basari');
      emitBotList();
    });

    bot.once('spawn', () => {
      emitLog(kullaniciAdi, '🌍 Bot dünyaya spawn oldu.', 'basari');

      try {
        // Pathfinder kurulumu
        const mcData = mcDataLoader(bot.version);
        const movements = new Movements(bot, mcData);
        movements.allowSprinting = true;
        movements.allowParkour = true;
        movements.canDig = false;
        movements.maxDropDown = 3;
        bot.pathfinder.setMovements(movements);

        // AutoEat kurulumu
        if (bot.autoEat) {
          bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato']
          };
          bot.autoEat.enableAutoEat();
        }

        // Anti-AFK başlat
        startAntiAfk(kullaniciAdi, botObj);
        emitLog(kullaniciAdi, '🛡️ Anti-AFK koruması aktif', 'basari');
      } catch (err) {
        emitLog(kullaniciAdi, `Spawn kurulum hatası: ${err.message}`, 'hata');
      }
    });

    bot.on('error', (err) => {
      console.error(`[${kullaniciAdi}] Hata:`, err.message);
      emitLog(kullaniciAdi, `⚠️ Hata: ${err.message}`, 'hata');

      if (!botObj.manuelDurdur && reconnectAttempts < CONFIG.MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        botObj.reconnectAttempts = reconnectAttempts;
        emitLog(kullaniciAdi, `🔄 Yeniden bağlanılıyor... (Deneme ${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})`, 'uyari');
        
        try { bot.quit(); } catch (e) {}
        
        setTimeout(() => {
          if (bots.has(kullaniciAdi)) {
            startBot();
          }
        }, CONFIG.RECONNECT_DELAY * reconnectAttempts); // Exponential backoff
      } else if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
        emitLog(kullaniciAdi, '❌ Maksimum bağlanma denemesi aşıldı, bot durduruldu', 'hata');
        cleanupBot(botObj);
        bots.delete(kullaniciAdi);
        emitBotList();
      }
    });

    bot.on('kicked', (reason) => {
      const reasonText = typeof reason === 'string' ? reason : JSON.stringify(reason);
      emitLog(kullaniciAdi, `👢 Sunucudan atıldı: ${reasonText}`, 'hata');
      
      if (!botObj.manuelDurdur) {
        setTimeout(() => {
          if (bots.has(kullaniciAdi)) {
            startBot();
          }
        }, CONFIG.RECONNECT_DELAY);
      }
    });

    bot.on('end', (reason) => {
      emitLog(kullaniciAdi, `🔌 Bağlantı kesildi: ${reason || 'Bilinmeyen sebep'}`, 'uyari');
      
      cleanupBot(botObj);

      if (!botObj.manuelDurdur && reconnectAttempts < CONFIG.MAX_RECONNECT_ATTEMPTS) {
        emitLog(kullaniciAdi, `🔄 ${CONFIG.RECONNECT_DELAY / 1000}s sonra yeniden bağlanılacak...`, 'uyari');
        
        botObj.yenidenBaglanmaZamani = setTimeout(() => {
          if (bots.has(kullaniciAdi) && !botObj.manuelDurdur) {
            startBot();
          }
        }, CONFIG.RECONNECT_DELAY);
      } else if (botObj.manuelDurdur) {
        bots.delete(kullaniciAdi);
        emitBotList();
        activeConnections--;
      }
    });

    bot.on('chat', (oyuncu, mesaj) => {
      if (mesaj && mesaj.trim()) {
        emitLog(kullaniciAdi, `💬 ${oyuncu}: ${mesaj}`, 'sohbet');
      }
    });

    bot.on('message', (jsonMsg) => {
      const text = jsonMsg.toString();
      if (text && text.trim().length > 0 && !text.startsWith('{')) {
        emitLog(kullaniciAdi, text, 'sistem');
      }
    });

    bot.on('death', () => {
      emitLog(kullaniciAdi, '💀 Bot öldü!', 'hata');
    });

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
            emitLog(kullaniciAdi, `⚔️ ${attacker.name || attacker.username || 'Saldırgan'}'a karşı savunma!`, 'uyari');
          } catch (err) {
            // PVP hatası sessizce geç
          }
        }
      }
    });

    // Plugin yükleme
    try {
      bot.loadPlugin(pathfinder);
      bot.loadPlugin(autoEat);
      bot.loadPlugin(armorManager);
      bot.loadPlugin(pvp);
    } catch (err) {
      emitLog(kullaniciAdi, `Plugin yükleme hatası: ${err.message}`, 'hata');
    }

    return botObj;
  }

  return startBot();
}

/**
 * Bot temizlik fonksiyonu
 */
function cleanupBot(botObj) {
  stopAntiAfk(botObj);
  
  if (botObj.spamInterval) {
    clearInterval(botObj.spamInterval);
    botObj.spamInterval = null;
  }
  
  if (botObj.yenidenBaglanmaZamani) {
    clearTimeout(botObj.yenidenBaglanmaZamani);
    botObj.yenidenBaglanmaZamani = null;
  }

  // Hareket kontrollerini sıfırla
  if (botObj.bot?.entity) {
    try {
      ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].forEach(control => {
        botObj.bot.setControlState(control, false);
      });
    } catch (e) {}
  }
}

/**
 * Graceful shutdown
 */
function gracefulShutdown() {
  console.log('[KAPATMA] Tüm botlar durduruluyor...');
  
  for (const [kullaniciAdi, botObj] of bots) {
    botObj.manuelDurdur = true;
    cleanupBot(botObj);
    try { botObj.bot?.quit(); } catch (e) {}
    try { botObj.bot?.end(); } catch (e) {}
  }
  
  bots.clear();
  console.log('[KAPATMA] Tüm botlar temizlendi');
}

// ═══════════════════════════════════════════════════════════
// PERİYODİK İŞLEMLER
// ═══════════════════════════════════════════════════════════

// Bot verilerini gönder (1 saniyede bir)
setInterval(() => {
  const payload = {};
  
  for (const [kullaniciAdi, botObj] of bots) {
    const bot = botObj.bot;
    if (bot?.entity && bot?.inventory) {
      try {
        const envanter = bot.inventory.slots
          .slice(0, 36) // Sadece ana envanter
          .map((esya, index) => {
            if (!esya) return null;
            return {
              slot: index,
              name: esya.name,
              displayName: esya.displayName || esya.name,
              count: esya.count || 1
            };
          });

        payload[kullaniciAdi] = {
          saglik: Math.round(bot.health * 10) / 10,
          aclik: Math.round(bot.food * 10) / 10,
          pozisyon: {
            x: bot.entity.position.x.toFixed(1),
            y: bot.entity.position.y.toFixed(1),
            z: bot.entity.position.z.toFixed(1)
          },
          envanter,
          antiAfk: botObj.antiAfkEnabled,
          spamAktif: !!botObj.spamInterval
        };
      } catch (err) {
        // Sessizce geç
      }
    }
  }

  if (Object.keys(payload).length > 0) {
    io.emit('bot_verileri', payload);
  }
}, CONFIG.BOT_DATA_INTERVAL);

// Memory check (30 saniyede bir)
setInterval(checkMemoryUsage, CONFIG.HEALTH_CHECK_INTERVAL);

// ═══════════════════════════════════════════════════════════
// SOCKET.IO EVENT HANDLERS
// ═══════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(`[BAĞLANTI] Yeni client: ${clientIP}`);
  
  emitLog('Sistem', `👤 Operatör bağlandı (${activeConnections} aktif)`, 'bilgi');
  emitBotList();

  // Son 50 log'u yeni client'a gönder
  const recentLogs = logBuffer.slice(-50);
  recentLogs.forEach(log => {
    socket.emit('log', log);
  });

  // ═══════════════════════════════════════════════════
  // Bot Bağlan
  // ═══════════════════════════════════════════════════
  socket.on('bot_baglan', (ayarlar) => {
    const { host, port, kullaniciAdi, surum } = ayarlar || {};

    // Validasyon
    if (!host || !port || !kullaniciAdi) {
      socket.emit('log', { 
        kullaniciAdi: 'Sistem', 
        mesaj: '❌ Tüm alanlar zorunludur: IP, Port, Kullanıcı Adı', 
        tur: 'hata',
        zaman: new Date().toLocaleTimeString('tr-TR')
      });
      return;
    }

    if (bots.has(kullaniciAdi)) {
      socket.emit('log', { 
        kullaniciAdi: 'Sistem', 
        mesaj: `❌ "${kullaniciAdi}" zaten aktif!`, 
        tur: 'hata',
        zaman: new Date().toLocaleTimeString('tr-TR')
      });
      return;
    }

    if (bots.size >= CONFIG.MAX_BOTS) {
      socket.emit('log', { 
        kullaniciAdi: 'Sistem', 
        mesaj: `❌ Maksimum bot limitine ulaşıldı (${CONFIG.MAX_BOTS})`, 
        tur: 'hata',
        zaman: new Date().toLocaleTimeString('tr-TR')
      });
      return;
    }

    // Host validasyonu
    const hostRegex = /^[a-zA-Z0-9.-]+$/;
    if (!hostRegex.test(host)) {
      socket.emit('log', { 
        kullaniciAdi: 'Sistem', 
        mesaj: '❌ Geçersiz sunucu adresi!', 
        tur: 'hata',
        zaman: new Date().toLocaleTimeString('tr-TR')
      });
      return;
    }

    createBotInstance({ host, port, kullaniciAdi, surum: surum || '1.20.1' });
    emitLog('Sistem', `🤖 "${kullaniciAdi}" botu başlatılıyor...`, 'bilgi');
  });

  // ═══════════════════════════════════════════════════
  // Bot Sonlandır
  // ═══════════════════════════════════════════════════
  socket.on('bot_kes', (kullaniciAdi) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj) {
      socket.emit('log', { 
        kullaniciAdi: 'Sistem', 
        mesaj: `❌ "${kullaniciAdi}" bulunamadı`, 
        tur: 'hata',
        zaman: new Date().toLocaleTimeString('tr-TR')
      });
      return;
    }

    botObj.manuelDurdur = true;
    cleanupBot(botObj);
    
    try { botObj.bot?.quit(); } catch (e) {}
    try { botObj.bot?.end(); } catch (e) {}
    
    bots.delete(kullaniciAdi);
    activeConnections--;
    emitBotList();
    emitLog('Sistem', `🛑 "${kullaniciAdi}" botu sonlandırıldı`, 'bilgi');
  });

  // ═══════════════════════════════════════════════════
  // Chat / Komut Gönder
  // ═══════════════════════════════════════════════════
  socket.on('chat_gonder', ({ kullaniciAdi, mesaj }) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj?.bot) return;

    if (!mesaj || mesaj.trim().length === 0) return;
    if (mesaj.length > 256) {
      emitLog(kullaniciAdi, '⚠️ Mesaj çok uzun (max 256 karakter)', 'uyari');
      return;
    }

    try {
      botObj.bot.chat(mesaj.trim());
      emitLog(kullaniciAdi, `💬 Sen: ${mesaj.trim()}`, 'komut');
    } catch (err) {
      emitLog(kullaniciAdi, `Mesaj gönderme hatası: ${err.message}`, 'hata');
    }
  });

  // ═══════════════════════════════════════════════════
  // Hareket Kontrolü
  // ═══════════════════════════════════════════════════
  socket.on('hareket', ({ kullaniciAdi, yon, durum }) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj?.bot?.entity) return;

    const gecerliYonler = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
    if (gecerliYonler.includes(yon)) {
      try {
        botObj.bot.setControlState(yon, durum);
      } catch (err) {
        // Sessizce geç
      }
    }
  });

  // ═══════════════════════════════════════════════════
  // Koordinata Git
  // ═══════════════════════════════════════════════════
  socket.on('git', ({ kullaniciAdi, x, y, z }) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj?.bot?.entity) return;

    const hedefX = parseInt(x);
    const hedefY = parseInt(y);
    const hedefZ = parseInt(z);

    if (isNaN(hedefX) || isNaN(hedefY) || isNaN(hedefZ)) {
      socket.emit('log', { 
        kullaniciAdi: 'Sistem', 
        mesaj: '❌ Geçersiz koordinatlar!', 
        tur: 'hata',
        zaman: new Date().toLocaleTimeString('tr-TR')
      });
      return;
    }

    // Y koordinatı için güvenlik kontrolü
    const safeY = Math.max(-64, Math.min(320, hedefY));

    try {
      const goal = new GoalBlock(hedefX, safeY, hedefZ);
      botObj.bot.pathfinder.setGoal(goal);
      emitLog(kullaniciAdi, `🎯 [${hedefX}, ${safeY}, ${hedefZ}] konumuna gidiliyor...`, 'bilgi');
    } catch (err) {
      emitLog(kullaniciAdi, `Navigasyon hatası: ${err.message}`, 'hata');
    }
  });

  // ═══════════════════════════════════════════════════
  // Eşya At
  // ═══════════════════════════════════════════════════
  socket.on('esya_at', ({ kullaniciAdi, slot }) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj?.bot?.inventory) return;

    try {
      const esya = botObj.bot.inventory.slots[slot];
      if (esya) {
        botObj.bot.tossStack(esya);
        emitLog(kullaniciAdi, `🗑️ ${esya.displayName || esya.name} x${esya.count} atıldı`, 'uyari');
      }
    } catch (err) {
      emitLog(kullaniciAdi, `Eşya atma hatası: ${err.message}`, 'hata');
    }
  });

  // ═══════════════════════════════════════════════════
  // Anti-AFK Toggle
  // ═══════════════════════════════════════════════════
  socket.on('antiafk_toggle', ({ kullaniciAdi, aktif }) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj) return;

    if (aktif) {
      startAntiAfk(kullaniciAdi, botObj);
      emitLog(kullaniciAdi, '🛡️ Anti-AFK açıldı', 'basari');
    } else {
      stopAntiAfk(botObj);
      emitLog(kullaniciAdi, '🔓 Anti-AFK kapatıldı', 'uyari');
    }
  });

  // ═══════════════════════════════════════════════════
  // Spam Başlat
  // ═══════════════════════════════════════════════════
  socket.on('spam_baslat', ({ kullaniciAdi, mesajlar, aralik }) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj?.bot) {
      socket.emit('log', { 
        kullaniciAdi: 'Sistem', 
        mesaj: '❌ Bot bulunamadı', 
        tur: 'hata',
        zaman: new Date().toLocaleTimeString('tr-TR')
      });
      return;
    }

    if (!mesajlar || mesajlar.length === 0) {
      socket.emit('log', { 
        kullaniciAdi: 'Sistem', 
        mesaj: '❌ En az 1 mesaj ekleyin', 
        tur: 'hata',
        zaman: new Date().toLocaleTimeString('tr-TR')
      });
      return;
    }

    const gercekAralik = Math.max(500, parseInt(aralik) || 3000);
    
    // Eski spam varsa durdur
    if (botObj.spamInterval) clearInterval(botObj.spamInterval);
    
    let idx = 0;
    botObj.spamInterval = setInterval(() => {
      if (!botObj.bot?.entity) {
        clearInterval(botObj.spamInterval);
        botObj.spamInterval = null;
        return;
      }

      const mesaj = mesajlar[idx % mesajlar.length];
      idx++;
      
      try {
        botObj.bot.chat(mesaj);
        emitLog(kullaniciAdi, `📨 [SPAM] ${mesaj}`, 'komut');
      } catch (err) {
        emitLog(kullaniciAdi, `Spam hatası: ${err.message}`, 'hata');
      }
    }, gercekAralik);

    emitLog(kullaniciAdi, `🚀 Spam başladı (${mesajlar.length} mesaj, ${gercekAralik}ms)`, 'basari');
  });

  // ═══════════════════════════════════════════════════
  // Spam Durdur
  // ═══════════════════════════════════════════════════
  socket.on('spam_durdur', ({ kullaniciAdi }) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj) return;

    if (botObj.spamInterval) {
      clearInterval(botObj.spamInterval);
      botObj.spamInterval = null;
      emitLog(kullaniciAdi, '⏹️ Spam durduruldu', 'uyari');
    }
  });

  // ═══════════════════════════════════════════════════
  // Client Disconnect
  // ═══════════════════════════════════════════════════
  socket.on('disconnect', (reason) => {
    console.log(`[BAĞLANTI] Client ayrıldı: ${clientIP} (${reason})`);
    emitLog('Sistem', `👋 Operatör ayrıldı (${activeConnections} aktif)`, 'bilgi');
  });
});

// ═══════════════════════════════════════════════════════════
// SUNUCU BAŞLATMA
// ═══════════════════════════════════════════════════════════
server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('═'.repeat(50));
  console.log('⚡ GOD MODE - Minecraft Bot Yönetim Paneli');
  console.log('═'.repeat(50));
  console.log(`📡 Port: ${CONFIG.PORT}`);
  console.log(`🌍 Ortam: ${CONFIG.NODE_ENV}`);
  console.log(`🤖 Max Bot: ${CONFIG.MAX_BOTS}`);
  console.log(`💾 Bellek: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`);
  console.log(`⏰ Başlangıç: ${new Date().toLocaleString('tr-TR')}`);
  console.log('═'.repeat(50));
  console.log('✅ Sunucu hazır, bağlantı bekleniyor...');
});

// Render.com için export
module.exports = app;