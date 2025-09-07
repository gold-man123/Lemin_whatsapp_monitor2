import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { Message, Channel, Alert, SystemStats } from '../types/index';

export class DatabaseManager {
  private db: Database | null = null;
  private readonly dbFile: string;
  private isInitialized: boolean = false;

  constructor(dbFile: string = './whatsapp_data.db') {
    this.dbFile = dbFile;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      this.db = await open({
        filename: this.dbFile,
        driver: sqlite3.Database
      });

      // Enable WAL mode for better performance
      await this.db.exec('PRAGMA journal_mode = WAL;');
      await this.db.exec('PRAGMA synchronous = NORMAL;');
      await this.db.exec('PRAGMA cache_size = 10000;');
      await this.db.exec('PRAGMA temp_store = MEMORY;');

      await this.createTables();
      await this.createIndexes();
      await this.createTriggers();
      
      this.isInitialized = true;
      console.log('✅ Database initialized with optimizations');
    } catch (error) {
      console.error('❌ Database initialization failed:', error);
      throw error;
    }
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
        category TEXT DEFAULT 'personal',
        metadata TEXT
      );
    `);

    // Enhanced messages table with better indexing
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        target_channel TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        content_hash TEXT,
        timestamp INTEGER NOT NULL,
        is_from_me INTEGER DEFAULT 0,
        message_type TEXT DEFAULT 'text',
        metadata TEXT,
        processed_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        risk_score REAL DEFAULT 0.0
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
        resolved_by TEXT,
        metadata TEXT
      );
    `);

    // System metrics table for performance monitoring
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata TEXT
      );
    `);

    // Performance analytics table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS performance_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        memory_usage INTEGER,
        timestamp INTEGER NOT NULL,
        success INTEGER DEFAULT 1
      );
    `);
  }

  private async createIndexes(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)',
      'CREATE INDEX IF NOT EXISTS idx_messages_target_timestamp ON messages(target_channel, timestamp DESC)',
      'CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)',
      'CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type)',
      'CREATE INDEX IF NOT EXISTS idx_messages_content_hash ON messages(content_hash)',
      'CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC)',
      'CREATE INDEX IF NOT EXISTS idx_alerts_channel ON alerts(channel_jid)',
      'CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(is_resolved)',
      'CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity)',
      'CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON system_metrics(timestamp DESC)',
      'CREATE INDEX IF NOT EXISTS idx_metrics_name_timestamp ON system_metrics(metric_name, timestamp DESC)',
      'CREATE INDEX IF NOT EXISTS idx_channels_active ON channels(is_active)',
      'CREATE INDEX IF NOT EXISTS idx_channels_last_message ON channels(last_message_at DESC)'
    ];

    for (const index of indexes) {
      await this.db.exec(index);
    }
  }

  private async createTriggers(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Auto-update channel statistics
    await this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_channel_stats
      AFTER INSERT ON messages
      BEGIN
        UPDATE channels 
        SET 
          last_message_at = NEW.timestamp,
          message_count = message_count + 1
        WHERE jid = NEW.target_channel;
      END;
    `);

    // Auto-cleanup old metrics
    await this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS cleanup_old_metrics
      AFTER INSERT ON system_metrics
      WHEN (SELECT COUNT(*) FROM system_metrics) > 10000
      BEGIN
        DELETE FROM system_metrics 
        WHERE timestamp < (strftime('%s', 'now') - 86400) * 1000;
      END;
    `);
  }

  async saveMessage(message: Message): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const metadata = message.metadata ? JSON.stringify(message.metadata) : null;
    const contentHash = this.generateContentHash(message.content);

    try {
      await this.db.run(
        `INSERT OR REPLACE INTO messages(
          id, sender, target_channel, type, content, content_hash, 
          timestamp, is_from_me, message_type, metadata, risk_score
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.id,
          message.sender,
          message.target_channel,
          message.type,
          message.content,
          contentHash,
          message.timestamp,
          message.is_from_me ? 1 : 0,
          message.message_type,
          metadata,
          message.risk_score || 0.0
        ]
      );
    } catch (error) {
      console.error('❌ Failed to save message:', error);
      throw error;
    }
  }

  async saveAlert(alert: Alert): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const metadata = alert.metadata ? JSON.stringify(alert.metadata) : null;

    try {
      await this.db.run(
        `INSERT OR REPLACE INTO alerts(
          id, type, severity, channel_jid, message_id, 
          description, timestamp, is_resolved, metadata
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          alert.id,
          alert.type,
          alert.severity,
          alert.channel_jid,
          alert.message_id,
          alert.description,
          alert.timestamp,
          alert.is_resolved ? 1 : 0,
          metadata
        ]
      );
    } catch (error) {
      console.error('❌ Failed to save alert:', error);
      throw error;
    }
  }

  async addChannel(channel: Omit<Channel, 'id'>): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const result = await this.db.run(
        `INSERT INTO channels(jid, label, is_active, created_at, category, metadata) 
         VALUES(?, ?, ?, ?, ?, ?)`,
        [
          channel.jid,
          channel.label,
          channel.is_active ? 1 : 0,
          channel.created_at,
          channel.category || 'personal',
          channel.metadata ? JSON.stringify(channel.metadata) : null
        ]
      );
      return result.lastID as number;
    } catch (error) {
      console.error('❌ Failed to add channel:', error);
      throw error;
    }
  }

  async removeChannel(id: number): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      await this.db.run('UPDATE channels SET is_active = 0 WHERE id = ?', [id]);
    } catch (error) {
      console.error('❌ Failed to remove channel:', error);
      throw error;
    }
  }

  async getChannels(): Promise<Channel[]> {
    if (!this.db) throw new Error('Database not initialized');

    try {
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
        WHERE c.is_active = 1
        ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
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
        category: row.category as Channel['category'],
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined
      }));
    } catch (error) {
      console.error('❌ Failed to get channels:', error);
      throw error;
    }
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

    try {
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
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        risk_score: row.risk_score
      }));
    } catch (error) {
      console.error('❌ Failed to get messages:', error);
      throw error;
    }
  }

  async getAlerts(filters: { 
    resolved?: boolean; 
    severity?: string; 
    limit?: number;
    channel?: string;
  } = {}): Promise<Alert[]> {
    if (!this.db) throw new Error('Database not initialized');

    try {
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

      if (filters.channel) {
        query += ' AND channel_jid = ?';
        params.push(filters.channel);
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
        is_resolved: Boolean(row.is_resolved),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined
      }));
    } catch (error) {
      console.error('❌ Failed to get alerts:', error);
      throw error;
    }
  }

  async getSystemStats(): Promise<SystemStats> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const [totalMessages, totalChannels, recentMessages, activeAlerts, topChannels, hourlyStats] = await Promise.all([
        this.db.get('SELECT COUNT(*) as count FROM messages'),
        this.db.get('SELECT COUNT(*) as count FROM channels WHERE is_active = 1'),
        this.db.get(`
          SELECT COUNT(*) as count FROM messages 
          WHERE timestamp > ?
        `, [Date.now() - 24 * 60 * 60 * 1000]),
        this.db.get('SELECT COUNT(*) as count FROM alerts WHERE is_resolved = 0'),
        this.db.all(`
          SELECT target_channel, COUNT(*) as message_count, MAX(timestamp) as last_message
          FROM messages 
          GROUP BY target_channel 
          ORDER BY message_count DESC 
          LIMIT 5
        `),
        this.db.all(`
          SELECT 
            strftime('%H', datetime(timestamp/1000, 'unixepoch')) as hour,
            COUNT(*) as message_count
          FROM messages 
          WHERE timestamp > ?
          GROUP BY hour
          ORDER BY hour
        `, [Date.now() - 24 * 60 * 60 * 1000])
      ]);

      return {
        total_messages: totalMessages?.count || 0,
        total_channels: totalChannels?.count || 0,
        recent_messages: recentMessages?.count || 0,
        active_alerts: activeAlerts?.count || 0,
        connection_status: 'unknown',
        uptime: 0,
        processing_rate: 0,
        top_channels: topChannels || [],
        hourly_stats: hourlyStats || []
      };
    } catch (error) {
      console.error('❌ Failed to get system stats:', error);
      throw error;
    }
  }

  async recordMetric(name: string, value: number, metadata?: any): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      await this.db.run(
        'INSERT INTO system_metrics(metric_name, metric_value, timestamp, metadata) VALUES(?, ?, ?, ?)',
        [name, value, Date.now(), metadata ? JSON.stringify(metadata) : null]
      );
    } catch (error) {
      console.error('❌ Failed to record metric:', error);
    }
  }

  async recordPerformance(operation: string, duration: number, success: boolean = true): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const memoryUsage = process.memoryUsage().heapUsed;
      await this.db.run(
        'INSERT INTO performance_logs(operation, duration_ms, memory_usage, timestamp, success) VALUES(?, ?, ?, ?, ?)',
        [operation, duration, memoryUsage, Date.now(), success ? 1 : 0]
      );
    } catch (error) {
      console.error('❌ Failed to record performance:', error);
    }
  }

  private generateContentHash(content: string): string {
    // Simple hash function for content deduplication
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  async cleanup(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      
      // Clean old metrics (keep last 30 days)
      await this.db.run('DELETE FROM system_metrics WHERE timestamp < ?', [thirtyDaysAgo]);
      
      // Clean old performance logs (keep last 7 days)
      await this.db.run('DELETE FROM performance_logs WHERE timestamp < ?', [sevenDaysAgo]);
      
      // Clean resolved alerts older than 7 days
      await this.db.run('DELETE FROM alerts WHERE is_resolved = 1 AND timestamp < ?', [sevenDaysAgo]);
      
      // Vacuum database to reclaim space
      await this.db.exec('VACUUM;');
      
      console.log('🧹 Database cleanup completed');
    } catch (error) {
      console.error('❌ Database cleanup failed:', error);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close();
        this.db = null;
        this.isInitialized = false;
        console.log('✅ Database connection closed');
      } catch (error) {
        console.error('❌ Failed to close database:', error);
      }
    }
  }

  async getHealth(): Promise<{ status: string; details: any }> {
    if (!this.db) {
      return { status: 'unhealthy', details: { error: 'Database not initialized' } };
    }

    try {
      const result = await this.db.get('SELECT 1 as test');
      const stats = await this.getSystemStats();
      
      return {
        status: 'healthy',
        details: {
          database_responsive: !!result,
          total_messages: stats.total_messages,
          total_channels: stats.total_channels,
          last_check: new Date().toISOString()
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: { error: error.message }
      };
    }
  }
}