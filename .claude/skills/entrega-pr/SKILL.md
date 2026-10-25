---
name: entrega-pr
description: Fechamento de uma tarefa do Processo Vivo ao abrir a PR — versão, CHANGELOG, DEPLOY, CLAUDE.md, merge da main, checagens e o relatório final com passo a passo para quem não é técnico. Use ao terminar de implementar qualquer prompt de agente.
---

# Entrega de PR — Processo Vivo (kit v1.1.0)

## 1. Antes de abrir a PR

1. **Versão:** leia `package.json` e `CLAUDE.md`; use a versão indicada no prompt (ou a seguinte à de produção). Atualize `package.json`, `package-lock.json` e o texto de versão visível, se houver. Diga qual usou.
2. **Documentação na mesma PR:** `CHANGELOG.md`, `CLAUDE.md` (regra nova, em poucas linhas) e `DEPLOY.md` (como usar/configurar; variáveis novas sem valor).
3. **Sincronizar:** `git fetch` e `git merge origin/main` (**sem rebase, sem force-push**).
4. **Checagens:** `npm run check` **com `npm run build`** e a suíte completa **duas vezes seguidas**, ambas verdes. Se um teste antigo foi reescrito, anote qual e por quê.
5. **Sem sobras:** nada de `console.log` de depuração e nada fora do escopo do prompt.

## 2. Abrir a PR

- **Abra a PR; não faça merge.** Título com a versão. Descrição curta: o que mudou, o que **não** mudou, como testar.
- Confirme na aba Checks que o **CI iniciou para o último commit** e informe o estado.

## 3. Relatório final (nesta ordem)

1. Respostas da investigação pedida no prompt, com divergências do código ou do `CLAUDE.md`.
2. O que ficou pronto, a **versão usada**, nomes finais (tabelas, rotas, variáveis) e o que mudou no ambiente.
3. Exemplo **fictício** da tela ou saída nova, quando houver tela.
4. **Passo a passo para quem não é técnico**: cada comando em bloco de código **e de novo em texto simples, uma linha por comando**.
5. **O que conferir em produção**, em poucos passos numerados.
6. Resultado dos testes, número da PR e estado do CI.

Se algo do prompt conflitar com o código, **pare e diga**.
