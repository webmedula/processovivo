import { createHash } from 'node:crypto';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type {
  ConteudoParaEnvio,
  EstadoDaConexao,
  MotivoDoErroDaConexao,
  PecaNoDestino,
} from '../../domain/entities/DestinoDePecas.js';
import { nomeDoArquivoNoDrive } from '../../domain/entities/nomeDoArquivoNoDrive.js';
import {
  ArquivoRemovidoNoDestinoError,
  AutorizacaoDoDestinoRevogadaError,
  AutorizacaoDoDestinoVencidaError,
  CredencialTribunalAusenteError,
  CredencialTribunalInvalidaError,
  DestinoIndisponivelError,
  DestinoLimitouError,
  DestinoRecusouError,
  DestinoSemEspacoError,
  DriveRecusadoError,
  ListagemDaPastaAusenteError,
  MniBloqueadoError,
  PastaRemovidaNoDestinoError,
  PecaDaPastaNaoEncontradaError,
  PecaSigilosaNaoGuardadaError,
  SegredoDeJusticaNaoGuardadoError,
} from '../../domain/errors/index.js';
import type { Clock } from '../../domain/ports/Clock.js';
import { clockDoSistema } from '../../domain/ports/Clock.js';
import type { DestinoExternoDePecas } from '../../domain/ports/DestinoExternoDePecas.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioDoDrive } from '../../domain/ports/RepositorioDoDrive.js';
import type { AutorizacaoDoDestino } from '../../domain/entities/DestinoDePecas.js';
import { EstadoDeConexaoRecusado } from '../politicas/estadosDeConexao.js';
import type { EstadosDeConexao } from '../politicas/estadosDeConexao.js';

/**
 * O envio das peças da Pasta digital para o Google Drive do advogado (v0.42.0).
 *
 * As regras que moldam este arquivo, na ordem em que o dono as decidiu:
 *
 * 1. **A pasta raiz "Processo Vivo" e uma subpasta por processo** são criadas pelo sistema;
 *    nunca se procura pasta pelo nome (o escopo `drive.file` não deixa listar, e procurar
 *    duplicaria). Os ids ficam guardados.
 * 2. **Escopo único e sentido único.** O sistema só grava; a única leitura é "o que EU criei
 *    ainda existe?". Não apaga, não renomeia, não compartilha nada do Drive.
 * 3. **Sigilo fica fora**: peça com `nivelSigilo > 0` e processo em segredo de justiça NÃO
 *    chegam ao Drive — zero chamadas. O resultado diz quantas ficaram de fora.
 * 4. **Só por clique**: não existe envio automático; nenhum agendador chama este serviço.
 * 5. **Sem consulta nova ao tribunal além da que a Pasta digital já faz.** A peça sai da guarda
 *    existente; se venceu da guarda de 24 h, é pedida pelo MESMO caminho da Pasta (`solicitar`:
 *    debounce, fila, pausa de 3 s, disjuntor) e só porque o advogado clicou. Sem retry contra o
 *    tribunal: credencial recusada ou bloqueio PARA o lote.
 * 6. **Idempotência** por (workspace, processo, peça), com o hash do conteúdo: o mesmo conteúdo
 *    não duplica; conteúdo novo atualiza o MESMO arquivo; arquivo que o advogado apagou NÃO é
 *    reenviado sozinho — conta como "removida no Drive", e reenviar é outro clique.
 * 7. **Uma peça por vez**, com pausa, e backoff LIMITADO em 429/5xx (respeitando `Retry-After`
 *    até um teto; sem laço infinito). Um job por workspace, e poucos no servidor inteiro.
 *
 * A autorização vive cifrada no cofre; este serviço a lê no momento de usar, renova sob demanda
 * (uma renovação por vez por workspace) e NUNCA a escreve em log, resposta ou erro.
 */

// ---------------------------------------------------------------------------
// A fonte das peças (a Pasta digital) vista por este serviço

export interface PecaParaODrive {
  readonly pecaId: string;
  readonly ordem: number;
  readonly rotulo: string;
  readonly data: Date | undefined;
  /** O número do ato como a Pasta o mostra (posição calculada ou número do Projudi). */
  readonly numeroDoAto: number | undefined;
  /** Sob sigilo na origem — ou o processo inteiro está em segredo de justiça. */
  readonly sigilosa: boolean;
}

export interface PecaEmGuardaParaODrive extends ConteudoParaEnvio {
  readonly conversao: 'nenhuma' | 'imagem' | 'html';
  readonly observacao: string | undefined;
}

export type EstadoDaPecaNaFonte =
  'nao_baixada' | 'na_fila' | 'baixando' | 'disponivel' | 'nao_obtida' | 'sigilo';

export interface FonteDePecasParaODrive {
  /** A lista gravada da Pasta. @throws {ListagemDaPastaAusenteError} */
  listar(
    workspace: string,
    numero: string,
  ): Promise<{
    readonly processoSigiloso: boolean;
    readonly pecas: readonly PecaParaODrive[];
  }>;
  emGuarda(
    workspace: string,
    numero: string,
    pecaId: string,
  ): Promise<PecaEmGuardaParaODrive | undefined>;
  /** Pede a peça ao tribunal PELO caminho da Pasta (debounce, fila, pausa, disjuntor). */
  solicitar(workspace: string, numero: string, pecaId: string): Promise<void>;
  estado(
    workspace: string,
    numero: string,
    pecaId: string,
  ): Promise<{
    readonly estado: EstadoDaPecaNaFonte;
    readonly retomarEm: Date | undefined;
  }>;
}

/** Quem confere o plano. `temRecursoSemExcecao` de `ServicoAssinaturas`. */
export type ConferirPlano = (workspace: string) => Promise<boolean>;

// ---------------------------------------------------------------------------
// O que a tela vê

export type EstadoDoEnvio = 'em_andamento' | 'concluido' | 'cancelado' | 'interrompido';

export type MotivoDaParadaDoEnvio =
  | 'precisa_reconectar'
  | 'drive_cheio'
  | 'limite_de_uso'
  | 'drive_indisponivel'
  | 'credencial_do_tribunal'
  | 'bloqueio_do_tribunal';

export type MotivoDaFalhaDaPeca =
  | 'tribunal_nao_entregou'
  | 'tempo_esgotado'
  | 'recusada_pelo_drive'
  | 'drive_indisponivel';

export type AvisoDoEnvio = 'pasta_raiz_recriada' | 'pasta_do_processo_recriada';

export interface ProgressoDoEnvio {
  readonly enviadas: number;
  readonly atualizadas: number;
  readonly jaEstavam: number;
  readonly removidasNoDrive: number;
  readonly falhas: number;
}

export interface EnvioParaODrive {
  readonly id: string;
  readonly workspace: string;
  readonly numeroProcesso: string;
  readonly estado: EstadoDoEnvio;
  /** Peças que este envio tenta (guardáveis e pedidas). */
  readonly total: number;
  /** Quantas já tiveram resultado. */
  readonly processadas: number;
  readonly progresso: ProgressoDoEnvio;
  /** Peças que NÃO foram ao Drive por serem sigilosas — nunca viram chamada. */
  readonly sigilosasForaDoEnvio: number;
  /** Ids das peças que o advogado apagou no Drive: "reenviar" só por clique. */
  readonly removidasNoDrive: readonly string[];
  readonly falhasDasPecas: readonly {
    readonly pecaId: string;
    readonly motivo: MotivoDaFalhaDaPeca;
  }[];
  readonly motivoDaParada: MotivoDaParadaDoEnvio | undefined;
  /** Bloqueio do tribunal: quando voltar a pedir. */
  readonly retomarEm: Date | undefined;
  readonly avisos: readonly AvisoDoEnvio[];
  /** A subpasta do processo, para "Abrir no Drive". */
  readonly linkDaPasta: string | undefined;
  readonly iniciadoEm: Date;
  readonly terminadoEm: Date | undefined;
}

export interface VisaoDoDrive {
  readonly plano: boolean;
  readonly estado: EstadoDaConexao;
  readonly linkDaPastaRaiz: string | undefined;
  readonly motivoDoUltimoErro: MotivoDoErroDaConexao | undefined;
  readonly conectadaEm: Date | undefined;
  readonly verificadaEm: Date | undefined;
  /** O envio em andamento deste workspace, para a tela reanexar-se depois de recarregar. */
  readonly envioAtivo:
    { readonly id: string; readonly numeroProcesso: string } | undefined;
}

export type ResultadoDaConexao =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly motivo:
        | 'estado_invalido'
        | 'escopo_negado'
        | 'autorizacao_recusada'
        | 'sem_plano'
        | 'indisponivel';
    };

export interface OpcoesServicoDrive {
  readonly destino: DestinoExternoDePecas;
  readonly repositorio: RepositorioDoDrive;
  readonly fonte: FonteDePecasParaODrive;
  readonly estados: EstadosDeConexao;
  /** `salvarNoDrive` E `pecas`, sem a exceção de "workspace sem assinatura passa livre". */
  readonly conferirPlano: ConferirPlano;
  readonly logger: Logger;
  readonly uriDeRetorno: string;
  /** Teto GLOBAL de envios em andamento. */
  readonly maxSimultaneos: number;
  readonly pausaEntrePecasMs: number;
  readonly clock?: Clock;
  readonly esperar?: (ms: number) => Promise<void>;
  readonly gerarId: () => string;
}

/** Nome da pasta raiz no Drive do advogado. */
export const NOME_DA_PASTA_RAIZ = 'Processo Vivo';
/** Renova o token de acesso quando faltar menos que isto para vencer. */
const MARGEM_DA_RENOVACAO_MS = 60_000;
/** Tentativas por peça diante de 429/5xx (a primeira + 3 repetições). */
export const MAXIMO_DE_TENTATIVAS = 4;
const ESPERA_BASE_MS = 1_000;
/** Pedido de espera maior que isto (Retry-After) não é esperado: o lote PARA. */
export const TETO_DA_ESPERA_MS = 60_000;
/** Falhas seguidas do Drive que encerram o lote em vez de gastar o tempo da pessoa. */
const FALHAS_SEGUIDAS_QUE_PARAM = 3;
/** Esperas de 1 s por uma peça que o tribunal ainda não entregou (a tela espera 120 s). */
const MAXIMO_DE_ESPERAS_PELA_PECA = 120;
const MAXIMO_DE_PEDIDOS_POR_PECA = 3;
/** Envios concluídos que a memória guarda para a tela consultar. */
const MAXIMO_DE_ENVIOS_GUARDADOS = 50;

type Peca = PecaParaODrive;

type Mutavel<T> = { -readonly [K in keyof T]: T[K] };

interface Execucao {
  envio: Omit<Mutavel<EnvioParaODrive>, 'progresso'> & {
    progresso: Mutavel<ProgressoDoEnvio>;
  };
  readonly pecas: readonly Peca[];
  readonly reenviarRemovidas: boolean;
  cancelado: boolean;
  terminou: Promise<void>;
}

class ParadaDoEnvio extends Error {
  constructor(
    readonly motivo: MotivoDaParadaDoEnvio,
    readonly retomarEm?: Date,
  ) {
    super(`envio parado: ${motivo}`);
  }
}
/** O advogado cancelou: sai do laço sem contar falha nem parada. */
class EnvioCancelado extends Error {
  constructor() {
    super('envio cancelado');
  }
}
class FalhaDaPeca extends Error {
  constructor(readonly motivo: MotivoDaFalhaDaPeca) {
    super(`peça não enviada: ${motivo}`);
  }
}

export class ServicoDrive {
  private readonly destino: DestinoExternoDePecas;
  private readonly repositorio: RepositorioDoDrive;
  private readonly fonte: FonteDePecasParaODrive;
  private readonly estados: EstadosDeConexao;
  private readonly conferirPlano: ConferirPlano;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly esperar: (ms: number) => Promise<void>;
  private readonly execucoes = new Map<string, Execucao>();
  /** Uma renovação por vez por workspace: duas em paralelo gastariam o token de renovação à toa. */
  private readonly renovacoes = new Map<string, Promise<AutorizacaoDoDestino>>();

  constructor(private readonly opcoes: OpcoesServicoDrive) {
    this.destino = opcoes.destino;
    this.repositorio = opcoes.repositorio;
    this.fonte = opcoes.fonte;
    this.estados = opcoes.estados;
    this.conferirPlano = opcoes.conferirPlano;
    this.logger = opcoes.logger.child({ servico: 'drive' });
    this.clock = opcoes.clock ?? clockDoSistema;
    this.esperar =
      opcoes.esperar ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  // ---------------------------------------------------------------------------
  // Estado e conexão

  /**
   * O estado do Drive para a tela. NUNCA chama o Google: sem plano responde só `plano: false`.
   */
  async visao(workspace: string): Promise<VisaoDoDrive> {
    const plano = await this.conferirPlano(workspace);
    const ativo = this.envioAtivoDe(workspace);
    const envioAtivo = ativo
      ? { id: ativo.envio.id, numeroProcesso: ativo.envio.numeroProcesso }
      : undefined;
    if (!plano) {
      return {
        plano: false,
        estado: 'desconectado',
        linkDaPastaRaiz: undefined,
        motivoDoUltimoErro: undefined,
        conectadaEm: undefined,
        verificadaEm: undefined,
        envioAtivo: undefined,
      };
    }
    const c = await this.repositorio.conexao(workspace);
    return {
      plano: true,
      estado: c?.estado ?? 'desconectado',
      linkDaPastaRaiz: c && c.estado !== 'desconectado' ? c.pastaRaiz?.link : undefined,
      motivoDoUltimoErro: c?.motivoDoUltimoErro,
      conectadaEm: c?.estado === 'conectado' ? c.conectadaEm : undefined,
      verificadaEm: c?.verificadaEm,
      envioAtivo,
    };
  }

  /**
   * Passo 1 da conexão: o endereço de autorização do Google. Não consulta ninguém.
   * @throws {DriveRecusadoError} sem plano.
   */
  async iniciarConexao(workspace: string): Promise<{ readonly url: string }> {
    await this.exigirPlano(workspace);
    const { estado, desafio } = this.estados.emitir(workspace);
    return this.destino.iniciarConexao({
      estado,
      desafio,
      uriDeRetorno: this.opcoes.uriDeRetorno,
    });
  }

  /**
   * Passo 2: o retorno do Google. NUNCA lança — o retorno é uma navegação do navegador, e o
   * que a tela precisa é de um motivo curto, não de uma pilha. O código e o `state` são
   * conferidos AQUI; nada deles vai a log.
   */
  async concluirConexao(entrada: {
    readonly codigo: string;
    readonly estado: string;
    /** Workspace da sessão por cookie que fez a navegação, se houver. Chave de API não vem aqui. */
    readonly workspaceDaSessao?: string;
  }): Promise<ResultadoDaConexao> {
    let workspace: string;
    let verificador: string;
    try {
      ({ workspace, verificador } = this.estados.consumir(
        entrada.estado,
        entrada.workspaceDaSessao,
      ));
    } catch (erro) {
      if (erro instanceof EstadoDeConexaoRecusado) {
        this.logger.warn('retorno do Drive recusado', { motivo: erro.motivo });
        return { ok: false, motivo: 'estado_invalido' };
      }
      throw erro;
    }
    // O plano é conferido DEPOIS do `state` de propósito: retorno forjado nem chega a gastar
    // consulta de plano, e quem perdeu o plano entre o clique e o retorno não conecta.
    if (!(await this.conferirPlano(workspace))) return { ok: false, motivo: 'sem_plano' };

    try {
      const autorizacao = await this.destino.concluirConexao({
        codigo: entrada.codigo,
        verificador,
        uriDeRetorno: this.opcoes.uriDeRetorno,
      });
      const anterior = await this.repositorio.conexao(workspace);
      // Reconectar reaproveita a pasta raiz que o sistema já criou (o `desconectar` a guarda):
      // sem isso, cada reconexão deixaria uma pasta "Processo Vivo" nova ao lado da antiga.
      const raiz = await this.destino.garantirPasta(autorizacao, {
        nome: NOME_DA_PASTA_RAIZ,
        ...(anterior?.pastaRaiz ? { idConhecido: anterior.pastaRaiz.id } : {}),
      });
      await this.repositorio.conectar(
        workspace,
        raiz.pasta,
        autorizacao,
        this.clock.agora(),
      );
      this.logger.info('Drive conectado', { workspace, pastaRecriada: raiz.recriada });
      return { ok: true };
    } catch (erro) {
      return { ok: false, motivo: this.motivoDaConexaoFalhada(erro) };
    }
  }

  /**
   * O advogado recusou na tela do Google (ou a volta veio sem código): só GASTA o `state` — ele
   * não pode ficar valendo —, sem chamar o Google. Nunca lança.
   */
  descartarConexao(estado: string, workspaceDaSessao?: string): void {
    try {
      this.estados.consumir(estado, workspaceDaSessao);
    } catch {
      // Já usado, vencido ou de outra conta: não há nada a gastar.
    }
  }

  /**
   * Desconecta: cancela o envio em curso, revoga no Google (melhor esforço) e APAGA a
   * autorização do cofre. O histórico fica marcado como desconectado; nada some do Drive do
   * advogado. Não exige plano: sair é direito de quem já está dentro, vencida ou não a assinatura.
   */
  async desconectar(workspace: string): Promise<void> {
    this.cancelarExecucao(this.envioAtivoDe(workspace));
    const autorizacao = await this.repositorio.autorizacao(workspace);
    if (autorizacao) await this.destino.desconectar(autorizacao);
    await this.repositorio.desconectar(workspace, this.clock.agora());
    this.logger.info('Drive desconectado', { workspace });
  }

  // ---------------------------------------------------------------------------
  // O envio

  /**
   * Começa o envio de peças de UM processo. Devolve o envio já registrado; o trabalho segue
   * em segundo plano. Nada é enviado sem este clique.
   *
   * @param pecas ids das peças marcadas; `'todas'` = todas as guardáveis do processo.
   * @throws {DriveRecusadoError | ListagemDaPastaAusenteError | PecaDaPastaNaoEncontradaError |
   *   SegredoDeJusticaNaoGuardadoError}
   */
  async iniciarEnvio(entrada: {
    readonly workspace: string;
    readonly numeroProcesso: string;
    readonly pecas: readonly string[] | 'todas';
    readonly reenviarRemovidas?: boolean;
  }): Promise<EnvioParaODrive> {
    const { workspace } = entrada;
    await this.exigirPlano(workspace);
    const numero = NumeroCNJ.criar(entrada.numeroProcesso).digitos;

    const conexao = await this.repositorio.conexao(workspace);
    if (!conexao || conexao.estado === 'desconectado') {
      throw new DriveRecusadoError(
        'nao_conectado',
        'Conecte o Google Drive antes de salvar peças.',
      );
    }
    if (conexao.estado === 'precisa_reconectar') {
      throw new DriveRecusadoError(
        'precisa_reconectar',
        'A autorização do Google Drive expirou. Reconecte para continuar.',
      );
    }

    // Lista gravada da Pasta: nenhuma consulta ao tribunal.
    const lista = await this.fonte.listar(workspace, numero);
    if (lista.processoSigiloso) throw new SegredoDeJusticaNaoGuardadoError(numero);

    const porId = new Map(lista.pecas.map((p) => [p.pecaId, p]));
    let escolhidas: Peca[];
    if (entrada.pecas === 'todas') {
      escolhidas = [...lista.pecas];
    } else {
      escolhidas = [];
      for (const id of new Set(entrada.pecas)) {
        const p = porId.get(id);
        if (!p) throw new PecaDaPastaNaoEncontradaError(id);
        escolhidas.push(p);
      }
    }
    const sigilosas = escolhidas.filter((p) => p.sigilosa).length;
    const guardaveis = escolhidas
      .filter((p) => !p.sigilosa)
      .sort((a, b) => a.ordem - b.ordem);
    if (guardaveis.length === 0) {
      throw new DriveRecusadoError(
        'nada_para_enviar',
        sigilosas > 0
          ? 'As peças escolhidas estão sob sigilo e não vão para o Drive.'
          : 'Não há peças para enviar.',
      );
    }

    // Do teste ao registro, sem `await`: dois cliques juntos não criam dois envios.
    if (this.envioAtivoDe(workspace)) {
      throw new DriveRecusadoError(
        'job_em_andamento',
        'Já há um envio ao Google Drive em andamento. Espere terminar ou cancele.',
      );
    }
    if (this.ativos().length >= this.opcoes.maxSimultaneos) {
      throw new DriveRecusadoError(
        'limite_global',
        'Há muitos envios ao Google Drive em andamento. Tente de novo em instantes.',
      );
    }
    const agora = this.clock.agora();
    const execucao: Execucao = {
      envio: {
        id: this.opcoes.gerarId(),
        workspace,
        numeroProcesso: numero,
        estado: 'em_andamento',
        total: guardaveis.length,
        processadas: 0,
        progresso: {
          enviadas: 0,
          atualizadas: 0,
          jaEstavam: 0,
          removidasNoDrive: 0,
          falhas: 0,
        },
        sigilosasForaDoEnvio: sigilosas,
        removidasNoDrive: [],
        falhasDasPecas: [],
        motivoDaParada: undefined,
        retomarEm: undefined,
        avisos: [],
        linkDaPasta: undefined,
        iniciadoEm: agora,
        terminadoEm: undefined,
      },
      pecas: guardaveis,
      reenviarRemovidas: entrada.reenviarRemovidas === true,
      cancelado: false,
      terminou: Promise.resolve(),
    };
    this.execucoes.set(execucao.envio.id, execucao);
    execucao.terminou = this.executar(execucao, lista.pecas).catch((erro: unknown) => {
      // Defeito nosso: o envio acaba como interrompido, sem pilha na tela.
      this.logger.error('envio ao Drive falhou de forma inesperada', {
        erro: erro instanceof Error ? erro.message : String(erro),
      });
      this.encerrar(execucao, 'interrompido', 'drive_indisponivel');
    });
    return this.copiar(execucao);
  }

  /** @throws {DriveRecusadoError} `job_nao_encontrado` — igual para "não existe" e "é de outra conta". */
  async envio(workspace: string, id: string): Promise<EnvioParaODrive> {
    return this.copiar(this.doWorkspace(workspace, id));
  }

  /** Cancela: o que já foi enviado fica; a peça em curso termina. @throws {DriveRecusadoError} */
  async cancelar(workspace: string, id: string): Promise<EnvioParaODrive> {
    const e = this.doWorkspace(workspace, id);
    this.cancelarExecucao(e);
    return this.copiar(e);
  }

  /** Espera todos os envios em andamento terminarem. Para teste e para o desligamento. */
  async aguardarOcioso(): Promise<void> {
    while (this.ativos().length > 0) {
      await Promise.all(this.ativos().map((e) => e.terminou));
    }
  }

  /** Exclusão de conta. */
  async apagarDoWorkspace(workspace: string): Promise<number> {
    for (const e of this.execucoes.values()) {
      if (e.envio.workspace === workspace) this.cancelarExecucao(e);
    }
    return this.repositorio.apagarDoWorkspace(workspace);
  }

  // ---------------------------------------------------------------------------
  // O laço

  private async executar(e: Execucao, todas: readonly Peca[]): Promise<void> {
    const { workspace } = e.envio;
    try {
      const pastaId = await this.prepararPastas(e);
      const ocorrencias = ocorrenciasDosNomes(todas);
      let falhasSeguidas = 0;
      let primeira = true;

      for (const peca of e.pecas) {
        if (e.cancelado) return this.encerrar(e, 'cancelado');
        if (!primeira) await this.esperar(this.opcoes.pausaEntrePecasMs);
        primeira = false;
        if (e.cancelado) return this.encerrar(e, 'cancelado');

        try {
          const resultado = await this.processarPeca(e, peca, pastaId, ocorrencias);
          falhasSeguidas = 0;
          this.contar(e, peca, resultado);
        } catch (erro) {
          if (erro instanceof FalhaDaPeca) {
            e.envio.progresso.falhas += 1;
            e.envio.falhasDasPecas = [
              ...e.envio.falhasDasPecas,
              { pecaId: peca.pecaId, motivo: erro.motivo },
            ];
            e.envio.processadas += 1;
            falhasSeguidas =
              erro.motivo === 'drive_indisponivel' ? falhasSeguidas + 1 : 0;
            if (falhasSeguidas >= FALHAS_SEGUIDAS_QUE_PARAM) {
              throw new ParadaDoEnvio('drive_indisponivel');
            }
            continue;
          }
          throw erro;
        }
      }
      this.encerrar(e, e.cancelado ? 'cancelado' : 'concluido');
    } catch (erro) {
      // Cancelar durante uma espera (o tribunal, o backoff) termina como cancelado, não como parada.
      if (e.cancelado || erro instanceof EnvioCancelado)
        return this.encerrar(e, 'cancelado');
      const parada = await this.paradaDe(workspace, erro);
      this.encerrar(e, 'interrompido', parada.motivo, parada.retomarEm);
    }
  }

  private async paradaDe(
    workspace: string,
    erro: unknown,
  ): Promise<{ motivo: MotivoDaParadaDoEnvio; retomarEm?: Date }> {
    if (erro instanceof ParadaDoEnvio) {
      return {
        motivo: erro.motivo,
        ...(erro.retomarEm ? { retomarEm: erro.retomarEm } : {}),
      };
    }
    if (erro instanceof AutorizacaoDoDestinoRevogadaError) {
      await this.marcarPrecisaReconectar(workspace, erro.motivo);
      return { motivo: 'precisa_reconectar' };
    }
    if (erro instanceof DriveRecusadoError && erro.motivo === 'precisa_reconectar') {
      return { motivo: 'precisa_reconectar' };
    }
    if (erro instanceof DestinoSemEspacoError) return { motivo: 'drive_cheio' };
    if (erro instanceof DestinoLimitouError) return { motivo: 'limite_de_uso' };
    if (erro instanceof DestinoIndisponivelError) return { motivo: 'drive_indisponivel' };
    if (erro instanceof MniBloqueadoError) {
      return { motivo: 'bloqueio_do_tribunal', retomarEm: erro.retomarEm };
    }
    if (
      erro instanceof CredencialTribunalAusenteError ||
      erro instanceof CredencialTribunalInvalidaError
    ) {
      return { motivo: 'credencial_do_tribunal' };
    }
    // Defeito nosso ou resposta que não sabemos tratar: o envio para, sem texto do Google.
    this.logger.error('envio ao Drive parou por erro inesperado', {
      workspace,
      erro: erro instanceof Error ? erro.name : 'desconhecido',
    });
    return { motivo: 'drive_indisponivel' };
  }

  /** Garante a raiz e a subpasta do processo (uma consulta cada, por envio). */
  private async prepararPastas(e: Execucao): Promise<string> {
    const { workspace, numeroProcesso: numero } = e.envio;
    const conexao = await this.repositorio.conexao(workspace);
    if (!conexao?.pastaRaiz) {
      throw new DriveRecusadoError(
        'nao_conectado',
        'Conecte o Google Drive antes de salvar peças.',
      );
    }
    const raiz = await this.comAutorizacao(workspace, (a) =>
      this.destino.garantirPasta(a, {
        nome: NOME_DA_PASTA_RAIZ,
        idConhecido: conexao.pastaRaiz?.id as string,
      }),
    );
    if (raiz.recriada) {
      await this.repositorio.atualizarPastaRaiz(
        workspace,
        raiz.pasta,
        'pasta_raiz_recriada',
      );
      this.avisar(e, 'pasta_raiz_recriada');
    } else {
      await this.repositorio.registrarVerificacao(workspace, this.clock.agora());
    }

    const conhecida = await this.repositorio.pastaDoProcesso(workspace, numero);
    const nome = NumeroCNJ.criar(numero).formatado;
    const processo = await this.comAutorizacao(workspace, (a) =>
      this.destino.garantirPasta(a, {
        nome,
        paiId: raiz.pasta.id,
        ...(conhecida && !raiz.recriada ? { idConhecido: conhecida.pasta.id } : {}),
      }),
    );
    if (processo.recriada) this.avisar(e, 'pasta_do_processo_recriada');
    if (
      !conhecida ||
      processo.recriada ||
      raiz.recriada ||
      conhecida.pasta.id !== processo.pasta.id
    ) {
      await this.repositorio.guardarPastaDoProcesso({
        workspace,
        numeroProcesso: numero,
        pasta: processo.pasta,
      });
    }
    e.envio.linkDaPasta = processo.pasta.link || undefined;
    return processo.pasta.id;
  }

  private async processarPeca(
    e: Execucao,
    peca: Peca,
    pastaId: string,
    ocorrencias: ReadonlyMap<string, number>,
  ): Promise<ResultadoDaPeca> {
    const { workspace, numeroProcesso: numero } = e.envio;
    const registro = await this.repositorio.peca(workspace, numero, peca.pecaId);
    let guardada = await this.fonte.emGuarda(workspace, numero, peca.pecaId);

    // Já enviada e a peça saiu da guarda: o conteúdo de uma peça do tribunal não muda, então
    // NÃO se volta ao tribunal só para comparar hash. Confere só se o arquivo ainda existe.
    if (!guardada && registro && registro.estado !== 'removida_no_destino') {
      return this.conferirExistencia(e, registro);
    }

    // O advogado apagou este arquivo antes. Sem clique de reenviar, não se envia sozinho —
    // mas confere se ele o restaurou da lixeira, e então a peça volta a valer como enviada.
    if (registro?.estado === 'removida_no_destino' && !e.reenviarRemovidas) {
      return this.conferirExistencia(e, registro);
    }

    if (!guardada) guardada = await this.obterDoTribunal(e, peca);
    const hash = await hashDoConteudo(guardada);

    if (registro && registro.estado !== 'removida_no_destino') {
      // Desconectada vira "no destino" na reconexão; aqui só chega estado `no_destino`.
      const existe = await this.comAutorizacao(workspace, (a) =>
        this.destino.conferirArquivo(a, registro.arquivoId),
      );
      if (existe === 'removido') return this.marcarRemovida(registro);
      if (registro.hash === hash) return 'ja_estava';
      return this.enviar(
        e,
        peca,
        guardada,
        hash,
        pastaId,
        ocorrencias,
        registro,
        registro.arquivoId,
      );
    }

    // Sem registro, ou removida com pedido explícito de reenviar: arquivo NOVO.
    return this.enviar(
      e,
      peca,
      guardada,
      hash,
      pastaId,
      ocorrencias,
      registro,
      undefined,
    );
  }

  private async conferirExistencia(
    e: Execucao,
    registro: PecaNoDestino,
  ): Promise<ResultadoDaPeca> {
    const existe = await this.comAutorizacao(e.envio.workspace, (a) =>
      this.destino.conferirArquivo(a, registro.arquivoId),
    );
    if (existe === 'removido') return this.marcarRemovida(registro);
    if (registro.estado === 'removida_no_destino') {
      // Restaurado da lixeira pelo advogado: volta a valer.
      await this.repositorio.guardarPeca({ ...registro, estado: 'no_destino' });
    }
    return 'ja_estava';
  }

  private async marcarRemovida(registro: PecaNoDestino): Promise<ResultadoDaPeca> {
    if (registro.estado !== 'removida_no_destino') {
      await this.repositorio.guardarPeca({ ...registro, estado: 'removida_no_destino' });
    }
    return 'removida_no_drive';
  }

  private async enviar(
    e: Execucao,
    peca: Peca,
    guardada: PecaEmGuardaParaODrive,
    hash: string,
    pastaId: string,
    ocorrencias: ReadonlyMap<string, number>,
    registro: PecaNoDestino | undefined,
    arquivoId: string | undefined,
  ): Promise<ResultadoDaPeca> {
    const { workspace, numeroProcesso: numero } = e.envio;
    const nome = nomeDoArquivoNoDrive({
      numeroDoAto: peca.numeroDoAto,
      rotulo: peca.rotulo,
      data: peca.data,
      conversao: guardada.conversao,
      pecaId: peca.pecaId,
      ocorrencia: ocorrencias.get(peca.pecaId),
    });
    const descricao =
      guardada.conversao === 'nenhuma'
        ? undefined
        : `Peça convertida pelo Processo Vivo (${guardada.conversao === 'html' ? 'HTML' : 'imagem'} do tribunal em PDF).` +
          (guardada.observacao ? ` ${guardada.observacao}` : '');

    let pasta = pastaId;
    let recriouPastaDoProcesso = false;
    for (let tentativa = 1; ; tentativa += 1) {
      try {
        const arquivo = await this.comRepeticao(e, (a) =>
          this.destino.enviarArquivo(a, {
            nome,
            paiId: pasta,
            mimetype: 'application/pdf',
            conteudo: guardada,
            ...(descricao ? { descricao } : {}),
            ...(arquivoId ? { arquivoId } : {}),
          }),
        );
        const agora = this.clock.agora();
        await this.repositorio.guardarPeca({
          workspace,
          numeroProcesso: numero,
          pecaId: peca.pecaId,
          arquivoId: arquivo.id,
          hash,
          nome,
          estado: 'no_destino',
          enviadaEm: arquivoId && registro ? registro.enviadaEm : agora,
          atualizadaEm: arquivoId ? agora : undefined,
        });
        return arquivoId ? 'atualizada' : 'enviada';
      } catch (erro) {
        if (erro instanceof ArquivoRemovidoNoDestinoError && registro) {
          return this.marcarRemovida(registro);
        }
        // O pai sumiu no meio do envio: recria a pasta do processo UMA vez e repete.
        if (
          erro instanceof PastaRemovidaNoDestinoError &&
          !recriouPastaDoProcesso &&
          !arquivoId
        ) {
          recriouPastaDoProcesso = true;
          pasta = await this.recriarPastaDoProcesso(e);
          continue;
        }
        throw this.traduzirFalhaDaPeca(erro);
      }
    }
  }

  private async recriarPastaDoProcesso(e: Execucao): Promise<string> {
    const { workspace, numeroProcesso: numero } = e.envio;
    const conexao = await this.repositorio.conexao(workspace);
    const raizId = conexao?.pastaRaiz?.id;
    const r = await this.comAutorizacao(workspace, (a) =>
      this.destino.garantirPasta(a, {
        nome: NumeroCNJ.criar(numero).formatado,
        ...(raizId ? { paiId: raizId } : {}),
      }),
    );
    await this.repositorio.guardarPastaDoProcesso({
      workspace,
      numeroProcesso: numero,
      pasta: r.pasta,
    });
    e.envio.linkDaPasta = r.pasta.link || undefined;
    this.avisar(e, 'pasta_do_processo_recriada');
    return r.pasta.id;
  }

  private traduzirFalhaDaPeca(erro: unknown): unknown {
    if (erro instanceof DestinoRecusouError)
      return new FalhaDaPeca('recusada_pelo_drive');
    if (erro instanceof DestinoIndisponivelError)
      return new FalhaDaPeca('drive_indisponivel');
    if (erro instanceof PastaRemovidaNoDestinoError)
      return new FalhaDaPeca('recusada_pelo_drive');
    if (erro instanceof ArquivoRemovidoNoDestinoError)
      return new FalhaDaPeca('recusada_pelo_drive');
    // Autorização revogada, Drive cheio e limite: derrubam o lote (vêm como estão).
    return erro;
  }

  /**
   * Pede a peça ao tribunal PELO caminho da Pasta e espera ela entrar na guarda. Sem pré-busca e
   * sem retry contra o tribunal: credencial recusada e bloqueio PARAM o lote.
   */
  private async obterDoTribunal(
    e: Execucao,
    peca: Peca,
  ): Promise<PecaEmGuardaParaODrive> {
    const { workspace, numeroProcesso: numero } = e.envio;
    for (let pedido = 1; pedido <= MAXIMO_DE_PEDIDOS_POR_PECA; pedido += 1) {
      try {
        await this.fonte.solicitar(workspace, numero, peca.pecaId);
      } catch (erro) {
        if (
          erro instanceof SegredoDeJusticaNaoGuardadoError ||
          erro instanceof PecaSigilosaNaoGuardadaError
        ) {
          throw new FalhaDaPeca('tribunal_nao_entregou');
        }
        if (
          erro instanceof CredencialTribunalAusenteError ||
          erro instanceof CredencialTribunalInvalidaError ||
          erro instanceof MniBloqueadoError ||
          erro instanceof ListagemDaPastaAusenteError
        ) {
          throw erro;
        }
        throw new FalhaDaPeca('tribunal_nao_entregou');
      }

      for (let espera = 0; espera < MAXIMO_DE_ESPERAS_PELA_PECA; espera += 1) {
        const guardada = await this.fonte.emGuarda(workspace, numero, peca.pecaId);
        if (guardada) return guardada;
        const s = await this.fonte.estado(workspace, numero, peca.pecaId);
        if (s.estado === 'nao_obtida') {
          if (s.retomarEm) throw new ParadaDoEnvio('bloqueio_do_tribunal', s.retomarEm);
          throw new FalhaDaPeca('tribunal_nao_entregou');
        }
        if (s.estado === 'sigilo') throw new FalhaDaPeca('tribunal_nao_entregou');
        // Pedido trocado por outro (o advogado clicou noutra peça na Pasta): pede de novo.
        if (s.estado === 'nao_baixada') break;
        if (e.cancelado) throw new EnvioCancelado();
        await this.esperar(1_000);
        if (e.cancelado) throw new EnvioCancelado();
      }
      const ultima = await this.fonte.emGuarda(workspace, numero, peca.pecaId);
      if (ultima) return ultima;
    }
    throw new FalhaDaPeca('tempo_esgotado');
  }

  // ---------------------------------------------------------------------------
  // Autorização

  /** Roda `fn` com a autorização vigente; no 401 renova UMA vez e repete. */
  private async comAutorizacao<T>(
    workspace: string,
    fn: (a: AutorizacaoDoDestino) => Promise<T>,
  ): Promise<T> {
    const a = await this.autorizacao(workspace, false);
    try {
      return await fn(a);
    } catch (erro) {
      if (!(erro instanceof AutorizacaoDoDestinoVencidaError)) throw erro;
      return fn(await this.autorizacao(workspace, true));
    }
  }

  /** `comAutorizacao` + backoff limitado em 429/5xx, respeitando `Retry-After` até um teto. */
  private async comRepeticao<T>(
    e: Execucao,
    fn: (a: AutorizacaoDoDestino) => Promise<T>,
  ): Promise<T> {
    let ultimo: unknown;
    for (let tentativa = 1; tentativa <= MAXIMO_DE_TENTATIVAS; tentativa += 1) {
      try {
        return await this.comAutorizacao(e.envio.workspace, fn);
      } catch (erro) {
        ultimo = erro;
        const repetivel =
          erro instanceof DestinoLimitouError || erro instanceof DestinoIndisponivelError;
        if (!repetivel || tentativa === MAXIMO_DE_TENTATIVAS || e.cancelado) throw erro;
        const pedido = erro instanceof DestinoLimitouError ? erro.esperarMs : undefined;
        // O Google pediu mais do que vale esperar: o lote para, com a causa dita à pessoa.
        if (pedido !== undefined && pedido > TETO_DA_ESPERA_MS) throw erro;
        const espera = Math.min(
          pedido ?? ESPERA_BASE_MS * 2 ** (tentativa - 1),
          TETO_DA_ESPERA_MS,
        );
        await this.esperar(espera);
      }
    }
    throw ultimo;
  }

  private async autorizacao(
    workspace: string,
    forcar: boolean,
  ): Promise<AutorizacaoDoDestino> {
    const atual = await this.repositorio.autorizacao(workspace);
    if (!atual) {
      // Só vira "precisa reconectar" quem estava conectado: sem isto, o envio que o
      // "Desconectar" acabou de cancelar desfaria o desconectar ao notar a falta do token.
      const c = await this.repositorio.conexao(workspace);
      if (c?.estado === 'conectado')
        await this.marcarPrecisaReconectar(workspace, 'revogada');
      throw new DriveRecusadoError(
        'precisa_reconectar',
        'A autorização do Google Drive expirou. Reconecte para continuar.',
      );
    }
    const folga = atual.expiraEm.getTime() - this.clock.agora().getTime();
    if (!forcar && folga > MARGEM_DA_RENOVACAO_MS) return atual;

    const emCurso = this.renovacoes.get(workspace);
    if (emCurso) return emCurso;
    const renovacao = (async (): Promise<AutorizacaoDoDestino> => {
      try {
        const nova = await this.destino.renovarAutorizacao(atual);
        await this.repositorio.salvarAutorizacao(workspace, nova);
        return nova;
      } catch (erro) {
        if (erro instanceof AutorizacaoDoDestinoRevogadaError) {
          await this.marcarPrecisaReconectar(workspace, erro.motivo);
        }
        throw erro;
      } finally {
        this.renovacoes.delete(workspace);
      }
    })();
    this.renovacoes.set(workspace, renovacao);
    return renovacao;
  }

  private async marcarPrecisaReconectar(
    workspace: string,
    motivo: 'revogada' | 'escopo_negado',
  ): Promise<void> {
    await this.repositorio.marcarEstado(
      workspace,
      'precisa_reconectar',
      motivo === 'escopo_negado' ? 'escopo_negado' : 'autorizacao_revogada',
      this.clock.agora(),
    );
  }

  // ---------------------------------------------------------------------------
  // Pequenos

  private async exigirPlano(workspace: string): Promise<void> {
    if (!(await this.conferirPlano(workspace))) {
      throw new DriveRecusadoError(
        'sem_plano',
        'Salvar no Drive faz parte dos planos Peças e IA. Faça upgrade do plano para usar.',
      );
    }
  }

  private motivoDaConexaoFalhada(
    erro: unknown,
  ): Extract<ResultadoDaConexao, { ok: false }>['motivo'] {
    if (erro instanceof AutorizacaoDoDestinoRevogadaError) {
      return erro.motivo === 'escopo_negado' ? 'escopo_negado' : 'autorizacao_recusada';
    }
    if (erro instanceof DestinoRecusouError) return 'autorizacao_recusada';
    if (erro instanceof DestinoIndisponivelError || erro instanceof DestinoLimitouError) {
      return 'indisponivel';
    }
    this.logger.error('conexão com o Drive falhou de forma inesperada', {
      erro: erro instanceof Error ? erro.name : 'desconhecido',
    });
    return 'indisponivel';
  }

  private contar(e: Execucao, peca: Peca, r: ResultadoDaPeca): void {
    const p = e.envio.progresso;
    if (r === 'enviada') p.enviadas += 1;
    else if (r === 'atualizada') p.atualizadas += 1;
    else if (r === 'ja_estava') p.jaEstavam += 1;
    else {
      p.removidasNoDrive += 1;
      e.envio.removidasNoDrive = [...e.envio.removidasNoDrive, peca.pecaId];
    }
    e.envio.processadas += 1;
  }

  private avisar(e: Execucao, aviso: AvisoDoEnvio): void {
    if (!e.envio.avisos.includes(aviso)) e.envio.avisos = [...e.envio.avisos, aviso];
  }

  private encerrar(
    e: Execucao,
    estado: EstadoDoEnvio,
    motivo?: MotivoDaParadaDoEnvio,
    retomarEm?: Date,
  ): void {
    if (e.envio.estado !== 'em_andamento') return;
    e.envio.estado = estado;
    e.envio.motivoDaParada = motivo;
    e.envio.retomarEm = retomarEm;
    e.envio.terminadoEm = this.clock.agora();
    this.logger.info('envio ao Drive terminou', {
      workspace: e.envio.workspace,
      estado,
      motivo,
      enviadas: e.envio.progresso.enviadas,
      atualizadas: e.envio.progresso.atualizadas,
      jaEstavam: e.envio.progresso.jaEstavam,
      falhas: e.envio.progresso.falhas,
    });
    this.podar();
  }

  private cancelarExecucao(e: Execucao | undefined): void {
    if (!e) return;
    e.cancelado = true;
  }

  private ativos(): Execucao[] {
    return [...this.execucoes.values()].filter((e) => e.envio.estado === 'em_andamento');
  }

  private envioAtivoDe(workspace: string): Execucao | undefined {
    return this.ativos().find((e) => e.envio.workspace === workspace);
  }

  private doWorkspace(workspace: string, id: string): Execucao {
    const e = this.execucoes.get(id);
    // Mesma resposta para "não existe" e "é de outra conta".
    if (!e || e.envio.workspace !== workspace) {
      throw new DriveRecusadoError('job_nao_encontrado', 'Envio não encontrado.');
    }
    return e;
  }

  private copiar(e: Execucao): EnvioParaODrive {
    return { ...e.envio, progresso: { ...e.envio.progresso } };
  }

  /** Só o necessário em memória: os mais recentes dos terminados. */
  private podar(): void {
    const terminados = [...this.execucoes.values()]
      .filter((e) => e.envio.estado !== 'em_andamento')
      .sort(
        (a, b) =>
          (a.envio.terminadoEm?.getTime() ?? 0) - (b.envio.terminadoEm?.getTime() ?? 0),
      );
    while (terminados.length > MAXIMO_DE_ENVIOS_GUARDADOS) {
      const antigo = terminados.shift();
      if (antigo) this.execucoes.delete(antigo.envio.id);
    }
  }
}

type ResultadoDaPeca = 'enviada' | 'atualizada' | 'ja_estava' | 'removida_no_drive';

/**
 * Peças do mesmo processo que dariam o MESMO nome: a primeira (na ordem dos autos) fica como
 * está, as seguintes ganham " (2)", " (3)". Calculado sobre a lista INTEIRA do processo, e não
 * sobre a seleção, para o nome da peça não mudar conforme o que se marcou.
 */
export function ocorrenciasDosNomes(pecas: readonly Peca[]): Map<string, number> {
  const vistos = new Map<string, number>();
  const saida = new Map<string, number>();
  for (const p of [...pecas].sort((a, b) => a.ordem - b.ordem)) {
    const chave = nomeDoArquivoNoDrive({
      numeroDoAto: p.numeroDoAto,
      rotulo: p.rotulo,
      data: p.data,
      pecaId: p.pecaId,
    });
    const n = (vistos.get(chave) ?? 0) + 1;
    vistos.set(chave, n);
    saida.set(p.pecaId, n);
  }
  return saida;
}

/** SHA-256 em hex de um conteúdo lido em pedaços — o hash de idempotência. */
export async function hashDoConteudo(c: ConteudoParaEnvio): Promise<string> {
  const h = createHash('sha256');
  if (c.tamanho > 0) {
    for await (const p of c.ler(0, c.tamanho - 1)) h.update(p);
  }
  return h.digest('hex');
}
