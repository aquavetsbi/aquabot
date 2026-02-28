import type { SupabaseRepo } from '../infrastructure/supabase.client';
import { logger } from '../shared/logger';

interface AlertCandidate {
  alertType: string;
  severity: string;
  message: string;
  parameterName: string;
  parameterValue: number;
  thresholdValue: number;
}

export interface RecordForAlerts {
  id: string;
  organizationId: string;     // alerts.organization_id (schema existente)
  pondId?: string;
  batchId?: string;
  oxygen_mg_l?: number | null;
  ammonia_mg_l?: number | null;
  nitrite_mg_l?: number | null;
  nitrate_mg_l?: number | null;
  ph?: number | null;
  temperature_c?: number | null;
  mortality_count?: number | null;
  fca?: number | null;
  populationCount?: number | null;
}

// ─── Umbrales acuicultura agua dulce tropical ─────────────────────────────────
const T = {
  oxygen:      { medium: 6.0,  high: 5.0  },
  ammonia:     { medium: 0.25, high: 0.5  },
  nitrite:     { medium: 0.5,  high: 1.0  },
  nitrate:     { medium: 50,   high: 100  },
  ph_low:      { medium: 6.5,  high: 6.0  },
  ph_high:     { medium: 8.5,  high: 9.0  },
  temp_low:    { medium: 22,   high: 20   },
  temp_high:   { medium: 30,   high: 32   },
  mortality:   { medium: 1.0,  high: 3.0  }, // % de la población
  fca:         { medium: 2.0,  high: 3.0  },
} as const;

export class AlertsService {
  constructor(private readonly db: SupabaseRepo) {}

  async evaluate(record: RecordForAlerts): Promise<void> {
    const candidates: AlertCandidate[] = [];

    this.below(candidates, record.oxygen_mg_l, 'LOW_OXYGEN', 'Oxígeno disuelto',
      T.oxygen.medium, T.oxygen.high);

    this.above(candidates, record.ammonia_mg_l, 'HIGH_AMMONIA', 'Amonio (NH₃)',
      T.ammonia.medium, T.ammonia.high);

    this.above(candidates, record.nitrite_mg_l, 'HIGH_NITRITE', 'Nitritos',
      T.nitrite.medium, T.nitrite.high);

    this.above(candidates, record.nitrate_mg_l, 'HIGH_NITRATE', 'Nitratos',
      T.nitrate.medium, T.nitrate.high);

    this.checkPh(candidates, record.ph);
    this.checkTemperature(candidates, record.temperature_c);
    this.checkMortality(candidates, record.mortality_count, record.populationCount);
    this.checkFca(candidates, record.fca);

    if (candidates.length === 0) return;

    logger.info({ recordId: record.id, count: candidates.length }, 'Inserting alerts');

    await Promise.all(
      candidates.map((c) =>
        this.db.insertAlert({
          organizationId:      record.organizationId,
          productionRecordId:  record.id,
          pondId:              record.pondId,
          batchId:             record.batchId,
          alertType:           c.alertType,
          severity:            c.severity,
          message:             c.message,
          parameterName:       c.parameterName,
          parameterValue:      c.parameterValue,
          thresholdValue:      c.thresholdValue,
        }),
      ),
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private below(out: AlertCandidate[], val: number | null | undefined,
    type: string, label: string, warnAt: number, critAt: number): void {
    if (val == null) return;
    if (val < critAt) {
      out.push({ alertType: type, severity: 'HIGH',
        message: `🚨 ${label} crítico: ${val} mg/L (mín. ${critAt} mg/L)`,
        parameterName: type.toLowerCase(), parameterValue: val, thresholdValue: critAt });
    } else if (val < warnAt) {
      out.push({ alertType: type, severity: 'MEDIUM',
        message: `⚠️ ${label} bajo: ${val} mg/L (mín. ${warnAt} mg/L)`,
        parameterName: type.toLowerCase(), parameterValue: val, thresholdValue: warnAt });
    }
  }

  private above(out: AlertCandidate[], val: number | null | undefined,
    type: string, label: string, warnAt: number, critAt: number): void {
    if (val == null) return;
    if (val >= critAt) {
      out.push({ alertType: type, severity: 'HIGH',
        message: `🚨 ${label} en nivel crítico: ${val} mg/L (máx. ${critAt} mg/L)`,
        parameterName: type.toLowerCase(), parameterValue: val, thresholdValue: critAt });
    } else if (val >= warnAt) {
      out.push({ alertType: type, severity: 'MEDIUM',
        message: `⚠️ ${label} elevado: ${val} mg/L (máx. ${warnAt} mg/L)`,
        parameterName: type.toLowerCase(), parameterValue: val, thresholdValue: warnAt });
    }
  }

  private checkPh(out: AlertCandidate[], ph: number | null | undefined): void {
    if (ph == null) return;
    if (ph >= T.ph_high.high)      out.push({ alertType: 'HIGH_PH', severity: 'HIGH',   message: `🚨 pH muy alto: ${ph}`, parameterName: 'ph', parameterValue: ph, thresholdValue: T.ph_high.high });
    else if (ph >= T.ph_high.medium) out.push({ alertType: 'HIGH_PH', severity: 'MEDIUM', message: `⚠️ pH elevado: ${ph}`,  parameterName: 'ph', parameterValue: ph, thresholdValue: T.ph_high.medium });
    else if (ph <= T.ph_low.high)    out.push({ alertType: 'LOW_PH',  severity: 'HIGH',   message: `🚨 pH muy bajo: ${ph}`, parameterName: 'ph', parameterValue: ph, thresholdValue: T.ph_low.high });
    else if (ph <= T.ph_low.medium)  out.push({ alertType: 'LOW_PH',  severity: 'MEDIUM', message: `⚠️ pH bajo: ${ph}`,    parameterName: 'ph', parameterValue: ph, thresholdValue: T.ph_low.medium });
  }

  private checkTemperature(out: AlertCandidate[], temp: number | null | undefined): void {
    if (temp == null) return;
    if (temp >= T.temp_high.high)     out.push({ alertType: 'HIGH_TEMPERATURE', severity: 'HIGH', message: `🚨 Temperatura crítica: ${temp}°C`, parameterName: 'temperature_c', parameterValue: temp, thresholdValue: T.temp_high.high });
    else if (temp <= T.temp_low.high) out.push({ alertType: 'LOW_TEMPERATURE',  severity: 'HIGH', message: `🚨 Temperatura muy baja: ${temp}°C`, parameterName: 'temperature_c', parameterValue: temp, thresholdValue: T.temp_low.high });
  }

  private checkMortality(out: AlertCandidate[], count: number | null | undefined, pop: number | null | undefined): void {
    if (count == null || !pop) return;
    const pct = (count / pop) * 100;
    if (pct >= T.mortality.high)       out.push({ alertType: 'HIGH_MORTALITY', severity: 'HIGH',   message: `🚨 Mortalidad elevada: ${count} peces (${pct.toFixed(2)}%)`, parameterName: 'mortality_count', parameterValue: count, thresholdValue: T.mortality.high });
    else if (pct >= T.mortality.medium) out.push({ alertType: 'HIGH_MORTALITY', severity: 'MEDIUM', message: `⚠️ Mortalidad inusual: ${count} peces (${pct.toFixed(2)}%)`,  parameterName: 'mortality_count', parameterValue: count, thresholdValue: T.mortality.medium });
  }

  private checkFca(out: AlertCandidate[], fca: number | null | undefined): void {
    if (fca == null) return;
    if (fca >= T.fca.high)       out.push({ alertType: 'HIGH_FCA', severity: 'HIGH',   message: `🚨 FCA fuera de rango: ${fca}`, parameterName: 'fca', parameterValue: fca, thresholdValue: T.fca.high });
    else if (fca >= T.fca.medium) out.push({ alertType: 'HIGH_FCA', severity: 'MEDIUM', message: `⚠️ FCA alto: ${fca}`,           parameterName: 'fca', parameterValue: fca, thresholdValue: T.fca.medium });
  }
}
