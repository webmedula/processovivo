import { createHash } from 'node:crypto';
import type {
  AvaliacaoDaAnalise,
  MotivoDaAvaliacao,
} from '../../domain/entities/AnaliseDoAto.js';
import type {
  AnaliseDePeca,
  ContagensDaAnaliseDePeca,
  ResultadoDaAnaliseDePeca,
} from '../../domain/entities/AnaliseDePeca.js';
import { NumeroCNJ } from '../../domain/entities/NumeroCNJ.js';
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
import type { AnalisadorDePeca } from '../../domain/ports/AnalisadorDePeca.js';
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
  /** O modelo que a configuração pede (gravado junto, para o reaproveitamento). */
  readonly modelo: string;
  readonly resultadoDias: number;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly novoId: () => string;
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
  /** A mesma peça já tinha sido analisada: nada foi gasto agora. */
  readonly reaproveitada: boolean;
  readonly modelo: string;
  readonly versaoPrompt: string;
  readonly provedor: string;
  readonly criadaEm: Date;
  readonly expiraEm: Date;
  readonly avaliacao: AvaliacaoDaAnalise | null;
}

export type RespostaDaAnaliseDePeca =
  AnaliseDePecaParaATela | { readonly estado: 'erro' };

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
};

const recusa = (
  motivo: AnaliseDePecaRecusadaError['motivo'],
): AnaliseDePecaRecusadaError => new AnaliseDePecaRecusadaError(motivo, FRASES[motivo]);

export class ServicoAnaliseDePeca {
  private readonly log: Logger;

  constructor(private readonly o: OpcoesServicoAnaliseDePeca) {
    this.log = o.logger.child({ servico: 'analise-de-peca' });
  }

  /** A conta está liberada pelas chaves? (O botão só aparece para quem está; o plano é conferido no clique.) */
  modoDa(workspace: string): ModoDaAnaliseDePeca | undefined {
    return modoDaAnaliseDePeca(workspace, this.o.liberacao);
  }

  async analisar(pedido: PedidoDeAnaliseDePeca): Promise<RespostaDaAnaliseDePeca> {
    const { workspace, pecaId } = pedido;

    // 1. Liberação e plano. Antes de ler qualquer coisa. Sem a chave: a rota "não existe".
    const modo = this.modoDa(workspace);
    if (!modo) throw recusa('indisponivel');
    if (!(await this.o.assinaturas.temRecursoSemExcecao(workspace, 'analiseIa'))) {
      throw recusa('sem_plano');
    }

    // 2. O retrato é DA CONTA: dele saem os nomes das partes (redação) e o segredo de justiça.
    const numero = NumeroCNJ.criar(pedido.numero).digitos;
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
    const entrada = montarEntradaDaPeca(texto.paginas, pessoasDoProcesso(processo));
    if (entrada.recusa === 'texto_insuficiente') throw recusa('sem_texto');
    if (entrada.recusa === 'acima_de_40_paginas') throw recusa('acima_de_40_paginas');
    if (entrada.recusa === 'acima_de_80_mil_caracteres') {
      throw recusa('acima_de_80_mil_caracteres');
    }

    // 5. A mesma peça, o mesmo prompt e o mesmo modelo: volta do banco, sem modelo e sem peso no teto.
    const processoChave = chaveDoProcesso(workspace, numero);
    const agora = this.o.clock.agora();
    const guardada = await this.o.analises.buscarReaproveitavel(
      workspace,
      {
        processoChave,
        pecaId,
        hashDosBytes,
        versaoPrompt: VERSAO_PROMPT_DA_PECA,
        modeloPedido: this.o.modelo,
      },
      agora,
    );
    if (guardada) {
      this.log.info('análise de peça reaproveitada', {
        versaoPrompt: VERSAO_PROMPT_DA_PECA,
        paginas: entrada.paginas,
      });
      return this.paraATela(guardada, entrada, modo, true);
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
      });
    } finally {
      vaga.liberar();
    }
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

  private async chamarEGuardar(
    pedido: PedidoDeAnaliseDePeca,
    c: {
      readonly processoChave: string;
      readonly hashDosBytes: string;
      readonly entrada: EntradaDaPeca;
      readonly modo: ModoDaAnaliseDePeca;
    },
  ): Promise<RespostaDaAnaliseDePeca> {
    const inicio = this.o.clock.monotonico();
    let bruta;
    try {
      bruta = await this.o.analisador.analisar({
        sistema: c.entrada.sistema,
        usuario: c.entrada.usuario,
        ...(pedido.sinal ? { sinal: pedido.sinal } : {}),
      });
    } catch (erro) {
      // Só a CLASSE do erro e o roteamento SANEADO vão ao log: a mensagem de um roteador pode ecoar o
      // pedido, que leva texto de peça.
      const r = erro instanceof ProviderIndisponivelError ? erro.roteamento : undefined;
      this.log.warn('análise de peça não concluída', {
        causa: erro instanceof DomainError ? erro.codigo : 'erro_inesperado',
        tipo: erro instanceof Error ? erro.name : typeof erro,
        ...(r?.status !== undefined ? { statusHttp: r.status } : {}),
        ...(r?.passo !== undefined ? { passoDoRoteamento: r.passo } : {}),
      });
      return { estado: 'erro' };
    }
    const latenciaMs = Math.max(0, Math.round(this.o.clock.monotonico() - inicio));

    const v = verificarAnaliseDePeca(bruta.resposta, c.entrada.textoEnviado);
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
          }
        : { estado: 'nao_verificada', motivo: v.motivo };
    const descartes =
      v.descartes.citacao + v.descartes.numero + v.descartes.forma + v.descartes.pagina;

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
        versaoPrompt: VERSAO_PROMPT_DA_PECA,
        provedor: bruta.provedor,
        criadaEm,
      },
      modeloPedido: this.o.modelo,
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
      versaoPrompt: VERSAO_PROMPT_DA_PECA,
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
    return this.paraATela(analise, c.entrada, c.modo, false);
  }

  /** Só o dono da conta avalia; pode corrigir. 404 igual para "não existe" e "é de outra". */
  async avaliar(
    workspace: string,
    id: string,
    avaliacao: AvaliacaoDaAnalise,
    motivo?: MotivoDaAvaliacao,
  ): Promise<void> {
    if (!this.modoDa(workspace)) throw recusa('indisponivel');
    const ok = await this.o.analises.avaliar(workspace, id, avaliacao, motivo);
    if (!ok) throw new AnaliseNaoEncontradaError();
  }

  private paraATela(
    a: AnaliseDePeca,
    entrada: EntradaDaPeca,
    modo: ModoDaAnaliseDePeca,
    reaproveitada: boolean,
  ): AnaliseDePecaParaATela {
    return {
      estado: a.resultado.estado,
      id: a.id,
      modo,
      resultado: restaurarResultado(a.resultado, entrada.restaurar),
      contagens: a.contagens,
      reaproveitada,
      modelo: a.procedencia.modelo,
      versaoPrompt: a.procedencia.versaoPrompt,
      provedor: a.procedencia.provedor,
      criadaEm: a.criadaEm,
      expiraEm: a.expiraEm,
      avaliacao: a.avaliacao ?? null,
    };
  }
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
