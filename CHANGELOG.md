# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento semântico: enquanto estiver em `0.x`, mudanças incompatíveis
entram como _minor_.

**Como descobrir qual versão você tem:** `node -p "require('./package.json').version"`
na raiz do projeto, ou o campo `versao` na resposta de `GET /health`.

---

## [0.62.0] — 2026-10-27

**`/admin` com administradores restritos: outras pessoas entram com usuário e senha próprios, e o dono escolhe, por aba inteira, o que cada uma pode usar.** O conteúdo e as funções de cada aba, as chaves de API (`LEXFLOW_API_KEYS`), o login dos clientes, planos, preços, pagamento, IA, política e termos **não mudaram**. Sem dependência nova; migração só aditiva (sem remoção nem renomeação).

- **Dois papéis.** _Dono_: o acesso de sempre (`PROCESSOVIVO_ADMIN_USUARIO`/`_SENHA`, **sem nenhuma mudança no Easypanel**); vê todas as abas e a nova "Administradores", e não perde nenhuma. _Administrador restrito_: só as abas liberadas; **começa sem nenhuma**. A liberação é por aba inteira (quem tem "IA" faz tudo o que a aba IA permite).
- **Credenciais só em variável de ambiente:** `PROCESSOVIVO_ADMIN_RESTRITOS=usuario:senha,usuario2:senha2`. O arranque recusa, sem imprimir senha nem o conteúdo da entrada: usuário repetido (inclusive igual ao do dono), senha com menos de 24 caracteres ou com espaço, usuário fora de `[a-z0-9_-]` (2 a 32), entrada sem `usuario:senha`, texto de exemplo e restritos sem o dono. A senha do dono segue com o mínimo de 16.
- **Login:** usuário e senha viram SHA-256 e são comparados com **todas** as entradas em tempo constante (usuário inexistente custa o mesmo que senha errada, com a mesma resposta). **Limite de tentativas erradas por IP** (10 por 15 min, reaproveita o `TokenBucketRateLimiter`): barrado, nem a senha certa passa (429). O primeiro pedido do navegador, sem cabeçalho, não conta.
- **Permissões no banco, regra no servidor.** Tabela `admin_permissoes` (usuário, aba, liberado por, instante). **A lista de abas é do código** (`domain/entities/AbasDoAdmin.ts`): aba nova nasce fechada para todo restrito; linha de aba desconhecida não abre nada. **Toda rota do `/admin` pertence a exatamente uma aba** (`ROTAS_DO_ADMIN`, em `rotas/admin.ts`) ou a "só o dono"; rota sem aba declarada derruba a montagem. Rota de aba não liberada, da aba "Administradores" ou que nem existe sob `/admin` responde **o mesmo 403** ao restrito. Lido a cada requisição: liberar ou tirar vale na seguinte, sem redeploy.
- **Falha fechada:** se as permissões não puderem ser lidas, o restrito não acessa nada (tela com aviso curto) e o dono segue com acesso total. Usuário que saiu da variável de ambiente não entra, mesmo com linhas no banco (a tela mostra "sem credencial").
- **Para o restrito, o `/admin` é como se só existissem as abas liberadas:** a página é montada no servidor só com o menu, o código e os estilos delas (o texto, as rotas e os nomes das outras abas nem chegam ao navegador); cai direto na primeira aba liberada; com uma aba só o menu vira o título dela; sem aba nenhuma, "Nenhuma área liberada para o seu acesso. Fale com o administrador."; a faixa do alerta de custo da IA só aparece com a aba IA. **Dois ajustes de rota para as abas se bastarem:** a aba Assinaturas lia `GET /admin/api/planos` (da aba Planos, com contagens de assinantes) e passou a ler `GET /admin/api/assinaturas/planos`, só com código, nome, preço e se está à venda; a cobrança (faixa TESTE, reconciliação, origem) pertence à aba Assinaturas, e a aba Planos só a mostra a quem também tem Assinaturas.
- **Tela "Administradores"** (`ui/administradores.ts`, só o dono): lista os restritos declarados, uma caixa por aba, último acesso e uma linha fixa "Todas as abas" para o dono. Salvar pede confirmação (teclado, foco, Esc) e vale na próxima requisição; o histórico de permissões (quem liberou ou tirou qual aba de quem) fica em `admin_permissoes_historico`, somente de acréscimo.
- **Quem fez o quê.** `ia_alteracoes`, `ia_instrucoes` e `ia_testes_modelo` passam a gravar o usuário que agiu (`u:<usuario>` para o restrito; o dono segue com o mesmo hash curto de antes, então **registro antigo aparece como do dono**). As listas de mudanças e de versões da aba IA ganharam o "Por" (a de mudanças virou tabela com a coluna "Por"); o rodapé do menu mostra "Entrou como …". Planos, assinaturas e chaves nunca tiveram tabela de auditoria e **continuam sem**. O e-mail do alerta de custo e o experimento das instruções seguem usando a conta do dono.
- **Logs** (o log do Fastify estava desligado, então nada disso era registrado): acerto — usuário e instante (na abertura da página); erro — só instante e IP, sem usuário digitado nem senha; negação por aba — usuário, aba e instante.
- **Dados (aditivos):** tabelas `admin_permissoes`, `admin_permissoes_historico`, `admin_acessos` (último acesso). Nenhuma tabela ou coluna existente foi tocada.
- **Variável nova:** `PROCESSOVIVO_ADMIN_RESTRITOS` (vazia por padrão = só o dono).
- **Testes reescritos:** o teste do tema chama `paginaAdmin` com o novo contexto; o teste de ESLint dos scripts do `/admin` passou a incluir a tela nova e o script montado para cada aba isolada.

---

## [0.61.0] — 2026-10-26

**Painel de IA, Fase C: o dono edita pela tela do `/admin` as instruções de interpretação de cada função de IA, experimenta num caso real comparando a resposta atual com a nova lado a lado, publica sem deploy e reverte em um clique.** Funções: análise de ato, resumo do processo e análise de peça. **Texto vazio = o prompt de antes, byte a byte (`+e0`): o deploy não muda nenhuma resposta da IA.** Modelo em produção, lista da Fase B, parte fixa dos prompts, esquema de saída, verificação de citação, ZDR, redação, segredo de justiça, planos, preços, `exigir()`, política, termos, calendário e e-mails **não mudaram**. Sem dependência nova; migração só aditiva (sem remoção nem renomeação).

- **Fronteira fixo × editável.** A parte fixa (REGRAS e CAMPOS: formato JSON, limites, citação literal, nunca calcular prazo nem dar parecer, dado × instrução, marcadores) continua no código. O bloco editável diz só COMO interpretar e O QUE destacar (foco, prioridade, tom, tamanho, exemplos). Onde conflitar com o _estilo_ padrão, vale o bloco; com as REGRAS ou os CAMPOS, valem as REGRAS e os CAMPOS. **Montagem pelo código, sempre na mesma ordem: parte fixa → bloco editável → lembrete final.** A segurança não depende de o modelo obedecer: citação, redação, segredo de justiça e ZDR rodam no código com ou sem bloco.
- **Versão efetiva gravada em cada resultado:** `ato-1.2.0+e1`, `resumo-1.2.0+e3`… Sem instrução publicada a versão é a de sempre, **sem sufixo** (a tela a mostra como `+e0`); assim o deploy não muda nada do que já se grava nem o reaproveitamento da análise de peça. O reaproveitamento (e portanto o "cache") **inclui a versão das instruções**: publicar não serve resposta velha, e reverter volta a servir a que já existia. A versão e o texto vêm de **uma leitura só**.
- **Falha segura:** leitura que falha (banco, linha torta, tabela ausente) = prompt padrão `+e0`, sem erro para o usuário, com um aviso por minuto sem texto. Publicar e reverter limpam o cache de 5 s: a próxima análise de qualquer conta já usa a versão nova.
- **Limites (as únicas recusas automáticas):** texto até **4.000 caracteres** (`texto_grande`, 422) e texto vazio ao publicar (`texto_vazio`, 422); observação até 200. Publicar exige uma confirmação; o dono é o único editor. Sem teste obrigatório, sem janela de 24 h, sem verificador de instruções hostis.
- **Experimentar num caso real** (`ServicoExperimentoDeInstrucoes`): roda a instrução publicada e o rascunho (a da caixa, mesmo sem salvar) sobre **o mesmo ato, processo ou peça da conta do próprio operador** (a que tem o e-mail `PROCESSOVIVO_ADMIN_EMAIL`; sem conta, o experimento explica o que falta e nenhum processo de assinante é tocado). Cada serviço de IA roda o **mesmo caminho de produção** (redação, modelo com ZDR, verificação, segredo de justiça) por um método `experimentar`; o resultado volta só na resposta da rota — **nada é gravado** (nem o texto do caso, nem as respostas), não consome o teto dos assinantes e não conta ocorrência. Um por vez e no máximo 30 por hora. Mostra as duas respostas completas, citações, o que a verificação descartou, tempo, custo, tokens e modelo.
- **Conjunto de verificação opcional** (`ServicoVerificacaoDeInstrucoes`): reaproveita os comparadores, o executor e a tabela `ia_testes_modelo` da Fase B (duas rodadas do mesmo conjunto sintético no modelo em uso: publicada × rascunho; estimativa e confirmação, teto de US$ 1,00, um por vez, cancelar, `reiniciado`). A conta é a de `julgarTeste`, mas aqui só vira **avisos de piora, que não bloqueiam**. A Fase B não enxerga esses testes (nem para publicar modelo).
- **"Onde a IA erra":** polegares por edição das instruções (`+e0`, `+e1`…) e os mais recentes para baixo, com o motivo de lista fechada, o modelo e 8 caracteres da conta — nunca o conteúdo da análise.
- **Rotas** (só o operador do `/admin`; entram em `ROTAS_ADMIN`): `GET /admin/api/ia/instrucoes`, `PUT …/instrucoes/:funcao/rascunho`, `POST …/previa`, `GET …/versoes/:versao`, `GET …/diff?de=&para=`, `POST …/publicar`, `POST …/reverter`, `GET …/erros`, `POST …/experimentar`, `POST …/verificacao/estimativa`, `POST …/verificacao`, `GET …/ia/experimento/processos[/:numero/atos|pecas]`, `GET …/ia/verificacoes/:id`, `POST …/ia/verificacoes/:id/cancelar`. Novo erro de domínio `InstrucaoDeIaRecusadaError` (frases nossas, nunca repetem o texto recebido).
- **Tela** (`ui/iaAdminInstrucoes.ts`, seção na tela "IA", abas por função): editor com contador e observação, "Salvar rascunho", "Visualizar prompt montado" (fixa, bloco, lembrete, formato e exemplo fictício), experimento lado a lado, publicar e reverter com confirmação, conjunto de verificação, histórico com comparação (diff) e "Usar como rascunho", e "Onde a IA erra". **Aviso ao sair com rascunho não salvo** (trocar de aba do `/admin` e `beforeunload`). Teclado, foco, `aria-live`, temas claro e escuro (axe), seis larguras sem rolagem horizontal.
- **Dados (aditivos):** tabela `ia_instrucoes` (função, versão, texto, autor, criado em, estado `rascunho|publicada|substituida`, observação, publicado em/por); colunas `instrucoes_versao`, `instrucoes_anterior` em `ia_config`; `tipo`, `instrucao_versao` em `ia_testes_modelo`; novos tipos de registro `instrucoes_publicadas` e `instrucoes_revertidas` em `ia_alteracoes` (edição antes → depois; o texto fica só em `ia_instrucoes`).
- **Variáveis de ambiente:** nenhuma nova. O experimento usa `PROCESSOVIVO_ADMIN_EMAIL` (já existente) para achar a conta do dono; a verificação precisa da IA ligada, como o teste de modelo.
- **Testes reescritos:** o teste que fixava as colunas de `ia_testes_modelo` ganhou `tipo` e `instrucao_versao` (a Fase C reaproveita a tabela); o ESLint de scripts do `/admin` passou a incluir o novo módulo. Nenhum outro teste assumia o prompt sem a parte editável: com texto vazio o prompt é idêntico (há teste de igualdade por função).

---

## [0.60.0] — 2026-10-25

**Painel de IA, Fase B: escolher o modelo de cada função de IA pela tela do `/admin`, com teste obrigatório antes de publicar e reversão em um clique.** As três funções (análise de ato, resumo do processo e análise de peça) têm, cada uma, o seu modelo; trocar uma não mexe nas outras. **O modelo em produção não mudou**, e nenhum prompt, verificação de citação, ZDR, redação, regra de segredo de justiça, plano, preço, política, termo, `exigir()`, calendário ou e-mail mudou. Sem dependência nova; migração só aditiva.

- **Lista permitida no código** (`src/infrastructure/ia/modelos-permitidos.ts`, validada por Zod no arranque): `id` real, provedor, apelido, ZDR com data e fonte, preço de entrada e saída por milhão de tokens, janela de contexto, funções permitidas e `status`. Só item _confirmado_ e _ativo_ vira candidato; o modelo de produção entra como _pendente_ (vale como modelo atual, nunca como troca) porque o preço de lista e a confirmação formal de ZDR dele ainda não estão registrados — nenhum número foi inventado. Incluir um modelo é mudança de código e exige rever a Política de Privacidade antes; a tela diz isso.
- **Modelo por função** (`ServicoModelosDeIa`): painel (se válido e na lista) → ambiente → padrão do código; cai no ambiente sem erro, conta a ocorrência `modelo_do_painel_invalido` e avisa na tela se o modelo do painel saiu da lista ou foi descontinuado. O modelo é escolhido **a cada chamada** (`ModeloDaFuncao`) e toda chamada passa pela mesma peça de ZDR de sempre; o resultado grava o modelo servido. A análise de peça passou a olhar o modelo de agora ao decidir se reaproveita um resultado.
- **Teste obrigatório** (`ServicoTesteDeModelo`, job em segundo plano com estado em `ia_testes_modelo` e consulta por polling): roda o conjunto sintético da função no candidato e no modelo atual, na mesma rodada, **reaproveitando os comparadores existentes** (o novo `ExecutorDoTesteDeModeloComSonda` só normaliza as métricas). Estimativa de chamadas e custo e confirmação antes de enviar; **teto de gasto de US$ 1,00 por rodada**; um teste por vez; cancelar; reinício do servidor marca o teste como falho; só números e ids são gravados (nunca texto de fixture ou resposta do modelo). O teste da análise de peça mede com o prompt, o esquema e a verificação de produção (o comparador manual ganhou a opção aditiva `entradaDeProducao`).
- **Veredito** (`julgarTeste`, constantes no código, mostradas na tela). _Bloqueios duros, sem aprovação manual:_ sem ZDR; violações acima das do modelo atual na mesma rodada; citação verificada abaixo de 95%; falhas de formato acima do atual em mais de 2,0 pontos percentuais; teste incompleto ou com erro do provedor. _Queda tolerável, com aprovação:_ pontos obrigatórios até −3,0 pontos, latência p95 até +30%, custo médio maior (com o impacto estimado por dia nos últimos 30 dias). Passar desses limites também bloqueia.
- **Publicar e reverter.** Publicar só com teste concluído do mesmo par função + candidato, de no máximo 24 h, cuja referência ainda é o modelo em uso; o veredito é recalculado das métricas. Aprovado: um clique + confirmação. Com ressalva: palavra `PUBLICAR` digitada + motivo de lista fechada + observação curta sem dado pessoal. Bloqueado: nunca. Reverter volta ao modelo anterior, sem novo teste. Tudo é registrado em `ia_alteracoes` (novos tipos `modelo_publicado`, `modelo_revertido`, `teste_modelo_iniciado`, com o id do teste e a aprovação), na mesma transação da mudança.
- **Rotas** (só o operador do `/admin`; entram em `ROTAS_ADMIN`): `GET /admin/api/ia/modelos`, `POST …/modelos/:funcao/estimativa`, `…/testes`, `…/publicar`, `…/reverter`, `GET …/modelos/testes/:id` e `POST …/modelos/testes/:id/cancelar`. Id fora da lista, descontinuado, pendente ou de outra função: 400 sem repetir o valor. Novo erro de domínio `ModeloDeIaRecusadoError`.
- **Tela** (`ui/iaAdminModelos.ts`, na tela "IA"): modelo em uso e de onde vem, seletor com preço, janela e ZDR, estimativa, progresso, tabela atual × novo com a diferença, bloqueios e ressalvas em português, publicar, reverter, "Regras desta decisão" e, nos cartões da Fase A, a quebra de uso e custo **por modelo** no período. Teclado, foco, `aria-live`, temas claro e escuro, seis larguras sem rolagem horizontal.
- **Dados (aditivos; sem remoção nem renomeação):** colunas `modelo`, `modelo_anterior`, `modelo_desde` em `ia_config`; `teste_id` e `aprovacao` em `ia_alteracoes`; tabela `ia_testes_modelo`. Banco da versão anterior só ganha colunas; a versão anterior do app continua lendo o banco novo.
- **Variáveis de ambiente:** nenhuma nova nem alterada. O teste de modelo precisa da IA ligada no ambiente (`PROCESSOVIVO_IA_HABILITADA` e `OPENROUTER_API_KEY`); sem elas a tela informa que o teste não está disponível, e publicar/reverter seguem funcionando.
- **Testes reescritos:** nenhum teste existente assumia o modelo vindo só do ambiente e precisou mudar de significado; só o _helper_ de tipos do `ServicoAnaliseDePeca` aceita agora `modelo` como função (ganhou um teste novo). O teste do `/admin` da Fase A ganhou o novo módulo na checagem do ESLint de scripts embutidos.

---

## [0.59.0] — 2026-10-24

**Sonda somente leitura do MNI do TRT18 (PJe): descobrir, com um único teste, se o tribunal aceita a credencial de advogado e devolve a consulta de um processo e dos documentos.** É teste de viabilidade, **sem mudança para o usuário final**:
nenhuma tela, rota, plano, preço, IA, política, termo, `Agendador`, cofre de credenciais, banco ou dependência mudou. A sonda não é chamada por rota nem pelo agendador.

- **`scripts/sonda-mni-pje.mjs`** (lógica testada em `src/main/sonda/sondaMniPje.ts` e `comandoSondaMniPje.ts`). Argumentos: `--url=` (obrigatório, https), `--processo=`, `--timeout=` (60 s), `--soap-action=cnj|vazio`, `--max-pdfs=` (40). A URL do TRT18
  **não está confirmada** na documentação pública (o padrão da comunidade é `https://pje.<tribunal>.jus.br/pje/intercomunicacao`), por isso é parâmetro obrigatório e não há padrão no código.
- **A credencial só existe em tempo de execução**: nunca por argumento (a sonda recusa `--senha`, `--cpf`, `--token` etc. sem repetir o valor); digitada sem eco quando o programa pergunta, ou lida de `SONDA_MNI_CPF`/`SONDA_MNI_SENHA` do ambiente daquele
  comando — e **apagadas do ambiente do processo logo depois de lidas** (o `pdftotext` que a sonda dispara herdaria o ambiente). Nada em disco, banco, log ou cofre de produção.
- **Só consulta, uma tentativa por operação, para na primeira recusa.** No máximo: um `GET` da descrição do serviço (WSDL) sem credencial, uma `consultarProcesso` sem documentos e uma com documentos. Recusa de credencial, exigência de certificado, segundo fator,
  cadastro prévio, HTTP 401/403/404 ou processo não encontrado encerram a sonda na hora; tempo esgotado e erro de rede também (sem repetição). Não testa outro número, não varre, não contorna bloqueio. A lista de operações permitidas
  (`OPERACOES_PERMITIDAS`) tem uma entrada, `consultarProcesso`, e há teste que falha se ela crescer.
- **Nunca gera ciência nem prazo.** `consultarAvisosPendentes` e `consultarTeorComunicacao` **não são chamadas**: a documentação oficial lida não prova qual delas registra ciência (uma fonte secundária diz que é a do teor), então a etapa de avisos sai como
  "não testado por risco de ciência". `consultarProcesso` é, pela especificação do MNI, uma consulta; o efeito colateral dela no PJe não está provado na documentação pública e fica registrado como risco residual.
- **Saída só de contagens e categorias**: conexão/TLS (dns, recusada, reiniciada, tempo esgotado, certificado do servidor, exige certificado de cliente, 404, 5xx), autenticação (aceita, recusada, exige certificado, exige segundo fator, exige cadastro/perfil, 401, 403),
  movimentos, partes (só quantidade), segredo de justiça, documentos por tipo (pdf/html/outro), com conteúdo × só referência, tamanho mínimo/mediano/máximo em KB e PDFs com camada de texto (pelo extrator que já existe, só contagem), e o veredito
  ("viável", "viável com ressalvas" com a lista, "inviável" com o motivo). Nenhum número de processo, nome, CPF, id de documento, URL ou trecho. Mensagem desconhecida do tribunal só sai **mascarada** (credencial e número literais, a redação da IA —
  CPF/CNPJ, e-mail, telefone, OAB, processo —, dígitos, endereços e pares de nomes próprios), cortada em 100 caracteres.
- **Adaptador MNI (aditivo; o TJGO não muda).** O `MniAdapter` já aceitava endpoint e tribunais por opção, e o envelope do MNI 2.2.2 é o mesmo do PJe — então não houve extração de "perfil de tribunal". Três acréscimos, todos fora do caminho do TJGO:
  (1) `consultarProcessoBruto`, que monta SÓ `consultarProcesso` e devolve a resposta aberta (a sonda conta o que veio; não há como pedir outra operação); (2) a opção `soapAction: 'cnj' | 'vazio'` (padrão `cnj`, o de sempre);
  (3) `contarPartes` e `idsDeTodosOsDocumentos` no mapper (contagens, nunca nomes). Os testes do MNI/TJGO seguem intactos; há teste de que o `SOAPAction` padrão é o do CNJ.
- **Testes** (servidor MNI do PJe FALSO e sintético, sem rede): caminho feliz com PDFs com e sem texto, HTML, documento só com ficha e anexo vinculado; recusa de credencial, certificado, segundo fator, perfil, 401, 403, 404, tempo esgotado, resposta malformada e
  sem habilitação — sempre uma chamada só; erros de conexão/TLS antes de qualquer credencial; o servidor sem `consultarProcesso`; nenhum envelope que não seja `consultarProcesso`; a credencial fora do argumento e fora do ambiente; e sentinelas (número, CPF, senha,
  nomes, texto do PDF, id de documento, URL) que **não podem aparecer** na saída em nenhum cenário, inclusive quando o tribunal ecoa dados pessoais na mensagem.

---

## [0.58.0] — 2026-10-23

**Painel de IA no /admin, Fase A: observar e controlar as três funções de IA (análise de ato, resumo do processo e análise de peça).** Nada mudou em modelo, prompts, verificação, ZDR, redação, planos, preços, políticas, `exigir()` dos outros
recursos nem calendário. Sem dependência nova, sem migração destrutiva, sem botão novo fora do `/admin`. Especificação: `docs/ia-painel-admin-especificacao-v1.0.0.md`.

- **A regra que não se discute: o ambiente é a trava mestra.** Uma função só funciona se a variável de ambiente permite **e** o painel está ligado. O painel pode desligar e reduzir teto; **nunca liga o que o ambiente desligou** (o pedido é recusado,
  409, e nada é gravado) nem sobe o teto acima da variável: o teto efetivo é o **menor** dos dois. **Falha segura:** se o banco do painel falhar (ou uma linha vier torta), a IA segue com o padrão do código — o painel não restringe nada — e
  o aviso vai ao log uma vez por minuto, sem a mensagem do erro. O painel nunca derruba a IA.
- **Quem acessa.** Só o operador do `/admin` (o mesmo Basic Auth, fora da tabela de usuários). Sessão de assinante e chave de API recebem 401 em toda rota nova. O autor das mudanças é um **identificador curto** (8 hex de um SHA-256 do usuário do
  `/admin`), nunca o nome nem o e-mail. Divergência registrada: o `/admin` tem uma credencial só, não pessoas; por isso o autor é derivado e não "a conta".
- **Tabelas novas e aditivas** (nenhuma coluna alterada, nenhuma retrocarga): `ia_config` (uma linha por função e a `global`; linha ausente = padrão), `ia_alteracoes` (**só acréscimo**: instante, autor, função, tipo, valor anterior e novo, valores simples),
  `ia_alertas_custo` (dia, valor, limite, tentativas, enviado em) e `ia_ocorrencias_dia` (só contagem por dia, função e motivo de lista fechada). Nenhuma guarda texto de ato ou de peça, nome, número de processo, e-mail ou chave.
- **O interruptor** (`ServicoControleDaIa`, cache de 5 s): cada função consulta o painel **antes de tudo** — antes do plano, do retrato, da vaga no limite e do modelo. Desligada: **zero chamadas ao provedor, zero consumo do teto** (há teste com teto de
  1 e três tentativas seguidas), erro **503** com a frase fixa "Este recurso está indisponível no momento." (`motivo: desligada`) e o botão some **para todas as contas**: `GET /v1/analises/disponibilidade` ganhou `funcoes` (**só quando o painel
  desligou uma das duas**, então o contrato de antes não mudou) e `GET /v1/analises-de-peca/disponibilidade` passa a dizer `liberado: false`. Avaliar (polegar) uma análise que já existe segue funcionando com a função desligada. Ligar de novo restaura.
  Desligar exige **confirmação na tela e no pedido** (`confirmado: true`; sem ela, 409).
- **Tetos do painel** (só reduzem): por função e por conta/dia (a peça pesa 5, como sempre) e **global** por dia (todas as contas e funções). Entram no `TetoDiario` que já existia (o painel que lança é ignorado: vale o ambiente).
- **A tela "IA"** (`ui/iaAdmin.ts`, módulo próprio; o `scriptAdmin.ts` ganhou só o gancho): período Hoje/7 dias/30 dias; um cartão por função com análises, polegar para cima/baixo e motivos, "não foi possível" e não verificadas (e a taxa), falhas de
  verificação por motivo, repetições automáticas, custo total/médio/p50/p95/máximo e tempo p50/p95; contas que mais usaram (**só os 8 primeiros caracteres** do id, nunca e-mail ou nome); liga/desliga com confirmação na tela; tetos e limite do alerta;
  últimas 50 mudanças. Estado efetivo (ambiente × painel) explícito, com a razão quando o ambiente bloqueia. Teclado, foco que só vai ao controle que a pessoa usou, região `aria-live` discreta, temas claro e escuro, sem rolagem horizontal de 390 a 1920 px.
- **Alerta de custo diário** (`ServicoAlertaDeCustoDaIa`, tick de 15 min, dia de São Paulo, relógio injetado): padrão **US$ 3,00**, ajustável. Passou do limite: **banner em qualquer aba do `/admin`** e **um** e-mail por dia (só data, valor do dia, limite e o
  link `/admin#ia`). Falha de envio não derruba o agendador: soma tentativa (**máximo 3 por dia**), vai ao log sem dado pessoal e só tenta de novo no próximo ciclo. Sem SMTP de verdade ("log não é entrega") ou sem e-mail do operador, não envia nem gasta tentativa;
  o banner continua. Variável nova **opcional** `PROCESSOVIVO_ADMIN_EMAIL` (cai em `PROCESSOVIVO_PAGAMENTO_AVISO_EMAIL`); o endereço nunca vai a log.
- **Contagens de falha** (`ia_ocorrencias_dia`): citação inválida, número ou data que o texto não tem, expressão proibida, ação copiada do trecho, nenhum item verificado, ato mais recente fora da situação, "sem pendências" indevido, ato antigo como atual,
  forma, página inexistente, chamada que falhou, formato fora do esquema, tempo esgotado e **repetição automática** (o transporte e a repetição por esquema da peça chamam um gancho opcional `aoRepetir`, que só conta). Contar nunca derruba a análise.
- **O relatório e o painel fazem a mesma conta.** `percentil`/`média` viraram `application/politicas/estatistica.ts` (o comparador reexporta) e `scripts/ia-avaliacoes.mjs` (`agruparAvaliacoes`) passou a usar a `metricasDoConjunto` do painel: uma implementação só.
  A saída do relatório não mudou. Há teste que compara os dois com as mesmas linhas e outro que falha se a conta for reescrita num dos lados.
- **Rotas novas** (todas sob o Basic Auth): `GET /admin/api/ia?periodo=hoje|7d|30d`, `GET`/`PUT /admin/api/ia/alerta`, `PUT /admin/api/ia/funcoes/:funcao`, `PUT /admin/api/ia/funcoes/:funcao/teto`, `PUT /admin/api/ia/teto-global`.
  Erro novo `ConfiguracaoDeIaRecusadaError` (`funcao_desconhecida`/`valor_invalido` 400, `confirmacao_necessaria`/`ambiente_bloqueia` 409); `desligada` (503) entrou em `EntradaNaoAnalisavelError` e `AnaliseDePecaRecusadaError`.
- **Fases B, C e D: futuro, não implementado** (troca de modelo pelo painel, edição de prompt com teste e reversão, canário). Ver a especificação.
- **Testes novos** (sem rede e sem tempo real): precedência e falha segura, teto efetivo, as três funções desligadas (zero chamadas, zero consumo, frase e reativação), segurança do acesso, registro de mudanças, métricas e percentis, o relatório igual ao painel,
  o alerta (uma vez por dia, virada do dia às 03:00 UTC, falha e 3 tentativas, e-mail falso), ausência de texto/nome/número/e-mail/chave nas respostas e, no Chromium, a tela (teclado, confirmação, foco, axe nos dois temas, seis larguras, aviso em qualquer aba, `/admin#ia` e o resto do `/admin`).
- **Reescritos (só os que assumiam a leitura direta do ambiente):** nenhum teste de comportamento precisou mudar. Duas adaptações de **infraestrutura de teste**: (1) `tests/helpers/aplicacao.ts` monta o controle da IA e o `TetoDiario` compartilhado sempre
  (antes só com `porDia`; sem `porDia` o teto é "infinito", como antes); (2) `tests/http/admin-script.spec.ts` passou a rodar o ESLint nos dois scripts do `/admin`.
- **Anotado, não alterado:** o rodapé da lateral do `/admin` (`.sub` "administração" e `.versao`) falha no contraste do axe no tema escuro — é anterior a esta versão; o teste do painel mede só a área do painel e do aviso.

---

## [0.57.0] — 2026-10-23

**Navegação por hash: o Voltar/Avançar do navegador e o F5 passam a funcionar dentro do sistema.** Só navegação do console: regras, rotas da API, dados, planos, IA, calendário e custos não mudaram. Sem rota nova no servidor,
sem dependência nova e sem nada gravado no banco ou no servidor.

- **O defeito.** As telas trocavam por variável (`estado.aba`/`estado.detalhe`) e não criavam entrada no histórico: o Voltar saía do app para o site anterior e o F5 voltava à tela inicial, em qualquer tela.
- **Como as telas se trocavam (investigação).** `ir(aba)` (menu lateral e botões que mudam de aba) e `abrir(numero)` (detalhe do processo) em `ui/script.ts`; a Pasta digital e o visualizador de peça, em `ui/scriptPasta.ts` (`abrirPasta`,
  `abrirPeca`, `fechar`); Atualizações, Calendário, Custos e Minha conta são abas do mesmo `render()`; os painéis (resumo, análise de peça, Custos do processo) são camadas sobre a tela, sem estado de navegação. O controle novo mora em módulo
  próprio, `ui/navegacao.ts` (`window.__pvNav`); `script.ts` **não cresceu** (2.341 linhas, as mesmas de antes): os ganchos entraram em linhas que já existiam.
- **Endereços** (`#/…`): `#/atualizacoes`, `#/processos`, `#/calendario`, `#/custos`, `#/buscar`, `#/vigilancia`, `#/acessos`, `#/conta`, `#/processo/<id>`, `#/processo/<id>/pasta` e `#/processo/<id>/pasta/peca/<peça>`. Usa só `history.pushState`,
  `replaceState` e `popstate`.
- **Nenhum dado pessoal na URL.** O número CNJ nunca vai ao endereço (nem ao histórico, favorito, `Referer` ou título da aba): o processo é um **identificador opaco**, calculado neste navegador com um sal aleatório que só ele conhece (o mesmo
  processo dá o mesmo identificador neste navegador, então F5, favorito e outra aba funcionam; quem vê o endereço não recupera o número). O `<peça>` é o id interno que a API já usa. O `document.title` também não leva o número. O link "número do processo"
  de Atualizações deixou de ser `/?processo=<número>` e passou a ser o endereço opaco (o link `/?processo=` que vem do calendário continua aceito, é lido e **apagado** da barra, como antes).
- **Um passo por tela**: lista, detalhe, Pasta digital e peça aberta. Painéis grandes (resumo, análise de peça, Custos do processo) **não** criam entrada: fechar painel não gasta um "Voltar". Trocar de peça dentro do visualizador **substitui** a
  entrada, então o "Voltar" da peça leva à lista.
- **"Fechar a pasta", "← lista de peças", Esc e "← voltar" do processo usam o mesmo mecanismo**: voltam um passo quando a origem é do app e vão à tela pai (Pasta → processo → lista) quando a pessoa chegou por link direto.
- **F5 e link direto**: abrir `#/processo/<id>` carrega a tela certa (logado) ou mostra a entrada e leva à tela pedida depois do login. Identificador inválido, de outra conta ou que já não existe: tela de aviso neutra ("Não encontramos esta página"),
  sem dado nenhum do processo. **Reabrir uma peça pelo endereço não consulta o tribunal**: abre a que já está disponível; a que precisaria ser pedida fica na lista.
- **Login e logout usam `replaceState`**: o login não vira entrada, e sair troca a entrada por `#/entrar` (apaga também o mapa de processos da aba). Voltar depois de sair mostra a entrada, nunca o app; sem laço de redirecionamento.
- **Foco e leitor de tela**: ao navegar, o foco vai para o título da tela (na tela do processo, o número da capa, que passa a ser anunciado como título) e o `document.title` muda ("Meus processos · Processo Vivo", "Processo · …", "Pasta digital · …").
- **Acessibilidade:** o botão "← voltar" da tela do processo usava `--tinta3` (contraste 4,39:1 no tema claro, abaixo dos 4,5:1); passou a `--tinta2`. Foi o axe do teste novo que apontou.
- **Testes** (Chromium): lista → processo → Pasta → peça e Voltar passo a passo até sair do app, Avançar refazendo, F5 em cada tela, link direto logado e deslogado, processo de outra conta (com o mesmo sal e carteira vazia), sair e Voltar, painel sem passo,
  foco e título, as abas, e 6 larguras (1920, 1366, 1280, 1024, 768, 390) em tema claro e escuro com axe. Teste de que nenhuma URL nem título tem o número do processo.
- **Reescritos (só os que assumiam a navegação antiga):** (1) os dois testes de Atualizações que esperavam `href` com `processo=<número>` agora esperam o endereço opaco e que o número não esteja nele.

---

## [0.56.2] — 2026-10-23

**PDF da prestação de contas: a coluna Data cabe sempre em UMA linha.** Só apresentação do PDF; a planilha (CSV), os totais, as rotas, os dados e as regras não mudaram. Sem dependência nova, sem migração.

- **O defeito:** a coluna Data tinha 50 pt (42 pt úteis, descontado o recuo de 4 pt de cada lado) e "30/12/2026" mede cerca de 42,5 pt em Helvetica de 8,5 pt: o último dígito ("6") caía na linha de baixo
  ("20/10/202" + "6"). Datas com dígitos mais largos ou em dezembro estouravam; as de setembro e outubro dos testes antigos coincidiam em caber.
- **A correção:** a coluna Data passou de **50 pt para 56 pt**, e a Descrição de 150 para **144 pt** (a Descrição já quebra em palavras; categoria, valor e situação ficam como estavam). As três tabelas
  (despesas, "Depósitos e garantias" e "Recebimentos do cliente") usam as mesmas colunas, então as três foram corrigidas juntas; a soma segue igual à largura útil da página (511,28 pt), sem estourar a margem.
- **Teste:** gera o PDF com a data mais larga (30/12/2026) nas três tabelas e falha se alguma data aparecer partida (verificado contra a largura antiga: falha; com a nova: passa). Nenhum teste anterior assumia a
  largura antiga (todos usavam datas que cabiam), então nenhum foi reescrito.

---

## [0.56.1] — 2026-10-23

**Análise de peça: despacho e decisão curtos deixam de receber pontos de atenção falsos e ganham o bloco "O que determina".** Prompt `peca-1.1.0`, regras de verificação `1.1.0`.
**Não mudaram:** modelo, provedor, ZDR, redação, segredo de justiça, planos, preços, teto diário, calendário, análise do ato, resumo e a avaliação por polegar. Sem dependência
nova; sem migração (resultado guardado antes continua legível; a mudança de prompt invalida o reaproveitamento sozinha).

- **A causa.** Os dois pontos falsos ("peça longa" e "texto incompleto ou ilegível") vinham do **MODELO**: o prompt `peca-1.0.0` pedia `pontos_de_atencao` com os quatro códigos, e
  a verificação só conferia que o código existia — nunca que era verdade. Num despacho de uma página o modelo os emitia por insegurança, e nenhuma regra do sistema os barrava.
  (Também não era "pedidos e alegações vazios": essa regra só vale para petição e contestação e o resultado saiu verificado.)
- **Fatos do sistema são calculados pelo código** (`pontosDeAtencaoDoSistema`, do que foi contado, nunca de texto): **peça extensa** (mais de 20 páginas ou 50 mil caracteres) e
  **pouco texto por página** (3 páginas ou mais com média abaixo de 200 caracteres: sugere páginas escaneadas). Só aparecem se verdadeiros; peça de uma página nunca é "extensa".
  O modelo só pode apontar o que depende do conteúdo (`peca_cita_documentos_nao_anexados`, `conferir_peca_inteira`); os códigos antigos que ele ainda emita, ou que um
  resultado guardado traga, são ignorados. A conversão do HTML do tribunal segue sendo aviso do sistema (`conversao`).
- **Novos tipos:** despacho, decisão, sentença e acórdão, com o bloco **"O que determina"**: até 5 itens `{ quem, texto, prazo, trecho, pagina }`, com os verbos "determina",
  "intima" e "manda". O **prazo é o literal escrito no ato** ("10 (dez) dias"): se não está LITERALMENTE na página, só o prazo sai e a determinação fica sem ele; nada é calculado
  nem convertido em data. Continuam: trecho na página indicada, número/valor só se estiver no texto, expressões proibidas (mérito, conselho, prazo calculado). Para esses
  tipos, pedidos e alegações vazios **não** tornam o resultado "não verificado".
- **Tela:** o bloco "O que determina" mostra quem, o quê e "Prazo escrito no ato", e todo item com citação traz "Ver trecho · pág. N" visível (o trecho abre ao clique).
- **Teste:** fixture sintética de um despacho de 1 página (~960 caracteres, texto fictício) e dublê de provedor que EMITE os dois códigos antigos: o teste falha se aparecer
  "peça longa" em peça de uma página ou se faltar um dos dois prazos.
- Os testes que olhavam `peca-1.0.0`/regras `1.0.0` foram atualizados para a nova versão.

---

## [0.56.0] — 2026-10-22

**Acabamento das IAs: resumo conciso, avaliação por polegar e o botão de peça também na Pasta digital.** Prompt `resumo-1.2.0` e regras de verificação `1.2.0`.
**Não mudaram:** modelo, provedor, ZDR, redação, segredo de justiça, planos, preços, teto diário, as regras de não calcular prazo, calendário, análise do ato (prompt
`ato-1.2.0`) e análise de peça (`peca-1.0.0`). Sem dependência nova; sem migração (o motivo novo da avaliação é texto na coluna que já existia).

- **Resumo direto e conciso.** De cima para baixo: faixa do sistema (só quando o ato mais recente não foi lido, ou a Pasta digital já lista um ato mais novo),
  **Situação** (1 a 3 itens, ~320 caracteres; abre pelo ato mais recente lido, com a data; ato antigo no máximo um, como "Antes, em dd/mm/aaaa…"), **O que pede
  providência** (até 5 linhas de até 160 caracteres; data e tipo do ato vêm do sistema; o prazo só se estiver escrito no ato, sem cálculo; citação recolhida em
  "Ver trecho"), **Detalhes** recolhido (o que foi lido, as providências do sistema que a IA não leu, a hora), o aviso fixo em uma linha e os polegares. Saíram "O que
  entrou e o que ficou de fora" e "Itens descartados na verificação: N" (havendo descarte, uma linha neutra nos Detalhes).
- **Verificação 1.2.0.** O ato mais recente LIDO tem de estar na situação (senão o resultado é "não verificado", motivo `sem_ato_mais_recente`; se estiver fora do começo,
  sobe para o começo); com ele lido, ato antigo entra no máximo uma vez e nunca como atual; situação acima de 360 caracteres, mais de 3 itens e pendência acima de 200
  são descartadas (o texto do modelo nunca é cortado). Continuam: citação literal, número/data só se estiver no ato, nenhuma expressão proibida, "sem pendências" barrado
  havendo providência sem leitura. Sem `regras` valem as 1.1.0 (o comparador compara as duas).
- **Avaliação por polegar** (`ui/polegares.ts`), no fim do resultado do resumo, da análise do ato e da análise de peça. Para cima grava "util"; para baixo grava "errado" e
  abre, sem sair da tela, a lista fechada e opcional de motivos: erro de fato, citação inventada, concluiu prazo, deixou de fora algo importante, **pode causar prejuízo se
  seguido** e outro. "Pode causar prejuízo" é o que antes era "perigoso": o servidor grava `perigoso` + `pode_causar_prejuizo`, então a tabela, o relatório e o critério "zero
  perigoso" falam a mesma língua. Saíram os botões Útil / Errado / Perigoso, o link "Reportar problema" e o modo de avaliação da peça (a API ainda informa `modo`).
  `ia-avaliacoes.mjs` conta o polegar para baixo e o motivo novo. **Não existia `PROCESSOVIVO_IA_AVALIACAO_COMPLETA`: nada a remover.**
- **"Analisar peça com IA" também no visualizador da Pasta digital**, com os mesmos estados da linha do tempo. O botão não some mais sem aviso: aparece **desligado, com a
  razão** para processo não acompanhado, outro tribunal, peça sob sigilo ou peça ainda não baixada/na fila/não obtida. A peça **convertida do HTML do tribunal** já era
  elegível (o arquivo guardado é um PDF que desenha o texto); o resultado só avisa que imagens e tabelas podem não ter entrado (`conversao: "html"` na resposta).
- **Pluralização** numa função só (`domain/entities/pluralizacao.ts`, testada para 0, 1 e vários): acabou "1 ato como pedem providência".
- **Comparador** `--tarefa=resumo`: `resumo-1.1.0` × `resumo-1.2.0` por padrão (a 1.0.0 segue aceita em `--versoes`); novas colunas com o tamanho médio da situação e das
  pendências. Estima antes de `--executar`; ZDR e teto como sempre.
- **Testes reescritos (e por quê):** os de navegador do resumo e da análise do ato que assumiam o layout antigo, a linha "Esta análise/resumo foi útil?", os três botões, o
  rodapé "Itens descartados" e a ordem do Tab; os da peça que assumiam o modo de avaliação e o "Reportar problema"; e os de versão (`resumo-1.1.0` → `1.2.0`) e do relatório
  de avaliações (um motivo a mais na lista). O de "providências não citadas" ganhou uma segunda intimação, porque o ato mais recente lido agora sempre é citado.

---

## [0.55.0] — 2026-10-22

**Análise de peça por IA, Fase 1: o botão "Analisar peça com IA".** Prompt `peca-1.0.0`, regras de verificação `1.0.0`, especificação v1.2.0
(`docs/ia-analise-de-pecas-especificacao-v1.2.0.md`). **Não mudaram:** modelo, provedor, ZDR, redação da análise de ato, análise de ato, resumo do processo,
planos, preços, calendário, textos da Política e dos Termos. Sem dependência nova; migração só aditiva (tabela nova).

- **Quem vê:** duas chaves — `PROCESSOVIVO_IA_PECAS_HABILITADA` (padrão `false`; `true` = todas as contas com o plano IA) e `PROCESSOVIVO_IA_PECAS_WORKSPACES`
  (lista de contas; vale com a chave geral desligada). A conta também precisa do recurso `analiseIa`, sem a exceção do "workspace sem assinatura". Sem nenhuma das
  duas o botão não aparece e a rota responde "indisponível". Conta da lista vê Útil / Errado / Perigoso com motivo (modo avaliação); no modo geral, só o link
  "Reportar problema".
- **Como funciona:** um clique. Se a peça não está na guarda de 24 h, a tela a baixa pelo pedido que a Pasta digital já tem e espera (só banco); o servidor lê o PDF
  guardado, extrai o texto por página (Fase 0), recusa o que não cabe, redige, chama o modelo com ZDR (falha fechada), verifica item a item e devolve o resultado.
  Só TJGO; só peça com texto pesquisável; recusa acima de 40 páginas ou 80 mil caracteres; peça sigilosa e processo em segredo de justiça: botão desligado, zero chamadas.
- **Resultado conciso:** em uma frase, o que pede (≤ 5), o que alega (≤ 4), preliminares (≤ 3), documentos (≤ 8) e valores (≤ 5) citados, pontos de atenção
  (códigos fechados), cada item com "Ver trecho · pág. N" recolhido, e o aviso "Leitura automática, pode omitir pontos. Confira a peça inteira.".
- **Verificação determinística:** o trecho tem de estar na página indicada; valor, número e data têm de estar no texto enviado; expressões de mérito/chance/conselho/prazo
  descartam o resultado; petição ou contestação sem pedido nem alegação verificados = "não verificado"; fora do esquema, uma repetição e depois erro.
- **Redação ampliada** para peças: endereço (com rótulo ou logradouro), RG/CNH mascarados, nascimento, conta/agência com rótulo, cartão, chave Pix e nomes de partes
  do retrato. Nome de terceiro fora do retrato e endereço sem rótulo podem passar (risco residual dito no CLAUDE.md).
- **Guarda:** tabela `analises_pecas_ia` (resultado com marcadores e citações curtas, 30 dias configuráveis, limpa pelo `Agendador`); nunca o texto da peça, o nome de
  parte ou o número do processo (chave opaca). Reaproveita o resultado da mesma peça (mesmos bytes), prompt e modelo, sem chamar o modelo e sem peso.
- **Teto:** cada análise pesa 5 no teto técnico diário e 1 no freio por hora (`PROCESSOVIVO_IA_PECAS_MAX_POR_HORA`).
- **Relatórios:** `scripts/ia-avaliacoes.mjs` ganhou a seção de peças; novo `scripts/ia-pecas-uso.mjs` (somente leitura, só contagens por conta).
- **Rotas:** `GET /v1/analises-de-peca/disponibilidade`, `GET /v1/processos/:numero/pasta/pecas/:pecaId/estado`, `POST /v1/processos/:numero/pecas/:pecaId/analise`,
  `POST /v1/analises-de-peca/:id/avaliacao`. Tela em `ui/analisePecaIA.ts` (`script.ts` não cresceu).
- **Testes reescritos (e por quê):** os da redação de peça da Fase 0 que fixavam "CEP não é redigido", "RG mascarado passa" e "o produto não promete endereço" — a Fase 1
  muda exatamente isso; e o de `ia-pecas-casos` com a expressão "Rua Nenhuma", que agora é (corretamente) redigida. A lista de expressões proibidas **não** ganhou
  "procedente/improcedência" porque descrevem o que a parte PEDE e derrubariam o gabarito do comparador.

---

## [0.54.0] — 2026-10-22

**Resumo do processo por IA: a "situação atual" nunca é um ato antigo.** Prompt `resumo-1.1.0` e regras de verificação `1.1.0`. **Não mudaram:** modelo, provedor,
ZDR, redação, segredo de justiça, planos, teto diário, freio por hora, regras de prazo, análise do ato, análise de peças (Fase 0), calendário e a marcação "pede
providência" do sistema. Sem dependência nova; sem migração (campos novos de `contagens` e `resultado` são aditivos e opcionais). O comando de diagnóstico da
0.53.x (`scripts/diagnostico-resumo.mjs`) continua, agora também mostrando a seleção nova.

**O problema, no caso que originou esta versão:** processo com 44 atos cujo ato mais recente (despacho de 05/10) o sistema marcava "pede providência". O resumo
mostrou como "Situação do processo" duas decisões de fevereiro de 2025, disse "A IA não indicou pendências" e o rodapé não dizia que o despacho novo não tinha
sido lido. Causa provável (o código não prova qual das três; o diagnóstico mostra no processo real): o texto do ato mais recente não estava no retrato da conta —
(a) só existia na régua do tribunal (MNI), que o resumo não lê; (b) o DJEN devolveu "teor indisponível"; ou (c) o título veio do DataJud e o texto do DJEN, em
linhas separadas. A correção cobre as três, sem chamar o tribunal.

- **Seleção determinística (`selecionarAtosParaResumo`):** o ato mais recente com texto entra sempre (com o limite de caracteres das providências); todas as
  providências do sistema com texto entram, até **8** (eram 5); depois os recentes até o limite de sempre; os atos só com título formam a linha do tempo e **não
  gastam o limite de textos**. A seleção devolve também qual é o ato mais recente, se o texto dele foi lido, quais providências do sistema ficaram sem leitura (com o
  motivo) e a contagem de atos não lidos por motivo.
- **Mesmo ato em duas fontes (só para a seleção):** o ato só com título (DataJud) e o ato com texto (DJEN) contam como um quando são do mesmo dia (fuso de São
  Paulo), da mesma classe (despacho, decisão, sentença, intimação, citação, ato ordinatório, edital — pelo começo do título) e de fontes diferentes, e há exatamente um de
  cada. Na dúvida não junta. O retrato, a tela e as contagens do sistema não mudam; a providência do só-título passa ao ato com texto.
- **Cabeçalho institucional:** a regra mínima (`removerCabecalhoInstitucional`, pura) tira do começo do texto o bloco repetido (PODER JUDICIÁRIO, Tribunal, Comarca, Vara,
  endereço com CEP, Autos nº, Natureza, Polo Ativo/Passivo) só quando pelo menos duas linhas curtas seguidas casam e o que sobra continua com texto utilizável (≥ 80
  caracteres); só mexe no começo; na dúvida, devolve o original. O texto enviado ao modelo é o texto verificado.
- **Faixa do sistema (nunca escrita pelo modelo):** logo abaixo da avaliação, a tela diz o **ato mais recente** (data e tipo) e se o texto dele foi lido. Se não foi:
  "O ato mais recente (dd/mm/aaaa, tipo) não pôde ser lido; confira-o na linha do tempo. O que está abaixo vem de atos mais antigos e não é a situação atual do
  processo", e o título da seção deixa de ser "Situação do processo" para "O que os atos lidos mostram". A faixa lista as providências que o sistema marca e a IA não
  leu (data, tipo e motivo: o tribunal não liberou o texto, sem texto, texto curto demais, fora do limite) e, quando a Pasta digital **já gravada** (nenhuma consulta
  nova ao tribunal) lista um ato mais novo que o retrato, avisa isso.
- **Pendências:** com providência do sistema sem leitura, a tela não diz "A IA não indicou pendências": diz "Há ato marcado pelo sistema como que pede providência
  que a IA não leu: (data, tipo)".
- **Prompt `resumo-1.1.0`:** o modelo recebe, em blocos escritos pelo sistema, `<ato_mais_recente>` (id, data, tipo, "Texto lido: sim|não") e
  `<providencias_do_sistema>`; se o mais recente foi lido, o primeiro item de situação é sobre ele e começa pela data; se não foi, o modelo não o descreve e não usa
  "atualmente", "no momento", "hoje", "último ato", "mais recente"; nunca escreve "não há pendências"; os pontos de atenção apontam o ato (`{ codigo, ato }`). A
  frase "o ato mais recente não pôde ser lido" é do sistema (mais robusta que pedi-la ao modelo). As versões anteriores seguem legíveis (`resumo-1.0.0` fica no banco).
- **Verificação `1.1.0`:** com o ato mais recente sem leitura, item de situação que o apresenta como atual é descartado; com providência do sistema sem leitura, item que
  afirma "não há pendências" é descartado; os dois são contados à parte (`atualidade`, `pendenciaNegada`); sem item de situação sobrevivente, o resultado continua "não
  verificado". O ponto de atenção "depende de outro documento" passa a dizer **de qual ato** (data e tipo vêm do retrato, não do modelo).
- **Rodapé em uma frase:** "Este resumo usou o texto de N atos, entre eles o ato mais recente (dd/mm/aaaa). Outros M atos têm só o título e K não foram lidos." (ou
  "…, mas não o do ato mais recente (dd/mm/aaaa)…"), mais a contagem de providências que o IA não citou e de itens descartados. Aviso fixo e "Este resumo foi útil?" não mudaram.
- **Log por motivo, só contagens** ("resumo do processo montado"): atos só pelo título por teor indisponível, sem texto, abaixo do mínimo e fora do limite; mesclados;
  providências sem leitura; se o mais recente foi lido; e os descartes da verificação por motivo. Nunca texto, título, parte, número de processo ou conta.
- **Comparador `--tarefa=resumo`:** `resumo-1.0.0` × `resumo-1.1.0` sobre 8 processos sintéticos (`tests/fixtures/ia-resumo`: cabeçalho longo, muitos só-título, despacho
  e decisão do mesmo dia, ato recente sem texto). Mede pontos cobertos, "abre no ato mais recente", "atual" indevido, pendência negada, violações, descartes, latência e
  custo; relatório `.md`, métricas `.csv` e planilha de revisão humana. Manual, ZDR da lista oficial de agora, teto de gasto (US$ 1,00), estima antes de `--executar`.
  `Dockerfile` copia `tests/fixtures/ia-resumo`.
- **Fonte única da tela e do resumo:** DataJud + DJEN já eram a mesma lista (o retrato é gravado pela mesma fusão que a tela mostra). A régua do MNI **não** pode virar fonte
  do resumo: traz só título e complementos, o texto das decisões está em PDF (e a extração de PDF é interna, da Fase 0). O que se reaproveita, sem consulta nova, é a listagem
  da Pasta digital que a tela já gravou, só para avisar que o tribunal lista ato mais novo.

## [0.53.0] — 2026-10-22

**IA de peças, Fase 0: viabilidade e medição, sem produto.** Nenhuma tela, rota, plano, preço ou chamada de IA nova em produção; a análise do
ato, o resumo, o calendário, `exigir()`, o modelo e o prompt de produção não mudaram. Sem dependência npm nova; sem migração. Especificação em
`docs/ia-analise-de-pecas-especificacao-v1.1.0.md` (a v1.0.0 fica preservada); resultado e investigação em `docs/ia-pecas-fase0-resultado-v1.0.0.md`.

- **Extração de texto por página (módulo interno, sem rota):** porta `ExtratorDeTextoDePdf` e `PdftotextExtrator` (`pdftotext -layout` do poppler, já na
  imagem desde a 0.30.0). PDF pela entrada padrão, `execFile` com argumentos em vetor, 30 s por peça, 20 MB por arquivo, 8 MB de saída, 40 páginas lidas e
  80 mil caracteres por peça; erro tipado em português (`ExtracaoDeTextoError`: arquivo vazio/grande, PDF inválido ou com senha, tempo esgotado, saída grande
  demais, ferramenta ausente), sem texto de peça em mensagem ou log. **Sem OCR:** peça escaneada volta sem texto e é contada, não lida. O texto nunca é gravado.
- **`scripts/pecas-medir-texto.mjs` (somente leitura, sem rede):** sobre as peças guardadas agora, mostra só agregados — % com texto pesquisável, páginas e
  caracteres (p50, p95, máximo), % acima de 40 páginas / 80 mil caracteres, falhas por tipo e tempo de extração. Nenhum texto, nome, número de processo,
  localizador ou workspace.
- **Redação extra para peças** (`redigirPecaParaIA`, função pura): CEP, RG/CNH com rótulo, "nascido em dd/mm/aaaa" e conta/agência com rótulo. A redação da
  análise do ato NÃO mudou. **Não cobre** endereço nem nome de terceiro fora do retrato, e nenhum texto pode prometer isso.
- **24 peças sintéticas** (`tests/fixtures/ia-pecas/casos.json`): texto por página, gabarito com a página de cada ponto, proibições, instrução injetada,
  dados pessoais fictícios de formato óbvio. Teste confere o alinhamento do gabarito com o texto e a ausência de dado real.
- **Comparador de peças** (`scripts/ia-comparar-modelos.mjs --tarefa=pecas`): esquema fechado da seção 5, verificação por (página, trecho), pedidos
  principais, proibições, citação com página, latência e custo (p50, p95, máximo), relatório com o critério da seção 8 e planilha de revisão humana; manual,
  ZDR obrigatório, teto de gasto e `--executar`. `--julgar-revisao=<csv>` calcula errado/perigoso da planilha preenchida. `executarSonda` ganhou o parâmetro opcional
  `tarefa` (sem ele, nada muda).
- **Correção da 0.52.0 (imagem Docker):** os conjuntos sintéticos do comparador (`tests/fixtures/ia-avaliacao`, e agora `ia-pecas`) não estavam na imagem, então o
  comparador falharia no Console; o `Dockerfile` passa a copiá-los. Só texto inventado.

## [0.52.0] — 2026-10-22

**Infraestrutura de medição e comparação da análise por IA.** Modelo, prompt (`ato-1.2.0`, `resumo-1.0.0`), regras de
verificação, ZDR, redação e segredo de justiça **não mudaram**. Nenhuma dependência nova; a coluna nova é aditiva.

- **Conjunto de avaliação** (`tests/fixtures/ia-avaliacao/casos.json`): 48 casos 100% sintéticos (decisão, despacho,
  intimação, sentença, audiência, valor, prazo escrito, cartório, ambíguo, curtíssimo, longo e armadilhas), cada um com
  o que a resposta deve cobrir e o que não pode fazer. Teste confere o formato, a coerência com a regra de "texto
  suficiente" do produto e a ausência de qualquer padrão de dado real.
- **Comparador de modelos** (`scripts/ia-comparar-modelos.mjs`, núcleo em `src/main/sonda/`): manual, fora do CI,
  só casos sintéticos. Reaproveita as peças da sonda (sem alterá-la). Sem `--executar` só estima; só roda modelo
  aprovado pela lista oficial de ZDR na hora (falha fechada, inclusive para o modelo de produção, que é sempre a
  referência); **teto de gasto padrão de US$ 1,00 por rodada** (`--teto-usd`); chave só por variável de ambiente.
  Mede citação verificada, pontos obrigatórios cobertos, violações (calcular prazo, inventar valor/data/nome, dar
  conselho, prazo estruturado inventado), falhas de formato, latência p50/p95 e custo médio/p95/máximo/total. Relatório
  em Markdown, métricas em CSV e CSV de revisão humana. **Preços são estimativa, não confirmados**, e o relatório diz a
  origem de cada custo.
- **Avaliação com motivo:** ao marcar Errado ou Perigoso, a pessoa pode (opcional) escolher o motivo — erro de fato,
  citação inventada, concluiu prazo, deixou de fora algo importante, outro. Coluna `motivo_avaliacao` em `analises_ia` e
  `resumos_ia` (migração aditiva, sem retrocarga). Nunca texto livre; Útil nunca guarda motivo.
- **Linha de avaliação logo abaixo do cabeçalho do resultado**, com "Esta análise foi útil?" / "Este resumo foi útil?".
  Teste de navegador em 1920, 1366, 1280, 1024, 768 e 390 px.
- **`scripts/ia-avaliacoes.mjs` (v1.1.0):** custo p50, p95 e máximo por modelo e prompt, e contagem por motivo entre as
  avaliações Errado/Perigoso. Continua só leitura e sem texto.
- **Resumo no teto técnico diário compartilhado:** análise de ato e resumo de processo somam no mesmo teto por conta
  (`PROCESSOVIVO_IA_MAX_POR_DIA`). O freio de 6 por hora do resumo e a mensagem neutra seguem.

## [0.51.0] — 2026-10-22

**Calendário: lembretes no feed ICS e resumo por e-mail dos eventos a confirmar.** Detecção de eventos, estados
(sugerido, confirmado, descartado), deduplicação, privacidade do feed (`SUMMARY`/`DESCRIPTION`), token do feed,
planos, preços e e-mails existentes não mudaram. Sem dependência nova; as tabelas e colunas novas são aditivas.
Nada aqui afirma prazo: as mensagens dizem "data lida do andamento de dd/mm, confira no processo".

- **Lembretes (`VALARM`) no feed:** o feed ganhou a escolha `lembretes` (`umDiaAntes`, `umaHoraAntes`; padrão
  nenhum) em `POST`/`GET`/`PATCH /v1/calendario/feed`. Saem só em evento **confirmado** e ainda no futuro, nunca em
  sugerido nem `CANCELLED`, com `DESCRIPTION` igual ao `SUMMARY` (sem parte, sem trecho, sem observação; sigilo
  sem número). Evento com hora: `TRIGGER:-P1D` e `-PT1H`. Dia inteiro: gatilho **absoluto em UTC** (12:00Z = 09:00
  de São Paulo no dia anterior; 11:00Z = 08:00 no próprio dia). Mudar a escolha sobe o contador `revisao_lembretes`
  do feed: `SEQUENCE` = `sequencia` do evento + revisão e `DTSTAMP` = o maior entre o evento e a mudança, sem
  regravar evento e sem trocar o `UID` (nada duplica).
- **Painel "Assinar no meu calendário"** (`ui/calendario.ts`): as duas opções e o texto "Apple Calendário e Outlook
  costumam mostrar estes lembretes. O Google Agenda pode ignorá-los em calendários assinados por URL…". O
  comportamento real de cada aplicativo **não é provado por teste**: só o formato do ICS.
- **Resumo por e-mail** (`ServicoResumoDoCalendario`): um e-mail por conta, no máximo um por dia, entre 08:00 e
  12:00 de São Paulo (tick de 15 min, relógio injetado), só com evento `sugerido` novo ou `revisar` ainda não
  avisado; até 10 itens e "e mais N". Chave global `PROCESSOVIVO_CALENDARIO_RESUMO_HABILITADO` (**desligada por
  padrão**) e só com SMTP de verdade. Opção por conta em `GET`/`PUT /v1/calendario/resumo` (padrão ligado) e no
  painel ("Resumo por e-mail"). Registro de itens e envios sem e-mail, número ou texto; até 3 tentativas por item.
  O link do e-mail é `/?calendario=resumo`, que abre o Calendário.
- **CLI:** `calendario resumo-previa` (só leitura): contas e itens que receberiam o resumo agora.
- **Testes:** formato do ICS (também lido pelo ical.js), API, resumo com banco real e notificador falso, CLI, grafo
  de imports do calendário (os módulos novos entram) e navegador (axe claro/escuro, seis larguras, teclado).
  Reescritos só dois literais de `FeedDoCalendario` em `calendario-sqlite.spec.ts`, que ganhou campos obrigatórios.

---

## [0.50.1] — 2026-10-22

**Tela de entrada: aviso de que as peças valem, por enquanto, só para o TJGO.** Só texto e layout do painel da esquerda
do login e do cadastro (é o mesmo painel nas duas abas). Nenhuma regra, rota, API, banco, plano, preço ou checkout mudou;
sem migração e sem dependência nova.

- **Aviso sob "Peças das partes":** "Por enquanto, o acesso às peças vale apenas para o Tribunal de Justiça de Goiás
  (TJGO). Em breve, será estendido a todos os tribunais do Brasil." Texto simples (sem link nem tooltip), menor e em tom
  secundário (`.beneficio-aviso`, mesmo cinza do `.lead`), dentro do texto do terceiro benefício: alinhado a ele, sem
  check e sem virar um quarto benefício. Sem data e sem prazo. **Remover quando houver outro tribunal com peças.**
- **Até 900 px a lista de benefícios continua escondida** (regra de antes): o aviso some junto com a afirmação a que se
  refere, e o formulário não é empurrado.
- **Teste de navegador** `tests/browser/login-aviso-pecas-navegador.spec.ts`: texto exato nas abas "Entrar" e "Criar
  conta", posição, axe nos temas claro e escuro, seis larguras sem rolagem horizontal e regressão de cadastro e login.
  Nenhum teste anterior verificava o texto do painel, então nenhum foi reescrito.

---

## [0.50.0] — 2026-10-22

**Plano IA à venda pelo mesmo caminho dos outros planos, decidido por dado no `/admin`.** Sem migração de banco, sem
dependência nova; webhook, reconciliação, carência, teste grátis, liberação manual, e-mails, modelo, provedor, redação,
verificação e segredo de justiça não mudaram.

- **Venda por dado, não por trava fixa:** `analiseIa` passou a `implementado: true` e ganhou `cobradoPorUso: true`. Plano
  com recurso cobrado por uso só vai à venda **com preço** ("Defina o preço antes de colocá-lo à venda") e **nunca** é o
  plano do teste grátis. A semente não muda: o IA continua **fora de venda e sem preço** até o operador pôr preço e
  "à venda" no `/admin`. Daí em diante aparece em `GET /v1/planos`, no cartão de planos do app e no checkout como os
  outros. O `/admin` explica a regra ao lado da caixa do recurso.
- **Sem exceção de beta:** saiu `PROCESSOVIVO_IA_WORKSPACES_LIBERADOS` (v0.38.1) e o código dela. Só usa a análise quem
  tem `analiseIa` no plano vigente (assinado ou liberado à mão). Se a variável ainda estiver no ambiente, o arranque
  só avisa no log, sem ecoar o valor. `PROCESSOVIVO_IA_HABILITADA` segue sendo a chave geral.
- **Teto técnico de segurança:** `PROCESSOVIVO_IA_MAX_POR_DIA` (padrão **200** análises de ato por conta por dia de São
  Paulo, em memória). Não é limite do plano. Atingido: 429, motivo `limite_diario`, "Muitas análises hoje. Tente de novo
  amanhã ou fale com a gente." e nenhuma chamada ao modelo. Os freios por hora, em andamento e global continuam.
- **Aviso de upgrade:** `GET /v1/analises/disponibilidade` devolve `oferta` (`ver_planos` | `fale_conosco` | `nenhuma`,
  aditivo). Com plano de IA contratável e cobrança ligada, a frase de sempre ganha o botão **"Ver planos"** (leva a
  "Minha conta"); conta de chave de API lê "A análise por IA faz parte do plano IA. Fale com a gente para contratar.";
  sem plano à venda, a frase de sempre, sem link. Vale também para o resumo do processo.
- **Vitrine e site:** `GET /v1/planos` ganhou `incluiAnaliseIa` (aditivo). Novo trecho do site
  **`site/planos-v0.50.0.html`** (o da v0.45.0 fica como estava): destaque "Inclui análise com IA" e a nota "O teste
  grátis de 14 dias não inclui a análise com IA."; três planos lado a lado a partir de ~860 px. O cartão de planos do
  app e a confirmação de assinatura mostram o mesmo destaque, com preço e ciclo do plano.
- **Custo por análise:** já registrado desde a v0.38.0 em `analises_ia` (modelo, provedor, latência, tokens e custo
  quando o OpenRouter informa; sem texto de ato); `node scripts/ia-avaliacoes.mjs` mostra o custo médio.
- **Testes reescritos (travavam a venda da IA):** `Assinatura.spec.ts` (o recurso "ainda não existente" e o plano IA
  invendável viraram "sem preço não vende; com preço e à venda vende"), `ServicoPlanos.spec.ts` (mesma troca, no
  serviço), `admin.spec.ts` (o catálogo e o PUT do plano IA), `planos-publicos.spec.ts` (campo novo na vitrine),
  `config-ia.spec.ts` (a lista de beta saiu; fica a detecção da variável e o teto) e a remoção de
  `analise-ia-workspaces-liberados.spec.ts`. Novos: `plano-ia-venda.spec.ts` (venda, liberação pelo gateway falso,
  teste/Peças sem IA, oferta), teto diário com relógio falso e isolamento, registro sem texto, e navegador (aviso com
  e sem "Ver planos", chave de API, três planos no site e no app em seis larguras, axe claro e escuro).

---

## [0.49.6] — 2026-10-21

**Checkout: os textos não sugerem mais que é preciso ter conta no Mercado Pago.** Só textos; nenhuma regra, rota, campo de
API (`emailDoPagador` segue), banco ou lógica mudou; sem migração e sem dependência nova. O Mercado Pago exige que o e-mail
digitado na página de pagamento seja o mesmo informado ao criar a assinatura — não exige conta para pagar com cartão.

- Rótulo do campo: "E-mail da sua conta do Mercado Pago" → **"E-mail para o pagamento"**.
- Ajuda: → **"Use o e-mail que você vai digitar na página de pagamento. Você não precisa ter conta no Mercado Pago para pagar
  com cartão. Se já tiver conta, use o e-mail dela."**
- Aviso da pendente: → **"Se a página de pagamento avisou que o e-mail não corresponde, confirme abaixo o e-mail que você usou
  e tente de novo."** (o título "Seu pagamento não foi concluído?" e os botões ficam).
- Nota da lista de planos: → **"Na próxima tela você confirma o e-mail para o pagamento."**
- Recusa do gateway por e-mail (`email_pagador`), na tela: → **"O Mercado Pago não aceitou o e-mail informado para o pagamento.
  Confira o e-mail e tente de novo; se repetir, fale com a gente."**; na API: → **"O Mercado Pago não aceitou o e-mail informado
  para o pagamento."** (antes falavam do "e-mail da sua conta/desta conta").
- E-mail de cobrança recusada: "o cartão cadastrado na sua conta do Mercado Pago" → **"o cartão usado na assinatura"**.
- O erro de e-mail inválido já não citava conta: segue "Informe um e-mail válido para o pagamento." (API) e "Informe um e-mail
  válido, como nome@exemplo.com.br." (tela).
- **Testes:** reescritos só os que conferiam os textos antigos (`pagamento-tela.spec.ts`, `email-do-pagador-navegador.spec.ts`,
  `assinatura-navegador.spec.ts`); novos: a tela não contém "conta do Mercado Pago" e três testes que DOCUMENTAM o "Vale até"
  depois do pagamento aprovado (sem conta anterior = 1 mês; no teste de 14 dias = fim do teste + 1 mês; com liberação manual
  longa de outro plano = vencimento antigo + 1 mês, com o plano trocado — a origem do "Vale até 22/10/2029" visto em produção).

---

## [0.49.5] — 2026-10-21

**Checkout do Mercado Pago: o e-mail de quem paga é confirmado na tela, e quem errar tenta de novo sem ajuda.** Num teste real,
o Mercado Pago recusou o pagamento com "Seu e-mail não corresponde ao da assinatura": o sistema mandava como `payer_email` o
e-mail da conta no Processo Vivo, e o Mercado Pago exige que quem paga use o MESMO e-mail da assinatura — e a página dele não
deixa trocar. **Não mudaram:** preços e valores, `/admin`, o plano "Teste", carência, teste de 14 dias, fluxo manual, webhook
(inclusive a validação da assinatura), idempotência, reconciliação, `exigir()`, a página de vendas e `GET /v1/planos`; sem
migração e sem dependência nova; `script.ts` não cresceu.

- **Campo "E-mail da sua conta do Mercado Pago"** na confirmação do checkout, obrigatório, pré-preenchido com o e-mail da conta
  e editável, com a ajuda "Use o mesmo e-mail com o qual você vai entrar (ou pagar) no Mercado Pago. Se for outro, o Mercado
  Pago recusa o pagamento." Rótulo associado, `aria-describedby` para a ajuda e para o erro, foco no campo com erro, temas
  claro e escuro, sem rolagem horizontal de 390 a 1920 px. A frase antiga ("o e-mail dela pode ser diferente do e-mail do
  Processo Vivo") ficou falsa e saiu.
- **`POST /v1/assinatura/checkout`** aceita `emailDoPagador` (aditivo; corpo continua `.strict()`). Ausente = o e-mail da conta
  (clientes antigos). O e-mail é aparado, validado pela mesma regra do cadastro (`normalizarEmail`), tem até 200 caracteres e
  vai como `payer_email`. Inválido: 422 `email_do_pagador_invalido`, "Informe um e-mail válido para o pagamento.", antes de
  gravar o aceite ou chamar o gateway, sem repetir o valor. **O e-mail do pagador NÃO é gravado em lugar nenhum** (nem na cobrança,
  nem na trilha, nem no `/admin`, nem em log): o gateway é quem o guarda.
- **Checkout novo substitui o pendente.** Antes, cada clique em pagar criava mais uma assinatura pendente no Mercado Pago
  (sem limite) e a tela ficava em "processando" por até 2 horas, sem saída. Agora o serviço consulta cada pendente da conta:
  se o gateway diz que ela JÁ foi autorizada, responde 409 `ja_assinante` (nada é cancelado nem criado); se não, cancela no
  gateway (`PUT /preapproval/{id}` com `status: cancelled`) e marca a linha como cancelada. Falha ao consultar ou cancelar NÃO
  impede o checkout novo: vai para a trilha (operação, status e motivo; nunca dado pessoal) com `pendente_nao_substituida`, e a
  linha fica `pendente` para a reconciliação, que não mudou.
- **Tela:** com pendente, "Seu pagamento não foi concluído? Se o Mercado Pago disse que o e-mail não corresponde, confirme
  abaixo o e-mail da sua conta do Mercado Pago e tente de novo.", com o mesmo campo, o aceite dos Termos e "Tentar de novo".
  A conferência automática não refaz a tela enquanto a pessoa digita. `GET /v1/assinatura` devolve `pagamento.emailDaConta`
  (o e-mail da PRÓPRIA conta, só para pré-preencher).
- **Testes:** `tests/browser/email-do-pagador-navegador.spec.ts` (novo) e um bloco novo em `tests/http/pagamentos.spec.ts`;
  reescritos só `pagamento-tela.spec.ts` (o pedido agora leva o e-mail; dois campos na tela; a frase antiga trocada; o clique
  confere o código do plano, que também vem da pendente), `assinatura-navegador.spec.ts` (a frase antiga da lista e o corpo do pedido) e o teste de `GET /v1/assinatura` que exigia o e-mail da conta ausente da resposta.

---

## [0.49.4] — 2026-10-21

**Tabela de Atualizações, só apresentação:** a coluna Atualização fica em UMA linha, sem o link "Abrir processo" na
tabela. Detecção, "pede providência", "cumprido", filtros, contagens, busca, ordenação, paginação, `GET /v1/novidades`,
`/v1/painel`, a verificação (0.49.3), a análise por IA, o calendário, a Pasta, os Custos e os planos **não mudaram**; sem
migração e sem dependência nova; `script.ts` não cresceu.

- **Uma linha só na tabela (>= 1024 px):** ponto azul (não lida), tipo do ato (negrito quando não lida), etiqueta
  ("Intimação"), selo "Não lida" e o aviso "Sem atualização detectada" (letra pequena, cor secundária) na mesma linha.
  Faltando largura, o tipo do ato e o aviso são cortados com reticências, com o texto inteiro no `title` e no DOM (o
  leitor de tela lê tudo); a etiqueta e os selos não encolhem. As regras de quando cada coisa aparece são as de antes.
- **Sem "Abrir processo" na tabela:** o número do processo (link) e o ícone "abrir" de Ações continuam abrindo o processo.
  O botão segue no DOM só para os **cartões** (< 1024 px), onde aparece com o texto e alvo de 44 px; na tabela está com
  `display:none` (fora da tela, do Tab e da leitura). Ordem do Tab: número, copiar, caixa "Cumprido", abrir, pasta, IA.
- **Frase acima da tabela:** "Cada processo mostra a atualização mais recente. As anteriores estão no processo: clique no
  número."
- **Correção nos cartões:** a célula Atualização tinha `height:48px` herdado da tabela e, quando o selo e o botão ocupavam
  mais de uma linha, transbordava sobre a célula seguinte (o botão "Abrir processo" ficava coberto em 390 px); nos cartões
  a altura agora é automática.
- **Alturas medidas** (lida / "Não lida" com Intimação / "Sem atualização detectada"), antes → depois: 1920 px
  48/48/48 → 48/48/48; 1366 px 50/63/58 → 50/51/51; 1280 px 50/63/58 → 50/51/51; 1024 px 57/122/134 → 50/51/51.
- **Testes:** novo `tests/browser/atualizacao-uma-linha-navegador.spec.ts`; reescritos só os que procuravam o link na
  tabela, a frase antiga ou a ordem de Tab com o link (`atualizacoes-navegador`, `atualizacoes-layout-navegador`).

---

## [0.49.3] — 2026-10-21

**Sincronização mais rápida e com informação na espera.** Antes, a verificação dos processos andava um por vez (40 a 60 s
cada) e a tela só dizia "verificando". Agora até 3 processos são verificados ao mesmo tempo (máximo 4) e a tela mostra o
progresso real. **Não mudaram:** limite de requisições por fonte, timeouts e tentativas do DataJud e do DJEN, ordem do
fallback, cache de 15 min, vigilância por OAB, planos, Custos, Pasta e calendário; sem dependência nova.

- **Pool de trabalhadores** em `ServicoAcompanhamento.executar`: `SYNC_CONCORRENCIA` (padrão 3, máximo 4; inválida →
  padrão e aviso no log, nunca derruba). Continua UMA rodada por vez (a flag `sincronizando`), a mesma ordem da fila, o
  limite de 200 por varredura, `SYNC_PAUSA_MS` após cada item (por trabalhador) e os limitadores e o cache compartilhados.
  Falha de um item não derruba os outros; nenhum item é pego duas vezes; a flag só cai quando todos os trabalhadores
  terminam, mesmo com exceção. O mesmo número de processo (contas que o compartilham) nunca é buscado em paralelo, para
  manter o proveito do cache. Com 1 trabalhador o comportamento é o de antes.
- **Estado em `GET /v1/sincronizacao`** (aditivo): `situacao` (`ociosa` | `na_fila` | `em_andamento`), `total`,
  `concluidos`, `ultimoProgressoEm`; `pendentes` e o resto seguem. `demorando` = nenhum sinal de vida por mais de 5 min
  (a conta ou a rodada); rodada que avança nunca é "demorando".
- **Tela** (`ui/verificacao.ts`, `window.__pvVerificacao`; `script.ts` encolheu): botão "Na fila: sua verificação começa
  quando a rodada atual terminar." / "Verificando X de N" (consulta a cada 4 s) / volta a "Verificar agora" com a
  última verificação nova; selo "Verificando 3 de 12"; aviso "A verificação está sem avançar há alguns minutos. As fontes
  dos tribunais podem estar lentas. Última verificação às HH:MM." só sem avanço. Região `aria-live` educada: anuncia mudança
  de situação na hora e o X no máximo a cada 10 s. Temas claro e escuro, sem rolagem horizontal.
- **Log:** uma linha `processo verificado` por item (número, fonte, duração, fontes tentadas, resultado
  ok/fallback/falha; nunca partes nem texto de ato) e a `varredura concluída` com total, falhas, duração, média por
  item e concorrência.
- **Processo que sempre falha não fica mais no começo da fila:** coluna aditiva `acompanhamentos.tentado_em` (sem
  retrocarga); a fila ordena por `COALESCE(tentado_em, sincronizado_em)`. `sincronizado_em` ("Última verificação") continua
  sendo só o último SUCESSO.
- **Testes:** `tests/application/sincronizacao-pool.spec.ts` e `tests/browser/verificacao-navegador.spec.ts` novos;
  reescritas só as expectativas que supunham ordem estritamente sequencial, o texto antigo do aviso ou "Verificação
  iniciada" para `na_fila` (`verificacao-por-conta`, `atualizacoes-sem-novidade`, `atualizacoes-tela`).

---

## [0.49.2] — 2026-10-21

**Tabela de Atualizações, só apresentação:** linha compacta, número do processo sem quebra, Ações numa fileira de
ícones com dica (inclusive "Analisar com IA") e texto visível nos cartões. Detecção, regras de "pede providência" e de
"cumprido", filtros e contagens, busca, ordenação, paginação, `GET /v1/novidades`, `/v1/painel`, calendário, o painel e
o conteúdo da análise por IA, a tela do processo, a Pasta, os Custos e os planos **não mudaram**; sem migração e sem
dependência nova; `script.ts` não cresceu.

- **Linha de 48 a 56 px** (antes ~104 px) para o processo típico em 1920, 1366 e 1280 px. **Processo:** o CNJ numa linha só
  (sem quebra) com o ícone de copiar colado ao número. **Partes:** até duas linhas e só então reticências, texto
  inteiro no `title`. **Tribunal/Classe:** uma linha com reticências; abaixo de 1600 px a Classe vira a linha de baixo da
  célula do Tribunal (como já era de 1024 a 1279 px). **Data do ato** e **Detectado** sem quebra, em coluna de conteúdo;
  o cabeçalho mostra **"Data"** (o nome completo, "Data do ato", fica no `aria-label` e no `title` do botão de ordenar).
- **Atualização numa linha só:** tipo do ato (negrito), etiqueta ("Intimação"), o link "Abrir processo", "Não lida" e o
  aviso **"Sem atualização detectada"** (mesmo texto, em letra pequena) dividem a MESMA linha e só descem quando falta
  largura. Quando o ato da linha é apenas o último andamento, "Última movimentação conhecida" deixou de ser texto
  visível: vai no `title` e em texto para leitor de tela, para o aviso caber numa linha.
- **Ações numa fileira só**, todos de 28 px (26 px em 1024–1279 px): caixa "Cumprido", abrir, pasta e **"Analisar com IA"
  como ícone** (faísca). Cada ícone tem `aria-label` próprio e a **mesma dica** da caixa "Cumprido"
  (`__pvProvidencia.comDica`), por mouse e por foco, com Esc fechando só a dica: "Copiar número", "Abrir o processo",
  "Abrir a pasta do processo", "Analisar com IA". O `title` antigo dos ícones saiu (a dica o substitui); a caixa
  mantém as dicas da 0.46.1. O botão de IA não tem estado desabilitado nem de carregamento — ele existe ou não existe
  (IA desligada ou ato sem chave); aberto/fechado continua em `aria-expanded` (fundo azul-claro) e o carregamento no
  painel. Mesmo clique, mesmo painel, mesmas regras de plano e de teste fechado.
- **Cartões (abaixo de 1024 px, como antes):** cada ícone ganha o texto ao lado ("Copiar número", "Abrir", "Pasta",
  "Analisar com IA"), alvo de 44 px, e as dicas dos ícones somem (sem mouse não há dica); a da caixa "Cumprido" continua.
- **O ponto de quebra para cartões não mudou (1024 px).** Em 1024–1279 px a tabela cabe sem rolagem horizontal, mas é
  apertada: o CNJ sem quebra e a fileira de ícones já pedem ~330 px dos ~720 px da tabela.

## [0.49.1] — 2026-10-21

**Painel de Custos do processo, só apresentação:** colunas da tabela de lançamentos, ações em ícones com dica e grade do
formulário. Regras de custos, totais, recebimentos, depósitos, cancelamento, histórico, comprovantes, PDF, CSV, API, banco,
a tela "Custos" por cliente, Atualizações, Pasta e planos **não mudaram**; sem migração e sem dependência nova.

- **Tabela de lançamentos:** Data (6,5 rem) e Valor sem quebra de linha — o valor à direita, com algarismos tabulares —;
  Pago por, Cobrar do cliente e Ações com largura de conteúdo; **Subcategoria numa linha só**, com reticências e o texto
  inteiro em `title` e no nome acessível (o corte é só visual); **Descrição** com o que sobra, até duas linhas e só então
  reticências (texto inteiro em `title`). Em 1366 e 1920 px (e 1280 px) um lançamento típico ocupa uma linha. De **900 a
  1439 px** as colunas estreitas encolhem e, abaixo de 1280 px, a letra e as margens também e a Subcategoria pode ir a duas
  linhas — em 1024 px a tabela agora cabe sem rolagem (antes a lista já virava cartões em 1100 px). O limite dos cartões
  passou de 1099 para 899 px. Larguras medidas antes e depois estão no relatório da PR.
- **Ações como ícones** (mesma ordem de sempre): Editar (lápis), Cancelar lançamento (círculo cortado — não é lixeira,
  porque o sistema cancela e não apaga), Anexar comprovante (clipe, com **selo de contagem** que não muda o tamanho do
  botão) e Histórico (relógio); "Reativar" (seta) nos cancelados. Cada um é um `<button type="button">` de 28×28 px com
  `aria-label` próprio ("Editar lançamento", "Cancelar lançamento", "Anexar comprovante" / "Anexar comprovante (2
  anexados)", "Histórico do lançamento"; nos recebimentos, "…recebimento"). **Dica** ao passar o mouse e ao focar pelo
  teclado, com o texto da ação, `role="tooltip"` ligada por `aria-describedby`, que **fecha com Esc** sem fechar o painel —
  é a **mesma dica da caixa "Cumprido"** (`__pvProvidencia.comDica` / `ligar`, em `ui/providencia.ts`), sem segundo desenho.
  Em tela estreita (cartões, abaixo de 900 px) **o texto da ação aparece ao lado do ícone** (Editar, Cancelar, Comprovante,
  Histórico, Reativar), porque sem mouse não há dica; a dica fica escondida ali.
- **Formulário** ("Novo lançamento", edição e recebimento) em **grade CSS** de quatro faixas: rótulos, caixas e altura dos
  controles alinhados na mesma linha (o "Valor (R$)" deixou de ficar mais baixo que "Data do gasto" e "Descrição"); a
  prévia do valor em reais cai abaixo da caixa, em altura reservada, sem empurrar os vizinhos; em tela estreita, uma coluna.
  Campos, validações, máscara do valor, conversão em centavos e ordem do Tab não mudaram.

## [0.49.0] — 2026-10-21

**Centro de custos, ampliação 2 de 2 (itens 4 e 7):** a tela **Custos** por cliente (com PDF consolidado e
planilha CSV) e os **comprovantes** guardados no Google Drive do advogado — mais o aviso do "Deixar de acompanhar".
Continua um advogado só, sem receita, honorário, multa, vencimento, previsto, alerta, integração bancária,
cálculo de custas, perfis nem permissões. Atualizações, Pasta, Calendário, IA, pagamentos, página de vendas e as
regras de plano não mudaram; o envio de peças ao Drive (v0.42.0) ganhou só um método novo e uma refatoração do
repetidor de 429/5xx, com os mesmos testes verdes.

- **Tela "Custos" no menu, logo depois de "Calendário"** (`ui/custosPorCliente.ts`; `script.ts` não cresceu).
  Filtros por **cliente**, **período** e **"somente com saldo a cobrar"**. Cada linha: processos, total de despesas,
  pago pelo escritório, recebido, saldo a cobrar e crédito do cliente. Abrir um cliente lista os processos dele
  com os totais de cada um e um atalho para o painel de custos do processo. Toda lista diz "Mostrando X de Y"
  (Y sem filtro). O cliente é o **rótulo que o advogado deu à pasta do processo**; quem não tem rótulo cai em
  "Sem cliente", e a tela AVISA quantos processos estão assim. Saldo e crédito são **por processo** (o recebimento
  de um processo não abate o de outro); o consolidado só soma os inteiros que `calcularTotais` já devolveu.
- **"Deixar de acompanhar" avisa** quando o processo tem custos lançados: o rótulo de cliente mora na pasta e se
  perde, o processo passa a "Sem cliente" na tela Custos, e **os custos não se perdem** (decisão A do dono; os custos
  continuam independentes do acompanhamento). Sem custos, não pergunta nada.
- **PDF consolidado por cliente** ("Prestação de contas — <cliente>"): uma seção por processo (número e tribunal)
  com despesas, depósitos e garantias em bloco à parte, recebimentos e totais do processo, e os **totais gerais**
  no fim. Mesmas regras do PDF por processo: categoria "Grupo › Subcategoria", "pago por", saldo e crédito;
  cancelados fora; **sem partes, sem texto de ato, sem dado de segredo de justiça**; gerado sob demanda e entregue
  na resposta, **sem gravar em disco**; rodapé com a versão do sistema. Cada lançamento diz "Comprovantes: N" (só o
  número — nunca nome de arquivo nem link do Drive).
- **CSV** (por processo, e por cliente/período): UTF-8 **com BOM**, separador **ponto e vírgula**, **vírgula
  decimal** (`1234,56`), datas `dd/mm/aaaa`, CRLF; uma linha por lançamento e outra por recebimento (coluna **Tipo**:
  Despesa, Depósito, Recebimento); colunas Situação, Processo, Cliente, Descrição, Subcategoria, Pago por, Cobrar
  do cliente, Valor e Comprovantes. Cancelados ficam de fora; com a opção entram **marcados** na coluna Situação.
  **Proteção contra injeção de fórmula:** célula de texto que começa com `=`, `+`, `-`, `@`, tabulação ou retorno
  de carro ganha um apóstrofo na frente. **XLSX não foi feito:** o projeto não tem biblioteca de zip/planilha e a
  regra é não criar dependência nova; o CSV abre direto no Excel em português.
- **Comprovantes (item 7):** até **5 por lançamento**, **PDF, JPEG ou PNG, 5 MB cada**. O tipo é conferido pelos
  **primeiros bytes** (a extensão e o `Content-Type` não decidem; o que o navegador declarou tem de bater com o
  conteúdo), o nome é saneado (sem caminho nem caractere proibido, com a extensão do tipo real) e a mensagem nunca
  repete o nome nem o conteúdo. O arquivo vai **direto da memória ao Drive** (`Processo Vivo/<número>/Custos`, só
  o número no nome): **nada é gravado no servidor**, nem arquivo temporário. O sistema guarda **apenas** o id do
  arquivo no Drive, o link, o nome, o tamanho e a data (`comprovantes_custo`, tabela nova e aditiva). Regras do
  Drive valem aqui: só quando o advogado clica, só de ida (não lê nem apaga nada no Drive), `salvarNoDrive` do plano
  e `PROCESSOVIVO_DRIVE_HABILITADO` respeitados, token no cofre. Sem Drive conectado, sem o recurso no plano ou com o
  Drive desligado, o botão **explica** (frase nossa, o caminho é "Meus acessos") e **nenhuma chamada ao Google**
  acontece. Cota cheia, limite de uso, fora do ar (4 tentativas, `Retry-After` até 60 s) e autorização vencida
  (renova UMA vez; se revogada, pede reconexão sem insistir) têm resposta própria em JSON, sem texto do Google.
  **"Remover" tira só o vínculo**: o arquivo continua no Google Drive do advogado, e a tela diz isso.
  "Abrir no Drive" abre em nova aba com `rel="noopener noreferrer"` e só para endereço do domínio do Google.
  O histórico registra **anexou** e **removeu** (sem nome de arquivo); nada de nome de arquivo em log.
- **API nova:** `POST /v1/custos/:id/comprovantes` (corpo binário, nome em `x-nome-do-arquivo`, 20 por minuto),
  `DELETE /v1/custos/:id/comprovantes/:comprovanteId`, `GET /v1/custos/clientes`, `GET /v1/custos/clientes/detalhe`,
  `GET /v1/custos/clientes/prestacao.pdf`, `GET /v1/custos/lancamentos.csv` e
  `GET /v1/processos/:numero/custos/lancamentos.csv`. Cookie ou chave, `exigir('custosDoProcesso')`, isolamento por
  workspace, Zod `.strict()` nas consultas, limite de taxa. Corpo grande demais agora responde 413 em JSON.
  Upload **sem dependência nova** (sem multipart): corpo binário e teto de 5 MB só nessa rota.
- **Sem dependência nova.** Testes: domínio (tipo pelos bytes, nome saneado, soma por cliente), CSV (BOM, separador,
  injeção de fórmula), servidor (isolamento, planos, limites, Drive simulado — upload ok, tipo falso, 5 MB, 6º
  arquivo, Drive desconectado, plano sem o recurso, token expirado, cota cheia, remoção só do vínculo, nada em disco,
  nada em log), PDF consolidado (texto extraído com `pdftotext`; 1 e 200 lançamentos) e navegador (menu, filtros,
  "Sem cliente", PDF e CSV baixados, aviso do "Deixar de acompanhar", comprovantes, axe nos dois temas, seis larguras).

---

## [0.48.0] — 2026-10-21

**Centro de custos, ampliação 1 de 2 (itens 1, 2, 3, 5 e 6):** recebimentos do cliente, quem pagou, depósitos e
garantias fora das despesas, cancelar em vez de excluir (com histórico) e catálogo em dois níveis. A segunda parte
(tela "Custos" por cliente com PDF e CSV, e comprovantes no Google Drive) vem na 0.49.0. Continua sendo o controle de
custos para cobrar do cliente e prestar contas, de um advogado só: sem receita, honorário, multa, conta a pagar,
vencimento, previsto, alerta, integração bancária, cálculo de custas, perfis, permissões nem multiusuário.
Atualizações, Pasta, Calendário, IA, Drive, pagamentos, página de vendas e as regras de plano não mudaram.

- **Recebimentos do cliente (item 1).** Tabela nova `recebimentos_processo` (data, `valor_centavos` inteiro > 0,
  observação de até 200 caracteres, cancelamento). O reembolso deixa de ser alocado por lançamento: a caixa
  "Ressarcido" e as rotas `PUT|DELETE /v1/custos/:id/ressarcimento` saíram. **Saldo a cobrar = reembolsável − recebido,
  nunca negativo; o excedente aparece à parte como "Crédito do cliente".** Totais no topo: total de despesas, pago
  pelo escritório, pago diretamente pelo cliente, reembolsável, recebido, saldo a cobrar e, se houver, crédito.
  Rotas: `POST /v1/processos/:numero/recebimentos`, `PATCH /v1/recebimentos/:id`. Teto de 500 por processo.
- **Migração dos dados (única, idempotente, marcada em `estado` como `migracao:custos-0.48.0`).** Cada lançamento
  reembolsável com `ressarcido_em` gera UM recebimento (data do ressarcimento, valor do lançamento, observação
  "Migrado da versão anterior"; id derivado do lançamento, então rodar de novo não duplica). A coluna `ressarcido_em`
  **não é apagada**, só deixa de ser usada. Nada de `DROP`, nenhuma coluna ou tabela da 0.47.0 foi removida.
- **Quem pagou (item 2).** Campo `pago_por` (`escritorio` por padrão, `cliente`). Despesa paga pelo cliente conta no
  total de despesas mas não gera reembolsável nem saldo: o servidor desliga "Cobrar do cliente" à força, e a tela a
  mostra desligada e desabilitada com a explicação escrita. "Pago por" é texto na linha. Lançamentos antigos viram
  `escritorio` (padrão da coluna).
- **Depósitos e garantias (item 3).** A natureza é DERIVADA do grupo: o Grupo 08 é depósito, todos os demais são
  despesa; não existe campo solto que possa discordar do grupo. Depósitos têm bloco e totais próprios e **não entram no
  total de despesas nem nos subtotais**. Depósito adiantado pelo escritório e marcado "Cobrar do cliente" entra no
  saldo e aparece identificado ("dos quais depósitos e garantias"). Levantamento, restituição e conversão de depósito
  **não** foram implementados (fora de escopo; use a descrição). Uma subcategoria própria com lançamentos não pode
  passar de ou para o Grupo 08 (reclassificaria, calada, totais já prestados ao cliente).
- **Cancelar em vez de excluir, com histórico (item 5).** Lançamentos e recebimentos não são mais apagados pela
  interface nem pela API: `POST|DELETE …/cancelamento` (motivo opcional de até 200 caracteres; reativar). Cancelados
  ficam fora de totais e PDFs, ocultos por padrão e visíveis em "Mostrar cancelados" (riscados e com o texto
  "Cancelado"). "Excluído. Desfazer" virou "Cancelado. Desfazer" (6 s), que apenas reativa o MESMO registro. Tabela
  `historico_custos`, **somente de acréscimo** (o repositório só insere e lê): criou, editou (campos alterados com o
  valor anterior e o novo: valor, data, subcategoria, pago por, cobrar do cliente), cancelou e reativou; descrição e
  observação são registradas como "alterada", sem copiar o texto. `GET /v1/custos/:id/historico` e
  `GET /v1/recebimentos/:id/historico`; na tela, o botão "Histórico" por linha. Só a exclusão da conta apaga.
- **Catálogo em dois níveis (item 6).** Dez grupos de código permanente (01 a 08, 11 e 12; **não** existem 09 Multas
  nem 10 Honorários) e 45 subcategorias pré-cadastradas com os códigos do dono (CUS-001…OUT-002). O advogado cria
  subcategorias próprias em qualquer grupo (até 60 ativas por conta, nome de até 60 caracteres, único dentro do
  grupo), arquiva, reativa e move de grupo. Seletor com os grupos como títulos e busca por texto, sem acento. O grupo
  08 mostra "Depósitos e garantias não entram no total de despesas." **O catálogo é um cadastro de classificação: não
  afirma que uma cobrança seja exigível em um processo e não calcula custas.**
- **Migração das categorias da 0.47.0:** Custas judiciais → CUS-020 · Perícia → PER-001 · Diligência → DIL-001 ·
  Deslocamento → ADM-001 · Cópias e impressões → ADM-004 · Publicações → DIL-010 (a antiga era genérica) · Outros →
  OUT-001. Categorias próprias viram subcategorias próprias do Grupo 12 (mesmo nome, mesmo código `c-<id>`); a chave
  de unicidade passa a ser `<grupo>:<nome>`. O servidor ainda aceita os códigos antigos e os traduz.
- **PDF da prestação de contas:** a categoria sai como "Grupo › Subcategoria", cada linha diz quem pagou, os
  depósitos vão em bloco à parte, os recebimentos ganham a própria tabela e o quadro de totais traz o saldo e o
  crédito. Cancelados não aparecem. Continua sem partes, sem texto de ato e sem gravar em disco.
- **Tela** (`ui/custos.ts`; `script.ts` não cresceu): "Registrar recebimento", "Pago por", seletor Grupo ›
  Subcategoria com busca, "Mostrar cancelados", "Reativar", "Histórico" e "Cancelado. Desfazer".
- **Sem dependência nova.** Testes: domínio (saldo, crédito, depósito, pago por, cancelamento, histórico, catálogo),
  migração (esquema da 0.47.0 → 0.48.0, rodando duas vezes), servidor (isolamento, planos, limites, Zod `.strict()`),
  PDF (texto extraído com `pdftotext`) e navegador (fluxo completo, teclado, axe nos dois temas, seis larguras).
  Reescritos, com o motivo: a caixa "Ressarcido" por lançamento, o "Excluído. Desfazer" que recriava o registro e as
  categorias antigas — todos afirmavam comportamento que esta versão substitui de propósito.

---

## [0.47.0] — 2026-10-20

**Centro de custos do processo:** o advogado lança as despesas de cada processo, vê os totais e gera uma prestação
de contas em PDF para o cliente. Funcionalidade nova e aditiva: Atualizações, Pasta, Calendário, IA, Drive,
pagamentos, página de vendas e a busca não mudaram. Versão 1 é manual — sem receita, honorário, parcela, integração
bancária nem comprovante.

- **Dados** (duas tabelas novas, sem migração destrutiva e sem retrocarga): `custos_processo` (lançamento: data,
  descrição, categoria, `valor_centavos` INTEIRO, reembolsável, `ressarcido_em`) e `categorias_custo` (categorias
  próprias, nome único por conta sem acento nem caixa, arquivável). Lista base fixa em código: Custas judiciais,
  Perícia, Diligência, Deslocamento, Cópias e impressões, Publicações, Outros. Chaves começam por `workspace`.
- **Regras:** valor em centavos, maior que zero e até R$ 1.000.000,00; descrição obrigatória, até 200 caracteres;
  data real (1/1/2000 até um ano à frente); 500 lançamentos por processo e 30 categorias próprias ativas por conta
  (422 com `detalhes.limite`); categoria própria não repete a base. **Os custos NÃO dependem de o processo estar
  acompanhado:** deixar de acompanhar não os apaga (a pasta e os custos são coisas diferentes; o gasto existiu).
- **Recurso `custosDoProcesso` no catálogo de planos**, ligado em TODOS os planos (inclusive o teste de 14 dias) por
  retrocarga única e marca em `estado`, como o calendário. O operador pode tirá-lo de um plano no `/admin` sem
  mexer em código. Conta de chave de API passa pelo `exigir()` como nos demais recursos (sem assinatura, passa).
- **API** (cookie ou chave, `exigir`, isolamento por workspace, limite de taxa por rota): `GET|POST
/v1/processos/:numero/custos`, `GET …/custos/totais`, `PATCH|DELETE /v1/custos/:id`, `PUT|DELETE
/v1/custos/:id/ressarcimento`, `GET|POST /v1/custos/categorias`, `PATCH /v1/custos/categorias/:id` (arquivar) e
  `GET …/custos/prestacao.pdf`. Totais calculados no servidor, em inteiros: gasto, reembolsável, ressarcido, saldo a
  cobrar (= reembolsável − ressarcido) e subtotais por categoria. Lançamento de outra conta é 404, igual a "não existe".
- **Prestação de contas em PDF** (pdf-lib, que o projeto já usa — nenhuma dependência nova): A4, cabeçalho da tabela
  repetido, totais sempre na última página, "Página N de M", filtros de período e "somente o que está a cobrar".
  Só leva número, tribunal, rótulo de cliente, advogado e OAB da conta, os lançamentos e os totais; **nunca** parte,
  texto de ato nem dado de segredo de justiça. Gerado sob demanda, entregue na resposta, **sem gravar em disco**.
- **Tela** (`ui/custos.ts`; `script.ts` não cresceu): botão "Custos" na capa do processo, painel com totais,
  subtotais, lista (cartões abaixo de 1100 px), formulário com valor `1.234,56`/`1234,56`, "Nova categoria…" e a
  caixa "Ressarcido" no estilo da "Cumprido" (otimista, com reversão). Excluir pede confirmação na linha e mostra
  "Excluído. Desfazer" por 6 s; o desfazer recria o lançamento.
- **Privacidade:** valor, descrição e nome de categoria não vão a log, e-mail, `/v1/novidades` nem rota pública.
  Os custos entram no backup do banco como os demais dados (nota no DEPLOY.md).
- **Testes** (sintéticos): domínio (totais, valores, categorias), HTTP (cookie e chave, isolamento, plano, limites),
  PDF (1 e 200 lançamentos, texto extraído com `pdftotext`) e Chromium (fluxo, teclado, axe nos dois temas, seis
  larguras, regressão da tela do processo e de Atualizações).

---

## [0.46.1] — 2026-10-20

**Tabela de Atualizações, segundo ajuste:** Partes ganha largura, a coluna "Cumprido" deixa de existir (a caixa
passa para a coluna Ações), o selo "Intimação a outro destinatário" sai da linha e a frase fixa sob o filtro de
Situação some. Só apresentação e posição de controle: a detecção de "pede providência", as regras e as chamadas de
"cumprido", `GET /v1/novidades`, `/v1/painel`, calendário, Pasta, IA e a busca não mudaram. Sem migração.

- **Larguras** (1920 / 1366 / 1280 / 1024 px, dados sintéticos, medido no Chromium): Partes 169 → 315 / 111 → 180 /
  102 → 166 / 83 → 136 px; Atualização 413 → 332 / 214 → 208 / 183 → 178 / 135 → 135 px. A largura da coluna
  extinta (145 / 95 / 88 / 79 px) voltou para a tabela; Ações cresceu para caber a caixa. Partes quebra em palavras
  inteiras, em até duas linhas, e só então corta com reticências (o nome completo fica no `title`). Sem rolagem
  horizontal em 1920, 1366, 1280, 1024, 768 e 390 px.
- **Caixa "Cumprido" na coluna Ações**, como PRIMEIRO controle (antes de abrir, pasta e "Analisar com IA"). Mesmo
  comportamento, mesmas duas chamadas, mesma dica (`role="tooltip"`, mouse, foco, Esc). Linha sem providência não
  tem caixa, mas reserva a vaga dela, para os ícones não mudarem de lugar. No empilhado (< 1024 px) a caixa abre o
  grupo de ações com o rótulo "Cumprido" visível. O módulo `ui/providencia.ts` continua dono de tudo sobre "cumprido".
- **Selos que moravam na coluna extinta:** "Não lida" e "sem marca há mais de N dias" passam para o fim da célula
  Atualização, sem mudar de texto nem de regra.
- **Selo "Intimação a outro destinatário" retirado da linha** (decisão do dono). O filtro continua: a frase "N com
  intimação a outro destinatário · Ver" e a lista aberta pelo "Ver" (com a explicação) seguem como estavam; o "Ver"
  ganhou um `title` com a mesma explicação.
- **Frase "Leitura automática do andamento, não é contagem de prazo. Confira no processo." removida** de baixo do
  filtro de Situação (decisão do dono). "Confira no ato completo" fica no `title` do cabeçalho Ações, do chip
  "Pedem providência" e da etiqueta Intimação/Citação.
- **Testes reescritos:** os que afirmavam a coluna "Cumprido" (`th.h-sit`, `td.c-sit`, nove colunas), o selo "outro
  destinatário" na linha, as larguras da 0.46.0 e a frase fixa sob o filtro; mais os que liam "Não lida" em `.c-sit`.

---

## [0.46.0] — 2026-10-20

**A tabela de Atualizações ficou mais limpa:** a célula Atualização mostra uma linha só, as colunas de data
ficaram estreitas e a coluna de providência virou "Cumprido", apenas com uma caixa e uma dica. É mudança de
apresentação e de controle; a detecção de "pede providência", as regras de "cumprido" e as rotas não mudaram.

- **Atualização em uma linha:** tipo do ato (negrito) + etiqueta (Intimação/Citação) + link "Abrir processo". O
  trecho do texto do ato saiu da tabela. **Nenhum dado foi apagado:** o texto continua guardado e aparece na tela
  do processo, na Pasta e na análise por IA; `GET /v1/novidades` não mudou. O trecho era montado só por
  `notaDoAto` (`ui/atualizacoes.ts`), com `ui/trechoDeTexto.ts`, que foi removido junto do seu teste. O link
  "Abrir processo" agora aparece em toda linha (antes, só quando o trecho era cortado).
- **Datas estreitas:** "Data do ato" e "Detectado" com largura fixa (5,25 rem; 4,75 rem entre 1024 e 1279 px),
  sem quebra de linha. Atualização e Partes ficaram mais largas em 1920, 1366, 1280 e 1024 px.
- **Coluna "Cumprido" (antes "Situação"):** só a caixa de seleção, sem o texto "Pede providência" nem o rótulo
  "Cumprido". Sem providência, a célula fica sem caixa e sem traço. Uma dica leve explica a caixa ("Pede
  providência. Marque quando cumprida." / "Cumprida. Clique para desmarcar."), com mouse e teclado, e fecha com
  Esc. Marcar e desmarcar usam as mesmas chamadas, com atualização otimista, reversão em erro e o aviso
  "Marcado como cumprido. Desfazer".
- **Código:** a célula e a dica moram em `ui/providencia.ts` (`celula`, `pintar`, `ligar`), isolados para uma
  futura marcação por categorias (não implementada).
- Testes reescritos: os que afirmavam o texto "Pede providência", o rótulo "Cumprido" visível, o cabeçalho
  "Situação" e o trecho transcrito. Testes novos de navegador para a dica, as larguras e o toque.

---

## [0.45.1] — 2026-10-20

**Quando o Mercado Pago recusa o pedido, o log diz por quê, a API devolve JSON com um motivo e o /admin mostra
a última falha.** Em produção, com credenciais de teste, `POST /v1/assinatura/checkout` voltava 502 e o proxy do
Easypanel trocava o corpo por uma página HTML: ninguém via o motivo do 400.

- **Log (`warn`) a cada 4xx do Mercado Pago** ("gateway de pagamento recusou o pedido"): operação, status, motivo,
  os campos `error` e `message` e, de cada item de `cause`, o `code` e a `description`; mais os NOMES dos campos
  enviados no pedido (`payer_email`, `auto_recurring.frequency`…), nunca os valores. E-mail é mascarado
  (`c***@e***.test`), token é apagado, cada texto é cortado em 300 caracteres e o corpo bruto nunca é gravado.
  5xx e 429 geram um `warn` curto só com status e operação.
- **API: 422 e 503, nunca 502.** Recusa do gateway é **422** e gateway fora do ar é **503**, sempre em JSON, com
  `detalhes: { situacao, motivo }` e `motivo` de uma lista fechada: `email_pagador`, `credencial`,
  `parametro_invalido`, `indisponivel`, `desconhecido`. A mensagem é nossa; o texto do gateway nunca sai.
  A classificação casa por **nome de campo do contrato** (`payer_email`, `back_url`…) e por frases inteiras
  conhecidas (`Invalid users involved`), nunca por palavra solta; sem evidência é `desconhecido`.
- **Tela:** uma frase diferente, em português claro, para cada motivo. Se o proxy trocar o corpo por HTML
  (502/503/504 sem JSON), o status sozinho vale como `indisponivel`.
- **/admin:** `GET /admin/api/pagamento` ganha `ultimaFalha` (data, operação, status, código, motivo) e a aba
  Assinaturas mostra "Última falha do gateway". Vem da trilha de auditoria (`eventos_de_pagamento`, tipo
  `gateway_falhou`): sem tabela nem coluna nova, e sem dado do pagador.
- Falhas do gateway também são registradas ao cancelar a renovação e na reconciliação.
- `GatewayDePagamentoRecusouError` carrega `motivoDoGateway` e um `diagnostico` já saneado;
  `GatewayDePagamentoIndisponivelError` carrega `motivoDoGateway = 'indisponivel'`.
- **O corpo do `POST /preapproval` NÃO mudou** e o fluxo do e-mail do pagador também não (ver o relatório da
  entrega: o `payer_email` é a causa mais provável do 400 com credencial de teste, e mudar o fluxo depende de
  decisão do dono).
- Testes ajustados da 0.45.0: `tests/browser/assinatura-navegador.spec.ts` (o gateway fora do ar agora tem frase
  própria). Novos: `recusa-do-mercadopago.spec.ts`, `MercadoPagoAdapter-recusa.spec.ts`, e casos em
  `pagamentos.spec.ts`, `admin-pagamento.spec.ts`, `pagamento-tela.spec.ts` e no teste de navegador.

## [0.45.0] — 2026-10-19

**Página de vendas: a ponte entre o site (planos) e o app (cadastro, confirmação e pagamento).**

- **Rota pública `GET /v1/planos`** (sem cookie e sem chave): só planos à venda, com `slug`, `nome`, `resumo`,
  `recursos` (nomes legíveis), `preco` (`{ valorCentavos, ciclo }` ou `null`) e `assinavel`, mais
  `pagamentoDisponivel` (`false` com a cobrança desligada). Nenhum id de banco, contagem ou configuração.
  Plano sem preço aparece **sem preço e sem "Assinar agora"**. Cache de 60 s e balde de limite de taxa próprio
  (120/min por IP). **CORS manual só nesta rota**, só para a origem de `PROCESSOVIVO_SITE_URL`, só `GET`, sem
  credenciais, `Vary: Origin` sempre; vazio (padrão) = sem CORS. `CORS_ORIGINS` (global) não mudou.
- **O plano escolhido no site atravessa cadastro e login.** O site aponta para a RAIZ do app:
  `/?plano=<slug>&conta=1` (teste grátis) e `/?plano=<slug>&assinar=1&conta=1` (assinar agora). O parâmetro é
  lido uma vez e sai da barra de endereço; só um slug no formato do catálogo é guardado, no `sessionStorage` por
  30 minutos (memória de reserva; nunca `localStorage`); depois de entrar, é conferido contra `GET /v1/planos`.
  Qualquer outro valor é ignorado em silêncio, e o plano nunca é destino de redirecionamento. Sem `assinar=1` a
  pessoa entra no teste normalmente e o plano fica destacado ("Plano escolhido") em "Minha conta"; com
  `assinar=1` abre a confirmação — **nunca cobra sozinho**. `conta=1` abre direto o cadastro.
- **Tela de confirmação de assinatura** (valor, ciclo, "Renovação automática. Você pode cancelar quando
  quiser.", link dos Termos, caixa de aceite DESMARCADA; "Continuar para o pagamento" só habilita com o aceite;
  "Ambiente de teste, nenhuma cobrança real." no teste). O botão "Assinar" do cartão de "Minha conta" usa a
  MESMA tela, em vez de chamar o checkout direto.
- **`POST /v1/assinatura/checkout` passa a exigir `aceiteTermos: true`.** Sem ele: 422 `termos_nao_aceitos` e
  nada é criado (nem cobrança, nem aceite, nem chamada ao Mercado Pago). O servidor grava o aceite na tabela
  nova `aceites_termos` (workspace, versão, plano, data; sem e-mail e sem IP; `CREATE TABLE IF NOT EXISTS`,
  nenhuma tabela existente muda).
- **Nova variável `PROCESSOVIVO_TERMOS_VERSAO`**: obrigatória com a cobrança habilitada (fail-closed).
  Em produção: `1.1`; passa a `1.2` quando os novos Termos saírem. **Atenção ao atualizar:** quem já usa a
  cobrança precisa defini-la antes do deploy, senão o serviço não sobe.
- **Nova variável `PROCESSOVIVO_SITE_URL`** (opcional): a origem do site de vendas.
- **Assinatura já em curso não abre outro checkout:** qualquer recorrência autorizada (de qualquer plano) segue
  barrada (`ja_assinante`, agora com "Para trocar de plano, cancele a renovação atual primeiro."), e plano
  pago e vigente do MESMO plano por liberação manual (Pix) é barrado com `plano_ja_vigente` (409). O teste de
  14 dias não conta como assinatura ativa. A troca de plano continua fora de escopo.
- **Trecho do site:** `site/planos-v0.45.0.html` (HTML + CSS + JS em um arquivo, sem dependência externa) para
  colar no site; texto da rede só por `textContent`; falha ou demora cai numa mensagem neutra com um botão.
- Webhook, adapter do Mercado Pago, reconciliação, regras de plano e `exigir()`, carência, teste de 14 dias,
  fluxo manual, IA, Drive, peças e calendário: **não mudaram**.
- Testes: vitrine pública (CORS, limite, campos), configuração, aceite obrigatório, plano vigente, tela de
  confirmação e plano escolhido no Chromium (cadastro, login, valores inválidos, chave de API, pagamento
  desligado), e o trecho do site (falha, tempo esgotado, dado malicioso, axe, 6 larguras, claro e escuro).
  Testes da 0.44 ajustados ao aceite obrigatório: ver a lista no PR.

## [0.44.1] — 2026-10-19

**O ambiente do pagamento passa a ser declarado, não deduzido do token.** O Mercado Pago emite credenciais
de teste com prefixo `APP_USR-`, igual às de produção; o prefixo `TEST-` deixou de identificar o ambiente.

- **Nova variável `PROCESSOVIVO_PAGAMENTO_AMBIENTE`** (`teste` | `producao`): obrigatória com
  `PROCESSOVIVO_PAGAMENTO_HABILITADO=true` e **sem valor padrão** (fail-closed). Ausente ou inválida, o
  arranque recusa e diz qual variável, sem imprimir segredo.
- **/admin e log** mostram o ambiente a partir da variável, com "TESTE" em destaque; a trava de teste em
  produção (`PROCESSOVIVO_PAGAMENTO_PERMITIR_TESTE`) olha a variável, não o prefixo do token.
- **Token `TEST-` com `producao` não sobe** (contradição que o prefixo prova).
- `ambienteDoToken` saiu; `MercadoPagoAdapter` recebe o ambiente nas opções.
- **Atenção ao atualizar:** quem já usa a cobrança precisa definir `PROCESSOVIVO_PAGAMENTO_AMBIENTE` antes
  do deploy, senão o serviço não sobe.
- Testes, `.env.example`, `DEPLOY.md` e `CLAUDE.md` atualizados.

## [0.44.0] — 2026-10-20

**Cobrança recorrente pelo Mercado Pago, parte 1: assinatura por cartão atrás de uma porta de pagamento.**
A conta assina pela tela "Minha conta", o Mercado Pago cobra o cartão a cada ciclo e o plano é liberado e
renovado sozinho — pelo MESMO caminho do `assinatura liberar` manual. Nasce **desligada**
(`PROCESSOVIVO_PAGAMENTO_HABILITADO=false`): sem rota de checkout, webhook 404, nada na tela. Pix e boleto
avulsos são a parte 2; a porta já tem o gancho (`criarCobrancaAvulsa`, opcional, sem implementação).

### O que entrou

- **Porta `GatewayDePagamento`** (`domain/ports`) e três implementações do lado de fora do domínio:
  `MercadoPagoAdapter` (REST com o `HttpClient` do projeto, **sem SDK**: a dependência inteira serviria a
  cinco chamadas), `GatewayFalso` (sem rede; só teste e desenvolvimento) e a validação do aviso. Leitura
  repete até 3 vezes; **criar e cancelar nunca repetem sozinhos**; nenhum erro carrega token, corpo do
  gateway ou dado do pagador.
- **Fluxo hospedado, sem cartão no sistema:** assinatura sem plano com pagamento pendente
  (`POST /preapproval`, `status: pending`); a conta vai à página do Mercado Pago e volta para
  `/?assinatura=retorno`. O retorno só mostra "processando": **o estado verdadeiro vem do webhook ou da
  consulta**. O e-mail vai ao gateway (que o exige) e não é gravado; o vínculo com o workspace é um
  `external_reference` aleatório de uso único.
- **Rotas:** `POST /v1/assinatura/checkout` (corpo só com o código do plano; preço e valor saem do
  servidor), `DELETE /v1/assinatura/recorrencia` (encerra a RENOVAÇÃO; o plano vale até o fim do período
  pago; evento registrado para auditoria), `GET /v1/assinatura` (agora com `pagamento`, `ciclo`,
  `valorDoCicloCentavos`, `contratavel` — aditivo) e `POST /v1/pagamentos/webhook/mercadopago` (pública).
  Conta de chave de API (sem e-mail) é recusada (`conta_sem_email`, 403).
- **Webhook:** assinatura do aviso conferida como no SDK oficial, em tempo constante (inválida = 401, nada
  gravado nem consultado). O corpo não é fonte de nada: o id serve para consultar a API. **Idempotente** por
  chave única; 200 em até 15 s. Aprovado renova; recusado avisa a conta e mantém o plano; cancelado ou
  pausado vira "sem renovação" (o plano segue); estorno e contestação **não revogam sozinhos** (registram e
  avisam o operador).
- **Reconciliação sem agendador:** `pagamento reconciliar [--workspace <id>]` (CLI) e botão no /admin.
- **/admin:** ambiente em destaque (**TESTE**), origem da assinatura (manual ou gateway), estado, id, último
  pagamento e reconciliar; o plano ganha o campo **Ciclo de renovação** (coluna nova `planos.ciclo`, padrão
  `mensal`, migração aditiva). Só `mensal` é vendável; **plano sem preço não contrata**.
- **Variáveis:** `PROCESSOVIVO_PAGAMENTO_HABILITADO`, `PROCESSOVIVO_PAGAMENTO_GATEWAY`,
  `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `PROCESSOVIVO_PAGAMENTO_PERMITIR_TESTE`,
  `PROCESSOVIVO_PAGAMENTO_AVISO_EMAIL` e `PROCESSOVIVO_TERMOS_URL`. Ligada sem credencial, **não sobe** (sem
  imprimir segredo); token de teste em produção só com `PERMITIR_TESTE=true`.
- Tabelas novas (`cobrancas_recorrentes`, `pagamentos_processados`, `eventos_de_pagamento`), só metadado.
  Nada destrutivo; `assinaturas`, `exigir()`, carência, teste de 14 dias, IA, Drive, peças e calendário não
  mudaram. `script.ts` não cresceu (tela em `ui/pagamento.ts`).

### Divergências e pontos para o primeiro teste com credenciais

A página oficial do Mercado Pago **não estava acessível** ao escrever isto (o ambiente bloqueava o domínio):
a fórmula do webhook vem do código do SDK oficial (`mercadopago/sdk-nodejs`), e o restante, do resumo da
documentação passado pelo dono. Tudo o que depende disso está num arquivo só,
`infrastructure/adapters/pagamento/mercadoPago.constantes.ts` (e no corpo de `criarAssinatura`).

| Item a confirmar no teste                                                                                        | O que assumi                                                                                                           | Onde mudar                                               |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `POST /preapproval` com `status: "pending"` devolve `init_point`, e o comprador consegue pagar só com cartão     | sim                                                                                                                    | `esquemaDaCriacao` e `STATUS_AO_CRIAR`                   |
| `end_date`                                                                                                       | omitido (assinatura sem fim)                                                                                           | corpo de `criarAssinatura`                               |
| `payer_email` precisa ser o e-mail da conta do Mercado Pago do comprador                                         | a tela avisa que pode ser diferente do e-mail do Processo Vivo                                                         | `AVISO_DA_CONTA_DO_GATEWAY` em `ui/pagamento.ts`         |
| `notification_url` existe no `POST /preapproval` (e vale para assinaturas)                                       | sim; o painel de Webhooks é a segunda via                                                                              | corpo de `criarAssinatura`; DEPLOY.md                    |
| `X-Idempotency-Key` é aceito na criação da assinatura                                                            | sim (a chave é a referência)                                                                                           | cabeçalho em `chamar`                                    |
| Cancelar e pausar: `PUT /preapproval/{id}` com `cancelled` / `paused`                                            | `cancelled` para cancelar; `paused` lido                                                                               | `STATUS_PARA_CANCELAR`, `ESTADO_DA_ASSINATURA`           |
| Nomes dos tópicos do aviso                                                                                       | `subscription_preapproval`, `subscription_authorized_payment`, `payment`                                               | `TOPICO_DO_AVISO`                                        |
| `GET /authorized_payments/{id}` traz `preapproval_id`, `status`, `payment { id, status }` e `external_reference` | sim                                                                                                                    | `esquemaDaCobranca`, `CAMINHOS.cobrancas`                |
| Busca das parcelas: `GET /authorized_payments/search?preapproval_id=` com `results[]`                            | sim                                                                                                                    | `CAMINHOS.buscaDeCobrancas`, `esquemaDaBuscaDeCobrancas` |
| Status de pagamento → resultado; estorno parcial = `approved` com `transaction_amount_refunded` > 0              | tabela em `RESULTADO_DO_PAGAMENTO`                                                                                     | `mercadoPago.constantes.ts`                              |
| `GET /v1/payments/{id}` traz `metadata.preapproval_id` e/ou `external_reference` da assinatura                   | sim (um dos dois liga o pagamento à conta)                                                                             | `esquemaDoPagamento`                                     |
| Prefixo do token de teste                                                                                        | `TEST-` (o ambiente sai dele)                                                                                          | `PREFIXO_DO_TOKEN_DE_TESTE`                              |
| `data.id` no manifesto sem converter para minúsculas; `x-request-id` presente                                    | como no SDK                                                                                                            | `validacaoDeWebhook.ts`                                  |
| Ciclo anual como `frequency: 12` + `months`                                                                      | sim (não vendável ainda)                                                                                               | `MESES_POR_CICLO`, `TIPO_DE_FREQUENCIA`                  |
| Link dos Termos                                                                                                  | **não há página de Termos no sistema**; o link sai de `PROCESSOVIVO_TERMOS_URL` (sem a variável, o texto sai sem link) | `urlDosTermos`                                           |

### Testes

`mercadopago-webhook-assinatura` (válida, ausente, malformada, adulterada, `data.id` diferente, timestamp
velho, segredo ausente), `MercadoPagoAdapter` (respostas sintéticas gravadas à mão, sem rede),
`pagamentos` (HTTP de ponta a ponta com `GatewayFalso`: checkout, aprovado = mesmo caminho do manual,
idempotência x3, fora de ordem, recusa, cancelamento, pausa, estorno, isolamento, reconciliação),
`admin-pagamento`, `config-pagamento` (fail-closed), `ciclo-do-plano` (inclui migração), repositório,
CLI, invariantes da tela e o teste de navegador (Assinar com e sem preço, processando, cancelar, axe nos
dois temas, seis larguras). Fixtures sintéticas: nenhum token, segredo, e-mail ou id de pagamento real.

---

## [0.43.0] — 2026-10-16

**Atualizações: a coluna Situação mostra o estado como TEXTO e a caixa "Cumprido" é o único controle.**
Mudança de apresentação e de controle; a detecção de "pede providência", as regras de "cumprido", as
rotas e os contadores não mudam.

### O que mudou na tela

- **Estado como texto**, sem fundo, sem borda e sem hover de clique: "● Pede providência" (âmbar),
  "✓ Cumprido" (verde discreto) e "—" (sem providência). Ícone e texto andam sempre juntos, então a
  informação não depende de cor; os tons de texto (`--atencao`, `--verde-tinta`) passam de 4,5:1 nos
  temas claro e escuro (axe, nos dois). A linha cumprida fica um pouco mais apagada (só o título perde
  o peso; nada some e o contraste não cai).
- **Caixa "Cumprido"** (`<input type="checkbox">` real, rótulo visível, alvo de 32 px no desktop e 44 px
  no empilhado, foco visível, Espaço, nome acessível "Cumprido: processo …"). Só existe onde há o que
  marcar (pede providência, com o ato que a tela mostrou) ou desmarcar (cumprido). Substitui o botão
  "Marcar como cumprido" e a confirmação "Sim, desfazer": **desmarcar a caixa é o desfazer**.
- **Atualização otimista**: a linha muda na hora; se o servidor falhar, volta ao que estava e a tela diz
  "Não foi possível salvar. Tente de novo." (no 409 — o ato saiu do retrato — a explicação do servidor
  vem junto, porque "tente de novo" sozinho não resolveria). Lista, contadores e filtros se refazem
  quando o servidor responde, como antes.
- **Aviso "Marcado como cumprido. Desfazer"** por 6 s, em `role="status"`, fora da tabela, sem prender o
  foco (Esc fecha; se o foco estava nele, vai para a caixa). "Desfazer" faz a mesma chamada de desmarcar.
- Larguras da tabela: Situação 11% (era 9%), Partes 9,5% e Atualização 18,5%, para "Cumprido" não quebrar no
  meio da palavra; o conteúdo da célula de Situação ficou ~30% mais baixo (142 → ~98 px numa linha com "Não lida", medido em 1366 px; sem "Não lida", ~80 px).

### O que NÃO mudou

Servidor, `GET /v1/novidades`, `/v1/painel`, calendário, rotas `POST`/`DELETE …/cumprido` (as mesmas
duas chamadas, com as mesmas regras), "Analisar com IA" e seu painel, busca, filtros, tela do processo.
Sem migração. `script.ts` não cresceu: o código novo está em `providencia.ts` (HTML do estado e da
caixa, e as chamadas), `atualizacoes.ts` (comportamento) e `tabelaAtualizacoes.ts` (`situacaoDaLinha`,
pura).

### Testes

`tests/http/providencia-componente.spec.ts` (novo: HTML de cada estado e as chamadas ao servidor),
`situacaoDaLinha` em `tabela-atualizacoes.spec.ts`, e o teste de navegador de "cumprido" reescrito
(mouse, teclado, otimista, falha, aviso e relógio falso, seis larguras, axe nos dois temas). Dois
casos de `atualizacoes-navegador.spec.ts` só trocaram o seletor do selo antigo pelo estado em texto.
Fixtures sintéticas.

---

## [0.42.2] — 2026-10-16

**Testes estáveis no CI e a volta do Google sem corrida.** Só correção; nenhuma regra de produto muda.

### Testes do CLI (`--workspace`)

O CLI ganhou `executar(argv, ambiente)` (o mesmo código, chamável em processo; o arquivo só roda como
programa quando é o ponto de entrada) e os testes o chamam direto: um `tsx` filho por chamada gastava
~1 s e estourava o timeout de 5 s no CI. Resta um único teste que sobe o processo de verdade, e o
timeout folgado (30 s) vale só para esse arquivo.

### Corrigido: a volta do Google podia não mostrar a mensagem (corrida no console, existia desde a 0.42.0)

Ao abrir `/?drive=ok`, o console desenha a aba inicial ("Últimas atualizações") e logo vai para
"Meus acessos". A resposta de `/v1/novidades`, se chegasse depois, repintava a aba antiga POR CIMA
do cartão do Drive: a pessoa voltava do Google e não via "conectado" (ou "cancelada"). Medido: o teste
de navegador falhava em ~1 de cada 3 execuções sob carga de CPU, também na 0.42.0. Agora a resposta
tardia confere se a aba ainda é a dela antes de pintar (`script.ts`, sem crescer), o cartão do Drive
não aparece em dobro quando a aba é desenhada duas vezes, e a mensagem do retorno vive até a primeira
ação da pessoa no cartão, em vez de sumir no primeiro desenho.

---

## [0.42.1] — 2026-10-16

**Google Drive: a conexão agora se completa também para conta de chave de API.** O retorno do
Google (`GET /v1/drive/retorno`) é uma navegação do navegador, sem JavaScript: não leva `x-api-key`
e a conta de chave não tem cookie de sessão. A rota exigia autenticação e usava o workspace do
cookie, então essa conta nunca concluía a conexão (o navegador recebia 401 ao voltar do Google).

### Corrigido

- **O dono da conexão vem do `state` assinado**, não do cookie. O `state` (HMAC, uso único, 10 min)
  já levava o workspace dentro da parte assinada; agora o retorno lê dali. A rota passou a ser
  pública para o plugin de autenticação (`ROTA_DRIVE_RETORNO`) — quem manda é o `state`.
- **Cookie de outro workspace + `state` válido é recusado** (`?drive=erro&motivo=estado_invalido`),
  nada é gravado e o `state` não é gasto: quem começou a conexão ainda a conclui.
- Mantido: assinatura, validade de 10 min, uso único (gasto também em erro), PKCE (o verificador
  fica no servidor), escopo `drive.file`, sentido único, sigilo fora, só por clique, tokens no
  cofre, `PROCESSOVIVO_DRIVE_HABILITADO`. `POST /v1/drive/conexao`, `DELETE /v1/drive`, o envio e
  o status continuam exigindo cookie ou chave e conferindo o plano. Nada de `state`, código ou
  token vai a log; a chave de API continua só em chamada de JavaScript, nunca em URL.
- O indicador de resultado segue `?drive=ok` / `?drive=erro&motivo=…`, e a tela já o trata sem
  cookie: lê o parâmetro, limpa a URL e consulta `GET /v1/drive` com a chave do `localStorage`.

### Sem mudança de regra de plano

Conta de chave continua precisando de uma assinatura de plano Peças ou IA para o workspace dela
(`temRecursoSemExcecao`, sem a exceção do "workspace sem assinatura passa livre"). Não há exceção
por tipo de autenticação.

### Assinatura de uma conta de chave de API: `--workspace <id>`

Chave de API não tem e-mail, e todo comando de liberação achava a conta por e-mail: não havia como
dar o plano Peças/IA (e, com ele, o Drive) a uma conta de chave. Agora:

- **CLI:** `assinatura liberar --workspace <id> <plano> <meses>` e `assinatura ver --workspace <id>`.
  E-mail e `--workspace` juntos, ou nenhum dos dois, é erro claro e não grava nada.
- **Admin:** `GET /admin/api/workspaces/:workspace/assinatura` e
  `POST /admin/api/workspaces/:workspace/assinatura/liberar`, e o campo **Workspace** em
  `/admin` → Assinaturas. A aba **Chaves de API** passou a mostrar a coluna **Workspace**.
- **O id é conferido** (`LocalizadorDeWorkspace`): 16 hex (chave) ou 32 hex (conta) e tem de ser de
  uma conta, de uma chave emitida e não revogada ou de uma chave do `.env`. Malformado = 400,
  inexistente = 404 (`WORKSPACE_INVALIDO`, sem repetir o valor digitado); nada é gravado.
- **Nenhuma regra de plano mudou.** É a mesma `liberar`/`resumo`, só com outro identificador. Plano
  Peças/IA inclui todos os recursos que existem hoje; o plano Acompanhamento continua sem o Drive.
- **Atenção:** a assinatura de uma chave vence como qualquer outra. Passada a carência, o
  workspace é barrado em tudo (402) e não sai aviso (não há e-mail). O comando avisa disso.

### Projeto

- `npm run check` agora inclui `npm run build` (o build de produção não tem a lib DOM e já falhou
  separado do typecheck).
- `DEPLOY.md`: o backup em produção é `node dist/main/cli.js backup` (a imagem não tem `tsx`).

### Testes

State com workspace conecta sem cookie nem chave; state reutilizado, adulterado e inventado
recusados; cookie de outro workspace recusado; fluxo completo da conta de chave (iniciar, retorno,
"conectado", desconectar); regressão da conta com cookie. Liberar e ver por workspace (CLI de verdade
com banco temporário e rota admin), os dois identificadores, nenhum, id malformado, inexistente e de
chave revogada, `salvarNoDrive` só depois da liberação, e a liberação por e-mail como antes.

---

## [0.42.0] — 2026-10-16

**Salvar as peças no Google Drive do advogado.** Na Pasta digital, o botão **"Salvar no Drive"**
grava as peças numa pasta **"Processo Vivo"** do Drive dele, com uma subpasta por processo (o nome é
o número). O advogado conecta a conta uma vez, em "Meus acessos". **Nasce desligado**
(`PROCESSOVIVO_DRIVE_HABILITADO=false`): o dono liga quando o Google estiver configurado (passo a
passo no `DEPLOY.md`). Nenhum dado real, token ou segredo entra no repositório, nos logs ou aqui.

### As regras (decisões do dono)

- **Escopo único: `drive.file`.** O sistema só enxerga a pasta e os arquivos que ele mesmo criou.
  Não há variável para pedir mais, e há teste que falha se outro escopo aparecer no código.
- **Sentido único.** O sistema grava. Não lista o Drive, não procura pasta pelo nome, não lê de
  volta, não apaga, não renomeia, não compartilha. A única leitura é "o que EU criei ainda existe?".
- **Sigilo fica fora.** Peça com `nivelSigilo > 0` e processo em segredo de justiça não vão para o
  Drive (zero chamadas), como na Pasta digital. O resultado diz quantas ficaram de fora.
- **Só por botão.** Nenhum envio automático. Sem o recurso no plano, ou com o recurso desligado,
  nenhuma chamada ao Google.
- **Planos Peças e IA** (recurso novo `salvarNoDrive`; retrocarga única nos dois planos já
  gravados). O plano IA continua fora de venda: `analiseIa` segue `implementado: false`.

### Adicionado

- **Conexão OAuth 2.0** (código de autorização, no servidor): `state` assinado, de uso único,
  10 minutos, amarrado ao workspace; PKCE (S256); `access_type=offline` + `prompt=consent`. O
  retorno (`GET /v1/drive/retorno`) nunca mostra token, nunca o põe em URL e redireciona para a tela
  com mensagem curta. Sem a permissão da pasta (consentimento granular) a conexão é recusada.
- **Tokens no cofre** AES-256-GCM existente, por workspace; renovação sob demanda, uma por vez.
- **Envio em segundo plano**, uma peça por vez, com progresso, cancelamento, um envio por conta e
  teto global (`PROCESSOVIVO_DRIVE_MAX_SIMULTANEOS`, padrão 2). Backoff limitado em 429/5xx,
  respeitando `Retry-After` (até 60 s). Upload simples até 5 MiB; resumível em pedaços de 8 MiB.
- **Idempotência** por (workspace, processo, peça), com hash: não duplica; conteúdo novo atualiza o
  mesmo arquivo; arquivo apagado pelo advogado conta como "removida no Drive" e só é reenviado por
  clique. Pasta raiz ou do processo apagada é recriada uma vez, com aviso.
- **Nome do arquivo:** `NNNN - Rótulo - dd-mm-aaaa.pdf` (número do ato como a Pasta o mostra; peça
  convertida leva o marcador de conversão; nomes iguais ganham `(2)`).
- **Rotas:** `GET /v1/drive`, `POST /v1/drive/conexao`, `GET /v1/drive/retorno`, `DELETE /v1/drive`,
  `POST /v1/processos/:numero/pasta/drive`, `GET` e `DELETE /v1/drive/jobs/:id`. Nenhuma aceita
  texto, nome de arquivo ou conteúdo do cliente: só chaves de peças da pasta daquele workspace.
- **Tela** (`ui/drive.ts`): cartão "Google Drive" em "Meus acessos" (desconectado, conectado,
  precisa reconectar, sem plano; nada com o recurso desligado) e botão na Pasta digital, com
  progresso, Cancelar, `aria-live` discreto e resumo ("12 enviadas · 3 já estavam · 2 sigilosas
  ficaram de fora · 1 falhou"). `script.ts` não cresceu.
- **Configuração:** `PROCESSOVIVO_DRIVE_HABILITADO`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `PROCESSOVIVO_DRIVE_MAX_SIMULTANEOS`, `PROCESSOVIVO_DRIVE_PAUSA_ENTRE_PECAS_MS`. Ligado, o
  arranque exige as chaves (barradas se parecerem exemplo), `PROCESSOVIVO_URL_BASE` em https e o
  cofre — e diz qual falta, sem mostrar valor. O endereço de retorno é
  `PROCESSOVIVO_URL_BASE` + `/v1/drive/retorno`.
- Três tabelas aditivas: `conexoes_drive`, `pastas_no_drive`, `pecas_no_drive`.
- `docs/drive-pecas-especificacao-v1.0.0.md`.

### Alterado

- `HttpClient.requisitar`: requisição genérica com cabeçalhos na resposta (o Drive precisa de
  `Location` e `Retry-After`). Sem dependência nova (nada de `googleapis`).
- `ServicoPasta.estadoDaPeca`: o estado de uma peça, sem montar a lista toda.
- `tests/domain/Assinatura.spec.ts`: a lista de recursos ganhou `salvarNoDrive` (o teste existe
  para fixar essa lista e pedir a pergunta "os planos já gravados recebem?", respondida em
  `banco.ts`). Os testes que travam a venda do plano IA continuam como estavam.

### Decisões que divergem do que se esperava (e por quê)

- O job do envio é **em memória**, e não na `FilaDeJobs`: aquela fila é do leitor (grava índice e
  páginas de PDF) e não serve a um envio por peça. Redeploy o perde; clicar de novo continua de
  onde parou, porque a idempotência faz as peças já enviadas virarem "já estavam".
- A rota por processo é `POST /v1/processos/:numero/pasta/drive`, na convenção das demais rotas da
  Pasta (`/v1/processos/:numero/pasta/…`).
- Conta **sem assinatura** (chave de API) não usa o Drive — como a análise por IA: o Drive usa a
  conta Google da pessoa, e chave de API não tem conta.

---

## [0.41.1] — 2026-10-15

Tela do processo mais limpa (decisão do dono). Os blocos **"Pede providência (últimos
N dias)"** e **"Última movimentação"** repetiam o cabeçalho do tribunal e não tinham uso
prático — para entender um ato, o advogado estuda o processo na Pasta digital. Só a
**apresentação** na tela de detalhe saiu. A ordem agora é: cabeçalho do processo → Peças do
processo → **Partes** → Linha do tempo.

### Removido

- Da tela do processo (`processoHtml`, em `ui/script.ts`): o cartão "Pede providência",
  a linha "N ato(s) anterior(es) que pedem providência…", o aviso "Marcado por leitura
  automática…", a variante "Nenhum ato dos últimos N dias…" e o bloco "Última
  movimentação" (com o aviso de teor indisponível dele). Saíram junto as variáveis que só
  eles liam e o CSS `.agora`. `script.ts` encolheu.

### Alterado

- "Partes" sobe para logo abaixo do card "Peças do processo". Conteúdo e visual iguais.
- Resumo por IA: duas frases do painel citavam o bloco "Pede providência" ("Confira o bloco…" e "É outra coisa que o bloco…"); agora apontam para a linha do tempo e para a marcação "providência" do sistema. O painel continua logo após a capa e não dependia dos blocos removidos. A busca por número, só da aba Atualizações, também não.

### Não mudou (de propósito)

- A detecção de "pede providência", `GET /v1/novidades`, `/v1/painel`, o filtro Situação,
  o selo e a linha de providência na aba Atualizações, as contagens, o "Marcar como
  cumprido", o calendário. A linha do tempo continua marcando o ato (selo "providência" e
  chip de filtro). Nenhuma rota, esquema ou migração; o servidor continua entregando
  `pendenciaJanelaDias` em `/v1/facetas`, agora lido só pela aba Atualizações.

### Testes

- Novo `tests/browser/detalhe-limpo-navegador.spec.ts` (Chromium): sem os blocos, ordem
  Peças → Partes → Linha do tempo, sem vão, regressão do selo/filtro/contagem na aba
  Atualizações para o mesmo processo, sem rolagem horizontal em 1920/1366/1280/1024/768/390
  e axe nos temas claro e escuro.
- `atualizacoes-tela.spec.ts` e `vigilancia-http.spec.ts`: ajustados só onde afirmavam a
  presença dos blocos antigos.

---

## [0.41.0] — 2026-10-14

**Atualizações: busca pelo número do processo.** Advogado com muitos processos acompanhados vai direto a um
número. Só a aba Atualizações; nenhuma consulta ao tribunal, nada de prazo.

### Adicionado

- Campo "Número do processo" no bloco de filtros, antes de Período: `type="search"`, `inputmode="numeric"`,
  rótulo visível. Compara só dígitos e casa por trecho (começo, meio ou fim); colar o número formatado funciona.
  Filtra enquanto digita, com espera de 200 ms; "Limpar" (visível com termo) e Esc limpam; mudar o termo volta à
  página 1. Termo com menos de 4 dígitos não filtra e não avisa. O termo vive na página, nunca em
  `localStorage`: recarregar zera.
- A busca combina com Situação (inclusive "cumpridos" e "outros"), Período, Tribunal e ordenação, e **diz quantos
  casam fora deles**, uma frase por motivo, só quando o número é maior que zero, cada uma com "Ver" que mantém a
  busca: "N processos com esse número em outra situação" (Situação = Todas), "N fora dos últimos X dias" (Período
  = Todas; X vem do servidor) e "N em outro tribunal" (Todos os tribunais). Processo fora por mais de um motivo
  conta uma vez, no primeiro da ordem Situação, Período, Tribunal. Sem resultado nos filtros mas com casamento
  fora, as frases ocupam o lugar do vazio (nunca "Nenhum processo"); sem casamento em lugar nenhum: "Nenhum
  processo acompanhado com esse número.", sem "Ver".
- A contagem ("N processos encontrados") vai à região `aria-live` da aba, só depois da espera.
- `GET /v1/novidades` ganhou `numerosForaDaJanela` e `numerosEmOutroTribunal`: só os NÚMEROS dos processos que o
  Período ou o Tribunal deixaram fora, da própria conta; vazios sem filtro, com `naoVistas` ou `numero`.
  Opcionais para quem lê: servidor antigo sem eles = a tela não conta o que está fora do período ou do tribunal.
- `filtrarPorNumero` e `contarForaDosFiltros` em `ui/tabelaAtualizacoes.ts` (puras, injetadas por `toString()`).

### Não faz

- Buscar parte, classe, tribunal ou texto do ato; buscar dentro das atualizações anteriores de um processo;
  guardar a busca entre recarregamentos; busca em outras abas; destaque do trecho casado (opcional, não feito).

## [0.40.1] — 2026-10-12

**IA como secretária, Etapa 2 (tela): "Resumir este processo com IA" na capa do processo.** Só a interface,
sobre as rotas da 0.40.0; nada mudou no servidor, na ZDR, na lista de provedores nem na conferência do par.

### Adicionado

- Botão "Resumir este processo com IA" ao lado de "Deixar de acompanhar", só para processo acompanhado e só
  com a IA disponível para a página (a rota de disponibilidade da análise de ato). Arquivo novo
  `ui/resumoIA.ts`; `script.ts` ganhou só dois ganchos e não cresceu.
- Painel sob a capa com os estados: resumindo (com Cancelar e o aviso de até 2 minutos), resultado, não
  verificado ("Não foi possível resumir com segurança. Leia os atos."), erro genérico, sem plano, limite de
  uso, segredo de justiça, sem texto utilizável e processo não acompanhado.
- Resultado: situação e pendências segundo a IA (blocos do resumo, separados do "Pede providência" do
  sistema, que não muda), cada item com o ato de origem (data, rótulo e tipo do retrato), o trecho citado e
  um link que leva ao andamento na linha do tempo; a contagem de atos que o sistema marca como pedem
  providência e a IA não citou; os atos que ficaram de fora; os itens descartados na verificação (só a
  contagem); pontos de atenção; rodapé "Gerado por IA em DATA E HORA. Confira nos atos." sem o nome do
  modelo; aviso fixo de apoio à leitura; avaliação Útil, Errado e Perigoso.
- Testes de navegador (`tests/browser/resumo-ia-navegador.spec.ts`) com dados sintéticos para cada estado,
  o redesenho da tela com o resumo em curso, teclado, foco, larguras de 390 a 1920 px e axe nos dois temas.

### Corrigido

- Painel de prazo da análise (pendente da 0.39.0): nenhuma opção de dias úteis ou corridos vem
  pré-marcada e o botão "Calcular" só ativa depois da escolha.

### Não faz

- Não reabre resumo anterior (o estado vive só na página, enquanto a pessoa fica no processo), não cria
  aviso nem evento e não altera providências, "não lida", ordem, contagens ou calendário.

---

## [0.40.0] — 2026-10-12

**IA como secretária, Etapa 2 (só o servidor): resumo do processo por IA.** Rota
`POST /v1/acompanhamentos/:numero/resumo`, por clique, sobre os atos do retrato da própria conta. A tela e o
botão ficam para a 0.40.1.

### Adicionado

- `ServicoResumoDoProcesso` e a porta `ResumidorDeProcesso`. Plano IA sem exceção (a mesma regra da análise),
  segredo de justiça e processo sem texto utilizável recusados antes de qualquer chamada ao modelo.
- `selecionarAtosParaResumo`: providências em aberto, atos recentes com texto, linha do tempo de títulos e a
  contagem do que ficou de fora. Orçamento estimado (teto de 28.000 caracteres), ainda sem os números reais de
  preço e contexto do modelo.
- Prompt `resumo-1.0.0`, UM redator para o pedido inteiro e esquema Zod fechado.
- `verificarResumo` (regras 1.0.0), item a item: identificador, trecho no ato citado, números e datas,
  cópia do trecho e expressão proibida.
- `contagens.providenciasDoSistema` e `providenciasNaoCitadas`: o resumo da IA e o "Pede providência" do
  sistema ficam separados, e a resposta diz quantas providências do sistema a IA não citou.
- `atosQuePedemProvidencia` (lista completa, mesma regra de `lerProvidencia`).
- Tabela `resumos_ia` (aditiva) e `POST /v1/resumos/:id/avaliacao` (Útil, Errado, Perigoso).
- Variáveis `PROCESSOVIVO_IA_RESUMO_MAX_POR_HORA` (6), `PROCESSOVIVO_IA_RESUMO_MAX_TOKENS` (1500) e
  `PROCESSOVIVO_IA_RESUMO_TIMEOUT_MS` (120000).
- `ia-avaliacoes` lê `analises_ia` e `resumos_ia` em seções separadas.

### Alterado

- Peça comum `ModeloComZdr` extraída do adaptador do analisador, sem mudar comportamento: ZDR, lista de
  provedores e conferência do par modelo + provedor são as mesmas para os dois usos.

---

## [0.39.0] — 2026-10-12

**IA como secretária, Etapa 1: do prazo escrito no ato ao aviso no calendário.** Na análise de um ato do
Diário que escreve um prazo em dias, o advogado clica em "Criar aviso no calendário", confere a data
calculada e as premissas, e só o clique em "Confirmar aviso" cria o evento. **Exceção registrada** à regra
"o calendário não calcula prazo" (decisão do dono): a calculadora só roda depois do clique, só para ato do
Diário, e a data sai sempre como "a conferir".

### Adicionado

- Campo opcional `prazo` na análise: `{ dias (1–365), tipo (uteis | corridos | null) }`, extraído do ato.
  Prompt `ato-1.2.0` e instrução de formato em texto. A IA nunca escreve data. `verificarAnalise` (regras
  1.2.0) descarta só o prazo cujo número não está escrito no texto enviado (dígitos ou por extenso, colado a
  "dia(s)"), fora de 1–365 ou com tipo desconhecido; a análise segue.
- `prazoEmDias.ts`: sábado e domingo, feriados nacionais fixos, Sexta-feira Santa (Páscoa calculada), recesso
  de 20/12 a 20/01; publicação no primeiro dia útil depois da disponibilização e contagem a partir do
  primeiro dia útil depois da publicação. Devolve as premissas em frases curtas e o aviso "Feriado local e
  suspensões não considerados".
- Rotas `POST /v1/analises/:id/aviso/previa` (não grava nada) e `POST /v1/analises/:id/aviso` (recalcula e
  cria o evento `prazo`, dia inteiro, `origem: manual`). Ambas exigem `analiseIa` e `calendario` e não
  chamam o modelo. Ato fora do Diário não calcula (`PrazoNaoCalculavelError`, 422); ato que não diz úteis
  ou corridos pede a escolha, sem tipo padrão.
- Evento com marcador `calculado` (coluna aditiva `eventos_calendario.calculado`): o feed passa a dizer
  "Data calculada pelo Processo Vivo: confira no processo." Editar a data apaga o marcador.
- Tela: bloco "Prazo escrito no ato" na análise, com a prévia (data, premissas, aviso, data editável) e a
  confirmação.

### Privacidade

O título do evento sai só de campos estruturados ("Prazo de 15 dias úteis (a conferir)"): sem texto da IA e
sem nome de parte. O feed continua levando só tipo e número do processo (ou "sigiloso").

### Não muda

ZDR, lista de provedores, conferência do par modelo + provedor e redação. Nada é criado sem confirmação.
Fora do escopo: feriado estadual, municipal e do tribunal, suspensões, prazo em dobro, juizados.

---

## [0.38.5] — 2026-10-11

**Ações possíveis da análise por IA deixam de repetir o ato, e a tela deixa de mostrar o modelo.** Em duas
análises reais o campo veio com defeito: ação mal escrita (dizia "pela parte passada" em vez de quem cumpre)
com segunda ação copiada do ato, e ação que repetia o trecho-chave quase literalmente.

### Alterado

- `acoes_possiveis` vira `{ acao }` (sem `trecho`): providência em linguagem de advogado, infinitivo ou
  imperativo curto, dizendo quem faz o quê; nunca cópia ou paráfrase do `trecho_chave`; lista vazia se o ato não
  indicar providência clara. Prompt `ato-1.1.0` e instrução de formato em texto atualizados.
- `verificarAnalise` (regras 1.1.0): ação com mais de 60% das palavras de conteúdo em comum com o
  `trecho_chave` torna o resultado "não verificado" (`acao_copiada_do_trecho`), sem texto no log. A ação não é
  mais citação (só o `trecho_chave`); número fora do texto e expressão proibida seguem como antes.
- Tela: a ação aparece sem bloco de citação; o `trecho_chave` aparece uma só vez; lista vazia mostra
  "Sem providência indicada no ato."; o rodapé e o selo dizem "Gerado por IA em DATA E HORA. Confira no ato." sem o
  nome do modelo (que segue em `analises_ia`, na API e em `ia-avaliacoes.mjs`).

### Não muda

- ZDR, `data_collection`, `allow_fallbacks`, `only`, conferência do par modelo + provedor, rodízio da 0.38.3 e
  formato em texto da 0.38.4. Análises já gravadas continuam legíveis (o `trecho` antigo da ação não sai na API).

---

## [0.38.4] — 2026-10-11

**A análise por IA deixa de depender de saída estruturada do provedor.** Em produção a 0.38.3 falhava em
~2,6 s com `SemProvedorQueAtendaError` (404, passo "Filter by Parameters"; funil: 16 endpoints iniciais,
1 após "Filter by Allowed Providers", 0 depois): o único endpoint ZDR do modelo não declara suporte ao
`response_format` `json_schema` estrito que a chamada exigia com `require_parameters`.

### Alterado

- A chamada normal (`TransporteOpenRouter.gerar`) usa o formato do degrau C: **sem `require_parameters` e
  sem `response_format`**; a instrução de formato vai no texto do sistema, o JSON é extraído por
  `jsonDoTexto` (cerca de código é tolerada) e validado pelo Zod `.strict()` do analisador.
- Resposta fora do formato (inclusive com chaves antes do JSON) falha de forma segura:
  `RespostaInvalidaError`, sem repetir, sem texto da resposta no erro nem no log.
- Diagnóstico em degraus da sonda: o A (esquema estrito) passa a ser só termo de comparação; o C é a
  chamada de produção. Descrições na sonda e na nota 2.1 atualizadas.

### Não muda

- `zdr: true`, `data_collection: deny`, `allow_fallbacks: false` e `provider.only` com a lista permitida
  em TODA chamada; a conferência do par modelo + provedor da resposta; `verificarAnalise` (citação,
  número inventado, expressões proibidas); o rodízio por provedor da 0.38.3 (que se desliga sozinho com
  um provedor só). Sem "escada" de tentativa com esquema estrito.

---

## [0.38.3] — 2026-10-11

**A análise por IA sobrevive ao limite de taxa de UM provedor.** Em produção a chamada recebia 429 do
DeepInfra em ~285 ms, três vezes seguidas, e falhava: as três tentativas levavam o mesmo `only`, e
com `allow_fallbacks: false` o OpenRouter não troca de provedor.

### Alterado

- Depois de um **429 ou 5xx**, cada nova tentativa usa `provider.only` com **UM** provedor da lista
  permitida, **em ordem**, sem repetir; a 1ª tentativa continua com **todos** os permitidos. Não
  depende de o corpo do erro informar quem limitou. Esgotada a lista (1 + N tentativas), a chamada
  falha com o log de roteamento da 0.38.2 (status, passo, funil — sem texto).
- Esperas: as atuais (1 s e 3 s); da 3ª repetição em diante repete-se a última (3 s).
- Outros erros não rodam a lista: 401/402/403/400/404 não repetem; falha de rede repete com os mesmos
  permitidos; com um provedor só, repete como antes.

### Não muda

- `allow_fallbacks` continua **false**; `zdr: true`, `data_collection: deny`, `require_parameters` e
  a lista `only` (nunca um provedor fora dela) em TODA tentativa; a conferência do par modelo +
  provedor da resposta contra a lista ZDR e o conjunto permitido; a lista ZDR; nenhuma chamada sem ZDR.

### Testes

- 429 leva a 2ª chamada com um provedor da lista; ordem sem repetição; nenhuma chamada fora da lista;
  esgotar a lista falha (1 + 4 chamadas) sem texto no erro nem no roteamento; `zdr`, `data_collection`
  e `allow_fallbacks: false` em toda tentativa; 401 não roda a lista; rede repete com os mesmos
  permitidos; um provedor só repete como antes.

---

## [0.38.2] — 2026-10-11

**O log da análise por IA passa a dizer ONDE a chamada parou.** A linha "análise do ato não concluída"
só trazia a classe do erro; uma indisponibilidade (`PROVIDER_INDISPONIVEL`) não distinguia 429 de 5xx,
400, 401 ou 402, nem dizia qual filtro do roteamento esvaziou os provedores.

### Adicionado

- `ProviderIndisponivelError.roteamento` (opcional): `status` HTTP, `passo` (`failed_routing_step`) e
  `funil` (`routing_funnel`) devolvidos pelo OpenRouter, já saneados. Preenchido em `traduzirErro`
  (`TransporteOpenRouter`) para todo erro HTTP, inclusive `ZdrIndisponivelError` e
  `SemProvedorQueAtendaError`.
- Na linha "análise do ato não concluída": `statusHttp`, `passoDoRoteamento` e `funilDoRoteamento`
  (texto JSON truncado em 600 caracteres). Campos ausentes não aparecem.

### Não muda

- **Nunca** vão ao log texto do ato, chave, corpo cru do erro, mensagem do SDK nem dado do processo
  (o funil passa por `sanearCorpoEnviado`: string longa vira marcador, campo com nome de segredo vira
  `[omitido]`). A lista de provedores, `provider.only`, `require_parameters` e a ZDR ficam como estavam;
  nenhuma repetição nova.

### Testes

- 429 esgotado leva só o status; 404 com passo e funil leva os três; funil saneado; o log traz os três
  campos, truncado, sem texto, parte nem número do processo; erro sem roteamento não ganha campos vazios.

---

## [0.38.1] — 2026-10-11

**Exceção de teste fechado da análise por IA, ligada por variável — a remover antes de abrir ao
público.** Uma integração que entra por chave de API (sem conta e sem e-mail) não é alcançável pelo
`/admin` nem pelo CLI de assinaturas, que só aceitam e-mail. Em vez de gravar assinatura (que traria
vencimento e, depois da carência, 402 nas peças, Pasta, leitor e calendário dessa integração), a
liberação vira configuração.

### Adicionado

- `PROCESSOVIVO_IA_WORKSPACES_LIBERADOS`: lista, separada por vírgula, de ids de workspace (16
  hexadecimais). Workspace da lista passa na checagem do plano IA **sem assinatura, só para
  `analiseIa`**. Vazia (padrão) = comportamento de sempre.
- **Nada mais muda:** peças, Pasta, leitor e calendário seguem como estavam; nenhuma linha é criada
  em `assinaturas`; continua exigindo `PROCESSOVIVO_IA_HABILITADA=true` e todas as outras travas
  (ZDR, redação, verificação, limite de uso, segredo de justiça). Quem não está na lista e não tem
  o plano continua vendo "A análise por IA faz parte do plano IA…".
- Validação no arranque (mesmo com a IA desligada): item fora do formato derruba o arranque com a
  **posição** do item — o valor não é repetido, porque pode ser uma chave de API colada por engano.
- Log e tela só mostram o id **mascarado** (`1ed3…1867`). Com a lista ligada o arranque registra um
  aviso lembrando de removê-la.

### Não muda

- A venda do plano IA continua travada (`analiseIa` segue `implementado: false`).

### Testes

- Listado e sem assinatura chama o adaptador dublado; não listado e sem assinatura não chama; lista
  vazia mantém o comportamento atual; id inválido derruba o arranque (e a mensagem não traz o valor);
  nenhuma linha em `assinaturas`; o log nunca traz o id completo.

---

## [0.38.0] — 2026-10-11

**Analisar com IA** (beta fechado). Um botão na tabela de Atualizações manda **um ato** a um modelo
de linguagem e devolve um resumo curto, o que ele parece pedir e as citações do próprio texto do
ato. É apoio à leitura: **não altera** "pede providência", "não lida", ordem, contagens, painel nem
calendário, e **não calcula prazo**. Nasce **desligada** (`PROCESSOVIVO_IA_HABILITADA=false`); sem a
variável nada muda para ninguém. Etapa 2 enxuta: o desenho original (cota mensal, cache, escolha de
modelo) foi cortado — ver o Errata v1.1.0 da especificação.

### Adicionado

- **Análise de um ato por IA**, só com o **texto que o sistema já tem** (nada de peça nem de PDF), **redigido** antes de sair
  (nomes, documentos, contatos, OAB e número de processo viram marcadores) e **verificado** depois (a citação precisa existir no
  texto enviado; número inventado ou expressão proibida descarta o resultado). O ato é resolvido **no servidor**, no retrato da conta,
  pela chave dele: o pedido carrega só a chave e texto vindo do cliente nunca é aceito. Processo em segredo de justiça, ato sem texto
  suficiente e teor que o tribunal avisou não ser público **não chamam o modelo** (testado: zero chamadas).
- **Retenção zero de dados (ZDR) falhando fechado, sem chave de desligar**: toda chamada leva `zdr: true`, `data_collection: deny`,
  `allow_fallbacks: false` e `provider.only` com os provedores ZDR do modelo, segundo a lista do OpenRouter (guardada 24 h em memória).
  Lista inalcançável/vazia = nenhuma chamada; resposta de provedor fora do conjunto permitido é descartada e o log leva só nomes.
  `PROCESSOVIVO_IA_PROVEDORES_PERMITIDOS` (opcional) só restringe (interseção com a lista ZDR).
- **Plano IA obrigatório, sem exceção** — inclusive para chave de API/conta sem assinatura, que nas demais funções passam livre. Sem
  o plano: nenhuma chamada e a frase fixa "A análise por IA faz parte do plano IA. Faça upgrade do plano para usar." A venda do plano IA
  **continua travada** (`analiseIa` segue `implementado: false`); contas entram por liberação manual (`/admin` → Liberar / renovar, ou
  `assinatura liberar <e-mail> ia <meses>`).
- **Rotas** `GET /v1/analises/disponibilidade`, `POST /v1/acompanhamentos/:numero/analise` e `POST /v1/analises/:id/avaliacao`
  (Útil / Errado / Perigoso, sem texto livre, só o dono, pode corrigir). Cancelar a requisição aborta a chamada ao modelo.
- **Tela** (`ui/analiseIA.ts`; `script.ts` não cresceu): botão "Analisar com IA" na coluna Ações, painel abaixo da linha com foco, Esc,
  `aria-expanded`, estados (analisando com Cancelar, resultado com citações destacadas, não verificado, erro, texto insuficiente, texto
  indisponível, segredo de justiça, sem plano, limite de uso), selo "IA" com a procedência e o aviso fixo. Com a IA desligada não há botão.
- **Tabela `analises_ia`** (aditiva): resultado **com marcadores**, modelo, versão do prompt, provedor, tokens, custo, latência e avaliação.
  Nunca o texto do ato nem os valores originais.
- **Freio de uso em memória**: limite por hora por conta, uma análise em andamento por conta e teto global baixo. Reiniciar zera.
- **`scripts/ia-avaliacoes.mjs` v1.0.0** (somente leitura, sem texto): por modelo e versão do prompt, análises, avaliações, taxa de "não
  verificado", latência p50/p95 e custo médio.
- **Configuração** validada no arranque: `PROCESSOVIVO_IA_HABILITADA`, `PROCESSOVIVO_IA_MODELO` (padrão `deepseek/deepseek-v4-flash`),
  `PROCESSOVIVO_IA_RACIOCINIO` (padrão `desligado`), `PROCESSOVIVO_IA_MAX_TOKENS`, `PROCESSOVIVO_IA_TIMEOUT_MS`,
  `PROCESSOVIVO_IA_PROVEDORES_PERMITIDOS`, `PROCESSOVIVO_IA_MAX_POR_HORA`, `PROCESSOVIVO_IA_MAX_SIMULTANEAS` e `OPENROUTER_API_KEY`
  (exigida só com a IA ligada; barrada se parecer valor de exemplo; nunca em log, resposta ou erro).
- Campos **aditivos** em `GET /v1/novidades`: `chaveDoAto` nas atualizações e na última movimentação das linhas sem novidade.

### Alterado

- A política de redação/verificação/preparo da entrada vive em `application/politicas/` e a sonda importa de lá (sem duplicação).
- O transporte do OpenRouter aceita um sinal de cancelamento (aborta a chamada e não repete).
- Rótulo do recurso "Análise com IA" no painel `/admin`: "em teste fechado: libere à mão; ainda não pode ir à venda".

### Corrigido

- Teste de navegador de "Peças baixadas" (`pasta-baixadas-navegador.spec.ts`): esperava só a classe `.pbx-vazio`, que também marca o
  "Carregando o histórico…", e lia o texto do carregamento quando vencia a corrida. Era do teste; a tela estava certa.

## [0.37.6] — 2026-10-09

Conferência com o Projudi. O dono pôs a aba Atualizações ao lado da tela de
Intimações do Projudi (Tribunal TJGO + Pedem providência + Últimos 15 dias): a aba tinha
20 processos e o Projudi, 10; dos que cabiam numa captura, 3 de 4 não estavam no Projudi;
2 do Projudi não estavam na aba; e uma linha mostrava duas datas de ato diferentes. Esta
versão entrega **a sonda para descobrir o porquê, processo a processo**, faz a linha falar
do **ato que gera a providência**, torna o "Detectado" legível e começa a separar a
**intimação dirigida a outro destinatário**. Nenhuma consulta ao tribunal. Nada de prazo
calculado nem de campo de data limite: o Projudi mostra uma "Possível Data Limite" que o
sistema continua sem informar. O filtro de Período (por `detectadaEm`) e a janela de 30
dias não mudaram.

### Adicionado

- **Sonda de diagnóstico `scripts/diagnostico-providencia.mjs` (v1.0.0).** Somente
  leitura e sem rede: abre o banco com `readOnly` (e `query_only`), sem `abrirBanco` — logo
  sem esquema, migração ou retrocarga —, não consulta tribunal, não grava nada, não lê senha
  nem XML. Recusa rodar sem `--workspace` quando há mais de um (aceita o identificador ou o
  e-mail da conta). Para cada processo diz: acompanhado, tribunal (do retrato e do número),
  procedência do retrato, contagem de movimentações e de comunicações do DJEN, última
  movimentação, novidades (total, não lidas, nos últimos 15 dias, maior lote detectado no
  mesmo instante e quantas são de ato 30+ dias anterior), a providência (`pede` / `cumprida`
  / `venceu` / `outro` / nenhuma, tipo, destinatário, marca de cumprido) e cada predicado do
  filtro, com a conclusão "aparece / não aparece, porque …". `--lista-filtro` lista os que
  passam (devem ser os da tela), termina com a contagem e separa os que pedem providência mas
  ficam fora SÓ pelo Período. Números mascarados sem `--mostrar`. Grava em `os.tmpdir()`
  `diagnostico-providencia-tabela.json`, só com contagens e booleanos. A lógica vive em
  `infrastructure/persistencia/diagnosticoDeProvidencia.ts` e usa a MESMA `estadoDaPasta` da rota.
- **Indicador de destinatário da comunicação do DJEN** (`Movimentacao.paraOUsuario`:
  `sim`, `nao` ou `desconhecido`). O DJEN informa, em cada comunicação, os advogados
  destinatários com número e UF da OAB, e a consulta por número devolve também as dirigidas
  à outra parte. O mapper deixa as inscrições em memória (`destinatariosOab`, transitório) e
  `comIndicadorDeDestinatario` — decorator da porta das pastas, o ponto único das cinco
  gravações — as compara com as OABs do workspace (a do cadastro e as das vigilâncias) e as
  troca pelo indicador. **Inscrição de terceiro nunca vai ao banco nem à API** (testes
  fixam). Migração aditiva e sem retrocarga: o retrato é JSON; fica `desconhecido` até a
  próxima sincronização, e uma resposta sem as inscrições (cache) não apaga o que já se sabia.
- **Intimação a outro destinatário** (`paraOUsuario = nao`): deixa de contar como "pede
  providência por intimação" (volta à regra comum do ato) e a tela diz: "N com intimação a
  outro destinatário · Ver" ao lado do filtro, o selo "Intimação a outro destinatário" na
  linha, e a lista dos que saíram por isso. `desconhecido` mantém o comportamento anterior e o
  selo da intimação diz "destinatário não confirmado". `GET /v1/novidades` ganhou, aditivos,
  `providencia.motivo.paraOUsuario`, `providencia.outroDestinatario` e a situação `outro`.

### Alterado

- **A linha mostra o ato que gera a providência.** Quando o processo pede providência, a
  atualização principal é esse ato (rótulo, selo "Intimação"/"Citação" e a data dele na
  coluna Data do ato); o último andamento, quando é outro, vai numa segunda linha "Último
  andamento: …". Saiu o "Pede providência por:" da 0.37.5. Ordenar por "Data do ato" usa a
  data exibida. O trecho do texto só aparece quando o ato da providência é a própria
  atualização da linha (o contrato da API não leva texto do ato da providência).
- **"Detectado" legível.** Quando a detecção está a mais de 7 dias da data do ato, a coluna
  mostra a data absoluta ("detectado em 07/10"), com o `title` "Data do ato é a do tribunal;
  detectado é quando o Processo Vivo viu pela primeira vez". Ordenação e regra de
  `detectadaEm` intactas.
- `serializarProcesso` aceita `preservarDestinatarios` (só o cache em memória o pede);
  `Processo.toJSON` não leva `destinatariosOab`.

### Investigação (sem alteração de comportamento)

- O reparo da avalanche deixa de fora lotes menores que 20 e atos com menos de 30 dias de
  atraso; testes sintéticos fixam o resíduo e o critério complementar proposto (5+ novidades,
  100% com ato 30+ dias anterior). Nada foi aplicado.

## [0.37.5] — 2026-10-08

A aba Atualizações (que já abre em "Pedem providência") passa a reconhecer as
**intimações e citações publicadas no Diário Eletrônico**, a manter cada uma pendente
por até 30 dias, e o advogado ganha um jeito de tirar da lista as que já cumpriu.
Corrige junto a "avalanche" de novidades. Nenhuma
consulta ao tribunal (nem MNI, nem sonda); o sistema continua sem calcular nem anunciar
prazo: "pede providência" é leitura automática do andamento.

### Corrigido

- **Avalanche de novidades.** Processo descoberto pela vigilância por OAB é gravado só
  com o retrato do DJEN; na primeira varredura regular o retrato passava a ser
  DataJud+DJEN e `detectarNovidades` tratava a linha do tempo INTEIRA do DataJud como
  novidade (num log real: 892 novidades em 4 processos, ato de 2024 "detectado há 2
  dias"). Agora o que vem de uma fonte que o retrato anterior ainda não tinha e é
  anterior ao ato mais recente que ele já conhecia é histórico: reforça a linha de base,
  não avisa. Ato realmente novo (posterior ao que se conhecia) continua gerando novidade. O mesmo vale
  para fonte que cai e volta. A completude do retrato sai da própria procedência
  (`datajud+djen`), já gravada: nenhum campo novo. A regra de unicidade não mudou e
  nenhuma novidade foi apagada.
- A procedência de um retrato fundido não cresce mais um `+djen` a cada varredura da
  vigilância (`fundirProcessos` deduplica as fontes).

### Adicionado

- **Tipo da comunicação do DJEN guardado** (`Movimentacao.tipoComunicacao`, só o tipo,
  nenhum texto a mais; a data de disponibilização já era a `data` e o id da comunicação
  já era o `idExterno`). Sem migração de esquema: o retrato é JSON e o campo opcional se
  preenche na próxima sincronização de cada processo.
- **`domain/entities/tipoDaComunicacao.ts`**: intimação / citação / outro. Intimação ou
  citação do DJEN passa a **exigir ação** ("Ato ordinatório" e afins escapavam).
- **`PENDENCIA_INTIMACAO_JANELA_DIAS` = 30**: para esses atos, "pede providência" dura até
  o advogado marcar como cumprido ou 30 dias da disponibilização, o que vier antes. Não é
  prazo. Os demais atos seguem em 10 dias. Quando a janela vence sem marca o processo sai
  do filtro, continua em "Todas", e a tela diz quantos saíram: "N sem marca há mais de 30
  dias".
- **"Marcar como cumprido"** por processo: guarda workspace, processo, ato coberto (chave
  e data), `cumpridoEm` e quem marcou. A marca cobre os atos até aquele; ato novo que
  exija ação volta a pedir providência sozinho. Não mexe na detecção de novidades nem na
  "não lida". Desfazer com confirmação leve, na própria célula (sem `alert`/`confirm`).
  Colunas aditivas `cumprido_chave`, `cumprido_ate`, `cumprido_em`, `cumprido_por` em
  `acompanhamentos` (migração explícita, sem retrocarga).
- API: `POST` e `DELETE /v1/acompanhamentos/:numero/cumprido` (Zod, isolamento por
  workspace, 404 igual para "não existe" e "é de outra conta", 409 para ato inválido).
  `GET /v1/novidades`: `processo.providencia` (`situacao` `pede`|`cumprida`|`venceu`,
  `motivo` {rotulo, data, chave, tipo}, `cumpridoEm`) e `pendenciaIntimacaoJanelaDias`.
  Nada foi removido nem renomeado.
- Tela: selo "Intimação"/"Citação"; segunda linha "Pede providência por: {ato} · {data}"
  quando o ato que gera o selo não é o da linha; "N marcados como cumpridos · Ver" (lista
  os marcados, com Desfazer); componente único de ação em `ui/providencia.ts`.
- **Reparo opcional da avalanche**: `npm run cli -- novidades reparar` (dry-run por
  padrão; só conta, por workspace, sem número de processo). Com `--aplicar` apenas marca
  como lidas as novidades antigas de lotes suspeitos, nunca apaga, e grava os `id` num
  arquivo; `--desfazer <arquivo>` reverte. Quem decide aplicar é o dono.

### Alterado

- `estadoDaPasta` devolve também a leitura da providência (`providencia`) e aceita a
  marca de cumprido; a carteira ("Meus processos") e o painel usam a mesma regra, então o
  selo some lá também depois de marcado.

### Testes

- Unidade: avalanche reproduzida e corrigida (ponta a ponta: vigilância → varredura regular
  → zero novidades; ato novo → 1), classificação do tipo, janela de 30 dias com relógio
  fake, marca cobre só até o ato e ato novo reabre, desfazer, isolamento por workspace,
  rotas, migração, reparo.
- Navegador: marcar tira da lista e atualiza a frase, "Ver" e "Desfazer", selo, segunda
  linha, teclado, foco, sem rolagem horizontal em 1920/1366/1280/1024/768/390 px, axe nos
  temas claro e escuro.
- O teste `pasta-baixadas-navegador` já falhava antes desta versão (a aba abre em
  "Pedem providência" desde a 0.37.4); passou a clicar em "Todas".

---

## [0.37.4] — 2026-10-08

Um ajuste na página de Atualizações, decisão do dono (opção A): a aba abre mostrando
só os processos que **pedem providência**; todos os demais ficam a um clique. Não
muda a detecção, `estadoDaPasta`, a janela de 10 dias, `exigeAcao`, o calendário, o
contrato de `GET /v1/novidades` nem `/v1/painel`. Nenhuma consulta nova ao tribunal.

### Alterado

- **Padrão da aba = filtro de Situação "Pedem providência"** (`SITUACAO_PADRAO`). O
  período continua "Todas". A escolha da pessoa vale enquanto ela navega (variável da
  página, nunca `localStorage`); recarregar volta ao padrão. Chips na mesma ordem, com
  contador de processos sobre a base de sempre (período + tribunal).
- **Frase de situação sempre à vista** com o filtro ativo: "Mostrando m de N processos
  acompanhados: só os que pedem providência · Ver todos" ("Ver todos" ativa "Todas").
  Com m = N fica só a contagem, sem "Ver todos".
- **Estado vazio** (m = 0): "Nenhum processo pede providência agora." + "N processos
  acompanhados · Ver todos", no lugar de tabela vazia. Sem alarme e sem a palavra "prazo".
- **Aviso de honestidade** junto do chip, sempre visível e ligado por `aria-describedby`:
  "Leitura automática do andamento, não é contagem de prazo. Confira no processo."
- **Processo sem movimentação conhecida** (acompanhado, ainda sem leitura) não pode ser
  avaliado: não é contado como providência e a tela diz quantos ficaram fora do filtro.

### Testes

- Unidade: padrão, contadores, "Ver todos", vazio, frase com m < N e m = N, paginação.
- Navegador: abre em providência (1 de 2), vazio com "Ver todos", "Ver todos" mostra 2,
  "Não lidas" e tribunal combinam, sem "prazo" fora do aviso, sem rolagem horizontal em
  1920/1366/1280/1024/768/390 px, axe nos temas claro e escuro. Os testes anteriores,
  que assumiam "Todas" como abertura, passaram a clicar "Todas" ao abrir.

## [0.37.3] — 2026-10-08

Dois ajustes na página de Atualizações, pedidos pelo dono depois de usar a 0.37.2 em
produção. Não muda a detecção de novidades, nenhum timeout, nem o DataJud/DJEN.

### Corrigido

- **Processo acompanhado sumia da aba Atualizações.** A aba só listava processo com
  pelo menos uma novidade, e a primeira sincronização guarda o retrato SEM gerar
  novidade (regra mantida): quem acompanhava 2 processos via 1, sem aviso, e a
  mensagem "N atualizações mais antigas não mostradas" falava de atualizações, não de
  processos. Agora a aba lista **todos os processos acompanhados**, uma linha por
  processo. Quem não tem novidade registrada mostra a última movimentação do retrato
  (mesma regra de `descricaoDoAto` e de trecho), "Detectado" = "—" (texto acessível
  "sem detecção registrada"), situação vazia (só "Pede providência" se o
  `estadoDaPasta` disser) e, sem nenhuma movimentação conhecida, "Nenhuma movimentação
  conhecida". Ordem padrão: primeiro os com atualização detectada (como antes), depois
  os demais pela data do ato, mais recente primeiro. Segredo de justiça: rótulo e data,
  nunca o texto do ato.
- **"Verificando agora" girava pela varredura de todo mundo.** O estado era uma
  bandeira única do serviço; com a varredura global rodando (todas as contas, fontes
  lentas) a tela de quem tem 2 processos girava por dezenas de minutos, e o clique em
  "Verificar agora" recebia 409. O estado agora é **por conta**.

### Alterado

- **O período de 15 dias virou filtro opcional e nasce desligado** ("Todas" é o padrão).
  Ligado, mostra só processos com atualização detectada na janela (regra de
  `detectadaEm` inalterada) e diz quantos PROCESSOS tirou: "N processos sem atualização
  nos últimos 15 dias (há K atualizações mais antigas) · Ver todos". A frase do topo
  conta processos acompanhados.
- **`GET /v1/novidades`:** campos existentes intactos (inclusive a lista plana
  `novidades`); dois campos NOVOS: `semNovidade` (processos acompanhados sem novidade
  registrada, com `ultimaMovimentacao` do retrato; vazio com `naoVistas=true`) e
  `processosForaDaJanela` (0 com a janela desligada). Nenhuma novidade é criada no banco.
- **`GET /v1/sincronizacao` e `verificacao` de `GET /v1/painel`** falam só da conta:
  `{ emAndamento, pendentes, desde, demorando }` — nenhum número da fila global. Antes
  `emAndamento` era a bandeira global.
- **`POST /v1/sincronizar`:** nunca dispara uma segunda verificação da mesma conta
  (`jaEmAndamento: true`) e não responde mais 409 por causa da varredura de OUTRAS
  contas: o pedido espera a vez (`naFila: true`) e roda em seguida, só com os processos
  de quem pediu. Continua sendo uma varredura por vez no processo (cota do CNJ).
- **Limite de espera: 5 minutos** (`LIMITE_VERIFICACAO_DEMORADA_MS`). Passado, a tela
  para de girar e diz "Verificação demorando: as fontes do tribunal estão lentas.
  Última verificação às HH:MM." (a verificação segue no servidor).

### Testes

`verificacao-por-conta.spec.ts`, `atualizacoes-sem-novidade.spec.ts`, ampliações em
`tabela-atualizacoes`, `atualizacoes-tela`, `painel` e `atualizacoes-navegador`
(2 processos / 1 sem novidade, período, sem rolagem horizontal em 1920, 1366, 1280,
1024, 768 e 390 px, temas claro e escuro, axe). Os testes que assumiam "só quem tem
novidade" ou o período de 15 dias como padrão foram reescritos para o novo contrato.

---

## [0.37.2] — 2026-10-07

Ajustes pequenos decorrentes do diagnóstico da coluna "Classe" e da aba "Meus
processos". Não muda quais processos aparecem em Atualizações, nem DataJud, vigilância
ou detecção de novidades.

### Alterado

- **Classe legível em Atualizações.** A coluna Classe passou de 8,5% para 12,5% da
  largura (Processo 17→16%, Partes 12→11%, Atualização 20→19%, Tribunal 6→6,5%, Data do
  ato 8→8,5%, Detectado 9→8%, Situação 9,5→9%, Ações 10→9,5%). Em 1366 px a coluna media
  ~74 px, menos que a palavra "Procedimento", e cortava no meio. Agora a classe quebra
  em palavras inteiras (`overflow-wrap: break-word`), cabe em até 2 linhas em 1366, 1280
  e 1920 px e, se exceder, o `line-clamp` põe as reticências; o `title` tem sempre a
  classe inteira (o texto no DOM também, para leitor de tela).
- **Classe normalizada SÓ na exibição** (`domain/entities/nomeDaClasse.ts`, função pura):
  `PROCEDIMENTO COMUM CíVEL` (DJEN), `PROCEDIMENTO COMUM CÍVEL` e `Procedimento Comum
Cível` (DataJud) passam a ter o mesmo texto. Preposições (de, da, do, e…) em minúscula,
  siglas conhecidas (INSS, FGTS…) preservadas, sigla desconhecida em texto bem escrito
  não é rebaixada. O valor guardado e a API não mudam; o texto cru vai no `title` quando
  difere. Sem classe, "—". Usada em Atualizações e em Meus processos (e nos resultados da
  busca por OAB, que já usavam o `titulo()` antigo); o `titulo()` do console foi
  removido — uma função só, a do domínio, injetada por `toString()`.
- **Filtro de classe de "Meus processos" agrupado.** `GET /v1/facetas` devolve UMA
  opção por classe normalizada (`classes`), e `GET /v1/acompanhamentos?classe=` casa com
  todas as grafias cruas que normalizam igual. Sem migração: o banco segue como gravado.
- **"Meus processos": última movimentação sem repetição** (`descricaoDoAto`, a mesma da
  Pasta e de Atualizações); o texto cru fica no `title`.
- **"Meus processos": sem rodapé "N de N".** O rodapé repetia o subtítulo e nunca mostrava
  o total sem filtro. Sem filtro, o subtítulo diz o total uma vez; com filtro, só o aviso
  "Mostrando X de Y processos" (Y = total sem filtro) conta, e o subtítulo some. O número
  da lateral (`cont-processos`) é o mesmo total sem filtro e foi mantido.
- O subtítulo da carteira usa `--tinta2` (o `--tinta3` mede 4,2:1; axe). A variável global
  não mudou.

### Não mudou (de propósito)

"Em curso", "+ rotular cliente", "classe não informada", a faixa de novidade e as colunas
da carteira ficam para a próxima versão, depois de ver a tela.

---

## [0.37.1] — 2026-10-06

Ajustes pedidos pelo dono depois de ver a tabela da 0.37.0 em produção.

### Removido

- **"+N anteriores", a lista de anteriores, o "mostrar mais 20" e o aviso "há anterior
  que pede providência"** saem da tabela de Atualizações (script, estilos e testes).
  Cada processo é uma linha com a atualização mais recente. A regra de ouro (nada some
  em silêncio) ficou em uma frase no nível da página, abaixo dos filtros: "Cada
  processo mostra a atualização mais recente. As anteriores estão em 'Abrir
  processo'." — só quando algum processo tem mais de uma atualização no período, sem
  contagem por processo. A mensagem "N atualizações mais antigas não mostradas (fora
  dos últimos 15 dias) · Ver todas" continua. Filtros, contadores, ordenação,
  paginação, "Ver todas" e a janela de 15 dias não mudaram; "Não lida" e "Pede
  providência" seguem a mesma regra.

### Alterado

- **`GET /v1/novidades` não envia mais as atualizações anteriores.** `grupos[].anteriores`
  saiu; entrou `grupos[].quantidade` (atualizações do processo no período). O campo
  `novidades` (achatado) traz só a mais recente de cada processo. `total`, `naoVistas`
  e `foraDaJanela` continuam contando atualizações. Um processo com ~300 atualizações
  agora trafega 1 item. `/v1/painel` não foi tocada.
- **Coluna "Detectado" enxuta:** "hoje", "há 1 dia", "há 11 dias". A frase completa
  ("detectado há 11 dias") fica no `title` e em texto para leitor de tela.
- **Coluna Ações:** só os dois botões (abrir processo, abrir pasta), sempre na mesma
  linha; alvos de 44 px no celular.
- **Descrição sem repetição, só na exibição.** "Juntada -> Petição — Juntada ->
  Petição - MANDADO…" passa a aparecer como "Juntada -> Petição - MANDADO…"
  (`descricaoDoAto`, função pura em `domain/entities`). Aplicada na lista da Pasta
  (peças e movimentações sem peça), no cabeçalho do visualizador e no título da
  atualização na tabela. O texto original continua no tooltip, na busca (casa com o
  original e o enxuto), nos dados guardados e na API.

---

## [0.37.0] — 2026-10-06

A página inicial (Atualizações) deixa de ser um painel de cartões com uma coluna de
peças e passa a ser uma **tabela de últimas atualizações, uma linha por processo**,
no estilo de uma lista de comunicações de tribunal: larga, legível, com filtros que
contam e paginação.

### Alterado

- **Sai o painel de quatro cartões** ("Processos ativos", "Pedem providência",
  "Novidades não lidas", "Peças baixadas hoje") **e a coluna "Peças baixadas"**. A
  página fica: título e situação da sincronização (inalterados), barra de filtros,
  tabela e paginação. A tabela usa toda a largura disponível.
- **Os cartões viram filtros com contador**, sobre a base já escolhida (período +
  tribunal): Situação — "Todas (N)", "Não lidas (N)" e "Pedem providência (N)". Os
  números contam **processos**, não atualizações. "Pedem providência" usa a MESMA
  regra e a mesma janela de 10 dias do selo da carteira e do cartão antigo
  (`estadoDaPasta`); o texto nunca fala em prazo. Ao filtrar, a tela diz "Mostrando
  X de Y processos" e oferece "Limpar filtros"; a mensagem sobre atualizações mais
  antigas que a janela de 15 dias ("N … não mostradas · Ver todas") continua.
- **Tabela de verdade** (`<table>`, `<th scope="col">`, `caption`): Processo (número
  CNJ monoespaçado, link, botão copiar com confirmação em região `aria-live`, sem
  `alert`), Partes (polo ativo × passivo, até 2 linhas, texto completo no tooltip),
  Atualização (rótulo + trecho curto de 220 caracteres, regra da 0.35.1), Tribunal,
  Classe, **Data do ato** e **Detectado** (o "detectado há N dias" da 0.35.2) em
  colunas separadas e rotuladas, Situação (selos "Não lida" e "Pede providência") e
  Ações (abrir processo, abrir Pasta digital, "+N anteriores").
- **"+N anteriores" expande na própria linha** (`aria-expanded`/`aria-controls`),
  em lotes de 20 com "Mostrar mais 20" e sempre "mostrando X de N" — um processo com
  300 atualizações continua sendo uma linha. A regra de agrupamento, a janela de 15
  dias e a marca "há anterior que pede providência" não mudaram.
- **Ordenação por cabeçalho** (Processo, Tribunal, Data do ato, Detectado; `aria-sort`;
  1º clique ordena, 2º inverte, 3º volta à ordem de chegada — a ordem atual da página
  continua sendo o padrão) e **paginação** (10, 25 ou 50 por página; "X–Y de Z
  processos"; primeira, anterior, próxima, última). Só ordenam, nunca escondem. A
  escolha vale só na sessão da página (nada em `localStorage`).
- **Layout:** cabeçalho fixo ao rolar; sem rolagem horizontal em 1920, 1366, 1280,
  1024, 768 e 390 px. Abaixo de 1024 px cada processo vira um bloco empilhado, com
  rótulos e alvos de toque de 44 px, e um seletor "Ordenar por" no lugar dos
  cabeçalhos. De 1024 a 1279 px a coluna Classe vira uma linha sob o Tribunal (a
  lateral de 256 px come a largura). Temas claro e escuro, foco visível,
  `prefers-reduced-motion`, axe sem violações. O texto de apoio da tela usa
  `--tinta2` (o `--tinta3` global mede 4,2:1 sobre o fundo claro).
- **Estados:** sem processos acompanhados ("Nenhum processo acompanhado ainda" +
  "Buscar processo"), sem resultado no filtro (quantos existem sem filtro + "Limpar
  filtros"), carregando (esqueleto) e erro ("Tentar de novo").
- **"Abrir pasta"** na linha abre o processo e já abre a Pasta digital (pedido de uma
  vez só, com validade de 60 s e por processo).

### Adicionado

- **Histórico de peças baixadas dentro da Pasta digital:** botão "Peças baixadas" no
  topo da Pasta abre uma gaveta com, só do processo aberto, o rótulo, o tamanho, a
  data e hora do download e "há N dias". Lê `GET /v1/pecas-baixadas?numero=` (já
  existia: isolado por workspace e por processo, só metadado). A gaveta diz que o
  arquivo não fica guardado ali — é o registro dos downloads avulsos feitos pela linha
  do tempo — e não oferece baixar de novo. Não consulta o tribunal.
- **`GET /v1/novidades` devolve, por processo (`grupos[].processo`):** tribunal,
  classe, partes por polo (nomes, até 20 por polo, com o total), `pedeProvidencia` e o
  motivo — tudo do retrato que o acompanhamento já guarda, sem consulta nova ao
  tribunal e sem migração. Mais `pendenciaJanelaDias` na resposta, para o filtro
  dizer de quantos dias é. Partes e classe são o que a fonte entregou (DJEN e
  DataJud); processo que ainda não sincronizou, ou fonte que não sabe, mostra "—".

### Removido

- Da página inicial: os quatro cartões e a coluna "Peças baixadas" (o histórico mudou
  para a Pasta). `GET /v1/painel` continua devolvendo `cards` e `pecasBaixadas`
  (a tela deixou de usá-los; remover é decisão à parte), e nenhum dado foi apagado.

## [0.36.0] — 2026-10-06

A lista da Pasta digital passa a mostrar **todas as movimentações** do processo, não
só as que têm peça. Num processo de 386 movimentações no Projudi (385 recebidas) a
lista tinha 279 linhas e a numeração parecia pular (386 → 382): atos sem documento
— conclusos, intimações, certidões — ficavam escondidos sem aviso.

### Adicionado

- **Uma linha por movimentação.** A movimentação sem peça é igual à de peça — número
  (exato / faixa / estimado / posição, "✓ conferido", "informar nº"), data e
  descrição —, com o selo "Sem peça" no lugar do estado e sem caixa de seleção.
  Atos com várias peças seguem em várias linhas, com o mesmo número. A ordem é a da
  lista de antes; o ato sem peça entra na posição cronológica dele.
- **Clique em movimentação sem peça:** cabeçalho "Mov. N · Movimentação" e a
  mensagem "Esta movimentação não tem peça (documento) anexada." Nenhuma consulta
  ao tribunal; a calibração do número continua disponível.
- **Contagem e filtros que dizem quantos são de cada tipo:** "X de M linhas · P
  peças · S sem peça"; chip "Sem peça (N)" (filtra); "só disponíveis" esconde as
  sem peça e informa quantas; a busca casa a descrição e o número delas. Todas,
  Nenhuma, Baixar PDF e Montar pasta completa continuam só sobre peças.
- **Lacuna de numeração, só quando provada:** entre dois atos vizinhos com número
  EXATO e salto maior que 1, uma linha discreta "nº 368 · ato não recebido do
  tribunal (provavelmente bloqueado)". Nunca em faixa ou estimado; não é linha
  (não conta, não abre) e some quando há filtro, dizendo quantas ocultou.
- **Listagem anterior à 0.36.0:** aviso "Esta lista tem só as peças" com o botão
  "Atualizar as peças" (o fluxo de sempre), sem erro e sem tela vazia.
- **Dados:** coluna `pasta_listagens.atos` (migração explícita, sem retrocarga):
  posição, data/hora, descrição e complemento de cada ato, gravados da mesma
  resposta do MNI. Só metadado do ato; mesmo workspace, mesma linha e mesma
  política de segredo da listagem. `GET …/pasta` ganha `todasAsMovimentacoes`,
  `atosSemPeca`, `lacunas`, `linhas` e `totais.atosSemPeca`.

### Alterado

- **Lista mais larga:** de 400 px fixos para `clamp(440px, 32vw, 520px)` (440 em
  1366 px, 520 de 1625 px em diante); o divisor arrastável continua. O visualizador
  mantém no mínimo 320 px. Sem rolagem horizontal em 1366, 1280, 1024, 768 e 390.
- **Descrição em até 2 linhas** (texto inteiro no mouse, no foco da linha e no
  cabeçalho do visualizador) e **placeholder da busca** encurtado para "Buscar
  rótulo, movimentação ou nº", sem corte em 1366 px.

### Não mudou

Cálculo da numeração (0.35.0), fila, limitador, cache de peças, isolamento por
workspace, PDF montado, leitor, calendário e planos.

---

## [0.35.3] — 2026-10-06

Layout da Pasta digital, pedido pelo dono depois de usar a Pasta com um processo
de ~280 peças: a lista começava na metade de baixo da janela.

### Alterado

- **A lista sobe e ocupa a altura da janela.** A Pasta passa a ter `100dvh` e a
  página por baixo deixa de ter altura além da janela (`documentElement.scrollHeight
<= clientHeight`): rolam só a lista e o visualizador, cada um por dentro. Onde a
  primeira linha começava (1366×768 / 1920×1080, medido com 40 peças sintéticas
  a mais): **553 → 277 px** e **534 → 277 px**; linhas inteiras visíveis:
  **2 → 5** e **5 → 10** (a massa de teste tem descrições de 2 linhas; com linhas
  compactas cabem 6 em 768 px).
- **Avisos compactados, sem perder nenhum.** Mesmo texto, fonte de 12 px e
  espaçamento menor numa faixa só. "Lista obtida do tribunal… não é consulta ao
  vivo" e o aviso da numeração (0.34.0/0.35.0) continuam sempre à vista; nada foi
  recolhido.
- **A estimativa do "Montar pasta completa" saiu da faixa de avisos** e foi para
  uma dica ao lado do botão: aparece no mouse e no foco do teclado, descreve o
  botão (`aria-describedby`, `role="tooltip"`) e fecha com Escape. O texto é o
  mesmo.
- **Busca e "só disponíveis" na mesma linha; ações (Todas/Nenhuma/Baixar PDF),
  chips menores e o contador "N marcadas de M · mostrando X de M" no mesmo fluxo**,
  sem rolagem horizontal. A linha da lista ficou mais baixa (padding menor).
- Cabeçalho da Pasta, avisos, "Conferir numeração", busca e ações ficam fixos; só
  as linhas rolam. A barra do visualizador (zoom, página, buscar no texto, baixar)
  já era fixa, e agora há teste. A região da lista passou a se chamar "Lista de
  peças" e o visualizador, "Visualizador da peça".

### Testes

- `tests/browser/pasta-layout-navegador.spec.ts`: 1920×1080, 1366×768, 1024×768,
  768×1024 e 390×844 (sem rolagem horizontal, página parada, lista rolando por
  dentro, primeira linha no alto), avisos obrigatórios à vista, dica por foco,
  lista que não pula ao marcar, barra do visualizador fixa e axe nos dois temas.

## [0.35.2] — 2026-10-06

Três ajustes de interface pedidos pelo dono: um na Pasta digital, dois na página inicial.

### Alterado

- **Pasta digital: o número da movimentação ocupa o lugar do índice.** A lista
  mostrava um índice sequencial (1, 2, 3…) que o advogado lia como o número do ato
  no Projudi. Agora a coluna à esquerda do rótulo é o número da movimentação, nos
  formatos já calculados pela 0.35.0: exato `386` (com "✓ conferido"), faixa
  `380–381` (nunca arredondada), estimado `~386` e posição `385` (com o aviso do
  topo da 0.34.0). O "mov. N" repetido saiu da linha de metadados; "faixa" e
  "estimado" aparecem por extenso ao lado do rótulo. Peça sem número mostra "—",
  nunca o índice. O cabeçalho do visualizador passou de "13. Certidão" para
  "Mov. 369 · Certidão" (e "Mov. 380–381", "Mov. ~386"), e o "Ver tudo seguido"
  diz "Mov. N" em vez de "peça N". Coluna de largura fixa (8ch, fonte tabular), sem
  rolagem horizontal em 1280/1024/768/390 px. Leitor de tela: "Movimentação 386,
  conferida" / "faixa 380 a 381" / "estimada 386" / "sem número". Várias peças do
  mesmo ato seguem como linhas separadas com o mesmo número. O índice continua
  existindo como chave interna de ordenação; só deixou de ser exibido. Sem mudança
  em API, banco ou no cálculo do número.
- **Página inicial: "há N dias" virou "detectado há N dias"** (singular "detectado
  há 1 dia"; "detectado hoje") na atualização em destaque e nas anteriores. A
  contagem sempre foi desde a detecção, não desde a data do ato (que está no
  quadro à esquerda); agora a tela diz isso, e o tooltip explica. Janela,
  ordenação e contagem não mudaram.
- **Cartão "Pedem providência"**: "ato dos últimos 10 dias que abre prazo" →
  "…que pede providência", coerente com a regra de não anunciar prazo.

## [0.35.1] — 2026-10-06

Página inicial — dois ajustes pedidos pelo dono depois de usar o sistema.

### Alterado

- **"Últimas atualizações" mostra só o começo do texto do ato**: até ~220
  caracteres, cortado em limite de palavra, com "…" (em `aria-hidden`) e no
  máximo 3 linhas. O texto completo continua nos dados e na API; quem quer ler
  abre o processo ("Abrir processo", que só aparece quando houve corte). Vale
  para a atualização em destaque e para as anteriores expandidas. Não mudou
  contagem de não lidas, janela de 15 dias, "+N anteriores", "pede providência"
  nem a ordem, e nenhuma atualização deixa de aparecer. A função é pura e mora em
  `ui/trechoDeTexto.ts`; o console recebe o texto dela (`toString()`), então o
  teste exercita a mesma função que roda no navegador. `script.ts` não cresceu.

### Corrigido

- **"Peças baixadas" empurrava a coluna da direita para fora da página** quando o
  nome do arquivo era comprido e sem espaço. Causa: item de grade não encolhe
  abaixo do conteúdo (`min-width: auto`). Correção: `minmax(0, …)` nas colunas de
  `.duas-colunas` e de `.app`, `min-width: 0` nos filhos e `overflow-wrap:
anywhere` no nome do arquivo, na linha de metadados e no título da atualização.
  O nome continua inteiro na tela, quebrado em linhas (sem truncar).

### Testes

- `tests/http/trecho-de-texto.spec.ts` (unidade) e
  `tests/browser/inicio-navegador.spec.ts` (Chromium: decisão de ~3.000
  caracteres mostra só o trecho; nome de 120 caracteres sem rolagem horizontal
  em 1280, 1024, 768 e 390 px; axe nos temas claro e escuro). Os testes de largura
  falham sem a correção de CSS.

---

## [0.35.0] — 2026-10-04

Pasta digital — **calibração do número da movimentação com o Projudi, feita pelo
advogado**. O número do Projudi conta também os atos bloqueados, que o MNI não
entrega; a 0.34.0 mostrava a posição com aviso, e isso não bastava. Agora o
advogado informa um ou mais números que vê no Projudi, e a tela mostra o número
exato SEMPRE QUE ISSO PUDER SER PROVADO — e uma faixa honesta quando não puder.

### Adicionado

- **Âncoras**: par (posição do ato, número no Projudi) informado pelo advogado.
  Regra: `número = posição + atos bloqueados antes`; o deslocamento
  `d = número − posição` é ≥ 0 e nunca diminui. Âncora que contradiz as outras é
  recusada ("Esse número não é compatível com os outros que você informou.").
  Até 50 por processo.
- **`numeroDoProjudi` (domínio, função pura)**: o próprio ato ancorado → exato;
  entre duas âncoras de mesmo `d` → exato; entre duas de `d` diferente → faixa
  `min–max`; antes da primeira → exato se `d = 0`, senão faixa `[pos, pos+d]`;
  depois da última → estimado (`pos + d`). Faixa nunca é arredondada. Sem âncora:
  a posição, como na 0.34.0.
- **API** (sem consulta ao tribunal): `PUT /v1/processos/:numero/pasta/calibracao`
  (`{ numeroProjudi, posicao? }`; sem `posicao` = o último ato recebido, o atalho
  "último número que você vê no Projudi"), `DELETE …/calibracao` e
  `DELETE …/calibracao/:posicao`. `GET …/pasta` traz `movimentacao.numero`
  (`{tipo: posicao|exato|faixa|estimado, …}`) por peça e `calibracao`
  (âncoras, quantos atos exatos/faixa/estimados, âncoras invalidadas) no topo.
  Erro novo: `CalibracaoDeNumeracaoInvalidaError` → 400.
- **Tela** (`ui/scriptPastaCalibracao.ts`; `script.ts` não cresce): bloco
  "Conferir numeração com o Projudi" no topo; "informar nº" na linha (mouse),
  tecla **N** na linha focada e botão no cabeçalho do visualizador abrem o mesmo
  editor. Exato = "mov. 382 ✓ conferido"; faixa = "mov. 380–381"; estimado =
  "mov. ~386"; sem calibração = "mov. 385" como antes. O aviso do topo muda
  ("Calibrada por você com N números…") e não some enquanto houver número não
  exato. Busca por número casa por igualdade e, numa faixa, quando o número está
  dentro dela (a linha vem rotulada). "Limpar calibração" e remoção individual.
- **Banco**: tabela `pasta_ancoras` (por workspace) com a `dataHora` do ato;
  colunas `pasta_listagens.datas_dos_atos` e `ancoras_invalidadas` (migração
  explícita, sem retrocarga: as datas só existem na resposta do tribunal).
  Âncora cujo ato mudou de data numa listagem nova é descartada e a tela avisa
  "Calibração anterior invalidada".

### Detalhes

- Nada é escondido por causa da calibração; "mostrando X de M" segue valendo.
- Sem calibração a tela é a da 0.34.0. Listagem gravada antes da 0.35.0 não tem
  as datas: para calibrar é preciso recarregar as peças do processo.
- Não detecta ato bloqueado sozinha, não usa DataJud e não lê o texto das peças.
- PUT exige o plano com peças, como o resto da Pasta; remover não exige.

---

## [0.34.0] — 2026-10-04

Pasta digital — **o número da movimentação volta, agora como a POSIÇÃO do ato**,
com aviso claro da limitação. Decisão do dono (04/10/2026) depois de ver a tela
do Projudi e a sonda de numeração.

### Adicionado

- **`mov. N` na linha da peça** (N = posição 1-based do ato na ordem cronológica
  dos atos que o MNI entregou; desempate estável por `dataHora` e
  `identificadorMovimento`). Tooltip: "Número calculado pela ordem dos atos
  recebidos do tribunal. Pode ficar abaixo do número do Projudi se o processo
  tiver atos bloqueados."
- **Aviso fixo no topo da Pasta** enquanto houver número na lista: "Numeração das
  movimentações calculada pelo Processo Vivo a partir de N atos recebidos do
  tribunal. Se o último número que você vê no Projudi for maior que N, há atos
  bloqueados que não recebemos…".
- **Cabeçalho do visualizador**: "Movimentação nº N · data — descrição", com o
  aviso curto ao lado.
- **Busca por número**: "382" ou "mov. 382" casa por igualdade com a posição
  ("382" não acha "1382"); placeholder e `aria-label` voltam a citar o número.
- `GET …/pasta`: `totalAtosRecebidos` no topo e `movimentacao.posicao` por peça.
  `identificadorMovimento` continua sem sair como número.
- Banco: coluna `pasta_listagens.total_atos_recebidos` (migração explícita, sem
  retrocarga: só o tribunal sabe o N). Listagens gravadas antes ganham os campos
  na próxima vez que a tela recarrega as peças — sem consulta nova ao tribunal.

### Detalhes

- A posição é calculada sobre a lista COMPLETA de movimentos que já vem na
  resposta do MNI à listagem de peças (`movimentos: true`), não só os que têm
  documento. Nenhuma consulta nova.
- **Limite honesto:** o Projudi conta também atos bloqueados que o MNI não
  entrega, então a posição só iguala o número do Projudi até o primeiro desses
  atos. Não há detecção nem calibração (fora do escopo). O mapper do MNI descarta
  movimento sem `dataHora`, que então também não entra na contagem.
- `CLAUDE.md`: a regra "não há mov. N" (0.33.3) foi substituída pela regra da
  posição, preservando o histórico do erro da 0.33.2.

## [0.33.3] — 2026-10-03

Pasta digital — **corrige o "mov. N" da 0.33.2, que estava errado**. O número
mostrado (ex.: 516017862) era o `identificadorMovimento` do MNI, um identificador
INTERNO do tribunal; o que o advogado vê no Projudi é a numeração sequencial do
ato. Usamos o campo errado e a 0.33.2 foi aprovada sem conferir contra o tribunal.

### Corrigido

- **Nenhum número de movimentação é mais exibido**: saiu da linha da lista, do
  cabeçalho do visualizador ("Movimentação · data — descrição") e da busca (que
  não procura mais por número; placeholder e `aria-label` ajustados). A descrição
  do ato, que estava correta, continua.
- `GET …/pasta`: `movimentacao` deixa de trazer `numero` (`data`, `descricao`,
  `complemento`). Quem consumia o campo deve parar.

### Detalhes

- **Por que remover e não derivar:** nenhuma resposta do MNI mapeada pelo projeto
  traz o número sequencial (atributos de `<movimento>`: `identificadorMovimento`,
  `dataHora`, `nivelSigilo`, filhos de classificação e `complemento`; de
  `<documento>`: `idDocumento`, `movimento`, `descricao`, `mimetype`, `dataHora`,
  `nivelSigilo`). Derivar pela posição exigiria conferir contra o Projudi — a
  verdade de campo não foi informada — e depender de que o sistema receba todos
  os atos (atos internos podem não vir). Sem confirmação, fica sem número.
- O `identificadorMovimento` continua sendo a chave INTERNA do vínculo peça → ato.
- Regressão: teste com identificador longo (516017862) que não pode aparecer na
  tela, no cabeçalho, na busca nem na resposta da API.

## [0.33.2] — 2026-10-03

Pasta digital — **cada peça mostra o ato a que pertence**. Pedido do dono: 111 de
279 peças de um processo real chegam rotuladas só "Outros", e o advogado não
tinha como identificá-las na lista.

### Adicionado

- **Descrição e número da movimentação em cada peça da lista.** Rótulo, data e
  estado como antes; abaixo, a descrição do ato em até 2 linhas e "mov. N" ao lado.
  Texto inteiro no mouse, com a linha em foco (teclado) e no cabeçalho do
  visualizador. Várias peças do mesmo ato repetem a descrição (sem agrupar).
- **A busca da lista procura também na descrição e no número da movimentação**
  (o número casa por igualdade: "382" não acha 1382). O contador "mostrando X de M
  (K escondidas pelos filtros)" segue valendo.
- `GET …/pasta`: cada peça traz `movimentacao` (`numero`, `data`, `descricao`,
  `complemento`) ou `null`. Procedência `aoVivo:false` em toda resposta.

### Detalhes

- **Fonte dos campos (MNI, tribunal):** vínculo `documento@movimento` ↔
  `movimento@identificadorMovimento` da mesma resposta; descrição =
  `movimentoLocal@descricao` (ou `descricao`); complementos = `complemento`s do
  ato; número = `identificadorMovimento`. Nenhuma consulta nova: os dados já vêm
  na listagem que a tela do processo grava, e agora ela grava também o ato.
- **Não se inventa:** sem os dois lados do vínculo (peça aponta ato que a resposta
  não trouxe, número repetido, ato sem data) a linha fica como era, sem bloco
  vazio. Número citado dentro da descrição é texto, nunca link nem número do ato.
- **Listagens gravadas antes desta versão** não têm o ato; ele aparece na próxima
  vez que a tela do processo carregar as peças (sem consulta automática ao
  tribunal para recuperar).
- Sem conteúdo de peça lido, sem mudança na fila, no limitador, no cache nem no
  isolamento por workspace.

---

## [0.33.1] — 2026-10-03

Pasta digital — **a tela** (Parte 2). Fecha a entrega da 0.33.0: o backend já
estava na tag anterior. Especificação: `docs/ajustes-e-pasta-digital-especificacao-v1.0.0.md`
(seções 5 a 8).

### Adicionado

- **Pasta digital** (`ui/scriptPasta.ts`, `ui/estilosPasta.ts`): lista de todas as
  peças à esquerda — ordem dos autos, rótulo, data, estado (não baixada, na fila,
  baixando, disponível, não obtida com motivo, sob sigilo), intervalo `p. N–M` quando
  o PDF montado existe, caixas de marcar, atalhos por tipo, "Todas (N)" /
  "Nenhuma", contador "N marcadas de M · mostrando X de M (K escondidas pelos
  filtros)", busca por rótulo, filtro "só disponíveis" e teclado completo
  (setas, Home/End, Enter abre, Espaço marca) — e o visualizador PDF.js à direita.
- **Clicar baixa só a peça.** O clique espera 400 ms (outro clique troca o
  agendado) antes de pedir; peça já guardada abre sem pedido. Estados honestos no
  visualizador: pedindo, **aguardando a fila do tribunal** (com a explicação de
  que há uma montagem andando e a pausa de 3 s), baixando, pausado pelo tribunal
  até HH:MM, sem habilitação nos autos, não obtida com o motivo, sob sigilo, e
  "obtida em dd/mm hh:mm, não é consulta ao vivo". Nunca "carregando" sem fim:
  limites de 120 s (peça) e 30 s (abrir PDF), e três falhas de consulta param a
  tela com "tentar de novo".
- **Montar pasta completa** (estimativa antes, confirmação acima de
  `LEITOR_CONFIRMAR_ACIMA_DE`, leitura enquanto monta, progresso e pausa do tribunal
  com a hora), **Ver tudo seguido** (PDF combinado; clicar numa peça com `p. N` leva
  até a página) e **Baixar PDF (N)** das marcadas, que antes mostra "serão
  buscadas K peças no tribunal (~tempo)" e baixa `processo-<n>-pecas-selecionadas.pdf`.
- Listagem ausente (409): mensagem clara e "Tentar de novo", que carrega as peças
  do processo e repete. Sem listagem ao abrir, a tela carrega as peças do processo.
- Divisor arrastável (e por teclado), largura lembrada e sempre limitada à janela;
  no celular a lista ocupa a tela e a peça abre em tela cheia com "voltar".
- Teste de navegador (Chromium, `playwright-core`, `axe-core` como dependências de
  desenvolvimento): cliques rápidos geram UM lote no tribunal falso; montagem com
  clique no meio; 403; 409; teclado; celular; divisor; axe nos temas claro e escuro.

### Alterado

- **Substitui o painel "Ler peças ao lado".** O botão do cartão das peças agora é
  "Pasta digital". Saíram `scriptLeitor.ts`, `estilosLeitor.ts`, as caixas de marcar
  na linha do tempo, "Reabrir o PDF já pronto" e o recorte por extratos na
  interface (as rotas da API continuam).
- O servidor só diz **"baixando"** quando a consulta ao tribunal de fato saiu; antes
  disso o pedido está "na fila" (um job em andamento, a pausa de 3 s).
  `ServicoLeitor.consultarLote` ganhou o aviso de início.
- O job do leitor confere a guarda por peça antes de CADA lote: uma peça aberta por
  clique durante a montagem não é baixada duas vezes.

---

## [0.33.0] — 2026-10-03

Pasta digital — **backend** (Parte 1). A tela (lista à esquerda, visualizador à
direita) vem na Parte 2; até lá o botão "Ler peças ao lado" continua como era.
Especificação: `docs/ajustes-e-pasta-digital-especificacao-v1.0.0.md` (seções 5 a
10). Medições: `docs/pasta-digital-medicoes-v0.33.0.md`.

### Adicionado

- **Abrir UMA peça ao clique.** `POST /v1/processos/:numero/pasta/pecas/:pecaId`
  pede só aquela peça ao tribunal (método em lote, lote de 1), guarda e serve em
  `GET …/arquivo` (PDF com `Range`, para o PDF.js). 200 = já estava em guarda,
  nenhuma chamada ao tribunal; 202 = na fila. HTML do tribunal vira texto no
  servidor e imagem vira página de PDF **na entrada** — o original não fica.
- **O clique não é uma chamada.** `ServicoPasta` guarda um pedido pendente por
  (workspace, processo): clique em peça diferente troca o pendente e só o último,
  depois de `PASTA_DEBOUNCE_MS` (400 ms), vai ao tribunal. Sem pré-busca; sem
  retry (a falha vira o estado da peça, com o motivo; 403 carrega a hora de volta).
- **Guarda por peça** (`GuardaDePecas`, `pasta_pecas`): por workspace, nome
  aleatório, fora do diretório servido e do backup, TTL de `LEITOR_TTL_HORAS`,
  limpeza pelo `Agendador`, e a MESMA cota por workspace do PDF combinado — a
  regra de substituição da v0.31.1 agora vale para os dois (e nunca tira o que um
  job em andamento usa). Peça e processo sob sigilo nunca são guardados.
- **Lista da Pasta** (`GET …/pasta`): todas as peças na ordem dos autos com
  estado (`nao_baixada`, `na_fila`, `baixando`, `disponivel`, `nao_obtida`
  com motivo, `sigilo`), intervalo de páginas quando o PDF montado existe, totais
  SEM filtro, pausa do tribunal e procedência (`aoVivo: false`). Não consulta o
  tribunal: lê a listagem gravada quando a tela carrega as peças do processo
  (`pasta_listagens`).
- **Montar pasta completa** (`POST …/pasta/montar`): job do leitor para todas as
  peças; só as não sigilosas fora da guarda vão ao tribunal, e o estado de cada
  peça muda conforme os lotes chegam. Idempotente.
- **Baixar as marcadas** (`POST …/pasta/baixar`, e `…/baixar/previa` para dizer
  antes quantas peças serão buscadas): junta na ordem dos autos, com índice
  próprio, usando a guarda e buscando só o que falta — tudo em guarda custa zero
  consultas. Nome: `processo-<número>-pecas-selecionadas.pdf`.
- Erros de domínio: `ListagemDaPastaAusenteError` (409),
  `PecaDaPastaNaoEncontradaError` (404, igual para "não existe" e "é de outro"),
  `PecaSigilosaNaoGuardadaError` (403), `PastaSemPecasParaJuntarError` (409).
- Motivos de peça não obtida: `sem_habilitacao` e `bloqueio_do_tribunal`.
- `PASTA_DEBOUNCE_MS` em `.env.example`.

### Alterado

- **Toda chamada ao tribunal sai por uma fila só** (`ServicoLeitor.consultarLote`):
  a pausa de 3 s passa a valer entre TODAS as chamadas — as do job e as dos
  cliques —, não só entre as do mesmo job. Continua um único `MniAdapter`, um
  balde, um disjuntor de 403.
- **O leitor guarda cada peça baixada na guarda por peça** (já como PDF) em vez da
  pasta de trabalho do job: a peça pode ser aberta antes de o combinado ficar
  pronto, e peça já guardada não volta ao tribunal. O índice continua dizendo
  `convertida`/`html_convertida`. O job ganhou `finalidade`
  (`pasta_completa` | `selecionadas`; ausente = seleção livre da v0.31).
- `visaoDoJob` ganhou `finalidade`. `ProvedorDePecas` ganhou `pausadoAte?()`
  opcional. `ArmazemDoLeitor` ganhou `gravarArquivo`, `apagarArquivo` e
  `removerTemporarios`.

### Observação de capacidade

Uma pasta completa ocupa **o dobro** do PDF combinado em disco (peças em guarda +
combinado). Com o teto de 300 MB por PDF, até ~600 MB dos 1 GB da conta. Ver
`docs/pasta-digital-medicoes-v0.33.0.md`.

---

## [0.32.1] — 2026-10-02

Três ajustes pedidos por advogados que usaram o sistema. Especificação:
`docs/ajustes-e-pasta-digital-especificacao-v1.0.0.md` (seções 2 a 4).

### Alterado

- **Atualizações: uma linha por processo.** A atualização mais recente fica em
  destaque e as anteriores do mesmo processo ficam atrás de "+N anteriores", que
  expande na própria linha. A janela padrão é de 15 dias (`NOVIDADES_JANELA_DIAS`),
  com a alternância "Últimos 15 dias | Todas" e o aviso "N atualizações mais
  antigas não mostradas". Nada é descartado, e `exigeAcao` não filtra: ele só
  MARCA — uma anterior que pede providência avisa no botão fechado e continua
  marcada depois de aberto. Menu e painel seguem contando atualizações não
  vistas, não linhas. `GET /v1/novidades` ganhou `grupos`, `janelaDias`,
  `janelaPadraoDias` e `foraDaJanela` (`?janela=todas` desliga a janela); o campo
  `novidades` continua, achatado. A tela mora em `ui/atualizacoes.ts`.
- **Tela do processo:** o card "Peças do processo" vem logo depois dos dados do
  processo (capa e ficha). Os demais blocos mantêm a ordem relativa.
- **"Pede providência": janela de 30 para 10 dias**, configuração única
  `PENDENCIA_JANELA_DIAS` lida pelo selo da carteira, pelo card do painel e pelo
  bloco da tela do processo (o servidor entrega o valor: `cards.pendenciaJanelaDias`
  em `/v1/painel` e `pendenciaJanelaDias` em `/v1/facetas`). O bloco lista só os
  atos dentro da janela e diz quantos atos anteriores que pedem providência ficaram
  de fora ("veja na linha do tempo"), que continua marcando todos. Não é cálculo
  de prazo.

### Adicionado

- `NOVIDADES_JANELA_DIAS` (15) e `PENDENCIA_JANELA_DIAS` (10) em `.env.example`.
- `domain/entities/agruparNovidades.ts` (agrupamento e janela, relógio injetado).

---

## [0.32.0] — 2026-10-02

Calendário: agenda por workspace, com eventos lidos dos andamentos (sugeridos,
a confirmar) e eventos criados pelo advogado, numa tela do console e num feed
ICS assinável. Especificação: `docs/calendario-especificacao-v1.1.0.md` (a v1.0.3 foi renomeada e ganhou a seção 17).

### Adicionado

- **Detecção de eventos nos andamentos** (`domain/entities/deteccaoDeEventos.ts`),
  função pura: só data EXPLÍCITA (`dd/mm/aaaa`, `dd/mm/aa`), com hora opcional
  (`14:30`, `14h30`, `14h`, `14 horas`), colada a um gatilho na mesma frase —
  audiência (conciliação, instrução, julgamento, una…), perícia/pericial,
  sessão de julgamento. Prazo só com data final escrita ("até 20/10/2026");
  **"prazo de N dias" não gera evento** — o sistema não calcula prazo. Data
  passada, data que não existe, ano a mais de 3 anos, dois tipos de gatilho na
  mesma frase e data alternativa presa ao mesmo gatilho não geram nada.
  "Cancelada", "retirada de pauta", "redesignada", "adiada" e "desmarcada" não
  criam sugestão: marcam para revisão os eventos detectados antes, do mesmo
  processo e tipo. O trecho guardado como procedência sai sem nome de parte
  nem de advogado e sem CPF/CNPJ.
- **Ingestão sem poder derrubar o sync.** Um decorator sobre a porta das pastas
  (`application/services/ingestaoDoCalendario.ts`) roda a detecção depois de
  toda gravação de retrato — varredura, "acompanhar" e vigilância por OAB —,
  relendo os andamentos dos últimos 180 dias. Falha vai para o log; a
  sincronização segue. Idempotente pelo índice único da chave de detecção, que
  cobre também os descartados.
- **Redesignação com data nova vira sugestão** (decisão do dono, spec v1.0.3):
  "audiência redesignada para o dia 20/11/2026 às 14h" sugere a data nova e
  mantém a antiga marcada para revisão. Duas datas na frase: vale só a que vem
  logo depois de "para"; se não for claro, não gera.
- **Tela do calendário** (`ui/calendario.ts`, arquivo próprio — `script.ts`
  não cresceu): item "Calendário" no menu; visões Agenda (padrão) e Mês, com
  anterior/próximo/hoje; sugerido com rótulo escrito "Sugerido", procedência
  ("lido do andamento de dd/mm/aaaa"), trecho e "ver o andamento" (abre o
  processo e destaca o andamento na linha do tempo); Confirmar, Editar,
  Descartar; aviso de revisão; descartados fora da lista com a contagem dita;
  formulário de evento com busca na carteira; painel "Assinar no meu
  calendário" (criar, regenerar, revogar, copiar a URL mostrada uma vez,
  incluir sugeridos, instruções para Google, Outlook e Apple). Sem o recurso no
  plano, a mensagem do servidor e o resto do console igual.
- **`/?processo=<número>`** abre a tela do processo — é o link da descrição do
  evento no feed.
- **`PATCH /v1/calendario/feed`** altera só "incluir sugeridos", sem trocar o
  token.
- **Preenchimento retroativo** pelo `Agendador` (de hora em hora, só banco):
  relê os andamentos já gravados de cada workspace uma vez.
- **Rotas** `GET/POST /v1/calendario/eventos`, `PATCH /v1/calendario/eventos/:id`
  (editar; `estado: "confirmado"` confirma), `POST .../:id/descartar`,
  `POST/GET/DELETE /v1/calendario/feed`. Intervalo máximo de 400 dias; a
  listagem devolve `totalNoIntervalo` (sem o filtro de estado) junto.
- **Feed ICS público** em `/calendario/feed/<token>.ics` — fora do `/v1`, porque
  a URL vive anos no calendário de quem assina. Token de 32 bytes, só o SHA-256
  no banco, URL completa mostrada uma vez, comparação em tempo constante,
  limite de 120 requisições/min por IP, `Cache-Control: private, max-age=300`,
  sem cookie. Token inválido, revogado, assinatura bloqueada ou plano sem o
  recurso: o MESMO 404. RFC 5545: CRLF, dobra em 75 octetos, escapes, `UID`
  estável, `SEQUENCE`, `VTIMEZONE` fixo em -03:00, dia inteiro sem deslocar o
  dia, `CANCELLED` por 30 dias, janela de -30/+365 dias. O feed leva só tipo e
  número do processo — sem nome de parte, trecho ou observação; processo em
  segredo de justiça vai sem número.
- **Recurso `calendario`** em todos os planos: na semente e, por retrocarga
  ÚNICA no arranque (marca em `estado`), em todo plano já gravado. Plano criado
  pelo painel o inclui por padrão. O operador pode tirá-lo depois; o arranque
  seguinte respeita.

### Alterado

- O log de acesso registra o PADRÃO da rota do feed (`/calendario/feed/:arquivo`)
  em vez do caminho: o caminho é o token.

### Dependência de desenvolvimento

- `ical.js` (o parser de iCalendar do Thunderbird), só nos testes, para validar
  o feed com um leitor independente.

## [0.31.2] — 2026-10-02

Diagnóstico do DataJud: o `GET /ready` reprovava a fonte ("timeout ao contatar
a API do CNJ") enquanto as consultas reais funcionavam no mesmo minuto.

### Alterado

- **Timeout na verificação de saúde do DataJud vira "lenta", não "fora do
  ar".** O diagnóstico devolve `saudavel: true, lenta: true` e um motivo que
  explica o índice frio do CNJ (20,5s medidos) e o teto maior das consultas.
  Falha de rede (conexão recusada, DNS), chave recusada, 429 e 5xx continuam
  reprovando. O `/ready` mostra `lenta: true` na fonte e segue 200; `cli saude`
  imprime `LENTA`.
- **Teto da verificação de 15s para 30s**, configurável em
  `DATAJUD_TIMEOUT_VERIFICACAO_MS` (novo, em `.env.example`). As consultas
  continuam com `DATAJUD_TIMEOUT_MS` (60s).

O resultado da verificação só informa (`/ready`, `cli saude`): a escolha da
fonte numa consulta não depende dele (`verificarSaude` está desligado no
composition root).

## [0.31.1] — 2026-10-02

Ajustes do leitor de peças pedidos depois do teste do dono com a 0.31.0.

### Alterado

- **Remarcar.** "Ler peças ao lado" abre com **"Nova seleção"** e, quando há
  um PDF guardado no prazo, **"Reabrir o PDF já pronto"** com a data e a hora
  em que foi montado. A seleção nova começa com **todas as caixas desmarcadas**
  (antes vinha com a seleção anterior, e remarcar virava desmarcar uma a uma);
  **"Limpar seleção"** fica sempre à mão, e **"Repetir a seleção anterior"** é
  um botão separado. O botão do topo do painel passou de "Marcar peças" a
  "Nova seleção".
- **Peça já guardada não volta ao tribunal.** Numa seleção nova, a peça que
  está em algum PDF deste processo ainda no prazo tem as páginas copiadas de
  lá; só a realmente nova é pedida — o mesmo caminho do "Atualizar". A tela diz
  quantas das marcadas são reaproveitadas, e a estimativa de tempo conta só as
  outras. `GET /v1/processos/:numero/leitor` passou a devolver também `pronto`
  (o PDF guardado mais recente) e `reaproveitaveis` (ids).
- **A seleção nova gera PDF NOVO e o anterior fica** até o próprio prazo (24 h).
  Só a atualização substitui o PDF de que partiu. **Regra de substituição pela
  cota:** com a conta no limite, saem primeiro os PDFs mais antigos de OUTROS
  processos, depois os deste; nunca um PDF de que uma combinação em andamento
  ainda vai copiar páginas (a limpeza do prazo também espera). Se nada puder
  sair, 413 antes de qualquer consulta. Antes, cota cheia era sempre recusa.

### Adicionado

- **"Baixar selecionadas (N)"**, no painel do PDF pronto ("Baixar só algumas
  peças deste PDF"): gera um PDF só com as páginas das peças marcadas,
  **recortadas do PDF guardado** — nenhuma consulta ao tribunal. Ordem dos
  autos, índice próprio contado do arquivo gerado, linearizado, nome
  `processo-<numero>-pecas-selecionadas.pdf`. Mesmo isolamento por workspace,
  mesma cota e mesmo prazo do PDF de origem (até 3 recortes por PDF). Rotas:
  `POST /v1/processos/:numero/leitor/:jobId/extratos` e
  `GET .../extratos/:extratoId/pdf` (com `Range`).
- `PdfDoLeitorExpiradoError` (**410**): o PDF de origem já saiu do disco. A tela
  diz isso e manda montar de novo pela "Nova seleção" — nunca baixa de novo em
  silêncio. `PecasForaDoPdfError` (400) para peça que não está naquele PDF.
- Motivo `origem_expirada` no índice: a peça seria reaproveitada de um PDF que
  foi apagado entre a listagem e a montagem — vira página de aviso, não erro.

### Corrigido

- **"Fechar" e "Baixar PDF" cortados na borda direita.** Medido no Chromium: o
  `<select>` "Ir para a peça" tem a largura da opção mais longa (728 px com
  rótulo longo do TJGO) e passava da borda do painel em qualquer janela, de
  1500 a 600 px de largura; e a largura arrastada no divisor, guardada no
  navegador, podia ser maior que a janela atual. Agora o painel usa
  `min(largura, 100vw)`, a largura guardada é ajustada à janela (sem perder a
  preferência), e nada dentro do painel empurra a borda (`min-width: 0`).
- Fechar e reabrir o painel sem a tela redesenhar deixava a seleção sem peças
  ("0 peças marcadas" ao clicar nas caixas).
- Um PDF novo que ficava pronto com outro PDF aberto no painel não era
  carregado: o painel continuava mostrando o anterior.

## [0.31.0] — 2026-10-01

Leitor de peças, **Etapa 2 — ler ao lado** (especificação
`leitor-e-analise-especificacao-v1.2.1`, seção 5). O PDF combinado da 0.30.0
abre num painel à direita da linha do tempo.

### Adicionado

- **Botão "Ler peças ao lado"** no cartão das peças do processo. Sem clicar
  nele, a tela do processo é exatamente a de antes (decisão do dono: o painel
  abre por botão).
- **Marcar peças na linha do tempo**: uma caixa ao lado de cada peça, "Selecionar
  todas (N)" com o número do processo inteiro (não só o da tela filtrada),
  atalhos por rótulo do tribunal (Petição, Certidão, Decisão…), contador e
  **estimativa de tempo em faixa** calculada no servidor com os números medidos
  (lote crescendo 5, 10, 20 até lote sem crescer), dita como ordem de
  grandeza. Acima de `LEITOR_CONFIRMAR_ACIMA_DE` peças (150), confirmação.
  Peça sob sigilo aparece desmarcável e com o motivo.
- **Painel à direita** com divisor arrastável (largura guardada no navegador);
  no celular, tela cheia com "← linha do tempo" e botão flutuante para voltar.
  Em arquivo próprio (`ui/scriptLeitor.ts`, `ui/estilosLeitor.ts`), fora do
  `script.ts`.
- **PDF.js servido pelo próprio servidor** (`/ui/pdfjs/:arquivo`, lista fechada,
  pública por ser biblioteca sem dado), carregado por `import()` — a página
  continua sem `<script src>`. Usa o build **legacy** do `pdfjs-dist`: o padrão
  usa `Map.getOrInsertComputed`, recurso de 2025, e a página ficava em branco
  sem erro em navegador não atualizado.
- **Leitura por trechos** (`Range`, sem baixar o resto em segundo plano) e
  **renderização preguiçosa**: só as páginas perto da tela são desenhadas, no
  máximo 24 ficam na memória. Largura ajustada por página (o PDF mistura A4 e
  outros tamanhos), com a rolagem compensada quando uma página acima muda de
  altura.
- **Navegação pela linha do tempo**: ao lado de cada peça que está no PDF, um
  atalho "p. N" pula para ela; rolar o PDF destaca a peça na linha do tempo e
  mostra rótulo, posição e páginas. Lista "Ir para a peça…", busca de texto
  (sem acento e sem caixa; diz que página digitalizada não é pesquisável),
  zoom e "Baixar PDF".
- **Estados honestos**: na fila; baixando com progresso; montando; sem progresso
  há mais de 3 minutos ("sem progresso desde HH:MM"); pausado pelo tribunal
  com o horário previsto de retomada; parcial com a lista do que faltou e por
  quê; pronto com data e hora — sempre com "não é consulta ao vivo" e até
  quando fica guardado. Três falhas seguidas ao consultar o progresso param a
  consulta e oferecem um botão, em vez de girar para sempre.
- `GET /v1/leitor/estimativa?pecas=N` e `GET /v1/processos/:numero/leitor`
  (o último PDF deste processo, do próprio workspace).

### Testes

- ESLint roda dentro do script do painel, como no do console.
- O painel foi conferido num Chromium de verdade contra um servidor local com
  MNI falso e PDFs sintéticos: marcar, montar, abrir, pular para a página,
  destaque na régua, busca, divisor, celular e fechar (que devolve a tela ao
  estado original). Esse roteiro não está na suíte (exigiria navegador no CI).

## [0.30.0] — 2026-10-01

Leitor de peças, **Etapa 1 — combinar** (especificação
`leitor-e-analise-especificacao-v1.2.1`, seções 4, 7 e 8). O advogado marca
peças e o sistema entrega **um PDF único**, na ordem dos autos, com índice de
páginas. A tela (Etapa 2: painel ao lado, PDF.js) ainda não existe — esta
entrega é a API e o motor.

### Adicionado

- **Rotas do leitor**: `POST /v1/processos/:numero/leitor` (cria o job, 202,
  com estimativa de tempo pela medição), `GET .../leitor/:jobId` (progresso:
  baixadas, total, recusadas com o motivo, estado), `GET .../pdf` (com
  `Range`/`Accept-Ranges: bytes`, PDF linearizado), `GET .../indice` e
  `POST .../atualizar`. Toda resposta traz a procedência (MNI, quando foi
  baixado, identificador não reversível da credencial, `aoVivo: false`).
- **Download em lote adaptativo**: `obterConteudosEmLote` na porta
  `ProvedorDePecas`, várias peças numa consulta MNI (medido até 20). O
  primeiro lote é de 5 peças — o único pedido sem saber o tamanho das
  respostas —, e só dobra (10, 20) depois de uma resposta leve; resposta acima
  de `LEITOR_LOTE_MAX_RESPOSTA_MB` corta o próximo pela metade, e ele nunca
  volta a crescer. Peça ausente numa resposta
  com sucesso é pedida uma vez sozinha no fim; se continuar ausente, fica no
  índice como não obtida.
- **Disjuntor global de 403** no `MniAdapter`: um 403 pausa TODAS as consultas
  MNI por `MNI_PAUSA_APOS_403_MIN` (padrão 30), sem gastar nem ficha do balde.
  Jobs ficam `pausado_por_bloqueio` e retomam sozinhos; a rota avulsa responde
  503 com a hora de retomada.
- **Fila mínima em SQLite** (`jobs_leitor`): um job do leitor por vez no
  processo INTEIRO (trava de módulo, não só por credencial — dois jobs em
  paralelo somariam o pico de memória), sobrevive a redeploy sem baixar de
  novo o que já veio. O PDF não é apagado no logout, só pelo prazo ou na
  exclusão de conta.
- **Peças HTML viram páginas de texto** (estratégia A, decidida pelo dono
  depois da sonda de HTML). Tokenizador tolerante no servidor, sem DOM: `p` e
  `br` quebram linha, `hr` vira separador, negrito e sublinhado sobrevivem,
  entidades são decodificadas, UTF-8 com recuo para windows-1252, atributos
  ignorados, script/iframe descartados. Imagens não entram e a página diz
  quantas eram; caractere sem equivalente na fonte vira "?"; tabela vira
  "célula | célula". Tudo isso vai para o `motivo` da linha `html_convertida`
  do índice. 84 HTMLs de ~19 KB convertem em ~1,3 s.
- **Montagem com qpdf** (argumentos em vetor, linearizado): PDF entra como
  veio, imagem vira página, e o que não deu — vazio, corrompido, protegido,
  recusado, sigiloso, formato estranho — vira **página de aviso** com o
  motivo. As páginas do índice são contadas do arquivo gerado e conferidas.
- **Guarda temporária em disco** (`/dados/leitor`), por workspace, com prazo
  (24 h), cota (300 MB por PDF, 1 GB por workspace), nome aleatório, fora do
  backup, limpeza horária e registro do uso de disco no log.
- `qpdf` e `poppler-utils` na imagem.
- `scripts/sonda-html.mjs` (mede só a FORMA de 2–3 HTMLs reais, 2 requisições;
  `--seco` e `--help`; o histograma só imprime nomes de tag conhecidos) e
  `scripts/medir-conversao-html.mjs`.
- `pdftotext` (poppler) no CI, para os testes lerem o texto do HTML convertido. e `scripts/medir-memoria-lote.mjs`.
- `docs/leitor-medicoes-v0.30.0.md`: as medições (qpdf 37 MB contra +357 MB do
  pdf-lib para 160 MB de PDFs; memória do lote) e a proposta para HTML.

### Mudado

- **O PDF combinado fica em disco** — decisão do dono (29/09/2026) que reverte
  "nenhum arquivo de peça no nosso disco". A peça avulsa continua sem guarda.
  CLAUDE.md §8 reescrito; o teste que fixa as chaves do registro de downloads
  passa a dizer que vale para a peça avulsa.
- O leitor de MTOM devolve **vistas** sobre a resposta em vez de copiar cada
  anexo: ler um lote de 48 MB passou de +75 MB para +8 MB de memória.
- O 403 do MNI agora é `MniBloqueadoError` (continua sendo
  `ProviderIndisponivelError`, continua 503).

### Testes

- Os testes do leitor usam números de processo SINTÉTICOS (`9999901-96.2026.8.09.9999`),
  nenhum nome de pessoa e PDFs gerados por biblioteca. A primeira versão desta
  entrega reaproveitava um número real do TJGO de um teste antigo; foi trocado.

### Ainda não

- Processo em **segredo de justiça** não tem PDF guardado (padrão da
  especificação até decisão do dono).
- Não há exclusão de conta no produto; a limpeza do leitor para ela existe
  (`apagarDoWorkspace`) e está testada.

## [0.29.1] — 2026-09-29

Dois ajustes relatados pelo dono do produto logo depois de instalar a v0.29.0.

### Adicionado

- **Escolha de tema na lateral**: automático (segue o computador, como antes),
  claro ou escuro. Com o computador em modo escuro, não havia como ver o tema
  claro. A escolha fica guardada no navegador e é aplicada no `<head>`, antes
  de a página ser pintada — sem piscar do escuro para o claro ao abrir. A área
  administrativa respeita a mesma escolha.

### Corrigido

- **"+ rotular cliente" não fazia nada.** A edição do rótulo na própria linha
  era ligada só na tela de Atualizações, que não tem botão de rotular; na
  carteira, onde o botão aparece, o clique ficava sem resposta. O defeito vinha
  da v0.25.0 e ficou mais visível na v0.29.0, que transformou o texto das
  partes num botão tracejado. Agora a rotulagem é ligada na carteira, e há
  teste que falha se ela sair de lá.

## [0.29.0] — 2026-09-29

Visual novo, a partir do logo do Processo Vivo. Aprovado primeiro num
protótipo (entrada, painel e lista de processos, em tema claro e escuro) e só
depois levado ao código.

### Adicionado

- **Logo no sistema**: na lateral e na tela de entrada, e o símbolo como ícone
  da aba (sobre um quadrado branco, para não sumir na aba escura do
  navegador). O SVG original era a página inteira do CorelDRAW com cinco
  rascunhos e o texto em Verdana sem converter; a versão final foi separada e
  as letras viraram desenho com a própria fonte que vinha no arquivo — sem
  isso, "PROCESSO VIVO" aparecia em outra fonte em Linux e em parte dos
  celulares.
- **Fontes Plus Jakarta Sans e JetBrains Mono** (números de processo), servidas
  pelo próprio servidor em `/ui/fontes/…`. Nada vem de fora: o console continua
  abrindo atrás de firewall, e há teste para isso.
- **Tela de entrada dividida**: marca, o que o sistema faz e a promessa do
  aviso de silêncio à esquerda; formulário à direita. No celular, empilha.
  Recuperar senha, redefinir e entrar com chave usam a mesma casca.
- **Painel**: saudação com a data, selo de verificação ao lado do título
  (verde só quando a verificação está de pé; âmbar com a contagem de processos
  sem verificação), quarto card com as novidades não lidas, feed com bloco de
  data, e a trilha de liberação com barra de progresso e um botão por passo.
- **Lateral** azul-marinho nos dois temas, com ícones, e um cartão no pé com
  quem está dentro e até quando vai o teste.

### Mudado

- **Cores tiradas do logo, com um significado cada**: verde = verificado/em
  dia, azul = novidade, âmbar = pede providência, vermelho = erro e sigilo.
  "Pede providência" era vermelho e passou a âmbar: vermelho fica para o que
  é falha.
- **Lista de processos compacta**: linha de altura fixa, textos cortados com
  reticências (o texto inteiro aparece ao parar o mouse). As **partes ganharam
  coluna própria**, sempre visível — antes dividiam a coluna Cliente e sumiam
  quando a pasta ganhava rótulo. Pasta sem cliente mostra "+ rotular cliente".
- **Filtros da lista recolhidos**: à vista ficam a busca, Tribunal, Cliente,
  "Mais filtros" e "Com novidade". Parte, classe, período e ordem ficam em
  "Mais filtros", que mostra quantos estão valendo e não fecha enquanto houver
  algum ativo.
- No celular a navegação vira só ícones (o texto continua para leitor de
  tela), e a página não rola mais para o lado por causa da tabela.
- A área administrativa usa a mesma casca e o mesmo logo.

### Mantido de propósito

- **Tema escuro**, seguindo o computador do advogado, como antes.
- As telas de busca, processo, vigilância, acessos e conta receberam as cores e
  as fontes novas, sem mudança de estrutura.

## [0.28.0] — 2026-09-28

Planos de assinatura controlados pelo painel. Até aqui os três planos estavam
fixos no código, sem preço, e mudar qualquer coisa neles era deploy.

### Adicionado

- **Aba Planos na área administrativa**, com:
  - **Visão geral**: cada plano com preço, recursos, situação (à venda ou
    pausado) e quantos assinantes tem — ativos, em teste, em carência,
    vencidos e cancelados, pelo status derivado no instante da consulta.
  - **Editar** nome, descrição, preço mensal, recursos incluídos e ordem na
    lista. Vale na hora para quem já tem o plano; ao mudar recursos de um
    plano com assinantes, o painel pergunta antes de gravar.
  - **Criar plano** combinando os recursos que existem (consulta,
    acompanhamento, vigilância por OAB, peças).
  - **Pausar e colocar à venda.** Pausar tira da oferta; quem já tem o plano
    continua com ele, e ele ainda pode ser liberado à mão.
  - **Teste e carência**: dias de teste, qual plano o teste libera e dias de
    carência depois do vencimento.
- **Preço no plano**, em centavos (vazio = sem preço publicado). Aparece em
  `GET /v1/assinatura` (na lista de planos à venda e no resumo da assinatura)
  e na tela "Minha conta" do console, que também passou a mostrar os recursos
  pelo nome em vez do código interno.
- O seletor de plano da aba Assinaturas agora vem do catálogo, com a marca
  "(pausado)" e o preço de cada um.

### Mudado

- **Planos saíram do código para o banco** (tabelas `planos` e
  `regras_assinatura`). Na primeira subida, os três planos atuais entram como
  semente, com os mesmos códigos — nenhuma assinatura existente muda. Depois
  disso o catálogo é seu: a semente não é reaplicada.
- **A trava do plano de IA foi para o recurso.** Em vez de um `false` fixo no
  plano, o recurso "análise com IA" está marcado como ainda não implementado,
  e nenhum plano que o inclua pode ir à venda nem ser o plano do teste —
  inclusive um criado pelo painel.
- A mensagem de "seu plano não inclui" sugere o menor plano **à venda** que
  resolve, e não mais um plano pausado.
- As regras não são retroativas: o teste novo vale para contas criadas depois
  da mudança; a carência nova, a partir da próxima liberação de cada
  assinante.

### Corrigido

- **Quem assinava depois do teste ficava com zero dias de carência.** O teste
  não tem carência, e a renovação copiava a de quem renovava — então o
  primeiro vencimento de um assinante convertido cortava a vigilância na
  hora, sem os 7 dias que existem justamente para isso. Agora a liberação
  grava a carência das regras vigentes.
- **Mensagem da área administrativa desligada.** Saía como "O provider
  "admin" não suporta a operação "acessar"…"; agora diz direto o que fazer.

### Notas de migração

Nada a fazer. As tabelas novas são criadas e preenchidas na subida. Os planos
começam sem preço — preencha pelo painel quando quiser que o valor apareça
para o advogado.

## [0.27.0] — 2026-09-28

Área administrativa: um lugar único para o operador do sistema gerenciar
assinatura e chave de API pela web, sem depender de CLI nem de editar `.env` e
reiniciar o serviço.

### Adicionado

- **Painel `/admin`**, protegido por HTTP Basic Auth
  (`PROCESSOVIVO_ADMIN_USUARIO`/`PROCESSOVIVO_ADMIN_SENHA`). Autenticação
  inteiramente separada da sessão de assinante — hook próprio
  (`autenticacaoAdmin`), zero linha tocando `usuarios` ou `sessoes`. Sem as
  duas variáveis definidas, a área nem existe: `/admin` e `/admin/api/*`
  respondem 501 em vez de 404 ou de pedir credencial.
- **Aba Assinaturas**: listar todas com e-mail da conta, consultar por
  e-mail, liberar plano por N meses (mesma validação de plano e prazo do
  comando `assinatura liberar` do CLI), cancelar, e disparar os avisos de
  vencimento na hora — o mesmo que o agendador roda sozinho, sem esperar o
  próximo ciclo.
- **Aba Chaves de API**: emitir chave nova (o valor em texto puro aparece uma
  única vez, na resposta da emissão — nunca mais volta a aparecer, nem no
  log), listar (identificador e rótulo, nunca a chave) e revogar. Uma chave
  emitida aqui autentica nas rotas do assinante exatamente como uma chave de
  `PROCESSOVIVO_API_KEYS`: as duas calculam `identificador`/`workspace` a
  partir do mesmo hash SHA-256 (`chavesDeApi.hash`), e o plugin de
  autenticação principal aceita as duas fontes. Revogar derruba a
  autenticação daquela chave imediatamente.

### Por que Basic Auth, e não sessão de cookie

O `CLAUDE.md` já registrava por que este sistema nunca cria um campo
"administrador" booleano na tabela `usuarios` — o cadastro é aberto, e isso
seria construir, sem perceber, uma escalada de privilégio. Reaproveitar
`ServicoContas` e a sessão de assinante para o operador puxaria a mesma
mistura para dentro do código, ainda que sem o campo. Basic Auth resolve com
uma credencial fixa, um hook, e nenhuma linha tocando `usuarios` ou
`sessoes`: o navegador pede a senha uma vez e guarda para as chamadas
seguintes da mesma origem.

### Notas de segurança

- A senha administrativa precisa de pelo menos 16 caracteres — validado no
  arranque, junto com o resto da configuração. É a única credencial desta
  área, sem 2FA.
- `assinatura ver/liberar/cancelar/avisar` no CLI continua existindo, igual —
  a rota HTTP é um segundo caminho para o mesmo operador, não uma
  substituição.

## [0.26.1] — 2026-09-24

Conserto de um defeito que eu introduzi na v0.26.0, e a trava para a família
inteira dele.

### Corrigido

- **O painel quebrava ao carregar**, exibindo "Cannot read properties of null
  (reading 'addEventListener')" duas vezes. A causa foi um `+` perdido no fim de
  `h+='<div class="filtros">'` ao montar a tela nova: as linhas seguintes viraram
  uma expressão solta, o motor avaliou e descartou, e o bloco dos filtros nunca
  entrou no HTML. Os `id` que os listeners procuravam não existiam.
- **A caixa de erro disfarçava defeito nosso de falha do servidor.** Um
  TypeError solto dentro de um `.then` era engolido pelo `.catch`, e `erroBloco`
  imprimia a mensagem dele duas vezes — como título e como explicação, porque
  `explicar()` cai em `e.message` quando não há status. Era exatamente por isso
  que a mensagem chegava sem dizer onde. Agora ela distingue erro com `status`
  (do servidor) de erro de programação, diz que a falha é da interface e mostra
  a primeira linha da pilha.
- Data do painel montada por partes: o formato pronto do pt-BR dava
  "quinta-feira, 24 de set. de 2026", que em versalete espaçado vira uma linha
  de conectivo. Agora sai "quinta · 24 set 2026 · 18:26".

### A trava

`no-unused-expressions` entrou nas regras que `console-script.spec.ts` roda
DENTRO da string do console, com teste próprio. Nenhuma das outras pegava este
caso: não há variável indefinida, não há sintaxe quebrada, e para o `tsc` aquilo
é texto. Verificado reintroduzindo o bug — a regra aponta a linha exata.

O conserto também foi conferido num navegador de verdade, com Playwright, e não
só pelo teste.

## [0.26.0] — 2026-09-24

A tela inicial, a partir da mesma referência visual da v0.25.0. Dos quatro
pedidos, dois tinham dado e dois não tinham — um destes virou funcionalidade e o
outro continua fora.

### Adicionado

- **Data por extenso e hora no topo do painel**, com a frase que decide se dá
  para confiar na tela: "verificado às 08:12, há 40 min". A referência põe ali a
  edição do diário; para nós o número que importa é quando a carteira foi vista
  pela última vez. Se alguma pasta está com a verificação falhando, a contagem
  aparece na mesma linha, e o texto diz o que isso significa — que o silêncio
  daquelas deixou de querer dizer "nada aconteceu".
- **Três cards**: Processos ativos (arquivados fora da conta), Pedem
  providência e Peças baixadas hoje.
- **"Últimas atualizações"** como título do feed, que é o que ele sempre foi.
- **Registro das peças baixadas** — tabela nova, gravada no momento do
  download. Guarda METADADO e nunca o arquivo: são autos de processo, muitos em
  segredo de justiça, e custodiá-los criaria uma obrigação de guarda que o
  produto não precisa assumir. Destrava o card, o trilho da direita e:
- **"Já baixado" na régua temporal.** O ganho não é estético: baixar uma peça
  custa dezenas de segundos e uma requisição que carrega a senha do advogado,
  contando para o bloqueio da conta dele no tribunal. Quem não lembra se já
  puxou a contestação clicava de novo e pagava tudo outra vez. O botão continua
  clicável — a pessoa pode ter perdido o arquivo.
- **Terceira coluna**, com o que já foi puxado do tribunal. Ela só é montada
  quando há conteúdo para pôr nela; sem baixa nenhuma, a página fica de uma
  coluna só. Reservar espaço para bloco vazio foi erro meu na v0.22.0, e vão em
  branco no meio da página não é lido como "ainda não há dados".
- **`GET /v1/painel`** e **`GET /v1/pecas-baixadas`**.

### O que continua fora

**"Prazos em 48h" e "Prazos de hoje".** Não existe prazo cadastrado em lugar
nenhum do sistema — é a próxima entrega da fila. O que temos perto disso é
"pedem providência", que é o ato que ABRE um prazo, não o prazo, e o card diz
exatamente isso. Há teste que falha se a palavra entrar no contrato por
descuido. O segundo bloco do trilho nasce quando os prazos nascerem.

## [0.25.0] — 2026-09-24

A casca do console mudou de forma, a partir de um sistema de referência que o
dono do produto trouxe. O que veio de lá é a ESTRUTURA — lateral fixa, carteira
em tabela, um estado por pasta. O que ficou de fora veio junto na referência e
não entrou de propósito, com motivo em cada caso (ver o fim desta entrada).

### Adicionado

- **Barra lateral fixa** no lugar das abas na barra de cima. Não rola para fora
  da tela, cabe crescer, e mostra a contagem ao lado de cada destino — que era
  informação que exigia abrir a tela para descobrir. A contagem da carteira vem
  da resposta que a tela já pedia; nenhuma requisição nova. Abaixo de 900px ela
  volta a ser barra superior: numa tela estreita, 228px fixos comeriam um quarto
  da largura útil da tabela. O conteúdo passou de 900px para 1100px.
- **A carteira virou tabela** — Processo · Cliente · Tribunal · Última
  movimentação · Estado. O número em fonte monoespaçada com numeral tabular:
  os dígitos alinham e o olho acha o processo sem ler. Os cartões empilhados
  funcionavam com dez pastas e viravam rolagem com cento e quarenta.
- **Rótulo de cliente por pasta**, editável na própria linha (Enter grava, Esc
  cancela, vazio apaga), com filtro e busca livre. Rotular cento e quarenta
  processos é trabalho de uma sentada; um ida-e-volta por pasta viraria uma
  tarde.
- **Estado derivado por pasta**: providência, novidade, arquivado, em curso —
  mais um aviso de **não verificado** que corre por FORA do selo, porque uma
  pasta pode ter prazo aberto e estar três dias sem verificação, e as duas
  informações importam. Derivado na resposta, nunca gravado em coluna: mesma
  razão do status de assinatura.

### O que veio na referência e NÃO entrou

- **Selos de "Audiência" e "Trânsito em julgado".** Exigiriam ler código da TPU
  que nunca apareceu numa resposta real deste projeto. Um selo que erra na tela
  de um advogado é pior que coluna nenhuma — ele não confere o que o sistema
  afirmou com convicção. Entram quando houver captura que os sustente.
- **Tema escuro fixo e tipografia serifada de display.** O console segue a
  preferência do sistema, e muito advogado trabalha em sala clara. A serifada
  come ~120px de altura por título: num app usado o dia inteiro isso é uma
  linha de tabela por dia. Esse tom vai para a landing page.
- **Botão "baixar peças do dia".** Prometeria o que não se entrega: cada
  consulta ao MNI são dezenas de segundos e uma tentativa que conta para o
  bloqueio da conta do advogado no tribunal. Em 142 processos isso não existe.

### Notas de migração

A coluna `cliente` entra pelo `migrarColunas` e **não tem retrocarga**, ao
contrário do que a regra geral manda. A regra vale para coluna DERIVADA de dado
já guardado — `partes_texto` sai do JSON do processo, e sem retrocarga o filtro
enxergaria só o sincronizado depois. `cliente` não sai de lugar nenhum: o
tribunal entrega as partes sem dizer qual delas o consultante representa, e
deduzir pela OAB poria o nome do adversário na coluna. Vazio significa "ainda
não rotulado", que é a verdade. Há teste que fixa isso.

### Achado, não corrigido

O campo `apelido` existe em `acompanhamentos` desde o começo, é aceito pela rota
de acompanhar e entra na busca textual — e **não há nenhum lugar no console que
o preencha**. Segue como está; `cliente` não o substitui (apelido nomeia o caso,
cliente nomeia a pessoa, e só o segundo agrupa).

## [0.24.0] — 2026-09-24

A crítica veio de um advogado em exercício usando a tela, e é sobre rotina, não
sobre estética: ler "14/09 · Petição da parte" no andamento, memorizar a data e
rolar a página até o rodapé para caçar o arquivo no meio de 278 peças não
acontece na correria de um escritório. A lista de anexos no rodapé está
aposentada; a linha do tempo virou a espinha dorsal da tela.

### O obstáculo que eu tinha declarado — e por que ele era o obstáculo errado

Nas versões anteriores eu disse que casar peça com andamento não era
confiável. A razão continua correta: `Peca.movimento` é o identificador do
movimento **no MNI**, e a linha do tempo da tela vem do DataJud e do DJEN, que
numeram movimento de outro jeito e não têm campo em comum. Casar por data
penduraria a contestação embaixo do despacho errado.

O que faltava ver: **a resposta do MNI que traz as peças também traz os
movimentos** — 381 num processo real — e o mapper os descartava. Cada
`<documento>` aponta para o `identificadorMovimento` do `<movimento>` que o
juntou. A junção não atravessa fontes: é uma chave que o tribunal afirmou,
dentro de um único XML, sem consulta nova.

### Adicionado

- **Régua temporal: cada evento entrega o documento na própria linha.** Com a
  resposta do tribunal, a linha do tempo passa a ser montada dos movimentos do
  MNI, cada um já com os seus documentos e um botão de baixar por documento.
  `domain/entities/linhaDoTempo.ts`.
- **Filtro "Apenas andamentos principais".** Decide pelo POSITIVO — some só o
  que foi _identificado_ como cartório (juntada, expedição, conclusão,
  remessa). Nasce desligado, diz quantas linhas escondeu, e nunca esconde ato
  que exige providência nem ato que entrega documento.
- **Destaque da decisão.** Sentença, decisão, acórdão, despacho e homologação
  ganham fundo e selo próprios; o que pede providência ganha a régua de acento
  à esquerda, o mesmo recurso do cartão de alerta. "Juntada de cópia da
  decisão" NÃO é destacada: é cartório levando a decisão aos autos.
- **Nome do movimento emprestado da TPU.** O MNI manda `codigoNacional` e nem
  sempre a descrição; o DataJud manda o nome. Mesma tabela do CNJ, então
  emprestar não é dedução — é ler a tabela numa fonte que a tem. Sem isto a
  régua exibiria "Movimento 12265".
- **`listarAtos` na porta `ProvedorDePecas`** (opcional): peças e movimentos na
  mesma resposta. Fonte que não a implementa segue pelo caminho antigo.
- **`scripts/sonda-movimentos.mjs`**, para verificar a correspondência no
  tribunal real. Banco em `readOnly`, uma tentativa sem repetição, recusa de
  rodar sobre credencial já marcada como recusada.

### Corrigido

- **Clicar num filtro da linha do tempo consultava o MNI de novo.** Redesenhar
  o detalhe chamava `carregarPecas`, e cada chamada são dezenas de segundos e
  mais uma oportunidade de recusa contra a conta do advogado no tribunal. A
  régua agora fica em cache na página, com botão "Atualizar" para forçar.
- **Evento que entrega documento não é mais agrupado em "×4".** O contador
  esconderia quatro botões de download diferentes atrás de um número.

### Degradação deliberada

A correspondência `documento.movimento` ↔ `identificadorMovimento` está na
especificação do MNI 2.2.2 e foi vista num Projudi. O próximo tribunal pode
numerar de outro jeito, e nesse dia o sistema fica **pior, nunca quebrado**:
sem casar peça nenhuma, a tela volta a ser exatamente a anterior — linha do
tempo das fontes públicas e todas as peças na lista. Há teste para isso.

E a contagem de atos nunca diminui: a reconciliação entre a linha do tribunal e
a das fontes públicas é por balde (mesmo dia, mesmo código da TPU) e só
descarta enquanto o tribunal tiver pelo menos tantas linhas quanto a fonte
pública. Se o DataJud tem três juntadas num dia e o tribunal mandou duas, a
terceira fica. Duas linhas para o mesmo ato é incômodo visual; uma linha
ausente é prazo perdido.

## [0.23.0] — 2026-09-23

Tudo aqui saiu de UM processo real com 278 peças. A v0.22.0 pôs o resumo no
lugar certo e mostrou que o conteúdo dele não servia.

### Corrigido

- **"Origem não identificada" em 111 das 278 peças.** O classificador só olhava
  o texto do rótulo, e o TJGO manda `descricao="Outros"` nos anexos — 40% da
  lista sem origem, todas PDF, todas na data de uma petição. Agora a origem é
  deduzida pelo atributo **`movimento`**, que diz a qual ato o documento
  pertence: anexo e petição compartilham o número porque foram juntados no
  mesmo ato. Não é mais um chute de texto — é uma relação que a fonte afirma.

  Três regras mantêm isso honesto: só preenche o que está vazio, movimento com
  origens conflitantes não deduz nada, e peça sem `movimento` continua
  desconhecida. A tela diz quantas foram deduzidas, porque o que o tribunal
  afirmou e o que o sistema concluiu não podem virar a mesma coisa.

- **O resumo mostrava "Outros" quatro vezes.** As 5 mais recentes do processo
  medido eram 1 petição e 4 documentos sem rótulo — logo abaixo da frase que
  promete as peças das partes. O cartão passa a mostrar **as das partes**, que
  é o que ele existe para mostrar.

- **"baixar text/html"** no botão dos documentos do juízo. O rótulo tirava o
  prefixo `application/` do mimetype, o que resolve PDF e deixa o resto falando
  jargão. Agora sai PDF, HTML, imagem, documento ou texto.

## [0.22.1] — 2026-09-23

### Corrigido

- **Vão em branco na busca por número.** O resumo de peças da v0.22.0 reserva
  altura para não empurrar o texto quando a consulta ao tribunal volta — mas a
  busca avulsa por número nunca carregou peças (só a tela de processo
  acompanhado carrega), e o espaço reservado ficava vazio entre "Última
  movimentação" e "Partes".

  A correção não é carregar peças em toda busca: cada consulta ao MNI leva
  dezenas de segundos e carrega a linha do tempo inteira como pedágio, então
  quem digitasse cinco números seguidos dispararia cinco chamadas ao tribunal
  sem ter pedido peça nenhuma. Agora a busca avulsa **oferece** — um cartão com
  o botão "Buscar peças", que preenche o espaço e só chama o tribunal quando
  alguém pede.

## [0.22.0] — 2026-09-23

### Corrigido

- **"Nenhuma peça" deixou de ser dito quando o caso é falta de habilitação.**
  O MNI devolve `sucesso: true` com o cabeçalho completo e ZERO movimentos
  quando o acesso cadastrado não consta como representante nos autos — sem
  código de erro, sem aviso. Medido no TJGO: 3 KB para quem não é
  representante, 273 KB com 278 documentos para quem tem procuração, mesma
  consulta. A tela dizia "o tribunal não devolveu nenhuma peça", e o advogado
  concluía que o processo estava vazio. Agora responde **403
  `SEM_HABILITACAO_NOS_AUTOS`**, com a mensagem que diz o que conferir.
- **O botão de acompanhar em lote dizia "Acompanhar todos" e acompanhava os
  FILTRADOS.** Com um filtro ativo a tela mostrava três números — o total no
  título, "mostrando X de Y" no aviso e o botão — e só o botão não se
  explicava. Agora o rótulo conta: _"Acompanhar 7 selecionados"_, _"Acompanhar
  os 12 filtrados"_, _"Acompanhar os 130"_.

### Adicionado

- **Resumo das peças no topo da página do processo**, logo abaixo da última
  movimentação. Antes elas ficavam depois de até 381 andamentos: quem não
  rolasse até o fim concluía que o sistema não tinha peças — a conclusão mais
  cara possível, porque é o que distingue o produto. O bloco tem altura
  reservada, para não empurrar o texto quando a consulta ao tribunal volta.
- **As peças passam a ser ordenadas por data**, da mais recente para a mais
  antiga. Nem o serviço nem a tela ordenavam; elas saíam na ordem do tribunal,
  que não é cronológica.
- **Lista completa agrupada por origem** — juntadas pelas partes primeiro, que
  é a pergunta que traz o advogado às peças. "Origem não identificada" continua
  visível: sumir com peça porque a heurística não decidiu é como se perde
  prazo.
- **Seleção por caixa na busca por OAB**, com "marcar os N visíveis", selo
  **já acompanhando** em quem está na carteira (marcado e travado) e
  confirmação a partir de 20 processos — acompanhar 130 significa 130 consultas
  ao tribunal por varredura, contra a cota compartilhada do CNJ.

### Notas

- A linha do resultado da busca deixou de ser um `<button>` único: caixa de
  seleção dentro de botão é HTML inválido e os cliques se atropelam. Agora são
  duas áreas irmãs — a caixa e o corpo, que continua abrindo o processo.
- Nenhuma variável de ambiente nova, nenhuma migração de banco.

## [0.21.0] — 2026-09-22

### Adicionado

- **Planos e assinatura.** Três planos: **Acompanhamento** (consulta, carteira,
  vigilância por OAB e avisos), **Peças** (tudo isso mais as peças do processo)
  e **IA** (análise com sugestões). O de IA está modelado e **não está à venda**
  — a funcionalidade ainda não existe, e um teste automatizado falha no dia em
  que alguém mudar isso sem querer.
- **Teste de 14 dias em toda conta nova**, no plano Peças. É o plano que mostra
  o diferencial: um teste que só dá acompanhamento mostra ao advogado
  exatamente o que o concorrente também faz.
- **Carência de 7 dias** depois do vencimento, com tudo funcionando. Cortar a
  vigilância no minuto do vencimento — que costuma ser cartão recusado, não
  decisão de cancelar — faz o advogado deixar de receber aviso de prazo sem
  saber que deixou.
- **Avisos por e-mail** em três etapas: 3 dias antes de vencer, ao entrar em
  carência e ao ser bloqueado. Uma vez por etapa, e a etapa só é marcada depois
  que o envio é confirmado. O aviso de bloqueio diz, com todas as letras, que a
  partir dali **não receber e-mail deixou de significar que nada aconteceu**.
- `GET /v1/assinatura`: plano em vigor, status, vencimento e os planos à venda.
- Comando `assinatura` no CLI: `ver`, `liberar`, `cancelar` e `avisar`. A
  liberação é manual, depois do Pix — **não há rota HTTP para isso**, e é
  deliberado: ela exigiria um papel de administrador que o sistema não tem, e
  inventar "administrador" numa API de cadastro aberto é como se constrói uma
  escalada de privilégio sem perceber.
- Tarja de assinatura na tela inicial (só quando há o que dizer) e cartão
  permanente do plano em Minha conta.

### Alterado

- As rotas de peças e de credenciais de tribunal passam a exigir o recurso no
  plano: **403** com o nome do plano que resolve. Assinatura vencida devolve
  **402**, que é outra conversa — pagar o que já foi contratado, e não trocar
  de plano.
- `DELETE /v1/credenciais/:tribunal` continua liberado sem plano. Exigir plano
  para apagar credencial seria "pague para poder tirar seus dados".

### Migração

- **Toda conta que já existia ganha assinatura ativa no arranque**, no plano
  Peças, por um ano, sem ser teste. Sem isso a entrega viraria um bloqueio em
  massa: o advogado que usou o sistema ontem abriria hoje e encontraria "sua
  assinatura venceu" sobre a carteira que ele montou à mão. A retrocarga é
  idempotente e não toca em quem já tem assinatura.
- **Workspace sem assinatura não é bloqueado.** É o caso das chaves de API, que
  não têm conta e nunca terão assinatura — tratá-las como bloqueadas derrubaria
  as integrações no dia do deploy.
- Nenhuma variável de ambiente nova.

## [0.20.2] — 2026-09-18

**A mesma tradução enganou de novo, um nível mais fundo.**

Contra um servidor de e-mail com certificado TLS **vencido**, o diagnóstico da
v0.20.1 respondeu "quase sempre é SMTP_SECURE trocado" — uma variável sem
nenhuma relação com o problema. Encontrado em produção, não em teste.

A v0.20.1 já tinha corrigido a versão que decidia só pelo código do erro,
passando a olhar a mensagem. Mas casava a **palavra solta** `certificate`, e
por isso agrupou sob "porta TLS errada" tudo que mencionasse certificado.
Palavra solta é chute com outro nome.

### Corrigido

Quatro falhas de TLS que se pareciam e agora se distinguem, cada uma com o seu
conserto:

- `certificate has expired` → o certificado do servidor de e-mail está vencido;
  renove **no servidor**, não há o que configurar aqui.
- `self-signed` / `unable to verify` → certificado não confiável ou cadeia
  incompleta.
- `altnames` / `does not match certificate` → o nome do certificado não bate
  com o `SMTP_HOST`.
- `wrong version number` / `packet length` → aí sim é `SMTP_SECURE` trocado.

### A regra, agora completa

Ao traduzir erro de biblioteca: decida pela mensagem e não pelo código; case
pela **frase**, não por palavra solta; carregue o texto original junto sempre; e
sem evidência para o palpite, entregue o texto cru.

### Testes

De 499 para 502. O novo par decisivo põe `certificate has expired` e
`wrong version number` lado a lado e exige que só o segundo mencione
`SMTP_SECURE` — o teste que a v0.20.1 teria reprovado.

---

## [0.20.1] — 2026-09-18

**O comando `email` agora diz POR QUE falhou, em vez de apontar para o log.**

A v0.19.0 entregou um diagnóstico que, na falha, dizia "o motivo está no log
acima" — inútil para quem está num terminal de contêiner com o log em outra aba,
ou com `LOG_LEVEL` alto. Diagnóstico que depende de outro lugar não é
diagnóstico.

### Adicionado

- `Notificador.diagnosticar()` (opcional, no mesmo espírito do `diagnosticar()`
  do `ProcessoProvider`): abre a conexão, autentica e desliga, **sem mandar
  mensagem**. A maioria das falhas de SMTP acontece antes de a mensagem existir
  — porta bloqueada, senha errada, TLS na porta errada —, e tentar enviar para
  descobrir isso mistura dois problemas.
- O comando `email` confere a conexão antes de enviar e imprime a causa
  provável com o campo a mexer.

### Duas traduções estavam ERRADAS, e do jeito pior

Encontradas testando contra falhas reais, não em revisão de código:

- **`ESOCKET` era traduzido como falha de TLS.** O nodemailer usa esse mesmo
  código para conexão recusada. Contra uma porta fechada, a mensagem mandava
  mexer em `SMTP_SECURE` enquanto o problema era a porta — meia hora no lugar
  errado. Agora a decisão olha a MENSAGEM (`ECONNREFUSED`, `ETIMEDOUT`,
  `wrong version number`), não só o código.
- **`EDNS` não estava na lista.** É o código que o nodemailer usa para nome que
  não resolve; `ENOTFOUND` aparece só dentro do texto.

A regra que fica: **tradução que chuta é pior que o erro cru**, porque o erro
cru ao menos não desperdiça tempo. O texto original agora vai junto sempre, e o
palpite só aparece quando há evidência para ele.

### Testes

De 492 para 499, incluindo os dois casos de `ESOCKET` lado a lado — o teste que
a versão anterior teria reprovado.

---

## [0.20.0] — 2026-09-18

**Justiça do Trabalho: 24 TRTs e o TST.**

Verificado contra número real: `0011242-47.2021.5.18.0016`, TRT da 18ª Região.

O que faltava era **só configuração**. A chave pública do CNJ é a mesma para
todos os tribunais e o endereço de cada um é montado a partir da sigla
(`api_publica_trt18`). Não havia credencial nova, adapter novo nem acordo com
ninguém — havia duas listas desatualizadas: as siglas suportadas e o mapa J.TR
do número CNJ.

Durante meses a resposta a um advogado trabalhista foi "tribunal não suportado",
e isso passou por limitação de arquitetura quando era uma lista por atualizar.
Fica registrado no CLAUDE.md como coisa a conferir antes de dizer que o produto
não atende um segmento.

### Adicionado

- `TRT1` a `TRT24` e `TST` em `TRIBUNAIS_SUPORTADOS`.
- Mapa do segmento 5 (`5.01`…`5.24`, e `5.00` para o TST) em `NumeroCNJ`.

### O que isso muda no produto

Advogado trabalhista passa a ter consulta por número, acompanhamento, vigilância
por OAB e aviso de movimentação — **sem credencial nenhuma**, porque nada disso
depende de senha de tribunal. O que ele não tem é peça, que exige o endereço MNI
daquele tribunal e a credencial de um advogado habilitado nos autos; hoje só o
TJGO está montado assim.

### Testes

De 489 para 492. Entre eles, o número real do TRT18 e a conferência das 24
regiões uma a uma — a numeração do CNJ é posicional, e um erro de deslocamento
mandaria a consulta ao tribunal errado, que responderia "não encontrado",
indistinguível de processo inexistente.

Um teste **mudou de exemplo**: `recusa tribunal fora da lista suportada` usava a
Justiça do Trabalho como caso de tribunal não atendido. Passou a usar o segmento
9, que não existe na Resolução 65 do CNJ — assim ele mede o que sempre quis
medir, recusar antes de ir à rede, e não precisa de conserto a cada vez que a
cobertura crescer.

### Pendente de verificação

O TST (`5.00`) entrou pelo padrão, sem número real para conferir. Se o alias
`api_publica_tst` não existir, a consulta cai no fallback e o DJEN responde —
nada quebra, mas vale um teste com número real quando aparecer um.

---

## [0.19.0] — 2026-09-18

**`npm run cli -- email <destinatario>`: testar o envio sem gastar um link.**

Até aqui, a única forma de saber se o SMTP estava certo era pedir uma
recuperação de senha de verdade. E ela é, por decisão de segurança, a pior
ferramenta de diagnóstico possível: responde exatamente a mesma coisa tendo
enviado ou não, justamente para não contar nada a um curioso. O efeito colateral
é que também não contava nada a quem estava configurando o servidor.

O comando novo é o contrário: barulhento e específico.

```
remetente ..... contato@processovivo.com.br
servidor ...... processovivo.com.br:587 (STARTTLS)
endereço base . https://app.processovivo.com.br
canal ......... email-smtp

Enviado para eu@exemplo.com.br. Confira a caixa de entrada E o spam.

Recuperação de senha: LIGADA.
```

Ele imprime a configuração que está valendo, envia de fato, e separa os três
estados que antes se confundiam: SMTP ausente (código 2, com o que definir),
envio recusado pelo servidor de e-mail (código 2, com as causas comuns), e envio
aceito. Também avisa quando o SMTP funciona mas `PROCESSOVIVO_URL_BASE` está
vazia — caso em que a recuperação continua desligada, porque link relativo em
e-mail não leva a lugar nenhum.

### Adicionado

- Comando `email` no CLI.
- `Aplicacao.notificador` — o canal de saída cru, exposto para diagnóstico. O
  `ServicoNotificacao` decide QUANDO avisar; este é por onde a mensagem sai.

### Detalhe que já quebrou uma vez

A checagem de "o SMTP está configurado?" usa a mesma condição do composition
root — host e remetente definidos —, e **não** o nome do canal. A primeira
versão comparava com a string `'smtp'`, e o notificador se chama `email-smtp`:
o comando recusava uma configuração perfeitamente válida. Comparar com string
mágica o que já existe como condição é assim que se escreve um diagnóstico que
mente.

---

## [0.18.2] — 2026-09-18

**Conserta a aba Atualizações, que quebrava com "f is not defined".**

A tela inicial do console pintava o conteúdo e, logo em seguida, lançava
`ReferenceError`. O `catch` do carregamento trocava a tela inteira por uma caixa
de erro — por isso a barra de navegação aparecia certa e o conteúdo sumia.

### Corrigido

- Removido de `verNovidades()` um bloco de restauração de foco copiado da tela
  de processos. Lá existe um `f` com o estado do filtro; aqui esse `f` nunca foi
  declarado. Essa tela não tem campo de texto — só um chip e um select —, então
  não há foco a restaurar e o bloco não tinha o que fazer ali.
- O defeito entrou na v0.16.0 e só apareceu agora porque a produção pulou da
  v0.14.0 direto para a v0.18.0.

### A lacuna que o permitiu, agora fechada

O console é JavaScript dentro de um `String.raw`. Isso é decisão de arquitetura,
e boa: sem build, sem bundler, sem `node_modules` na imagem. O preço é que **nem
o `tsc` nem o ESLint enxergam uma linha dele** — para as duas ferramentas aquilo
é texto. O bug passou por `typecheck` limpo, `lint` limpo e 486 testes verdes.

`tests/http/console-script.spec.ts` agora extrai a string e roda o ESLint dentro
dela, com os globais de navegador, checando `no-undef`, erro de sintaxe e
parentes próximos. Não substitui um teste de navegador, mas pega a família
inteira de erros que este bug representa: variável não declarada, nome digitado
errado, sintaxe quebrada. Verificado reintroduzindo o defeito — o teste aponta a
linha e o nome da variável.

### Testes

De 486 para 489.

---

## [0.18.1] — 2026-09-18

**Corrige a falha que a v0.18.0 causou em produção: banco vazio, em silêncio.**

A v0.18.0 trocou o caminho padrão do banco no `Dockerfile`, de
`/dados/lexflow.db` para `/dados/processovivo.db`. A compatibilidade que eu tinha
escrito cobria as variáveis declaradas no painel — e não cobria o padrão da
imagem, que é justamente de onde a instalação em produção tirava o valor.

O resultado foi o pior modo de falhar que este sistema tem: o SQLite criou um
arquivo NOVO e VAZIO, o serviço subiu saudável, o health check passou, e a
carteira apareceu em branco — com 1,2 MB de dados intactos no arquivo ao lado,
invisíveis. Nada produziu erro. Foi preciso consultar o banco para descobrir.

### Corrigido

- **`abrirBanco` recusa iniciar** quando o banco configurado não existe, ou
  existe e está sem nenhum dado, **e** há um banco com o nome antigo na mesma
  pasta com dados dentro. A mensagem traz os dois caminhos e as três saídas
  possíveis, prontas para copiar.
- A verificação acontece em **duas passagens**, e a segunda é a que importa:
  antes de abrir, o sinal é "o arquivo não existe"; depois de abrir e criar o
  esquema, o sinal é "o arquivo existe e está vazio". Sem a segunda, a proteção
  valeria no primeiro deploy e ficaria calada em todos os seguintes — ou seja,
  justamente em quem já tropeçou.
- `PROCESSOVIVO_BANCO_NOVO=true` reconhece um banco novo proposital e desliga a
  checagem.

### A regra que fica

**Entre subir vazio e não subir, não subir.** Um serviço fora do ar por dez
minutos é um incidente comum; um serviço no ar mostrando a carteira em branco é
o cliente achando que perdeu o trabalho dele — e essa diferença é confiança no
produto, que não volta com um redeploy.

O corolário para renomeações futuras: **valor padrão dentro da imagem é
configuração que ninguém lembra que existe.** Renomear uma variável no painel é
visível; mudar o `ENV` do `Dockerfile` muda o comportamento de toda instalação
que não a declara, sem nenhum sinal.

### Testes

De 478 para 486. Entre eles, o segundo arranque com o arquivo vazio já criado —
o estado exato da produção quando o problema apareceu.

---

## [0.18.0] — 2026-09-17

**O produto agora se chama Processo Vivo.**

O domínio `processovivo.com.br` foi comprado, e o nome mudou em todo lugar:
interface, e-mails, cookie de sessão, cabeçalhos HTTP, nomes de arquivo de
backup, variáveis de ambiente, `package.json`, CLI e documentação.

Feito AGORA, e não depois, por um motivo específico: três destas coisas ficam
caras assim que houver o primeiro assinante. Trocar o nome do cookie desconecta
todo mundo; trocar o caminho do banco exige mexer no arquivo dentro do volume; e
trocar as variáveis de ambiente arrisca um deploy quebrado. Hoje não há
assinante, então o custo é meia hora. Em um mês seria um aviso a clientes.

### Mudou

- `LexFlow` → `Processo Vivo` em toda a interface e em todos os e-mails.
- Cookie de sessão: `lexflow_sessao` → `processovivo_sessao` (e
  `__Host-lexflow_sessao` → `__Host-processovivo_sessao` em HTTPS). **Isto
  desconecta todas as sessões abertas, uma vez.**
- Cabeçalhos de procedência: `x-lexflow-fonte` e `x-lexflow-cache` →
  `x-processovivo-fonte` e `x-processovivo-cache`.
- Variáveis de ambiente: prefixo `LEXFLOW_` → `PROCESSOVIVO_`.
- Arquivo do banco, por padrão: `lexflow.db` → `processovivo.db`.
- Arquivos de backup: `lexflow-<data>.db` → `processovivo-<data>.db`.
- `PROCESSOVIVO_URL_BASE` passa a apontar para `app.processovivo.com.br`: o
  sistema vive no subdomínio e a raiz fica para a página de vendas. Os links dos
  e-mails de recuperação valem uma hora — não podem apontar para um endereço que
  ainda vai ser reformado.

### Compatibilidade, de propósito

- **As variáveis `LEXFLOW_*` continuam funcionando**, e o log avisa em `warn`
  qual trocar. Com as duas definidas, vence a nova. Sem isso, uma variável
  esquecida no painel derrubaria ou corromperia o deploy — e cada uma falharia
  de um jeito diferente: sem a chave de API o processo nem sobe; sem a chave do
  cofre as peças somem em silêncio; sem o caminho do banco o sistema abre um
  arquivo NOVO e vazio ao lado do que tem os dados, e a carteira parece ter
  evaporado.
- **A poda de backup continua reconhecendo `lexflow-<data>.db`.** Sem isso, a
  pasta guardaria as sete cópias novas MAIS todas as antigas, para sempre,
  enchendo justamente o volume onde mora o banco.

### Documentação

- Nova seção no `DEPLOY.md`: **"Migrar uma instalação que era LexFlow"** — passo
  a passo com os dois lugares onde dá para perder dados sem receber erro nenhum
  (renomear o volume no Easypanel, e apontar o caminho do banco para um arquivo
  que não existe).
- A aba Domains agora documenta o app no subdomínio e explica por que a landing
  não divide origem com a tela onde o advogado digita a senha.

### Testes

De 472 para 478. Os novos cobrem a compatibilidade das variáveis (nome antigo
aceito, nome novo tendo precedência, variável vazia não contando como definida)
e a poda das cópias de backup com o nome antigo.

---

## [0.17.0] — 2026-09-17

**Backup do banco e recuperação de senha — o que faltava para vender.**

Até aqui, duas coisas travavam a venda por motivos que não são técnicos: um
assinante que esquecesse a senha só voltava se eu mexesse no banco dele, e o
dia em que o volume do VPS falhasse seria o dia em que a carteira de todos os
clientes deixaria de existir. Nenhuma das duas aparece numa demonstração, e as
duas aparecem no primeiro problema real.

### Adicionado

- **Backup automático do banco**, ligado por padrão: uma cópia por dia, sete
  guardadas, em `/dados/backups/`. `BACKUP_INTERVALO_HORAS` e `BACKUP_MANTER`
  controlam; 0 desliga. Também sob demanda: `npm run cli -- backup`.
- **Recuperação de senha por e-mail.** Link de uso único, válido por uma hora,
  no máximo cinco pedidos por conta por hora. Quem redefine já entra, e todas
  as sessões anteriores caem.
- **Telas de "esqueci minha senha" e "escolher nova senha"** no console.
- `GET /v1/senha/recuperar` diz se **esta instalação** consegue enviar e-mail.
  É o que permite a interface esconder o link em vez de prometer o que não vai
  cumprir.
- **Seção 6 do DEPLOY.md**: procedimento de restauração passo a passo, custódia
  da `PROCESSOVIVO_CREDENCIAL_CHAVE` e o que fazer para tirar a cópia do VPS.

### Decisões que moldaram o código

- **A cópia é feita com `VACUUM INTO`, não copiando o arquivo.** Em modo WAL,
  uma escrita recente vive no `-wal` até o checkpoint: copiar o `.db` cru
  devolveria um arquivo que abre, parece íntegro e está desatualizado. Há teste
  que prova a diferença.
- **Toda cópia é aberta e conferida** (`PRAGMA integrity_check` + contagem de
  contas) antes de ser aceita; a que não passa é apagada. Backup que ninguém
  abriu é suposição.
- **O backup mora no mesmo volume do banco, e isso está escrito como limite, não
  como recurso.** Protege contra erro de operação e arquivo corrompido; não
  protege contra perder o volume. O CLI avisa isso em toda execução, por stderr.
- **O pedido de recuperação responde sempre 202, com a mesma mensagem** — conta
  existente, inexistente, e-mail malformado, limite estourado ou SMTP fora do
  ar. Qualquer diferença observável transformaria uma rota pública e sem senha
  no verificador de assinantes do Processo Vivo.
- **Link inválido, vencido e já usado dão a mesma resposta.** Distinguir "já
  usado" contaria a quem achou o e-mail meses depois que aquele link foi real.
- **A senha nova é validada antes de o link ser consumido.** Do contrário um
  erro de digitação queimaria o link, e o limite de cinco por hora transformaria
  isso em ficar de fora da própria conta.
- **O token sai da barra de endereço assim que a página carrega**
  (`history.replaceState`). Na URL ele entraria no histórico, num favorito, numa
  captura de tela e no cabeçalho `Referer` de toda requisição externa.
- **Trocar a senha pelo painel mata os links de recuperação pendentes.** É
  justamente quem desconfia de invasão que troca a senha.
- **O endereço do link vem de `PROCESSOVIVO_URL_BASE`, nunca do cabeçalho `Host`.**
  Senão bastaria mandar outro `Host` para o servidor enviar, com a nossa cara,
  um link apontando para o endereço de quem atacou.
- **Sem SMTP a funcionalidade não existe, e a interface não a oferece.** Aceitar
  o pedido, dizer "enviamos um e-mail" e não enviar nada é pior do que não ter.

### Testes

De 446 para 472. Entre eles, um que **restaura de fato**: apaga o banco e os
arquivos do WAL, copia o backup por cima e sobe pelo mesmo `abrirBanco` da
produção, conferindo que as contas, os `workspace` e a carteira voltaram — e que
o banco restaurado aceita escrita nova. Procedimento de restauração que ninguém
executou é um palpite, e a hora de descobrir que ele não funciona não pode ser a
hora em que o banco sumiu.

### Achados de uma revisão de segurança adversarial, todos corrigidos

Antes de fechar a versão, o fluxo inteiro foi revisado por um segundo par de
olhos com a instrução de tentar quebrá-lo. Achou seis coisas. As duas primeiras
eram graves e teriam ido para produção:

- **O token de recuperação ia para o log de acesso.** O link é
  `GET /?recuperar=<token>`, e o servidor registrava a URL inteira em nível
  `info` — token válido, de uso único, com uma hora de vida, escrito no log do
  contêiner, que costuma seguir para um coletor de terceiro. Agora o log guarda
  só o caminho, sem query string, para toda rota: uma lista de parâmetros
  proibidos envelheceria mal e a próxima rota com segredo na URL entraria calada.
- **A recuperação se declarava disponível sem SMTP.** Sem `SMTP_HOST`, o sistema
  cai no notificador de log, que se declara habilitado de propósito — certo para
  a vigilância, desastroso aqui: o "envio" era um token que ninguém recebia, e a
  pessoa via "confira seu e-mail", gastava o link e, após cinco tentativas,
  ficava uma hora travada. O composition root agora só entrega o notificador à
  recuperação quando ele entrega de verdade.
- **O scrypt era pago antes de conferir o token** em `/v1/senha/redefinir`, que
  é pública: ~50ms de CPU e 16 MB por requisição, de graça, para qualquer token
  inventado. A ordem virou validar (de graça) → conferir o token → hash. A
  porta `HashDeSenha` ganhou um `validar` justamente para separar as duas coisas.
- **A poda de backups apagava arquivos que não eram dela.** O filtro era "começa
  com `processovivo-` e termina em `.db`", e alcançava a cópia manual que alguém
  guardou antes de uma migração. Agora só apaga o nome exato que ela própria
  gera — e registra no log QUAIS apagou, não só quantas.
- **Permissões da cópia**: 0700 na pasta, 0600 no arquivo. O backup é o banco
  inteiro num volume que pode ser montado noutro lugar.
- **`limparSessoesExpiradas` estava implementada, testada e nunca era chamada.**
  Entrou de carona na varredura que já roda.

Um sétimo ponto foi **documentado em vez de corrigido**: sobra uma diferença de
tempo de ~0,14 ms entre pedir recuperação para um e-mail cadastrado e para um
desconhecido. Está abaixo do jitter de qualquer rede, exigiria milhares de
amostras por endereço contra um teto de 60 requisições por minuto, e o 409 do
cadastro já revela o mesmo fato de graça por decisão de produto. O comentário no
código agora diz isso, em vez de afirmar uma simetria que não existe.

### Corrigido

- **O envio do e-mail de recuperação não é mais aguardado dentro da
  requisição.** Encontrado num teste de fumaça contra um SMTP inalcançável: com
  `await`, o pedido de um e-mail cadastrado ficava pendurado até o timeout do
  nodemailer, enquanto o de um endereço desconhecido voltava na hora. Status
  igual, mensagem igual — e o relógio contando quem é assinante. A enumeração
  que a rota inteira existe para impedir, entrando por outro canal. Agora os
  dois caminhos voltam em milissegundos, e há teste com um notificador que
  nunca responde.
- `.env.example` ainda descrevia o cadastro como fechado por convite, regra que
  deixou de valer na v0.14.0.

---

## [0.16.0] — 2026-09-17

**A carteira agora mostra as partes, e filtra por cliente em SQL.**

A v0.15.0 fez isso na busca por OAB, onde a lista está em memória. Aqui é
outra história: a carteira mora no banco, pode ter milhares de processos, e o
filtro precisa acontecer em SQL. Alguns advogados têm carteira grande, e achar
"os processos do cliente X" rolando a tela não é achar.

### Adicionado

- **As partes em cada linha de "Meus processos"** — nome e polo em palavra
  (`autor`, `réu`, `outra parte`), até quatro por linha, o resto como `+N`.
- **Campo "Parte"**, com filtro no servidor: `GET /v1/acompanhamentos?parte=`.
- **A vara na linha**, junto de tribunal e classe.
- **Rótulos na barra de filtros.** Eram seis caixas mudas em fila; na tela do
  dono do produto elas apareceram como "TribunalTJGOTRT18", indistinguíveis de
  conteúdo. Filtro que não se anuncia é filtro que ninguém usa.
- O foco volta para o campo depois de cada filtragem, com o cursor no fim —
  antes a tela era redesenhada e quem digitava perdia o campo no meio da
  palavra.

### A coluna nova, e a primeira migração de coluna do projeto

`partes_texto` guarda os nomes das partes normalizados. Desnormalizada pelo
mesmo motivo de `tribunal` e `classe`: resolver o filtro com `json_each` sobre
o processo inteiro desserializaria ~100 KB por linha **a cada tecla digitada**.
Numa carteira de 2.000 processos, 200 MB de JSON por busca.

Foi também a primeira coluna acrescentada a uma tabela que já existe em
produção, e isso exigiu migração de verdade: `CREATE TABLE IF NOT EXISTS` não
acrescenta coluna nenhuma num banco que já tem a tabela, e `ALTER TABLE ADD
COLUMN` estoura se a coluna já está lá. A checagem no `PRAGMA table_info`
precede a alteração.

Há **retrocarga no arranque**: sem ela o filtro acharia apenas os processos
sincronizados depois da atualização e ficaria calado sobre os outros — o erro
que a v0.14.2 já custou. Ela tolera JSON corrompido numa linha sem derrubar a
subida do servidor, e marca com texto vazio o processo que realmente não tem
parte, para ele sair da fila em vez de voltar a cada arranque.

### O `upper()` do SQLite é ASCII-only, e isso quase passou

A primeira retrocarga era SQL puro, elegante, com `group_concat` e
`json_each`. O teste reprovou: `upper('José')` devolve **`JOSé`** — o "é" fica
intacto. A retrocarga gravaria uma forma e as sincronizações seguintes outra, e
o advogado que buscasse "josé" acharia metade dos processos, sem erro nenhum em
lugar nenhum.

A correção virou `paraBusca`, num módulo próprio usado nos **três** pontos que
precisam concordar — gravação, retrocarga e consulta. Ela também dobra o
acento, porque ninguém digita acento numa busca: quem procura "José Antônio"
escreve "jose antonio", e um filtro que exige o acento correto parece dizer que
o cliente não tem processo.

### Nota sobre os dois campos de busca

`Parte` e `Busca livre` respondem perguntas diferentes, e é de propósito.
`Busca livre` varre o JSON inteiro e casa com qualquer menção — inclusive
dentro de um despacho, trazendo processo em que o cliente é apenas citado.
`Parte` casa somente com quem consta como parte. O primeiro é útil; o segundo
é preciso.

---

## [0.15.0] — 2026-09-17

**As partes já vinham na resposta e eram jogadas fora.**

Uma busca por OAB devolveu 130 processos. A pergunta do dono foi imediata: _"em
quais deles esse advogado representa o Condomínio Sunsquare?"_ — e a resposta
já estava na tela, invisível. O DJEN manda os destinatários de cada intimação,
o mapper os consolida em `partes`, a rota devolve tudo, e a lista desenhava
apenas número, tribunal, classe e último andamento.

Carteira de 130 processos sem mostrar quem é a parte obriga o advogado a abrir
um por um para achar os do cliente X. É exatamente o trabalho que ele esperava
que o sistema fizesse.

### Adicionado — tela de resultado da busca por OAB

- **As partes em cada linha**, com o polo em palavra de advogado: `autor`,
  `réu`, `outra parte`. `OUTROS` não virou "terceiro": a fonte não disse isso,
  e ali pode estar o MP, um assistente ou um perito.
- **Filtro por parte, classe ou número**, aplicado **localmente** sobre a lista
  já em mãos. Refazer a consulta a cada letra digitada gastaria uma ida ao DJEN
  por tecla.
- **Filtro por tribunal**, montado a partir dos tribunais que apareceram.
- **"Mostrando X de Y"** sempre que houver recorte, com botão de limpar — a
  regra que ficou do filtro fantasma da v0.14.2.

### Corrigido — a CAIXA ALTA do DJEN

A tela mostrava `AçãO TRABALHISTA - RITO ORDINáRIO`. Não é defeito de
codificação: o DJEN manda caixa alta com os caracteres acentuados em
minúscula, e é assim que chega. Agora a exibição normaliza para
`Ação Trabalhista - Rito Ordinário`, com as preposições em minúscula.

O detalhe que fez a primeira tentativa falhar: testar "está todo em maiúsculas"
nunca dá verdadeiro nesse texto, justamente por causa dos acentos. O corte é
**70% de maiúsculas entre as letras**, o que reconhece o caso real e deixa
intacto o texto escrito normalmente. O dado guardado continua como veio, como
manda a regra do projeto — a normalização é só da camada de exibição.

### Decisão de estado

O filtro vive em `estado.buscaOab`, e **não** numa variável global da página:
nasce com a busca e morre com ela. Foi a lição da v0.14.2, onde um filtro em
variável global sobreviveu a trocar de aba e só morreu com o recarregamento —
convencendo o dono de que o sistema tinha perdido processos.

### O que isso NÃO resolve

Busca por **CNPJ** continua fora. O DJEN dá nome e polo da parte, sem
documento, e nem informa se é pessoa física ou jurídica. O MNI dá
`numeroDocumentoPrincipal` e `tipoPessoa` — e hoje esse dado chega e é
descartado, porque o `MniAdapter` só produz `Peca`. Aproveitá-lo é trabalho
pequeno, limitado ao TJGO, e depende de uma decisão: o MNI devolve **CPF
completo**, sem máscara, e guardar documento de pessoa física de quem não é
cliente do assinante muda o perfil de risco do Processo Vivo na LGPD. A recomendação
registrada é guardar CNPJ e descartar CPF na entrada.

Também não muda o teto da fonte: o DJEN lista como partes os destinatários das
intimações **publicadas**. Processo em que o cliente não foi intimado na janela
consultada pode não trazer o nome. O resultado do filtro é piso, não teto.

---

## [0.14.2] — 2026-09-17

**Um filtro esquecido, e a carteira parecia ter um processo em vez de três.**

A v0.14.1 tratou metade do problema — a tela inicial não dizia quantos
processos existem. Mas o relato seguinte foi decisivo: _"eu saí e entrei e
apareceram os processos"_. Sair e entrar recarrega a página, e recarregar a
página apaga as variáveis globais onde os filtros da tela de processos moram.

Ou seja: havia um filtro ativo. Ele sobrevivia a trocar de aba, a abrir
processo, a voltar — só morria com um recarregamento. E a tela mostrava o
subconjunto sem dizer que era um subconjunto.

"Sair e entrar resolveu" é o pior tipo de conserto: não explica nada e deixa a
desconfiança de pé para a próxima vez que algo parecer estranho.

### Corrigido

- **O botão de limpar filtros não limpava.** `Object.assign({}, filtros, {})`
  mantém tudo — o ramo de reset construía um objeto vazio e mesclava, o que é
  uma operação nula. Estava ali desde que a tela existe, aparentando funcionar.
- **`GET /v1/acompanhamentos` passa a devolver `totalSemFiltro`.** O total real
  da carteira acompanha toda listagem, sempre.
- **A tela avisa quando está escondendo algo**: "Mostrando 1 de 3 processos —
  há filtro ativo", com o botão de limpar ao lado. Interface que mostra um
  subconjunto calada é como se perde a confiança no dado.

### A regra que fica

Toda listagem filtrável devolve o total **sem filtro** junto do filtrado, e
toda tela que esconde linha diz quantas escondeu. Vale para processos,
novidades e o que vier — o custo é um COUNT, e o preço de não fazer foi o dono
do produto achando que o sistema tinha perdido os dados dele.

---

## [0.14.1] — 2026-09-17

**A tela inicial convenceu o dono de que o sistema tinha perdido dados.**

Ele cadastrou três processos numa conta nova, abriu o Processo Vivo, viu **um** item e
concluiu que só um tinha sido salvo. O banco tinha os três, íntegros, com
tribunal, classe e retrato completo. A consulta que a tela faz devolvia os três.

O que acontecia: a tela inicial mostra movimentação **nova**, e processo
recém-adicionado não gera nenhuma — a primeira sincronização é o retrato
inicial, e transformá-la em novidade encheria o feed de dezenas de avisos
falsos no primeiro dia. Dos três processos, só um tinha sido varrido uma
segunda vez pelo agendador; só ele tinha novidade; só ele aparecia.

Nada estava quebrado, e era esse o problema: a interface não dava como
distinguir "não tenho processo" de "tenho processos e nada mudou". Perda de
confiança no dado é mais cara do que perda de dado — a segunda se conserta.

### Corrigido

- `GET /v1/novidades` passa a devolver **`acompanhados`**, a contagem de
  processos do assinante (COUNT próprio, não `listar().length`, que
  desserializaria dezenas de KB de JSON por linha a cada abertura da tela).
- A tela inicial mostra esse número no subtítulo, **antes** do de movimentações.
- O estado vazio virou três estados, que antes eram dois e se confundiam:
  - nenhum processo → convite para adicionar o primeiro;
  - processos sem movimentação nova → **"Seus N processos foram verificados e
    nada mudou"**, com atalho para Meus processos. Silêncio verificado é
    informação, não ausência dela — é a mesma regra que obriga a notificação a
    avisar quando NÃO conseguimos verificar;
  - filtro ativo escondendo tudo → dizer que é o filtro.

### Verificado com o tribunal, não deduzido

O MNI do TJGO entrega peça **somente onde o advogado está habilitado nos
autos**. Medido com a mesma credencial em dois processos: no dele, 278
documentos e PDF baixando; no de outro advogado, sem acesso às peças. O
controle é do tribunal, e o Processo Vivo não precisa — nem deve — replicá-lo.
Para a venda: "as peças dos **seus** processos".

---

## [0.14.0] — 2026-09-16

**Cada advogado com o seu ambiente.**

Até aqui, entrar no Processo Vivo era colar uma chave de API — o que serve para uma
integração e não para uma pessoa. Agora há conta com e-mail e senha, e cada
conta nasce com o próprio ambiente: processos, vigilâncias e acesso ao tribunal
separados por assinante, na mesma instalação.

### O cadastro é progressivo, e isso é a decisão central

Pedir OAB e a senha do Projudi na primeira tela custaria a maior parte dos
cadastros — é muita confiança para quem ainda não viu o sistema funcionar.
Então:

1. **Nome, e-mail e senha** — já consulta qualquer processo por número,
   acompanha e recebe as atualizações.
2. **OAB e UF** — o sistema passa a achar sozinho os processos no nome da
   pessoa e a avisar de publicação nova.
3. **Acesso ao tribunal** — as peças das partes: petição, contestação, laudo.

A tela inicial mostra a trilha enquanto houver passo pendente, e cada passo diz
o que DESTRAVA, não o que exige. A trilha some quando tudo está pronto:
lembrete permanente vira ruído e ensina a ignorar a área mais importante da
tela.

### Adicionado

- **Contas** (`POST /v1/contas`), **sessão** (`POST`/`DELETE /v1/sessoes`) e
  **perfil** (`GET`/`PATCH /v1/eu`, `POST /v1/eu/senha`).
- **Telas de entrar e criar conta**, aba **Minha conta** e a trilha de
  liberação no topo das Atualizações.
- `COOKIE_SECURE` na configuração — deixe `true` em produção; `false` apenas
  para desenvolvimento em `http://localhost`, onde o navegador descarta cookie
  `Secure` em silêncio.

### Como a segurança foi montada

- **Senha com scrypt do `node:crypto`**, parâmetros gravados junto do hash —
  dá para encarecer no futuro sem invalidar senha de quem já é assinante. Sem
  dependência nativa, pelo mesmo motivo que escolheu `node:sqlite`: Alpine.
- **O banco guarda o HASH do token de sessão, nunca o token.** Vazamento do
  banco não vira sessão aberta.
- **O token não volta no corpo da resposta** — só no cookie `HttpOnly`. Se
  voltasse, a tela poderia guardá-lo no `localStorage` e desfazer a proteção.
- Em HTTPS o cookie se chama **`__Host-processovivo_sessao`**. O prefixo obriga o
  navegador a recusar gravação por subdomínio, o que fecha a fixação de sessão
  por subdomínio esquecido — ataque que sobrevive a `HttpOnly` e `SameSite`.
- **"E-mail não encontrado" e "senha incorreta" são a MESMA resposta**, e a
  verificação gasta o mesmo tempo nos dois casos, inclusive para e-mail
  malformado. Respostas diferentes transformariam o login num verificador de
  quem é cliente.
- **Trocar a senha encerra as outras sessões.** Quem troca costuma estar
  tirando alguém de dentro.
- **Sessão tem precedência sobre chave de API.** Com as duas presentes vence a
  pessoa; o contrário faria alguém ver a carteira da integração por baixo da
  própria conta, conforme a aba.

### Corrigido — achados de uma revisão de segurança

Nenhum destes veio de relato de uso; todos vieram de uma revisão dirigida ao
código novo. Os dois primeiros já existiam antes das contas.

- **`POST /v1/sincronizar` e `POST /v1/vigilancias/varrer` eram GLOBAIS.**
  Qualquer chamador autenticado disparava a varredura de TODOS os assinantes:
  consulta ao tribunal sobre a carteira alheia, escrita nos dados deles e
  gasto da cota compartilhada do CNJ em nome deles. Nada do conteúdo alheio
  voltava na resposta, que é justamente o que fazia isso passar despercebido.
  Agora as duas rotas são escopadas a quem pediu; a varredura agendada
  continua global, e há teste para os dois lados.
- **`trustProxy` aceitava a cadeia inteira de `X-Forwarded-For`**, que o
  cliente escreve. Um IP diferente por requisição caía num balde novo de rate
  limit e anulava o limite — na rota de login, que é pública e gasta scrypt,
  isso é força bruta sem teto e consumo de memória ao mesmo tempo. Agora só o
  salto que o nosso próprio proxy acrescenta é considerado.
- **`?ultimosDias=x` virava 500.** `Number('x')` era NaN, `new Date(NaN)`
  estourava `RangeError`, e uma query digitada errada acendia alarme de
  produção.
- **`PROCESSOVIVO_AUTH_DISABLED=true` estava quebrado**: sem chave nem sessão as
  rotas de dados não tinham ambiente e respondiam 500. O modo documentado agora
  funciona, com um ambiente fixo.
- **Servidor sem banco respondia 401 "sua sessão expirou"** nas rotas de conta,
  mandando a pessoa fazer login num laço infinito. Agora responde 501.

### Sabendo do risco

- **O cadastro é aberto, por decisão de produto** — o Processo Vivo vai ser vendido a
  advogados pelo Brasil, e formulário fechado por convite não combina com isso.
  Duas consequências ficam registradas: qualquer pessoa pode descobrir se um
  e-mail já é assinante (o 409 do cadastro denuncia), e a cota compartilhada do
  CNJ passa a depender do limitador do nosso lado, não do número de contas.
  Se o abuso aparecer, os caminhos são confirmação por e-mail antes da primeira
  consulta e teto de consultas no plano gratuito.
- **A varredura manual usa uma trava global.** Escopada, ela dura poucos
  segundos, mas enquanto roda a varredura agendada responde 409. Aceitável
  agora; vira trava por ambiente quando houver volume.
- Continua de pé a dívida do fixture de sucesso do MNI.

---

## [0.13.2] — 2026-09-16

**O download das peças, fechado contra o tribunal de verdade.**

A v0.13.1 fez as 278 peças aparecerem. Faltava o arquivo. A causa era a mesma
de antes, no outro caminho: pedir um documento pelo id com `movimentos=false`
devolve 800 bytes e nenhum documento. Com `movimentos=true`, 501.753 bytes,
o documento pedido e o PDF em anexo MTOM.

### Corrigido

- **`obterConteudo` pede a linha do tempo**, como `listarPecas` já fazia. O
  recorte por id continua: sem ele viriam as 278 peças a cada download.
- **O botão de download aparece em todas as peças.** A interface só o mostrava
  quando `conteudoDisponivel`, que na listagem do MNI é `false` para todas —
  inclusive as que baixam sem problema. Um processo inteiramente acessível
  aparecia com a mensagem "nenhuma peça liberada" e zero botões.
- **403 e 424 têm mensagem própria no download.** Antes qualquer falha virava
  "falhou — tentar de novo", o que fazia o advogado clicar dez vezes numa peça
  que ele não tem direito de ver. Agora: falta de procuração nos autos, ou
  senha recusada com o caminho para "Meus acessos".
- **O nome do arquivo é o do tribunal** (`certidaosistemadigital.pdf`), lido de
  `<outroParametro nome="NomeArquivo">`, e só então um nome montado por nós.

### Mudado

- `GET /v1/processos/:n/pecas` troca `comTeorDisponivel` por **`comArquivo`**.
  O primeiro contava "quantas vieram com o teor junto" — zero sempre, no MNI — e
  a tela lia isso como "quantas eu consigo abrir". São perguntas diferentes, e a
  segunda não tem resposta antes da tentativa.
- A tela e o CLI passam a destacar **quantas peças são das partes**, que é a
  informação que motivou tudo isso. No processo medido: 58 petições e 2
  procurações entre 278.

### Aprendido

- A forma da resposta de sucesso está verificada contra o TJGO ao vivo e
  documentada no teste: `<documento>` é filho de `<processo>` e carrega o
  `movimento` que o originou; `<movimento>` aponta de volta por
  `<idDocumentoVinculado>`; o teor vem por `xop:Include`, nunca inline.
- Dívida que continua: os BYTES da resposta de sucesso não estão versionados. A
  captura real tem 501 KB e carrega petição com dado de parte. Fechar isso exige
  `npm run cli -- pecas <n> --capturar` num processo escolhido para esse fim.

---

## [0.13.1] — 2026-09-16

**As peças apareciam como zero, e o tribunal não reclamava.**

Com a credencial do advogado cadastrada e correta, `GET /v1/processos/:n/pecas`
respondia `total: 0` num processo com 278 documentos. Nem erro, nem log, nem
teste vermelho: o TJGO devolvia `sucesso: true` e a resposta simplesmente vinha
sem a lista.

### Corrigido

- **`listarPecas` agora pede a linha do tempo** (`movimentos=true`). No Projudi
  o documento nasce pendurado num movimento, e sem pedir os movimentos o
  tribunal devolve só o cabeçalho — com sucesso. Medido no mesmo processo, mesma
  credencial, mesmo `incluirDocumentos=true`:

  | `movimentos` | resposta      | `<documento>` |
  | ------------ | ------------- | ------------- |
  | `false`      | 4.122 bytes   | 0             |
  | `true`       | 279.653 bytes | 278           |

  Há teste travando a linha no envelope, porque é o tipo de mudança que se
  desfaz sem querer e volta a falhar em silêncio.

- **Classificação de origem ajustada pelo censo real** de um processo do TJGO
  (278 peças): "Ato Ordinatório" (17) e "Ementa" (1) caíam em `DESCONHECIDA` e
  agora são `JUIZO`.

### Aprendido

- No Projudi o rótulo da peça chega em `descricao`, **não** em
  `tipoDocumentoLocal` — esse atributo não existe na resposta real.
- `DESCONHECIDA` não é falha da heurística: 111 das 278 peças vêm rotuladas
  literalmente como "Outros" pelo próprio tribunal.

### Em aberto

- **Download do teor ainda não funciona.** Pedir um `<documento>` específico com
  `movimentos=false` devolve resposta sem documento nenhum (800 bytes sem
  cabeçalho, 4.122 com). Falta medir a combinação `movimentos=true` +
  `documento=<id>`. Enquanto isso, `obterConteudo` está sem caminho de sucesso
  verificado contra o tribunal.
- Continua de pé a dívida do fixture: os testes de sucesso do MNI rodam contra
  payload derivado do WSDL, não contra captura real.

---

## [0.13.0] — 2026-09-11

**A interface que faltava.**

A v0.12.0 entregou as peças pela API e parou aí. Do lado de quem usa, nada tinha
mudado: nenhum campo para o advogado informar o acesso dele, nenhuma peça em
tela. Funcionalidade que só existe para quem chama com `curl` não existe.

### Adicionado

- **Aba "Meus acessos"** — cadastro do acesso do advogado no tribunal, com
  tribunal, CPF e senha. Lista o que está cadastrado e o estado de cada um:
  usado com sucesso, ainda não usado, ou **recusado pelo tribunal** com a data.
  Esse último é o que evita a vigilância falhar em silêncio quando a senha muda.
- **Peças na tela do processo**, com a origem de cada uma (da parte / do juízo),
  data, assinantes e botão de download.
- O download vai por `fetch` e não por link direto: a rota exige o header
  `x-api-key`, que um `<a href>` não tem como mandar.

### Decisões que a tela carrega

- **As peças carregam DEPOIS do processo, em requisição separada.** A consulta
  ao MNI autentica no tribunal e pode levar dezenas de segundos; amarrada à
  principal, faria o advogado esperar por ela para ver as movimentações que já
  estavam prontas.
- **O 428 vira convite, não erro.** Sem credencial cadastrada, a tela explica que
  petição e documento de parte não são publicados no diário e oferece o botão de
  cadastrar — em vez de mostrar um código na cara de quem só queria ler a peça.
- **"Nenhuma peça com arquivo" é explicado na hora.** É o caso mais comum de
  todos — falta de procuração naquele processo — e o que mais parece defeito
  nosso sem uma frase dizendo o que é.
- **O campo de senha nasce sempre vazio**, inclusive com acesso já cadastrado: o
  servidor guarda cifrado e não devolve. A tela avisa, senão parece que não salvou.

---

## [0.12.0] — 2026-09-10

**As peças das partes.**

Até aqui o sistema mostrava decisões e julgados, e só. Não era limitação do
código: era o teto da fonte. O DJEN é o diário, e diário publica ato judicial —
petição, contestação, laudo e documento juntado pela parte **nunca são
publicados**. O DataJud não tem documento nenhum. Faltava a fonte que tem.

### Adicionado — MNI 2.2.2 do Projudi/TJGO

- **`MniAdapter`**, contra `https://projudi.tjgo.jus.br/IntercomunicacaoService`.
  O TJGO implementa MNI, ao contrário do que a ausência de `pje.tjgo.jus.br`
  sugere — o endereço só não segue o padrão `/intercomunicacao` do PJe, que ali
  responde 404. O link está na página inicial do próprio Projudi.
- **Autenticação por `idConsultante` + `senhaConsultante`**: usuário e senha do
  advogado, dentro do envelope SOAP. Não passa pela tela de login, então não há
  CAPTCHA nem código por e-mail no caminho, e este tribunal não exige
  certificado digital.
- **Entidade `Peca`** separada de `Movimentacao`: a movimentação diz que algo
  aconteceu, a peça é o arquivo. O TEOR não mora na entidade — `Peca` é metadado
  e circula barato; o arquivo sai por rota própria, uma peça por vez, senão uma
  listagem despejaria dezenas de MB na resposta.
- **Porta `ProvedorDePecas`, deliberadamente separada de `ProcessoProvider`.**
  Não é purismo: `CachedProcessoProvider` indexa por número de processo, **sem
  workspace na chave**. Uma fonte com credencial dentro da cadeia serviria ao
  assinante seguinte a resposta obtida com a credencial do anterior.
- Rotas `GET /v1/processos/:numero/pecas` e
  `GET /v1/processos/:numero/pecas/:id` (download como anexo).
- `npm run cli -- pecas <numero>` lendo a credencial do AMBIENTE, não do banco:
  serve para validar o acesso antes de cadastrar ninguém. Com `--capturar`,
  grava a resposta crua do tribunal.

### Adicionado — cofre de credenciais

- **`credenciais_tribunal`, com a senha cifrada em AES-256-GCM.** É o dado mais
  sensível do banco: a chave de API só abre o Processo Vivo, esta abre o processo no
  tribunal. GCM e não CBC porque o GCM autentica — adulterar a coluna dá erro de
  decifração, e não um "segredo" corrompido que só falha lá no tribunal
  parecendo senha errada do usuário.
- **Sem `PROCESSOVIVO_CREDENCIAL_CHAVE`, o acesso a peças não é montado** e as rotas
  respondem 501 com a instrução. Não existe caminho que guarde senha em claro.
- Chave gerada por `npm run chave -- --cofre`.
- Rotas `GET/PUT/DELETE /v1/credenciais`. A senha nunca volta na resposta — nem
  mascarada: `***` convidaria a interface a exibir um campo "preenchido" que não
  pode ser reenviado, e o próximo salvamento gravaria os asteriscos como senha.

### Descoberto na captura real, e que teria custado caro

Duas armadilhas que nenhum fixture escrito por quem implementa revelaria. As
duas estão gravadas em `tests/fixtures/mni-tjgo-credencial-invalida-real.txt`:

- **A resposta não é XML puro.** Vem em `multipart/related` (Apache CXF, com
  XOP/MTOM). Quem chamar o parser direto sobre o corpo recebe lixo.
- **O teor dos documentos não vem em base64**, embora o WSDL declare
  `xs:base64Binary`. Vem como parte binária separada, referenciada por
  `<xop:Include href="cid:...">`. Um mapper que lesse `conteudo` como base64
  acharia string vazia e concluiria "o tribunal não liberou o arquivo" — com o
  arquivo ali, na parte seguinte da mesma resposta.
- **Recusa vem com HTTP 200.** `sucesso: false` no corpo. Confiar em
  `resposta.ok` faria "Usuário ou Senha inválida." virar consulta bem-sucedida
  com zero peças — indistinguível de "processo sem documentos".

### Segurança e limites, explícitos

- **Uma tentativa, sem retry.** Diferente de todos os outros adapters, e de
  propósito: a requisição carrega a senha do advogado, e o Projudi conta
  tentativa malsucedida para bloquear conta. Retry transformaria senha
  desatualizada em três recusas por consulta, e a vigilância de hora em hora
  levaria ao bloqueio no mesmo dia.
- **30 requisições/minuto**, metade do teto relatado antes de bloqueio de IP de
  datacenter (403, espera de ~30 min). Num VPS o IP é de todos os assinantes.
- **A trava que nenhum código contorna:** o MNI devolve as peças conforme o
  perfil de acesso do consultante. Sem procuração nos autos, o metadado vem e o
  conteúdo não. Daí `TeorNaoAutorizadoError` ter nome próprio: a interface diz
  "você não está habilitado neste processo", e não "erro ao baixar".
- Status HTTP novos, escolhidos para dizer o que fazer: **428** (falta
  cadastrar credencial — não 401, que mandaria refazer login à toa), **424** (o
  tribunal recusou a credencial — nem 401 nem 502), **403** (respondeu e negou o
  arquivo — não 404, que diria que a peça não existe).

### Corrigido

- **`.env.example` estava desatualizado e sabotava a busca por OAB.** Trazia
  `PROCESSOVIVO_PROVIDER_CHAIN=mock-crawler-tjsp,datajud` e `DATAJUD_TIMEOUT_MS=8000`.
  Quem seguisse o README (`cp .env.example .env`) subia sem DJEN na cadeia: a
  vigilância respondia 501 e a busca por OAB devolvia zero. O arquivo correto
  tinha virado `env.example` (sem ponto) num dos uploads, e o antigo ficou.
- Removidos do repositório `download` (um `.dockerignore` antigo),
  `download (1)` (um `.gitignore` antigo) e `prettierrc.json`, duplicata de
  `.prettierrc.json`.
- README anunciava v0.8.0 com o `package.json` em 0.11.0.

### Dívida assumida, declarada aqui para não ser esquecida

O caminho de SUCESSO do MNI **ainda não tem captura real**: exige a credencial
de um advogado habilitado nos autos, e não havia nenhuma disponível. Os testes
de sucesso rodam contra um payload montado a partir do WSDL real — que é
exatamente o circuito fechado que o CLAUDE.md manda evitar. Na primeira consulta
bem-sucedida, use `npm run cli -- pecas <numero> --capturar` e substitua o bloco
`xmlComDocumentos` de `tests/infrastructure/MniAdapter.spec.ts` pela resposta de
verdade.

---

## [0.11.0] — 2026-09-07

**O Processo Vivo passa a parecer o que já era.**

A crítica que originou esta versão foi simples: a tela estava bem construída,
mas parecia ferramenta interna, não produto que se vende. O que denunciava não
era acabamento — era, em ordem, a porta de entrada, a ausência de painel e a
falta de identidade.

### Adicionado — contas de verdade

- **Entrada com e-mail e senha.** "Cole sua chave de API" era o momento mais
  evidente de que aquilo não era um produto: nenhum advogado entende a
  expressão. Agora é login, como qualquer serviço que se paga.
- **Senha com `scrypt` do próprio Node.** Não é bcrypt nem argon2 pela mesma
  razão que levou ao `node:sqlite` no lugar do `better-sqlite3`: **zero
  dependência nativa** — a imagem é Alpine e compilar módulo nativo lá exige
  python, make e g++. Os parâmetros vão gravados junto do hash, para o custo
  poder subir no futuro sem invalidar as senhas antigas.
- **Sessão em cookie HttpOnly**, com o HASH do token no banco — nunca o token.
  Se o banco vazar, o que está lá não abre conta nenhuma. `SameSite=Lax` para
  que chegar pelo link do e-mail de aviso não caia na tela de login, e `Secure`
  apenas sob HTTPS (marcar sempre faria o navegador descartar o cookie em
  `localhost`, com o sintoma "faço login e volto para o login").
- **Cadastro por código de acesso**, que é uma das chaves de `PROCESSOVIVO_API_KEYS`.
  Não é burocracia: a chave do CNJ é compartilhada por todo o país, e um
  formulário aberto na internet transforma o VPS em proxy gratuito para a cota
  alheia — quem leva o bloqueio é a chave. Distribuir uma chave por cliente vira,
  de quebra, o mecanismo natural de onboarding e revogação.
- **A chave de API continua valendo** para integração (n8n, CLI, scripts). Os
  dois caminhos resolvem para o mesmo `workspace`, e nenhuma rota de dados sabe
  qual dos dois trouxe a requisição. A sessão tem precedência: com os dois
  presentes, vence a pessoa — do contrário a carteira "sumiria" conforme a aba.

### Adicionado — painel e primeiro uso

- **Painel como tela inicial.** Antes o usuário caía numa lista. Lista não
  responde à pergunta que ele traz ao abrir — "tem alguma coisa me esperando?".
  Quatro números: novidades não lidas, processos acompanhados, inscrições
  vigiadas e **quando foi a última verificação**. O último é o que quase nenhum
  concorrente mostra, e é o que separa "nada aconteceu" de "o sistema parou de
  olhar".
- **Primeira execução guiada**, em três passos, começando pelo que dá resultado
  sem digitar número nenhum (cadastrar a OAB). Um painel zerado é a pior
  primeira impressão possível de um SaaS.

### Alterado — identidade visual

- **Tema claro** com fundo levemente quente, verde-petróleo como marca e serifa
  nos títulos. A escolha é comercial, não estética: escuro lê como ferramenta de
  programador, e praticamente todo software jurídico brasileiro é azul — o
  petróleo mantém a seriedade sem se confundir com os concorrentes.
- **Marca em SVG inline** (também usada como favicon), sistema de cor em tokens,
  hierarquia tipográfica e estados vazios desenhados.
- Tudo continua **sem nenhum recurso externo**: fonte do sistema, zero CDN, zero
  build. Um teste garante isso — carregar Google Fonts quebraria o console de
  quem estiver atrás do firewall de um fórum.

### Corrigido

- **Campos de filtro sem estilo.** Os `input` e `select` das telas de processos,
  atualizações e busca não usavam a classe do sistema de design e apareciam com
  a aparência nativa do navegador no meio de uma interface desenhada. Foi visto
  em captura de tela real, não no código.
- **Rodapé flutuando no meio da página** sempre que o conteúdo era curto — que é
  exatamente o caso de quem acabou de assinar.
- **501 logado como erro, com stack trace.** Vigilância por OAB sem o DJEN na
  cadeia não é falha, é configuração; a cada abertura da aba o log ganhava um
  stack. É assim que se aprende a ignorar o log, que é o único lugar onde o 500
  de verdade aparece. Virou aviso, sem stack.

### Migração

A primeira conta criada **adota o workspace derivado da primeira chave de API**.
Sem isso, você criaria sua conta e encontraria a carteira vazia, achando que o
deploy apagou os dados. Sai uma linha no log quando acontece.

---

## [0.10.0] — 2026-09-05

**O sistema deixa de vigiar o que você digitou e passa a vigiar o seu nome.**

Até aqui era preciso saber o número do processo para acompanhá-lo — ou seja, era
preciso já saber que o processo existe. Esta versão inverte isso e fecha o ciclo:
detecta sozinho, separa o que pede providência, e avisa.

### Adicionado

- **Vigilância contínua por OAB.** O advogado cadastra a inscrição uma vez; toda
  publicação nova no nome dele entra sozinha na carteira. Novas rotas
  `/v1/vigilancias` e aba **Vigilância** no console.
  - A primeira varredura olha **30 dias**, não o histórico inteiro: um advogado
    com 1.871 publicações veria a carteira toda entrar como "novidade" e o aviso
    de verdade sumiria no meio.
  - As seguintes retomam com **2 dias de sobreposição**, porque o DJEN indexa
    com atraso e varrer do exato ponto de parada perderia publicação — que é
    perder prazo.
  - Roda **de hora em hora**, contra as 12h da varredura de processos. Pode,
    porque só toca o DJEN (200ms, sem chave). Amarrar as duas no mesmo relógio
    fazia a fonte lenta ditar o ritmo da rápida, e é na rápida que estão as
    publicações que abrem prazo.
- **Notificação por e-mail**, via SMTP (`Notificador` como porta, para o
  WhatsApp entrar depois sem mexer no resumo). Um e-mail por ciclo, agrupado por
  processo, com o trecho do teor — não um e-mail por movimentação.
- **Aviso de que NÃO conseguimos verificar.** Se a última varredura bem-sucedida
  passar de 26h, sai um alerta. É metade da funcionalidade, não um extra:
  notificação é uma promessa, e a partir do primeiro aviso o advogado passa a
  ler silêncio como "não houve nada". Um sistema que só avisa novidade é pior do
  que não ter notificação, porque troca incerteza conhecida por falsa segurança.
- **Triagem do que exige ação** (`domain/entities/triagem.ts`): separa o ato que
  abre prazo ou pede providência (`INTIME-SE`, `MANIFESTE-SE`, "prazo de N
  dias", sentença, decisão, acórdão) do registro de cartório (juntada,
  expedição, conclusão). Aplicada uma vez, na construção do `Processo`, para que
  API, e-mail e tela concordem. **Nunca esconde andamento** — só ordena e
  destaca.
- **Modo log do notificador**: sem SMTP configurado, o caminho inteiro continua
  sendo exercitado e o log mostra o que teria saído.

### Alterado — a tela do processo

O topo respondia "o que é este processo?" quando a pergunta do advogado ao abrir
é "o que eu preciso fazer?". A ordem mudou:

1. **Pede providência** — o que abre prazo, com trecho do texto
2. **Última movimentação** — agora com o inteiro teor, não só o rótulo
   ("Ato ordinatório" é categoria, não informação)
3. **Partes** — quem está do outro lado importa mais que a data de distribuição
4. Ficha cadastral, com **hora** na verificação (verificado às 03h e às 14h são
   coisas diferentes quando se conta prazo) e as fontes que responderam
5. Andamentos, com filtros (tudo / pede providência / com inteiro teor) e
   **"ler o ato inteiro"** por andamento

### Corrigido

- **O DJEN devolve um aviso no lugar do inteiro teor** quando o documento não é
  público: `ARQUIVOS DIGITAIS INDISPONÍVEIS (NÃO SÃO DO TIPO PÚBLICO)`. São
  **43 das 62 publicações** do processo de teste — 69%. O mapper guardava esse
  aviso como se fosse o despacho, e a tela exibiria 43 andamentos com um
  "inteiro teor" que só diz que não há inteiro teor. Agora é reconhecido, marcado
  como `teorIndisponivel` e acompanhado do link para o tribunal. Efeito colateral
  desejado: com o teor legitimamente ausente, o orquestrador volta a considerar
  que falta conteúdo e continua perguntando às outras fontes.
- **Corpo de requisição inválido virava HTTP 500.** `ZodError` não estava
  mapeado, então um campo faltando acendia alarme de produção em vez de dizer ao
  cliente qual campo corrigir. Agora é 400, com o nome do campo.
- **Resumo reenviado a cada ciclo.** O filtro do repositório é
  `detectada_em >= desde`, e usar o instante do último envio reincluía a novidade
  detectada no mesmo milissegundo. O usuário receberia o mesmo aviso para sempre
  e pararia de confiar no aviso.

### Notas de arquitetura

- `Movimentacao` ganhou `teorIndisponivel`, `exigeAcao`, `fonte` e `url`.
- Falha de varredura **não** marca a inscrição como varrida: marcar abriria um
  buraco silencioso exatamente no período em que a fonte esteve fora.
- A vigilância **funde** o retrato guardado com o que o DJEN traz, nunca
  substitui — o DJEN não tem os andamentos internos, e substituir faria um
  processo de 361 andamentos aparecer com 8.
- `nodemailer` é a primeira dependência de runtime nova desde o Fastify.

### ⚠️ Ação necessária no deploy

Se `PROCESSOVIVO_PROVIDER_CHAIN` estiver preenchida no Easypanel com o valor antigo,
**troque para `datajud,djen`**. Valor explícito ganha do padrão do código — foi
por isso que o DJEN não entrou na v0.9.0. Sem `djen` na cadeia, a vigilância por
OAB responde 501.

---

## [0.9.0] — 2026-09-05

**A busca por OAB passa a existir — e o processo passa a vir inteiro.**

Até aqui o Processo Vivo enxergava metade de cada processo: o DataJud entrega
metadados e a linha do tempo codificada, mas não indexa parte nem advogado, e
por isso `buscarPorOab` só sabia lançar `OperacaoNaoSuportadaError`. Esta versão
fecha o buraco com uma segunda fonte oficial.

### Como cheguei aqui — e por que NÃO tem crawler

O plano era escrever um crawler do tribunal. Investiguei antes de codar, e a
investigação matou o plano duas vezes:

1. **O TJGO não usa eproc.** O campo `sistema` do DataJud diz `Eproc`, mas
   nenhum host de eproc do TJGO existe (`eproc.tjgo.jus.br`, `eproc1`, `eproc2`
   — todos sem DNS). O sistema real é o **Projudi**. Um adapter escrito a partir
   daquele campo teria sido escrito contra um sistema que o tribunal não usa.
2. **A consulta pública do Projudi é protegida por Cloudflare Turnstile.** O
   formulário carrega `challenges.cloudflare.com/turnstile/v0/api.js` em modo
   `render=explicit` e o botão Buscar nasce `disabled`, só habilitando com token
   válido. Não é rate limit: é desafio anti-bot em toda consulta. E o formulário
   **não tem campo de OAB** — mesmo vencido o desafio, a funcionalidade
   pretendida não estava lá.

Contornar CAPTCHA está fora de cogitação: é o tribunal dizendo que não quer
robô, e dependeria de serviço pago de resolução, com custo por consulta e
quebra a cada ajuste da Cloudflare.

A saída foi outra fonte oficial.

### Adicionado

- **`DjenAdapter`** — Diário de Justiça Eletrônico Nacional, via Comunica API do
  CNJ (`comunicaapi.pje.jus.br`). Sem chave, sem CAPTCHA, cobertura nacional.
  Traz o que faltava:
  - **busca por OAB de verdade** (`numeroOab` + `ufOab`), a funcionalidade que
    faz um advogado assinar;
  - **partes**, com polo;
  - **advogados**, com número e UF da inscrição;
  - **inteiro teor** do ato publicado, não só o rótulo.
- **Enriquecimento entre fontes** no `ProcessoSearchService`. Achar o processo
  deixou de encerrar a busca: as fontes seguintes que sabem algo que a vencedora
  não sabe são consultadas e os resultados são fundidos. É o que torna a
  arquitetura híbrida de fato híbrida, e não só uma cadeia de fallback.
- **`fundirProcessos`** (`domain/entities/fusaoProcessos.ts`) — regra de
  precedência entre fontes: a preferida vence em campo escalar, a complementar
  só preenche buraco, e as linhas do tempo se unem sem duplicar.
- **Capacidade `retornaLinhaDoTempoCompleta`** na porta `ProcessoProvider`.
  Sem ela o orquestrador via um resultado do DJEN com partes e teor, concluía
  que não faltava nada, e nunca perguntava ao DataJud — um processo com 361
  andamentos apareceria com 8.
- **`Movimentacao.idExterno`, `.url` e `.fonte`.** O `idExterno` conserta um bug
  latente na detecção de novidades: a chave era `data|titulo`, e o DJEN informa
  só o dia, então duas decisões publicadas no mesmo dia no mesmo processo
  viravam uma só e a segunda nunca era avisada.
- **Acompanhar em lote** na tela: o resultado da busca por OAB ganhou o botão
  _Acompanhar todos_. Digitar a própria inscrição uma vez e sair com a carteira
  inteira sob vigilância é o fluxo que fecha o produto.
- `tests/fixtures/djen-comunica-real.json` — captura real, com as armadilhas
  anotadas no cabeçalho.
- Suíte de integração `hibrido-datajud-djen.spec.ts`, que roda a cadeia contra
  as duas capturas reais e falha se o enriquecimento parar de acontecer.

### Corrigido

- **Enriquecimento não reabre fonte já descartada.** Uma fonte que acabou de dar
  timeout, que não cobre o tribunal ou que reprovou no health check não é
  consultada de novo na etapa de complemento.
- **O tribunal considerado no complemento é o do número CONSULTADO**, não o do
  processo devolvido — senão uma fonte que responde errado passa a decidir quem
  mais é chamado.
- `HttpClient.get` passou a aceitar `OpcoesRequisicao` (timeout e tentativas por
  chamada), como o `postJson` já aceitava.
- Duas mensagens da interface afirmavam que busca por OAB e inteiro teor
  "dependem do crawler do tribunal". Virou mentira quando o DJEN entrou, e
  mensagem desatualizada manda o usuário procurar defeito onde não há.

### Alterado

- **`PROCESSOVIVO_PROVIDER_CHAIN` mudou de `mock-crawler-tjsp,datajud` para
  `datajud,djen`.** O mock saiu do padrão: em produção ele inventaria processo.
  Sem `DATAJUD_API_KEY` a cadeia degrada sozinha para só o DJEN — que não exige
  chave, então o serviço sobe e funciona sem nenhuma configuração de fonte.

### Limites honestos desta fonte

- O DJEN só conhece o que foi **publicado no diário**. Juntada, conclusão e
  expediente de cartório não aparecem — para isso o DataJud continua na cadeia.
- Histórico curto: consulta a 2020 devolve zero. O DJEN concentra as publicações
  nacionais a partir de 2023/2024.
- `destinatarios` e `destinatarioadvogados` vêm como listas irmãs, sem ligação
  entre si. Com um destinatário — o caso comum — a associação é inequívoca; com
  vários, os advogados são atribuídos a todas as partes daquela comunicação.
- O DJEN não informa se a parte é pessoa física ou jurídica. Fica
  `DESCONHECIDO`; adivinhar por sufixo erra com espólio e condomínio.

---

## [0.8.0] — 2026-09-05

**O Processo Vivo deixa de ser consulta avulsa e vira produto de acompanhamento.**

### ⚠️ Ação necessária no deploy

Monte um **volume em `/dados`** no Easypanel (aba Mounts). Sem ele, o banco vive
dentro do contêiner e é apagado a cada redeploy — a carteira do usuário some.
Ver [DEPLOY.md](./DEPLOY.md).

A imagem passou para **Node 24**, exigido pelo `node:sqlite`.

### Adicionado

- **Acompanhamento de processos.** O usuário marca um processo e o Processo Vivo passa
  a verificá-lo sozinho. A primeira consulta acontece na hora de adicionar, para
  o processo já aparecer preenchido na lista.
- **Feed de atualizações.** Só o que apareceu DEPOIS de você começar a
  acompanhar, em ordem cronológica, com marcação de lido. Para um advogado, é
  provavelmente a tela mais útil: não "meus 40 processos", e sim "o que mudou".
- **Varredura automática em segundo plano**, a cada 12h por padrão, com disparo
  manual pela tela. Sequencial e com pausa entre consultas — paralelizar contra
  a chave compartilhada do CNJ queimaria a cota de todo o país.
- **Navegação de verdade**: Atualizações, Meus processos e Buscar, com detalhe do
  processo e volta.
- **Filtros** na lista (texto, tribunal, classe, período, só com novidade,
  ordenação) e no feed (não lidas, tribunal), alimentados por facetas reais do
  banco.
- **Espaços isolados por chave de API.** Enquanto não há contas de usuário, cada
  chave é um assinante com sua própria carteira. A coluna `workspace` já existe
  no banco, então migrar para login não mexe no modelo.
- Persistência em **SQLite** via `node:sqlite` — sem dependência nativa, sem
  toolchain de compilação no Alpine, sem serviço extra para subir.
- 34 testes novos (total: 218), incluindo isolamento entre workspaces, detecção
  de novidade entre duas varreduras e idempotência da sincronização.

### Decisões que vale registrar

**Por que banco agora, depois de eu ter recusado.** Recusei quando o motivo era
"guardar processos" — não havia o que guardar além de ficção. Duas medidas
mudaram isso: a consulta fria ao CNJ leva ~20s (medido: `took: 20514`), então o
usuário não pode esperar pela fonte; e "o que mudou desde ontem" é irrespondível
sem ter o ontem. O banco deixou de ser preferência de arquitetura e virou
requisito medido.

**Primeira sincronização não gera novidade.** O histórico inteiro seria "novo";
despejar 361 avisos em quem acabou de adicionar o processo não ajuda ninguém.

**Movimentação que some da fonte não vira alarme.** Tribunal reescreve e remove
andamento; tratar ausência como evento geraria alarme falso a cada oscilação, e
alarme falso corrói a confiança no aviso que importa.

**Falha ao adicionar não desfaz o acompanhamento.** O processo fica na lista com
o motivo, e a varredura tenta de novo — senão o usuário teria que readicionar
toda vez que o tribunal saísse do ar.

---

## [0.7.0] — 2026-09-05

Foco: a tela mostrar o que importa, e a data certa.

### Corrigido

- **A data de distribuição aparecia um dia antes.** O formato compacto do CNJ
  (`"20150826000000"`) não declara fuso, e eu o interpretava como UTC — que,
  exibido em horário de Brasília, volta para 25/08. Aparecia na tela como
  "Distribuição 25/08/2015" para um processo distribuído em 26/08. Agora é
  interpretado como UTC−03:00, que é como o CNJ carimba. Teste novo verifica a
  data **exibida**, não só a existência dela: o teste anterior passava com a data
  errada.

### Adicionado

- **Cabeçalho com o estado do processo**: número em destaque, classe e assunto,
  selos de tribunal/grau/fonte, e um bloco "última movimentação" com o tempo
  decorrido em linguagem natural ("há 2 meses").
- **Linha do tempo organizada**, no lugar da lista plana de 361 itens:
  - agrupada por ano, com o ano fixo no topo enquanto se rola;
  - repetições idênticas no mesmo dia colapsadas em um item com `×N` — o CNJ
    registra "Confirmada" duas e três vezes seguidas;
  - **andamentos internos recolhidos por padrão** (confirmações, expedições,
    juntadas de documento). Numa resposta real de 361 andamentos, isso reduz a
    124 o que aparece de primeira — 66% do volume é registro de cartório que não
    muda o estado do processo;
  - **marcos em destaque** (distribuição, sentença, trânsito em julgado, alvará,
    decurso de prazo).
- Metadados em grade, com contagem total de andamentos.

### Importante sobre o que fica recolhido

Nada é descartado. A contagem do que foi recolhido fica sempre visível, um
clique reverte, e a escolha é lembrada no navegador. Sumir com movimentação em
silêncio é como se perde prazo — o mesmo princípio que fez a data em formato
desconhecido passar a falhar alto na v0.5.0.

A classificação entre "interno" e "marco" usa códigos da Tabela Processual
Unificada observados numa resposta real do TJGO, mas quem decide o que importa é
quem advoga. Se estiver errada, é a tabela que muda — o dado continua todo lá.

---

## [0.6.0] — 2026-09-04

**O sistema passou a ter tela.**

### Adicionado

- **Console web em `/`**, servido pela própria API. Abrir o domínio no navegador
  agora abre o sistema: campo para a chave, consulta por número CNJ ou por OAB,
  e o processo renderizado com partes e movimentações.

  Motivo: até aqui o Processo Vivo era só API. Digitar a URL no navegador devolvia
  `{"erro":"NAO_AUTENTICADO"}`, porque navegador não manda header customizado —
  e do lado de quem usa, isso é indistinguível de "não funciona". Servindo da
  mesma origem, a página manda o `x-api-key` sozinha: sem CORS, sem PowerShell,
  sem curl.

- A tela mostra **cronômetro e aviso durante a espera**, porque a consulta fria
  ao CNJ leva até um minuto — sem isso, a página pareceria travada.
- Cada código de erro vira explicação em português, incluindo o 501 de busca por
  OAB (que o DataJud não faz) e o 502 de fonte externa lenta ou fora.
- A ausência de partes é dita na tela em vez de aparecer como espaço vazio: a
  base do CNJ não publica partes nem advogados.
- 8 testes novos (total: 180), incluindo que a raiz abre sem chave, que as rotas
  de dados **continuam** protegidas, e que a página não carrega nada de fora.

### Notas

O console é uma ferramenta de operação para conferir o serviço, não o produto
final: a chave de API fica no navegador de quem opera. O produto terá contas de
usuário, e a chave nunca chegará ao navegador do advogado.

Sem framework, sem build, sem recurso externo — a página é uma string que o
servidor devolve. Nada para compilar e nada que quebre em deploy.

---

## [0.5.0] — 2026-09-04

**Primeira versão validada contra uma resposta real da API do CNJ.** Até aqui,
todo o adapter do DataJud tinha sido escrito e testado contra um fixture que eu
inventei a partir da documentação. A primeira captura real derrubou duas
suposições no primeiro minuto.

### Corrigido

- **`dataAjuizamento` não é ISO.** Vem como `"20150826000000"`
  (`yyyyMMddHHmmss`), enquanto `movimentos[].dataHora` no MESMO documento vem em
  ISO 8601. O mapper fazia `new Date()` nos dois: o compacto virava
  `Invalid Date`, que virava `undefined`, e o processo era entregue "com
  sucesso" **sem data de distribuição**. Nenhum dos 161 testes pegou, porque
  todos validavam a minha suposição contra ela mesma.
- **Timeout curto demais fazia toda consulta fria falhar.** O Elasticsearch
  público do CNJ reportou `took: 20514` — 20,5 segundos — numa busca por número
  em índice frio. O teto era 8s. O erro saía como "timeout ao contatar a API do
  CNJ", que parece problema de rede e mandou a investigação para o lado errado.
  Consultas: 60s e 2 tentativas. Health check: 15s (era 5s) e 1 tentativa.

### Alterado

- **Data em formato desconhecido agora falha alto** (`RespostaInvalidaError`,
  nomeando campo e valor) em vez de virar `undefined`. Num produto onde a data
  decide prazo, entregar campo vazio é pior que recusar a resposta — o
  orquestrador ainda pode tentar outra fonte, mas ninguém reage a um campo que
  sumiu em silêncio. Campo AUSENTE continua sendo ausência, não erro.
- `tests/fixtures/datajud-tjgo-real.json` substitui o fixture inventado.
  Captura real do TJGO, valores intocados, lista de movimentos reduzida
  mantendo um exemplar de cada forma. Daqui em diante, o comportamento do CNJ se
  testa contra o que ele devolve.

### Confirmado pelo dado real

- Zero partes, zero advogados, zero inteiro teor. A busca por OAB não sai do
  DataJud — é o que sustenta a existência do crawler próprio no desenho.
- O processo do TJGO usado na captura roda em **eproc**
  (`"sistema": {"nome": "Eproc"}`), não Projudi.

### Em aberto

60 segundos é tempo demais para um usuário esperando numa tela. Este release
torna a consulta possível, não confortável. A saída é buscar em segundo plano e
servir do armazenamento, com o usuário fora do caminho crítico da fonte — e é
essa lentidão medida, não uma preferência de arquitetura, que passa a justificar
um banco.

---

## [0.4.2] — 2026-09-03

Foco: o health check do DataJud dava timeout contra a API real.

### Corrigido

- **A consulta de verificação era `match_all` no índice do TJSP** — o maior
  tribunal do país. Mesmo com `size: 0`, isso faz o Elasticsearch percorrer e
  contar o índice inteiro: a query mais cara possível, disparada a cada
  `/ready`. Contra a API pública compartilhada e sob carga, dava timeout, e o
  Processo Vivo concluía "fonte fora do ar" com a fonte no ar. Agora a consulta casa
  com zero documentos (um número CNJ de vinte zeros), que responde a mesma
  pergunta — "consigo falar com a fonte e ela me aceita?" — de graça.
- **O health check herdava a política de retry das consultas de usuário**
  (3 tentativas × 8s + backoff): o `/ready` podia levar mais de 25 segundos só
  para dizer que a fonte estava fora — tempo suficiente para um orquestrador de
  contêiner concluir que o serviço inteiro morreu. Agora é tentativa única com
  teto de 5s.

### Adicionado

- `OpcoesRequisicao` no `HttpClient`: `timeoutMs` e `tentativas` por chamada,
  sobrepondo o padrão do cliente. Nem toda requisição merece a mesma política —
  consulta de usuário compensa esperar e insistir, health check não.
- 7 testes novos, incluindo a política de retry do `HttpClient` contra `fetch`
  dublado (total: 161).

---

## [0.4.1] — 2026-09-03

Foco: impedir que texto de exemplo vire credencial.

### Corrigido

- **O bloco de configuração do `DEPLOY.md` trazia placeholders não vazios**
  (`DATAJUD_API_KEY=COLE_AQUI_A_CHAVE_DO_CNJ_OU_DEIXE_VAZIO`). Colado como
  estava, o valor passava em toda checagem de presença: o adapter do DataJud
  subia com uma credencial de mentira, entrava na cadeia e só falhava com 401 —
  aparecendo no `/ready` como problema de disponibilidade, não de configuração.
  Os blocos agora vêm com os valores realmente vazios e a instrução em
  comentário.

### Adicionado

- `pareceValorDeExemplo()` — detecta placeholder não substituído. A heurística é
  conservadora de propósito (só maiúsculas/dígitos/`_`/`-` **e** termo suspeito),
  porque falso positivo aqui recusaria credencial legítima.
  - `DATAJUD_API_KEY` com placeholder → fonte tratada como **ausente**, com aviso
    dizendo o que fazer, em vez de virar credencial quebrada.
  - `PROCESSOVIVO_API_KEYS` com placeholder → serviço **recusa subir**. Um placeholder
    de 35 caracteres passaria no mínimo de 24 e viraria a chave de produção.
- 9 testes novos, incluindo o valor exato do incidente (total: 154).

---

## [0.4.0] — 2026-09-02

Foco: tornar `/ready` capaz de explicar o que está errado.

### Corrigido

- **`healthCheck` do DataJud reprovava fonte que estava disponível.** Qualquer
  resposta fora do 2xx marcava a fonte como morta — inclusive um 4xx que não é
  de autenticação, que na verdade significa "cheguei, a chave foi aceita, só a
  consulta de verificação foi recusada". Na prática isso tirava o DataJud da
  cadeia de fallback com ele funcionando. Agora 4xx não-autenticação conta como
  saudável, com uma ressalva no motivo.

### Adicionado

- `diagnosticar()` na porta `ProcessoProvider` — opcional, para não forçar
  migração de adapter existente; quem não implementa cai no `healthCheck`.
- `GET /ready` e `npm run cli -- saude` agora trazem o **motivo** por fonte:
  chave rejeitada (com o link da chave vigente), limite excedido (com o
  parâmetro a ajustar), API do CNJ fora do ar, timeout ou falha de rede.
  Antes, `saudavel: false` era um beco sem saída.
- 9 testes novos cobrindo cada classificação (total: 145).

---

## [0.3.0] — 2026-09-02

Foco: geração e proteção das chaves de API.

### Adicionado

- `npm run chave` — gera chaves de API sem depender de `openssl` (que não existe
  no Windows fora do Git Bash/WSL). Imprime o valor **e** o identificador que
  aparece nos logs, para você anotar qual chave é de qual consumidor.
- Validação de autenticação no arranque (`src/main/http/chaves.ts`): recusa subir
  sem chave, com chave de menos de 24 caracteres, com chaves repetidas, ou com
  `PROCESSOVIVO_AUTH_DISABLED=true` junto de chaves preenchidas.
- Seção completa no `DEPLOY.md` sobre gerar, guardar e rotacionar chaves sem
  downtime.
- 11 testes novos (total: 135).

### Alterado

- **Identificador de chave nos logs agora é hash** (8 hex do SHA-256) em vez dos
  4 primeiros caracteres da chave. O prefixo vazava parte do segredo e deixava
  de distinguir qualquer coisa se as chaves compartilhassem convenção de nome.
- `GET /health` agora informa a versão do serviço.

### Corrigido

- Documentação recomendava `openssl rand -hex 32` sem alternativa para Windows.
- Item de troubleshooting sobre "espaço na variável" estava errado: espaços em
  volta das vírgulas sempre foram tolerados.

---

## [0.2.0] — 2026-09-02

Foco: tornar o projeto publicável em servidor.

### Adicionado

- **API HTTP** (Fastify) como segundo adaptador de entrada, sobre os mesmos
  casos de uso do CLI:
  - `GET /v1/processos/:numero`
  - `GET /v1/advogados/:uf/:oab/processos`
  - `GET /health` (liveness, não consulta fonte externa)
  - `GET /ready` (readiness, com diagnóstico por fonte)
- Autenticação por chave de API (`x-api-key` ou `Authorization: Bearer`).
- Rate limit por chave, com health checks fora da cota.
- Mapeamento centralizado de erro de domínio para status HTTP, separando culpa
  do cliente (4xx), falha rio acima (502/503) e bug nosso (500).
- Desligamento gracioso em SIGTERM — redeploy não derruba requisição em voo.
- `Dockerfile` multi-stage, `.dockerignore`, `docker-compose.yml`.
- `DEPLOY.md`: runbook do Easypanel.
- CI no GitHub Actions (typecheck, lint, testes, build da imagem).
- 23 testes de API (total: 124).

### Alterado

- `npm run dev` e `npm start` agora sobem a API. O CLI segue em `npm run cli`.

---

## [0.1.0] — 2026-09-02

Núcleo do MVP.

### Adicionado

- Domínio: `Processo`, `Movimentacao`, `Parte`, e os value objects `NumeroCNJ`
  (com validação de dígito verificador, ISO 7064 MOD 97-10) e `Oab`.
- Porta `ProcessoProvider` com declaração de capacidades por fonte.
- `DataJudAdapter` — API Pública do CNJ, com mapper anticorrupção e validação de
  payload por Zod.
- `MockCrawlerAdapter` — crawler simulado do e-SAJ (TJSP), com falha configurável
  para exercitar o fallback.
- `ProcessoSearchService` — orquestrador com cadeia ordenada, fallback automático
  e distinção entre "não encontrado" e "fonte fora do ar".
- Cache em memória com TTL e LRU, aplicado por decorator.
- Token bucket para autolimitar as chamadas ao DataJud.
- CLI (`processo`, `oab`, `saude`).
- `CLAUDE.md` com regras de código e arquitetura.
- 101 testes.
