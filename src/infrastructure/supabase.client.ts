import { createClient, type SupabaseClient as Sb } from '@supabase/supabase-js';
import type { NormalizedOcrResult } from '../ocr/types';
import type { ProviderType } from '../whatsapp/types';
import { logger } from '../shared/logger';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateUploadInput {
  userId?: string | null;
  batchId?: string;
  imageUrl: string;
  whatsappProvider: ProviderType;
  whatsappMsgId: string;
  senderPhone: string;
}

export interface UpdateUploadWithOcrInput {
  uploadId: string;
  result: NormalizedOcrResult;
}

export interface CreateProductionRecordInput {
  uploadId: string;
  batchId?: string;
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
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    this.bucket = bucket;
  }

  // ─── Profiles ─────────────────────────────────────────────────────────────

  /**
   * Busca el usuario por su número de WhatsApp.
   * Busca primero en profiles.phone, luego mantiene compatibilidad con
   * profiles.whatsapp_phone y finalmente valida la whitelist
   * organizations.authorized_whatsapp_contacts.
   */
  async findUserByPhone(phone: string): Promise<{ id: string | null; orgId: string; fullName: string | null } | null> {
    const phoneCandidates = this.buildPhoneCandidates(phone);

    logger.info({ phone, phoneCandidates }, '[findUserByPhone] searching');

    // 1. Buscar por número normalizado en profiles.phone
    const { data: byProfilePhone, error: profilePhoneError } = await this.db
      .from('profiles')
      .select('id, organization_id, full_name')
      .in('phone', phoneCandidates)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (profilePhoneError) {
      logger.error({ error: profilePhoneError, phone }, '[findUserByPhone] profiles.phone query error');
    }

    if (byProfilePhone?.organization_id) {
      logger.info({ found: true, via: 'profiles.phone' }, '[findUserByPhone] result');
      return {
        id: byProfilePhone.id as string,
        orgId: byProfilePhone.organization_id as string,
        fullName: (byProfilePhone.full_name as string | null) ?? null,
      };
    }

    // 2. Compatibilidad con el campo legado profiles.whatsapp_phone
    const { data: byWhatsappPhone, error: whatsappPhoneError } = await this.db
      .from('profiles')
      .select('id, organization_id, full_name')
      .in('whatsapp_phone', phoneCandidates)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (whatsappPhoneError) {
      logger.error({ error: whatsappPhoneError, phone }, '[findUserByPhone] profiles.whatsapp_phone query error');
    }

    if (byWhatsappPhone?.organization_id) {
      logger.info({ found: true, via: 'profiles.whatsapp_phone' }, '[findUserByPhone] result');
      return {
        id: byWhatsappPhone.id as string,
        orgId: byWhatsappPhone.organization_id as string,
        fullName: (byWhatsappPhone.full_name as string | null) ?? null,
      };
    }

    // 3. Validar si el número está autorizado a nivel de organización
    const { data: organizations, error: organizationsError } = await this.db
      .from('organizations')
      .select('id, authorized_whatsapp_contacts');

    if (organizationsError) {
      logger.error({ error: organizationsError, phone }, '[findUserByPhone] organizations query error');
      return null;
    }

    const phoneCandidateSet = new Set(phoneCandidates);
    const matchedOrganization = (organizations ?? [])
      .map((organization) => ({
        orgId: organization.id as string,
        match: this.findAuthorizedOrganizationContact(organization.authorized_whatsapp_contacts, phoneCandidateSet),
      }))
      .find((organization) => organization.match !== null);

    if (matchedOrganization?.match) {
      logger.info({ found: true, via: 'organizations.authorized_whatsapp_contacts' }, '[findUserByPhone] result');
      return {
        id: null,
        orgId: matchedOrganization.orgId,
        fullName: matchedOrganization.match.fullName,
      };
    }

    logger.info({ found: false }, '[findUserByPhone] result');
    return null;
  }

  /**
   * Auto-registra un número si no existe usando el org ID por defecto.
   * Solo se llama cuando SUPABASE_DEFAULT_ORG_ID está configurado.
   */
  async upsertProfileByPhone(phone: string, defaultOrgId: string): Promise<{ id: string | null; orgId: string; fullName: string | null }> {
    const existing = await this.findUserByPhone(phone);
    if (existing) return existing;

    const preferredPhone = this.selectPreferredProfilePhone(phone);

    const { data, error } = await this.db
      .from('profiles')
      .insert({
        whatsapp_phone: phone,
        phone: preferredPhone,
        organization_id: defaultOrgId,
        is_active: true,
      })
      .select('id, organization_id')
      .single();

    if (error) throw new Error(`upsertProfileByPhone: ${error.message}`);
    logger.info({ phone, orgId: defaultOrgId }, 'Auto-registered new WhatsApp user');
    return { id: data.id as string, orgId: data.organization_id as string, fullName: null };
  }

  private buildPhoneCandidates(phone: string): string[] {
    const trimmed = phone.trim();
    const withoutJid = trimmed.includes('@') ? (trimmed.split('@')[0] ?? trimmed) : trimmed;
    const compact = withoutJid.replace(/[^\d+]/g, '');
    const digits = compact.replace(/\D/g, '');

    const candidates = new Set<string>([trimmed, withoutJid, compact]);

    if (digits) {
      candidates.add(digits);
      candidates.add(`+${digits}`);
    }

    if (digits.length === 10) {
      candidates.add(`57${digits}`);
      candidates.add(`+57${digits}`);
    }

    if (digits.length === 12 && digits.startsWith('57')) {
      const localDigits = digits.slice(2);
      candidates.add(localDigits);
      candidates.add(`+${digits}`);
      candidates.add(`+${localDigits}`);
    }

    return Array.from(candidates).filter(Boolean);
  }

  private selectPreferredProfilePhone(phone: string): string | null {
    const candidates = this.buildPhoneCandidates(phone);
    return candidates.find((candidate) => /^\+\d+$/.test(candidate)) ?? null;
  }

  private findAuthorizedOrganizationContact(
    authorizedContacts: unknown,
    phoneCandidateSet: Set<string>,
  ): { fullName: string | null } | null {
    if (!Array.isArray(authorizedContacts)) return null;

    for (const contact of authorizedContacts) {
      if (typeof contact === 'string') {
        const matches = this.buildPhoneCandidates(contact).some((candidate) => phoneCandidateSet.has(candidate));
        if (matches) return { fullName: null };
        continue;
      }

      if (!contact || typeof contact !== 'object') continue;

      const record = contact as Record<string, unknown>;

      const possibleValues = [
        'phone',
        'whatsapp_phone',
        'number',
        'value',
      ].flatMap((key) => {
        const value = record[key];
        return typeof value === 'string' ? [value] : [];
      });

      const matches = possibleValues.some((value) =>
        this.buildPhoneCandidates(value).some((candidate) => phoneCandidateSet.has(candidate)),
      );

      if (!matches) continue;

      const fullName = [
        'full_name',
        'fullName',
        'name',
        'contact_name',
        'contactName',
      ].flatMap((key) => {
        const value = record[key];
        return typeof value === 'string' && value.trim() ? [value.trim()] : [];
      })[0] ?? null;

      return { fullName };
    }

    return null;
  }

  // ─── Ponds & Batches ──────────────────────────────────────────────────────

  async findPondByName(orgId: string, pondName: string): Promise<{ id: string } | null> {
    const { data } = await this.db
      .from('ponds')
      .select('id')
      .eq('organization_id', orgId)
      .ilike('name', `%${pondName.trim()}%`)
      .eq('status', 'active')
      .limit(1)
      .single();

    return data ? { id: data.id as string } : null;
  }

  async listActivePondsByOrg(orgId: string): Promise<Array<{ id: string; name: string }>> {
    const { data, error } = await this.db
      .from('ponds')
      .select('id, name')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .order('name', { ascending: true });

    if (error) throw new Error(`listActivePondsByOrg: ${error.message}`);

    return (data ?? []).map((pond) => ({
      id: pond.id as string,
      name: pond.name as string,
    }));
  }

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

  // ─── Uploads ──────────────────────────────────────────────────────────────

  async createUpload(input: CreateUploadInput): Promise<{ id: string }> {
    const { data, error } = await this.db
      .from('uploads')
      .insert({
        user_id:           input.userId ?? null,
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

  async updateUploadWithOcrResult(input: UpdateUploadWithOcrInput): Promise<void> {
    const { data } = input.result;

    await this.db
      .from('uploads')
      .update({
        status:                input.result.isValid ? 'pending_review' : 'rejected',
        // processed_data almacena el output completo de Gemini (todos los campos OCR)
        processed_data:        data,
        ocr_field_confidences: data.confidence,
        ocr_confidence:        input.result.overallConfidence,
        pond_name_raw:         data.pond_name,
        record_date_raw:       data.record_date,
        rejection_reason:      input.result.isValid
          ? null
          : input.result.rejectionReasons.join(', '),
      })
      .eq('id', input.uploadId);
  }

  // ─── Production Records ───────────────────────────────────────────────────

  async createProductionRecord(input: CreateProductionRecordInput): Promise<{ id: string }> {
    const d = input.result.data;
    const avgWeightKg = this.normalizeAvgWeightKg(d.avg_weight_g);

    const { data, error } = await this.db
      .from('production_records')
      .insert({
        batch_id:        input.batchId ?? null,
        upload_id:       input.uploadId,
        record_date:     d.record_date ?? new Date().toISOString().split('T')[0],
        report_type:     d.report_type ?? 'daily',
        week_end_date:   d.week_end_date,

        // Columnas existentes AquaData
        feed_kg:         d.feed_kg,
        avg_weight_kg:   avgWeightKg,
        sampling_weight_g: d.sampling_weight_g,
        mortality_count: d.mortality_count ?? 0,
        temperature_c:   d.temperature_c,
        oxygen_mg_l:     d.oxygen_mg_l,
        ammonia_mg_l:    d.ammonia_mg_l,
        nitrite_mg_l:    d.nitrite_mg_l,
        nitrate_mg_l:    d.nitrate_mg_l,
        ph:              d.ph,
        notes:           d.notes,

        // Columnas nuevas (migración 002)
        fish_count:      d.fish_count,
        phosphate_mg_l:  d.phosphate_mg_l,
        hardness_mg_l:   d.hardness_mg_l,
        alkalinity_mg_l: d.alkalinity_mg_l,
        turbidity_ntu:   d.turbidity_ntu,
        biomass_kg:      d.biomass_kg,

        review_status:   'PENDING_REVIEW',
      })
      .select('id')
      .single();

    if (error) throw new Error(`createProductionRecord: ${error.message}`);
    return { id: data.id as string };
  }

  /**
   * El OCR sigue exponiendo avg_weight_g por compatibilidad histórica.
   * En DB ahora persistimos avg_weight_kg.
   * - Si el valor parece gramos (> 20), convierte g -> kg.
   * - Si el valor parece kg (<= 20), lo deja tal cual.
   */
  private normalizeAvgWeightKg(avgWeightRaw: number | null): number | null {
    if (avgWeightRaw === null || Number.isNaN(avgWeightRaw)) return null;
    if (avgWeightRaw <= 0) return 0;

    const kg = avgWeightRaw > 20 ? avgWeightRaw / 1000 : avgWeightRaw;
    return Math.round(kg * 1000) / 1000;
  }

  async getProductionRecord(id: string): Promise<Record<string, unknown> | null> {
    const { data } = await this.db
      .from('production_records')
      .select(`
        *,
        uploads(image_url, sender_phone, processed_data, ocr_confidence, ocr_field_confidences, pond_name_raw, created_at),
        batches(id, pond_id, current_population, ponds(id, name, organization_id))
      `)
      .eq('id', id)
      .single();

    return data ?? null;
  }

  async updateUploadStatus(uploadId: string, status: string): Promise<void> {
    await this.db.from('uploads').update({ status }).eq('id', uploadId);
  }

  async cancelUpload(uploadId: string): Promise<void> {
    await this.db.from('uploads').update({ status: 'cancelled' }).eq('id', uploadId);
  }

  async getPreviousProductionRecord(
    batchId: string,
    recordDate: string,
    currentRecordId: string,
  ): Promise<{ avg_weight_g: number | null; record_date: string } | null> {
    const { data, error } = await this.db
      .from('production_records')
      .select('avg_weight_g, record_date')
      .eq('batch_id', batchId)
      .lt('record_date', recordDate)
      .neq('id', currentRecordId)
      .order('record_date', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return null;
    return {
      avg_weight_g: data.avg_weight_g as number | null,
      record_date: data.record_date as string,
    };
  }

  async confirmProductionRecord(id: string, updates: Record<string, unknown>): Promise<void> {
    await this.db
      .from('production_records')
      .update({ ...updates, review_status: 'CONFIRMED' })
      .eq('id', id);
  }

  // ─── Alerts ───────────────────────────────────────────────────────────────

  async insertAlert(input: InsertAlertInput): Promise<void> {
    await this.db.from('alerts').insert({
      organization_id:      input.organizationId,
      production_record_id: input.productionRecordId,
      pond_id:              input.pondId ?? null,
      batch_id:             input.batchId ?? null,
      alert_type:           input.alertType,
      severity:             input.severity,
      message:              input.message,
      is_read:              false,
      parameter_name:       input.parameterName ?? null,
      parameter_value:      input.parameterValue ?? null,
      threshold_value:      input.thresholdValue ?? null,
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
