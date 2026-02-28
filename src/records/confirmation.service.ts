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
    oxygen_mg_l?: number;     // nombre de columna existente en AquaData
    ammonia_mg_l?: number;
    nitrite_mg_l?: number;
    nitrate_mg_l?: number;
    ph?: number;
    notes?: string;           // columna 'notes' en AquaData
  };
  /** Población actual del lote — para cálculo de biomasa y % mortalidad. */
  batchPopulation?: number;
  /** Biomasa del día anterior — para cálculo exacto de FCA. */
  biomassYesterdayKg?: number;
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
    // Nombres de columna según schema existente de AquaData
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
      notes:           input.overrides?.notes           ?? (record['notes'] as string | null),
    };

    // 3. Resolver org_id para las alertas (via batch → pond → organization_id)
    const batchData  = record['batches'] as { pond_id: string; ponds: { organization_id: string } } | null;
    const orgId      = batchData?.ponds?.organization_id ?? '';
    const pondId     = batchData?.pond_id;

    // 4. Calcular biomasa y FCA
    const calc = this.calculations.compute(final, input.batchPopulation ?? null, input.biomassYesterdayKg ?? null);

    // 5. Confirmar registro — usa nombres de columna del schema existente
    await this.db.confirmProductionRecord(input.recordId, {
      ...final,
      calculated_biomass_kg: calc.total_biomass_kg,  // columna existente AquaData
      calculated_fca:        calc.fca,               // columna existente AquaData
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
