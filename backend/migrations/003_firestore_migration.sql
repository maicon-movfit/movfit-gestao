-- Camada de transição para preservar integralmente documentos do Firestore.
-- Os módulos podem ser normalizados aos poucos sem perder campos históricos.

CREATE TABLE IF NOT EXISTS app_importacoes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    origem text NOT NULL,
    arquivo text,
    status text NOT NULL CHECK (status IN ('iniciada', 'concluida', 'falhou')),
    total_documentos integer NOT NULL DEFAULT 0,
    checksum text,
    detalhes jsonb NOT NULL DEFAULT '{}'::jsonb,
    iniciada_em timestamptz NOT NULL DEFAULT now(),
    concluida_em timestamptz
);

CREATE TABLE IF NOT EXISTS app_documentos_legados (
    caminho text PRIMARY KEY,
    colecao text NOT NULL,
    documento_id text NOT NULL,
    caminho_pai text,
    unidade_id text REFERENCES app_unidades(id) ON UPDATE CASCADE,
    dados jsonb NOT NULL,
    checksum text NOT NULL,
    importacao_id uuid REFERENCES app_importacoes(id) ON DELETE SET NULL,
    versao bigint NOT NULL DEFAULT 1,
    excluido boolean NOT NULL DEFAULT false,
    origem_criado_em timestamptz,
    origem_atualizado_em timestamptz,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    CHECK (caminho <> '' AND colecao <> '' AND documento_id <> '')
);

CREATE INDEX IF NOT EXISTS app_documentos_legados_colecao_idx
    ON app_documentos_legados (colecao, unidade_id);
CREATE INDEX IF NOT EXISTS app_documentos_legados_pai_idx
    ON app_documentos_legados (caminho_pai);
CREATE INDEX IF NOT EXISTS app_documentos_legados_dados_gin_idx
    ON app_documentos_legados USING gin (dados jsonb_path_ops);

CREATE TABLE IF NOT EXISTS app_documentos_historico (
    id bigserial PRIMARY KEY,
    caminho text NOT NULL,
    versao bigint NOT NULL,
    dados jsonb NOT NULL,
    checksum text NOT NULL,
    importacao_id uuid REFERENCES app_importacoes(id) ON DELETE SET NULL,
    registrado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (caminho, versao)
);

CREATE OR REPLACE FUNCTION app_preservar_versao_documento_legado()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.checksum IS DISTINCT FROM NEW.checksum THEN
        INSERT INTO app_documentos_historico
            (caminho, versao, dados, checksum, importacao_id)
        VALUES
            (OLD.caminho, OLD.versao, OLD.dados, OLD.checksum, OLD.importacao_id)
        ON CONFLICT (caminho, versao) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_documentos_legados_preservar_versao
    ON app_documentos_legados;
CREATE TRIGGER app_documentos_legados_preservar_versao
BEFORE UPDATE ON app_documentos_legados
FOR EACH ROW
EXECUTE FUNCTION app_preservar_versao_documento_legado();

ALTER TABLE app_usuarios
    ADD COLUMN IF NOT EXISTS firebase_uid text UNIQUE,
    ADD COLUMN IF NOT EXISTS provedor_auth text NOT NULL DEFAULT 'firebase',
    ADD COLUMN IF NOT EXISTS senha_hash text,
    ADD COLUMN IF NOT EXISTS ultimo_login_em timestamptz;

ALTER TABLE app_usuarios DROP CONSTRAINT IF EXISTS app_usuarios_provedor_auth_check;
ALTER TABLE app_usuarios ADD CONSTRAINT app_usuarios_provedor_auth_check
    CHECK (provedor_auth IN ('firebase', 'local', 'migrado'));

CREATE TABLE IF NOT EXISTS app_sessoes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id uuid NOT NULL REFERENCES app_usuarios(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expira_em timestamptz NOT NULL,
    revogada_em timestamptz,
    ip inet,
    user_agent text,
    criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_sessoes_usuario_idx
    ON app_sessoes (usuario_id, expira_em DESC);

CREATE TABLE IF NOT EXISTS app_convites_acesso (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id uuid NOT NULL REFERENCES app_usuarios(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expira_em timestamptz NOT NULL,
    utilizado_em timestamptz,
    criado_em timestamptz NOT NULL DEFAULT now()
);
