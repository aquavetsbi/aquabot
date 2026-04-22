import type { WhatsAppProvider, IncomingMessage } from '../whatsapp/types';
import type { OcrPipeline } from '../ocr/pipeline';
import type { DraftService, OcrDraft } from '../ocr/draft.service';
import type { ChatService } from '../ai/chat.service';
import type { RedisClient } from '../infrastructure/redis.client';
import type { SupabaseRepo } from '../infrastructure/supabase.client';
import type { OcrData } from '../ocr/types';
import { BotError } from '../shared/errors';
import { logger } from '../shared/logger';
import { config } from '../config';

const RATE_LIMIT_PER_MIN = 10;
const REPORT_POND_SELECTION_TTL_SEC = 15 * 60;
const SELECTED_POND_TTL_SEC = 6 * 60 * 60;

export class MessageGatewayService {
  constructor(
    private readonly provider: WhatsAppProvider,
    private readonly ocr: OcrPipeline,
    private readonly draft: DraftService,
    private readonly chat: ChatService,
    private readonly redis: RedisClient,
    private readonly db: SupabaseRepo,
  ) {
    this.provider.onMessage((msg) => this.handle(msg));
    logger.info({ provider: provider.getProviderType() }, 'MessageGatewayService ready');
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  private async handle(msg: IncomingMessage): Promise<void> {
    logger.info(
      { msgId: msg.id, from: msg.from, type: msg.mediaBuffer ? 'image' : msg.textBody ? 'text' : 'other' },
      'Incoming message',
    );

    try {
      await this.processMessage(msg);
    } catch (err) {
      logger.error({ err, msgId: msg.id }, 'Unhandled error in message handler');
      const botError = err instanceof BotError
        ? err
        : new BotError('PROVIDER_ERROR', 'Ocurrió un error inesperado. Por favor reintenta.');
      await this.provider.sendError(this.replyTo(msg), botError).catch(() => undefined);
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

    // ── 3. Verificar usuario habilitado ──────────────────────────────────
    const user = await this.resolveUser(msg.from);
    if (!user) {
      await this.provider.sendMessage(
        this.replyTo(msg),
        '⛔ Tu número no está registrado o no tiene acceso al bot. Contacta a tu administrador.',
      );
      return;
    }

    // ── 4. Imagen → iniciar pipeline OCR ─────────────────────────────────
    if (msg.mediaBuffer || msg.mediaUrl) {
      await this.handleImage(msg, user);
      return;
    }

    // ── 5. Texto ──────────────────────────────────────────────────────────
    if (msg.textBody) {
      await this.handleText(msg, user);
      return;
    }
  }

  // ─── Imagen: OCR y borrador ────────────────────────────────────────────────

  private async handleImage(
    msg: IncomingMessage,
    user: { id: string | null; orgId: string; fullName: string | null },
  ): Promise<void> {
    const selectedPond = await this.getSelectedPond(msg.from);
    if (!selectedPond) {
      await this.provider.sendMessage(
        this.replyTo(msg),
        'Antes de enviar la foto, confirma el estanque escribiendo *quiero mandar un reporte*.',
      );
      return;
    }

    // Si hay un borrador activo, avisamos antes de reemplazarlo
    const existing = await this.draft.get(msg.from);
    if (existing) {
      await this.provider.sendMessage(
        this.replyTo(msg),
        '⚠️ Tenías un reporte pendiente de confirmar. Lo reemplacé con la nueva imagen.',
      );
    }

    const imageBuffer = msg.mediaBuffer ?? (await this.downloadRemoteImage(msg.mediaUrl!));

    // Crear registro en DB sin subir imagen a Supabase Storage
    let uploadId = `local-${msg.id}`;
    const imageUrl = 'not_stored';

    try {
      const upload = await this.db.createUpload({
        userId: user.id,
        imageUrl,
        whatsappProvider: msg.providerType,
        whatsappMsgId: msg.id,
        senderPhone: msg.from,
      });
      uploadId = upload.id;
    } catch (err) {
      logger.warn({ err }, 'DB create upload skipped — running OCR anyway');
    }

    // Ejecutar OCR (siempre, con o sin DB)
    const lockKey = `lock:ocr:${msg.id}`;
    if (!(await this.redis.setnx(lockKey, '1', 300))) return;

    try {
      const result = await this.ocr.run({
        jobId: uploadId,
        imageBuffer,
        mimeType: msg.mediaMimeType ?? 'image/jpeg',
      });

      // Persistir resultado si hay upload real en DB
      if (uploadId !== `local-${msg.id}`) {
        await this.db.updateUploadWithOcrResult({ uploadId, result }).catch((err) =>
          logger.warn({ err }, 'Failed to persist OCR result'),
        );
      }

      if (!result.isValid) {
        const missing = result.rejectionReasons.map((r) => r.replace('missing_', '')).join(' ni ');
        await this.provider.sendError(
          this.replyTo(msg),
          new BotError('MISSING_CRITICAL_FIELDS', `No pude detectar ${missing}. Envía una foto más clara.`),
        );
        return;
      }

      const draftData: OcrData = {
        ...result.data,
        pond_name: selectedPond.name,
        confidence: {
          ...result.data.confidence,
          pond_name: 100,
        },
      };

      await this.draft.save(msg.from, { uploadId, imageUrl, data: draftData, edited: [] });
      await this.provider.sendMessage(this.replyTo(msg), this.buildDraftMessage(draftData, []));

    } finally {
      await this.redis.del(lockKey);
    }
  }

  // ─── Texto: correcciones o confirmación ───────────────────────────────────

  private async handleText(
    msg: IncomingMessage,
    user: { id: string | null; orgId: string; fullName: string | null },
  ): Promise<void> {
    const text = msg.textBody!;
    const activeDraft = await this.draft.get(msg.from);
    const pendingPondsKey = this.pendingPondsKey(msg.from);

    // ── Sin borrador activo → solo flujo de reporte por imagen ──────────
    if (!activeDraft) {
      const pendingPondsRaw = await this.redis.get(pendingPondsKey);
      if (pendingPondsRaw) {
        const pendingPonds = JSON.parse(pendingPondsRaw) as Array<{ id: string; name: string }>;
        const selected = this.matchPondSelection(text, pendingPonds);

        if (!selected) {
          const pondList = pendingPonds.map((pond, idx) => `${idx + 1}. ${pond.name}`).join('\n');
          await this.provider.sendMessage(
            this.replyTo(msg),
            `Gracias 🙌 No logré identificar esa opción todavía.\nResponde con el *número* del estanque (ejemplo: *1*):\n\n${pondList}`,
          );
          return;
        }

        await this.redis.del(pendingPondsKey);
        await this.redis.set(this.selectedPondKey(msg.from), JSON.stringify(selected), {
          ttlSeconds: SELECTED_POND_TTL_SEC,
        });
        await this.provider.sendMessage(
          this.replyTo(msg),
          `¡Perfecto! Trabajaremos con *${selected.name}* ✅\nCuando quieras, envíame la *foto del reporte* y lo proceso de una vez.`,
        );
        return;
      }

      if (this.isReportRequest(text)) {
        const ponds = await this.db.listActivePondsByOrg(user.orgId);
        if (!ponds.length) {
          await this.provider.sendMessage(
            this.replyTo(msg),
            'En este momento no veo estanques activos en tu cuenta. Te recomiendo pedirle al administrador que los configure y te ayudo enseguida.',
          );
          return;
        }

        await this.redis.set(pendingPondsKey, JSON.stringify(ponds), {
          ttlSeconds: REPORT_POND_SELECTION_TTL_SEC,
        });
        await this.redis.del(this.selectedPondKey(msg.from));

        const pondList = ponds.map((pond, idx) => `${idx + 1}. ${pond.name}`).join('\n');
        await this.provider.sendMessage(
          this.replyTo(msg),
          `Perfecto. Para mandar el reporte, elige el estanque:\n\n${pondList}\n\nResponde con el *número* de la opción (ejemplo: *1*).`,
        );
        return;
      }

      await this.provider.sendMessage(
        this.replyTo(msg),
        this.buildWelcomeMessage(user.fullName),
      );
      return;
    }

    // ── Con borrador activo ──────────────────────────────────────────────

    // Cancelación
    if (this.draft.isCancellation(text)) {
      await this.draft.clear(msg.from);
      await this.redis.del(this.selectedPondKey(msg.from));
      await this.db.cancelUpload(activeDraft.uploadId);
      await this.provider.sendMessage(this.replyTo(msg), '❌ Reporte cancelado. Puedes enviar una nueva foto cuando quieras.');
      return;
    }

    // Confirmación
    if (this.draft.isConfirmation(text)) {
      await this.confirmDraft(msg, user, activeDraft);
      return;
    }

    // Corrección de un campo
    const corrected = this.draft.applyCorrection(activeDraft, text);
    if (corrected) {
      await this.draft.save(msg.from, corrected);
      await this.provider.sendMessage(
        this.replyTo(msg),
        this.buildDraftMessage(corrected.data, corrected.edited),
      );
      return;
    }

    // Texto no reconocido con borrador activo → recordar estado
    await this.provider.sendMessage(
      this.replyTo(msg),
      '📋 Tienes un reporte pendiente. Puedes:\n' +
      '• Corregir un campo: *campo: valor* (ej: "oxígeno: 7.2")\n' +
      '• Confirmar: *confirmar*\n' +
      '• Cancelar: *cancelar*',
    );
  }

  // ─── Confirmar borrador → guardar en DB ───────────────────────────────────

  private async confirmDraft(
    msg: IncomingMessage,
    user: { id: string | null; orgId: string; fullName: string | null },
    activeDraft: OcrDraft,
  ): Promise<void> {
    const selectedPond = await this.getSelectedPond(msg.from);
    if (!selectedPond) {
      await this.provider.sendMessage(
        this.replyTo(msg),
        'No tengo el estanque de este reporte. Escribe *quiero mandar un reporte* para seleccionarlo de nuevo.',
      );
      return;
    }

    const batch = await this.db.findActiveBatch(selectedPond.id);
    if (!batch) {
      await this.provider.sendMessage(
        this.replyTo(msg),
        `No encontré un lote activo para *${selectedPond.name}*. Avísale al administrador para habilitarlo y vuelve a intentar.`,
      );
      return;
    }

    const record = await this.db.createProductionRecord({
      uploadId: activeDraft.uploadId,
      batchId: batch.id,
      result: { data: activeDraft.data, isValid: true, rejectionReasons: [], overallConfidence: 1.0 },
    });

    await this.draft.clear(msg.from);
    await this.redis.del(this.selectedPondKey(msg.from));
    await this.db.updateUploadStatus(activeDraft.uploadId, 'processed').catch(() => undefined);

    await this.provider.sendMessage(
      this.replyTo(msg),
      `✅ *Reporte guardado correctamente.*\n_Estanque: ${selectedPond.name}_`,
    );

    logger.info({ recordId: record.id, phone: msg.from }, 'Production record created after operator confirmation');
  }

  // ─── Mensaje del borrador ──────────────────────────────────────────────────

  private buildDraftMessage(data: OcrData, edited: string[]): string {
    const fmt = (v: string | number | null, unit = '', field = '') => {
      if (v === null) return '—';
      const tag = edited.includes(field) ? ' ✏️' : '';
      return `${v}${unit ? ' ' + unit : ''}${tag}`;
    };

    const conf = (field: keyof OcrData['confidence']) => {
      const c = data.confidence[field];
      if (c >= 80) return '';
      if (c >= 50) return ` _(${c}%)_`;
      return c === 0 ? ' _(no detectado)_' : ` _(⚠️ ${c}%)_`;
    };

    const lines = [
      '📋 *Revisa los datos extraídos:*',
      '',
      `📅 Fecha:      ${fmt(data.record_date, '', 'record_date')}${conf('record_date')}`,
      `🌾 Alimento:   ${fmt(data.feed_kg, 'kg', 'feed_kg')}${conf('feed_kg')}`,
      `⚖️  Peso:       ${fmt(data.avg_weight_g, 'g', 'avg_weight_g')}${conf('avg_weight_g')}`,
      `💀 Mortalidad: ${fmt(data.mortality_count, 'peces', 'mortality_count')}${conf('mortality_count')}`,
      `🌡️  Temp:       ${fmt(data.temperature_c, '°C', 'temperature_c')}${conf('temperature_c')}`,
      `💧 Oxígeno:    ${fmt(data.oxygen_mg_l, 'mg/L', 'oxygen_mg_l')}${conf('oxygen_mg_l')}`,
      `🧪 pH:         ${fmt(data.ph, '', 'ph')}${conf('ph')}`,
      `🧱 Dureza:     ${fmt(data.hardness_mg_l, 'mg/L', 'hardness_mg_l')}${conf('hardness_mg_l')}`,
      `🧫 Alcalinidad:${fmt(data.alkalinity_mg_l, 'mg/L', 'alkalinity_mg_l')}${conf('alkalinity_mg_l')}`,
    ];

    // Añadir parámetros extra si fueron detectados
    if (data.ammonia_mg_l !== null) lines.push(`⚗️  Amonio:     ${fmt(data.ammonia_mg_l, 'mg/L', 'ammonia_mg_l')}${conf('ammonia_mg_l')}`);
    if (data.nitrite_mg_l !== null) lines.push(`⚗️  Nitritos:   ${fmt(data.nitrite_mg_l, 'mg/L', 'nitrite_mg_l')}${conf('nitrite_mg_l')}`);
    if (data.nitrate_mg_l !== null) lines.push(`⚗️  Nitratos:   ${fmt(data.nitrate_mg_l, 'mg/L', 'nitrate_mg_l')}${conf('nitrate_mg_l')}`);
    if (data.phosphate_mg_l !== null) lines.push(`⚗️  Fosfatos:   ${fmt(data.phosphate_mg_l, 'mg/L', 'phosphate_mg_l')}${conf('phosphate_mg_l')}`);
    if (data.fish_count !== null) lines.push(`🐠 Peces:      ${fmt(data.fish_count, 'peces', 'fish_count')}${conf('fish_count')}`);
    if (data.notes) lines.push(`📝 Notas:      ${fmt(data.notes, '', 'notes')}`);

    lines.push('');
    lines.push('_✏️ Corregir campo: *campo: valor*_');
    lines.push('_Ej: "oxígeno: 7.2"  •  "fecha: 15/03/2025"_');
    lines.push('');
    lines.push('_✅ Envía *confirmar* cuando todo esté correcto._');
    lines.push('_❌ Envía *cancelar* para descartar._');

    return lines.join('\n');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Resuelve el usuario por teléfono. Retorna null si no está registrado (flujo abierto). */
  private async resolveUser(phone: string): Promise<{ id: string | null; orgId: string; fullName: string | null } | null> {
    try {
      const existing = await this.db.findUserByPhone(phone);
      if (existing) return existing;

      if (config.SUPABASE_DEFAULT_ORG_ID) {
        return await this.db.upsertProfileByPhone(phone, config.SUPABASE_DEFAULT_ORG_ID);
      }

      return null;
    } catch (err) {
      logger.error({ err, phone }, 'Failed to resolve or auto-register WhatsApp user');
      return null;
    }
  }

  private replyTo(msg: IncomingMessage): string {
    return msg.replyJid ?? msg.from;
  }

  private buildWelcomeMessage(fullName: string | null): string {
    const firstName = fullName
      ?.trim()
      .split(/\s+/)
      .find(Boolean);

    const greeting = firstName ? `¡Hola, ${firstName}! 👋` : '¡Hola! 👋';
    return `${greeting} Soy AquaBot, tu asistente de AquaData.\n\nEstoy listo para ayudarte con el monitoreo de tus cultivos acuicolas. Cuentame, ¿en que puedo asistirte hoy? 😊`;
  }

  private async downloadRemoteImage(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new BotError('INVALID_IMAGE', 'No pude descargar la imagen. Por favor reenvía la foto.', new Error(`HTTP ${res.status}`));
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private isReportRequest(text: string): boolean {
    const normalized = text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    const wantsReport = normalized.includes('reporte') || normalized.includes('reportar');
    const wantsToSubmit = ['mandar', 'enviar', 'hacer', 'subir', 'cargar', 'registrar']
      .some((verb) => normalized.includes(verb));

    return (
      wantsReport && wantsToSubmit
    );
  }

  private pendingPondsKey(phone: string): string {
    return `report:pending_pond_selection:${phone}`;
  }

  private selectedPondKey(phone: string): string {
    return `report:selected_pond:${phone}`;
  }

  private async getSelectedPond(phone: string): Promise<{ id: string; name: string } | null> {
    const raw = await this.redis.get(this.selectedPondKey(phone));
    if (!raw) return null;
    try {
      const selected = JSON.parse(raw) as { id: string; name: string };
      if (!selected.id || !selected.name) return null;
      return selected;
    } catch {
      return null;
    }
  }

  private matchPondSelection(
    text: string,
    ponds: Array<{ id: string; name: string }>,
  ): { id: string; name: string } | null {
    const trimmed = text.trim();
    const numericChoice = Number(trimmed);
    if (Number.isInteger(numericChoice) && numericChoice >= 1 && numericChoice <= ponds.length) {
      return ponds[numericChoice - 1] ?? null;
    }

    const normalizedInput = this.normalizeText(trimmed);
    return ponds.find((pond) => this.normalizeText(pond.name) === normalizedInput) ?? null;
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }
}
