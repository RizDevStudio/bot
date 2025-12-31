// index.js - Enhanced Version
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Konfigurasi
const API_URL = process.env.API_URL || 'http://localhost/api/parents';
const API_SECRET = process.env.API_SECRET || 'rahasia_kamu';

const authFolder = path.join(__dirname, 'baileys_auth');
if (!fs.existsSync(authFolder)) {
  fs.mkdirSync(authFolder, { recursive: true });
}

// ✅ Fungsi untuk validasi dan ekstrak nomor HP
function extractPhoneNumber(jid) {
  try {
    // Normalize JID terlebih dahulu
    const normalized = jidNormalizedUser(jid);
    
    // Format yang valid: angka@s.whatsapp.net
    if (!normalized || !normalized.endsWith('@s.whatsapp.net')) {
      return null;
    }

    // Extract nomor tanpa suffix
    const phone = normalized.replace('@s.whatsapp.net', '');
    
    // Validasi: harus angka, minimal 10 digit, maksimal 15 digit
    if (!/^\d{10,15}$/.test(phone)) {
      return null;
    }

    return phone;
  } catch (error) {
    console.error('[!] Error ekstrak nomor:', error.message);
    return null;
  }
}

// ✅ Fungsi untuk validasi JID adalah nomor pribadi
function isPersonalChat(jid) {
  if (!jid) return false;
  
  // Tolak grup dan broadcast
  if (jid.includes('@g.us') || jid.includes('@broadcast')) {
    return false;
  }
  
  // Tolak newsletter/channel (format baru WA)
  if (jid.includes('@newsletter')) {
    return false;
  }
  
  // Hanya terima format nomor pribadi
  return jid.endsWith('@s.whatsapp.net');
}

// ✅ Fungsi untuk mendapatkan nama kontak dari Baileys
async function getContactName(sock, jid) {
  try {
    const contact = await sock.onWhatsApp(jid);
    if (contact && contact[0]) {
      return contact[0].notify || contact[0].name || null;
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  // ✅ Buat in-memory store untuk menyimpan metadata kontak
  const store = makeInMemoryStore({});
  store.readFromFile('./baileys_store.json');
  
  // Simpan store setiap 10 detik
  setInterval(() => {
    store.writeToFile('./baileys_store.json');
  }, 10000);

  const sock = makeWASocket({
    auth: state,
    syncFullBookmarks: false,
    markOnline: false,
    generateHighQualityLinkPreview: false,
    version,
    printQRInTerminal: false, // Kita pakai qrcode-terminal sendiri
  });

  // ✅ Bind store ke socket
  store.bind(sock.ev);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📝 [QR CODE] Scan kode berikut dengan WhatsApp kamu:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`🔌 Koneksi ditutup. Alasan: ${statusCode}`);
      if (shouldReconnect) {
        console.log('🔁 Mencoba menyambung ulang...');
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('❌ Bot logged out. Hapus folder baileys_auth untuk login ulang.');
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp terhubung! Menunggu pesan...\n');
      console.log(`📱 Bot Number: ${sock.user?.id || 'Unknown'}\n`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ✅ Tangani pesan masuk dengan validasi ketat
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      
      // Abaikan pesan dari diri sendiri atau pesan kosong
      if (!msg.message || msg.key.fromMe) return;
      
      const jid = msg.key.remoteJid;

      // ✅ VALIDASI 1: Pastikan ini chat pribadi
      if (!isPersonalChat(jid)) {
        console.warn(`[!] Pesan ditolak dari non-personal chat: ${jid}`);
        return;
      }

      // ✅ VALIDASI 2: Ekstrak nomor HP yang valid
      const phoneNumber = extractPhoneNumber(jid);
      if (!phoneNumber) {
        console.warn(`[!] Gagal ekstrak nomor HP dari JID: ${jid}`);
        await sock.sendMessage(jid, { 
          text: '⚠️ Maaf, sistem tidak dapat mendeteksi nomor HP Anda. Pastikan Anda menggunakan nomor WhatsApp yang valid.' 
        });
        return;
      }

      // ✅ Ekstrak teks dari berbagai tipe pesan
      let text = '';
      if (msg.message.conversation) {
        text = msg.message.conversation;
      } else if (msg.message.extendedTextMessage?.text) {
        text = msg.message.extendedTextMessage.text;
      } else if (msg.message.imageMessage?.caption) {
        text = msg.message.imageMessage.caption;
      } else if (msg.message.videoMessage?.caption) {
        text = msg.message.videoMessage.caption;
      }

      text = text.trim();

      // ✅ Log pesan yang diterima
      const senderName = msg.pushName || phoneNumber;
      console.log(`📨 [${new Date().toLocaleString('id-ID')}] Dari: ${senderName} (${phoneNumber})`);
      console.log(`   Pesan: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}\n`);

      // ✅ Tampilkan sambutan jika bukan format ABSENSI
      if (!text.toUpperCase().startsWith('ABSENSI#')) {
        const welcomeMessage = `Halo *${senderName}* 👋

Selamat datang di layanan otomatis *Absensi SMK N 4 Bandar Lampung*.

📋 *Cara Pendaftaran:*
Ketik pesan dengan format:
\`\`\`
ABSENSI#NISN#NAMA_ORANG_TUA
\`\`\`

📝 *Contoh:*
\`\`\`
ABSENSI#0012345678#Budi Santoso
\`\`\`

✅ Nomor HP Anda yang terdeteksi: *${phoneNumber}*

Jika ada pertanyaan, hubungi admin sekolah.

Terima kasih! 🙏`;
        
        await sock.sendMessage(jid, { text: welcomeMessage });
        return;
      }

      // ✅ Parse format ABSENSI#NISN#NAMA
      const parts = text.split('#');
      if (parts.length !== 3) {
        await sock.sendMessage(jid, { 
          text: `❌ *Format salah!*

Format yang benar:
\`\`\`
ABSENSI#NISN#NAMA_ORANG_TUA
\`\`\`

Contoh:
\`\`\`
ABSENSI#0012345678#Budi Santoso
\`\`\`` 
        });
        return;
      }

      const [, nisn, nama_orang_tua] = parts;

      // ✅ Validasi input
      if (!nisn || nisn.trim().length < 5) {
        await sock.sendMessage(jid, { 
          text: '❌ NISN tidak valid. NISN minimal 5 digit.' 
        });
        return;
      }

      if (!nama_orang_tua || nama_orang_tua.trim().length < 3) {
        await sock.sendMessage(jid, { 
          text: '❌ Nama orang tua tidak valid. Minimal 3 karakter.' 
        });
        return;
      }

      // ✅ Kirim indikator "sedang mengetik..."
      await sock.sendPresenceUpdate('composing', jid);

      // ✅ Kirim data ke Laravel API
      try {
        console.log(`[→] Mengirim data ke API...`);
        console.log(`    NISN: ${nisn.trim()}`);
        console.log(`    Nama: ${nama_orang_tua.trim()}`);
        console.log(`    No HP: ${phoneNumber}\n`);

        const response = await axios.post(API_URL, {
          nisn: nisn.trim(),
          nama_orang_tua: nama_orang_tua.trim(),
          no_hp: phoneNumber // ✅ Gunakan nomor yang sudah divalidasi
        }, {
          headers: {
            'Authorization': `Bearer ${API_SECRET}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000 // 15 detik timeout
        });

        await sock.sendPresenceUpdate('paused', jid);

        if (response.data.success) {
          const successMsg = `✅ *Pendaftaran Berhasil!*

📋 Data yang terdaftar:
• NISN: ${nisn.trim()}
• Nama Orang Tua: ${nama_orang_tua.trim()}
• No HP: ${phoneNumber}

Anda akan menerima notifikasi absensi siswa melalui nomor ini.

Terima kasih! 🙏`;
          
          await sock.sendMessage(jid, { text: successMsg });
          console.log(`[✓] Berhasil registrasi: ${nama_orang_tua.trim()} (${nisn.trim()}) - ${phoneNumber}\n`);
        } else {
          throw new Error(response.data.message || 'Gagal di backend');
        }
      } catch (error) {
        await sock.sendPresenceUpdate('paused', jid);
        
        let errorMsg = '⚠️ *Gagal menyimpan data.*\n\n';
        
        if (error.response) {
          // Error dari API
          const status = error.response.status;
          const message = error.response.data?.message || 'Error tidak diketahui';
          
          if (status === 409 || message.includes('sudah terdaftar')) {
            errorMsg += `Nomor *${phoneNumber}* atau NISN *${nisn.trim()}* sudah terdaftar.\n\nJika ada kesalahan, hubungi admin sekolah.`;
          } else if (status === 401) {
            errorMsg += 'Autentikasi gagal. Hubungi admin sistem.';
          } else {
            errorMsg += `${message}\n\nSilakan coba lagi atau hubungi admin.`;
          }
        } else if (error.code === 'ECONNREFUSED') {
          errorMsg += 'Server tidak dapat dihubungi. Coba beberapa saat lagi.';
        } else {
          errorMsg += 'Terjadi kesalahan sistem. Silakan coba lagi nanti.';
        }
        
        console.error(`[✗] Error: ${error.message}\n`);
        await sock.sendMessage(jid, { text: errorMsg });
      }
    } catch (error) {
      console.error('[!] Error handler pesan:', error);
    }
  });

  return sock;
}

// ✅ Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⚠️  Bot dihentikan oleh user');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('💥 Unhandled Rejection:', error);
});

// Start bot
console.log('🚀 Memulai WhatsApp Bot...\n');
connectToWhatsApp().catch(console.error);
