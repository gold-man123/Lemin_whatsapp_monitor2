export interface Message {
  id: string;
  sender: string;
  target_channel: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'contact' | 'location' | 'other';
  content: string;
  timestamp: number;
  is_from_me: boolean;
  message_type: string;
  risk_score?: number;
  metadata?: {
    media_url?: string;
    file_size?: number;
    duration?: number;
    mime_type?: string;
    file_name?: string;
    location?: { lat: number; lng: number };
    [key: string]: any;
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
  metadata?: {
    description?: string;
    participant_count?: number;
    admin_count?: number;
    [key: string]: any;
  };
}

export interface Alert {
  id: string;
  type: 'spam_detected' | 'rate_limit_exceeded' | 'suspicious_pattern' | 'keyword_match' | 'behavioral_anomaly' | 'duplicate_content';
  severity: 'low' | 'medium' | 'high' | 'critical';
  channel_jid: string;
  message_id?: string;
  description: string;
  timestamp: number;
  is_resolved: boolean;
  metadata?: {
    spam_score?: number;
    reasons?: string[];
    patterns?: string[];
    confidence?: number;
    anomalies?: string[];
    [key: string]: any;
  };
}

export interface SystemStats {
  total_messages: number;
  total_channels: number;
  recent_messages: number;
  active_alerts: number;
  connection_status: string;
  uptime: number;
  processing_rate: number;
  top_channels?: Array<{
    target_channel: string;
    message_count: number;
    last_message: number;
  }>;
  hourly_stats?: Array<{
    hour: string;
    message_count: number;
  }>;
}

export interface PerformanceMetric {
  name: string;
  value: number;
  timestamp: number;
  metadata?: any;
}

export interface SecurityEvent {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  timestamp: number;
  source: string;
  metadata?: any;
}