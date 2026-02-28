-- =============================================================================
-- AquaBot — Schema inicial
-- Ejecutar en Supabase SQL Editor o con psql
-- =============================================================================

-- ─── Extensiones ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Enum Types ───────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE whatsapp_provider_type AS ENUM ('baileys', 'twilio');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE message_status AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'REJECTED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE record_status AS ENUM ('PENDING_REVIEW', 'CONFIRMED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alert_severity AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alert_status AS ENUM ('UNREAD', 'READ', 'RESOLVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- TABLA: whatsapp_messages
-- Registro de cada mensaje entrante — fuente de verdad del canal.
-- =============================================================================
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid                    NOT NULL,
  user_id           uuid,                   -- null si número no está registrado

  provider_type     whatsapp_provider_type  NOT NULL,
  provider_msg_id   text                    NOT NULL,
  sender_phone      text                    NOT NULL,
  received_at       timestamptz             NOT NULL DEFAULT now(),

  has_media         boolean                 NOT NULL DEFAULT false,
  media_url         text,
  media_mime_type   text,
  media_size_bytes  integer,
  raw_body          text,

  status            message_status          NOT NULL DEFAULT 'RECEIVED',
  error_message     text,

  UNIQUE (provider_type, provider_msg_id)
);

CREATE INDEX IF NOT EXISTS idx_wamsg_org_received ON whatsapp_messages(org_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_wamsg_sender       ON whatsapp_messages(sender_phone);

ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "wamsg_org_isolation" ON whatsapp_messages
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- =============================================================================
-- TABLA: ocr_jobs
-- Job de procesamiento OCR. 1 mensaje → 1 job.
-- =============================================================================
CREATE TABLE IF NOT EXISTS ocr_jobs (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid        NOT NULL,
  whatsapp_message_id   uuid        NOT NULL REFERENCES whatsapp_messages(id),

  status                job_status  NOT NULL DEFAULT 'PENDING',
  attempt_count         integer     NOT NULL DEFAULT 0,
  max_attempts          integer     NOT NULL DEFAULT 3,
  last_attempt_at       timestamptz,
  completed_at          timestamptz,

  last_error_code       text,
  last_error_message    text,
  worker_id             text,
  processing_ms         integer,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (whatsapp_message_id)
);

CREATE INDEX IF NOT EXISTS idx_ocrjob_org_status ON ocr_jobs(org_id, status);
CREATE INDEX IF NOT EXISTS idx_ocrjob_pending    ON ocr_jobs(status, created_at) WHERE status = 'PENDING';

ALTER TABLE ocr_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "ocrjob_org_isolation" ON ocr_jobs
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- =============================================================================
-- TABLA: ocr_results
-- Resultado del pipeline OCR con todos los campos y confidence scores.
-- =============================================================================
CREATE TABLE IF NOT EXISTS ocr_results (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL,
  ocr_job_id      uuid        NOT NULL REFERENCES ocr_jobs(id),

  -- Campos detectados (null = no detectado)
  field_date              date,
  field_date_conf         numeric(4,3),

  field_pond_name         text,
  field_pond_name_conf    numeric(4,3),

  field_batch_code        text,
  field_batch_code_conf   numeric(4,3),

  field_feed_kg           numeric(10,3),
  field_feed_kg_conf      numeric(4,3),

  field_avg_weight_g      numeric(10,3),
  field_avg_weight_g_conf numeric(4,3),

  field_mortality_count   integer,
  field_mortality_conf    numeric(4,3),

  field_temperature_c     numeric(5,2),
  field_temperature_conf  numeric(4,3),

  field_oxygen_mgl        numeric(5,2),
  field_oxygen_conf       numeric(4,3),

  field_ammonia_mgl       numeric(6,4),
  field_ammonia_conf      numeric(4,3),

  field_nitrite_mgl       numeric(6,4),
  field_nitrite_conf      numeric(4,3),

  field_nitrate_mgl       numeric(6,3),
  field_nitrate_conf      numeric(4,3),

  field_ph                numeric(4,2),
  field_ph_conf           numeric(4,3),

  field_observations      text,
  field_observations_conf numeric(4,3),

  raw_claude_response     jsonb,
  overall_confidence      numeric(4,3),
  is_valid                boolean     NOT NULL DEFAULT false,
  rejection_reasons       text[],

  created_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (ocr_job_id)
);

ALTER TABLE ocr_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "ocrresult_org_isolation" ON ocr_results
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- =============================================================================
-- TABLA: production_records
-- El registro productivo real. PENDING_REVIEW → CONFIRMED por un admin.
-- =============================================================================
CREATE TABLE IF NOT EXISTS production_records (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid          NOT NULL,
  ocr_job_id            uuid          REFERENCES ocr_jobs(id),
  whatsapp_message_id   uuid          REFERENCES whatsapp_messages(id),
  reported_by_user_id   uuid,
  confirmed_by_user_id  uuid,

  -- Identificación del registro
  pond_id               uuid,         -- FK a tabla ponds (si existe en catálogo)
  pond_name_raw         text          NOT NULL,
  batch_id              uuid,         -- FK a tabla batches
  batch_code_raw        text,
  record_date           date          NOT NULL,

  -- Datos productivos (editables por admin antes de confirmar)
  feed_kg               numeric(10,3),
  avg_weight_g          numeric(10,3),
  mortality_count       integer,
  temperature_c         numeric(5,2),
  oxygen_mgl            numeric(5,2),
  ammonia_mgl           numeric(6,4),
  nitrite_mgl           numeric(6,4),
  nitrate_mgl           numeric(6,3),
  ph                    numeric(4,2),
  observations          text,

  -- Cálculos (se llenan al confirmar)
  total_biomass_kg      numeric(12,3),
  fca                   numeric(6,3),
  population_count      integer,

  image_url             text,

  status                record_status NOT NULL DEFAULT 'PENDING_REVIEW',
  confirmed_at          timestamptz,
  rejection_reason      text,

  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prodrec_org_status  ON production_records(org_id, status);
CREATE INDEX IF NOT EXISTS idx_prodrec_org_date    ON production_records(org_id, record_date DESC);
CREATE INDEX IF NOT EXISTS idx_prodrec_pending     ON production_records(org_id, created_at)
  WHERE status = 'PENDING_REVIEW';

ALTER TABLE production_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "prodrec_org_isolation" ON production_records
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- =============================================================================
-- TABLA: alerts
-- Alertas técnicas generadas al confirmar un registro que viola umbrales.
-- =============================================================================
CREATE TABLE IF NOT EXISTS alerts (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid          NOT NULL,
  production_record_id  uuid          NOT NULL REFERENCES production_records(id),
  pond_id               uuid,
  batch_id              uuid,

  alert_type            text          NOT NULL,
  severity              alert_severity NOT NULL,
  message               text          NOT NULL,

  parameter_name        text,
  parameter_value       numeric,
  threshold_value       numeric,

  status                alert_status  NOT NULL DEFAULT 'UNREAD',
  read_by_user_id       uuid,
  read_at               timestamptz,
  resolved_at           timestamptz,

  created_at            timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_org_status   ON alerts(org_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_org_severity ON alerts(org_id, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unread       ON alerts(org_id, created_at DESC)
  WHERE status = 'UNREAD';

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "alerts_org_isolation" ON alerts
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- =============================================================================
-- FUNCIÓN: updated_at automático
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_prodrec_updated_at
  BEFORE UPDATE ON production_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_ocrjob_updated_at
  BEFORE UPDATE ON ocr_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
