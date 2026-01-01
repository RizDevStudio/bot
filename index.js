// index.js - WhatsApp Bot Absensi SMK N 4 Bandar Lampung
// Fitur: Auto-scan pesan ABSENSI yang belum dibalas (setiap 15 menit)

const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ===== KONFIGURASI =====
const API_URL = process.env.API_URL || 'http://localhost:8000/api/parents';
const API_SECRET = process.env.API_SECRET || 'rahasia_kamu';

const authFolder = path.join(__dirname, 'baileys_auth');
if (!fs.existsSync(authFolder)) {
  fs.mkdirSync(authFolder, { recursive: true });
}

// ===== STATE PERSISTEN =====
const contactedUsers = new Set();
const contactedUsersFile = path.join(__dirname, 'contacted_users.json');

const processedMessageIds = new Set();
const processedMessageIdsFile = path.join(__dirname, 'processed_message_ids.json');

function loadContactedUsers() {
  try {
    if (fs.existsSync(contactedUsersFile)) {
      const data = fs.readFileSync(contactedUsersFile, 'utf8');
      const users = JSON.parse(data);
      users.forEach(user => contactedUsers.add(user));
      console.log(`📋 Loaded ${contactedUsers.size} contacted users`);
    }
  } catch (err) {
    console.log('⚠️ Could not load contacted users:', err.message);
  }
}

function saveContactedUsers() {
  try {
    fs.writeFileSync(contactedUsersFile, JSON.stringify([...contactedUsers]), 'utf8');
  } catch (err) {
    console.error('⚠️ Could not save contacted users:', err.message);
  }
}

function loadProcessedMessageIds() {
  try {
    if (fs.existsSync(processedMessageIdsFile)) {
      const data = fs.readFileSync(processedMessageIdsFile, 'utf8');
      const ids = JSON.parse(data);
      ids.forEach(id => processedMessageIds.add(id));
      console.log(`✅ Loaded ${processedMessageIds.size} processed message IDs`);
    }
  } catch (err) {
    console.log('⚠️ Could not load processed message IDs:', err.message);
  }
}

function saveProcessedMessageIds() {
  try {
    fs.writeFileSync(processedMessageIdsFile, JSON.stringify([...processedMessageIds]), 'utf8');
  } catch (err) {
    console.error('⚠️ Could not save processed message IDs:', err.message);
  }
}

// Auto-save state
setInterval(() => {
  saveContactedUsers();
  saveProcessedMessageIds();
}, 5 * 60 * 1000);

// ===== ANTRIAN PESAN =====
class MessageQueue {
  constructor(minDelay = 15000, maxDelay = 25000) {
    this.queue = [];
    this.processing = false;
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.lastSendTime = 0;
  }

  async add(sock, jid, message) {
    return new Promise((resolve, reject) => {
      this.queue.push({ sock, jid, message, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const timeSinceLastSend = now - this.lastSendTime;
      const randomDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;

      if (timeSinceLastSend < randomDelay) {
        const waitTime = randomDelay - timeSinceLastSend;
        console.log(`   ⏳ Menunggu ${Math.ceil(waitTime / 1000)}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      const item = this.queue.shift();
      try {
        await item.sock.sendMessage(item.jid, item.message);
        this.lastSendTime = Date.now();
        item.resolve();
        console.log(`   ✓ Pesan terkirim (queue: ${this.queue.length})`);
      } catch (err) {
        console.error(`   ✗ Gagal kirim: ${err.message}`);
        item.reject(err);
      }

      if (this.queue.length > 0) {
        const extraDelay = Math.floor(Math.random() * 2000) + 2000;
        await new Promise(resolve => setTimeout(resolve, extraDelay));
      }
    }
    this.processing = false;
  }

  getQueueSize() {
    return this.queue.length;
  }
}

const messageQueue = new MessageQueue(15000, 25000);

// ===== UTILITAS =====
function validatePhoneNumber(phone) {
  const cleaned = phone.replace(/[\s\-\+]/g, '');
  if (!/^\d{10,15}$/.test(cleaned)) return { valid: false, error: 'Nomor HP harus 10-15 digit angka' };
  if (!cleaned.startsWith('62') && !cleaned.startsWith('0')) return { valid: false, error: 'Nomor HP harus diawali 62 atau 0' };
  let normalized = cleaned;
  if (normalized.startsWith('0')) normalized = '62' + normalized.substring(1);
  return { valid: true, phone: normalized };
}

function validateNISN(nisn) {
  const cleaned = nisn.trim();
  if (cleaned.length < 5) return { valid: false, error: 'NISN minimal 5 digit' };
  if (!/^\d+$/.test(cleaned)) return { valid: false, error: 'NISN harus berupa angka' };
  return { valid: true, nisn: cleaned };
}

function validateName(name) {
  const cleaned = name.trim();
  if (cleaned.length < 3) return { valid: false, error: 'Nama minimal 3 karakter' };
  if (cleaned.length > 100) return { valid: false, error: 'Nama maksimal 100 karakter' };
  return { valid: true, name: cleaned };
}

function isPersonalChat(jid) {
  return jid && !jid.includes('@g.us') && !jid.includes('@broadcast') && !jid.includes('@newsletter');
}

// ===== PROSES PESAN UTAMA =====
async function processMessage(sock, msg) {
  try {
    if (!msg.message || msg.key?.fromMe) return;
    const jid = jidNormalizedUser(msg.key.remoteJid);
    if (!isPersonalChat(jid)) return;

    let text = '';
    if (msg.message.conversation) text = msg.message.conversation;
    else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
    else if (msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption;
    else if (msg.message.videoMessage?.caption) text = msg.message.videoMessage.caption;
    text = text.trim();
    if (!text) return;

    const senderName = msg.pushName || 'User';
    const timestamp = new Date().toLocaleString('id-ID');
    console.log(`\n📨 [${timestamp}] Dari: ${senderName} | JID: ${jid}`);
    console.log(`   Pesan: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

    // Cek apakah ini pesan ABSENSI
    const isAbsensi = text.toUpperCase().startsWith('ABSENSI#');

    if (!isAbsensi) {
      if (!contactedUsers.has(jid)) {
        const welcomeMsg = `Halo *${senderName}* 👋

Selamat datang di *Layanan Absensi SMK N 4 Bandar Lampung*

📋 *Format Pendaftaran:*
\`\`\`
ABSENSI#NISN#NAMA_ORANG_TUA#NOMOR_HP
\`\`\`

📝 *Contoh:*
\`\`\`
ABSENSI#0085517246#Syarif Hidayat#6281234567890
\`\`\`

⚠️ *Perhatian:*
• NISN: 10 digit nomor induk siswa
• Nama: Nama lengkap orang tua/wali
• Nomor HP: Format 62xxx atau 08xxx
• Pisahkan dengan tanda #
• Tanpa spasi di awal/akhir

Notifikasi absensi akan dikirim ke nomor ini.
Terima kasih! 🙏`;
        await messageQueue.add(sock, jid, { text: welcomeMsg });
        contactedUsers.add(jid);
      }
      return;
    }

    // Tandai user pernah chat
    if (!contactedUsers.has(jid)) {
      contactedUsers.add(jid);
    }

    const parts = text.split('#');
    if (parts.length !== 4) {
      const errorMsg = `❌ *Format Salah!*
Harus 4 bagian dipisah #.
Contoh: \`ABSENSI#0085517246#Syarif Hidayat#6281234567890\``;
      await messageQueue.add(sock, jid, { text: errorMsg });
      return;
    }

    const [, nisnRaw, namaRaw, phoneRaw] = parts;
    const nisnCheck = validateNISN(nisnRaw);
    if (!nisnCheck.valid) return await messageQueue.add(sock, jid, { text: `❌ ${nisnCheck.error}` });
    const nameCheck = validateName(namaRaw);
    if (!nameCheck.valid) return await messageQueue.add(sock, jid, { text: `❌ ${nameCheck.error}` });
    const phoneCheck = validatePhoneNumber(phoneRaw);
    if (!phoneCheck.valid) return await messageQueue.add(sock, jid, { text: `❌ ${phoneCheck.error}` });

    const nisn = nisnCheck.nisn;
    const nama_orang_tua = nameCheck.name;
    const no_hp = phoneCheck.phone;

    console.log(`\n[→] MEMPROSES: NISN=${nisn}, Nama=${nama_orang_tua}, HP=${no_hp}`);
    await sock.sendPresenceUpdate('composing', jid);

    try {
      const response = await axios.post(API_URL, {
        nisn,
        nama_orang_tua,
        no_hp
      }, {
        headers: {
          'Authorization': `Bearer ${API_SECRET}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      await sock.sendPresenceUpdate('paused', jid);
      if (response.data.success) {
        const successMsg = `✅ *PENDAFTARAN BERHASIL!*
📋 *Data Terdaftar:*
━━━━━━━━━━━━━━━━━━━━━
👤 Nama: ${nama_orang_tua}
🎓 NISN: ${nisn}
📱 No HP: ${no_hp}
━━━━━━━━━━━━━━━━━━━━━
✓ Notifikasi absensi akan dikirim ke nomor ini.
Terima kasih! 🙏`;
        await messageQueue.add(sock, jid, { text: successMsg });

        // ✅ TANDAI PESAN INI SUDAH DIPROSES
        if (msg.key?.id) {
          processedMessageIds.add(msg.key.id);
        }

        console.log(`[✓] BERHASIL: ${no_hp}`);
      } else {
        throw new Error(response.data.message || 'Gagal di backend');
      }
    } catch (error) {
      await sock.sendPresenceUpdate('paused', jid);
      let errorMsg = '⚠️ *GAGAL MENYIMPAN DATA*\n\n';
      if (error.response) {
        const msg = error.response.data?.message || '';
        if (error.response.status === 409 || msg.toLowerCase().includes('sudah terdaftar')) {
          errorMsg += `📌 Data sudah terdaftar untuk NISN ini.`;
        } else {
          errorMsg += `💬 ${msg || 'Coba lagi nanti.'}`;
        }
      } else {
        errorMsg += `🔌 Gagal terhubung ke server.`;
      }
      await sock.sendMessage(jid, { text: errorMsg });
    }
  } catch (err) {
    console.error('💥 Error in processMessage:', err.message);
  }
}

// ===== SCAN OTOMATIS SETIAP 15 MENIT =====
async function scanUnrepliedAbsensi(sock) {
  console.log('\n🔄 [AUTO SCAN] Mencari pesan ABSENSI yang belum dibalas...');
  let foundCount = 0;
  const scannedJids = new Set();

  try {
    const chats = Object.values(sock.chats || {}).filter(chat => isPersonalChat(chat.id));
    console.log(`📊 Memindai ${chats.length} chat...`);

    for (const chat of chats) {
      const jid = jidNormalizedUser(chat.id);
      if (scannedJids.has(jid)) continue;
      scannedJids.add(jid);

      try {
        // Muat 20 pesan terbaru
        const messages = await sock.loadMessages(jid, 20);
        for (const msg of messages) {
          if (msg.key?.fromMe) continue;
          if (!msg.message) continue;

          let text = '';
          if (msg.message.conversation) text = msg.message.conversation;
          else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
          text = text.trim();

          if (!text || !text.toUpperCase().startsWith('ABSENSI#')) continue;

          // Lewati jika sudah pernah diproses
          if (msg.key?.id && processedMessageIds.has(msg.key.id)) continue;

          console.log(`🔍 Temukan ABSENSI belum dibalas: ${jid}`);
          foundCount++;
          await processMessage(sock, msg);
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (err) {
        // Skip error per chat
      }
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`✅ [AUTO SCAN] Selesai. Ditemukan ${foundCount} pesan.`);
  } catch (err) {
    console.error('⚠️ [AUTO SCAN] Error:', err.message);
  }
}

// ===== KONEKSI UTAMA =====
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  loadContactedUsers();
  loadProcessedMessageIds();

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: true,
    browser: ['AbsensiBot', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📝 [QR CODE] Scan kode berikut dengan WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('❌ Session logged out. Hapus folder baileys_auth dan restart.');
        process.exit(0);
      } else {
        console.log('🔁 Reconnecting...');
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp terhubung!');
      console.log(`📱 Bot: ${sock.user?.id || 'Unknown'}`);
      console.log('=' .repeat(60));

      // ===== PROSES HISTORIS SAAT STARTUP =====
      setTimeout(async () => {
        console.log('\n🔍 Memeriksa pesan historis...\n');
        let totalProcessed = 0;
        const processedJids = new Set();

        try {
          const chats = Object.values(sock.chats || {});
          for (const chat of chats) {
            const jid = jidNormalizedUser(chat.id);
            if (!isPersonalChat(jid) || processedJids.has(jid)) continue;
            processedJids.add(jid);

            const unreadCount = chat.unreadCount || 0;
            if (unreadCount > 0) {
              try {
                const messages = await sock.loadMessages(jid, Math.min(unreadCount + 10, 50));
                const userMessages = messages
                  .filter(m => !m.key.fromMe)
                  .sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

                for (const msg of userMessages) {
                  await processMessage(sock, msg);
                  totalProcessed++;
                  await new Promise(r => setTimeout(r, 300));
                }
              } catch (err) {
                console.error(`   ✗ Error: ${err.message}`);
              }
              await new Promise(r => setTimeout(r, 1000));
            }
          }
          console.log(`\n✅ Selesai. Total pesan historis: ${totalProcessed}`);
          console.log('=' .repeat(60) + '\n');
        } catch (err) {
          console.error('⚠️ Gagal load historis:', err.message);
        }

        // ===== JALANKAN AUTO-SCAN SETIAP 15 MENIT =====
        setInterval(async () => {
          if (sock.ws?.readyState === sock.ws?.OPEN) {
            await scanUnrepliedAbsensi(sock);
          }
        }, 15 * 60 * 1000);
      }, 10000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      await processMessage(sock, msg);
    }
  });

  return sock;
}

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', () => { saveContactedUsers(); saveProcessedMessageIds(); process.exit(0); });
process.on('SIGTERM', () => { saveContactedUsers(); saveProcessedMessageIds(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('💥 Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('💥 Unhandled:', err); });

// ===== START =====
console.log('╔════════════════════════════════════════════════════════╗');
console.log('║     WhatsApp Bot - Absensi SMK N 4 Bandar Lampung     ║');
console.log('╚════════════════════════════════════════════════════════╝');
console.log('\n🚀 Memulai bot...\n');

connectToWhatsApp().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
