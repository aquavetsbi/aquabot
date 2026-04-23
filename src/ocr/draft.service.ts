import type { RedisClient } from '../infrastructure/redis.client';
import type { OcrData } from './types';

const DRAFT_TTL_SEC = 30 * 60; // 30 min sin actividad → expira

export interface OcrDraft {
  uploadId: string;
  imageUrl: string;
  data: OcrData;
  /** Campos editados manualmente por el operario. */
  edited: string[];
}

/** Alias en español para los campos del schema (insensible a tildes/mayúsculas). */
const FIELD_ALIASES: Record<string, keyof Omit<OcrData, 'confidence'>> = {
  // Fecha
  fecha: 'record_date',   date: 'record_date',
  semana: 'week_end_date', cierre: 'week_end_date', week: 'week_end_date',
  tipo: 'report_type', reporte: 'report_type',

  // Estanque
  estanque: 'pond_name',  pond: 'pond_name',  tanque: 'pond_name',

  // Peces
  peces: 'fish_count',    fish: 'fish_count',  cantidad: 'fish_count',  poblacion: 'fish_count',

  // Alimento
  alimento: 'feed_kg',    comida: 'feed_kg',   alimentacion: 'feed_kg',  feed: 'feed_kg',

  // Peso
  peso: 'avg_weight_g',   weight: 'avg_weight_g',
  muestreo: 'sampling_weight_g', pesomuestreo: 'sampling_weight_g', sampling: 'sampling_weight_g',

  // Mortalidad
  mortalidad: 'mortality_count',  muertos: 'mortality_count',  mortality: 'mortality_count',

  // Temperatura
  temperatura: 'temperature_c',  temp: 'temperature_c',  temperature: 'temperature_c',

  // Oxígeno
  oxigeno: 'oxygen_mg_l',  oxígeno: 'oxygen_mg_l',  o2: 'oxygen_mg_l',  oxygen: 'oxygen_mg_l',

  // Amonio
  amonio: 'ammonia_mg_l',  amoniaco: 'ammonia_mg_l',  nh3: 'ammonia_mg_l',  ammonia: 'ammonia_mg_l',

  // Nitritos
  nitritos: 'nitrite_mg_l',  nitrito: 'nitrite_mg_l',  no2: 'nitrite_mg_l',

  // Nitratos
  nitratos: 'nitrate_mg_l',  nitrato: 'nitrate_mg_l',  no3: 'nitrate_mg_l',

  // pH
  ph: 'ph',

  // Fosfatos
  fosfatos: 'phosphate_mg_l',  fosfato: 'phosphate_mg_l',  po4: 'phosphate_mg_l',

  // Dureza
  dureza: 'hardness_mg_l',  hardness: 'hardness_mg_l',

  // Alcalinidad
  alcalinidad: 'alkalinity_mg_l',  alkalinity: 'alkalinity_mg_l',

  // Turbidez
  turbidez: 'turbidity_ntu',  turbidity: 'turbidity_ntu',  ntu: 'turbidity_ntu',

  // Biomasa
  biomasa: 'biomass_kg',  biomass: 'biomass_kg',

  // Notas
  notas: 'notes',  observaciones: 'notes',  obs: 'notes',  notes: 'notes',
};

const CONFIRM_WORDS = new Set(['confirmar', 'confirmo', 'listo', 'ok', 'si', 'sí', 'correcto', 'correct', '✓', '✅', 'yes', 'dale', 'va']);
const CANCEL_WORDS  = new Set(['cancelar', 'cancel', 'descartar', 'borrar', 'no', 'nope']);

export class DraftService {
  constructor(private readonly redis: RedisClient) {}

  private key(phone: string) {
    return `draft:ocr:${phone}`;
  }

  async save(phone: string, draft: OcrDraft): Promise<void> {
    await this.redis.set(this.key(phone), JSON.stringify(draft), { ttlSeconds: DRAFT_TTL_SEC });
  }

  async get(phone: string): Promise<OcrDraft | null> {
    const raw = await this.redis.get(this.key(phone));
    return raw ? (JSON.parse(raw) as OcrDraft) : null;
  }

  async clear(phone: string): Promise<void> {
    await this.redis.del(this.key(phone));
  }

  /**
   * Intenta aplicar una corrección de texto al draft.
   * Formato esperado: "campo: valor"  o  "campo valor"
   * Retorna el draft actualizado si la corrección fue válida, null si no lo es.
   */
  applyCorrection(draft: OcrDraft, text: string): OcrDraft | null {
    const normalized = this.normalize(text);

    // Probar "campo: valor" y "campo valor"
    const patterns = [
      /^(.+?):\s*(.+)$/,   // "oxígeno: 7.2"
      /^(\S+)\s+(.+)$/,    // "oxigeno 7.2"
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (!match) continue;

      const rawField = match[1];
      const rawValue = match[2];
      if (!rawField || !rawValue) continue;

      const field = FIELD_ALIASES[rawField.trim()];
      if (!field) continue;

      const updated = this.applyFieldValue(draft, field, rawValue.trim());
      if (updated) return updated;
    }

    return null;
  }

  isConfirmation(text: string): boolean {
    return CONFIRM_WORDS.has(this.normalize(text).trim());
  }

  isCancellation(text: string): boolean {
    return CANCEL_WORDS.has(this.normalize(text).trim());
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // quitar tildes
      .trim();
  }

  private applyFieldValue(
    draft: OcrDraft,
    field: keyof Omit<OcrData, 'confidence'>,
    rawValue: string,
  ): OcrDraft | null {
    let parsed: string | number | null = null;

    if (field === 'notes' || field === 'pond_name') {
      parsed = rawValue;
    } else if (field === 'report_type') {
      parsed = this.parseReportType(rawValue);
      if (!parsed) return null;
    } else if (field === 'record_date') {
      // Intentar parsear fecha en varios formatos
      const iso = this.parseDate(rawValue);
      if (!iso) return null;
      parsed = iso;
    } else if (field === 'week_end_date') {
      const iso = this.parseDate(rawValue);
      if (!iso) return null;
      parsed = iso;
    } else {
      const num = parseFloat(rawValue.replace(',', '.'));
      if (isNaN(num)) return null;
      parsed = num;
    }

    const newData: OcrData = {
      ...draft.data,
      [field]: parsed,
      confidence: {
        ...draft.data.confidence,
        // Campo editado manualmente → confianza 100
        [field]: 100,
      },
    };

    return {
      ...draft,
      data: newData,
      edited: Array.from(new Set([...draft.edited, field])),
    };
  }

  private parseDate(value: string): string | null {
    // Formatos: DD/MM/YYYY, DD-MM-YYYY, DD/MM/YY, YYYY-MM-DD
    const patterns = [
      { re: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/, fn: (_: string, d: string, m: string, y: string) => `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}` },
      { re: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/,  fn: (_: string, d: string, m: string, y: string) => `20${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}` },
      { re: /^(\d{4})-(\d{2})-(\d{2})$/,                  fn: (s: string) => s },
    ];

    for (const { re, fn } of patterns) {
      const m = value.match(re);
      if (m) return fn(...(m as [string, string, string, string]));
    }
    return null;
  }

  private parseReportType(value: string): 'daily' | 'weekly' | null {
    const normalized = this.normalize(value);
    if (['daily', 'diario', 'dia', 'día'].includes(normalized)) return 'daily';
    if (['weekly', 'semanal', 'semana'].includes(normalized)) return 'weekly';
    return null;
  }
}
