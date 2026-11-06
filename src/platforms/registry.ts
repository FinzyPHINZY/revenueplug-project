import { logger } from '../shared/logger/index.js';
import type { AuthType, Platform } from '../shared/types/index.js';
import type { IPlatformAdapter } from './types.js';


class PlatformRegistry {
  private adapters: Map<Platform, IPlatformAdapter> = new Map();


  register(adapter: IPlatformAdapter): void {
    if (this.adapters.has(adapter.platform)) {
      logger.warn({ platform: adapter.platform }, 'Platform adapter already registered, replacing');
    }

    this.adapters.set(adapter.platform, adapter);
    logger.info({ platform: adapter.platform }, 'Platform adapter registered');
  }


  getAdapter(platform: Platform): IPlatformAdapter {
    const adapter = this.adapters.get(platform);

    if (!adapter) {
      throw new Error(`No adapter registered for platform: ${platform}`);
    }

    return adapter;
  }

  isSupported(platform: Platform): boolean {
    return this.adapters.has(platform);
  }


  getSupportedPlatforms(): Platform[] {
    return Array.from(this.adapters.keys());
  }


  getSupportedAuthTypes(platform: Platform): AuthType[] {
    const adapter = this.adapters.get(platform);
    return adapter ? adapter.supportedAuthTypes : [];
  }


  getAllAdapters(): IPlatformAdapter[] {
    return Array.from(this.adapters.values());
  }


  clear(): void {
    this.adapters.clear();
  }
}

export const platformRegistry = new PlatformRegistry();


export async function initializePlatformRegistry(): Promise<void> {
  logger.info('Initializing platform registry');

  try {

    const { stripeAdapter } = await import('./stripe/adapter.js');
    const { polarAdapter } = await import('./polar/adapter.js');

    platformRegistry.register(stripeAdapter);
    platformRegistry.register(polarAdapter);

    logger.info(
      { platforms: platformRegistry.getSupportedPlatforms() },
      'Platform registry initialized'
    );
  } catch (error) {
    logger.error({ error }, 'Failed to initialize platform registry');
    throw error;
  }
}
