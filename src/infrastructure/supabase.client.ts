import { createClient, type SupabaseClient as Sb } from '@supabase/supabase-js';
import type { NormalizedOcrResult } from '../ocr/types';
import type { ProviderType } from '../whatsapp/types';
import { logger } from '../shared/logger';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateUploadInput {
  userId: string;
  batchId?: string;           // opcional — se resuelve si se puede
  imageUrl: string;
  whatsappProvider: ProviderType;
  whatsappMsgId: string;
  senderPhone: string;
}

export interface UpdateUploadWithOcrInput {
  uploadId: string;
  result: NormalizedOcrResult;
  rawOcrText?: string;
}

export interface CreateProductionRecordInput {
  uploadId: string;
  batchId?: string;           // nullable si no se pudo resolver
  result: NormalizedOcrResult;
}

export interface InsertAlertInput {
  organizationId: string;
  productionRecordId: string;
  pondId?: string;
  batchId?: string;
  alertType: string;
  severity: string;
  message: string;
  parameterName?: string;
  parameterValue?: number;
  thresholdValue?: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class SupabaseRepo {
  private db: Sb;
  private bucket: string;

  constructor(url: string, serviceRoleKey: string, bucket: string) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
    this.bucket = bucket;
  }

  // ─── Profiles (users) ─────────────────────────────────────────────────────

  /** Resuelve el usuario por número de WhatsApp usando profiles.whatsapp_phone */
  async findUserByPhone(phone: string): Promise<{ id: string; orgId: string } | null> {
    const { data, error } = await this.db
      .from('profiles')
      .select('id, organization_id')
      .eq('whatsapp_phone', phone)
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error({ error, phone }, 'Error finding user by phone');
    }

    if (!data) return null;
    return { id: data.id as string, orgId: data.organization_id as string };
  }

  // ─── Ponds & Batches ──────────────────────────────────────────────────────

  /**
   * Busca un estanque por nombre (case-insensitive) dentro de la organización.
   * Usado para resolver automáticamente el estanque del OCR.
   */
  async findPondByName(orgId: string, pondName: string): Promise<{ id: string } | null> {
    const { data } = await this.db
      .from('ponds')
      .select('id')
      .eq('organization_id', orgId)
      .ilike('name', pondName.trim())
      .eq('status', 'active')
      .single();

    return data ? { id: data.id as string } : null;
  }

  /** Retorna el lote activo más reciente de un estanque. */
  async findActiveBatch(pondId: string): Promise<{ id: string; current_population: number | null } | null> {
    const { data } = await this.db
      .from('batches')
      .select('id, current_population')
      .eq('pond_id', pondId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return data ? { id: data.id as string, current_population: data.current_population as number | null } : null;
  }

  // ─── Uploads (= mensajes WhatsApp + jobs OCR + resultados) ────────────────

  async createUpload(input: CreateUploadInput): Promise<{ id: string }> {
    const { data, error } = await this.db
      .from('uploads')
      .insert({
        user_id:           input.userId,
        batch_id:          input.batchId ?? null,
        image_url:         input.imageUrl,
        whatsapp_provider: input.whatsappProvider,
        whatsapp_msg_id:   input.whatsappMsgId,
        sender_phone:      input.senderPhone,
        status:            'processing',
      })
      .select('id')
      .single();

    if (error) throw new Error(`createUpload: ${error.message}`);
    return { id: data.id as string };
  }

  /**
   * Actualiza el upload con el resultado del OCR.
   * - processed_data: valores finales mapeados a nombres de columna de production_records
   * - ocr_field_confidences: confidence por campo (mismo mapa de keys)
   * - raw_ocr_text: texto crudo de Claude (para auditoría)
   */
  async updateUploadWithOcrResult(input: UpdateUploadWithOcrInput): Promise<void> {
    const { fields } = input.result;

    // Mapa de nombres OCR (español) → columnas de production_records (inglés)
    const processedData = {
      record_date:     fields.fecha.value,
      pond_name:       fields.estanque.value,
      batch_code:      fields.lote.value,
      feed_kg:         fields.alimento_kg.value,
      avg_weight_g:    fields.peso_promedio_g.value,
      mortality_count: fields.mortalidad.value,
      temperature_c:   fields.temperatura_c.value,
      oxygen_mg_l:     fields.oxigeno_mgl.value,
      ammonia_mg_l:    fields.amonio_mgl.value,
      nitrite_mg_l:    fields.nitritos_mgl.value,
      nitrate_mg_l:    fields.nitratos_mgl.value,
      ph:              fields.ph.value,
      notes:           fields.observaciones.value,
    };

    const fieldConfidences = {
      record_date:     fields.fecha.confidence,
      pond_name:       fields.estanque.confidence,
      batch_code:      fields.lote.confidence,
      feed_kg:         fields.alimento_kg.confidence,
      avg_weight_g:    fields.peso_promedio_g.confidence,
      mortality_count: fields.mortalidad.confidence,
      temperature_c:   fields.temperatura_c.confidence,
      oxygen_mg_l:     fields.oxigeno_mgl.confidence,
      ammonia_mg_l:    fields.amonio_mgl.confidence,
      nitrite_mg_l:    fields.nitritos_mgl.confidence,
      nitrate_mg_l:    fields.nitratos_mgl.confidence,
      ph:              fields.ph.confidence,
      notes:           fields.observaciones.confidence,
    };

    await this.db
      .from('uploads')
      .update({
        status:               input.result.isValid ? 'pending_review' : 'rejected',
        processed_data:       processedData,
        ocr_field_confidences: fieldConfidences,
        ocr_confidence:       input.result.overallConfidence,
        raw_ocr_text:         input.rawOcrText ?? null,
        pond_name_raw:        fields.estanque.value,
        record_date_raw:      fields.fecha.value,
        rejection_reason:     input.result.isValid
          ? null
          : input.result.rejectionReasons.join(', '),
      })
      .eq('id', input.uploadId);
  }

  // ─── Production Records ───────────────────────────────────────────────────

  async createProductionRecord(input: CreateProductionRecordInput): Promise<{ id: string }> {
    const { fields } = input.result;

    const { data, error } = await this.db
      .from('production_records')
      .insert({
        batch_id:        input.batchId ?? null,
        upload_id:       input.uploadId,
        record_date:     fields.fecha.value ?? new Date().toISOString().split('T')[0],

        // Columnas existentes (nombres del schema AquaData)
        feed_kg:         fields.alimento_kg.value,
        avg_weight_g:    fields.peso_promedio_g.value,
        mortality_count: fields.mortalidad.value ?? 0,
        temperature_c:   fields.temperatura_c.value,
        oxygen_mg_l:     fields.oxigeno_mgl.value,
        ammonia_mg_l:    fields.amonio_mgl.value,
        nitrite_mg_l:    fields.nitritos_mgl.value,
        nitrate_mg_l:    fields.nitratos_mgl.value,
        ph:              fields.ph.value,
        notes:           fields.observaciones.value,

        review_status:   'PENDING_REVIEW',   // columna agregada
      })
      .select('id')
      .single();

    if (error) throw new Error(`createProductionRecord: ${error.message}`);
    return { id: data.id as string };
  }

  async getProductionRecord(id: string): Promise<Record<string, unknown> | null> {
    const { data } = await this.db
      .from('production_records')
      .select(`
        *,
        uploads(
          image_url, sender_phone, processed_data,
          ocr_confidence, ocr_field_confidences,
          pond_name_raw, created_at
        ),
        batches(
          id, pond_id, current_population,
          ponds(id, name, organization_id)
        )
      `)
      .eq('id', id)
      .single();

    return data ?? null;
  }

  async confirmProductionRecord(
    id: string,
    updates: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .from('production_records')
      .update({
        ...updates,
        review_status: 'CONFIRMED',
        // confirmed_by: userId  ← agregar cuando haya auth
      })
      .eq('id', id);
  }

  // ─── Alerts ───────────────────────────────────────────────────────────────

  async insertAlert(input: InsertAlertInput): Promise<void> {
    await this.db.from('alerts').insert({
      organization_id:       input.organizationId,
      production_record_id:  input.productionRecordId,
      pond_id:               input.pondId ?? null,
      batch_id:              input.batchId ?? null,
      alert_type:            input.alertType,
      severity:              input.severity,
      message:               input.message,
      is_read:               false,
      parameter_name:        input.parameterName ?? null,
      parameter_value:       input.parameterValue ?? null,
      threshold_value:       input.thresholdValue ?? null,
    });
  }

  // ─── Storage ──────────────────────────────────────────────────────────────

  async uploadImage(buffer: Buffer, path: string): Promise<string> {
    const { error } = await this.db.storage
      .from(this.bucket)
      .upload(path, buffer, { contentType: 'image/jpeg', upsert: false });

    if (error) throw new Error(`uploadImage: ${error.message}`);

    const { data } = this.db.storage.from(this.bucket).getPublicUrl(path);
    return data.publicUrl;
  }
}
