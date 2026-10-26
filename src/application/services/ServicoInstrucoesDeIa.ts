import { ehFuncaoDeIa, type FuncaoDeIa } from '../../domain/entities/ControleDaIa.js';
import {
  EXEMPLO_DE_ENTRADA_POR_FUNCAO,
  LIMITE_DA_INSTRUCAO,
  LIMITE_DA_OBSERVACAO,
  LIMITE_DO_HISTORICO,
  SEM_INSTRUCAO,
  diferencaDeLinhas,
  montarPrompt,
  normalizarInstrucao,
  observacaoValida,
  problemaDoTexto,
  type InstrucaoEfetiva,
  type InstrucaoGravada,
  type LinhaDoDiff,
  type PartesDoPrompt,
} from '../../domain/entities/InstrucoesDeIa.js';
import {
  InstrucaoDeIaRecusadaError,
  type MotivoDeInstrucaoDeIaRecusada,
} from '../../domain/errors/index.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type {
  InstrucoesDaFuncao,
  RepositorioDeInstrucoesDeIa,
} from '../../domain/ports/InstrucoesDeIa.js';
import type { Logger } from '../../domain/ports/Logger.js';

/** As frases são NOSSAS e fixas: nunca repetem o que o operador enviou (nem o texto da instrução). */
export const MENSAGEM_DA_INSTRUCAO_RECUSADA: Readonly<
  Record<MotivoDeInstrucaoDeIaRecusada, string>
> = Object.freeze({
  funcao_desconhecida: 'Função de IA desconhecida.',
  texto_vazio:
    'Escreva a instrução antes de publicar. Para voltar ao padrão, use Reverter.',
  texto_grande: `A instrução passa de ${LIMITE_DA_INSTRUCAO} caracteres. Encurte o texto.`,
  observacao_invalida: `A observação passa de ${LIMITE_DA_OBSERVACAO} caracteres ou tem caracteres inválidos.`,
  confirmacao_necessaria: 'Esta ação pede confirmação.',
  rascunho_inexistente: 'Não há rascunho salvo para publicar. Salve o rascunho primeiro.',
  rascunho_mudou: 'O rascunho mudou depois que você abriu a tela. Recarregue e confira.',
  nada_para_reverter:
    'Não há instrução publicada para reverter: a função já usa o padrão (+e0).',
  versao_inexistente: 'Essa versão não existe.',
  versoes_invalidas: 'Escolha duas versões válidas para comparar.',
  experimento_indisponivel: 'O experimento não está disponível neste servidor.',
  conta_do_dono_ausente:
    'Não achei a sua conta para buscar os casos. Confira o e-mail do operador (PROCESSOVIVO_ADMIN_EMAIL) e se há uma conta com ele.',
  caso_invalido: 'O caso escolhido não é válido.',
  caso_nao_encontrado:
    'Esse caso não está mais na sua conta. Atualize a lista e escolha de novo.',
  caso_sigiloso: 'Processo ou peça em segredo de justiça: nada é enviado à IA.',
  caso_sem_texto: 'Esse caso não tem texto suficiente para a IA ler.',
  experimento_em_andamento: 'Já existe um experimento em andamento. Espere terminar.',
  limite_de_experimentos: 'Muitos experimentos na última hora. Tente de novo mais tarde.',
  verificacao_indisponivel:
    'O conjunto de verificação não está disponível neste servidor.',
  verificacao_em_andamento:
    'Já existe um teste em andamento. Espere terminar ou cancele.',
  verificacao_nao_encontrada: 'Verificação não encontrada.',
  estimativa_acima_do_teto:
    'A estimativa de custo passa do teto da rodada. Nada foi enviado.',
});

export function recusarInstrucao(
  motivo: MotivoDeInstrucaoDeIaRecusada,
): InstrucaoDeIaRecusadaError {
  return new InstrucaoDeIaRecusadaError(motivo, MENSAGEM_DA_INSTRUCAO_RECUSADA[motivo]);
}

export interface TextosFixosDaFuncao {
  /** A parte fixa do prompt de sistema, exatamente como o código a monta sem instrução. */
  readonly fixa: string;
  /** A instrução do formato da saída que o transporte acrescenta (só para mostrar na prévia). */
  readonly formato: string;
}

export interface OpcoesDoServicoInstrucoesDeIa {
  readonly repositorio: RepositorioDeInstrucoesDeIa;
  readonly textosFixos: Readonly<Record<FuncaoDeIa, TextosFixosDaFuncao>>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly validadeDoCacheMs?: number;
}

const VALIDADE_PADRAO_MS = 5_000;
const AVISO_DE_FALHA_A_CADA_MS = 60_000;

export interface EstadoDasInstrucoes {
  readonly funcao: FuncaoDeIa;
  readonly publicada: InstrucaoEfetiva;
  /** A edição publicada antes (0 = nenhuma). */
  readonly anterior: number;
  readonly rascunho: InstrucaoGravada | undefined;
  readonly historico: readonly InstrucaoGravada[];
  /** A leitura do banco falhou: o que vale é o prompt de sempre. */
  readonly leituraFalhou: boolean;
}

export interface PrevisaoDoPrompt extends PartesDoPrompt {
  readonly formato: string;
  /** O exemplo FICTÍCIO que ocupa o lugar do texto do caso. */
  readonly exemplo: string;
}

/**
 * As instruções de interpretação de cada função (Fase C, v0.61.0). **Falha segura:** qualquer problema ao
 * ler (banco, linha torta) devolve `{ versao: 0, texto: '' }` — o prompt de sempre, `+e0` — sem lançar: a IA
 * nunca cai nem muda de comportamento por causa do painel. Publicar e reverter limpam o cache, então a
 * próxima análise de qualquer conta já usa a versão nova; a versão e o texto vêm de UMA leitura, então o que é
 * gravado no resultado é sempre a versão do texto que de fato foi ao modelo. Sem travas pesadas: o operador é
 * o único editor, publicar pede só uma confirmação, e as únicas recusas automáticas são o tamanho e o texto
 * vazio ao publicar. Nada aqui toca em ZDR, redação, verificação ou segredo de justiça.
 */
export class ServicoInstrucoesDeIa implements InstrucoesDaFuncao {
  private cache = new Map<
    FuncaoDeIa,
    { readonly valor: InstrucaoEfetiva; readonly ate: number }
  >();
  private ultimoAvisoDeFalhaEm = Number.NEGATIVE_INFINITY;
  private readonly log: Logger;

  constructor(private readonly o: OpcoesDoServicoInstrucoesDeIa) {
    this.log = o.logger.child({ servico: 'instrucoes-de-ia' });
  }

  /** O que vale numa chamada de agora (cache curto). Nunca lança. */
  efetiva(funcao: FuncaoDeIa): InstrucaoEfetiva {
    const agora = this.o.clock.monotonico();
    const guardada = this.cache.get(funcao);
    if (guardada && agora < guardada.ate) return guardada.valor;
    let valor: InstrucaoEfetiva;
    try {
      const p = this.o.repositorio.emProducao(funcao);
      valor = { versao: p.versao, texto: p.texto };
    } catch {
      if (agora - this.ultimoAvisoDeFalhaEm >= AVISO_DE_FALHA_A_CADA_MS) {
        this.ultimoAvisoDeFalhaEm = agora;
        this.log.warn('instruções de IA indisponíveis: vale o prompt de sempre (+e0)');
      }
      valor = SEM_INSTRUCAO;
    }
    this.cache.set(funcao, {
      valor,
      ate: agora + (this.o.validadeDoCacheMs ?? VALIDADE_PADRAO_MS),
    });
    return valor;
  }

  // --- leitura para a tela ---------------------------------------------------------------------------------

  estado(funcao: string): EstadoDasInstrucoes {
    const f = this.funcao(funcao);
    let leituraFalhou = false;
    let publicada: InstrucaoEfetiva = SEM_INSTRUCAO;
    let anterior = 0;
    try {
      const p = this.o.repositorio.emProducao(f);
      publicada = { versao: p.versao, texto: p.texto };
      anterior = p.anterior;
    } catch {
      leituraFalhou = true;
    }
    let rascunho: InstrucaoGravada | undefined;
    let historico: readonly InstrucaoGravada[] = [];
    try {
      rascunho = this.o.repositorio.rascunho(f);
      historico = this.o.repositorio.historico(f, LIMITE_DO_HISTORICO);
    } catch {
      leituraFalhou = true;
    }
    return { funcao: f, publicada, anterior, rascunho, historico, leituraFalhou };
  }

  /** O texto de uma edição; `0` é o vazio (o prompt de sempre). */
  textoDaVersao(funcao: string, versao: number): { versao: number; texto: string } {
    const f = this.funcao(funcao);
    if (versao === 0) return { versao: 0, texto: '' };
    const g = this.o.repositorio.buscar(f, versao);
    if (!g) throw recusarInstrucao('versao_inexistente');
    return { versao: g.versao, texto: g.texto };
  }

  /** O que cada função fixa tem no código, para a prévia e para o experimento. */
  fixa(funcao: FuncaoDeIa): TextosFixosDaFuncao {
    return this.o.textosFixos[funcao];
  }

  previa(funcao: string, texto: string): PrevisaoDoPrompt {
    const f = this.funcao(funcao);
    if (problemaDoTexto(texto, { exigirTexto: false }) === 'grande') {
      throw recusarInstrucao('texto_grande');
    }
    const fixos = this.o.textosFixos[f];
    return {
      ...montarPrompt(f, fixos.fixa, texto),
      formato: fixos.formato,
      exemplo: EXEMPLO_DE_ENTRADA_POR_FUNCAO[f],
    };
  }

  /** Diff por linha entre duas edições (`0` = vazio). */
  diferenca(
    funcao: string,
    de: number,
    para: number,
  ): { readonly de: number; readonly para: number; readonly linhas: LinhaDoDiff[] } {
    if (!Number.isInteger(de) || !Number.isInteger(para) || de < 0 || para < 0) {
      throw recusarInstrucao('versoes_invalidas');
    }
    const a = this.textoDaVersao(funcao, de);
    const b = this.textoDaVersao(funcao, para);
    return { de, para, linhas: diferencaDeLinhas(a.texto, b.texto) };
  }

  // --- mudanças (só pelo /admin) -----------------------------------------------------------------------------

  salvarRascunho(
    autor: string,
    funcao: string,
    texto: string,
    observacao: string,
  ): InstrucaoGravada {
    const f = this.funcao(funcao);
    if (problemaDoTexto(texto, { exigirTexto: false }) === 'grande') {
      throw recusarInstrucao('texto_grande');
    }
    if (!observacaoValida(observacao)) throw recusarInstrucao('observacao_invalida');
    return this.o.repositorio.salvarRascunho(
      f,
      normalizarInstrucao(texto),
      observacao.trim(),
      autor,
      this.o.clock.agora(),
    );
  }

  publicar(
    autor: string,
    funcao: string,
    pedido: { readonly versao: number; readonly confirmado: boolean },
  ): InstrucaoGravada {
    const f = this.funcao(funcao);
    if (!pedido.confirmado) throw recusarInstrucao('confirmacao_necessaria');
    const rascunho = this.o.repositorio.rascunho(f);
    if (!rascunho) throw recusarInstrucao('rascunho_inexistente');
    if (rascunho.versao !== pedido.versao) throw recusarInstrucao('rascunho_mudou');
    const problema = problemaDoTexto(rascunho.texto, { exigirTexto: true });
    if (problema === 'vazio') throw recusarInstrucao('texto_vazio');
    if (problema === 'grande') throw recusarInstrucao('texto_grande');
    const anterior = this.leituraFresca(f);
    const agora = this.o.clock.agora();
    this.o.repositorio.publicar(f, rascunho.versao, autor, agora, {
      em: agora,
      autor,
      funcao: f,
      tipo: 'instrucoes_publicadas',
      anterior: `e${anterior}`,
      novo: `e${rascunho.versao}`,
    });
    this.cache.clear();
    this.log.info('instruções de IA publicadas', {
      autor,
      funcao: f,
      de: anterior,
      para: rascunho.versao,
    });
    return { ...rascunho, estado: 'publicada', publicadoEm: agora, publicadoPor: autor };
  }

  reverter(
    autor: string,
    funcao: string,
    confirmado: boolean,
  ): { de: number; para: number } {
    const f = this.funcao(funcao);
    if (!confirmado) throw recusarInstrucao('confirmacao_necessaria');
    const agora = this.o.clock.agora();
    const r = this.o.repositorio.reverter(f, autor, agora, (de, para) => ({
      em: agora,
      autor,
      funcao: f,
      tipo: 'instrucoes_revertidas',
      anterior: `e${de}`,
      novo: `e${para}`,
    }));
    this.cache.clear();
    if (!r) throw recusarInstrucao('nada_para_reverter');
    this.log.info('instruções de IA revertidas', {
      autor,
      funcao: f,
      de: r.de,
      para: r.para,
    });
    return r;
  }

  // --- internos ---------------------------------------------------------------------------------------------------

  private funcao(v: string): FuncaoDeIa {
    if (!ehFuncaoDeIa(v)) throw recusarInstrucao('funcao_desconhecida');
    return v;
  }

  private leituraFresca(f: FuncaoDeIa): number {
    try {
      return this.o.repositorio.emProducao(f).versao;
    } catch {
      return 0;
    }
  }
}
