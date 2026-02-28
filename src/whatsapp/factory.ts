import type { WhatsAppProvider } from './types';
import { BaileysProvider, type BaileysConfig } from './providers/baileys.provider';
import { TwilioProvider, type TwilioConfig } from './providers/twilio.provider';

export type ProviderConfig =
  | { type: 'baileys'; config: BaileysConfig }
  | { type: 'twilio'; config: TwilioConfig };

export class WhatsAppProviderFactory {
  static create(providerConfig: ProviderConfig): WhatsAppProvider {
    switch (providerConfig.type) {
      case 'baileys':
        return new BaileysProvider(providerConfig.config);

      case 'twilio':
        return new TwilioProvider(providerConfig.config);

      default: {
        // TypeScript exhaustiveness check — falla en compile time si falta un case.
        const _exhaustive: never = providerConfig;
        throw new Error(`Unknown WhatsApp provider: ${(_exhaustive as { type: string }).type}`);
      }
    }
  }
}
