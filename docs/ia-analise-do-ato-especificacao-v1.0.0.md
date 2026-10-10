# Processo Vivo — IA: botão "Analisar este ato" — Especificação v1.0.0

Documento: `ia-analise-do-ato-especificacao-v1.0.0` · 10/10/2026 · complementa `analise-sistema-planos-v1.1.0` (Trilha D) e
`arquitetura-mvp` (CLAUDE.md). Não substitui as specs `ia-*-v1.1.0` (Jev, classificação), que continuam adiadas: aquela rota só devolve
rótulos; esta precisa de um modelo que gere texto, atrás de **uma porta nova**. O Jev pode voltar depois como classificador barato.
Versão do repositório em que a entrega entra: **0.38.0** (a `main` está em 0.37.6). A sonda de avaliação (Etapa 1) não muda a versão.

## 1. Decisões do dono (10/10/2026)

1. **Entrada da v1:** só o texto que o sistema **já tem** do ato (andamento e comunicação do DJEN). Sem baixar PDF, sem peça. A IA só roda
   **quando o usuário clica num botão**. Nunca automática, nunca em lote, nunca em varredura.
2. **Acesso:** a função fica visível para os usuários; quem **não tem o plano IA** vê o aviso de que a análise exige **upgrade do plano**.
3. **Avaliação:** o **Autran** (advogado) avalia a qualidade em cerca de 20 casos anonimizados antes de abrirmos para terceiros.

## 2. O que é e o que não é

**É** uma leitura assistida do **último ato** de um processo: o que o texto diz, o que ele **parece pedir** e **ações possíveis**, sempre com
**citação literal** do texto, verificada pelo sistema. Serve para o advogado entender mais rápido o que chegou.

**Não é** cálculo de prazo, análise de mérito, sugestão de tese, jurisprudência, recomendação de recurso, nem resumo do processo todo.
O advogado continua responsável por ler o ato e contar o prazo.

## 3. Princípios (inegociáveis, no espírito do CLAUDE.md)

1. **A IA só acrescenta.** Não esconde, não filtra, não reordena e não altera "pede providência", "não lida" nem o calendário.
2. **Prazo é do advogado.** O resultado não traz prazo calculado nem "prazo fatal". Número de dias ou data só aparece se estiver **no texto
   do ato**, e a verificação confere isso (seção 6).
3. **Toda afirmação tem citação literal verificada.** Sem citação que exista no texto enviado, o item é descartado. Sem citação para o
   ponto principal, o resultado é "não foi possível analisar com segurança".
4. **Incerteza é resposta legítima.** "Indeterminado" é um valor válido e é mostrado como tal.
5. **Segredo de justiça nunca é enviado.** `segredoJustica === true` ou nível de sigilo acima de zero: o botão fica desligado com explicação.
6. **Dado mínimo e redigido.** Nome de parte e de advogado, CPF/CNPJ, número de processo, e-mail, telefone e OAB são **trocados por marcadores**
   antes de sair do servidor (seção 5).
7. **ZDR falha fechado.** Toda chamada exige retenção zero por requisição. Se a ZDR não puder ser cumprida, a chamada falha; nunca se repete
   sem ZDR.
8. **Falha da IA não derruba a tela.** Erro vira mensagem curta no próprio painel; o resto da aba não muda.
9. **Rótulo da IA nunca dispara ação.** Nenhum alarme, filtro ou cobrança depende do resultado.
10. **Texto do ato é dado, não instrução.** Pode conter "ignore as instruções"; ele entra em campo delimitado e o contrato de saída é
    fechado (esquema), então o pior caso é um resultado descartado pela verificação.

## 4. Entrada (o que vai para o modelo)

Do **ato selecionado** (o que a linha mostra como atualização principal; para processo que pede providência, o ato que a gera):

- título/rótulo, descrição e complemento do andamento, ou o texto da comunicação do DJEN, **o que o retrato já guarda**; data do ato;
- tipo da comunicação (intimação/citação/outro) quando existir; classe processual e tribunal (sem número do processo);
- opcional (a sonda decide se ajuda): os **títulos** dos 5 andamentos anteriores, sem texto, só para dar a fase do processo.

O agente deve **descobrir e relatar** qual texto existe de fato por ato. Se o texto guardado for só um título curto, o botão mostra
"Este ato não traz texto suficiente para análise" e **não chama o modelo**. Texto muito longo é truncado de forma determinística (início
e fim), e isso é avisado ao usuário.

## 5. Redação antes de enviar

Função pura (domínio/aplicação), testada com fixtures sintéticas, que troca por marcadores: números CNJ (`[PROCESSO]`), CPF e CNPJ
(`[DOCUMENTO]`), e-mails e telefones (`[CONTATO]`), inscrições OAB (`[OAB]`), e **nomes das partes e dos advogados do retrato** (`[PARTE A]`,
`[PARTE B]`, `[ADVOGADO A]`...). O mapa marcador→original fica **só em memória durante a requisição**. O texto verificado é o texto
**redigido** (o que de fato foi enviado). Para exibir, o servidor devolve as citações com os marcadores trocados de volta pelos valores
originais (o dado já é do usuário e está no mesmo banco, isolado por workspace). Nada identificável sai do servidor.

## 6. Saída e verificação determinística

Esquema fechado (Zod), em português, temperatura 0, sem ferramentas:

- `parece_pedir`: `manifestar` | `cumprir_determinacao` | `comparecer_audiencia_ou_pericia` | `apenas_ciencia` |
  `sem_providencia_aparente` | `indeterminado`
- `resumo`: até 280 caracteres, o que o ato diz
- `trecho_chave`: citação literal que sustenta `parece_pedir`
- `acoes_possiveis`: até 3 itens `{ acao (até 160 caracteres, tom neutro), trecho }`
- `pontos_de_atencao`: até 2 **códigos** de um vocabulário fechado (`conferir_prazo_no_processo`, `ato_depende_de_outro_documento`,
  `texto_incompleto`, `possivel_outro_destinatario`), traduzidos pelo app

Verificação após o modelo (sem confiar nele):

1. Cada `trecho` e o `trecho_chave` precisam existir no texto enviado (comparação normalizada: minúsculas, sem acento, espaços colapsados).
   Item sem citação válida é **descartado**; `trecho_chave` inválido torna o resultado **"não verificado"** (sem resumo).
2. Qualquer **número de dias, horas, meses ou data** em `resumo` ou `acao` precisa aparecer no texto enviado; caso contrário o item é
   descartado.
3. Lista de **expressões proibidas** (por exemplo "prazo fatal", "recorra", "apele", "perderá o direito", "tese", "jurisprudência"): resultado
   com elas é descartado. Lista pequena, versionada e testada.
4. Resposta fora do esquema: uma repetição; depois erro de resposta inválida.

## 7. Acesso, plano e cota

- O botão aparece para todos. **Com o recurso do plano IA**: roda. **Sem**: não chama nada e mostra o aviso fixo "A análise por IA faz parte
  do plano IA. Faça upgrade do plano para usar." (o agente usa o mecanismo de planos existente e o padrão de aviso de plano já usado).
- Observação: o plano IA está hoje **fora de venda e travado por teste**. O agente deve ler esse teste, **não destravar a venda**, e relatar
  como o dono atribui o plano a uma conta pelo `/admin`. O aviso não deve prometer um link de compra que não existe.
- **Chave de ativação global** `..._IA_HABILITADA` (padrão `false`). Desligada: o botão não aparece.
- **Cota mensal por workspace** configurável (`..._IA_COTA_MENSAL`, sugestão inicial 100), contando só análises novas (cache não conta).
  Mensagem clara ao atingir ("Você usou N de M análises neste mês"). Limite de taxa e de concorrência no servidor.
- Proposta minha, não decidida: a cota existe para segurar custo e abuso; o valor final sai da sonda.

## 8. Arquitetura (Ports & Adapters)

```
domain/ports/AnalisadorDeAto.ts            a porta (nome, healthCheck que nunca lança)
domain/entities/AnaliseDoAto.ts            value object imutável, com procedência
domain/errors/                              reutiliza ProviderIndisponivelError, RespostaInvalidaError; novo EntradaNaoAnalisavelError
application/services/ServicoAnaliseDoAto.ts redige, chama, verifica, aplica cota e plano, grava
application/politicas/redigirParaIA.ts      função pura da seção 5
application/politicas/verificarAnalise.ts   função pura da seção 6
infrastructure/adapters/modelo/             adapter com transporte injetável (gateway com ZDR; direto como interface pronta)
infrastructure/persistencia/                tabelas analises_ia (cache por hash + versão do prompt + modelo) e uso_ia (cota)
main/http/rotas/analiseIA.ts                POST /v1/acompanhamentos/:numero/analise (sem try/catch; errorHandler traduz)
ui/analiseIA.ts                             botão, painel e avaliação (script.ts não cresce)
```

- **Transporte gateway:** AI Gateway da Vercel, com `providerOptions: { gateway: { zeroDataRetention: true } }` **sempre**. Exige conta Vercel
  Pro ou Enterprise (ZDR por requisição); a sonda confirma. `no_providers_available` (HTTP 400) vira `ProviderIndisponivelError` sem
  repetição. Chave `AI_GATEWAY_API_KEY`, nunca em log nem em resposta; valor de exemplo barrado por `pareceValorDeExemplo()`.
- **Modelo:** escolhido pela sonda (configuração `..._IA_MODELO`), nunca fixo no código.
- **Cache:** chave = hash do texto redigido + modelo + `versaoPrompt`. Análise repetida do mesmo ato devolve a salva (`deCache: true`) e **não
  gasta cota**. Há "Analisar de novo" (gasta cota) só se o usuário pedir.
- **Procedência** em toda análise: modelo, versão do prompt, data, `deCache`.
- **Avaliação embutida:** três botões discretos "Útil", "Errado", "Perigoso", guardados por análise (sem texto livre). Um script de
  leitura (CLI) soma por modelo e versão. É o que o Autran usa depois do beta.

## 9. Interface (regras, não desenho final)

- Botão pequeno "Analisar com IA" na coluna Ações da tabela de Atualizações; o resultado abre num painel logo abaixo da linha
  (`aria-expanded`, foco no painel, `Esc` fecha). Estados: carregando, resultado, "não verificado", erro, sem texto, segredo de justiça,
  sem plano, cota esgotada.
- Selo "IA" distinto do rótulo do tribunal. Tooltip: "Gerado por IA ({modelo}) em {data}. Confira no ato."
- **Aviso fixo e curto** no painel: "Apoio à leitura, não substitui a leitura do ato nem a contagem de prazo." (mesma redação das outras
  telas: "isto não é contagem de prazo".)
- As citações aparecem destacadas, com o texto do ato logo ao lado ou abaixo, para o advogado conferir sem sair da tela.
- Sem a palavra "prazo" em texto novo da tela, exceto o aviso de honestidade e o ponto de atenção "conferir o prazo no processo".
- Não mexe nas contagens do menu, no `/v1/painel` nem na ordenação.

## 10. Segurança, LGPD e o que é de fora do código

- Fase A (texto do ato, redigido, sem segredo de justiça) pode rodar em teste fechado antes dos itens abaixo. **Abrir para terceiros pagantes
  depende deles:**
  1. confirmar que a conta Vercel é Pro ou Enterprise e que a ZDR funciona com o modelo escolhido;
  2. ler o DPA e a política do provedor do modelo e da Vercel; perguntar por escrito região e subprocessadores;
  3. listar os dois como operadores nos **termos de uso e na política de privacidade** (pendência R3 do documento de planos);
  4. o advogado é o controlador dos dados do cliente dele: avaliar com ele ou com consultoria o que consta no contrato do plano IA.
  Não sou advogado; a orientação da OAB e a LGPD ficam com quem for.
- Por isso a chave `..._IA_HABILITADA` nasce `false`. O dono liga quando decidir.

## 11. Etapa 1 — sonda de avaliação (antes de qualquer produto)

`scripts/sonda-ia-ato.mjs`, no padrão das sondas anteriores. **Não consulta tribunal.**

- **Casos:** (a) ~20 atos **anonimizados pelo Autran**, de processos dele, cobrindo: intimação para manifestar, determinação a cumprir,
  audiência designada, apenas ciência, despacho sem providência, texto com instrução injetada, texto curto, texto longo, ato com nomes e CPF
  a redigir. Ficam **fora do repositório** (arquivo em volume do servidor ou `--stdin`), nunca em log nem em fixture. (b) um conjunto
  **sintético** pequeno no repositório, para os testes.
- **Modelos:** 3 ou 4 do catálogo do gateway (um pequeno, um médio, um maior), todos **com ZDR**. Se algum não tiver provedor com ZDR,
  o agente registra e segue sem ele; se nenhum tiver, **para**.
- **Variantes:** com e sem os 5 títulos anteriores.
- **Métricas:** taxa de itens com citação verificada, taxa de descarte, taxa de "indeterminado", tempo p50/p95, tokens e custo por análise,
  e o **julgamento do Autran** por caso: útil / errado / perigoso (planilha gerada pela sonda, no volume, sem número de processo).
- **Critério para seguir** (proposto; o dono ajusta): citações verificadas **≥ 95%**, **zero "perigoso"**, "errado" **≤ 10%**; vence o modelo
  **mais barato** que cumprir. Se nenhum cumprir, voltamos ao desenho (mais restrição, ou outro modelo).
- Respostas cruas dos casos **sintéticos** viram fixtures não editáveis para os testes do adapter. Respostas de caso real nunca são salvas
  no repositório.

## 12. Testes (regras do repositório valem)

Vitest, sem rede, sem tempo real. `redigirParaIA` (cada padrão e cada marcador, texto sem nada a redigir, nome parcial); `verificarAnalise`
(citação existente, inexistente, com acento e espaços diferentes; número inventado; expressão proibida; instrução injetada que tenta
mudar o esquema); gating (sem plano não chama o adaptador; segredo de justiça, texto curto e cota esgotada não chamam o modelo; cache não
gasta cota); ZDR (toda chamada leva `zeroDataRetention: true`; `no_providers_available` não gera segunda chamada); isolamento por workspace
(A não vê análise de B); a tela (Chromium): botão, painel, estados, teclado, sem rolagem horizontal em 1920, 1366, 1280, 1024, 768 e 390 px,
temas claro e escuro, axe. `npm run check` verde.

## 13. Decisões que ainda são suas

1. Valor inicial da cota mensal (sugestão 100) e se o teste de 14 dias inclui a IA (recomendo que **não**).
2. Texto exato do aviso de upgrade, já que o plano IA está fora de venda.
3. Quando ligar `..._IA_HABILITADA` para terceiros (depende da seção 10).
4. Se, depois desta versão, o painel passa a existir também na Pasta e na página do processo.
5. Conta Vercel: Pro ou Enterprise?

## Histórico de versões

- **v1.0.0 (10/10/2026):** primeira versão, com as três decisões do dono (entrada só com texto do sistema e por botão; função liberada com
  aviso de upgrade para quem não tem o plano IA; avaliação pelo Autran).
