import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PLANOS_INICIAIS } from '../../../domain/entities/Plano.js';
import { paraBusca } from '../normalizacaoBusca.js';

/**
 * Banco embutido, via `node:sqlite`.
 *
 * Escolhido em vez de `better-sqlite3` por um motivo concreto: nenhuma
 * dependência nativa. A imagem é Alpine, e compilar módulo nativo lá exige
 * python, make e g++ no estágio de build — mais tempo, mais superfície, mais
 * coisa para quebrar num deploy que já deu trabalho. `node:sqlite` vem no
 * runtime (estável a partir do Node 24, que é o que a imagem usa).
 *
 * Escolhido em vez de Postgres por enquanto porque é UMA instância: um arquivo
 * num volume resolve, sem serviço extra para subir e monitorar. Quando houver
 * mais de uma instância, é escrever outro repositório para a mesma porta.
 */

const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS acompanhamentos (
     workspace       TEXT NOT NULL,
     numero          TEXT NOT NULL,
     apelido         TEXT,
     -- Nome que o advogado dá à pasta: "Grupo Lume", "R. Andrade".
     --
     -- Separado de apelido porque servem a coisas diferentes e só um dos dois
     -- agrupa. Apelido nomeia o CASO ("Ação trabalhista do Silva"); cliente
     -- nomeia a PESSOA, e é por ela que o escritório organiza a carteira.
     -- Agrupar por apelido não funcionaria: dois processos do mesmo cliente
     -- ganham apelidos diferentes e nunca cairiam no mesmo grupo.
     cliente         TEXT,
     criado_em       TEXT NOT NULL,
     sincronizado_em TEXT,
     erro            TEXT,
     processo        TEXT,
     -- Colunas desnormalizadas a partir do JSON do processo. Existem para que
     -- a lista filtre e ordene em SQL: com json_extract em cada linha, filtrar
     -- por tribunal viraria varredura completa a cada abertura da tela.
     tribunal        TEXT,
     classe          TEXT,
     ultima_mov_data TEXT,
     -- Nomes das partes, em MAIÚSCULAS, separados por " | ".
     --
     -- Desnormalizado pelo mesmo motivo de tribunal e classe: o filtro "quais
     -- processos são do meu cliente X" é o que o advogado mais faz numa
     -- carteira grande, e resolvê-lo com json_each sobre o processo inteiro
     -- significaria desserializar ~100 KB por linha a cada tecla digitada.
     -- Numa carteira de 2.000 processos isso é 200 MB de JSON por busca.
     partes_texto    TEXT,
     PRIMARY KEY (workspace, numero)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_acomp_ws_mov
     ON acompanhamentos (workspace, ultima_mov_data DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_acomp_sincronizar
     ON acompanhamentos (sincronizado_em)`,

  `CREATE TABLE IF NOT EXISTS novidades (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     workspace    TEXT NOT NULL,
     numero       TEXT NOT NULL,
     data         TEXT NOT NULL,
     titulo       TEXT NOT NULL,
     codigo_tpu   INTEGER,
     conteudo     TEXT,
     tribunal     TEXT,
     detectada_em TEXT NOT NULL,
     vista_em     TEXT
   )`,
  // Idempotência da sincronização: rodar a varredura duas vezes não pode
  // duplicar aviso. É o índice, e não o código, que garante isso.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_nov_unica
     ON novidades (workspace, numero, data, titulo)`,
  `CREATE INDEX IF NOT EXISTS idx_nov_feed
     ON novidades (workspace, detectada_em DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_nov_nao_vistas
     ON novidades (workspace, vista_em)`,

  // Inscrições da OAB sob vigilância contínua. A chave é (workspace, oab, uf)
  // e não um id: cadastrar a mesma inscrição duas vezes tem que ser a mesma
  // vigilância, não duas varreduras concorrentes contra a mesma fonte.
  `CREATE TABLE IF NOT EXISTS vigilancias_oab (
     workspace            TEXT NOT NULL,
     oab                  TEXT NOT NULL,
     uf                   TEXT NOT NULL,
     apelido              TEXT,
     criada_em            TEXT NOT NULL,
     varrida_em           TEXT,
     erro                 TEXT,
     processos_encontrados INTEGER NOT NULL DEFAULT 0,
     ativa                INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (workspace, oab, uf)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_vig_varrer
     ON vigilancias_oab (ativa, varrida_em)`,

  `CREATE TABLE IF NOT EXISTS notificacoes (
     workspace        TEXT PRIMARY KEY,
     email            TEXT,
     ativa            INTEGER NOT NULL DEFAULT 0,
     ultimo_envio_em  TEXT,
     ultimo_alerta_em TEXT
   )`,

  // Credencial do advogado no tribunal, para as consultas que exigem
  // habilitação nos autos (peças, via MNI). A senha vai CIFRADA na coluna —
  // ver `infrastructure/seguranca/cofre.ts`. É o dado mais sensível do banco:
  // a chave de API só abre o Processo Vivo, esta abre o processo no tribunal.
  //
  // Uma credencial por (workspace, tribunal): o advogado tem uma inscrição por
  // sistema, e permitir duas criaria a dúvida de qual usar numa consulta — que
  // se resolveria testando as duas e colecionando recusa até bloquear a conta.
  `CREATE TABLE IF NOT EXISTS credenciais_tribunal (
     workspace     TEXT NOT NULL,
     tribunal      TEXT NOT NULL,
     identificacao TEXT NOT NULL,
     senha_cifrada TEXT NOT NULL,
     criada_em     TEXT NOT NULL,
     usada_em      TEXT,
     recusada_em   TEXT,
     PRIMARY KEY (workspace, tribunal)
   )`,

  // Chave-valor para marcas do sistema inteiro. Hoje guarda só quando a última
  // varredura terminou bem — o que sustenta o aviso de "faz X horas que não
  // consigo verificar". Precisa estar em disco: é depois de um redeploy que dá
  // para ficar horas sem varrer sem ninguém perceber.
  `CREATE TABLE IF NOT EXISTS pecas_baixadas (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     workspace  TEXT NOT NULL,
     numero     TEXT NOT NULL,
     peca_id    TEXT NOT NULL,
     rotulo     TEXT,
     mimetype   TEXT,
     bytes      INTEGER NOT NULL,
     baixada_em TEXT NOT NULL
     -- METADADO, nunca o arquivo. A peça avulsa vai do tribunal direto para a
     -- máquina do advogado: são autos de processo, muitos em segredo de
     -- justiça. (O PDF combinado do leitor, desde a v0.30.0, é a exceção
     -- decidida pelo dono — guarda temporária em disco, ver jobs_leitor.)
     --
     -- Sem chave única de propósito: baixar a mesma peça duas vezes são dois
     -- registros. "Puxei de novo na semana passada" é informação, e um UNIQUE
     -- aqui a apagaria em silêncio.
   )`,
  `CREATE INDEX IF NOT EXISTS idx_baixa_ws
     ON pecas_baixadas (workspace, baixada_em DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_baixa_processo
     ON pecas_baixadas (workspace, numero)`,

  `CREATE TABLE IF NOT EXISTS estado (
     chave TEXT PRIMARY KEY,
     valor TEXT NOT NULL
   )`,

  // A conta do assinante.
  //
  // `workspace` é gerado no cadastro e NUNCA muda: é a coluna que já separava
  // os dados por chave de API, e agora separa por conta. UNIQUE porque dois
  // assinantes com o mesmo workspace veriam os processos um do outro — é a
  // única falha aqui que não daria erro nenhum, só mostraria a carteira errada.
  //
  // `email` é UNIQUE e guardado já em minúsculas (ver `normalizarEmail`). Sem
  // normalizar antes, o UNIQUE do SQLite deixa passar `A@x.com` e `a@x.com`.
  //
  // `senha` guarda o hash scrypt COM os parâmetros — nunca a senha.
  `CREATE TABLE IF NOT EXISTS usuarios (
     id               TEXT PRIMARY KEY,
     email            TEXT NOT NULL UNIQUE,
     nome             TEXT NOT NULL,
     senha            TEXT NOT NULL,
     workspace        TEXT NOT NULL UNIQUE,
     oab              TEXT,
     uf_oab           TEXT,
     criado_em        TEXT NOT NULL,
     ultimo_acesso_em TEXT
   )`,

  // Sessões em DISCO, não em memória: o cache evapora no redeploy, e o Processo Vivo
  // é redeployado com frequência. Sessão em cache desconectaria todo mundo a
  // cada subida.
  //
  // A chave primária é o HASH do token. O token em si não existe no banco —
  // vazamento da tabela não vira sessão aberta na conta de ninguém.
  //
  // ON DELETE CASCADE: apagar a conta apaga as sessões junto. Sem isso ficaria
  // sessão órfã válida apontando para um usuário que não existe mais.
  `CREATE TABLE IF NOT EXISTS sessoes (
     hash_token  TEXT PRIMARY KEY,
     usuario_id  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
     criada_em   TEXT NOT NULL,
     expira_em   TEXT NOT NULL
   )`,

  // Pedidos de recuperação de senha.
  //
  // Mesma regra da sessão: a chave é o HASH do token, nunca o token. Quem lesse
  // esta tabela num vazamento não conseguiria redefinir a senha de ninguém.
  //
  // `usada_em` existe para que o link valha UMA vez. Sem isso, um link que
  // ficou no histórico do e-mail continuaria abrindo a conta meses depois — e
  // e-mail é o lugar menos seguro onde esse link vai parar.
  `CREATE TABLE IF NOT EXISTS recuperacoes_senha (
     hash_token TEXT PRIMARY KEY,
     usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
     criada_em  TEXT NOT NULL,
     expira_em  TEXT NOT NULL,
     usada_em   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_recup_usuario ON recuperacoes_senha(usuario_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recup_expira ON recuperacoes_senha(expira_em)`,

  // Assinatura: UMA por workspace, que é a unidade de isolamento de tudo o
  // mais. Por usuário criaria um segundo eixo, e no dia em que dois advogados
  // dividissem o mesmo ambiente ninguém saberia qual assinatura vale.
  //
  // **Não existe coluna `status`, e isso é deliberado.** Status gravado precisa
  // de alguém que o atualize, e esse alguém é sempre uma tarefa agendada que
  // pode não ter rodado — uma assinatura que venceu às 3h e só é marcada às 6h
  // são três horas em que o sistema mente. O status sai das datas, na entidade.
  //
  // `venceEm` tem índice porque a varredura de avisos pergunta exatamente por
  // ele: "quem vence nos próximos N dias".
  `CREATE TABLE IF NOT EXISTS assinaturas (
     workspace        TEXT PRIMARY KEY,
     plano            TEXT NOT NULL,
     inicio_em        TEXT NOT NULL,
     vence_em         TEXT NOT NULL,
     eh_teste         INTEGER NOT NULL DEFAULT 0,
     dias_carencia    INTEGER NOT NULL DEFAULT 0,
     cancelada_em     TEXT,
     observacao       TEXT,
     -- Última etapa de aviso já enviada nesta vigência: 'vencendo', 'carencia'
     -- ou 'bloqueada'. Existe para que o lembrete saia UMA vez por etapa: sem
     -- ela, a varredura mandaria o mesmo e-mail a cada volta, e o assinante
     -- aprenderia a ignorar justamente o remetente que também manda aviso de
     -- prazo. Renovar zera — a vigência nova começa sem aviso nenhum.
     ultimo_aviso     TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_assin_vence ON assinaturas(vence_em)`,

  // Chaves de API emitidas pela área administrativa — pool separado das
  // chaves estáticas de PROCESSOVIVO_API_KEYS, para poder crescer sem
  // redeploy. A chave primária é o HASH da chave, nunca a chave em si: mesma
  // regra de `sessoes` e `recuperacoes_senha` logo acima. `identificador` e
  // `workspace` não são colunas — são fatias do próprio hash (8 e 16
  // caracteres), calculadas em `RepositorioChavesApiSqlite`.
  `CREATE TABLE IF NOT EXISTS chaves_api (
     hash         TEXT PRIMARY KEY,
     rotulo       TEXT NOT NULL,
     criada_em    TEXT NOT NULL,
     revogada_em  TEXT
   )`,

  // O catálogo de planos, editável pela área administrativa desde a v0.28.0.
  //
  // `codigo` é a chave e não muda: `assinaturas.plano` aponta para ele. Não há
  // FOREIGN KEY daquele lado de propósito — a tabela `assinaturas` é anterior
  // a esta, e recriar a tabela de assinaturas em produção para ganhar uma
  // restrição é o tipo de migração que dá errado em silêncio. A integridade é
  // garantida por não existir remoção de plano (ver `RepositorioPlanos`).
  //
  // `recursos` é um array JSON de códigos de recurso. `preco_mensal_centavos`
  // NULL significa "sem preço publicado".
  `CREATE TABLE IF NOT EXISTS planos (
     codigo                 TEXT PRIMARY KEY,
     nome                   TEXT NOT NULL,
     resumo                 TEXT NOT NULL,
     recursos               TEXT NOT NULL,
     disponivel             INTEGER NOT NULL DEFAULT 0,
     preco_mensal_centavos  INTEGER,
     ordem                  INTEGER NOT NULL DEFAULT 0
   )`,

  // Regras de teste e carência. Uma linha só (`id = 1`, garantido pelo
  // CHECK); sem ela, valem as `REGRAS_PADRAO` do domínio.
  `CREATE TABLE IF NOT EXISTS regras_assinatura (
     id                INTEGER PRIMARY KEY CHECK (id = 1),
     dias_de_teste     INTEGER NOT NULL,
     plano_do_teste    TEXT NOT NULL,
     dias_de_carencia  INTEGER NOT NULL
   )`,

  // Jobs do leitor de peças (v0.30.0): um pedido de PDF combinado por linha.
  //
  // Colunas só para o que se FILTRA (dono, estado, quando retomar, quando
  // expira); o resto — peças, índice, contadores — vai em `dados`, JSON. O job
  // é gravado inteiro a cada lote, e é isso que o faz sobreviver a redeploy
  // sem baixar de novo o que já veio.
  //
  // A chave é (workspace, id), não só o id: nenhuma consulta do assinante
  // consegue chegar a um job sem dizer de quem ele é.
  `CREATE TABLE IF NOT EXISTS jobs_leitor (
     workspace     TEXT NOT NULL,
     id            TEXT NOT NULL,
     numero        TEXT NOT NULL,
     estado        TEXT NOT NULL,
     criado_em     TEXT NOT NULL,
     atualizado_em TEXT NOT NULL,
     retomar_em    TEXT,
     expira_em     TEXT,
     dados         TEXT NOT NULL,
     PRIMARY KEY (workspace, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_leitor_fila ON jobs_leitor (estado, criado_em)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_leitor_expira ON jobs_leitor (expira_em)`,

  // Pasta digital (v0.33.0): o retrato da listagem do tribunal e o índice das
  // peças guardadas por peça. Os BYTES ficam no armazém (fora do backup, que
  // copia o banco); aqui só metadado.
  //
  // Chaves começam por `workspace`: nenhuma consulta chega a uma linha sem dizer
  // de quem ela é. `localizador` é opaco e não sai em resposta HTTP nem em log.
  // Sem retrocarga: tabela nova, nada derivado de dado já guardado.
  `CREATE TABLE IF NOT EXISTS pasta_listagens (
     workspace         TEXT NOT NULL,
     numero            TEXT NOT NULL,
     tribunal          TEXT NOT NULL,
     listada_em        TEXT NOT NULL,
     processo_sigiloso INTEGER NOT NULL,
     pecas             TEXT NOT NULL,
     PRIMARY KEY (workspace, numero)
   )`,
  `CREATE TABLE IF NOT EXISTS pasta_pecas (
     workspace          TEXT NOT NULL,
     numero             TEXT NOT NULL,
     peca_id            TEXT NOT NULL,
     localizador        TEXT NOT NULL,
     mimetype_original  TEXT NOT NULL,
     conversao          TEXT NOT NULL,
     observacao         TEXT,
     bytes              INTEGER NOT NULL,
     paginas            INTEGER NOT NULL,
     obtida_em          TEXT NOT NULL,
     expira_em          TEXT NOT NULL,
     PRIMARY KEY (workspace, numero, peca_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pasta_pecas_expira ON pasta_pecas (expira_em)`,

  // Calendário (v0.32.0): eventos da agenda do advogado.
  //
  // A chave é (workspace, id): nenhuma consulta chega a um evento sem dizer de
  // quem ele é. `chave_deteccao` é a identidade de uma sugestão lida de um
  // andamento — (processo, andamento, tipo, data, hora) — gravada UMA vez, no
  // nascimento, e nunca recalculada: se fosse, corrigir a data de uma sugestão
  // faria a releitura do andamento criar a original de novo. O índice único
  // dela cobre também os DESCARTADOS, e é isso que impede uma sugestão
  // recusada de voltar.
  //
  // `segredo_justica` é cópia do processo, atualizada a cada sincronização:
  // o feed decide por ela se pode mostrar o número.
  `CREATE TABLE IF NOT EXISTS eventos_calendario (
     workspace        TEXT NOT NULL,
     id               TEXT NOT NULL,
     numero           TEXT NOT NULL,
     tribunal         TEXT NOT NULL,
     tipo             TEXT NOT NULL,
     titulo           TEXT NOT NULL,
     observacao       TEXT,
     data_local       TEXT NOT NULL,
     hora_local       TEXT,
     duracao_min      INTEGER,
     origem           TEXT NOT NULL,
     estado           TEXT NOT NULL,
     mov_id           TEXT,
     mov_data         TEXT,
     trecho           TEXT,
     chave_deteccao   TEXT,
     revisar          INTEGER NOT NULL DEFAULT 0,
     revisao_ate      TEXT,
     segredo_justica  INTEGER NOT NULL DEFAULT 0,
     sequencia        INTEGER NOT NULL DEFAULT 0,
     criado_em        TEXT NOT NULL,
     atualizado_em    TEXT NOT NULL,
     confirmado_em    TEXT,
     descartado_em    TEXT,
     PRIMARY KEY (workspace, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_eventos_ws_data
     ON eventos_calendario (workspace, data_local)`,
  `CREATE INDEX IF NOT EXISTS idx_eventos_ws_processo
     ON eventos_calendario (workspace, numero)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_eventos_deteccao
     ON eventos_calendario (workspace, chave_deteccao)
     WHERE chave_deteccao IS NOT NULL`,

  // Feeds ICS. O token em claro NUNCA é gravado — mesma regra de `sessoes` e
  // `chaves_api`: vazar a tabela não pode virar agenda alheia exposta. Um
  // vigente por workspace; regenerar revoga o anterior na mesma transação.
  `CREATE TABLE IF NOT EXISTS calendario_feeds (
     id               TEXT PRIMARY KEY,
     workspace        TEXT NOT NULL,
     token_hash       TEXT NOT NULL UNIQUE,
     inclui_sugeridos INTEGER NOT NULL DEFAULT 0,
     criado_em        TEXT NOT NULL,
     revogado_em      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_feeds_ws ON calendario_feeds (workspace, revogado_em)`,

  // Quem já teve os andamentos guardados relidos pela detecção (o
  // preenchimento retroativo de 180 dias). Uma linha por workspace.
  `CREATE TABLE IF NOT EXISTS calendario_retroativo (
     workspace TEXT PRIMARY KEY,
     feito_em  TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes(usuario_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessoes_expira ON sessoes(expira_em)`,
];

/**
 * Tabelas cuja presença de linhas significa "este banco está em uso".
 *
 * As quatro que representam trabalho do assinante. `marcas` e as tabelas de
 * sessão ficam de fora de propósito: elas se preenchem sozinhas no arranque e
 * fariam um banco recém-criado parecer habitado.
 */
const TABELAS_COM_DADO_DO_ASSINANTE = [
  'usuarios',
  'acompanhamentos',
  'credenciais_tribunal',
  'vigilancias',
];

function temConteudo(db: DatabaseSync): boolean {
  for (const tabela of TABELAS_COM_DADO_DO_ASSINANTE) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get() as unknown as {
        n: number;
      };
      if (Number(r.n) > 0) return true;
    } catch {
      // Tabela ausente é banco de versão anterior, não erro: segue para a próxima.
    }
  }
  return false;
}

function arquivoDeBancoTemConteudo(caminho: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(caminho, { readOnly: true });
    return temConteudo(db);
  } catch {
    // Arquivo ilegível ou que não é banco: não é dado a resgatar.
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Nomes que o arquivo do banco já teve. Hoje só um: o produto se chamava
 * LexFlow até a v0.18.0.
 */
const NOMES_ANTIGOS_DO_BANCO = ['lexflow.db'];

/**
 * Recusa subir quando o banco configurado não existe MAS o antigo está ali do lado.
 *
 * Isto aconteceu em produção, e o modo de falhar é o pior que existe neste
 * sistema. A v0.18.0 renomeou o produto e, junto, o caminho padrão do banco no
 * `Dockerfile` — de `/dados/lexflow.db` para `/dados/processovivo.db`. Quem não
 * declarava o caminho no painel herdava o padrão da imagem: no primeiro deploy,
 * o SQLite criou um arquivo NOVO e VAZIO, o serviço subiu saudável, o health
 * check passou, e o assinante entrou numa carteira em branco — com os dados
 * dele intactos no arquivo ao lado, invisíveis.
 *
 * Nada disso produziu um erro. Foi preciso ir ao banco para descobrir.
 *
 * Então a regra passa a ser: **na dúvida entre subir vazio e não subir, não
 * subir.** Um serviço fora do ar por dez minutos é um incidente comum; um
 * serviço no ar mostrando carteira vazia é o cliente achando que perdeu o
 * trabalho dele — e a diferença entre as duas coisas é a confiança no produto,
 * que não volta com um redeploy.
 *
 * A checagem é estreita de propósito: só dispara quando o arquivo configurado
 * NÃO existe e um dos nomes antigos existe na mesma pasta COM conteúdo. Numa
 * instalação nova, num volume novo, nada disso é verdade e a função é silenciosa.
 */
function conferirBancoAntigoAoLado(caminho: string, aberto?: DatabaseSync): void {
  // Duas passagens, e a segunda é a que pega o caso real.
  //
  // ANTES de abrir, o sinal é "o arquivo configurado não existe". Isso protege
  // o primeiro deploy depois da renomeação.
  //
  // DEPOIS de abrir, o sinal é "o arquivo configurado existe e está VAZIO".
  // Protege todos os deploys seguintes — porque no primeiro o SQLite já criou o
  // arquivo, e a partir daí ele existe. Sem esta segunda passagem a proteção
  // valeria uma vez só e ficaria calada justamente em quem já tropeçou.
  if (aberto ? temConteudo(aberto) : existsSync(caminho)) return;

  const pasta = dirname(caminho);
  for (const nome of NOMES_ANTIGOS_DO_BANCO) {
    const antigo = join(pasta, nome);
    if (antigo === caminho || !existsSync(antigo)) continue;
    if (statSync(antigo).size === 0) continue;
    // Um arquivo antigo também vazio não é dado a resgatar — e travar o
    // arranque por causa dele transformaria a proteção em estorvo.
    if (!arquivoDeBancoTemConteudo(antigo)) continue;

    // O estado do arquivo configurado muda o diagnóstico, e quem lê isto está
    // no meio de um deploy: a primeira linha precisa já dizer o que houve.
    const estado = existsSync(caminho) ? 'existe e está sem nenhum dado' : 'não existe';
    throw new Error(
      [
        `O banco configurado ${estado}, e há um banco antigo com dados na mesma pasta.`,
        ``,
        `  configurado:  ${caminho}   (${estado})`,
        `  encontrado:   ${antigo}`,
        ``,
        `Subir assim criaria um banco VAZIO e o sistema pareceria ter perdido as`,
        `contas, a carteira e os acessos aos tribunais — com os dados intactos no`,
        `arquivo acima. Por isso o Processo Vivo recusa iniciar.`,
        ``,
        `Escolha uma saída:`,
        ``,
        `  1. Apontar para o arquivo que tem os dados (mais simples, sem risco):`,
        `     PROCESSOVIVO_DB_PATH=${antigo}`,
        ``,
        `  2. Renomear o arquivo, com o serviço PARADO, levando -wal e -shm junto:`,
        `     mv ${antigo} ${caminho}`,
        `     mv ${antigo}-wal ${caminho}-wal   # se existir`,
        `     mv ${antigo}-shm ${caminho}-shm   # se existir`,
        ``,
        `  3. Começar mesmo um banco novo, de propósito, ignorando o antigo:`,
        `     PROCESSOVIVO_BANCO_NOVO=true`,
      ].join('\n'),
    );
  }
}

export function abrirBanco(caminho: string): DatabaseSync {
  if (caminho !== ':memory:') {
    // Antes do `mkdirSync`, e muito antes de abrir: depois que o SQLite toca no
    // caminho, o arquivo vazio já existe e a checagem não teria mais o que ver.
    if (process.env['PROCESSOVIVO_BANCO_NOVO'] !== 'true') {
      conferirBancoAntigoAoLado(caminho);
    }
    mkdirSync(dirname(caminho), { recursive: true });
  }

  const db = new DatabaseSync(caminho);

  // WAL: leitura não bloqueia escrita. Importante porque a varredura em
  // segundo plano escreve enquanto alguém navega pela interface.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Espera em vez de devolver SQLITE_BUSY na hora, para o caso raro de a
  // sincronização e uma requisição tentarem escrever ao mesmo tempo.
  db.exec('PRAGMA busy_timeout = 5000');

  for (const ddl of ESQUEMA) db.exec(ddl);
  migrarColunas(db);
  preencherPartesTexto(db);
  semearPlanos(db);
  acrescentarCalendarioAosPlanos(db);
  retrocarregarAssinaturas(db);

  // Segunda passagem: o esquema já existe, então dá para perguntar ao banco se
  // ele tem alguma coisa dentro. É aqui que o caso real é pego — o arquivo
  // vazio criado por um deploy anterior existe, e só a contagem denuncia.
  if (caminho !== ':memory:' && process.env['PROCESSOVIVO_BANCO_NOVO'] !== 'true') {
    try {
      conferirBancoAntigoAoLado(caminho, db);
    } catch (erro) {
      db.close();
      throw erro;
    }
  }

  return db;
}

/**
 * Colunas acrescentadas depois que a tabela já existia em produção.
 *
 * `CREATE TABLE IF NOT EXISTS` não resolve isto: num banco que já tem a tabela,
 * ele não faz nada, e a coluna nova nunca aparece. E `ALTER TABLE ADD COLUMN`
 * estoura se a coluna já está lá — então a checagem no `PRAGMA table_info`
 * precede a alteração. Sem os dois passos, ou o deploy quebra ou a coluna
 * simplesmente não existe, e o sintoma aparece como "o filtro não acha nada".
 */
const COLUNAS_ACRESCENTADAS: ReadonlyArray<{
  readonly tabela: string;
  readonly coluna: string;
  readonly tipo: string;
}> = [
  { tabela: 'acompanhamentos', coluna: 'partes_texto', tipo: 'TEXT' },
  /*
   * `total_atos_recebidos` (v0.34.0) NÃO tem retrocarga: o "N" só existe na
   * resposta do MNI, e consultar o tribunal sem a pessoa pedir é o que a regra
   * do MNI proíbe. NULL é a verdade ("listagem anterior à 0.34.0"): a coluna se
   * preenche na próxima vez que a tela carrega as peças do processo.
   */
  { tabela: 'pasta_listagens', coluna: 'total_atos_recebidos', tipo: 'INTEGER' },
  /*
   * `cliente` NÃO tem retrocarga, e a ausência é deliberada.
   *
   * A regra deste repositório manda retrocarregar coluna nova, e ela existe
   * para coluna DERIVADA de dado já guardado: sem a retrocarga, o filtro
   * enxergaria só o que foi sincronizado depois da atualização e ficaria calado
   * sobre o resto. `partes_texto` é exatamente esse caso — sai do JSON do
   * processo que já está no banco.
   *
   * `cliente` não sai de lugar nenhum. É o nome que o ADVOGADO dá à pasta, e
   * nenhuma fonte do processo sabe quem é o cliente dele: as partes vêm do
   * tribunal sem dizer qual delas ele representa, e chutar pela OAB do
   * advogado seria inventar vínculo de cliente a partir de palpite. Vazio aqui
   * significa "ainda não rotulado", que é a verdade.
   */
  { tabela: 'acompanhamentos', coluna: 'cliente', tipo: 'TEXT' },
];

function migrarColunas(db: DatabaseSync): void {
  for (const { tabela, coluna, tipo } of COLUNAS_ACRESCENTADAS) {
    const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all() as Array<{
      name: string;
    }>;
    if (colunas.some((c) => c.name === coluna)) continue;
    db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  }
}

/**
 * Retrocarga das partes nos processos já guardados.
 *
 * Por que retrocarregar em vez de esperar a próxima varredura: sem isso o
 * filtro por parte encontraria apenas os processos sincronizados DEPOIS da
 * atualização, e ficaria calado sobre os outros. Mostrar subconjunto em
 * silêncio é justamente o que este projeto já pagou caro para aprender.
 *
 * **Por que em JavaScript e não em SQL puro**, que era a primeira versão: o
 * `upper()` do SQLite é ASCII-only. `upper('José')` devolve `JOSé`. A
 * retrocarga em SQL gravaria uma forma e as sincronizações seguintes outra, e o
 * filtro acharia uns nomes e não outros — sem erro nenhum. A normalização mora
 * em `paraBusca`, e é a MESMA usada na gravação e na consulta.
 *
 * Só toca linhas sem o campo, então na segunda subida não faz trabalho nenhum.
 * Numa carteira grande isso é uma passada única, no arranque, e não por
 * requisição.
 */
function preencherPartesTexto(db: DatabaseSync): void {
  const pendentes = db
    .prepare(
      `SELECT workspace, numero, processo FROM acompanhamentos
        WHERE partes_texto IS NULL AND processo IS NOT NULL`,
    )
    .all() as Array<{ workspace: string; numero: string; processo: string }>;
  if (pendentes.length === 0) return;

  const gravar = db.prepare(
    'UPDATE acompanhamentos SET partes_texto = ? WHERE workspace = ? AND numero = ?',
  );

  for (const linha of pendentes) {
    let nomes: string[] = [];
    try {
      const bruto = JSON.parse(linha.processo) as { partes?: Array<{ nome?: string }> };
      nomes = (bruto.partes ?? [])
        .map((p) => (p.nome ?? '').trim())
        .filter((n) => n.length > 0);
    } catch {
      // Linha com JSON corrompido não derruba o arranque do servidor inteiro.
      // Ela fica sem o campo e volta a ser candidata na próxima subida — e a
      // próxima sincronização do processo resolve de vez.
      continue;
    }
    // Grava string vazia, e não NULL, para um processo que realmente não tem
    // parte: NULL o traria de volta nesta consulta a cada arranque, para
    // sempre.
    gravar.run(
      nomes.length > 0 ? paraBusca(nomes.join(' | ')) : '',
      linha.workspace,
      linha.numero,
    );
  }
}

/**
 * Os planos com que o sistema nasceu entram no catálogo — UMA vez.
 *
 * Só com a tabela vazia, e não com `INSERT OR IGNORE` a cada subida: depois
 * que o catálogo existe, ele é do operador. Reinserir a semente a cada
 * arranque não desfaria edições (o IGNORE preservaria as linhas), mas passaria
 * a ideia errada de que o código ainda manda na lista — e o dia em que a
 * semente mudasse, ela voltaria a aparecer num catálogo que alguém organizou.
 *
 * É o que mantém válidas as assinaturas gravadas antes da v0.28.0: elas
 * apontam para `acompanhamento`, `pecas` e `ia`, e os três passam a existir
 * como linha antes da primeira requisição.
 */
function semearPlanos(db: DatabaseSync): void {
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM planos').get() as {
    total: number;
  };
  if (total > 0) return;

  const gravar = db.prepare(
    `INSERT INTO planos
       (codigo, nome, resumo, recursos, disponivel, preco_mensal_centavos, ordem)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of PLANOS_INICIAIS) {
    gravar.run(
      p.codigo,
      p.nome,
      p.resumo,
      JSON.stringify(p.recursos),
      p.disponivelParaContratacao ? 1 : 0,
      p.precoMensalCentavos,
      p.ordem,
    );
  }
}

/** Marca, na tabela `estado`, de que a retrocarga do calendário já rodou. */
export const MARCA_CALENDARIO_NOS_PLANOS = 'retrocarga:calendario-nos-planos';

/**
 * O calendário entra em TODOS os planos já gravados (v0.32.0).
 *
 * Decisão do dono: o calendário é recurso do Acompanhamento, ou seja, de todos
 * os planos. Pôr só na semente não bastaria — a semente só entra com a tabela
 * vazia, e em produção o catálogo já existe. Seria a mesma lição da cobrança:
 * recurso que entra sem retrocarga é recurso que ninguém que já assina recebe.
 *
 * Roda UMA vez por banco (marca em `estado`), e não a cada arranque: depois
 * dela o catálogo volta a ser do operador. Se ele tirar o calendário de um
 * plano pelo painel, um redeploy não pode desfazer a decisão em silêncio.
 * Dentro da execução, só acrescenta a quem ainda não tem — nunca duplica.
 */
function acrescentarCalendarioAosPlanos(db: DatabaseSync): void {
  const feita = db
    .prepare('SELECT 1 FROM estado WHERE chave = ?')
    .get(MARCA_CALENDARIO_NOS_PLANOS);
  if (feita) return;

  const planos = db.prepare('SELECT codigo, recursos FROM planos').all() as Array<{
    codigo: string;
    recursos: string;
  }>;
  const gravar = db.prepare('UPDATE planos SET recursos = ? WHERE codigo = ?');

  db.exec('BEGIN');
  try {
    for (const p of planos) {
      let recursos: unknown;
      try {
        recursos = JSON.parse(p.recursos);
      } catch {
        // Linha corrompida não derruba o arranque; fica como está.
        continue;
      }
      if (!Array.isArray(recursos) || recursos.includes('calendario')) continue;
      gravar.run(JSON.stringify([...recursos, 'calendario']), p.codigo);
    }
    db.prepare('INSERT INTO estado (chave, valor) VALUES (?, ?)').run(
      MARCA_CALENDARIO_NOS_PLANOS,
      new Date().toISOString(),
    );
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
}

/** Quanto tempo de cortesia a retrocarga dá a quem já era assinante. */
const DIAS_DE_CORTESIA_NA_RETROCARGA = 365;

/**
 * Toda conta que já existia ganha assinatura ativa.
 *
 * **É a parte com risco real desta entrega.** Cobrança que entra sem
 * retrocarga transforma a atualização num bloqueio em massa: o advogado que
 * usava o sistema ontem abre hoje e encontra "sua assinatura venceu" sobre uma
 * carteira que ele montou à mão. Não há mensagem de erro que conserte essa
 * primeira impressão, e a vigilância dele teria parado em silêncio no meio.
 *
 * Quem já estava aqui entrou sem cobrança existir. Cortar seria mudar o trato
 * unilateralmente e sem aviso, então a retrocarga trata todos como assinantes
 * pagos do plano mais completo à venda, por um ano. É generoso de propósito: o
 * número de contas nesta situação é pequeno e conhecido, e cada uma pode ser
 * ajustada depois com um comando. O oposto — apertar e descobrir pelo
 * reclamante — não tem desfazer.
 *
 * Roda em toda subida e é idempotente: só alcança workspace SEM assinatura.
 * Conta nova criada depois disto já nasce com o teste, pelo `ServicoContas`.
 */
function retrocarregarAssinaturas(db: DatabaseSync): void {
  const pendentes = db
    .prepare(
      `SELECT u.workspace AS workspace
         FROM usuarios u
         LEFT JOIN assinaturas a ON a.workspace = u.workspace
        WHERE a.workspace IS NULL`,
    )
    .all() as Array<{ workspace: string }>;
  if (pendentes.length === 0) return;

  const agora = new Date();
  const vence = new Date(agora.getTime() + DIAS_DE_CORTESIA_NA_RETROCARGA * 86_400_000);
  const gravar = db.prepare(
    `INSERT INTO assinaturas
       (workspace, plano, inicio_em, vence_em, eh_teste, dias_carencia, observacao)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  );

  for (const { workspace } of pendentes) {
    gravar.run(
      workspace,
      'pecas',
      agora.toISOString(),
      vence.toISOString(),
      7,
      'retrocarga: conta anterior à cobrança',
    );
  }
}
