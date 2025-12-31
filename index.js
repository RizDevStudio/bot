// index.js
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion
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

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    syncFullBookmarks: false,
    markOnline: false,
    generateHighQualityLinkPreview: false,
    version,
  });

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
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp terhubung! Menunggu pesan...\n');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Tangani pesan masuk
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid.includes('@g.us')) return; // abaikan grup

    let text = '';
    if (msg.message.conversation) {
      text = msg.message.conversation;
    } else if (msg.message.extendedTextMessage?.text) {
      text = msg.message.extendedTextMessage.text;
    }

    // Tampilkan sambutan jika bukan format ABSENSI
    if (!text.trim().startsWith('ABSENSI#')) {
      const welcomeMessage = `Halo, ini adalah layanan otomatis Absensi SMK N 4 Bandar Lampung

Jika belum pernah mendaftarkan nomor silahkan ketik :

ABSENSI#NISN#NAMA_ORANG_TUA#NOMOR_HP_ORANG_TUA

Contoh:
ABSENSI#0085517246#Siti Aminah#6281234567890

Pastikan NOMOR_HP diawali 62 (tanpa tanda + atau 0).

Terimakasih`;
      await sock.sendMessage(jid, { text: welcomeMessage });
      return;
    }

    const parts = text.split('#');
    if (parts.length !== 4) {
      await sock.sendMessage(jid, { 
        text: '❌ Format salah.\n\nContoh yang benar:\nABSENSI#0085517246#Siti Aminah#6281234567890' 
      });
      return;
    }

    const [, nisn, nama_orang_tua, no_hp_input] = parts;

    // Validasi dasar
    if (!nisn || !nama_orang_tua || !no_hp_input) {
      await sock.sendMessage(jid, { text: '❌ Semua bagian wajib diisi.' });
      return;
    }

    // Validasi NISN: hanya angka, min 5 digit
    if (!/^\d{5,20}$/.test(nisn.trim())) {
      await sock.sendMessage(jid, { text: '❌ NISN harus berupa angka (5-20 digit).' });
      return;
    }

    // Validasi nomor HP: mulai 62, hanya angka, panjang 10-14
    const no_hp = no_hp_input.trim();
    if (!/^628\d{8,12}$/.test(no_hp)) {
      await sock.sendMessage(jid, { 
        text: '❌ Format nomor HP salah.\n\nContoh: 6281234567890 (diawali 62, tanpa + atau 0)' 
      });
      return;
    }

    try {
      const response = await axios.post(API_URL, {
        nisn: nisn.trim(),
        nama_orang_tua: nama_orang_tua.trim(),
        no_hp: no_hp
      }, {
        headers: {
          'Authorization': `Bearer ${API_SECRET}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.data.success) {
        await sock.sendMessage(jid, { text: '✅ Data orang tua berhasil didaftarkan!' });
        console.log(`[+] Berhasil: ${nama_orang_tua} (${nisn}) - ${no_hp}`);
      } else {
        throw new Error(response.data.message || 'Gagal di backend');
      }
    } catch (error) {
      console.error('[!] Error kirim ke Laravel:', error.message);
      await sock.sendMessage(jid, { text: '⚠️ Gagal menyimpan data. Coba lagi nanti.' });
    }
  });

  return sock;
}

console.log('🚀 Memulai WhatsApp Bot...');
connectToWhatsApp().catch(console.error);
