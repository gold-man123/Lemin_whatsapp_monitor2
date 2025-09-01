export interface Message {
  id: string;
  sender: string;
  target_channel: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'contact' | 'location' | 'other';
  content: string;
  timestamp: number;
  is_from_me: boolean;
  message_type: string;
  metadata?: {
    media_url?: string;
    file_size?: number;
    duration?: number;
    location?: { lat: number; lng: number };
  };
}

export interface Channel {
  id: number;
  jid: string;
  label: string;
  is_active: boolean;
  created_at: number;
  last_message_at?: number;
  message_count?: number;
  risk_score?: number;
  category?: 'personal' | 'business' | 'group' | 'broadcast';
}

export interface Alert {
  id: string;
  type: 'spam_detected' | 'rate_limit_exceeded' | 'suspicious_pattern' | 'keyword_match';
  severity: 'low' | 'medium' | 'high' | 'critical';
  channel_jid: string;
  message_id?: string;
  description: string;
  timestamp: number;
  is_resolved: boolean;
}

export interface SystemStats {
  total_messages: number;
  total_channels: number;
  recent_messages: number;
  active_alerts: number;
  connection_status: string;
  uptime: number;
  processing_rate: number;
}