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
}

export interface CalculationResult {
  total_biomass_kg: number | null;
  /** Factor de Conversión Alimenticia. Requiere biomasa previa para ser exacto. */
  fca: number | null;
}

export class CalculationsService {
  /**
   * Calcula biomasa total a partir del peso promedio y la población del lote.
   *
   * @param avgWeightG     - Peso promedio en gramos
   * @param populationCount - Población actual del lote (antes de mortalidad del día)
   * @param mortalityCount  - Mortalidad del día
   */
  calculateBiomass(
    avgWeightG: number | null,
    populationCount: number | null,
    mortalityCount: number | null,
  ): number | null {
    if (!avgWeightG || !populationCount) return null;

    const effectivePopulation = populationCount - (mortalityCount ?? 0);
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

  compute(record: RecordData, populationCount: number | null, biomassYesterdayKg: number | null): CalculationResult {
    const totalBiomassKg = this.calculateBiomass(
      record.avg_weight_g ?? null,
      populationCount,
      record.mortality_count ?? null,
    );

    const fca = this.calculateFca(record.feed_kg ?? null, totalBiomassKg, biomassYesterdayKg);

    return { total_biomass_kg: totalBiomassKg, fca };
  }
}
