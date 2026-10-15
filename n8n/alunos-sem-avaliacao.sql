BEGIN;

CREATE TABLE IF NOT EXISTS public.alunos_sem_avaliacao (
    unidade_codigo integer NOT NULL,
    codigo_cliente bigint NOT NULL,
    unidade_nome text NOT NULL,
    matricula text NOT NULL,
    nome_aluno text NOT NULL,
    nome_avaliador text,
    nome_professor text,
    observacao text,
    modalidade text,
    indicador text NOT NULL DEFAULT 'IND_AF_ATIVOS_SEM',
    pagina_origem integer NOT NULL DEFAULT 0,
    coletado_em timestamptz NOT NULL,
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT alunos_sem_avaliacao_pk
        PRIMARY KEY (unidade_codigo, codigo_cliente)
);

CREATE INDEX IF NOT EXISTS alunos_sem_avaliacao_matricula_idx
    ON public.alunos_sem_avaliacao (unidade_codigo, matricula);

CREATE TABLE IF NOT EXISTS public.coletas_alunos_sem_avaliacao (
    unidade_codigo integer PRIMARY KEY,
    unidade_nome text NOT NULL,
    indicador text NOT NULL,
    total_api integer NOT NULL CHECK (total_api >= 0),
    coletado_em timestamptz NOT NULL,
    atualizado_em timestamptz NOT NULL DEFAULT now()
);

COMMIT;
