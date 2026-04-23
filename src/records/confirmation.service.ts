import type { SupabaseRepo } from '../infrastructure/supabase.client';
import { CalculationsService } from './calculations.service';
import { AlertsService } from './alerts.service';
import { logger } from '../shared/logger';

export interface ConfirmationInput {
  recordId: string;
  /** Valores editados por el admin (pueden diferir del OCR). */
  overrides?: {
    feed_kg?: number;
    avg_weight_g?: number;
    mortality_count?: number;
    temperature_c?: number;
    oxygen_mg_l?: number;
    ammonia_mg_l?: number;
    nitrite_mg_l?: number;
    nitrate_mg_l?: number;
    ph?: number;
    biomass_kg?: number;
    fish_count?: number;
    turbidity_ntu?: number;
    notes?: string;
  };
  /** Población actual del lote — para cálculo de biomasa y % mortalidad. */
  batchPopulation?: number;
  /** Biomasa del día anterior — para cálculo exacto de FCA. */
  biomassYesterdayKg?: number;
  /** FCA configurado por la finca (opcional). */
  configuredFca?: number | null;
}

export class ConfirmationService {
  constructor(
    private readonly db: SupabaseRepo,
    private readonly calculations: CalculationsService,
    private readonly alerts: AlertsService,
  ) {}

  async confirm(input: ConfirmationInput): Promise<void> {
    logger.info({ recordId: input.recordId }, 'Confirming production record');

    // 1. Cargar registro
    const record = await this.db.getProductionRecord(input.recordId);
    if (!record) throw new Error(`Production record not found: ${input.recordId}`);

    if (record['review_status'] !== 'PENDING_REVIEW') {
      throw new Error(`Record ${input.recordId} is not PENDING_REVIEW`);
    }

    // 2. Fusionar valores OCR con overrides del admin
    const final = {
      feed_kg:         input.overrides?.feed_kg         ?? (record['feed_kg'] as number | null),
      avg_weight_g:    input.overrides?.avg_weight_g    ?? (record['avg_weight_g'] as number | null),
      mortality_count: input.overrides?.mortality_count ?? (record['mortality_count'] as number | null),
      temperature_c:   input.overrides?.temperature_c   ?? (record['temperature_c'] as number | null),
      oxygen_mg_l:     input.overrides?.oxygen_mg_l     ?? (record['oxygen_mg_l'] as number | null),
      ammonia_mg_l:    input.overrides?.ammonia_mg_l    ?? (record['ammonia_mg_l'] as number | null),
      nitrite_mg_l:    input.overrides?.nitrite_mg_l    ?? (record['nitrite_mg_l'] as number | null),
      nitrate_mg_l:    input.overrides?.nitrate_mg_l    ?? (record['nitrate_mg_l'] as number | null),
      ph:              input.overrides?.ph              ?? (record['ph'] as number | null),
      biomass_kg:      input.overrides?.biomass_kg      ?? (record['biomass_kg'] as number | null),
      fish_count:      input.overrides?.fish_count      ?? (record['fish_count'] as number | null),
      turbidity_ntu:   input.overrides?.turbidity_ntu   ?? (record['turbidity_ntu'] as number | null),
      notes:           input.overrides?.notes           ?? (record['notes'] as string | null),
    };

    // 3. Resolver org_id para las alertas (via batch → pond → organization_id)
    const batchData  = record['batches'] as { pond_id: string; ponds: { organization_id: string } } | null;
    const orgId      = batchData?.ponds?.organization_id ?? '';
    const pondId     = batchData?.pond_id;

    // 4. Obtener registro anterior del mismo lote para ADG
    const batchId = record['batch_id'] as string | undefined;
    const recordDate = record['record_date'] as string | undefined;
    const prevRecord = batchId && recordDate
      ? await this.db.getPreviousProductionRecord(batchId, recordDate, input.recordId)
      : null;

    // 5. Calcular biomasa, FCA, ADG y FCA efectivo
    const calc = this.calculations.compute(
      final,
      input.batchPopulation ?? null,
      input.biomassYesterdayKg ?? null,
      recordDate ?? new Date().toISOString().slice(0, 10),
      prevRecord,
      input.configuredFca ?? null,
    );

    // 6. Confirmar registro
    await this.db.confirmProductionRecord(input.recordId, {
      ...final,
      calculated_biomass_kg: calc.total_biomass_kg,
      calculated_fca:        calc.fca,
      effective_fca:         calc.effective_fca,
      adg_g_per_day:         calc.adg_g_per_day,
    });

    // 6. Generar alertas
    await this.alerts.evaluate({
      id:              input.recordId,
      organizationId:  orgId,
      pondId,
      batchId:         record['batch_id'] as string | undefined,
      oxygen_mg_l:     final.oxygen_mg_l,
      ammonia_mg_l:    final.ammonia_mg_l,
      nitrite_mg_l:    final.nitrite_mg_l,
      nitrate_mg_l:    final.nitrate_mg_l,
      ph:              final.ph,
      temperature_c:   final.temperature_c,
      mortality_count: final.mortality_count,
      fca:             calc.fca,
      populationCount: input.batchPopulation ?? null,
    });

    logger.info({ recordId: input.recordId }, 'Production record confirmed');
  }
}
