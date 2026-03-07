import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  downloadMediaMessage,
  type proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import type { WhatsAppProvider, IncomingMessage } from '../types';
import { BotError } from '../../shared/errors';
import { logger } from '../../shared/logger';

export interface BaileysConfig {
  authFolder: string;
}

export class BaileysProvider implements WhatsAppProvider {
  private sock!: ReturnType<typeof makeWASocket>;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  private reconnectAttempts = 0;

  /**
   * Mapa LID → JID de teléfono (@s.whatsapp.net).
   * contacts.upsert llega ~1-2 s después de la conexión.
   * Por eso bufferizamos mensajes hasta que isReady=true.
   */
  private readonly lidToJid = new Map<string, string>();
  private pendingMessages: proto.IWebMessageInfo[] = [];
  private isReady = false;
  private static readonly READY_DELAY_MS = 8_000;

  constructor(private readonly config: BaileysConfig) {}

  getProviderType() {
    return 'baileys' as const;
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
    void this.connect();
  }

  async sendMessage(to: string, text: string): Promise<void> {
    await this.sock.sendMessage(this.toJid(to), { text });
  }

  async sendError(to: string, error: BotError): Promise<void> {
    await this.sendMessage(to, `⚠️ ${error.userMessage}`);
  }

  async ack(_messageId: string): Promise<void> {
    // Baileys hace ACK automáticamente
  }

  async disconnect(): Promise<void> {
    await this.sock.end(undefined);
    logger.info('BaileysProvider disconnected');
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.config.authFolder);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: logger.child({ component: 'baileys' }) as Parameters<typeof makeWASocket>[0]['logger'],
      syncFullHistory: true,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    // Poblar lidToJid desde eventos de contactos.
    // Cada Contact puede tener:
    //   - id   = JID en cualquier formato
    //   - lid  = JID en formato @lid
    //   - jid  = JID en formato @s.whatsapp.net
    // Mapeamos: lid → jid (o lid → id si id es @s.whatsapp.net)
    const indexContacts = (contacts: Array<{ id?: string; lid?: string; jid?: string }>) => {
      for (const c of contacts) {
        const phoneJid = c.jid ?? (c.id?.includes('@s.whatsapp.net') ? c.id : undefined);
        const lidJid   = c.lid ?? (c.id?.includes('@lid') ? c.id : undefined);
        if (lidJid && phoneJid) {
          this.lidToJid.set(lidJid, phoneJid);
          logger.debug({ lid: lidJid, phone: phoneJid }, 'LID mapped');
        }
      }
    };
    this.sock.ev.on('messaging-history.set', ({ contacts }) => {
      logger.info({ count: contacts.length, sample: contacts.slice(0, 3) }, 'messaging-history.set contacts received');
      indexContacts(contacts);
      logger.info({ mapSize: this.lidToJid.size }, 'lidToJid map after messaging-history.set');
    });
    this.sock.ev.on('contacts.upsert', indexContacts);
    this.sock.ev.on('contacts.update', indexContacts);

    this.sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        logger.info('Scan the QR code below:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.reconnectAttempts = 0;
        logger.info('WhatsApp connected ✓');

        // Esperar READY_DELAY_MS para que contacts.upsert se complete
        // antes de procesar mensajes (resuelve la race condition con @lid).
        this.isReady = false;
        setTimeout(() => {
          this.isReady = true;
          const queued = this.pendingMessages.splice(0);
          if (queued.length) {
            logger.info({ count: queued.length }, 'Flushing buffered messages');
          }
          for (const raw of queued) void this.processRawMessage(raw);
        }, BaileysProvider.READY_DELAY_MS);
      }

      if (connection === 'close') {
        this.isReady = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        logger.warn({ statusCode, shouldReconnect }, 'WhatsApp connection closed');

        if (shouldReconnect) {
          this.reconnectAttempts++;
          const delay = Math.min(3_000 * this.reconnectAttempts, 30_000);
          logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Scheduling reconnect...');
          setTimeout(() => void this.connect(), delay);
        } else {
          logger.error('WhatsApp logged out — delete auth folder and restart');
        }
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const raw of messages) {
        if (!this.isReady) {
          this.pendingMessages.push(raw);
        } else {
          void this.processRawMessage(raw);
        }
      }
    });
  }

  private async processRawMessage(raw: proto.IWebMessageInfo): Promise<void> {
    if (!raw.message || raw.key.fromMe) return;

    const incoming = await this.normalize(raw);
    if (!incoming) return;

    if (this.messageHandler) {
      await this.messageHandler(incoming).catch((err) => {
        logger.error({ err, msgId: incoming.id }, 'Message handler error');
      });
    }
  }

  private async normalize(raw: proto.IWebMessageInfo): Promise<IncomingMessage | null> {
    const originalJid = raw.key.remoteJid ?? '';
    if (!originalJid) return null;

    // 0. En mensajes LID, Baileys puede incluir el número real en senderPn/participantPn.
    const keyWithPn = raw.key as proto.IMessageKey & { senderPn?: string; participantPn?: string };
    const pnCandidate =
      this.extractPhoneJid(keyWithPn.senderPn) ??
      this.extractPhoneJid(keyWithPn.participantPn) ??
      this.extractPhoneJid(raw.key.participant);

    // Resolver @lid → número de teléfono
    let resolvedJid = originalJid;
    if (pnCandidate) {
      resolvedJid = pnCandidate;
      if (originalJid.includes('@lid')) {
        this.lidToJid.set(originalJid, pnCandidate);
      }
      logger.debug({ lid: originalJid, phone: resolvedJid }, 'Resolved sender via message key pn');
    } else if (originalJid.includes('@lid')) {
      // 1. Mapa en memoria (poblado por contacts.set / contacts.upsert)
      const fromMap = this.lidToJid.get(originalJid);
      if (fromMap) {
        resolvedJid = fromMap;
        logger.debug({ lid: originalJid, phone: resolvedJid }, 'Resolved @lid via map');
      } else {
        logger.warn({ lid: originalJid }, '@lid sin resolver — el usuario no está en contactos del bot');
      }
    }

    const from = resolvedJid
      .replace('@s.whatsapp.net', '')
      .replace('@g.us', '')
      .replace('@lid', '');

    const base = {
      id: raw.key.id ?? `baileys-${Date.now()}`,
      from,
      replyJid: originalJid,
      timestamp: new Date(Number(raw.messageTimestamp ?? 0) * 1000),
      providerType: 'baileys' as const,
    };

    // ── Imagen ──────────────────────────────────────────────────────────────
    const imageMsg =
      raw.message?.imageMessage ??
      raw.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

    if (imageMsg) {
      try {
        const downloaded = await downloadMediaMessage(raw, 'buffer', {});
        return {
          ...base,
          mediaBuffer: downloaded as Buffer,
          mediaMimeType: imageMsg.mimetype ?? 'image/jpeg',
        };
      } catch (err) {
        logger.error({ err, msgId: raw.key.id }, 'Failed to download media');
        return null;
      }
    }

    // ── Texto ────────────────────────────────────────────────────────────────
    const text =
      raw.message?.conversation ??
      raw.message?.extendedTextMessage?.text;

    if (text) {
      return { ...base, textBody: text };
    }

    return null; // stickers, audio, video, etc.
  }

  /** Intenta convertir un JID/cadena en formato de teléfono @s.whatsapp.net. */
  private extractPhoneJid(value?: string | null): string | null {
    if (!value) return null;
    if (value.includes('@s.whatsapp.net')) return value;

    const digits = value.replace(/\D/g, '');
    if (digits.length < 8) return null;

    return `${digits}@s.whatsapp.net`;
  }

  /** Convierte número/JID a JID completo. Si ya tiene '@' lo usa tal cual. */
  private toJid(phone: string): string {
    if (phone.includes('@')) return phone;
    return phone.replace('+', '') + '@s.whatsapp.net';
  }
}
