import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { Message, Channel, Alert } from '../types/index.js';

export class DatabaseManager {
  private db: Database | null = null;
  private readonly dbFile: string;

  constructor(dbFile: string = './whatsapp_data.db') {
    this.dbFile = dbFile;
  }

  async initialize(): Promise<void> {
    this.db = await open({
      filename: this.dbFile,
      driver: sqlite3.Database
    });

    await this.createTables();
    await this.createIndexes();
    console.log('✅ Database initialized successfully');
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Enhanced channels table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jid TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_message_at INTEGER,
        message_count INTEGER DEFAULT 0,
        risk_score REAL DEFAULT 0.0,
        category TEXT DEFAULT 'personal'
      );
    `);

    // Enhanced messages table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        target_channel TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        timestamp INTEGER NOT NULL,
        is_from_me INTEGER DEFAULT 0,
        message_type TEXT DEFAULT 'text',
        metadata TEXT,
        processed_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );
    `);

    // Alerts table for security monitoring
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        channel_jid TEXT NOT NULL,
        message_id TEXT,
        description TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_resolved INTEGER DEFAULT 0,
        resolved_at INTEGER,
        resolved_by TEXT
      );
    `);

    // System metrics table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
  }

  private async createIndexes(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(target_channel);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
      CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
      CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
      CREATE INDEX IF NOT EXISTS idx_alerts_channel ON alerts(channel_jid);
      CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(is_resolved);
      CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON system_metrics(timestamp);
    `);
  }

  async saveMessage(message: Message): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const metadata = message.metadata ? JSON.stringify(message.metadata) : null;

    await this.db.run(
      `INSERT OR REPLACE INTO messages(id, sender, target_channel, type, content, timestamp, is_from_me, message_type, metadata) 
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.sender,
        message.target_channel,
        message.type,
        message.content,
        message.timestamp,
        message.is_from_me ? 1 : 0,
        message.message_type,
        metadata
      ]
    );

    // Update channel statistics
    await this.updateChannelStats(message.target_channel, message.timestamp);
  }

  async saveAlert(alert: Alert): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    await this.db.run(
      `INSERT OR REPLACE INTO alerts(id, type, severity, channel_jid, message_id, description, timestamp, is_resolved) 
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        alert.id,
        alert.type,
        alert.severity,
        alert.channel_jid,
        alert.message_id,
        alert.description,
        alert.timestamp,
        alert.is_resolved ? 1 : 0
      ]
    );
  }

  private async updateChannelStats(channelJid: string, timestamp: number): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    await this.db.run(
      `UPDATE channels 
       SET last_message_at = ?, message_count = message_count + 1 
       WHERE jid = ?`,
      [timestamp, channelJid]
    );
  }

  async getChannels(): Promise<Channel[]> {
    if (!this.db) throw new Error('Database not initialized');

    const rows = await this.db.all(`
      SELECT c.*, 
        COALESCE(m.message_count, 0) as message_count,
        COALESCE(a.alert_count, 0) as alert_count
      FROM channels c
      LEFT JOIN (
        SELECT target_channel, COUNT(*) as message_count 
        FROM messages 
        GROUP BY target_channel
      ) m ON c.jid = m.target_channel
      LEFT JOIN (
        SELECT channel_jid, COUNT(*) as alert_count 
        FROM alerts 
        WHERE is_resolved = 0 
        GROUP BY channel_jid
      ) a ON c.jid = a.channel_jid
      ORDER BY c.created_at DESC
    `);

    return rows.map(row => ({
      id: row.id,
      jid: row.jid,
      label: row.label,
      is_active: Boolean(row.is_active),
      created_at: row.created_at,
      last_message_at: row.last_message_at,
      message_count: row.message_count,
      risk_score: row.risk_score,
      category: row.category as Channel['category']
    }));
  }

  async getMessages(filters: {
    channel?: string;
    search?: string;
    limit?: number;
    offset?: number;
    startTime?: number;
    endTime?: number;
  } = {}): Promise<Message[]> {
    if (!this.db) throw new Error('Database not initialized');

    let query = 'SELECT * FROM messages WHERE 1=1';
    const params: any[] = [];

    if (filters.channel) {
      query += ' AND target_channel = ?';
      params.push(filters.channel);
    }

    if (filters.search) {
      query += ' AND (content LIKE ? OR sender LIKE ?)';
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }

    if (filters.startTime) {
      query += ' AND timestamp >= ?';
      params.push(filters.startTime);
    }

    if (filters.endTime) {
      query += ' AND timestamp <= ?';
      params.push(filters.endTime);
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    if (filters.offset) {
      query += ' OFFSET ?';
      params.push(filters.offset);
    }

    const rows = await this.db.all(query, params);
    
    return rows.map(row => ({
      id: row.id,
      sender: row.sender,
      target_channel: row.target_channel,
      type: row.type,
      content: row.content,
      timestamp: row.timestamp,
      is_from_me: Boolean(row.is_from_me),
      message_type: row.message_type,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    }));
  }

  async getAlerts(filters: { resolved?: boolean; severity?: string; limit?: number } = {}): Promise<Alert[]> {
    if (!this.db) throw new Error('Database not initialized');

    let query = 'SELECT * FROM alerts WHERE 1=1';
    const params: any[] = [];

    if (filters.resolved !== undefined) {
      query += ' AND is_resolved = ?';
      params.push(filters.resolved ? 1 : 0);
    }

    if (filters.severity) {
      query += ' AND severity = ?';
      params.push(filters.severity);
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const rows = await this.db.all(query, params);
    
    return rows.map(row => ({
      id: row.id,
      type: row.type,
      severity: row.severity,
      channel_jid: row.channel_jid,
      message_id: row.message_id,
      description: row.description,
      timestamp: row.timestamp,
      is_resolved: Boolean(row.is_resolved)
    }));
  }

  async getSystemStats(): Promise<any> {
    if (!this.db) throw new Error('Database not initialized');

    const totalMessages = await this.db.get('SELECT COUNT(*) as count FROM messages');
    const totalChannels = await this.db.get('SELECT COUNT(*) as count FROM channels WHERE is_active = 1');
    const recentMessages = await this.db.get(`
      SELECT COUNT(*) as count FROM messages 
      WHERE timestamp > ?
    `, [Date.now() - 24 * 60 * 60 * 1000]);
    
    const activeAlerts = await this.db.get('SELECT COUNT(*) as count FROM alerts WHERE is_resolved = 0');
    
    const topChannels = await this.db.all(`
      SELECT target_channel, COUNT(*) as message_count, MAX(timestamp) as last_message
      FROM messages 
      GROUP BY target_channel 
      ORDER BY message_count DESC 
      LIMIT 5
    `);

    const hourlyStats = await this.db.all(`
      SELECT 
        strftime('%H', datetime(timestamp/1000, 'unixepoch')) as hour,
        COUNT(*) as message_count
      FROM messages 
      WHERE timestamp > ?
      GROUP BY hour
      ORDER BY hour
    `, [Date.now() - 24 * 60 * 60 * 1000]);

    return {
      total_messages: totalMessages.count,
      total_channels: totalChannels.count,
      recent_messages: recentMessages.count,
      active_alerts: activeAlerts.count,
      top_channels: topChannels,
      hourly_stats: hourlyStats
    };
  }

  async recordMetric(name: string, value: number): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    await this.db.run(
      'INSERT INTO system_metrics(metric_name, metric_value, timestamp) VALUES(?, ?, ?)',
      [name, value, Date.now()]
    );
  }

  async cleanup(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    // Clean old metrics
    await this.db.run('DELETE FROM system_metrics WHERE timestamp < ?', [thirtyDaysAgo]);
    
    // Clean resolved alerts older than 7 days
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    await this.db.run('DELETE FROM alerts WHERE is_resolved = 1 AND timestamp < ?', [sevenDaysAgo]);
    
    console.log('🧹 Database cleanup completed');
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}