import { createHash } from 'node:crypto';
import type {
  AvaliacaoDaAnalise,
  MotivoDaAvaliacao,
} from '../../domain/entities/AnaliseDoAto.js';
import {
  PONTOS_DE_ATENCAO_DO_MODELO,
  pontosDeAtencaoDoSistema,
  type AnaliseDePeca,
  type ContagensDaAnaliseDePeca,
  type PontoDeAtencaoDoSistema,
  type ResultadoDaAnaliseDePeca,
} from '../../domain/entities/AnaliseDePeca.js';
import {
  versaoEfetiva,
  type InstrucaoDoExperimento,
} from '../../domain/entities/InstrucoesDeIa.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
import type { Processo } from '../../domain/entities/Processo.js';
import type { Parte } from '../../domain/entities/Parte.js';
import {
  AcompanhamentoNaoEncontradoError,
  AnaliseDePecaRecusadaError,
  AnaliseNaoEncontradaError,
  DomainError,
  ExtracaoDeTextoError,
  ListagemDaPastaAusenteError,
  PecaDaPastaNaoEncontradaError,
  PecaSigilosaNaoGuardadaError,
  ProviderIndisponivelError,
  SegredoDeJusticaNaoGuardadoError,
} from '../../domain/errors/index.js';
import type {
  AnalisadorDePeca,
  RespostaDoAnalisadorDePeca,
} from '../../domain/ports/AnalisadorDePeca.js';
import {
  SEM_INSTRUCOES,
  type InstrucoesDaFuncao,
} from '../../domain/ports/InstrucoesDeIa.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type {
  ExtratorDeTextoDePdf,
  TextoExtraido,
} from '../../domain/ports/ExtratorDeTextoDePdf.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { RepositorioAcompanhamentos } from '../../domain/ports/RepositorioAcompanhamentos.js';
import type { RepositorioAnalisesDePeca } from '../../domain/ports/RepositorioAnalisesDePeca.js';
import {
  LIMITE_DE_CARACTERES_DA_PECA,
  LIMITE_DE_PAGINAS_DA_PECA,
  montarEntradaDaPeca,
  PESO_DA_PECA_NO_TETO,
  VERSAO_PROMPT_DA_PECA,
  type EntradaDaPeca,
} from '../politicas/entradaDaPeca.js';
import {
  CONTROLE_SEM_PAINEL,
  type ControleDaIa,
} from '../../domain/entities/ControleDaIa.js';
import {
  SEM_REGISTRO_DE_OCORRENCIAS,
  type RegistroDeOcorrenciasDeIa,
} from '../../domain/ports/PainelDeIa.js';
import {
  contagensDaPeca,
  motivoDaFalhaDaChamada,
  registrarContagens,
} from '../politicas/ocorrenciasDeIa.js';
import type { LimiteDeAnalises } from '../politicas/limiteDeAnalises.js';
import {
  modoDaAnaliseDePeca,
  type LiberacaoDaAnaliseDePeca,
  type ModoDaAnaliseDePeca,
} from '../politicas/liberacaoDaAnaliseDePeca.js';
import type { PessoasParaRedigir } from '../politicas/redigirParaIA.js';
import {
  verificarAnaliseDePeca,
  VERSAO_DAS_REGRAS_DA_PECA,
  type ContagemDeCitacoesDePeca,
  type DescartesDaPeca,
  type ResultadoDaVerificacaoDePeca,
} from '../politicas/verificarAnaliseDePeca.js';
import type { PecaParaAnalise } from './ServicoPasta.js';
import type { ServicoAssinaturas } from './ServicoAssinaturas.js';

/**
 * Análise de UMA peça por IA, a pedido de um clique (v0.55.0, Fase 1; especificação v1.2.0).
 *
 * O que molda o código:
 * - **A peça é lida do SERVIDOR**, da guarda de 24 h da Pasta digital (nunca do que o navegador diz) e
 *   só existe em memória: bytes → texto por página → redação → modelo. **O texto da peça nunca é
 *   gravado** — nem no banco, nem em log, nem em erro, nem na resposta (a resposta leva só o
 *   resultado verificado, com citações curtas);
 * - tudo o que recusa (liberação, plano, sigilo, tribunal, sem texto, limites, PDF ruim, teto e freio)
 *   acontece ANTES de qualquer chamada ao adaptador — há teste de zero chamadas;
 * - o processo precisa estar ACOMPANHADO: o retrato dá os nomes das partes para a redação, e sem ele
 *   a peça iria ao modelo com os nomes à vista;
 * - cada análise pesa `PESO_DA_PECA_NO_TETO` (5) no teto técnico diário e conta no freio por hora;
 * - a MESMA peça (mesmos bytes), com o mesmo prompt e o mesmo modelo, volta do banco sem chamar o
 *   modelo e sem pesar de novo: o hash dos bytes não revela o conteúdo;
 * - falha do modelo NÃO vira exceção para a tela: devolve `{ estado: 'erro' }`.
 *
 * Apoio à leitura: nada aqui altera "pede providência", ordem, contagem, calendário ou qualquer dado
 * do retrato, e a leitura descreve a peça ("alega", "pede", "cita") sem avaliar mérito.
 */

export interface FonteDePecaParaAnalise {
  pecaParaAnalise(
    workspace: string,
    numeroProcesso: string,
    pecaId: string,
  ): Promise<PecaParaAnalise>;
}

export interface OpcoesServicoAnaliseDePeca {
  readonly repositorio: RepositorioAcompanhamentos;
  readonly analises: RepositorioAnalisesDePeca;
  readonly assinaturas: Pick<ServicoAssinaturas, 'temRecursoSemExcecao'>;
  readonly fonte: FonteDePecaParaAnalise;
  readonly extrator: ExtratorDeTextoDePdf;
  readonly analisador: AnalisadorDePeca;
  readonly limite: LimiteDeAnalises;
  /** As duas chaves de liberação (lidas da configuração no arranque). */
  readonly liberacao: LiberacaoDaAnaliseDePeca;
  /** Siglas dos tribunais com peça: hoje só o TJGO. */
  readonly tribunais: readonly string[];
  /**
   * O modelo que a configuração pede (gravado junto, para o reaproveitamento). Função desde a Fase B do
   * painel de IA (v0.60.0): o modelo pode mudar pelo painel, e o reaproveitamento tem de olhar o de agora.
   */
  readonly modelo: string | (() => string);
  readonly resultadoDias: number;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly novoId: () => string;
  /** O painel de IA do /admin (v0.58.0). Ausente = só vale o ambiente. */
  readonly controle?: ControleDaIa;
  /** Contagem de falhas e repetições, por motivo (v0.58.0). Ausente = não conta. */
  readonly ocorrencias?: RegistroDeOcorrenciasDeIa;
  /** As instruções de interpretação publicadas no painel (Fase C, v0.61.0). Ausente = o prompt de sempre (+e0). */
  readonly instrucoes?: InstrucoesDaFuncao;
}

export interface PedidoDeAnaliseDePeca {
  readonly workspace: string;
  readonly numero: string;
  readonly pecaId: string;
  readonly sinal?: AbortSignal;
}

/** O que a tela recebe: o resultado já com os nomes do retrato no lugar dos marcadores. */
export interface AnaliseDePecaParaATela {
  readonly estado: 'verificada' | 'nao_verificada';
  readonly id: string;
  readonly modo: ModoDaAnaliseDePeca;
  readonly resultado: ResultadoDaAnaliseDePeca;
  readonly contagens: ContagensDaAnaliseDePeca;
  /**
   * Fatos que o SISTEMA mediu (v0.56.1): peça extensa, pouco texto por página. Calculados aqui, do que o
   * código contou — nunca do modelo — e só quando verdadeiros; peça de uma página nunca é "extensa".
   */
  readonly pontosDoSistema: readonly PontoDeAtencaoDoSistema[];
  /** A mesma peça já tinha sido analisada: nada foi gasto agora. */
  readonly reaproveitada: boolean;
  /**
   * Como o arquivo analisado nasceu (v0.56.0): `html` é o HTML do tribunal desenhado como texto — imagens e
   * tabelas podem não ter entrado, e a tela diz isso. `null` = PDF como o tribunal entregou.
   */
  readonly conversao: 'html' | 'imagem' | null;
  readonly modelo: string;
  readonly versaoPrompt: string;
  readonly provedor: string;
  readonly criadaEm: Date;
  readonly expiraEm: Date;
  readonly avaliacao: AvaliacaoDaAnalise | null;
}

export type RespostaDaAnaliseDePeca =
  AnaliseDePecaParaATela | { readonly estado: 'erro' };

export type BracoDoExperimentoDaPeca =
  | {
      readonly rotulo: InstrucaoDoExperimento['rotulo'];
      readonly versao: number;
      readonly estado: 'erro';
    }
  | {
      readonly rotulo: InstrucaoDoExperimento['rotulo'];
      readonly versao: number;
      readonly estado: 'ok';
      readonly analise: AnaliseDePecaParaATela;
      /** Por que não foi verificada; `null` se foi. */
      readonly motivoDeNaoVerificacao: string | null;
      readonly descartes: DescartesDaPeca;
      readonly citacoes: ContagemDeCitacoesDePeca;
      readonly latenciaMs: number;
      readonly custoUsd: number | null;
      readonly tokensEntrada: number | null;
      readonly tokensSaida: number | null;
    };

const TAMANHO_MAXIMO_DO_PDF_BYTES = 20 * 1024 * 1024;
const UM_DIA_MS = 86_400_000;

const FRASES: Readonly<Record<AnaliseDePecaRecusadaError['motivo'], string>> = {
  indisponivel: 'A análise de peça por IA não está disponível para esta conta.',
  sem_plano:
    'A análise de peça por IA faz parte do plano IA. Faça upgrade do plano para usar.',
  peca_sigilosa: 'Peça sob sigilo: a análise por IA não é feita. Leia a peça.',
  processo_sigiloso:
    'Processo em segredo de justiça: a análise por IA não é feita. Leia a peça.',
  tribunal_nao_suportado:
    'Por enquanto a análise de peça vale apenas para o Tribunal de Justiça de Goiás (TJGO).',
  peca_nao_encontrada:
    'Esta peça não está na lista carregada do processo. Carregue as peças do processo e tente de novo.',
  peca_nao_baixada: 'Baixe a peça antes de analisar.',
  sem_texto:
    'Esta peça não tem texto que possamos ler (parece ser imagem escaneada). Leia a peça.',
  acima_de_40_paginas:
    'Esta peça tem mais de 40 páginas, acima do limite da análise por IA. Leia a peça.',
  acima_de_80_mil_caracteres:
    'Esta peça tem mais de 80 mil caracteres, acima do limite da análise por IA. Leia a peça.',
  pdf_invalido: 'Não conseguimos ler o PDF desta peça. Leia a peça.',
  pdf_protegido: 'O PDF desta peça tem senha e não pode ser lido. Leia a peça.',
  arquivo_grande:
    'O arquivo desta peça é grande demais para a análise por IA. Leia a peça.',
  limite_de_uso:
    'Há muitas análises em andamento ou o limite por hora foi atingido. Tente novamente em instantes.',
  limite_diario:
    'Muitas análises hoje (cada peça conta como cinco). Tente de novo amanhã ou fale com a gente.',
  desligada: 'Este recurso está indisponível no momento.',
};

const recusa = (
  motivo: AnaliseDePecaRecusadaError['motivo'],
): AnaliseDePecaRecusadaError => new AnaliseDePecaRecusadaError(motivo, FRASES[motivo]);

export class ServicoAnaliseDePeca {
  private readonly log: Logger;
  private readonly ocorrencias: RegistroDeOcorrenciasDeIa;

  constructor(private readonly o: OpcoesServicoAnaliseDePeca) {
    this.log = o.logger.child({ servico: 'analise-de-peca' });
    this.ocorrencias = o.ocorrencias ?? SEM_REGISTRO_DE_OCORRENCIAS;
  }

  /** A função está ligada no painel (e o ambiente a permite, já que o serviço existe)? */
  disponivel(): boolean {
    return (this.o.controle ?? CONTROLE_SEM_PAINEL).ligada('peca');
  }

  /**
   * A conta está liberada pelas chaves E a função está ligada no painel? (O botão só aparece para
   * quem está; o plano é conferido no clique.) Desligada no painel, ninguém está liberado: o botão
   * não é desenhado em conta nenhuma.
   */
  modoDa(workspace: string): ModoDaAnaliseDePeca | undefined {
    return this.disponivel() ? this.liberadaPelasChaves(workspace) : undefined;
  }

  private liberadaPelasChaves(workspace: string): ModoDaAnaliseDePeca | undefined {
    return modoDaAnaliseDePeca(workspace, this.o.liberacao);
  }

  async analisar(pedido: PedidoDeAnaliseDePeca): Promise<RespostaDaAnaliseDePeca> {
    const { workspace, pecaId } = pedido;

    // 0. Desligada no painel: nada além da frase fixa, antes de tudo (sem teto consumido, sem modelo).
    if (!this.disponivel()) throw recusa('desligada');

    // 1. Liberação e plano. Antes de ler qualquer coisa. Sem a chave: a rota "não existe".
    const modo = this.modoDa(workspace);
    if (!modo) throw recusa('indisponivel');
    if (!(await this.o.assinaturas.temRecursoSemExcecao(workspace, 'analiseIa'))) {
      throw recusa('sem_plano');
    }

    // 2 a 4. O retrato, a peça da guarda, os bytes em memória e o texto por página (nada disto é gravado).
    const { numero, processo, alvo, hashDosBytes, texto } = await this.lerPecaDaConta(
      workspace,
      pedido.numero,
      pecaId,
    );
    // A versão e o texto das instruções vêm juntos, de UMA leitura: o que se grava é a versão do texto que
    // foi ao modelo, e ela entra na chave do reaproveitamento (publicar instrução nova não serve resposta velha).
    const instrucao = (this.o.instrucoes ?? SEM_INSTRUCOES).efetiva('peca');
    const versaoDoPrompt = versaoEfetiva(VERSAO_PROMPT_DA_PECA, instrucao.versao);
    const entrada = this.entradaDaPeca(texto, processo, instrucao.texto);

    // 5. A mesma peça, o mesmo prompt e o mesmo modelo: volta do banco, sem modelo e sem peso no teto.
    const processoChave = chaveDoProcesso(workspace, numero);
    const agora = this.o.clock.agora();
    const guardada = await this.o.analises.buscarReaproveitavel(
      workspace,
      {
        processoChave,
        pecaId,
        hashDosBytes,
        versaoPrompt: versaoDoPrompt,
        modeloPedido: this.modeloPedido(),
      },
      agora,
    );
    if (guardada) {
      this.log.info('análise de peça reaproveitada', {
        versaoPrompt: versaoDoPrompt,
        paginas: entrada.paginas,
      });
      return this.paraATela(guardada, entrada, modo, true, conversaoParaATela(alvo));
    }

    // 6. Freio por hora e teto diário (peso 5). A vaga é liberada em qualquer desfecho.
    const vaga = this.o.limite.reservar(workspace, PESO_DA_PECA_NO_TETO);
    if ('negada' in vaga) {
      throw recusa(vaga.negada === 'dia' ? 'limite_diario' : 'limite_de_uso');
    }
    try {
      return await this.chamarEGuardar(pedido, {
        processoChave,
        hashDosBytes,
        entrada,
        modo,
        conversao: conversaoParaATela(alvo),
        versaoDoPrompt,
      });
    } finally {
      vaga.liberar();
    }
  }

  /**
   * Os passos 2 a 4 da análise, comuns ao clique do assinante e ao experimento do operador: o retrato é da
   * PRÓPRIA conta (dele saem os nomes da redação e o segredo de justiça), a peça vem da guarda e só existe em
   * memória, e todas as recusas por conteúdo (sem texto, páginas, caracteres) acontecem ANTES do modelo.
   */
  private async lerPecaDaConta(
    workspace: string,
    numeroBruto: string,
    pecaId: string,
  ): Promise<{
    readonly numero: string;
    readonly processo: Processo;
    readonly alvo: PecaParaAnalise;
    readonly hashDosBytes: string;
    readonly texto: TextoExtraido;
  }> {
    const numero = NumeroCNJ.criar(numeroBruto).digitos;
    const acompanhamento = await this.o.repositorio.buscar(workspace, numero);
    if (!acompanhamento) throw new AcompanhamentoNaoEncontradoError();
    const processo = acompanhamento.processo;
    // Sem retrato não há nomes para redigir: a peça não vai ao modelo com os nomes à vista.
    if (!processo) throw new AcompanhamentoNaoEncontradoError();
    if (processo.segredoJustica) throw recusa('processo_sigiloso');

    // 3. A peça, da guarda: a listagem gravada manda (sigilo e tribunal), nunca o navegador.
    let alvo: PecaParaAnalise;
    try {
      alvo = await this.o.fonte.pecaParaAnalise(workspace, numero, pecaId);
    } catch (erro) {
      if (erro instanceof SegredoDeJusticaNaoGuardadoError)
        throw recusa('processo_sigiloso');
      if (erro instanceof PecaSigilosaNaoGuardadaError) throw recusa('peca_sigilosa');
      if (
        erro instanceof PecaDaPastaNaoEncontradaError ||
        erro instanceof ListagemDaPastaAusenteError
      ) {
        throw recusa('peca_nao_encontrada');
      }
      throw erro;
    }
    if (!this.o.tribunais.includes(alvo.tribunal.toUpperCase())) {
      throw recusa('tribunal_nao_suportado');
    }
    if (!alvo.arquivo) throw recusa('peca_nao_baixada');
    if (alvo.arquivo.tamanho > TAMANHO_MAXIMO_DO_PDF_BYTES)
      throw recusa('arquivo_grande');

    // 4. Bytes em memória -> hash -> texto por página -> recusas -> redação. Nada disto é gravado.
    const bytes = await lerTudo(alvo.arquivo);
    const hashDosBytes = createHash('sha256').update(bytes).digest('hex');
    const texto = await this.extrair(bytes);
    if (!texto.contagens.temTextoPesquisavel) throw recusa('sem_texto');
    if (texto.contagens.truncadoPorPaginas) throw recusa('acima_de_40_paginas');
    if (texto.contagens.excedeLimiteDeCaracteres)
      throw recusa('acima_de_80_mil_caracteres');
    return { numero, processo, alvo, hashDosBytes, texto };
  }

  /** Monta a entrada com o bloco de instruções dado e aplica as recusas que dependem do texto montado. */
  private entradaDaPeca(
    texto: TextoExtraido,
    processo: Processo,
    instrucao: string,
  ): EntradaDaPeca {
    const entrada = montarEntradaDaPeca(texto.paginas, pessoasDoProcesso(processo), {
      instrucao,
    });
    if (entrada.recusa === 'texto_insuficiente') throw recusa('sem_texto');
    if (entrada.recusa === 'acima_de_40_paginas') throw recusa('acima_de_40_paginas');
    if (entrada.recusa === 'acima_de_80_mil_caracteres') {
      throw recusa('acima_de_80_mil_caracteres');
    }
    return entrada;
  }

  private modeloPedido(): string {
    return typeof this.o.modelo === 'function' ? this.o.modelo() : this.o.modelo;
  }

  private async extrair(bytes: Uint8Array): Promise<TextoExtraido> {
    try {
      return await this.o.extrator.extrair(bytes, {
        maxPaginas: LIMITE_DE_PAGINAS_DA_PECA,
        maxCaracteres: LIMITE_DE_CARACTERES_DA_PECA,
      });
    } catch (erro) {
      if (erro instanceof ExtracaoDeTextoError) {
        this.log.warn('texto da peça não extraído', { motivo: erro.motivo });
        if (erro.motivo === 'pdf_protegido') throw recusa('pdf_protegido');
        if (erro.motivo === 'arquivo_grande') throw recusa('arquivo_grande');
        throw recusa('pdf_invalido');
      }
      throw erro;
    }
  }

  /**
   * Chama o modelo com a entrada pronta e verifica a resposta (citação na PÁGINA indicada, números, mérito,
   * pedidos…). É o MESMO caminho do clique do assinante e do experimento do operador (`contar` liga as
   * ocorrências do painel). Falha do modelo vira `undefined`, nunca exceção.
   */
  private async chamar(
    entrada: EntradaDaPeca,
    sinal: AbortSignal | undefined,
    contar: boolean,
  ): Promise<
    | {
        readonly bruta: RespostaDoAnalisadorDePeca;
        readonly v: ResultadoDaVerificacaoDePeca;
        readonly resultado: ResultadoDaAnaliseDePeca;
        readonly descartes: number;
        readonly latenciaMs: number;
      }
    | undefined
  > {
    const inicio = this.o.clock.monotonico();
    let bruta: RespostaDoAnalisadorDePeca;
    try {
      bruta = await this.o.analisador.analisar({
        sistema: entrada.sistema,
        usuario: entrada.usuario,
        ...(sinal ? { sinal } : {}),
        ...(contar
          ? {
              aoRepetir: () => this.ocorrencias.registrar('peca', 'repeticao_automatica'),
            }
          : {}),
      });
    } catch (erro) {
      if (contar) this.ocorrencias.registrar('peca', motivoDaFalhaDaChamada(erro));
      // Só a CLASSE do erro e o roteamento SANEADO vão ao log: a mensagem de um roteador pode ecoar o
      // pedido, que leva texto de peça.
      const r = erro instanceof ProviderIndisponivelError ? erro.roteamento : undefined;
      this.log.warn('análise de peça não concluída', {
        causa: erro instanceof DomainError ? erro.codigo : 'erro_inesperado',
        tipo: erro instanceof Error ? erro.name : typeof erro,
        ...(r?.status !== undefined ? { statusHttp: r.status } : {}),
        ...(r?.passo !== undefined ? { passoDoRoteamento: r.passo } : {}),
      });
      return undefined;
    }
    const latenciaMs = Math.max(0, Math.round(this.o.clock.monotonico() - inicio));

    const v = verificarAnaliseDePeca(bruta.resposta, entrada.textoEnviado);
    const resultado: ResultadoDaAnaliseDePeca =
      v.estado === 'verificada'
        ? {
            estado: 'verificada',
            tipo: v.tipo,
            emUmaFrase: v.emUmaFrase,
            pedidos: v.pedidos,
            alegacoes: v.alegacoes,
            preliminares: v.preliminares,
            documentos: v.documentos,
            valores: v.valores,
            pontosDeAtencao: v.pontosDeAtencao,
            determinacoes: v.determinacoes,
          }
        : { estado: 'nao_verificada', motivo: v.motivo };
    const descartes =
      v.descartes.citacao + v.descartes.numero + v.descartes.forma + v.descartes.pagina;
    if (contar) {
      registrarContagens(
        this.ocorrencias,
        'peca',
        contagensDaPeca(
          v.descartes,
          v.estado === 'nao_verificada' ? v.motivo : undefined,
        ),
      );
    }
    return { bruta, v, resultado, descartes, latenciaMs };
  }

  /**
   * EXPERIMENTO do operador (Fase C, v0.61.0): o MESMO caminho de produção (guarda da peça, extração do
   * texto, redação, modelo com ZDR, verificação por página, segredo de justiça) sobre UMA peça da conta do
   * operador, uma vez para cada instrução. **Não grava nada** (nem a análise, nem o texto), não consome o
   * teto dos assinantes, não conta ocorrência e não reaproveita resultado guardado.
   */
  async experimentar(pedido: {
    readonly workspace: string;
    readonly numero: string;
    readonly pecaId: string;
    readonly instrucoes: readonly InstrucaoDoExperimento[];
    readonly sinal?: AbortSignal;
  }): Promise<readonly BracoDoExperimentoDaPeca[]> {
    const { numero, processo, alvo, hashDosBytes, texto } = await this.lerPecaDaConta(
      pedido.workspace,
      pedido.numero,
      pedido.pecaId,
    );
    const conversao = conversaoParaATela(alvo);
    const processoChave = chaveDoProcesso(pedido.workspace, numero);
    // As recusas por conteúdo valem para qualquer instrução: conferidas antes de gastar uma chamada.
    this.entradaDaPeca(texto, processo, '');
    return Promise.all(
      pedido.instrucoes.map(async (i): Promise<BracoDoExperimentoDaPeca> => {
        const entrada = this.entradaDaPeca(texto, processo, i.texto);
        const feita = await this.chamar(entrada, pedido.sinal, false);
        if (!feita) return { rotulo: i.rotulo, versao: i.versao, estado: 'erro' };
        const { bruta, v, resultado, descartes, latenciaMs } = feita;
        const criadaEm = this.o.clock.agora();
        const analise: AnaliseDePeca = {
          id: 'experimento',
          workspace: pedido.workspace,
          processoChave,
          pecaId: pedido.pecaId,
          hashDosBytes,
          resultado,
          contagens: {
            paginas: entrada.paginas,
            caracteres: entrada.caracteres,
            itensDescartados: descartes,
            peso: PESO_DA_PECA_NO_TETO,
          },
          procedencia: {
            modelo: bruta.modelo,
            versaoPrompt: versaoEfetiva(VERSAO_PROMPT_DA_PECA, i.versao),
            provedor: bruta.provedor,
            criadaEm,
          },
          modeloPedido: this.modeloPedido(),
          medidas: {
            latenciaMs,
            ...(bruta.tokensEntrada !== undefined
              ? { tokensEntrada: bruta.tokensEntrada }
              : {}),
            ...(bruta.tokensSaida !== undefined
              ? { tokensSaida: bruta.tokensSaida }
              : {}),
            ...(bruta.custoUsd !== undefined ? { custoUsd: bruta.custoUsd } : {}),
          },
          criadaEm,
          expiraEm: criadaEm,
        };
        return {
          rotulo: i.rotulo,
          versao: i.versao,
          estado: 'ok',
          analise: this.paraATela(analise, entrada, 'avaliacao', false, conversao),
          motivoDeNaoVerificacao:
            resultado.estado === 'nao_verificada' ? resultado.motivo : null,
          descartes: v.descartes,
          citacoes: v.citacoes,
          latenciaMs,
          custoUsd: bruta.custoUsd ?? null,
          tokensEntrada: bruta.tokensEntrada ?? null,
          tokensSaida: bruta.tokensSaida ?? null,
        };
      }),
    );
  }

  private async chamarEGuardar(
    pedido: PedidoDeAnaliseDePeca,
    c: {
      readonly processoChave: string;
      readonly hashDosBytes: string;
      readonly entrada: EntradaDaPeca;
      readonly modo: ModoDaAnaliseDePeca;
      readonly conversao: 'html' | 'imagem' | null;
      /** A versão do prompt com a edição das instruções (`peca-1.1.0+e2`), a que vai gravada. */
      readonly versaoDoPrompt: string;
    },
  ): Promise<RespostaDaAnaliseDePeca> {
    const feita = await this.chamar(c.entrada, pedido.sinal, true);
    if (!feita) return { estado: 'erro' };
    const { bruta, v, resultado, descartes, latenciaMs } = feita;

    const criadaEm = this.o.clock.agora();
    const analise: AnaliseDePeca = {
      id: this.o.novoId(),
      workspace: pedido.workspace,
      processoChave: c.processoChave,
      pecaId: pedido.pecaId,
      hashDosBytes: c.hashDosBytes,
      resultado,
      contagens: {
        paginas: c.entrada.paginas,
        caracteres: c.entrada.caracteres,
        itensDescartados: descartes,
        peso: PESO_DA_PECA_NO_TETO,
      },
      procedencia: {
        modelo: bruta.modelo,
        versaoPrompt: c.versaoDoPrompt,
        provedor: bruta.provedor,
        criadaEm,
      },
      modeloPedido: this.modeloPedido(),
      medidas: {
        latenciaMs,
        ...(bruta.tokensEntrada !== undefined
          ? { tokensEntrada: bruta.tokensEntrada }
          : {}),
        ...(bruta.tokensSaida !== undefined ? { tokensSaida: bruta.tokensSaida } : {}),
        ...(bruta.custoUsd !== undefined ? { custoUsd: bruta.custoUsd } : {}),
      },
      criadaEm,
      expiraEm: new Date(criadaEm.getTime() + this.o.resultadoDias * UM_DIA_MS),
    };
    await this.o.analises.salvar(analise);

    // Só contagens: nada de texto de peça, trecho, título, parte, número de processo ou conta.
    this.log.info('análise de peça concluída', {
      versaoPrompt: c.versaoDoPrompt,
      regras: VERSAO_DAS_REGRAS_DA_PECA,
      estado: resultado.estado,
      paginas: c.entrada.paginas,
      caracteres: c.entrada.caracteres,
      citacoesEmitidas: v.citacoes.emitidas,
      citacoesValidas: v.citacoes.validas,
      descartesCitacao: v.descartes.citacao,
      descartesNumero: v.descartes.numero,
      descartesForma: v.descartes.forma,
      descartesPagina: v.descartes.pagina,
      latenciaMs,
    });
    return this.paraATela(analise, c.entrada, c.modo, false, c.conversao);
  }

  /** Só o dono da conta avalia; pode corrigir. 404 igual para "não existe" e "é de outra". */
  async avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
    motivo?: MotivoDaAvaliacao,
  ): Promise<void> {
    // Avaliar o que já foi feito não depende do interruptor do painel, só da liberação.
    if (!this.liberadaPelasChaves(workspace)) throw recusa('indisponivel');
    const ok = await this.o.analises.avaliar(workspace, id, avaliacao, motivo);
    if (!ok) throw new AnaliseNaoEncontradaError();
  }

  private paraATela(
    a: AnaliseDePeca,
    entrada: EntradaDaPeca,
    modo: ModoDaAnaliseDePeca,
    reaproveitada: boolean,
    conversao: 'html' | 'imagem' | null,
  ): AnaliseDePecaParaATela {
    return {
      estado: a.resultado.estado,
      id: a.id,
      modo,
      resultado: restaurarResultado(a.resultado, entrada.restaurar),
      contagens: a.contagens,
      pontosDoSistema: pontosDeAtencaoDoSistema(a.contagens),
      reaproveitada,
      conversao,
      modelo: a.procedencia.modelo,
      versaoPrompt: a.procedencia.versaoPrompt,
      provedor: a.procedencia.provedor,
      criadaEm: a.criadaEm,
      expiraEm: a.expiraEm,
      avaliacao: a.avaliacao ?? null,
    };
  }
}

function conversaoParaATela(alvo: PecaParaAnalise): 'html' | 'imagem' | null {
  return alvo.conversao === 'html' || alvo.conversao === 'imagem' ? alvo.conversao : null;
}

/** Chave opaca do processo: prende a análise a ele sem gravar o número CNJ. */
export function chaveDoProcesso(workspace: string, numero: string): string {
  return createHash('sha256').update(`peca-ia:${workspace}:${numero}`).digest('hex');
}

function restaurarResultado(
  r: ResultadoDaAnaliseDePeca,
  restaurar: (t: string) => string,
): ResultadoDaAnaliseDePeca {
  if (r.estado === 'nao_verificada') return r;
  const item = (i: {
    texto: string;
    trecho: string;
    pagina: number;
  }): { texto: string; trecho: string; pagina: number } => ({
    texto: restaurar(i.texto),
    trecho: restaurar(i.trecho),
    pagina: i.pagina,
  });
  return {
    ...r,
    // Resultado guardado antes da 0.56.1 pode trazer os códigos de fato do sistema que o modelo emitia:
    // saem aqui (o fato, se verdadeiro, volta pelo cálculo).
    pontosDeAtencao: r.pontosDeAtencao.filter((p) =>
      (PONTOS_DE_ATENCAO_DO_MODELO as readonly string[]).includes(p),
    ),
    ...(r.determinacoes
      ? {
          determinacoes: r.determinacoes.map((d) => ({
            quem: restaurar(d.quem),
            texto: restaurar(d.texto),
            prazo_escrito: d.prazo_escrito === null ? null : restaurar(d.prazo_escrito),
            trecho: restaurar(d.trecho),
            pagina: d.pagina,
          })),
        }
      : {}),
    emUmaFrase: restaurar(r.emUmaFrase),
    pedidos: r.pedidos.map(item),
    alegacoes: r.alegacoes.map(item),
    preliminares: r.preliminares.map(item),
    documentos: r.documentos.map((d) => ({
      nome_como_escrito: restaurar(d.nome_como_escrito),
      pagina: d.pagina,
    })),
    valores: r.valores.map((v) => ({
      valor_literal: v.valor_literal,
      contexto_curto: restaurar(v.contexto_curto),
      trecho: restaurar(v.trecho),
      pagina: v.pagina,
    })),
  };
}

async function lerTudo(arquivo: {
  readonly tamanho: number;
  ler(inicio: number, fim: number): AsyncIterable<Uint8Array>;
}): Promise<Uint8Array> {
  const partes: Uint8Array[] = [];
  let total = 0;
  if (arquivo.tamanho > 0) {
    for await (const p of arquivo.ler(0, arquivo.tamanho - 1)) {
      partes.push(p);
      total += p.byteLength;
    }
  }
  const saida = new Uint8Array(total);
  let posicao = 0;
  for (const p of partes) {
    saida.set(p, posicao);
    posicao += p.byteLength;
  }
  return saida;
}

function pessoasDoProcesso(processo: {
  readonly partes: readonly Parte[];
}): PessoasParaRedigir {
  return {
    partes: processo.partes.map((p) => ({
      nome: p.nome,
      pessoaFisica: p.tipoPessoa === 'FISICA',
      advogados: p.advogados.map((a) => ({ nome: a.nome })),
    })),
  };
}
