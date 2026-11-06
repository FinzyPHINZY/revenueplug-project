
export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  uptime: number;
  checks: {
    postgres: boolean;
    redis: boolean;
    kafka: boolean;
    clickhouse: boolean;
  };
}

export interface LivenessStatus {
  status: 'alive';
  timestamp: string;
}

export interface ReadinessStatus {
  status: 'ready' | 'not_ready';
  timestamp: string;
  checks: {
    postgres: boolean;
    redis: boolean;
    kafka: boolean;
    clickhouse: boolean;
  };
}
