// index.js - Manual Phone Number Version
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

// ✅ Track kontak yang sudah pernah chat (di-reset saat bot restart)
const contactedUsers = new Set();

// ✅ File untuk persist contacted users (opsional, bisa di-comment jika tidak perlu)
const contactedUsersFile = path.join(__dirname, 'contacted_users.json');

// Load contacted users dari file saat startup
function loadContactedUsers() {
  try {
    if (fs.existsSync(contactedUsersFile)) {
      const data = fs.readFileSync(contactedUsersFile, 'utf8');
      const users = JSON.parse(data);
      users.forEach(user => contactedUsers.add(user));
      console.log(`📋 Loaded ${contactedUsers.size} contacted users from file`);
    }
  } catch (error) {
    console.log('⚠️  Could not load contacted users file:', error.message);
  }
}

// Save contacted users ke file
function saveContactedUsers() {
  try {
    fs.writeFileSync(contactedUsersFile, JSON.stringify([...contactedUsers]), 'utf8');
  } catch (error) {
    console.error('⚠️  Could not save contacted users:', error.message);
  }
}

// Auto-save setiap 5 menit
setInterval(saveContactedUsers, 5 * 60 * 1000);

// ✅ Validasi format nomor HP
function validatePhoneNumber(phone) {
  // Hapus spasi, dash, plus jika ada
  const cleaned = phone.replace(/[\s\-\+]/g, '');
  
  // Harus angka saja, 10-15 digit
  if (!/^\d{10,15}$/.test(cleaned)) {
    return { valid: false, error: 'Nomor HP harus 10-15 digit angka' };
  }
  
  // Validasi prefix Indonesia (62 atau 0)
  if (!cleaned.startsWith('62') && !cleaned.startsWith('0')) {
    return { valid: false, error: 'Nomor HP harus diawali 62 atau 0' };
  }
  
  // Normalisasi ke format 62
  let normalized = cleaned;
  if (normalized.startsWith('0')) {
    normalized = '62' + normalized.substring(1);
  }
  
  return { valid: true, phone: normalized };
}

// ✅ Validasi NISN
function validateNISN(nisn) {
  const cleaned = nisn.trim();
  
  if (cleaned.length < 5) {
    return { valid: false, error: 'NISN minimal 5 digit' };
  }
  
  if (!/^\d+$/.test(cleaned)) {
    return { valid: false, error: 'NISN harus berupa angka' };
  }
  
  return { valid: true, nisn: cleaned };
}

// ✅ Validasi nama
function validateName(name) {
  const cleaned = name.trim();
  
  if (cleaned.length < 3) {
    return { valid: false, error: 'Nama minimal 3 karakter' };
  }
  
  if (cleaned.length > 100) {
    return { valid: false, error: 'Nama maksimal 100 karakter' };
  }
  
  return { valid: true, name: cleaned };
}

// ✅ Cek apakah chat pribadi
function isPersonalChat(jid) {
  if (!jid) return false;
  return !jid.includes('@g.us') && 
         !jid.includes('@broadcast') && 
         !jid.includes('@newsletter');
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  // Load contacted users saat startup
  loadContactedUsers();

  const sock = makeWASocket({
    auth: state,
    syncFullBookmarks: false,
    markOnline: false,
    generateHighQualityLinkPreview: false,
    version,
    printQRInTerminal: false,
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
      const errorMessage = lastDisconnect?.error?.message || '';
      
      console.log(`🔌 Koneksi ditutup. Status: ${statusCode}`);
      console.log(`   Error: ${errorMessage}`);
      
      // Handle Bad MAC error - reset session
      if (errorMessage.includes('Bad MAC') || statusCode === 440) {
        console.log('\n⚠️  Detected Bad MAC error - Session corrupted');
        console.log('🔄 Resetting session...\n');
        
        // Hapus session yang corrupt
        try {
          const authPath = path.join(__dirname, 'baileys_auth');
          if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log('✓ Session cleared');
          }
        } catch (err) {
          console.error('Error clearing session:', err.message);
        }
        
        console.log('🔁 Restarting... Please scan QR code again\n');
        setTimeout(connectToWhatsApp, 2000);
        return;
      }
      
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('🔁 Reconnecting in 3s...');
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('❌ Bot logged out. Restart aplikasi untuk login ulang.');
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp terhubung! Siap menerima pesan...\n');
      console.log(`📱 Bot Number: ${sock.user?.id || 'Unknown'}\n`);
      console.log('=' .repeat(60));
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      
      // Abaikan pesan dari bot sendiri atau pesan kosong
      if (!msg.message || msg.key.fromMe) return;
      
      const jid = msg.key.remoteJid;

      // Hanya terima chat pribadi
      if (!isPersonalChat(jid)) {
        console.log(`[!] Pesan dari non-personal chat diabaikan: ${jid}`);
        return;
      }

      // Ekstrak teks pesan
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
      if (!text) return;

      // Info pengirim
      const senderName = msg.pushName || 'User';
      const timestamp = new Date().toLocaleString('id-ID');
      
      console.log(`\n📨 [${timestamp}]`);
      console.log(`   Dari: ${senderName}`);
      console.log(`   JID: ${jid}`);
      console.log(`   Pesan: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

      // ✅ CEK FORMAT ABSENSI
      if (!text.toUpperCase().startsWith('ABSENSI#')) {
        // ✅ Cek apakah user ini sudah pernah chat sebelumnya
        if (!contactedUsers.has(jid)) {
          // User baru, kirim welcome message
          const welcomeMsg = `Halo *${senderName}* 👋

Selamat datang di *Layanan Absensi SMK N 4 Bandar Lampung*

📋 *Format Pendaftaran:*
\`\`\`
ABSENSI#NISN#NAMA_ORANG_TUA#NOMOR_HP
\`\`\`

📝 *Contoh:*
\`\`\`
ABSENSI#1234567890#Budi Susanto#6281234567890
\`\`\`

⚠️ *Perhatian:*
• NISN: 10 digit nomor induk siswa
• Nama: Nama lengkap orang tua/wali
• Nomor HP: Format 62xxx atau 08xxx
• Pisahkan dengan tanda #
• Tanpa spasi di awal/akhir

Notifikasi absensi akan dikirim ke nomor HP yang didaftarkan.

Jika ada pertanyaan, hubungi admin sekolah.
Terima kasih! 🙏`;
          
          await sock.sendMessage(jid, { text: welcomeMsg });
          console.log(`   → Mengirim welcome message (user baru)\n`);
          
          // Tandai user sudah pernah chat
          contactedUsers.add(jid);
          saveContactedUsers();
        } else {
          // User lama, kirim pesan singkat
          const reminderMsg = `Gunakan format:
\`\`\`
ABSENSI#NISN#NAMA_ORANG_TUA#NOMOR_HP
\`\`\`

Contoh: \`ABSENSI#1234567890#Budi Susanto#6281234567890\``;
          
          await sock.sendMessage(jid, { text: reminderMsg });
          console.log(`   → Mengirim reminder (user lama)\n`);
        }
        return;
      }

      // ✅ Tandai user sudah pernah chat (jika belum)
      if (!contactedUsers.has(jid)) {
        contactedUsers.add(jid);
        saveContactedUsers();
      }

      // ✅ PARSE FORMAT
      const parts = text.split('#');
      
      if (parts.length !== 4) {
        const errorMsg = `❌ *Format Salah!*

Format yang benar:
\`\`\`
ABSENSI#NISN#NAMA_ORANG_TUA#NOMOR_HP
\`\`\`

Contoh:
\`\`\`
ABSENSI#1234567890#Budi Susanto#6281234567890
\`\`\`

Anda mengirim ${parts.length} bagian, seharusnya 4 bagian.`;
        
        await sock.sendMessage(jid, { text: errorMsg });
        console.log(`   → Format salah (${parts.length} bagian)\n`);
        return;
      }

      const [, nisnRaw, namaRaw, phoneRaw] = parts;

      // ✅ VALIDASI NISN
      const nisnCheck = validateNISN(nisnRaw);
      if (!nisnCheck.valid) {
        await sock.sendMessage(jid, { text: `❌ ${nisnCheck.error}\n\nContoh NISN yang benar: 1234567890` });
        console.log(`   → Validasi NISN gagal: ${nisnCheck.error}\n`);
        return;
      }

      // ✅ VALIDASI NAMA
      const nameCheck = validateName(namaRaw);
      if (!nameCheck.valid) {
        await sock.sendMessage(jid, { text: `❌ ${nameCheck.error}\n\nContoh nama yang benar: Budi Santoso` });
        console.log(`   → Validasi nama gagal: ${nameCheck.error}\n`);
        return;
      }

      // ✅ VALIDASI NOMOR HP
      const phoneCheck = validatePhoneNumber(phoneRaw);
      if (!phoneCheck.valid) {
        await sock.sendMessage(jid, { 
          text: `❌ ${phoneCheck.error}

Contoh nomor yang benar:
• 6281234567890
• 081234567890
• 62-812-3456-7890

Nomor akan dinormalisasi ke format 62xxx` 
        });
        console.log(`   → Validasi nomor gagal: ${phoneCheck.error}\n`);
        return;
      }

      const nisn = nisnCheck.nisn;
      const nama_orang_tua = nameCheck.name;
      const no_hp = phoneCheck.phone;

      console.log(`\n[→] MEMPROSES PENDAFTARAN`);
      console.log(`    NISN: ${nisn}`);
      console.log(`    Nama: ${nama_orang_tua}`);
      console.log(`    No HP: ${no_hp}`);

      // Kirim indikator mengetik
      await sock.sendPresenceUpdate('composing', jid);

      // ✅ KIRIM KE API
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

✓ Nomor HP telah diverifikasi
✓ Notifikasi absensi akan dikirim ke nomor ini

Terima kasih sudah mendaftar! 🙏`;
          
          await sock.sendMessage(jid, { text: successMsg });
          
          console.log(`[✓] BERHASIL REGISTRASI`);
          console.log(`    → Data tersimpan di database`);
          console.log(`    → Notifikasi akan dikirim ke: ${no_hp}\n`);
          console.log('=' .repeat(60));
        } else {
          throw new Error(response.data.message || 'Gagal di backend');
        }

      } catch (error) {
        await sock.sendPresenceUpdate('paused', jid);
        
        let errorMsg = '⚠️ *GAGAL MENYIMPAN DATA*\n\n';
        
        if (error.response) {
          const status = error.response.status;
          const message = error.response.data?.message || '';
          
          console.log(`[✗] API Error - Status: ${status}`);
          console.log(`    Message: ${message}`);
          
          if (status === 409 || message.toLowerCase().includes('sudah terdaftar')) {
            errorMsg += `📌 Data sudah terdaftar sebelumnya:
• NISN: ${nisn}
• Nama: ${nama_orang_tua}
• No HP: ${no_hp}

Jika ini bukan Anda atau ada kesalahan, hubungi admin sekolah.`;
          } else if (status === 401 || status === 403) {
            errorMsg += `🔒 Autentikasi gagal.\nSilakan hubungi admin sistem.`;
          } else if (status === 400) {
            errorMsg += `📝 Data tidak valid:\n${message}\n\nPastikan format sudah benar.`;
          } else {
            errorMsg += `💬 ${message}\n\nJika masalah berlanjut, hubungi admin.`;
          }
        } else if (error.code === 'ECONNREFUSED') {
          errorMsg += `🔌 Server tidak dapat dihubungi.\nSilakan coba beberapa saat lagi.`;
          console.log(`[✗] Connection refused`);
        } else if (error.code === 'ETIMEDOUT') {
          errorMsg += `⏱️ Request timeout.\nServer membutuhkan waktu terlalu lama.\nSilakan coba lagi.`;
          console.log(`[✗] Timeout`);
        } else {
          errorMsg += `❌ Terjadi kesalahan sistem.\nSilakan coba lagi dalam beberapa menit.`;
          console.log(`[✗] Error: ${error.message}`);
        }
        
        await sock.sendMessage(jid, { text: errorMsg });
        console.log('=' .repeat(60));
      }

    } catch (error) {
      console.error('\n💥 [HANDLER ERROR]', error.message);
      // Jangan log full stack untuk production, cukup message
      if (process.env.NODE_ENV === 'development') {
        console.error(error.stack);
      }
    }
  });

  return sock;
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Mematikan bot...');
  saveContactedUsers(); // Save sebelum exit
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n⚠️  Mematikan bot...');
  saveContactedUsers(); // Save sebelum exit
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('\n💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('\n💥 Unhandled Rejection:', error);
});

// Start
console.log('╔════════════════════════════════════════════════════════╗');
console.log('║     WhatsApp Bot - Absensi SMK N 4 Bandar Lampung     ║');
console.log('╚════════════════════════════════════════════════════════╝');
console.log('\n🚀 Memulai bot...\n');

connectToWhatsApp().catch((error) => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
