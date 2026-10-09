-- Histórico mensal aditivo para matriculas_mov_fit.
-- Não altera a tabela operacional nem sua chave primária atual.

BEGIN;

CREATE TABLE IF NOT EXISTS public.matriculas_mov_fit_historico
    (LIKE public.matriculas_mov_fit INCLUDING DEFAULTS);

ALTER TABLE public.matriculas_mov_fit_historico
    ADD COLUMN IF NOT EXISTS arquivado_em timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.matriculas_mov_fit_historico'::regclass
          AND contype = 'p'
    ) THEN
        ALTER TABLE public.matriculas_mov_fit_historico
            ADD CONSTRAINT matriculas_mov_fit_historico_pkey
            PRIMARY KEY (unidade_codigo, codigo_contrato, competencia_coleta);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_matriculas_historico_competencia
    ON public.matriculas_mov_fit_historico (competencia_coleta, unidade_codigo);

CREATE INDEX IF NOT EXISTS idx_matriculas_historico_cliente
    ON public.matriculas_mov_fit_historico
       (unidade_codigo, codigo_cliente, competencia_coleta);

CREATE TABLE IF NOT EXISTS public.matriculas_mov_fit_coletas (
    unidade_codigo integer NOT NULL,
    competencia date NOT NULL,
    status text NOT NULL CHECK (status IN ('CONCLUIDA', 'FALHA')),
    registros_esperados integer NOT NULL CHECK (registros_esperados >= 0),
    registros_arquivados integer NOT NULL CHECK (registros_arquivados >= 0),
    coletado_em timestamptz,
    finalizado_em timestamptz NOT NULL DEFAULT now(),
    erro text,
    PRIMARY KEY (unidade_codigo, competencia)
);

-- Preserva imediatamente tudo que existe antes da instalação desta estrutura.
INSERT INTO public.matriculas_mov_fit_historico
SELECT m.*, now()
FROM public.matriculas_mov_fit m
ON CONFLICT (unidade_codigo, codigo_contrato, competencia_coleta) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fechar_coleta_matriculas(
    p_unidade_codigo integer,
    p_competencia date,
    p_registros_esperados integer,
    p_coletado_em timestamptz,
    p_contratos_coletados jsonb
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_competencia date := date_trunc('month', p_competencia)::date;
    v_mes_atual date := date_trunc(
        'month', timezone('America/Sao_Paulo', now())
    )::date;
    v_total integer;
BEGIN
    IF v_competencia < v_mes_atual THEN
        RAISE EXCEPTION
            'Competencia encerrada % nao pode ser regravada', v_competencia;
    END IF;

    IF jsonb_typeof(p_contratos_coletados) <> 'array' THEN
        RAISE EXCEPTION 'A lista de contratos coletados deve ser um array JSON';
    END IF;

    SELECT count(DISTINCT contrato)::integer INTO v_total
    FROM jsonb_array_elements_text(p_contratos_coletados) AS lista(contrato);

    IF v_total <> p_registros_esperados THEN
        RAISE EXCEPTION
            'Lista de contratos inconsistente da unidade %: esperados %, recebidos %',
            p_unidade_codigo, p_registros_esperados, v_total;
    END IF;

    -- Remove apenas registros que desapareceram da API durante a competencia
    -- corrente. Nenhuma outra unidade ou competencia e modificada.
    DELETE FROM public.matriculas_mov_fit m
    WHERE m.unidade_codigo = p_unidade_codigo
      AND m.competencia_coleta = v_competencia
      AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(p_contratos_coletados) AS lista(contrato)
          WHERE lista.contrato = m.codigo_contrato::text
      );

    SELECT count(*)::integer INTO v_total
    FROM public.matriculas_mov_fit
    WHERE unidade_codigo = p_unidade_codigo
      AND competencia_coleta = v_competencia;

    IF v_total <> p_registros_esperados THEN
        RAISE EXCEPTION
            'Coleta incompleta da unidade %: esperados %, encontrados %',
            p_unidade_codigo, p_registros_esperados, v_total;
    END IF;

    -- A competência corrente pode ser refeita. O DELETE + INSERT ocorre na mesma
    -- transação; leitores nunca observam um snapshot pela metade.
    DELETE FROM public.matriculas_mov_fit_historico
    WHERE unidade_codigo = p_unidade_codigo
      AND competencia_coleta = v_competencia;

    INSERT INTO public.matriculas_mov_fit_historico
    SELECT m.*, now()
    FROM public.matriculas_mov_fit m
    WHERE m.unidade_codigo = p_unidade_codigo
      AND m.competencia_coleta = v_competencia;

    INSERT INTO public.matriculas_mov_fit_coletas (
        unidade_codigo, competencia, status, registros_esperados,
        registros_arquivados, coletado_em, finalizado_em, erro
    ) VALUES (
        p_unidade_codigo, v_competencia, 'CONCLUIDA', p_registros_esperados,
        v_total, p_coletado_em, now(), NULL
    )
    ON CONFLICT (unidade_codigo, competencia) DO UPDATE SET
        status = EXCLUDED.status,
        registros_esperados = EXCLUDED.registros_esperados,
        registros_arquivados = EXCLUDED.registros_arquivados,
        coletado_em = EXCLUDED.coletado_em,
        finalizado_em = EXCLUDED.finalizado_em,
        erro = NULL;

    RETURN v_total;
END;
$$;

COMMIT;
