import fetch from 'node-fetch';
import { Message, Alert } from '../types/index.js';

export class WebhookManager {
  private readonly webhookUrl: string;
  private readonly retryAttempts: number = 3;
  private readonly retryDelay: number = 1000;
  private readonly timeout: number = 10000;
  private failedWebhooks: number = 0;
  private lastSuccessfulWebhook: number = 0;

  constructor(webhookUrl: string = '') {
    this.webhookUrl = webhookUrl;
  }

  async sendMessage(message: Message): Promise<void> {
    if (!this.webhookUrl) return;

    const payload = {
      event: 'new_message',
      timestamp: Date.now(),
      data: {
        id: message.id,
        sender: message.sender,
        target_channel: message.target_channel,
        type: message.type,
        content: message.content,
        message_type: message.message_type,
        is_from_me: message.is_from_me,
        risk_score: message.risk_score,
        formatted_time: new Date(message.timestamp).toLocaleString(),
        metadata: message.metadata
      }
    };

    await this.sendWebhook(payload);
  }

  async sendAlert(alert: Alert): Promise<void> {
    if (!this.webhookUrl) return;

    const payload = {
      event: 'security_alert',
      timestamp: Date.now(),
      data: {
        id: alert.id,
        type: alert.type,
        severity: alert.severity,
        channel_jid: alert.channel_jid,
        description: alert.description,
        message_id: alert.message_id,
        metadata: alert.metadata
      }
    };

    await this.sendWebhook(payload);
  }

  async sendGroupUpdate(update: any): Promise<void> {
    if (!this.webhookUrl) return;

    const payload = {
      event: 'group_participants_update',
      timestamp: Date.now(),
      data: update
    };

    await this.sendWebhook(payload);
  }

  async sendSystemAlert(type: string, message: string, severity: 'low' | 'medium' | 'high' = 'medium'): Promise<void> {
    if (!this.webhookUrl) return;

    const payload = {
      event: 'system_alert',
      timestamp: Date.now(),
      data: {
        type,
        message,
        severity,
        system_info: {
          memory_usage: process.memoryUsage(),
          uptime: process.uptime(),
          platform: process.platform
        }
      }
    };

    await this.sendWebhook(payload);
  }

  private async sendWebhook(payload: any, attempt: number = 1): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Monitor/1.0',
          'X-Webhook-Signature': this.generateSignature(payload)
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.lastSuccessfulWebhook = Date.now();
      this.failedWebhooks = Math.max(0, this.failedWebhooks - 1); // Reduce failure count on success
      console.log(`📤 Webhook sent successfully (${payload.event})`);
    } catch (error) {
      this.failedWebhooks++;
      console.warn(`⚠️ Webhook failed (attempt ${attempt}/${this.retryAttempts}):`, error.message);

      if (attempt < this.retryAttempts) {
        const delay = this.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
        setTimeout(() => {
          this.sendWebhook(payload, attempt + 1);
        }, delay);
      } else {
        console.error(`❌ Webhook failed after ${this.retryAttempts} attempts`);
      }
    }
  }

  private generateSignature(payload: any): string {
    // Simple signature for webhook verification
    const content = JSON.stringify(payload);
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `sha256=${hash.toString(16)}`;
  }

  async testWebhook(): Promise<{ success: boolean; message: string; response_time?: number }> {
    if (!this.webhookUrl) {
      return { success: false, message: 'No webhook URL configured' };
    }

    const startTime = Date.now();
    
    try {
      const payload = {
        event: 'webhook_test',
        timestamp: Date.now(),
        message: 'Test webhook from WhatsApp Monitor',
        test_data: {
          version: '1.0.0',
          system: process.platform,
          node_version: process.version
        }
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Monitor/1.0'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;

      if (response.ok) {
        this.lastSuccessfulWebhook = Date.now();
        return { 
          success: true, 
          message: 'Webhook test successful',
          response_time: responseTime
        };
      } else {
        return { 
          success: false, 
          message: `HTTP ${response.status}: ${response.statusText}`,
          response_time: responseTime
        };
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return { 
        success: false, 
        message: (error as Error).message,
        response_time: responseTime
      };
    }
  }

  getWebhookStats(): {
    url_configured: boolean;
    failed_webhooks: number;
    last_successful: number | null;
    health_status: 'healthy' | 'degraded' | 'unhealthy';
  } {
    const now = Date.now();
    const timeSinceLastSuccess = this.lastSuccessfulWebhook ? now - this.lastSuccessfulWebhook : null;
    
    let healthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (this.failedWebhooks > 10) healthStatus = 'unhealthy';
    else if (this.failedWebhooks > 5 || (timeSinceLastSuccess && timeSinceLastSuccess > 300000)) healthStatus = 'degraded';

    return {
      url_configured: !!this.webhookUrl,
      failed_webhooks: this.failedWebhooks,
      last_successful: this.lastSuccessfulWebhook,
      health_status: healthStatus
    };
  }
}