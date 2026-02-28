import type { BotError } from '../shared/errors';

export type ProviderType = 'baileys' | 'twilio';

export interface IncomingMessage {
  /** ID único del mensaje — proviene del provider. */
  id: string;
  /** Número en formato E.164: +573001234567 */
  from: string;
  /** Buffer de la imagen (Baileys). */
  mediaBuffer?: Buffer;
  /** URL pública de la imagen (Twilio). */
  mediaUrl?: string;
  mediaMimeType?: string;
  timestamp: Date;
  providerType: ProviderType;
}

/**
 * Contrato que TODOS los providers deben cumplir.
 * La lógica de negocio solo habla con esta interface.
 */
export interface WhatsAppProvider {
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  sendMessage(to: string, text: string): Promise<void>;
  sendError(to: string, error: BotError): Promise<void>;
  ack(messageId: string): Promise<void>;
  getProviderType(): ProviderType;
  disconnect(): Promise<void>;
}

export type { BotError };
