const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const autoEat = require('mineflayer-auto-eat').plugin;
const armorManager = require('mineflayer-armor-manager');
const pvp = require('mineflayer-pvp').plugin;
const mcDataLoader = require('minecraft-data');

// ─── ÇÖKME KORUMASI ───
process.on('uncaughtException', (err) => {
  console.error('[ÇÖKME KORUMASI] Yakalanmamış İstisna:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ÇÖKME KORUMASI] İşlenmeyen Reddetme:', promise, 'Sebep:', reason);
});

// ─── EXPRESS & SOCKET.IO KURULUMU ───
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket'],
  allowUpgrades: false,
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static('.'));

// ─── DURUM YÖNETİMİ ───
const bots = new Map();

function emitLog(kullaniciAdi, mesaj, tur = 'bilgi') {
  io.emit('log', { kullaniciAdi, mesaj, tur, zaman: new Date().toLocaleTimeString('tr-TR') });
}

function emitBotList() {
  const liste = Array.from(bots.keys());
  io.emit('bot_listesi', liste);
}

// ─── ANTİ-AFK: Rastgele zamanlı doğal kamera hareketi ───
// Sunucu hile algılama sistemlerini tetiklememek için:
//  - Tamamen rastgele aralık (25-50 sn)
//  - Sadece bot.look() ile küçük yaw/pitch değişimi
//  - Hareket komutu GÖNDERILMEZ, sadece bakış açısı değişir
function scheduleAntiAfk(kullaniciAdi, botObj) {
  if (!botObj.antiAfkEnabled) return;
  const delay = 25000 + Math.floor(Math.random() * 25000); // 25-50 sn arası rastgele
  botObj.antiAfkTimeout = setTimeout(() => {
    const bot = botObj.bot;
    if (bot && bot.entity && botObj.antiAfkEnabled) {
      const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.35;
      const pitch = Math.max(-0.6, Math.min(0.6, bot.entity.pitch + (Math.random() - 0.5) * 0.18));
      bot.look(yaw, pitch, false);
      // Bazen (1/3 ihtimalle) tek adım ileri geri git
      if (Math.random() < 0.33 && !botObj.spamInterval) {
        bot.setControlState('forward', true);
        setTimeout(() => {
          if (bot && bot.entity) bot.setControlState('forward', false);
        }, 200 + Math.floor(Math.random() * 200));
      }
    }
    scheduleAntiAfk(kullaniciAdi, botObj); // bir sonraki anti-afk planla
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

// ─── BOT OLUŞTURUCU ───
function createBotInstance(ayarlar) {
  const { host, port, kullaniciAdi, surum } = ayarlar;

  const bot = mineflayer.createBot({
    host,
    port: parseInt(port),
    username: kullaniciAdi,
    version: surum,
    auth: 'offline',
    hideErrors: true
  });

  const botObj = {
    bot,
    yenidenBaglanmaZamani: null,
    manuelDurdur: false,
    ayarlar,
    antiAfkEnabled: true,
    antiAfkTimeout: null,
    spamInterval: null,
    spamMesajlar: [],
    spamAralik: 3000
  };
  bots.set(kullaniciAdi, botObj);
  emitBotList();

  // Eklentileri Yükle
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(autoEat);
  bot.loadPlugin(armorManager);
  bot.loadPlugin(pvp);

  // ─── Spawn Olayı ───
  bot.once('spawn', () => {
    const mcData = mcDataLoader(bot.version);
    const defaultMove = new Movements(bot, mcData);
    defaultMove.allowSprinting = true;
    defaultMove.allowParkour = true;
    bot.pathfinder.setMovements(defaultMove);

    if (bot.autoEat) {
      bot.autoEat.options = {
        priority: 'foodPoints',
        startAt: 14,
        bannedFood: []
      };
      bot.autoEat.enable();
    }

    // Anti-AFK otomatik başlat
    startAntiAfk(kullaniciAdi, botObj);
    emitLog(kullaniciAdi, 'Anti-AFK sistemi aktif edildi.', 'basari');
  });

  // ─── Hayatta Kalma: Oto-PVP ───
  bot.on('entityHurt', (entity) => {
    if (entity === bot.entity) {
      const saldiran = bot.nearestEntity(e => e.type === 'player' && e !== bot.entity);
      if (saldiran) {
        bot.pvp.attack(saldiran);
        emitLog(kullaniciAdi, `${saldiran.name || saldiran.username || 'Düşman'}'a karşılık veriliyor!`, 'uyari');
      }
    }
  });

  // ─── Olay Kayıtları ───
  bot.on('login', () => {
    emitLog(kullaniciAdi, `${host}:${port} adresine giriş yapıldı.`, 'basari');
  });

  bot.on('spawn', () => {
    emitLog(kullaniciAdi, 'Dünyaya spawn olundu.', 'basari');
  });

  bot.on('chat', (oyuncu, mesaj) => {
    emitLog(kullaniciAdi, `[Sohbet] ${oyuncu}: ${mesaj}`, 'sohbet');
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString();
    if (text && text.trim().length > 0) {
      emitLog(kullaniciAdi, text, 'sistem');
    }
  });

  bot.on('death', () => {
    emitLog(kullaniciAdi, 'Bot öldü!', 'hata');
  });

  bot.on('kicked', (reason) => {
    emitLog(kullaniciAdi, `Sunucudan atıldı: ${reason}`, 'hata');
  });

  bot.on('error', (err) => {
    emitLog(kullaniciAdi, `Hata: ${err.message}`, 'hata');
  });

  // ─── Otomatik Yeniden Bağlanma ───
  bot.on('end', () => {
    emitLog(kullaniciAdi, 'Sunucu bağlantısı kesildi.', 'uyari');
    // Temizlik
    stopAntiAfk(botObj);
    if (botObj.spamInterval) {
      clearInterval(botObj.spamInterval);
      botObj.spamInterval = null;
    }
    if (!botObj.manuelDurdur) {
      emitLog(kullaniciAdi, '10 saniye sonra otomatik yeniden bağlanılacak...', 'uyari');
      botObj.yenidenBaglanmaZamani = setTimeout(() => {
        if (bots.has(kullaniciAdi) && bots.get(kullaniciAdi) === botObj) {
          bots.delete(kullaniciAdi);
          createBotInstance(ayarlar);
        }
      }, 10000);
    } else {
      bots.delete(kullaniciAdi);
      emitBotList();
    }
  });

  return botObj;
}

// ─── VERİ AKIŞI: 1 SANİYE ARALIKLA ───
setInterval(() => {
  const payload = {};
  for (const [kullaniciAdi, botObj] of bots) {
    const bot = botObj.bot;
    if (bot && bot.entity) {
      const envanter = bot.inventory.slots.map((esya, index) => {
        if (!esya) return null;
        return {
          slot: index,
          name: esya.name,
          displayName: esya.displayName,
          count: esya.count
        };
      });
      payload[kullaniciAdi] = {
        saglik: bot.health,
        aclik: bot.food,
        pozisyon: {
          x: bot.entity.position.x.toFixed(2),
          y: bot.entity.position.y.toFixed(2),
          z: bot.entity.position.z.toFixed(2)
        },
        envanter,
        antiAfk: botObj.antiAfkEnabled,
        spamAktif: !!botObj.spamInterval
      };
    }
  }
  io.emit('bot_verileri', payload);
}, 1000);

// ─── SOCKET.IO OLAYLARI ───
io.on('connection', (socket) => {
  emitLog('Sistem', 'God Mode operatörü bağlandı.', 'bilgi');
  emitBotList();

  // Bot Bağlan
  socket.on('bot_baglan', (ayarlar) => {
    const { host, port, kullaniciAdi, surum } = ayarlar;
    if (!host || !port || !kullaniciAdi) {
      socket.emit('log', { kullaniciAdi: 'Sistem', mesaj: 'Bağlantı bilgileri eksik.', tur: 'hata' });
      return;
    }
    if (bots.has(kullaniciAdi)) {
      socket.emit('log', { kullaniciAdi: 'Sistem', mesaj: `${kullaniciAdi} isimli bot zaten aktif.`, tur: 'hata' });
      return;
    }
    createBotInstance({ host, port, kullaniciAdi, surum });
    emitLog('Sistem', `${kullaniciAdi} botu başlatılıyor...`, 'bilgi');
  });

  // Bot Kes
  socket.on('bot_kes', (kullaniciAdi) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj) {
      socket.emit('log', { kullaniciAdi: 'Sistem', mesaj: `${kullaniciAdi} botu bulunamadı.`, tur: 'hata' });
      return;
    }
    botObj.manuelDurdur = true;
    stopAntiAfk(botObj);
    if (botObj.spamInterval) { clearInterval(botObj.spamInterval); botObj.spamInterval = null; }
    if (botObj.yenidenBaglanmaZamani) { clearTimeout(botObj.yenidenBaglanmaZamani); botObj.yenidenBaglanmaZamani = null; }
    try { botObj.bot.end(); } catch (e) {}
    bots.delete(kullaniciAdi);
    emitBotList();
    emitLog('Sistem', `${kullaniciAdi} botu operatör tarafından sonlandırıldı.`, 'bilgi');
  });

  // Sohbet / Komut Gönder
  socket.on('chat_gonder', ({ kullaniciAdi, mesaj }) => {
    const botObj = bots.get(kullaniciAdi);
    if (botObj && botObj.bot) {
      botObj.bot.chat(mesaj);
      emitLog(kullaniciAdi, `> ${mesaj}`, 'komut');
    }
  });

  // Hareket Kontrolü
  socket.on('hareket', ({ kullaniciAdi, yon, durum }) => {
    const botObj = bots.get(kullaniciAdi);
    if (botObj && botObj.bot && botObj.bot.entity) {
      const gecerliYonler = ['forward', 'back', 'left', 'right', 'jump'];
      if (gecerliYonler.includes(yon)) {
        botObj.bot.setControlState(yon, durum);
      }
    }
  });

  // Koordinata Git
  socket.on('git', ({ kullaniciAdi, x, y, z }) => {
    const botObj = bots.get(kullaniciAdi);
    if (botObj && botObj.bot && botObj.bot.entity) {
      const hedefX = parseInt(x);
      const hedefY = parseInt(y);
      const hedefZ = parseInt(z);
      if (isNaN(hedefX) || isNaN(hedefY) || isNaN(hedefZ)) {
        socket.emit('log', { kullaniciAdi: 'Sistem', mesaj: 'Geçersiz koordinatlar.', tur: 'hata' });
        return;
      }
      const goal = new GoalBlock(hedefX, hedefY, hedefZ);
      botObj.bot.pathfinder.setGoal(goal);
      emitLog(kullaniciAdi, `[${hedefX}, ${hedefY}, ${hedefZ}] koordinatlarına gidiliyor...`, 'bilgi');
    }
  });

  // Eşya At
  socket.on('esya_at', ({ kullaniciAdi, slot }) => {
    const botObj = bots.get(kullaniciAdi);
    if (botObj && botObj.bot) {
      const esya = botObj.bot.inventory.slots[slot];
      if (esya) {
        botObj.bot.tossStack(esya);
        emitLog(kullaniciAdi, `${esya.displayName} x${esya.count} yere atıldı.`, 'uyari');
      }
    }
  });

  // ─── ANTİ-AFK TOGGLE ───
  socket.on('antiafk_toggle', ({ kullaniciAdi, aktif }) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj) return;
    if (aktif) {
      startAntiAfk(kullaniciAdi, botObj);
      emitLog(kullaniciAdi, 'Anti-AFK sistemi açıldı.', 'basari');
    } else {
      stopAntiAfk(botObj);
      emitLog(kullaniciAdi, 'Anti-AFK sistemi kapatıldı.', 'uyari');
    }
  });

  // ─── SPAM BAŞLAT ───
  socket.on('spam_baslat', ({ kullaniciAdi, mesajlar, aralik }) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj || !botObj.bot) {
      socket.emit('log', { kullaniciAdi: 'Sistem', mesaj: 'Bot bulunamadı.', tur: 'hata' });
      return;
    }
    if (!mesajlar || mesajlar.length === 0) {
      socket.emit('log', { kullaniciAdi: 'Sistem', mesaj: 'En az 1 spam mesajı girin.', tur: 'hata' });
      return;
    }
    const gercekAralik = Math.max(500, parseInt(aralik) || 3000);
    if (botObj.spamInterval) clearInterval(botObj.spamInterval);
    let idx = 0;
    botObj.spamInterval = setInterval(() => {
      const mesaj = mesajlar[idx % mesajlar.length];
      idx++;
      try {
        botObj.bot.chat(mesaj);
        emitLog(kullaniciAdi, `[SPAM] ${mesaj}`, 'komut');
      } catch (e) {
        emitLog(kullaniciAdi, `Spam hatası: ${e.message}`, 'hata');
      }
    }, gercekAralik);
    emitLog(kullaniciAdi, `Spam başlatıldı. ${mesajlar.length} mesaj, ${gercekAralik}ms arayla.`, 'basari');
  });

  // ─── SPAM DURDUR ───
  socket.on('spam_durdur', ({ kullaniciAdi }) => {
    const botObj = bots.get(kullaniciAdi);
    if (!botObj) return;
    if (botObj.spamInterval) {
      clearInterval(botObj.spamInterval);
      botObj.spamInterval = null;
      emitLog(kullaniciAdi, 'Spam durduruldu.', 'uyari');
    }
  });

  socket.on('disconnect', () => {
    emitLog('Sistem', 'Operatör bağlantısı kesildi.', 'bilgi');
  });
});

// ─── SUNUCU BAŞLATMA ───
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`[GOD MODE] Sunucu çalışıyor: http://localhost:${PORT}`);
});
