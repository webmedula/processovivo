---
name: migracao-aditiva
description: Como alterar o banco do Processo Vivo sem migração destrutiva — tabelas e colunas novas, defaults, compatibilidade com o código antigo e testes. Use ao criar tabela, coluna, índice ou registro de configuração.
---

# Migração aditiva — Processo Vivo (kit v1.1.0)

Antes de escrever, **descubra no repositório** como as migrações são feitas hoje (pasta, numeração, runner, SQLite) e **siga o padrão existente**; não invente outro.

## Regras

1. **Só aditivo:** `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN` com `DEFAULT` ou nulável, `CREATE INDEX IF NOT EXISTS`. **Nada** de `DROP`, `RENAME`, mudança de tipo ou `NOT NULL` sem default em tabela existente.
2. **Compatível com o código anterior:** a versão antiga do app, rodando contra o banco novo (rollback do deploy), continua funcionando.
3. **Idempotente:** rodar duas vezes não falha nem duplica.
4. **Sem dado pessoal desnecessário:** guarde identificadores curtos e contagens; nada de texto de ato/peça, e-mail em log ou nome de parte, salvo se o prompt mandar e o `CLAUDE.md` permitir.
5. **Falha segura:** se a leitura da tabela nova falhar, o recurso cai no comportamento padrão do código, sem derrubar o fluxo principal.
6. **Cada tabela de auditoria** (alterações, alertas) guarda autor (id da conta, não e-mail), instante, tipo e valores simples.

## Testes

- Banco vazio → migração cria tudo; banco "da versão anterior" → migração só acrescenta.
- Segunda execução não altera nada.
- Leitura com tabela ausente/corrompida cai no padrão.
- Isolamento por workspace nas consultas novas.

## No relatório da PR

Liste cada tabela/coluna criada, o default, e diga explicitamente: "migração aditiva, sem remoção nem renomeação".
