---
description: Modelo para iniciar uma tarefa do Processo Vivo seguindo as regras do projeto (investigar antes, implementar, testar, entregar)
argument-hint: <resumo da tarefa em uma linha>
---

Tarefa: $ARGUMENTS

Siga as regras do `CLAUDE.md` e use as skills do projeto quando couber (`entrega-pr` no fechamento, `teste-de-tela` para interface, `migracao-aditiva` para banco).

1. **Investigue primeiro** (sem alterar nada): leia `CLAUDE.md`, `package.json` e os arquivos relacionados; responda o que o prompt pedir para investigar. Se algo conflitar com o código ou com o `CLAUDE.md`, **pare e me diga**.
2. **Plano curto:** liste o que vai criar/alterar e o que **não** vai mudar. Espere minha confirmação só se houver conflito ou decisão minha pendente.
3. **Implemente** no escopo do prompt, sem dependência nova e sem migração destrutiva.
4. **Teste** (sem rede e sem tempo real), revisando com o subagente `revisor-privacidade`.
5. **Entregue** conforme a skill `entrega-pr`: PR aberta (sem merge), versão informada, relatório com passo a passo para não técnico.

Contexto e decisões da tarefa:
