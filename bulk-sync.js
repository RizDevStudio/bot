// bulk-sync.js - Diperbaiki untuk mendeteksi pesan ABSENSI saat offline
// Jalankan: node bulk-sync.js

const { 
  default: makeWASocket, 
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║          Bulk Sync - WhatsApp Unread Messages         ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

const authFolder = path.join(__dirname, 'baileys_auth');

if (!fs.existsSync(authFolder)) {
  console.error('❌ Folder baileys_auth tidak ditemukan!');
  console.error('   Pastikan bot sudah pernah login.');
  process.exit(1);
}

async function bulkSync() {
  const { state } = await useMultiFileAuthState(authFolder);
  
  const sock = makeWASocket({
    auth: state,
    syncFullHistory: true,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: ['BulkSync', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('🔁 Reconnecting...');
        setTimeout(bulkSync, 3000);
      } else {
        console.log('❌ Session logged out. Please re-login.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      console.log('✅ Connected!\n');
      console.log('🔍 Fetching all recent conversations...\n');
      
      // Tunggu sebentar agar WhatsApp Web menyelesaikan inisialisasi
      await new Promise(r => setTimeout(r, 10000));
      
      await scanAndExport(sock);
      
      console.log('\n✅ Scan selesai!');
      console.log('📄 Hasil disimpan di: unread_messages.json & absensi_messages.json');
      console.log('\nTekan Ctrl+C untuk keluar\n');
    }
  });

  // Tangani error global
  sock.ev.on('messages.upsert', () => {}); // dummy listener agar event tidak error
}

async function scanAndExport(sock) {
  const results = [];
  let totalUnread = 0;
  const absensiEntries = [];

  try {
    // Langkah 1: Ambil semua kontak yang pernah chat (termasuk saat offline)
    const allContacts = Object.keys(sock.contacts || {}).filter(jid => 
      jid.endsWith('@s.whatsapp.net') // hanya kontak pribadi
    );

    // Langkah 2: Tambahkan juga dari sock.chats jika ada yang tidak di contacts
    const chatJids = Object.keys(sock.chats || {}).filter(jid => 
      jid.endsWith('@s.whatsapp.net')
    );
    const uniqueJids = [...new Set([...allContacts, ...chatJids])];

    console.log(`📊 Total kontak/chat yang diproses: ${uniqueJids.length}\n`);

    for (let i = 0; i < uniqueJids.length; i++) {
      const jid = jidNormalizedUser(uniqueJids[i]);
      process.stdout.write(`\r⏳ Memproses: ${i + 1}/${uniqueJids.length} | ${jid}`);

      try {
        // Muat hingga 20 pesan terbaru dari tiap kontak
        const messages = await sock.loadMessages(jid, 20);
        
        // Urutkan dari terlama ke terbaru
        const sortedMsgs = messages.sort((a, b) => 
          (a.messageTimestamp || 0) - (b.messageTimestamp || 0)
        );

        // Cari pesan ABSENSI yang belum diproses (dari non-bot)
        const absensiMsgs = sortedMsgs
          .filter(msg => !msg.key.fromMe && msg.message)
          .map(msg => {
            let text = '';
            if (msg.message.conversation) {
              text = msg.message.conversation;
            } else if (msg.message.extendedTextMessage?.text) {
              text = msg.message.extendedTextMessage.text;
            }
            return {
              from: jid,
              text: text.trim(),
              timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : null,
              pushName: msg.pushName || 'Unknown',
              key: msg.key
            };
          })
          .filter(m => m.text && m.text.toUpperCase().startsWith('ABSENSI#'));

        if (absensiMsgs.length > 0) {
          totalUnread += absensiMsgs.length;
          absensiEntries.push(...absensiMsgs);

          results.push({
            jid,
            unreadCount: absensiMsgs.length,
            messages: absensiMsgs
          });
        }

      } catch (err) {
        // Skip jika error (misal: kontak tidak valid)
      }

      // Jeda kecil untuk hindari rate limit
      await new Promise(r => setTimeout(r, 200));
    }

    console.log('\n\n' + '='.repeat(60));
    console.log(`\n📊 HASIL SCAN:`);
    console.log(`   Total kontak diproses: ${uniqueJids.length}`);
    console.log(`   Total pesan ABSENSI ditemukan: ${absensiEntries.length}`);

    // Simpan semua pesan unread (opsional)
    fs.writeFileSync(
      path.join(__dirname, 'unread_messages.json'),
      JSON.stringify(results, null, 2),
      'utf-8'
    );

    // Simpan hanya ABSENSI
    fs.writeFileSync(
      path.join(__dirname, 'absensi_messages.json'),
      JSON.stringify(absensiEntries, null, 2),
      'utf-8'
    );

    console.log(`\n📄 Files created:`);
    console.log(`   1. unread_messages.json`);
    console.log(`   2. absensi_messages.json`);

    if (absensiEntries.length > 0) {
      console.log(`\n📝 Preview (5 pertama):`);
      absensiEntries.slice(0, 5).forEach((msg, idx) => {
        console.log(`\n${idx + 1}. ${msg.pushName} (${msg.from})`);
        console.log(`   ${msg.text.substring(0, 70)}${msg.text.length > 70 ? '...' : ''}`);
      });
    }

  } catch (error) {
    console.error('\n❌ Fatal error during scan:', error);
  }
}

// Jalankan
bulkSync().catch(console.error);

process.on('SIGINT', () => {
  console.log('\n\n👋 Exiting gracefully...');
  process.exit(0);
});
