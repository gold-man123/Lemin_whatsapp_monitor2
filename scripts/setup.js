import { existsSync, mkdirSync } from 'fs';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

console.log('🚀 Setting up WhatsApp Monitor...');

// Create required directories
const dirs = ['auth_info', 'views', 'public', 'logs'];
dirs.forEach(dir => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`✅ Created directory: ${dir}`);
  }
});

// Initialize database
async function setupDatabase() {
  try {
    const db = await open({
      filename: './whatsapp_data.db',
      driver: sqlite3.Database
    });
    
    await db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jid TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_message_at INTEGER
      );
    `);
    
    await db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        target_channel TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        timestamp INTEGER NOT NULL,
        is_from_me INTEGER DEFAULT 0,
        message_type TEXT DEFAULT 'text'
      );
    `);

    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(target_channel);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
    `);
    
    await db.close();
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database setup failed:', error);
    process.exit(1);
  }
}

await setupDatabase();
console.log('🎉 Setup complete! Run "npm start" to begin monitoring.');