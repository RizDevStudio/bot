// process-absensi.js - Process hasil scan dan kirim ke API
// Jalankan setelah bulk-sync.js selesai
// Usage: node process-absensi.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const API_URL = process.env.API_URL || 'http://localhost/api/parents';
const API_SECRET = process.env.API_SECRET || 'rahasia_kamu';

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║         Process ABSENSI Messages to Database          ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

// Validasi functions (copy dari main)
function validatePhoneNumber(phone) {
  const cleaned = phone.replace(/[\s\-\+]/g, '');
  if (!/^\d{10,15}$/.test(cleaned)) {
    return { valid: false, error: 'Nomor HP harus 10-15 digit angka' };
  }
  if (!cleaned.startsWith('62') && !cleaned.startsWith('0')) {
    return { valid: false, error: 'Nomor HP harus diawali 62 atau 0' };
  }
  let normalized = cleaned;
  if (normalized.startsWith('0')) {
    normalized = '62' + normalized.substring(1);
  }
  return { valid: true, phone: normalized };
}

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

async function processAbsensi() {
  // Load hasil scan
  const filePath = path.join(__dirname, 'absensi_messages.json');
  
  if (!fs.existsSync(filePath)) {
    console.error('❌ File absensi_messages.json tidak ditemukan!');
    console.error('   Jalankan bulk-sync.js terlebih dahulu.');
    process.exit(1);
  }
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  console.log(`📊 Total chat dengan ABSENSI: ${data.length}\n`);
  
  const results = {
    success: [],
    failed: [],
    skipped: []
  };
  
  let processed = 0;
  const total = data.reduce((sum, chat) => sum + chat.messages.length, 0);
  
  for (const chat of data) {
    for (const msg of chat.messages) {
      processed++;
      
      console.log(`\n[${processed}/${total}] Processing...`);
      console.log(`From: ${msg.pushName} (${chat.jid})`);
      console.log(`Text: ${msg.text.substring(0, 60)}...`);
      
      // Parse ABSENSI
      const parts = msg.text.split('#');
      
      if (parts.length !== 4) {
        console.log(`⚠️  SKIPPED: Format salah (${parts.length} parts)`);
        results.skipped.push({ jid: chat.jid, reason: 'Format salah', text: msg.text });
        continue;
      }
      
      const [, nisnRaw, namaRaw, phoneRaw] = parts;
      
      // Validasi
      const nisnCheck = validateNISN(nisnRaw);
      if (!nisnCheck.valid) {
        console.log(`⚠️  SKIPPED: ${nisnCheck.error}`);
        results.skipped.push({ jid: chat.jid, reason: nisnCheck.error, text: msg.text });
        continue;
      }
      
      const nameCheck = validateName(namaRaw);
      if (!nameCheck.valid) {
        console.log(`⚠️  SKIPPED: ${nameCheck.error}`);
        results.skipped.push({ jid: chat.jid, reason: nameCheck.error, text: msg.text });
        continue;
      }
      
      const phoneCheck = validatePhoneNumber(phoneRaw);
      if (!phoneCheck.valid) {
        console.log(`⚠️  SKIPPED: ${phoneCheck.error}`);
        results.skipped.push({ jid: chat.jid, reason: phoneCheck.error, text: msg.text });
        continue;
      }
      
      const nisn = nisnCheck.nisn;
      const nama_orang_tua = nameCheck.name;
      const no_hp = phoneCheck.phone;
      
      console.log(`📝 Valid data:`);
      console.log(`   NISN: ${nisn}`);
      console.log(`   Nama: ${nama_orang_tua}`);
      console.log(`   HP: ${no_hp}`);
      
      // Kirim ke API
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
        
        if (response.data.success) {
          console.log(`✅ SUCCESS: Data tersimpan`);
          results.success.push({ jid: chat.jid, nisn, nama_orang_tua, no_hp });
        } else {
          throw new Error(response.data.message || 'Unknown error');
        }
        
      } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.log(`❌ FAILED: ${errorMsg}`);
        results.failed.push({ jid: chat.jid, nisn, nama_orang_tua, no_hp, error: errorMsg });
      }
      
      // Delay untuk tidak overwhelm API
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('\n📊 HASIL PEMROSESAN:\n');
  console.log(`✅ Berhasil: ${results.success.length}`);
  console.log(`❌ Gagal: ${results.failed.length}`);
  console.log(`⚠️  Dilewati: ${results.skipped.length}`);
  console.log(`📊 Total: ${processed}`);
  
  // Save results
  fs.writeFileSync(
    path.join(__dirname, 'process_results.json'),
    JSON.stringify(results, null, 2)
  );
  
  console.log(`\n💾 Detail hasil disimpan di: process_results.json`);
  
  if (results.failed.length > 0) {
    console.log(`\n⚠️  Ada ${results.failed.length} data yang gagal:`);
    results.failed.slice(0, 5).forEach((item, idx) => {
      console.log(`   ${idx + 1}. ${item.nama_orang_tua} - ${item.error}`);
    });
    if (results.failed.length > 5) {
      console.log(`   ... dan ${results.failed.length - 5} lainnya`);
    }
  }
  
  console.log('\n✅ Selesai!\n');
}

processAbsensi().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
