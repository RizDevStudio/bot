// bulk-sync.js - Script untuk bulk sync pesan tertunda
// Jalankan: node bulk-sync.js

const { 
  default: makeWASocket, 
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║          Bulk Sync - WhatsApp Unread Messages         ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

const authFolder = path.join(__dirname, 'baileys_auth');

// Check if auth exists
if (!fs.existsSync(authFolder)) {
  console.error('❌ Folder baileys_auth tidak ditemukan!');
  console.error('   Bot harus sudah login terlebih dahulu.');
  process.exit(1);
}

async function bulkSync() {
  const { state } = await useMultiFileAuthState(authFolder);
  
  const sock = makeWASocket({
    auth: state,
    syncFullHistory: true, // ✅ Sync full history
    printQRInTerminal: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        console.log('🔁 Reconnecting...');
        setTimeout(bulkSync, 3000);
      } else {
        console.log('❌ Connection closed');
        process.exit(0);
      }
    } else if (connection === 'open') {
      console.log('✅ Connected!\n');
      console.log('🔍 Scanning all chats for unread messages...\n');
      
      await scanAndExport(sock);
      
      console.log('\n✅ Scan selesai!');
      console.log('📄 Hasil disimpan di: unread_messages.json');
      console.log('\nTekan Ctrl+C untuk keluar\n');
    }
  });
}

async function scanAndExport(sock) {
  const results = [];
  let totalUnread = 0;
  
  try {
    // Wait for sync
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    const chats = Object.values(sock.chats || {});
    console.log(`📊 Total chat: ${chats.length}\n`);
    
    let processed = 0;
    
    for (const chat of chats) {
      const jid = chat.id;
      
      // Skip group chats
      if (jid.includes('@g.us') || jid.includes('@broadcast') || jid.includes('@newsletter')) {
        continue;
      }
      
      processed++;
      process.stdout.write(`\r⏳ Progress: ${processed}/${chats.length} chats...`);
      
      const unreadCount = chat.unreadCount || 0;
      
      if (unreadCount > 0) {
        totalUnread += unreadCount;
        
        try {
          const messages = await sock.fetchMessagesFromWA(jid, Math.min(unreadCount + 5, 100));
          
          const unreadMessages = messages
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
                pushName: msg.pushName || 'Unknown'
              };
            })
            .filter(m => m.text); // Only messages with text
          
          if (unreadMessages.length > 0) {
            results.push({
              jid,
              unreadCount,
              messages: unreadMessages
            });
          }
          
        } catch (err) {
          console.error(`\n⚠️  Error fetching from ${jid}: ${err.message}`);
        }
      }
      
      // Small delay
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    console.log('\n');
    console.log('=' .repeat(60));
    console.log(`\n📊 HASIL SCAN:`);
    console.log(`   Total chat dipindai: ${processed}`);
    console.log(`   Total unread messages: ${totalUnread}`);
    console.log(`   Chat dengan pesan ABSENSI: ${results.filter(r => 
      r.messages.some(m => m.text.toUpperCase().startsWith('ABSENSI#'))
    ).length}`);
    
    // Export to JSON
    fs.writeFileSync(
      path.join(__dirname, 'unread_messages.json'),
      JSON.stringify(results, null, 2)
    );
    
    // Export ABSENSI only
    const absensiOnly = results
      .map(r => ({
        ...r,
        messages: r.messages.filter(m => m.text.toUpperCase().startsWith('ABSENSI#'))
      }))
      .filter(r => r.messages.length > 0);
    
    fs.writeFileSync(
      path.join(__dirname, 'absensi_messages.json'),
      JSON.stringify(absensiOnly, null, 2)
    );
    
    console.log(`\n📄 Files created:`);
    console.log(`   1. unread_messages.json - Semua pesan belum dibaca`);
    console.log(`   2. absensi_messages.json - Hanya pesan ABSENSI`);
    
    // Show preview
    if (absensiOnly.length > 0) {
      console.log(`\n📝 Preview pesan ABSENSI (5 pertama):`);
      absensiOnly.slice(0, 5).forEach((chat, idx) => {
        console.log(`\n${idx + 1}. ${chat.messages[0].pushName} (${chat.jid})`);
        console.log(`   ${chat.messages[0].text.substring(0, 60)}...`);
      });
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  }
}

// Start
bulkSync().catch(console.error);

// Graceful exit
process.on('SIGINT', () => {
  console.log('\n\n👋 Exiting...');
  process.exit(0);
});
