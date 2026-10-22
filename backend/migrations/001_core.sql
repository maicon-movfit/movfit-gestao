CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_unidades (
    id text PRIMARY KEY,
    nome text NOT NULL,
    codigo_pacto integer UNIQUE,
    slug_pacto text UNIQUE,
    ativa boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_usuarios (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    nome text NOT NULL,
    papel text NOT NULL CHECK (papel IN ('admin', 'rt')),
    ativo boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_usuarios_email_lower_uidx ON app_usuarios (lower(email));

CREATE TABLE IF NOT EXISTS app_usuario_unidades (
    usuario_id uuid NOT NULL REFERENCES app_usuarios(id) ON DELETE CASCADE,
    unidade_id text NOT NULL REFERENCES app_unidades(id) ON DELETE CASCADE,
    criado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (usuario_id, unidade_id)
);

CREATE TABLE IF NOT EXISTS app_competencias (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unidade_id text NOT NULL REFERENCES app_unidades(id),
    competencia date NOT NULL CHECK (competencia = date_trunc('month', competencia)::date),
    status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'fechada')),
    fechado_em timestamptz,
    fechado_por uuid REFERENCES app_usuarios(id),
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (unidade_id, competencia)
);

CREATE TABLE IF NOT EXISTS app_meses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    competencia_id uuid NOT NULL REFERENCES app_competencias(id) ON DELETE CASCADE,
    nome text NOT NULL,
    dados jsonb NOT NULL DEFAULT '{}'::jsonb,
    registrado_por uuid REFERENCES app_usuarios(id),
    registrado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (competencia_id)
);

CREATE TABLE IF NOT EXISTS app_colaboradores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unidade_id text NOT NULL REFERENCES app_unidades(id),
    legado_id text,
    codigo_pacto bigint,
    tipo text NOT NULL DEFAULT 'professor' CHECK (tipo IN ('professor', 'estagiario', 'rt', 'outro')),
    nome text NOT NULL,
    email text,
    ativo boolean NOT NULL DEFAULT true,
    dados jsonb NOT NULL DEFAULT '{}'::jsonb,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_colaboradores_legado_uidx
    ON app_colaboradores (unidade_id, legado_id) WHERE legado_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS app_colaboradores_pacto_uidx
    ON app_colaboradores (unidade_id, codigo_pacto) WHERE codigo_pacto IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_metas_unidades (
    unidade_id text PRIMARY KEY REFERENCES app_unidades(id) ON DELETE CASCADE,
    metas jsonb NOT NULL DEFAULT '{}'::jsonb,
    atualizado_por uuid REFERENCES app_usuarios(id),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_fechamentos_semanais (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unidade_id text NOT NULL REFERENCES app_unidades(id),
    semana_inicio date NOT NULL,
    semana_fim date NOT NULL,
    status text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'concluido', 'reaberto')),
    indicadores jsonb NOT NULL DEFAULT '{}'::jsonb,
    concluido_por uuid REFERENCES app_usuarios(id),
    concluido_em timestamptz,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    CHECK (semana_fim >= semana_inicio),
    UNIQUE (unidade_id, semana_inicio)
);

CREATE TABLE IF NOT EXISTS app_fechamento_dias (
    fechamento_id uuid NOT NULL REFERENCES app_fechamentos_semanais(id) ON DELETE CASCADE,
    data date NOT NULL,
    dados jsonb NOT NULL DEFAULT '{}'::jsonb,
    preenchido_por uuid REFERENCES app_usuarios(id),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (fechamento_id, data)
);

CREATE TABLE IF NOT EXISTS app_ciclos_avaliacao (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    colaborador_id uuid NOT NULL REFERENCES app_colaboradores(id) ON DELETE CASCADE,
    legado_id text,
    tipo text NOT NULL DEFAULT 'radar',
    status text NOT NULL DEFAULT 'aberto',
    dados jsonb NOT NULL DEFAULT '{}'::jsonb,
    criado_por uuid REFERENCES app_usuarios(id),
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_ciclos_legado_uidx
    ON app_ciclos_avaliacao (colaborador_id, legado_id) WHERE legado_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_eventos_colaborador (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    colaborador_id uuid NOT NULL REFERENCES app_colaboradores(id) ON DELETE CASCADE,
    ciclo_id uuid REFERENCES app_ciclos_avaliacao(id) ON DELETE CASCADE,
    categoria text NOT NULL,
    dados jsonb NOT NULL DEFAULT '{}'::jsonb,
    criado_por uuid REFERENCES app_usuarios(id),
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_eventos_colaborador_lookup_idx
    ON app_eventos_colaborador (colaborador_id, categoria, criado_em DESC);

CREATE TABLE IF NOT EXISTS app_tokens_portal (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text NOT NULL UNIQUE,
    colaborador_id uuid NOT NULL REFERENCES app_colaboradores(id) ON DELETE CASCADE,
    finalidade text NOT NULL CHECK (finalidade IN ('portal', 'carteira', 'autoavaliacao')),
    ativo boolean NOT NULL DEFAULT true,
    expira_em timestamptz NOT NULL,
    ultimo_acesso_em timestamptz,
    criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_auditoria (
    id bigserial PRIMARY KEY,
    usuario_id uuid REFERENCES app_usuarios(id),
    unidade_id text REFERENCES app_unidades(id),
    entidade text NOT NULL,
    entidade_id text,
    acao text NOT NULL,
    antes jsonb,
    depois jsonb,
    ip inet,
    criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_auditoria_entidade_idx
    ON app_auditoria (entidade, entidade_id, criado_em DESC);

INSERT INTO app_unidades (id, nome, codigo_pacto, slug_pacto) VALUES
    ('premium24', 'Premium 24 Horas', 3, 'santarem_24h'),
    ('nrexpress', 'NR Express', 5, 'santarem_nova_republica'),
    ('itaituba', 'Itaituba', 2, 'itaituba'),
    ('medicilandia', 'Medicilândia', 1, 'medicilandia'),
    ('novoprogresso', 'Novo Progresso', 6, 'novo_progresso')
ON CONFLICT (id) DO UPDATE SET
    nome = EXCLUDED.nome,
    codigo_pacto = EXCLUDED.codigo_pacto,
    slug_pacto = EXCLUDED.slug_pacto,
    atualizado_em = now();
