import { logger } from '../shared/logger';

export interface RecordData {
  feed_kg?: number | null;
  avg_weight_g?: number | null;
  mortality_count?: number | null;
  oxygen_mgl?: number | null;
  ammonia_mgl?: number | null;
  nitrite_mgl?: number | null;
  nitrate_mgl?: number | null;
  ph?: number | null;
  temperature_c?: number | null;
  biomass_kg?: number | null;
  fish_count?: number | null;
}

export interface PreviousRecord {
  avg_weight_g: number | null;
  record_date: string;
}

export interface CalculationResult {
  /** Biomasa final: manual si existe, si no calculada. */
  total_biomass_kg: number | null;
  /** FCA calculado (alimento / ganancia de biomasa). */
  fca: number | null;
  /** FCA que se usará efectivamente (configurado o calculado). */
  effective_fca: number | null;
  /** Ganancia diaria promedio en gramos por día. */
  adg_g_per_day: number | null;
}

export class CalculationsService {
  /**
   * Resuelve la biomasa total del estanque.
   * Prioridad:
   * 1. Biomasa manual si el usuario la envió.
   * 2. Cálculo: (avgWeightG / 1000) × (fishCount − mortalityCount)
   */
  resolveBiomass(
    biomassManualKg: number | null,
    avgWeightG: number | null,
    fishCount: number | null,
    mortalityCount: number | null,
  ): number | null {
    // 1. Prioridad: biomasa manual
    if (biomassManualKg !== null && biomassManualKg > 0) {
      return Math.round(biomassManualKg * 100) / 100;
    }

    // 2. Fallback: cálculo desde peso promedio y población
    if (!avgWeightG || !fishCount) return null;

    const effectivePopulation = fishCount - (mortalityCount ?? 0);
    if (effectivePopulation <= 0) return null;

    const biomassKg = (avgWeightG / 1000) * effectivePopulation;
    return Math.round(biomassKg * 100) / 100;
  }

  /**
   * FCA = kg alimento consumido / kg de biomasa ganada.
   * Para el cálculo exacto se necesita la biomasa del día anterior.
   * Si no se provee, retorna null.
   */
  calculateFca(
    feedKg: number | null,
    biomassTodayKg: number | null,
    biomassYesterdayKg: number | null,
  ): number | null {
    if (!feedKg || !biomassTodayKg || !biomassYesterdayKg) return null;

    const biomassGain = biomassTodayKg - biomassYesterdayKg;
    if (biomassGain <= 0) {
      logger.warn({ feedKg, biomassTodayKg, biomassYesterdayKg }, 'Non-positive biomass gain — FCA not calculated');
      return null;
    }

    const fca = feedKg / biomassGain;
    return Math.round(fca * 1000) / 1000;
  }

  /**
   * ADG (Average Daily Gain) = diferencia de peso promedio / días transcurridos.
   * Requiere el registro anterior del mismo lote.
   */
  calculateAdg(
    avgWeightG: number | null,
    prevAvgWeightG: number | null,
    daysDiff: number,
  ): number | null {
    if (!avgWeightG || !prevAvgWeightG || daysDiff <= 0) return null;

    const gain = avgWeightG - prevAvgWeightG;
    const adg = gain / daysDiff;
    return Math.round(adg * 1000) / 1000;
  }

  /**
   * Resuelve el FCA efectivo.
   * - Si la finca tiene un FCA configurado, se puede usar ese.
   * - Si no, se usa el FCA calculado.
   */
  resolveEffectiveFca(calculatedFca: number | null, configuredFca: number | null): number | null {
    if (configuredFca !== null && configuredFca > 0) {
      return Math.round(configuredFca * 1000) / 1000;
    }
    return calculatedFca;
  }

  compute(
    record: RecordData,
    populationCount: number | null,
    biomassYesterdayKg: number | null,
    currentRecordDate: string,
    prevRecord?: PreviousRecord | null,
    configuredFca?: number | null,
  ): CalculationResult {
    // 1. Biomasa total (manual primero, luego calculada)
    const totalBiomassKg = this.resolveBiomass(
      record.biomass_kg ?? null,
      record.avg_weight_g ?? null,
      record.fish_count ?? populationCount ?? null,
      record.mortality_count ?? null,
    );

    // 2. FCA calculado
    const fca = this.calculateFca(
      record.feed_kg ?? null,
      totalBiomassKg,
      biomassYesterdayKg,
    );

    // 3. FCA efectivo
    const effectiveFca = this.resolveEffectiveFca(fca, configuredFca ?? null);

    // 4. ADG (ganancia diaria)
    let adgGPerDay: number | null = null;
    if (prevRecord && record.avg_weight_g != null && prevRecord.avg_weight_g != null) {
      const daysDiff = this.daysBetween(prevRecord.record_date, currentRecordDate);
      adgGPerDay = this.calculateAdg(record.avg_weight_g, prevRecord.avg_weight_g, daysDiff);
    }

    return {
      total_biomass_kg: totalBiomassKg,
      fca,
      effective_fca: effectiveFca,
      adg_g_per_day: adgGPerDay,
    };
  }

  /** Días entre dos fechas ISO (YYYY-MM-DD). Siempre positivo. */
  private daysBetween(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffMs = end.getTime() - start.getTime();
    return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
  }
}
