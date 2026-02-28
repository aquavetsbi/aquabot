import type { WhatsAppProvider, IncomingMessage } from '../whatsapp/types';
import type { OcrPipeline } from '../ocr/pipeline';
import type { RedisClient } from '../infrastructure/redis.client';
import type { SupabaseRepo } from '../infrastructure/supabase.client';
import { BotError } from '../shared/errors';
import { logger } from '../shared/logger';

const RATE_LIMIT_PER_MIN = 10;

export class MessageGatewayService {
  constructor(
    private readonly provider: WhatsAppProvider,
    private readonly ocr: OcrPipeline,
    private readonly redis: RedisClient,
    private readonly db: SupabaseRepo,
  ) {
    this.provider.onMessage((msg) => this.handle(msg));
    logger.info({ provider: provider.getProviderType() }, 'MessageGatewayService ready');
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  private async handle(msg: IncomingMessage): Promise<void> {
    logger.info({ msgId: msg.id, from: msg.from }, 'Incoming message');

    try {
      await this.processMessage(msg);
    } catch (err) {
      logger.error({ err, msgId: msg.id }, 'Unhandled error in message handler');

      const botError =
        err instanceof BotError
          ? err
          : new BotError('PROVIDER_ERROR', 'Ocurrió un error inesperado. Por favor reintenta.');

      await this.provider.sendError(msg.from, botError).catch((e) =>
        logger.error({ e }, 'Failed to send error to user'),
      );
    }
  }

  private async processMessage(msg: IncomingMessage): Promise<void> {
    // ── 1. Rate limiting ──────────────────────────────────────────────────
    const count = await this.redis.incrementWithTtl(`rate:limit:${msg.from}`, 60);
    if (count > RATE_LIMIT_PER_MIN) return;

    // ── 2. Deduplicación ──────────────────────────────────────────────────
    const dedupKey = `dedup:msg:${msg.providerType}:${msg.id}`;
    if (await this.redis.get(dedupKey)) {
      logger.info({ msgId: msg.id }, 'Duplicate — skipped');
      return;
    }
    await this.redis.set(dedupKey, '1', { ttlSeconds: 86_400 });

    // ── 3. Resolver usuario (con cache 10 min) ────────────────────────────
    const cacheKey = `user:phone:${msg.from}`;
    let user: { id: string; orgId: string } | null = null;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      user = JSON.parse(cached) as { id: string; orgId: string };
    } else {
      user = await this.db.findUserByPhone(msg.from);
      if (user) await this.redis.set(cacheKey, JSON.stringify(user), { ttlSeconds: 600 });
    }

    if (!user) {
      await this.provider.sendError(
        msg.from,
        new BotError('USER_NOT_FOUND', 'Tu número no está registrado en AquaData. Contacta a tu administrador.'),
      );
      return;
    }

    // ── 4. Validar imagen ─────────────────────────────────────────────────
    if (!msg.mediaBuffer && !msg.mediaUrl) {
      await this.provider.sendMessage(
        msg.from,
        '📋 Para registrar un reporte, envía una *foto* del formulario de campo.',
      );
      return;
    }

    // ── 5. Descargar imagen (si viene como URL en Twilio) ─────────────────
    const imageBuffer = msg.mediaBuffer ?? await this.downloadRemoteImage(msg.mediaUrl!);

    // ── 6. Subir imagen a Supabase Storage ────────────────────────────────
    const storagePath = `${user.orgId}/${Date.now()}_${msg.id.slice(0, 8)}.jpg`;
    const imageUrl = await this.db.uploadImage(imageBuffer, storagePath);

    // ── 7. Crear upload (= whatsapp_message + ocr_job en un solo registro) ─
    const upload = await this.db.createUpload({
      userId:           user.id,
      imageUrl,
      whatsappProvider: msg.providerType,
      whatsappMsgId:    msg.id,
      senderPhone:      msg.from,
    });

    // ── 8. Ejecutar OCR ───────────────────────────────────────────────────
    await this.runOcr({ uploadId: upload.id, user, msg, imageBuffer });
  }

  // ─── OCR pipeline ─────────────────────────────────────────────────────────

  private async runOcr(ctx: {
    uploadId: string;
    user: { id: string; orgId: string };
    msg: IncomingMessage;
    imageBuffer: Buffer;
  }): Promise<void> {
    const lockKey = `lock:upload:${ctx.uploadId}`;
    const locked  = await this.redis.setnx(lockKey, '1', 300);

    if (!locked) {
      logger.warn({ uploadId: ctx.uploadId }, 'Upload already locked');
      return;
    }

    try {
      // Ejecutar pipeline OCR
      const result = await this.ocr.run({
        jobId:       ctx.uploadId,
        imageBuffer: ctx.imageBuffer,
        mimeType:    ctx.msg.mediaMimeType ?? 'image/jpeg',
      });

      // Persistir resultado en uploads.processed_data / ocr_field_confidences
      await this.db.updateUploadWithOcrResult({ uploadId: ctx.uploadId, result });

      // ── Imagen rechazada por OCR (faltan campos críticos) ──
      if (!result.isValid) {
        const missing = result.rejectionReasons
          .map((r) => r.replace('missing_', ''))
          .join(' ni ');

        await this.provider.sendError(
          ctx.msg.from,
          new BotError(
            'MISSING_CRITICAL_FIELDS',
            `No pude detectar ${missing} en tu reporte. Envía una foto más clara o con mejor iluminación.`,
          ),
        );
        return;
      }

      // ── Intentar resolver estanque → lote automáticamente ──
      let batchId: string | undefined;

      const pondName = result.fields.estanque.value;
      if (pondName) {
        const pond = await this.db.findPondByName(ctx.user.orgId, pondName);
        if (pond) {
          const batch = await this.db.findActiveBatch(pond.id);
          if (batch) {
            batchId = batch.id;
          } else {
            logger.info({ pondName, pondId: pond.id }, 'No active batch found for pond');
          }
        } else {
          logger.info({ pondName, orgId: ctx.user.orgId }, 'Pond not found in catalogue');
        }
      }

      // ── Crear production_record en PENDING_REVIEW ──
      await this.db.createProductionRecord({
        uploadId: ctx.uploadId,
        batchId,
        result,
      });

      const batchMsg = batchId
        ? ''
        : '\n_El estanque no está en el catálogo — el admin asignará el lote._';

      await this.provider.sendMessage(
        ctx.msg.from,
        `✅ Reporte recibido. Un administrador lo revisará y confirmará en breve.${batchMsg}`,
      );

    } catch (err) {
      const botError =
        err instanceof BotError
          ? err
          : new BotError('OCR_FAILED', 'Error procesando tu reporte. Por favor reenvía la foto.');

      await this.provider.sendError(ctx.msg.from, botError);
      logger.error({ err, uploadId: ctx.uploadId }, 'OCR pipeline failed');

    } finally {
      await this.redis.del(lockKey);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async downloadRemoteImage(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new BotError(
        'INVALID_IMAGE',
        'No pude descargar la imagen. Por favor reenvía la foto.',
        new Error(`HTTP ${res.status} from ${url}`),
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
