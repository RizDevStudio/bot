// index.js
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore
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

    // ✅ PERBAIKAN: Hanya terima pesan dari nomor pribadi (format: 6281234567890@s.whatsapp.net)
    if (!jid || 
        jid.includes('@g.us') ||           // grup
        jid.includes('@broadcast') ||      // broadcast
        !jid.endsWith('@s.whatsapp.net')) { // bukan nomor pribadi (misal: @lid)
      console.warn(`[!] Pesan ditolak dari JID tidak valid: ${jid}`);
      return;
    }

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

ABSENSI#NISN#NAMA_ORANG_TUA_SISWA

untuk mendaftarkan nomor.

Terimakasih`;
      await sock.sendMessage(jid, { text: welcomeMessage });
      return;
    }

    const parts = text.split('#');
    if (parts.length !== 3) {
      await sock.sendMessage(jid, { text: '❌ Format salah. Contoh: ABSENSI#0012345678#Budi Santoso' });
      return;
    }

    const [, nisn, nama_orang_tua] = parts;
    // ✅ PERBAIKAN: Sekarang jid PASTI berakhir dengan @s.whatsapp.net
    const no_hp = jid.replace('@s.whatsapp.net', '');

    if (!nisn || !nama_orang_tua || nisn.length < 5) {
      await sock.sendMessage(jid, { text: '❌ NISN atau nama tidak valid.' });
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

connectToWhatsApp().catch(console.error);
