-- =============================================================================
-- AquaBot — Adiciones mínimas al schema existente de AquaData
-- Solo agrega columnas/índices. NUNCA modifica datos existentes.
-- Ejecutar en Supabase SQL Editor.
-- =============================================================================

-- ─── profiles: vincular número WhatsApp al usuario ───────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS whatsapp_phone text,
  ADD COLUMN IF NOT EXISTS whatsapp_lid   text,   -- LID de WhatsApp Multi-Device (ej: 204071092912202)
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Índice único parcial: solo indexa filas con teléfono asignado.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_whatsapp_phone_idx
  ON public.profiles(whatsapp_phone)
  WHERE whatsapp_phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_whatsapp_lid_idx
  ON public.profiles(whatsapp_lid)
  WHERE whatsapp_lid IS NOT NULL;

-- ─── uploads: metadata de WhatsApp + resultado OCR ───────────────────────────
-- La tabla uploads ya existe y tiene: id, batch_id, user_id, image_url,
-- raw_ocr_text, processed_data (jsonb), status, created_at.
--
-- Nuevas columnas para el bot:
ALTER TABLE public.uploads
  ADD COLUMN IF NOT EXISTS whatsapp_provider  text,          -- 'baileys' | 'twilio'
  ADD COLUMN IF NOT EXISTS whatsapp_msg_id    text,          -- ID del mensaje en el provider
  ADD COLUMN IF NOT EXISTS sender_phone       text,          -- +573001234567
  ADD COLUMN IF NOT EXISTS ocr_confidence     numeric(4,3),  -- confianza global del OCR
  ADD COLUMN IF NOT EXISTS ocr_field_confidences jsonb,      -- { "feed_kg": 0.92, ... }
  ADD COLUMN IF NOT EXISTS rejection_reason   text,          -- si OCR rechazó la imagen
  ADD COLUMN IF NOT EXISTS pond_name_raw      text,          -- nombre de estanque detectado
  ADD COLUMN IF NOT EXISTS record_date_raw    date;          -- fecha detectada en la imagen

-- Deduplicación: evitar reprocesar el mismo mensaje dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS uploads_wa_msg_dedup
  ON public.uploads(whatsapp_provider, whatsapp_msg_id)
  WHERE whatsapp_provider IS NOT NULL AND whatsapp_msg_id IS NOT NULL;

-- ─── production_records: flujo de revisión ───────────────────────────────────
-- Agrega review_status para el pipeline PENDING_REVIEW → CONFIRMED.
-- Hace batch_id nullable para registros donde el lote no fue resuelto
-- automáticamente y debe ser asignado manualmente por el admin.
ALTER TABLE public.production_records
  ADD COLUMN IF NOT EXISTS review_status    text    NOT NULL DEFAULT 'PENDING_REVIEW',
  ADD COLUMN IF NOT EXISTS fish_count       integer,
  ADD COLUMN IF NOT EXISTS phosphate_mg_l   numeric,
  ADD COLUMN IF NOT EXISTS hardness_mg_l    numeric,
  ADD COLUMN IF NOT EXISTS alkalinity_mg_l  numeric;

ALTER TABLE public.production_records
  ALTER COLUMN batch_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prodrec_review_status
  ON public.production_records(review_status, created_at DESC)
  WHERE review_status = 'PENDING_REVIEW';

-- ─── alerts: vincular a production_record + datos del umbral ─────────────────
-- La tabla alerts ya tiene: id, organization_id, pond_id, batch_id,
-- alert_type, severity, message, is_read, created_at.
ALTER TABLE public.alerts
  ADD COLUMN IF NOT EXISTS production_record_id uuid
    REFERENCES public.production_records(id),
  ADD COLUMN IF NOT EXISTS parameter_name  text,
  ADD COLUMN IF NOT EXISTS parameter_value numeric,
  ADD COLUMN IF NOT EXISTS threshold_value numeric;

CREATE INDEX IF NOT EXISTS idx_alerts_unread
  ON public.alerts(organization_id, created_at DESC)
  WHERE is_read = false;

CREATE INDEX IF NOT EXISTS idx_alerts_prod_record
  ON public.alerts(production_record_id);
