import { z } from 'zod';
import type { NivelLog } from '../../domain/ports/Logger.js';
import type { NivelDeRaciocinio } from '../adapters/modelo/TransporteOpenRouter.js';
import { ehApelidoOuVariante } from '../adapters/modelo/endpointsZdr.js';
import { pareceValorDeExemplo } from './placeholder.js';
import { FORMATO_DE_WORKSPACE } from '../../domain/entities/workspaceLiberado.js';

/**
 * Configuração validada no arranque.
 *
 * Falhar cedo e alto: variável ausente ou fora do formato derruba o processo na
 * inicialização, com o nome da variável na mensagem. O modo caro de descobrir
 * que `DATAJUD_API_KEY` estava vazia é o 401 na consulta de um cliente.
 */

const booleano = z
  .string()
  .transform((v) => ['1', 'true', 'yes', 'sim'].includes(v.toLowerCase()));

function inteiroPositivo(padrao: number): z.ZodDefault<z.ZodNumber> {
  return z.coerce.number().int().positive().default(padrao);
}

const schema = z.object({
  /**
   * Ordem das fontes. O DataJud vem primeiro porque só ele tem a linha do tempo
   * COMPLETA e a data de distribuição; o DJEN entra logo atrás e completa com
   * partes, advogados e inteiro teor. O mock não está no padrão: em produção ele
   * inventaria processo.
   *
   * Sem DATAJUD_API_KEY a cadeia degrada sozinha para só o DJEN — que não exige
   * chave nenhuma. É de propósito: o sistema sobe e funciona sem configuração.
   */
  PROCESSOVIVO_PROVIDER_CHAIN: z.string().default('datajud,djen'),

  DATAJUD_API_KEY: z.string().default(''),
  DATAJUD_BASE_URL: z.string().url().default('https://api-publica.datajud.cnj.jus.br'),
  // 60s: consulta fria no CNJ chega a 20s (medido). Ver DataJudAdapter.
  DATAJUD_TIMEOUT_MS: inteiroPositivo(60_000),
  DATAJUD_TIMEOUT_VERIFICACAO_MS: inteiroPositivo(30_000),
  DATAJUD_RATE_LIMIT_PER_MINUTE: inteiroPositivo(60),

  DJEN_BASE_URL: z.string().url().default('https://comunicaapi.pje.jus.br'),
  // 20s: latência medida foi de 185ms a 993ms. Ver DjenAdapter.
  DJEN_TIMEOUT_MS: inteiroPositivo(20_000),
  DJEN_RATE_LIMIT_PER_MINUTE: inteiroPositivo(60),
  // Teto de publicações lidas numa busca por OAB. 500 cobre meses de atividade.
  DJEN_MAX_COMUNICACOES_POR_OAB: inteiroPositivo(500),

  // Vigilância por OAB: varre de HORA em hora, contra as 12h da varredura de
  // processos. Pode, porque só toca o DJEN — 200ms por consulta e sem chave.
  // É onde estão as publicações que abrem prazo, então velocidade aqui é prazo.
  VIGILANCIA_INTERVALO_HORAS: z.coerce.number().min(0).default(1),
  VIGILANCIA_MAXIMO_POR_VARREDURA: inteiroPositivo(50),
  VIGILANCIA_PAUSA_MS: z.coerce.number().int().min(0).default(1000),

  // Notificação. Sem SMTP_HOST o sistema usa o notificador de log: exercita o
  // caminho inteiro e mostra no log o que teria saído.
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: inteiroPositivo(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_FROM: z.string().default(''),
  /**
   * Endereço público do sistema — ex.: `https://processovivo.webmedula.com.br`.
   *
   * Usado nos links que saem por e-mail, inclusive o de recuperação de senha.
   * **Sem ele a recuperação não é oferecida**: link relativo em e-mail não leva
   * a lugar nenhum, e adivinhar o domínio pelo cabeçalho `Host` da requisição
   * deixaria qualquer um forjar o destino do link mandando outro `Host` — o
   * e-mail sairia do nosso servidor, com a nossa cara, apontando para o
   * atacante.
   */
  PROCESSOVIVO_URL_BASE: z.string().default(''),
  // Silêncio tolerado antes de avisar que a verificação parou. 26h e não 24h
  // para não disparar por causa de uma varredura que atrasou alguns minutos.
  NOTIFICACAO_HORAS_ATE_ALERTAR: inteiroPositivo(26),

  MOCK_CRAWLER_LATENCY_MS: z.coerce.number().int().min(0).default(120),
  MOCK_CRAWLER_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

  CACHE_TTL_SECONDS: inteiroPositivo(900),
  CACHE_MAX_ENTRIES: inteiroPositivo(1000),
  CACHE_ENABLED: booleano.default('true'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  // --- Peças do processo (MNI) ----------------------------------------------
  // O MNI é o único caminho para as PEÇAS (petição, contestação, laudo) — o
  // DJEN publica ato judicial e o DataJud não tem documento nenhum.
  //
  // Endpoint do Projudi/TJGO. NÃO é o caminho `/intercomunicacao` do PJe: nesse
  // o Projudi responde 404, o que já levou à conclusão errada de que o TJGO não
  // tinha MNI.
  MNI_ENDPOINT: z
    .string()
    .url()
    .default('https://projudi.tjgo.jus.br/IntercomunicacaoService'),
  /** Siglas atendidas por esse endpoint, separadas por vírgula. */
  MNI_TRIBUNAIS: z.string().default('TJGO'),
  // 90s: com `incluirDocumentos` o tribunal monta e transmite os PDFs na mesma
  // resposta. Não se compara com os 20s que bastam ao DJEN.
  MNI_TIMEOUT_MS: inteiroPositivo(90_000),
  // Metade do teto relatado (~50/min) antes de bloqueio de IP com 403. Num VPS
  // o IP é compartilhado por todos os assinantes: estourar derruba todo mundo.
  MNI_RATE_LIMIT_PER_MINUTE: inteiroPositivo(30),
  /**
   * Chave do cofre que cifra a senha do advogado no tribunal (32 bytes em
   * base64). SEM ELA o acesso a peças não é montado — e é de propósito: guardar
   * senha de tribunal em claro transformaria um vazamento de banco em acesso
   * aos processos de terceiros. Gere com `npm run chave -- --cofre`.
   */
  PROCESSOVIVO_CREDENCIAL_CHAVE: z.string().default(''),
  // Depois de um HTTP 403 o MNI inteiro fica parado por esta janela — peça
  // avulsa, régua e leitor, de todos os assinantes. O bloqueio é do IP.
  MNI_PAUSA_APOS_403_MIN: inteiroPositivo(30),

  // --- Leitor de peças (v0.30.0) ----------------------------------------------
  // Pasta da guarda temporária dos PDFs combinados. Vazio = `leitor/` ao lado
  // do banco (no contêiner, /dados/leitor — no volume, fora do backup).
  LEITOR_PASTA: z.string().default(''),
  LEITOR_QPDF: z.string().default('qpdf'),
  // Lote adaptativo, medido na sonda de 01/10/2026: 20 peças numa chamada sem
  // perda. Começa em 5, e não em 10: o primeiro lote é o único pedido às
  // cegas (a listagem não diz o tamanho de nada), e 10 peças do tamanho da
  // maior já vista (3,9 MB) dariam um pico de ~150 MB. Com 5, ~90 MB. Só
  // dobra (5 → 10 → 20) depois de uma resposta abaixo de
  // LEITOR_LOTE_CRESCER_ABAIXO_MB — ou seja, depois de ver o tamanho real.
  LEITOR_LOTE_INICIAL: inteiroPositivo(5),
  LEITOR_LOTE_MAXIMO: inteiroPositivo(20),
  // Resposta acima disto corta o lote seguinte pela metade. A conta está em
  // docs/leitor-medicoes-v0.30.0.md: pico ≈ 2 × resposta + 8 MB.
  LEITOR_LOTE_MAX_RESPOSTA_MB: inteiroPositivo(12),
  LEITOR_LOTE_CRESCER_ABAIXO_MB: inteiroPositivo(3),
  LEITOR_PAUSA_ENTRE_CHAMADAS_MS: z.coerce.number().int().min(0).default(3000),
  LEITOR_TTL_HORAS: inteiroPositivo(24),

  // --- Telas: janelas de tempo (v0.32.1) --------------------------------------
  // Atualizações: quantos dias a tela mostra por padrão (há "Todas" na tela).
  NOVIDADES_JANELA_DIAS: inteiroPositivo(15),
  // Por quanto tempo um ato que pede providência ainda conta como pendente.
  // UM valor para o selo da carteira, o card do painel e a tela do processo.
  PENDENCIA_JANELA_DIAS: inteiroPositivo(10),

  LEITOR_COTA_POR_PDF_MB: inteiroPositivo(300),
  LEITOR_COTA_POR_WORKSPACE_MB: inteiroPositivo(1024),
  LEITOR_AVISO_DISCO_MB: inteiroPositivo(10_240),
  // Acima de quantas peças a tela pede confirmação antes de montar o PDF.
  LEITOR_CONFIRMAR_ACIMA_DE: inteiroPositivo(150),

  // --- Pasta digital (v0.33.0) ------------------------------------------------
  // Janela em que cliques seguidos em peças se fundem: só o último pedido
  // pendente vai ao tribunal. A guarda por peça usa LEITOR_PASTA, LEITOR_TTL_HORAS
  // e as cotas do leitor — a pasta do workspace é uma só, e a cota também.
  PASTA_DEBOUNCE_MS: z.coerce.number().int().min(0).default(400),

  // --- Banco e sincronização ------------------------------------------------
  // Caminho do arquivo SQLite. No contêiner tem que apontar para um VOLUME,
  // senão os acompanhamentos somem a cada redeploy.
  PROCESSOVIVO_DB_PATH: z.string().default('./dados/processovivo.db'),
  // Intervalo da varredura automática, em horas. 0 desliga.
  SYNC_INTERVALO_HORAS: z.coerce.number().min(0).default(12),
  SYNC_MAXIMO_POR_VARREDURA: inteiroPositivo(200),
  // Pausa entre consultas. A chave do CNJ é compartilhada por todo o país.
  SYNC_PAUSA_MS: z.coerce.number().int().min(0).default(1500),

  // --- HTTP ---------------------------------------------------------------
  // 0.0.0.0 e não 127.0.0.1: dentro de um contêiner, escutar só em loopback
  // torna o serviço invisível para o proxy do Easypanel. É o erro nº 1 de quem
  // sobe app em contêiner pela primeira vez.
  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: inteiroPositivo(3000),
  HTTP_BODY_LIMIT_BYTES: inteiroPositivo(65_536),
  /** Chaves aceitas no header x-api-key, separadas por vírgula. */
  PROCESSOVIVO_API_KEYS: z.string().default(''),
  /** Escape explícito para rodar sem autenticação (só em rede interna). */
  PROCESSOVIVO_AUTH_DISABLED: booleano.default('false'),
  RATE_LIMIT_MAX: inteiroPositivo(60),
  RATE_LIMIT_WINDOW_MS: inteiroPositivo(60_000),
  /** Confia em X-Forwarded-For. Ligado por padrão: atrás do Traefik do Easypanel. */
  HTTP_TRUST_PROXY: booleano.default('true'),
  /**
   * Marca `Secure` no cookie de sessão. Ligado por padrão, porque produção é
   * HTTPS atrás do Traefik.
   *
   * Desligue APENAS para desenvolvimento em `http://localhost` — sem HTTPS o
   * navegador descarta o cookie em silêncio, e o sintoma é "entrei e voltei
   * para a tela de login", que não parece problema de configuração.
   */
  COOKIE_SECURE: booleano.default('true'),
  /**
   * Backup automático do banco, em horas. 0 desliga.
   *
   * 24h por padrão, e LIGADO por padrão: um SaaS que guarda a carteira e a
   * credencial de tribunal do assinante não pode depender de alguém lembrar de
   * configurar backup. O custo de uma cópia por dia é um arquivo do tamanho do
   * banco; o custo de não ter é o negócio.
   */
  BACKUP_INTERVALO_HORAS: z.coerce.number().min(0).default(24),
  /** Quantas cópias manter. */
  BACKUP_MANTER: inteiroPositivo(7),
  /** Origens liberadas para CORS, separadas por vírgula. Vazio = CORS desligado. */
  CORS_ORIGINS: z.string().default(''),

  // --- Área administrativa -------------------------------------------------
  // Um operador só, credencial própria, TOTALMENTE separada da tabela
  // `usuarios` — ver o aviso em `CLAUDE.md` sobre inventar "administrador"
  // como campo booleano numa API de cadastro aberto. As duas vazias desliga a
  // área inteira (comportamento padrão, e o de hoje); definir só uma é erro de
  // configuração — ver `validarConfiguracaoAdmin`.
  PROCESSOVIVO_ADMIN_USUARIO: z.string().default(''),
  PROCESSOVIVO_ADMIN_SENHA: z.string().default(''),

  // --- Análise de ato por IA (v0.38.0) ----------------------------------------
  // Nasce DESLIGADA. Não existe variável para desligar a retenção zero (ZDR): ela é
  // exigida em toda chamada, e sem ela a chamada não sai.
  PROCESSOVIVO_IA_HABILITADA: booleano.default('false'),
  // EXCEÇÃO DE TESTE FECHADO (v0.38.1) — REMOVER ANTES DE ABRIR AO PÚBLICO. Ids de workspace
  // (16 hex) separados por vírgula que passam na checagem do plano IA SEM assinatura, só para
  // `analiseIa`. Não cria linha em `assinaturas`, não muda nenhum outro recurso e não dispensa
  // PROCESSOVIVO_IA_HABILITADA nem as demais travas. Vazia = comportamento de sempre.
  PROCESSOVIVO_IA_WORKSPACES_LIBERADOS: z.string().default(''),
  // Um modelo REAL do OpenRouter (sem `~` nem `:`). É configuração, nunca constante no código.
  PROCESSOVIVO_IA_MODELO: z.string().default('deepseek/deepseek-v4-flash'),
  // Raciocínio do modelo: desligado por padrão (latência medida p50 29 s / p95 52 s com ele ligado).
  PROCESSOVIVO_IA_RACIOCINIO: z
    .enum(['padrao', 'desligado', 'nenhum', 'minimo', 'baixo'])
    .default('desligado'),
  PROCESSOVIVO_IA_MAX_TOKENS: inteiroPositivo(1200),
  PROCESSOVIVO_IA_TIMEOUT_MS: inteiroPositivo(90_000),
  // Lista (separada por vírgula) de provedores autorizados. Vazia = todos os provedores
  // ZDR do modelo. Com valor, vale a INTERSEÇÃO com a lista ZDR: só restringe.
  PROCESSOVIVO_IA_PROVEDORES_PERMITIDOS: z.string().default(''),
  // Freio por conta, em memória (reiniciar zera). O teto real de gasto é o limite da chave.
  PROCESSOVIVO_IA_MAX_POR_HORA: inteiroPositivo(20),
  PROCESSOVIVO_IA_MAX_SIMULTANEAS: inteiroPositivo(3),
  // Resumo de processo (v0.40.0): mais caro que a análise de um ato (5 a 6 vezes a entrada).
  // Freio próprio por conta, em memória; a saída maior e a espera maior têm teto próprio.
  PROCESSOVIVO_IA_RESUMO_MAX_POR_HORA: inteiroPositivo(6),
  PROCESSOVIVO_IA_RESUMO_MAX_TOKENS: inteiroPositivo(1500),
  PROCESSOVIVO_IA_RESUMO_TIMEOUT_MS: inteiroPositivo(120_000),
  // Exigida SÓ com a IA habilitada. Nunca vai para log, resposta ou mensagem de erro.
  OPENROUTER_API_KEY: z.string().default(''),

  // --- Google Drive (v0.42.0) -------------------------------------------------
  // Nasce DESLIGADO; o dono liga. O escopo é um só (`drive.file`) e não tem variável: o sistema
  // só enxerga o que ele mesmo criou, e pedir mais não é configuração, é outro produto.
  PROCESSOVIVO_DRIVE_HABILITADO: booleano.default('false'),
  // Nomes nativos do Google (Cloud Console > Credenciais > ID do cliente OAuth). Exigidos SÓ com
  // o recurso habilitado. O segredo nunca vai a log, resposta ou mensagem de erro.
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  // Teto GLOBAL de envios em andamento (um job por workspace, e poucos ao mesmo tempo no
  // servidor): o Drive é do advogado, mas o disco e a banda são nossos.
  PROCESSOVIVO_DRIVE_MAX_SIMULTANEOS: inteiroPositivo(2),
  // Pausa entre uma peça e outra do mesmo envio. Sem rajada: uma peça por vez.
  PROCESSOVIVO_DRIVE_PAUSA_ENTRE_PECAS_MS: z.coerce.number().int().min(0).default(400),
});

export interface Config {
  readonly cadeiaDeProviders: readonly string[];
  readonly djen: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly limitePorMinuto: number;
    readonly maxComunicacoesPorOab: number;
  };
  readonly dataJud: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly timeoutVerificacaoMs: number;
    readonly limitePorMinuto: number;
  };
  readonly mockCrawler: {
    readonly latenciaMs: number;
    readonly taxaDeFalha: number;
  };
  readonly cache: {
    readonly habilitado: boolean;
    readonly ttlSegundos: number;
    readonly maxEntradas: number;
  };
  readonly mni: {
    readonly endpoint: string;
    readonly tribunais: readonly string[];
    readonly timeoutMs: number;
    readonly limitePorMinuto: number;
    readonly chaveDoCofre: string;
    readonly pausaApos403Ms: number;
  };
  readonly leitor: {
    /** Vazio = `leitor/` ao lado do banco. */
    readonly pasta: string;
    readonly qpdf: string;
    readonly loteInicial: number;
    readonly loteMaximo: number;
    readonly limiteRespostaBytes: number;
    readonly limiarCrescimentoBytes: number;
    readonly pausaEntreChamadasMs: number;
    readonly ttlMs: number;
    readonly cotaPorPdfBytes: number;
    readonly cotaPorWorkspaceBytes: number;
    readonly avisoDiscoBytes: number;
    readonly confirmarAcimaDe: number;
  };
  readonly pasta: {
    readonly debounceMs: number;
  };
  readonly nivelLog: NivelLog;
  readonly banco: { readonly caminho: string };
  readonly backup: {
    readonly intervaloHoras: number;
    readonly manter: number;
  };
  readonly sincronizacao: {
    readonly intervaloHoras: number;
    readonly maximoPorVarredura: number;
    readonly pausaMs: number;
  };
  readonly vigilancia: {
    readonly intervaloHoras: number;
    readonly maximoPorVarredura: number;
    readonly pausaMs: number;
  };
  readonly notificacao: {
    readonly smtpHost: string;
    readonly smtpPorta: number;
    readonly smtpUsuario: string;
    readonly smtpSenha: string;
    readonly smtpSeguro: boolean;
    readonly remetente: string;
    readonly urlBase: string;
    readonly horasAteAlertar: number;
  };
  readonly http: {
    readonly host: string;
    readonly porta: number;
    readonly bodyLimitBytes: number;
    readonly chavesDeApi: readonly string[];
    readonly autenticacaoDesativada: boolean;
    readonly rateLimitMax: number;
    readonly rateLimitJanelaMs: number;
    readonly confiarNoProxy: boolean;
    readonly cookieSeguro: boolean;
    readonly urlBase: string;
    readonly corsOrigins: readonly string[];
  };
  readonly telas: {
    readonly novidadesJanelaDias: number;
    readonly pendenciaJanelaDias: number;
  };
  readonly ia: {
    readonly habilitada: boolean;
    readonly modelo: string;
    readonly raciocinio: NivelDeRaciocinio;
    readonly maxTokens: number;
    readonly timeoutMs: number;
    readonly provedoresPermitidos: readonly string[];
    readonly maxPorHora: number;
    readonly maxSimultaneas: number;
    /** Resumo de processo (v0.40.0). */
    readonly resumoMaxPorHora: number;
    readonly resumoMaxTokens: number;
    readonly resumoTimeoutMs: number;
    /** Exceção de teste fechado (v0.38.1): ids já validados, minúsculos e sem repetição. */
    readonly workspacesLiberados: readonly string[];
    /** Vazia quando a IA está desligada. */
    readonly chave: string;
  };
  readonly drive: {
    readonly habilitado: boolean;
    /** Vazios quando o recurso está desligado. Nunca vão a log, resposta ou erro. */
    readonly clientId: string;
    readonly clientSecret: string;
    /** `PROCESSOVIVO_URL_BASE` + `/v1/drive/retorno`; vazio com o recurso desligado. */
    readonly uriDeRetorno: string;
    readonly maxSimultaneos: number;
    readonly pausaEntrePecasMs: number;
  };
  readonly admin: {
    /** Vazio quando a área administrativa está desligada (as duas variáveis vazias). */
    readonly usuario: string;
    readonly senha: string;
  };
}

/**
 * Nomes antigos que ainda são aceitos, e o nome atual de cada um.
 *
 * O produto se chamava LexFlow até a v0.18.0. Renomear as variáveis é o certo —
 * ninguém quer ler `LEXFLOW_` no painel de um sistema chamado Processo Vivo —,
 * mas uma renomeação seca transformaria a atualização numa armadilha: bastaria
 * esquecer UMA variável no Easypanel para o serviço subir errado.
 *
 * E o modo de falhar seria diferente em cada uma, o que é pior do que uma falha
 * só: sem `..._API_KEYS` o processo se recusa a subir (barulhento, fácil);
 * sem `..._CREDENCIAL_CHAVE` as peças somem em silêncio e as rotas passam a
 * responder 501; sem `..._DB_PATH` o sistema abre um banco NOVO e vazio ao lado
 * do que tem os dados, e a carteira parece ter sumido.
 *
 * Então o nome antigo continua valendo, com aviso no log dizendo exatamente o
 * que trocar. A remoção fica para uma versão futura, depois de o painel estar
 * limpo.
 */
const NOMES_ANTIGOS: ReadonlyArray<readonly [antigo: string, atual: string]> = [
  ['LEXFLOW_PROVIDER_CHAIN', 'PROCESSOVIVO_PROVIDER_CHAIN'],
  ['LEXFLOW_API_KEYS', 'PROCESSOVIVO_API_KEYS'],
  ['LEXFLOW_AUTH_DISABLED', 'PROCESSOVIVO_AUTH_DISABLED'],
  ['LEXFLOW_DB_PATH', 'PROCESSOVIVO_DB_PATH'],
  ['LEXFLOW_CREDENCIAL_CHAVE', 'PROCESSOVIVO_CREDENCIAL_CHAVE'],
  ['LEXFLOW_URL_BASE', 'PROCESSOVIVO_URL_BASE'],
];

/** O que `carregarConfig` encontrou de nome antigo. Vazio é o estado desejado. */
export interface AvisoDeRenomeacao {
  readonly antigo: string;
  readonly atual: string;
}

let avisosDaUltimaCarga: readonly AvisoDeRenomeacao[] = [];

/**
 * Os nomes antigos vistos na última chamada de `carregarConfig`.
 *
 * Existe porque o logger ainda não foi construído quando a configuração é lida —
 * o nível de log vem dela. Guardar e emitir depois, no composition root, evita
 * um `console.warn` solto em biblioteca e mantém o aviso no mesmo formato JSON
 * do resto do log.
 */
export function avisosDeRenomeacao(): readonly AvisoDeRenomeacao[] {
  return avisosDaUltimaCarga;
}

/**
 * Preenche o nome atual a partir do antigo, quando só o antigo veio.
 *
 * O nome ATUAL sempre vence: quem já migrou e deixou o antigo para trás no
 * painel não pode ver o valor velho sobrescrever o novo.
 */
function aceitarNomesAntigos(fonte: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copia: NodeJS.ProcessEnv = { ...fonte };
  const avisos: AvisoDeRenomeacao[] = [];

  for (const [antigo, atual] of NOMES_ANTIGOS) {
    const valorAntigo = fonte[antigo];
    if (valorAntigo === undefined || valorAntigo === '') continue;
    avisos.push({ antigo, atual });
    if (fonte[atual] === undefined || fonte[atual] === '') {
      copia[atual] = valorAntigo;
    }
  }

  avisosDaUltimaCarga = avisos;
  return copia;
}

const MB = 1_048_576;

export function carregarConfig(fonte: NodeJS.ProcessEnv = process.env): Config {
  const resultado = schema.safeParse(aceitarNomesAntigos(fonte));
  if (!resultado.success) {
    const detalhes = resultado.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração inválida:\n${detalhes}`);
  }

  const env = resultado.data;
  validarConfiguracaoDaIa(env);
  validarConfiguracaoDoDrive(env);
  // Validada mesmo com a IA desligada: erro de digitação aparece no deploy, não no dia de ligar.
  lerWorkspacesLiberados(env.PROCESSOVIVO_IA_WORKSPACES_LIBERADOS);
  return {
    cadeiaDeProviders: env.PROCESSOVIVO_PROVIDER_CHAIN.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    djen: {
      baseUrl: env.DJEN_BASE_URL,
      timeoutMs: env.DJEN_TIMEOUT_MS,
      limitePorMinuto: env.DJEN_RATE_LIMIT_PER_MINUTE,
      maxComunicacoesPorOab: env.DJEN_MAX_COMUNICACOES_POR_OAB,
    },
    dataJud: {
      apiKey: env.DATAJUD_API_KEY,
      baseUrl: env.DATAJUD_BASE_URL,
      timeoutMs: env.DATAJUD_TIMEOUT_MS,
      timeoutVerificacaoMs: env.DATAJUD_TIMEOUT_VERIFICACAO_MS,
      limitePorMinuto: env.DATAJUD_RATE_LIMIT_PER_MINUTE,
    },
    mockCrawler: {
      latenciaMs: env.MOCK_CRAWLER_LATENCY_MS,
      taxaDeFalha: env.MOCK_CRAWLER_FAILURE_RATE,
    },
    cache: {
      habilitado: env.CACHE_ENABLED,
      ttlSegundos: env.CACHE_TTL_SECONDS,
      maxEntradas: env.CACHE_MAX_ENTRIES,
    },
    mni: {
      endpoint: env.MNI_ENDPOINT,
      tribunais: env.MNI_TRIBUNAIS.split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0),
      timeoutMs: env.MNI_TIMEOUT_MS,
      limitePorMinuto: env.MNI_RATE_LIMIT_PER_MINUTE,
      chaveDoCofre: env.PROCESSOVIVO_CREDENCIAL_CHAVE.trim(),
      pausaApos403Ms: env.MNI_PAUSA_APOS_403_MIN * 60_000,
    },
    leitor: {
      pasta: env.LEITOR_PASTA.trim(),
      qpdf: env.LEITOR_QPDF.trim() || 'qpdf',
      loteInicial: Math.min(env.LEITOR_LOTE_INICIAL, env.LEITOR_LOTE_MAXIMO),
      loteMaximo: env.LEITOR_LOTE_MAXIMO,
      limiteRespostaBytes: env.LEITOR_LOTE_MAX_RESPOSTA_MB * MB,
      limiarCrescimentoBytes: env.LEITOR_LOTE_CRESCER_ABAIXO_MB * MB,
      pausaEntreChamadasMs: env.LEITOR_PAUSA_ENTRE_CHAMADAS_MS,
      ttlMs: env.LEITOR_TTL_HORAS * 3_600_000,
      cotaPorPdfBytes: env.LEITOR_COTA_POR_PDF_MB * MB,
      cotaPorWorkspaceBytes: env.LEITOR_COTA_POR_WORKSPACE_MB * MB,
      avisoDiscoBytes: env.LEITOR_AVISO_DISCO_MB * MB,
      confirmarAcimaDe: env.LEITOR_CONFIRMAR_ACIMA_DE,
    },
    pasta: { debounceMs: env.PASTA_DEBOUNCE_MS },
    nivelLog: env.LOG_LEVEL,
    banco: { caminho: env.PROCESSOVIVO_DB_PATH },
    backup: {
      intervaloHoras: env.BACKUP_INTERVALO_HORAS,
      manter: env.BACKUP_MANTER,
    },
    sincronizacao: {
      intervaloHoras: env.SYNC_INTERVALO_HORAS,
      maximoPorVarredura: env.SYNC_MAXIMO_POR_VARREDURA,
      pausaMs: env.SYNC_PAUSA_MS,
    },
    vigilancia: {
      intervaloHoras: env.VIGILANCIA_INTERVALO_HORAS,
      maximoPorVarredura: env.VIGILANCIA_MAXIMO_POR_VARREDURA,
      pausaMs: env.VIGILANCIA_PAUSA_MS,
    },
    notificacao: {
      smtpHost: env.SMTP_HOST.trim(),
      smtpPorta: env.SMTP_PORT,
      smtpUsuario: env.SMTP_USER.trim(),
      smtpSenha: env.SMTP_PASS,
      smtpSeguro: env.SMTP_SECURE === 'true',
      // Sem SMTP_FROM explícito, o usuário SMTP costuma ser o próprio endereço.
      remetente: env.SMTP_FROM.trim() || env.SMTP_USER.trim(),
      urlBase: env.PROCESSOVIVO_URL_BASE.trim().replace(/\/+$/, ''),
      horasAteAlertar: env.NOTIFICACAO_HORAS_ATE_ALERTAR,
    },
    http: {
      host: env.HTTP_HOST,
      porta: env.HTTP_PORT,
      bodyLimitBytes: env.HTTP_BODY_LIMIT_BYTES,
      chavesDeApi: listaSeparadaPorVirgula(env.PROCESSOVIVO_API_KEYS),
      autenticacaoDesativada: env.PROCESSOVIVO_AUTH_DISABLED,
      rateLimitMax: env.RATE_LIMIT_MAX,
      rateLimitJanelaMs: env.RATE_LIMIT_WINDOW_MS,
      confiarNoProxy: env.HTTP_TRUST_PROXY,
      cookieSeguro: env.COOKIE_SECURE,
      urlBase: env.PROCESSOVIVO_URL_BASE.trim().replace(/\/+$/, ''),
      corsOrigins: listaSeparadaPorVirgula(env.CORS_ORIGINS),
    },
    telas: {
      novidadesJanelaDias: env.NOVIDADES_JANELA_DIAS,
      pendenciaJanelaDias: env.PENDENCIA_JANELA_DIAS,
    },
    ia: {
      habilitada: env.PROCESSOVIVO_IA_HABILITADA,
      modelo: env.PROCESSOVIVO_IA_MODELO.trim(),
      raciocinio: env.PROCESSOVIVO_IA_RACIOCINIO,
      maxTokens: env.PROCESSOVIVO_IA_MAX_TOKENS,
      timeoutMs: env.PROCESSOVIVO_IA_TIMEOUT_MS,
      provedoresPermitidos: listaSeparadaPorVirgula(
        env.PROCESSOVIVO_IA_PROVEDORES_PERMITIDOS,
      ).map((s) => s.toLowerCase()),
      maxPorHora: env.PROCESSOVIVO_IA_MAX_POR_HORA,
      maxSimultaneas: env.PROCESSOVIVO_IA_MAX_SIMULTANEAS,
      resumoMaxPorHora: env.PROCESSOVIVO_IA_RESUMO_MAX_POR_HORA,
      resumoMaxTokens: env.PROCESSOVIVO_IA_RESUMO_MAX_TOKENS,
      resumoTimeoutMs: env.PROCESSOVIVO_IA_RESUMO_TIMEOUT_MS,
      workspacesLiberados: lerWorkspacesLiberados(env.PROCESSOVIVO_IA_WORKSPACES_LIBERADOS),
      chave: env.PROCESSOVIVO_IA_HABILITADA ? env.OPENROUTER_API_KEY.trim() : '',
    },
    drive: {
      habilitado: env.PROCESSOVIVO_DRIVE_HABILITADO,
      clientId: env.PROCESSOVIVO_DRIVE_HABILITADO ? env.GOOGLE_CLIENT_ID.trim() : '',
      clientSecret: env.PROCESSOVIVO_DRIVE_HABILITADO
        ? env.GOOGLE_CLIENT_SECRET.trim()
        : '',
      uriDeRetorno: env.PROCESSOVIVO_DRIVE_HABILITADO
        ? `${env.PROCESSOVIVO_URL_BASE.trim().replace(/\/+$/, '')}${ROTA_DE_RETORNO_DO_DRIVE}`
        : '',
      maxSimultaneos: env.PROCESSOVIVO_DRIVE_MAX_SIMULTANEOS,
      pausaEntrePecasMs: env.PROCESSOVIVO_DRIVE_PAUSA_ENTRE_PECAS_MS,
    },
    admin: {
      usuario: env.PROCESSOVIVO_ADMIN_USUARIO.trim(),
      senha: env.PROCESSOVIVO_ADMIN_SENHA,
    },
  };
}

/**
 * Com a IA habilitada, o arranque exige chave real e modelo real. Falha cedo e alto: IA ligada
 * sem chave só mostraria erro na primeira análise de um assinante, e valor de exemplo colado
 * no painel passa por qualquer checagem de presença. A mensagem NUNCA traz o valor da chave.
 */
function validarConfiguracaoDaIa(env: z.infer<typeof schema>): void {
  if (!env.PROCESSOVIVO_IA_HABILITADA) return;
  const chave = env.OPENROUTER_API_KEY.trim();
  if (chave === '') {
    throw new Error(
      'Configuração inválida:\n  - OPENROUTER_API_KEY: obrigatória com PROCESSOVIVO_IA_HABILITADA=true',
    );
  }
  if (pareceValorDeExemplo(chave)) {
    throw new Error(
      'Configuração inválida:\n  - OPENROUTER_API_KEY: parece um valor de exemplo; coloque a chave real',
    );
  }
  const modelo = env.PROCESSOVIVO_IA_MODELO.trim();
  if (modelo === '' || ehApelidoOuVariante(modelo)) {
    throw new Error(
      'Configuração inválida:\n  - PROCESSOVIVO_IA_MODELO: use o id de um modelo real (sem "~" nem ":")',
    );
  }
}

/** O caminho que o Google chama de volta depois da autorização. Cadastrado no Cloud Console. */
export const ROTA_DE_RETORNO_DO_DRIVE = '/v1/drive/retorno';

/**
 * Com o Drive habilitado, o arranque exige tudo o que ele precisa — e diz o que falta, sem
 * nunca trazer o valor de nenhuma chave. Falha cedo e alto: Drive ligado sem segredo só
 * mostraria erro na primeira conexão de um assinante, e valor de exemplo colado no painel
 * passa por qualquer checagem de presença.
 *
 * O cofre é pré-requisito: a autorização do Google (token de renovação) só pode ser guardada
 * cifrada, como a senha do tribunal — e sem as peças não há o que enviar.
 */
function validarConfiguracaoDoDrive(env: z.infer<typeof schema>): void {
  if (!env.PROCESSOVIVO_DRIVE_HABILITADO) return;
  const problemas: string[] = [];
  const id = env.GOOGLE_CLIENT_ID.trim();
  const segredo = env.GOOGLE_CLIENT_SECRET.trim();
  if (id === '')
    problemas.push(
      'GOOGLE_CLIENT_ID: obrigatório com PROCESSOVIVO_DRIVE_HABILITADO=true',
    );
  else if (pareceValorDeExemplo(id)) {
    problemas.push(
      'GOOGLE_CLIENT_ID: parece um valor de exemplo; coloque o ID real do cliente OAuth',
    );
  }
  if (segredo === '') {
    problemas.push(
      'GOOGLE_CLIENT_SECRET: obrigatório com PROCESSOVIVO_DRIVE_HABILITADO=true',
    );
  } else if (pareceValorDeExemplo(segredo)) {
    problemas.push(
      'GOOGLE_CLIENT_SECRET: parece um valor de exemplo; coloque o segredo real',
    );
  }
  const base = env.PROCESSOVIVO_URL_BASE.trim().replace(/\/+$/, '');
  if (base === '') {
    problemas.push(
      'PROCESSOVIVO_URL_BASE: obrigatória com PROCESSOVIVO_DRIVE_HABILITADO=true ' +
        `(o endereço de retorno é ela + ${ROTA_DE_RETORNO_DO_DRIVE})`,
    );
  } else if (
    !/^https:\/\//i.test(base) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)
  ) {
    problemas.push(
      'PROCESSOVIVO_URL_BASE: o Google só aceita retorno em https (ou localhost)',
    );
  }
  const cofre = env.PROCESSOVIVO_CREDENCIAL_CHAVE.trim();
  if (cofre === '' || pareceValorDeExemplo(cofre)) {
    problemas.push(
      'PROCESSOVIVO_CREDENCIAL_CHAVE: obrigatória com PROCESSOVIVO_DRIVE_HABILITADO=true ' +
        '(a autorização do Google só é guardada cifrada)',
    );
  }
  if (problemas.length > 0) {
    throw new Error(
      `Configuração inválida:\n${problemas.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
}

/**
 * Lê PROCESSOVIVO_IA_WORKSPACES_LIBERADOS: 16 hex por item, minúsculas, sem repetição.
 * Item fora do formato derruba o arranque dizendo QUAL (pela posição) — o valor NUNCA é
 * ecoado, porque quem cola a chave de API inteira no lugar do id deixaria o segredo
 * no log do contêiner.
 */
function lerWorkspacesLiberados(valor: string): string[] {
  const itens = listaSeparadaPorVirgula(valor).map((s) => s.toLowerCase());
  const ruins = itens.flatMap((id, i) => (FORMATO_DE_WORKSPACE.test(id) ? [] : [i + 1]));
  if (ruins.length > 0) {
    throw new Error(
      'Configuração inválida:\n  - PROCESSOVIVO_IA_WORKSPACES_LIBERADOS: ' +
        `item ${ruins.join(', ')} fora do formato (use ids de workspace com 16 caracteres ` +
        'hexadecimais, separados por vírgula; não cole a chave de API)',
    );
  }
  return [...new Set(itens)];
}

function listaSeparadaPorVirgula(valor: string): string[] {
  return valor
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
