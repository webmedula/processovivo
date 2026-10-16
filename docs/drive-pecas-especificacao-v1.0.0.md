# Salvar as peças no Google Drive — especificação v1.0.0

Produto 0.42.0. Curta de propósito: as decisões do dono e os casos de erro. O porquê de cada
regra está no `CLAUDE.md` (§8, "Google Drive") e nos comentários do código.

## 1. Decisões do dono

1. **Pasta.** O sistema cria a pasta raiz **"Processo Vivo"** no Drive do advogado ao conectar, e
   **uma subpasta por processo** (nome = número CNJ formatado). Sem seletor de pastas (Picker),
   sem chave de API extra.
2. **Escopo único.** `https://www.googleapis.com/auth/drive.file`: o sistema só enxerga o que ele
   mesmo criou. Nunca se pede escopo mais amplo; nunca se lê nada do Drive além do que foi criado
   (não há listagem nem busca por nome). Não é configurável.
3. **Sigilo.** Peça com `nivelSigilo > 0` e processo com `segredoJustica` **não vão** (mesma regra
   da Pasta digital): zero chamadas ao Drive. O resultado diz quantas ficaram de fora.
4. **Gatilho.** Só o botão "Salvar no Drive" na Pasta digital (peças marcadas, ou todas as
   guardáveis quando nada está marcado). Nenhum envio automático; nenhum agendador chama o serviço.
5. **Sentido único.** O sistema grava. Não lê de volta, não apaga, não renomeia, não compartilha.
   A única leitura é "o que EU criei ainda existe?", pelo id guardado.
6. **Plano.** Recurso `salvarNoDrive` nos planos **Peças** e **IA** (retrocarga única nos planos já
   gravados). Quem não tem vê o aviso fixo e nenhuma chamada ao Google é feita. Conta sem
   assinatura (chave de API) **não** passa — como a análise por IA. O plano IA continua fora de
   venda (`analiseIa` segue `implementado: false`).
7. **Desligado por padrão.** `PROCESSOVIVO_DRIVE_HABILITADO=false`. O dono liga.

## 2. Como funciona

- **Conexão (OAuth 2.0, código de autorização).** `POST /v1/drive/conexao` devolve o endereço do
  Google. `state` assinado (HMAC), de uso único, 10 min de validade, amarrado ao workspace; PKCE
  S256 além do segredo; `access_type=offline` + `prompt=consent`. O retorno
  (`GET /v1/drive/retorno`) exige sessão, nunca mostra token nem o põe em URL ou log, e sempre
  redireciona para `/?drive=ok` ou `/?drive=erro&motivo=…`. O consentimento granular é conferido:
  sem a permissão da pasta, a conexão é recusada (`escopo_negado`).
- **Tokens.** Cifrados no cofre AES-256-GCM (o mesmo das credenciais de tribunal), por workspace.
  Renovação sob demanda, uma por vez por workspace; `401` renova uma vez e repete.
- **Envio.** Job em memória (um por workspace, teto global `PROCESSOVIVO_DRIVE_MAX_SIMULTANEOS`),
  uma peça por vez, pausa entre elas, cancelável. Os bytes vêm da guarda da Pasta; peça que
  venceu da guarda é pedida pelo **mesmo caminho do clique da Pasta** (debounce, fila, pausa de 3 s,
  disjuntor) e só porque o advogado clicou. Sem retry contra o tribunal.
- **Nome do arquivo.** `NNNN - Rótulo - dd-mm-aaaa.pdf` (`0382 - Decisão - 14-10-2026.pdf`):
  número do ato **como a Pasta o mostra** (posição calculada, ou o número do Projudi quando a
  calibração do advogado o provou — nunca "oficial"), rótulo do tribunal, data do ato (fuso de
  São Paulo). Peça convertida leva ` (conversão de HTML)` / ` (conversão de imagem)` e a
  observação da Pasta vai na descrição do arquivo. Saneado (sem `/`, controle, `\:*?"<>|`), no
  máximo 150 caracteres (o rótulo cede). Nomes iguais no processo ganham ` (2)`, ` (3)`.
- **Upload.** Até **5 MiB** (`LIMITE_DO_UPLOAD_SIMPLES_BYTES`): um pedido multipart. Acima:
  **resumível**, em pedaços de **8 MiB** (`TAMANHO_DO_PEDACO_BYTES`, múltiplo de 256 KiB), com uma
  recuperação por pedaço (pergunta ao Google quanto recebeu e continua).
- **Idempotência.** Tabela `pecas_no_drive` por (workspace, processo, peça), com `fileId`, hash
  SHA-256 e data. Mesmo hash: "já estava". Hash novo: atualiza o **mesmo** arquivo.

## 3. Casos de erro

| Caso | O que acontece |
|---|---|
| Recurso desligado | `GET /v1/drive` → `{habilitado:false}`; demais rotas 501; a tela não mostra nada |
| Sem o recurso no plano | 403 `sem_plano`; aviso fixo; **zero** chamadas ao Google |
| Não conectado / autorização caída | 409 `nao_conectado` / `precisa_reconectar` |
| `state` inválido, expirado, usado, de outra conta | retorno → `/?drive=erro&motivo=estado_invalido`; o Google não é chamado |
| Advogado cancelou no Google | `/?drive=erro&motivo=negado`; o `state` é gasto |
| Permissão da pasta desmarcada | `escopo_negado`; nada é conectado |
| `invalid_grant` (revogou / venceu) | envio para; conexão vira `precisa_reconectar`; "Reconectar" |
| `storageQuotaExceeded` (Drive cheio) | **o lote para**; mensagem própria |
| 429 / `userRateLimitExceeded` | backoff 1 s, 2 s, 4 s (máx. 4 tentativas); `Retry-After` respeitado até 60 s; acima disso ou esgotado: o lote para ("limite de uso") |
| 5xx / rede | mesmo backoff; a peça falha; 3 falhas seguidas encerram o lote |
| Outro 4xx numa peça | só ela falha ("recusada pelo Drive"); o lote segue |
| Pasta raiz / subpasta na lixeira ou apagada | recriada **uma** vez; aviso no resultado |
| Pai some no meio do envio | recria a subpasta uma vez e repete; de novo = a peça falha (sem laço) |
| Arquivo apagado pelo advogado (404 / `trashed`) | **não reenvia sozinho**: "removida no Drive"; reenviar só por clique ("Reenviar as removidas"), que cria arquivo novo. Restaurado da lixeira: volta a valer |
| Peça sigilosa / processo em segredo de justiça | fora, contado ("N sigilosas ficaram de fora"); processo sigiloso = 403 e zero chamadas |
| Peça não veio do tribunal | a peça falha, o lote segue; credencial do tribunal ausente/recusada ou bloqueio **param** o lote |
| Envio já em andamento no workspace | 409 `job_em_andamento` |
| Teto global de envios | 429 `limite_global` |
| Envio de outra conta | 404, igual ao "não existe" |
| Desconectar | cancela o envio, revoga no Google (melhor esforço), **apaga** a autorização do cofre, mantém o histórico como "desconectado"; nada some do Drive do advogado; vale mesmo sem plano |

## 4. O que NÃO foi feito (de propósito)

Picker de pastas; envio automático; leitura de volta; apagar/renomear/compartilhar; retomar o job
depois de redeploy (é em memória — clicar de novo continua de onde parou, porque a idempotência
faz as já enviadas virarem "já estavam"); SDK `googleapis`.
