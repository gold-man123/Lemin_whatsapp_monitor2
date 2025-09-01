import makeWASocket, { 
  fetchLatestBaileysVersion, 
  useMultiFileAuthState, 
  WASocket,
  MessageUpsertType,
  BaileysEventMap
} from '@adiwajshing/baileys';
import { Boom } from '@hapi/boom';
import { Message } from '../types/index.js';
import { DatabaseManager } from './DatabaseManager.js';
import { MessageAnalyzer } from './MessageAnalyzer.js';
import { WebhookManager } from './WebhookManager.js';

export class WhatsAppManager {
  private sock: WASocket | null = null;
  private connectionStatus: string = 'disconnected';
  private readonly authDir: string;
  private readonly db: DatabaseManager;
  private readonly analyzer: MessageAnalyzer;
  private readonly webhook: WebhookManager;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 5;
  private monitoredChannels: Set<string> = new Set();

  constructor(
    authDir: string,
    db: DatabaseManager,
    analyzer: MessageAnalyzer,
    webhook: WebhookManager
  ) {
    this.authDir = authDir;
    this.db = db;
    this.analyzer = analyzer;
    this.webhook = webhook;
  }

  async initialize(): Promise<void> {
    await this.loadMonitoredChannels();
    await this.startSocket();
  }

  private async loadMonitoredChannels(): Promise<void> {
    const channels = await this.db.getChannels();
    this.monitoredChannels = new Set(
      channels.filter(c => c.is_active).map(c => c.jid)
    );
    console.log(`📋 Loaded ${this.monitoredChannels.size} monitored channels`);
  }

  private async startSocket(): Promise<void> {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: {
          level: 'warn',
          log: (level, ...args) => console.log('[Baileys]', level, ...args)
        },
        markOnlineOnConnect: false,
        syncFullHistory: true,
        generateHighQualityLinkPreview: false
      });

      this.setupEventHandlers();
      console.log('🔄 WhatsApp socket initialized');
    } catch (error) {
      console.error('❌ Failed to start WhatsApp socket:', error);
      await this.handleReconnection();
    }
  }

  private setupEventHandlers(): void {
    if (!this.sock) return;

    this.sock.ev.on('creds.update', async (creds) => {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      await saveCreds();
    });

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('📱 Scan QR Code with WhatsApp to connect');
        this.connectionStatus = 'qr_ready';
        this.emitConnectionStatus();
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== 401;
        console.log('❌ Connection closed. Reconnecting:', shouldReconnect);
        this.connectionStatus = 'disconnected';
        this.emitConnectionStatus();

        if (shouldReconnect) {
          await this.handleReconnection();
        } else {
          console.log('🚫 Authentication failed. Please delete auth_info and restart.');
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connected successfully');
        this.connectionStatus = 'connected';
        this.reconnectAttempts = 0;
        this.emitConnectionStatus();
        await this.db.recordMetric('connection_established', 1);
      }
    });

    this.sock.ev.on('messages.upsert', async (messageUpdate) => {
      await this.handleMessageUpsert(messageUpdate);
    });

    this.sock.ev.on('group-participants.update', async (update) => {
      console.log('👥 Group participants update:', update);
      await this.webhook.sendGroupUpdate(update);
    });
  }

  private async handleMessageUpsert(messageUpdate: { messages: any[], type: MessageUpsertType }): Promise<void> {
    try {
      const startTime = Date.now();
      let processedCount = 0;

      for (const message of messageUpdate.messages) {
        if (!message.message || !message.key) continue;

        const messageData = this.extractMessageData(message);
        if (!messageData) continue;

        // Only process messages from monitored channels
        if (!this.monitoredChannels.has(messageData.target_channel)) continue;

        // Save message to database
        await this.db.saveMessage(messageData);

        // Analyze message for security threats
        const alerts = this.analyzer.analyzeMessage(messageData);
        for (const alert of alerts) {
          await this.db.saveAlert(alert);
          await this.webhook.sendAlert(alert);
        }

        // Send real-time updates
        await this.webhook.sendMessage(messageData);

        processedCount++;
      }

      // Record processing metrics
      const processingTime = Date.now() - startTime;
      await this.db.recordMetric('messages_processed', processedCount);
      await this.db.recordMetric('processing_time_ms', processingTime);

      if (processedCount > 0) {
        console.log(`📨 Processed ${processedCount} messages in ${processingTime}ms`);
      }
    } catch (error) {
      console.error('❌ Message processing error:', error);
      await this.db.recordMetric('processing_errors', 1);
    }
  }

  private extractMessageData(message: any): Message | null {
    try {
      const messageId = message.key.id || `generated-${Date.now()}-${Math.random()}`;
      const remoteJid = message.key.remoteJid;
      const participant = message.key.participant;
      const isFromMe = message.key.fromMe;
      const isGroup = remoteJid?.endsWith('@g.us');

      // Determine target channel and sender
      const targetChannel = isGroup ? remoteJid : (participant || remoteJid);
      const sender = isFromMe ? 'You' : (participant || remoteJid || 'unknown');

      // Extract content and determine message type
      const content = this.extractMessageContent(message);
      const messageType = this.getMessageType(message);

      // Determine message category
      let type = 'message';
      if (isFromMe) type = 'outgoing';
      else if (isGroup) type = 'group';
      else type = 'direct';

      // Extract metadata
      const metadata = this.extractMessageMetadata(message);

      return {
        id: messageId,
        sender,
        target_channel: targetChannel,
        type: messageType,
        content,
        timestamp: Date.now(),
        is_from_me: isFromMe,
        message_type: type,
        metadata
      };
    } catch (error) {
      console.error('❌ Failed to extract message data:', error);
      return null;
    }
  }

  private extractMessageContent(message: any): string {
    if (!message.message) return '';

    return (
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      message.message.imageMessage?.caption ||
      message.message.videoMessage?.caption ||
      message.message.documentMessage?.fileName ||
      message.message.audioMessage?.caption ||
      '[Media message]'
    ).toString();
  }

  private getMessageType(message: any): Message['type'] {
    if (!message.message) return 'other';

    if (message.message.conversation) return 'text';
    if (message.message.imageMessage) return 'image';
    if (message.message.videoMessage) return 'video';
    if (message.message.audioMessage) return 'audio';
    if (message.message.documentMessage) return 'document';
    if (message.message.contactMessage) return 'contact';
    if (message.message.locationMessage) return 'location';

    return 'other';
  }

  private extractMessageMetadata(message: any): Message['metadata'] | undefined {
    const metadata: any = {};

    if (message.message?.imageMessage) {
      metadata.file_size = message.message.imageMessage.fileLength;
      metadata.media_url = message.message.imageMessage.url;
    }

    if (message.message?.videoMessage) {
      metadata.file_size = message.message.videoMessage.fileLength;
      metadata.duration = message.message.videoMessage.seconds;
      metadata.media_url = message.message.videoMessage.url;
    }

    if (message.message?.audioMessage) {
      metadata.duration = message.message.audioMessage.seconds;
      metadata.file_size = message.message.audioMessage.fileLength;
    }

    if (message.message?.locationMessage) {
      metadata.location = {
        lat: message.message.locationMessage.degreesLatitude,
        lng: message.message.locationMessage.degreesLongitude
      };
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('🚫 Max reconnection attempts reached. Manual intervention required.');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff
    
    console.log(`🔄 Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
    
    setTimeout(async () => {
      await this.startSocket();
    }, delay);
  }

  private emitConnectionStatus(): void {
    // This would be connected to Socket.io in the main application
    console.log(`📡 Connection status: ${this.connectionStatus}`);
  }

  async addMonitoredChannel(jid: string): Promise<void> {
    this.monitoredChannels.add(jid);
    console.log(`➕ Added channel to monitoring: ${jid}`);
  }

  async removeMonitoredChannel(jid: string): Promise<void> {
    this.monitoredChannels.delete(jid);
    console.log(`➖ Removed channel from monitoring: ${jid}`);
  }

  getConnectionStatus(): string {
    return this.connectionStatus;
  }

  async sendMessage(jid: string, content: string): Promise<boolean> {
    if (!this.sock || this.connectionStatus !== 'connected') {
      console.error('❌ Cannot send message: WhatsApp not connected');
      return false;
    }

    try {
      await this.sock.sendMessage(jid, { text: content });
      console.log(`📤 Message sent to ${jid}`);
      return true;
    } catch (error) {
      console.error('❌ Failed to send message:', error);
      return false;
    }
  }

  async cleanup(): Promise<void> {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (error) {
        console.warn('⚠️ Error during logout:', error);
      }
    }
    this.analyzer.cleanupRateLimitData();
  }
}