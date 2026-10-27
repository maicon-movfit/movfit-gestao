-- Snapshot mensal imutável após o fechamento da competência.
-- Esta migration é apenas aditiva e não altera competências já fechadas.

ALTER TABLE app_meses
    ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS checksum text,
    ADD COLUMN IF NOT EXISTS coletado_em timestamptz;

CREATE INDEX IF NOT EXISTS app_competencias_fechadas_idx
    ON app_competencias (competencia DESC, unidade_id)
    WHERE status = 'fechada';
