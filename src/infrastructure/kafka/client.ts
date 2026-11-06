import { Kafka, logLevel, type Producer } from 'kafkajs';
import { config } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';



let kafkaClient: Kafka | null = null;
let kafkaProducer: Producer | null = null;


function createKafkaClient(): Kafka {
  return new Kafka({
    clientId: config.KAFKA_CLIENT_ID,
    brokers: config.KAFKA_BROKERS,
    logLevel: logLevel.ERROR,
    retry: {
      initialRetryTime: 100,
      retries: 8,
    },
  });
}


export function getKafkaProducer(): Producer {
  if (!kafkaProducer) {
    throw new Error('Kafka producer not initialized. Call connectKafka() first.');
  }
  return kafkaProducer;
}

export async function connectKafka(): Promise<void> {
  try {
    kafkaClient = createKafkaClient();
    kafkaProducer = kafkaClient.producer({
      allowAutoTopicCreation: true,
      idempotent: true,
      maxInFlightRequests: 5,
      retry: {
        initialRetryTime: 300,
        retries: 10,
      },
    });

    await kafkaProducer.connect();
    logger.info('Connected to Kafka');
  } catch (error) {
    logger.error({ error }, 'Failed to connect to Kafka');
    throw error;
  }
}


export async function disconnectKafka(): Promise<void> {
  try {
    if (kafkaProducer) {
      await kafkaProducer.disconnect();
      kafkaProducer = null;
    }
    kafkaClient = null;
    logger.info('Disconnected from Kafka');
  } catch (error) {
    logger.error({ error }, 'Error disconnecting from Kafka');
    throw error;
  }
}

export async function checkKafkaHealth(): Promise<boolean> {
  try {
    if (!kafkaClient) {
      return false;
    }

    const admin = kafkaClient.admin();
    await admin.connect();
    await admin.listTopics();
    await admin.disconnect();

    return true;
  } catch (error) {
    logger.error({ error }, 'Kafka health check failed');
    return false;
  }
}
