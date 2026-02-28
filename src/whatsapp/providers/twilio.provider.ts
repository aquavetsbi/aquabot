import type { WhatsAppProvider, IncomingMessage } from '../types';
import { BotError } from '../../shared/errors';
import { logger } from '../../shared/logger';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Número Twilio en formato whatsapp:+14155238886 */
  fromNumber: string;
}

/**
 * TwilioProvider — stub completo.
 *
 * Diferencia clave vs Baileys:
 *   - Twilio NO usa conexión persistente.
 *   - Los mensajes llegan vía HTTP webhook (POST /api/whatsapp/twilio/incoming).
 *   - El handler se registra aquí pero es invocado por el webhook controller.
 *
 * Para activar: implementar los métodos marcados con TODO
 * y registrar TwilioWebhookController en Express.
 */
export class TwilioProvider implements WhatsAppProvider {
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;

  constructor(private readonly config: TwilioConfig) {
    logger.info('TwilioProvider initialized (stub mode)');
  }

  getProviderType() {
    return 'twilio' as const;
  }

  /**
   * Registra el handler — será llamado por TwilioWebhookController
   * cuando llegue un POST al webhook de Twilio.
   */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
    logger.info('TwilioProvider: handler registered — waiting for webhook calls');
  }

  /**
   * Expone el handler para que el webhook controller lo invoque.
   * TwilioWebhookController normaliza el payload de Twilio a IncomingMessage
   * y llama a este método.
   */
  async handleWebhookMessage(msg: IncomingMessage): Promise<void> {
    if (!this.messageHandler) {
      logger.warn('TwilioProvider: no handler registered');
      return;
    }
    await this.messageHandler(msg);
  }

  async sendMessage(to: string, text: string): Promise<void> {
    // TODO: implementar con Twilio SDK
    // const client = twilio(this.config.accountSid, this.config.authToken);
    // await client.messages.create({
    //   from: `whatsapp:${this.config.fromNumber}`,
    //   to:   `whatsapp:${to}`,
    //   body: text,
    // });
    logger.warn({ to, text }, 'TwilioProvider.sendMessage — NOT IMPLEMENTED');
    throw new Error('TwilioProvider not yet implemented');
  }

  async sendError(to: string, error: BotError): Promise<void> {
    await this.sendMessage(to, `⚠️ ${error.userMessage}`);
  }

  /**
   * Twilio requiere responder HTTP 200 al webhook.
   * El ACK real ocurre en TwilioWebhookController (res.sendStatus(200)).
   */
  async ack(_messageId: string): Promise<void> {
    // no-op — webhook controller responde 200
  }

  async disconnect(): Promise<void> {
    // no persistent connection to close
    logger.info('TwilioProvider disconnected (no-op)');
  }
}
