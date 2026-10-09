BEGIN;

CREATE TABLE IF NOT EXISTS public.pacto_indicadores_mensais (
    unidade_codigo integer NOT NULL,
    unidade_nome text NOT NULL,
    empresa_pacto_id integer NOT NULL,
    competencia date NOT NULL,
    alunos_ativos integer NOT NULL,
    contratos_total integer NOT NULL,
    contratos_ativos integer NOT NULL,
    contratos_vencidos integer NOT NULL,
    fechamento_anterior integer NOT NULL,
    matriculados_mes integer NOT NULL,
    rematriculados_mes integer NOT NULL,
    cancelados_mes integer NOT NULL,
    desistencias_mes integer NOT NULL,
    saldo_mes integer NOT NULL,
    churn numeric(10,4) NOT NULL,
    acessos_hoje integer NOT NULL,
    alunos_agora integer NOT NULL,
    acessos_mes integer NOT NULL,
    acessos_ultimos_30_dias integer NOT NULL,
    dia_pico text,
    horario_pico text,
    momento_pacto timestamptz,
    payload_alunos jsonb NOT NULL,
    payload_contratos jsonb NOT NULL,
    payload_acessos jsonb NOT NULL,
    coletado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (unidade_codigo, competencia)
);

CREATE INDEX IF NOT EXISTS idx_pacto_indicadores_competencia
    ON public.pacto_indicadores_mensais (competencia DESC, unidade_codigo);

CREATE OR REPLACE FUNCTION public.salvar_indicadores_pacto(p_dados jsonb)
RETURNS public.pacto_indicadores_mensais
LANGUAGE plpgsql
AS $$
DECLARE
    v_competencia date := date_trunc('month', (p_dados->>'competencia')::date)::date;
    v_mes_atual date := date_trunc('month', timezone('America/Sao_Paulo', now()))::date;
    v_resultado public.pacto_indicadores_mensais;
BEGIN
    IF v_competencia <> v_mes_atual THEN
        RAISE EXCEPTION 'Somente a competencia atual pode ser atualizada: %', v_competencia;
    END IF;

    INSERT INTO public.pacto_indicadores_mensais (
        unidade_codigo, unidade_nome, empresa_pacto_id, competencia,
        alunos_ativos, contratos_total, contratos_ativos, contratos_vencidos,
        fechamento_anterior, matriculados_mes, rematriculados_mes,
        cancelados_mes, desistencias_mes, saldo_mes, churn, acessos_hoje,
        alunos_agora, acessos_mes, acessos_ultimos_30_dias, dia_pico,
        horario_pico, momento_pacto, payload_alunos, payload_contratos,
        payload_acessos, coletado_em, atualizado_em
    ) VALUES (
        (p_dados->>'unidade_codigo')::integer, p_dados->>'unidade_nome',
        (p_dados->>'empresa_pacto_id')::integer, v_competencia,
        (p_dados->>'alunos_ativos')::integer, (p_dados->>'contratos_total')::integer,
        (p_dados->>'contratos_ativos')::integer, (p_dados->>'contratos_vencidos')::integer,
        (p_dados->>'fechamento_anterior')::integer, (p_dados->>'matriculados_mes')::integer,
        (p_dados->>'rematriculados_mes')::integer, (p_dados->>'cancelados_mes')::integer,
        (p_dados->>'desistencias_mes')::integer, (p_dados->>'saldo_mes')::integer,
        (p_dados->>'churn')::numeric, (p_dados->>'acessos_hoje')::integer,
        (p_dados->>'alunos_agora')::integer, (p_dados->>'acessos_mes')::integer,
        (p_dados->>'acessos_ultimos_30_dias')::integer, p_dados->>'dia_pico',
        p_dados->>'horario_pico', (p_dados->>'momento_pacto')::timestamptz,
        p_dados->'payload_alunos', p_dados->'payload_contratos',
        p_dados->'payload_acessos', now(), now()
    )
    ON CONFLICT (unidade_codigo, competencia) DO UPDATE SET
        unidade_nome = EXCLUDED.unidade_nome,
        empresa_pacto_id = EXCLUDED.empresa_pacto_id,
        alunos_ativos = EXCLUDED.alunos_ativos,
        contratos_total = EXCLUDED.contratos_total,
        contratos_ativos = EXCLUDED.contratos_ativos,
        contratos_vencidos = EXCLUDED.contratos_vencidos,
        fechamento_anterior = EXCLUDED.fechamento_anterior,
        matriculados_mes = EXCLUDED.matriculados_mes,
        rematriculados_mes = EXCLUDED.rematriculados_mes,
        cancelados_mes = EXCLUDED.cancelados_mes,
        desistencias_mes = EXCLUDED.desistencias_mes,
        saldo_mes = EXCLUDED.saldo_mes,
        churn = EXCLUDED.churn,
        acessos_hoje = EXCLUDED.acessos_hoje,
        alunos_agora = EXCLUDED.alunos_agora,
        acessos_mes = EXCLUDED.acessos_mes,
        acessos_ultimos_30_dias = EXCLUDED.acessos_ultimos_30_dias,
        dia_pico = EXCLUDED.dia_pico,
        horario_pico = EXCLUDED.horario_pico,
        momento_pacto = EXCLUDED.momento_pacto,
        payload_alunos = EXCLUDED.payload_alunos,
        payload_contratos = EXCLUDED.payload_contratos,
        payload_acessos = EXCLUDED.payload_acessos,
        coletado_em = now(),
        atualizado_em = now()
    RETURNING * INTO v_resultado;

    RETURN v_resultado;
END;
$$;

COMMIT;
