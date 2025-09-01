import fetch from 'node-fetch';
import { Message, Alert } from '../types/index.js';

export class WebhookManager {
  private readonly webhookUrl: string;
  private readonly retryAttempts: number = 3;
  private readonly retryDelay: number = 1000;

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
        formatted_time: new Date(message.timestamp).toLocaleString()
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
        message_id: alert.message_id
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
        severity
      }
    };

    await this.sendWebhook(payload);
  }

  private async sendWebhook(payload: any, attempt: number = 1): Promise<void> {
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Monitor/1.0'
        },
        body: JSON.stringify(payload),
        timeout: 10000
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      console.log(`📤 Webhook sent successfully (${payload.event})`);
    } catch (error) {
      console.warn(`⚠️ Webhook failed (attempt ${attempt}/${this.retryAttempts}):`, error.message);

      if (attempt < this.retryAttempts) {
        setTimeout(() => {
          this.sendWebhook(payload, attempt + 1);
        }, this.retryDelay * attempt);
      } else {
        console.error(`❌ Webhook failed after ${this.retryAttempts} attempts`);
      }
    }
  }

  async testWebhook(): Promise<{ success: boolean; message: string }> {
    if (!this.webhookUrl) {
      return { success: false, message: 'No webhook URL configured' };
    }

    try {
      const payload = {
        event: 'webhook_test',
        timestamp: Date.now(),
        message: 'Test webhook from WhatsApp Monitor'
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 5000
      });

      if (response.ok) {
        return { success: true, message: 'Webhook test successful' };
      } else {
        return { success: false, message: `HTTP ${response.status}: ${response.statusText}` };
      }
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}