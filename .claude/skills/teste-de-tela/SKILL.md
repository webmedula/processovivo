---
name: teste-de-tela
description: Padrão de teste de interface do Processo Vivo em Chromium — 6 larguras, temas claro e escuro, teclado, foco, axe, sem rolagem horizontal. Use ao criar ou alterar qualquer tela, botão, painel ou módulo em ui/.
---

# Teste de tela — Processo Vivo (kit v1.1.0)

Toda tela nova ou alterada precisa de teste no navegador (Chromium, Playwright), sem rede externa e sem tempo real.

## Matriz obrigatória

- **Larguras:** 1920, 1366, 1280, 1024, 768 e 390 px. Em todas: **sem rolagem horizontal** (`document.documentElement.scrollWidth <= clientWidth`) e nenhum controle cortado.
- **Temas:** claro e escuro. Contraste conferido pelo axe nos dois.
- **Acessibilidade:** `axe` sem violações em cada estado relevante (inicial, carregando, resultado, erro, vazio, desabilitado). Todo controle tem nome acessível; mudanças de estado usam `aria-live` discreto.
- **Teclado:** todo fluxo concluível só com teclado (Tab, Shift+Tab, Enter, Espaço, Esc); foco visível; foco vai para o painel/diálogo aberto e **volta ao gatilho** ao fechar; `Esc` fecha o que abre.
- **Estados:** teste cada um que o prompt listar (por exemplo: sem plano, função desligada, segredo de justiça, cota esgotada, erro de rede).
- **Regressão:** confirme que o que já existia na mesma tela continua igual (menus, contagens, ordenação).

## Regras de código

- Módulo de tela próprio em `ui/`; **não aumentar `script.ts`**.
- Textos em português do Brasil, curtos, sem jargão; aviso honesto onde houver IA ("apoio à leitura, não substitui a leitura do ato").
- Nenhum texto de ato, peça, nome de parte ou número de processo reais em fixtures, capturas ou snapshots.

## Dica de velocidade

Rode primeiro só o arquivo de teste da tela que mudou; a suíte completa roda uma vez no fim (duas, na entrega — veja a skill `entrega-pr`).
