# Dados necessários para retirar a dependência do Firebase

Não envie senha da conta Google, chave privada, token, arquivo de credencial ou configuração de administrador. Para migrar os dados, é necessário o conteúdo dos documentos, seus IDs e caminhos completos.

## Formato aceito

Salve cada lote como JSON:

```json
{
  "exportedAt": "2026-10-22T18:00:00.000Z",
  "documents": [
    {
      "path": "unidades/premium24/meses/OUTUBRO_2026",
      "data": { "nome": "Outubro/26" },
      "createdAt": "2026-10-01T03:00:00.000Z",
      "updatedAt": "2026-10-22T18:00:00.000Z"
    }
  ]
}
```

`createdAt` e `updatedAt` são opcionais. `path` e `data` são obrigatórios. Datas existentes dentro de `data` devem ser mantidas exatamente como aparecem na exportação.

## Copiar primeiro — dados essenciais

Para cada unidade (`premium24`, `nrexpress`, `itaituba`, `medicilandia` e `novoprogresso`), exporte:

- `unidades/{unidade}/meses`
- `unidades/{unidade}/colaboradores`
- todas as subcoleções de cada colaborador: `performance`, `ciclos`, `mensagensRT`, `planos`, `vozColab`, `compromissos`, `checklist`, `identidade`, `aprendizados`, `conquistasRT`, `checkins` e `elevacao`
- `unidades/{unidade}/professores`
- `unidades/{unidade}/estagiarios`
- todas as subcoleções de estagiários: `ciclos`, `elevacao`, `vozColab`, `compromissos`, `compromissosRadar`, `aprendizados`, `checklist`, `identidade`, `conquistasRT`, `planoEstagio` e `diario`
- `unidades/{unidade}/agendasRt`
- `unidades/{unidade}/historicoScoreRT`
- `unidades/{unidade}/radarRT`, incluindo as subcoleções `semanas`, `registros` e `respostas`
- `unidades/{unidade}/pulsos`, incluindo `auditorias`
- `unidades/{unidade}/pulsoSemanal`
- `unidades/{unidade}/matriculados_competencias`
- `unidades/{unidade}/matriculados_alunos`
- `unidades/{unidade}/matriculados_relatorios`

## Copiar depois — dados globais

- `config/metas`
- `carteiraTokens` — pode ser migrada, mas os tokens serão substituídos por hashes novos antes da produção
- `_logs` e `_analytics` somente se o histórico de auditoria for necessário

Não é necessário copiar `configuracoes/pacto_api`: credenciais e tokens da Pacto não devem sair do backend/n8n nem ser importados como dados comuns.

## Usuários do Firebase Authentication

O Firestore não contém as contas de login. Exporte separadamente, sem senhas:

- `uid`
- e-mail
- nome de exibição
- conta ativa ou desativada
- perfis/claims, se existirem
- unidades às quais cada pessoa pode acessar

As senhas não devem ser copiadas na conversa. Na mudança para autenticação local, cada usuário receberá um convite para criar uma senha nova.

## Ordem recomendada de envio

1. `config/metas` e a lista de usuários.
2. Uma unidade piloto completa, preferencialmente `premium24`.
3. Conferência de contagens e telas.
4. As quatro unidades restantes.
5. Logs e analytics, se forem realmente necessários.

Antes da importação definitiva, rode:

```powershell
npm run import:firestore --workspace @movfit/backend -- caminho\arquivo.json --dry-run
```

Após a validação, remova `--dry-run`.
