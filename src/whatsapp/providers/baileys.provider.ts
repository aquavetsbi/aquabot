import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  type proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import type { WhatsAppProvider, IncomingMessage } from '../types';
import { BotError } from '../../shared/errors';
import { logger } from '../../shared/logger';

export interface BaileysConfig {
  /** Carpeta donde Baileys persiste el estado de sesión QR. */
  authFolder: string;
}

export class BaileysProvider implements WhatsAppProvider {
  private sock!: ReturnType<typeof makeWASocket>;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;

  constructor(private readonly config: BaileysConfig) {}

  getProviderType() {
    return 'baileys' as const;
  }

  /**
   * Registra el handler y abre la conexión WhatsApp.
   * El caller no necesita saber nada de Baileys.
   */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
    void this.connect();
  }

  async sendMessage(to: string, text: string): Promise<void> {
    const jid = this.toJid(to);
    await this.sock.sendMessage(jid, { text });
  }

  async sendError(to: string, error: BotError): Promise<void> {
    await this.sendMessage(to, `⚠️ ${error.userMessage}`);
  }

  /**
   * Baileys hace ACK automáticamente al recibir el mensaje.
   * Método presente para mantener la interface uniforme con Twilio.
   */
  async ack(_messageId: string): Promise<void> {
    // no-op
  }

  async disconnect(): Promise<void> {
    await this.sock.end(undefined);
    logger.info('BaileysProvider disconnected');
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.config.authFolder);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: logger.child({ component: 'baileys' }) as Parameters<typeof makeWASocket>[0]['logger'],
      // Reducir uso de memoria en producción
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        logger.info('WhatsApp QR code ready — scan it in the terminal');
      }

      if (connection === 'open') {
        logger.info('WhatsApp connected ✓');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn({ statusCode, shouldReconnect }, 'WhatsApp connection closed');

        if (shouldReconnect) {
          setTimeout(() => void this.connect(), 3_000);
        } else {
          logger.error('WhatsApp logged out — delete auth folder and restart');
        }
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const raw of messages) {
        void this.processRawMessage(raw);
      }
    });
  }

  private async processRawMessage(raw: proto.IWebMessageInfo): Promise<void> {
    // Ignorar mensajes propios y sin contenido
    if (!raw.message || raw.key.fromMe) return;

    const incoming = await this.normalize(raw);
    if (!incoming) return;

    if (this.messageHandler) {
      await this.messageHandler(incoming).catch((err) => {
        logger.error({ err, messageId: incoming.id }, 'Message handler error');
      });
    }
  }

  private async normalize(raw: proto.IWebMessageInfo): Promise<IncomingMessage | null> {
    const imageMsg =
      raw.message?.imageMessage ??
      raw.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

    if (!imageMsg) return null; // solo imágenes

    let mediaBuffer: Buffer | undefined;

    try {
      const downloaded = await downloadMediaMessage(raw, 'buffer', {});
      mediaBuffer = downloaded as Buffer;
    } catch (err) {
      logger.error({ err, messageId: raw.key.id }, 'Failed to download media');
      return null;
    }

    return {
      id: raw.key.id ?? `baileys-${Date.now()}`,
      from: (raw.key.remoteJid ?? '').replace('@s.whatsapp.net', '').replace('@g.us', ''),
      mediaBuffer,
      mediaMimeType: imageMsg.mimetype ?? 'image/jpeg',
      timestamp: new Date(Number(raw.messageTimestamp ?? 0) * 1000),
      providerType: 'baileys',
    };
  }

  /** +573001234567 → 573001234567@s.whatsapp.net */
  private toJid(phone: string): string {
    return phone.replace('+', '') + '@s.whatsapp.net';
  }
}
