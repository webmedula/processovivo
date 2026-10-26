import {
  FUNCOES_DE_IA,
  ROTULO_DA_FUNCAO,
  type FuncaoDeIa,
} from '../../../domain/entities/ControleDaIa.js';
import {
  LIMITE_DA_INSTRUCAO,
  LIMITE_DA_OBSERVACAO,
  versaoEfetiva,
  type InstrucaoGravada,
} from '../../../domain/entities/InstrucoesDeIa.js';
import { linhasDaComparacao } from '../../../domain/entities/ModelosDeIa.js';
import { avisosDePiora } from '../../../domain/entities/VerificacaoDeInstrucoes.js';
import type { TesteDeModelo } from '../../../domain/ports/ModelosDeIa.js';
import { VERSAO_PROMPT } from '../../../application/politicas/entradaDoModelo.js';
import { VERSAO_PROMPT_DA_PECA } from '../../../application/politicas/entradaDaPeca.js';
import { VERSAO_PROMPT_DO_RESUMO } from '../../../application/politicas/entradaDoResumo.js';
import { FRASE_DA_FALHA_DO_TESTE } from '../../../application/services/ServicoTesteDeModelo.js';
import type { ResultadoDoExperimento } from '../../../application/services/ServicoExperimentoDeInstrucoes.js';
import type { ServicoExperimentoDeInstrucoes } from '../../../application/services/ServicoExperimentoDeInstrucoes.js';
import type { ServicoInstrucoesDeIa } from '../../../application/services/ServicoInstrucoesDeIa.js';
import type { ServicoVerificacaoDeInstrucoes } from '../../../application/services/ServicoVerificacaoDeInstrucoes.js';
import { MAXIMO_DE_EXPERIMENTOS_POR_HORA } from '../../../application/services/ServicoExperimentoDeInstrucoes.js';

/**
 * As respostas do painel de instruções (Fase C, v0.61.0) como JSON. Aqui há duas famílias de conteúdo: o TEXTO das
 * instruções do operador (dele, não de caso) e — SÓ na resposta do experimento, que não é gravada — o resultado
 * da IA sobre um caso da conta do próprio operador. Nada disto leva nome de parte, número de processo ou conta
 * de assinante; as contas dos erros saem com 8 caracteres.
 */

const iso = (d: Date | undefined | null): string | null => (d ? d.toISOString() : null);

export const VERSAO_DE_CODIGO_DO_PROMPT: Readonly<Record<FuncaoDeIa, string>> =
  Object.freeze({
    ato: VERSAO_PROMPT,
    resumo: VERSAO_PROMPT_DO_RESUMO,
    peca: VERSAO_PROMPT_DA_PECA,
  });

const rotuloDaEdicao = (n: number): string => `+e${n}`;

function versaoParaJson(v: InstrucaoGravada): Record<string, unknown> {
  return {
    versao: v.versao,
    rotulo: rotuloDaEdicao(v.versao),
    estado: v.estado,
    observacao: v.observacao,
    caracteres: v.texto.length,
    criadoEm: v.criadoEm.toISOString(),
    publicadoEm: iso(v.publicadoEm),
    publicadoPor: v.publicadoPor ?? null,
    autor: v.autor,
  };
}

export function verificacaoParaJson(
  t: TesteDeModelo,
  volume = 0,
): Record<string, unknown> {
  const rascunho = t.metricasDoCandidato;
  const publicada = t.metricasDaReferencia;
  const piora = rascunho && publicada ? avisosDePiora(rascunho, publicada) : undefined;
  return {
    id: t.id,
    funcao: t.funcao,
    estado: t.estado,
    modelo: t.candidato,
    rascunho: t.instrucaoVersao ? rotuloDaEdicao(t.instrucaoVersao) : 'rascunho',
    criadoEm: t.criadoEm.toISOString(),
    iniciadoEm: iso(t.iniciadoEm),
    terminadoEm: iso(t.terminadoEm),
    chamadasPrevistas: t.chamadasPrevistas,
    chamadasFeitas: Math.min(t.chamadasFeitas, t.chamadasPrevistas),
    estimativaUsd: t.estimativaUsd,
    gastoUsd: t.gastoUsd,
    falha: t.falha ? { codigo: t.falha, frase: FRASE_DA_FALHA_DO_TESTE[t.falha] } : null,
    // Os avisos NUNCA bloqueiam; `sem_zdr` (veredito gravado com bloqueio) também vira aviso.
    avisos: piora
      ? piora.avisos
      : (t.bloqueios ?? []).map((c) => ({
          codigo: c,
          frase: 'Nada foi enviado.',
          gravidade: 'grave',
        })),
    semPiora: piora?.semPiora ?? null,
    // Referência = instrução publicada; candidato = rascunho (a tabela mostra "publicada" e "rascunho").
    comparacao: rascunho && publicada ? linhasDaComparacao(rascunho, publicada) : null,
    analisesNosUltimos30Dias: volume,
  };
}

export function instrucoesParaJson(
  instrucoes: ServicoInstrucoesDeIa,
  experimento: ServicoExperimentoDeInstrucoes,
  verificacao: ServicoVerificacaoDeInstrucoes,
): Record<string, unknown> {
  return {
    limites: { texto: LIMITE_DA_INSTRUCAO, observacao: LIMITE_DA_OBSERVACAO },
    verificacao: {
      disponivel: verificacao.disponivel,
      tetoDaRodadaUsd: verificacao.teto,
      emAndamento: ((): Record<string, unknown> | null => {
        const t = verificacao.emAndamento();
        return t ? verificacaoParaJson(t) : null;
      })(),
    },
    experimento: { maximoPorHora: MAXIMO_DE_EXPERIMENTOS_POR_HORA },
    funcoes: FUNCOES_DE_IA.map((f) => {
      const e = instrucoes.estado(f);
      const ultima = verificacao.ultimaDaFuncao(f);
      const base = VERSAO_DE_CODIGO_DO_PROMPT[f];
      return {
        funcao: f,
        rotulo: ROTULO_DA_FUNCAO[f],
        versaoDoPrompt: base,
        versaoEfetiva: `${base}${rotuloDaEdicao(e.publicada.versao)}`,
        // O que fica gravado em cada resultado: sem sufixo quando não há instrução publicada.
        versaoGravada: versaoEfetiva(base, e.publicada.versao),
        leituraFalhou: e.leituraFalhou,
        publicada: {
          versao: e.publicada.versao,
          rotulo: rotuloDaEdicao(e.publicada.versao),
          texto: e.publicada.texto,
        },
        // Reverter volta à anterior; sem anterior, ao padrão (`+e0`).
        podeReverter: e.publicada.versao > 0,
        reverteParaRotulo: e.publicada.versao > 0 ? rotuloDaEdicao(e.anterior) : null,
        rascunho: e.rascunho
          ? {
              versao: e.rascunho.versao,
              rotulo: rotuloDaEdicao(e.rascunho.versao),
              texto: e.rascunho.texto,
              observacao: e.rascunho.observacao,
              salvoEm: e.rascunho.criadoEm.toISOString(),
            }
          : null,
        historico: e.historico.filter((h) => h.estado !== 'rascunho').map(versaoParaJson),
        experimentoDisponivel: experimento.disponivelPara(f),
        ultimaVerificacao: ultima ? verificacaoParaJson(ultima) : null,
      };
    }),
  };
}

// --- experimento ---------------------------------------------------------------------------------------------------

interface ItemJson {
  readonly texto: string;
  readonly citacao?: string;
  readonly nota?: string;
}
interface SecaoJson {
  readonly titulo: string;
  readonly itens: readonly ItemJson[];
}

const ROTULO_DO_DESCARTE: Readonly<Record<string, string>> = Object.freeze({
  citacao: 'citação que não está no texto',
  numeroInventado: 'número ou data que o texto não tem',
  numero: 'número ou data que o texto não tem',
  expressaoProibida: 'expressão proibida (parecer, mérito, chance)',
  forma: 'forma fora do contrato (tamanho, vocabulário)',
  acaoCopiada: 'providência que só copia o trecho',
  prazoDescartado: 'prazo descartado (número que o ato não escreve)',
  referencia: 'ato que não foi enviado',
  copiaDoTrecho: 'texto que só copia o trecho',
  atualidade: 'ato antigo apresentado como atual',
  pendenciaNegada: '"sem pendências" havendo providência do sistema',
  pagina: 'página que não existe',
});

const ROTULO_DO_MOTIVO: Readonly<Record<string, string>> = Object.freeze({
  sem_citacao_valida: 'nenhuma citação do modelo existe no texto',
  expressao_proibida: 'o modelo usou expressão proibida (parecer, mérito ou chance)',
  acao_copiada_do_trecho: 'a providência só copiava o trecho',
  sem_item_verificado: 'nenhum item sobreviveu à verificação',
  sem_ato_mais_recente: 'o ato mais recente lido não estava na situação',
});

const ROTULO_DO_PARECE_PEDIR: Readonly<Record<string, string>> = Object.freeze({
  manifestar: 'manifestação',
  cumprir_determinacao: 'cumprir determinação',
  comparecer_audiencia_ou_pericia: 'comparecer a audiência ou perícia',
  apenas_ciencia: 'só ciência',
  sem_providencia_aparente: 'sem providência aparente',
  indeterminado: 'indeterminado',
});

const dataBr = (d: Date | string): string => {
  const x = new Date(d);
  const local = new Date(x.getTime() - 3 * 3_600_000);
  return `${String(local.getUTCDate()).padStart(2, '0')}/${String(local.getUTCMonth() + 1).padStart(2, '0')}/${local.getUTCFullYear()}`;
};

const humano = (codigo: string): string => codigo.replace(/_/g, ' ');

function lista<T>(v: readonly T[] | undefined): readonly T[] {
  return v ?? [];
}

function secoesDo(
  r: ResultadoDoExperimento['bracos'][number],
  funcao: FuncaoDeIa,
): SecaoJson[] {
  if (r.estado !== 'ok') return [];
  const secoes: SecaoJson[] = [];
  if (funcao === 'ato' && 'analise' in r && !('resumo' in r)) {
    const a = r.analise as {
      parecePedir?: string;
      resumo?: string;
      trechoChave?: string;
      acoesPossiveis: readonly { acao: string }[];
      pontosDeAtencao: readonly string[];
      prazo?: { dias: number; tipo: string | null };
    };
    if (a.resumo !== undefined) {
      secoes.push({
        titulo: 'O que o ato diz',
        itens: [
          {
            texto: a.resumo,
            ...(a.trechoChave ? { citacao: a.trechoChave } : {}),
            ...(a.parecePedir
              ? {
                  nota: `Parece pedir: ${ROTULO_DO_PARECE_PEDIR[a.parecePedir] ?? humano(a.parecePedir)}`,
                }
              : {}),
          },
        ],
      });
    }
    if (a.acoesPossiveis.length > 0) {
      secoes.push({
        titulo: 'Providências',
        itens: a.acoesPossiveis.map((x) => ({ texto: x.acao })),
      });
    }
    if (a.prazo) {
      secoes.push({
        titulo: 'Prazo escrito no ato',
        itens: [
          {
            texto: `${a.prazo.dias} dias${a.prazo.tipo ? ` (${a.prazo.tipo === 'uteis' ? 'úteis' : 'corridos'})` : ''}`,
          },
        ],
      });
    }
    if (a.pontosDeAtencao.length > 0) {
      secoes.push({
        titulo: 'Pontos de atenção',
        itens: a.pontosDeAtencao.map((p) => ({ texto: humano(p) })),
      });
    }
  } else if (funcao === 'resumo' && 'resumo' in r) {
    const x = r.resumo;
    const item = (i: (typeof x.situacao)[number]): ItemJson => ({
      texto: i.texto,
      citacao: i.trecho,
      nota: `${i.ato.rotulo} · ${dataBr(i.ato.data)}`,
    });
    if (x.situacao.length > 0)
      secoes.push({ titulo: 'Situação', itens: x.situacao.map(item) });
    if (x.pendencias.length > 0) {
      secoes.push({ titulo: 'O que pede providência', itens: x.pendencias.map(item) });
    }
    if (x.pontosDoAto.length > 0) {
      secoes.push({
        titulo: 'Pontos de atenção',
        itens: x.pontosDoAto.map((p) => ({
          texto: humano(p.codigo),
          ...(p.ato ? { nota: `${p.ato.rotulo} · ${dataBr(p.ato.data)}` } : {}),
        })),
      });
    }
  } else if (funcao === 'peca' && 'analise' in r) {
    const res = (r.analise as { resultado: Record<string, unknown> }).resultado as {
      estado: string;
      tipo?: string;
      emUmaFrase?: string;
      pedidos?: readonly { texto: string; trecho: string; pagina: number }[];
      alegacoes?: readonly { texto: string; trecho: string; pagina: number }[];
      preliminares?: readonly { texto: string; trecho: string; pagina: number }[];
      documentos?: readonly { nome_como_escrito: string; pagina: number }[];
      valores?: readonly {
        valor_literal: string;
        contexto_curto: string;
        trecho: string;
        pagina: number;
      }[];
      determinacoes?: readonly {
        quem: string;
        texto: string;
        prazo_escrito: string | null;
        trecho: string;
        pagina: number;
      }[];
      pontosDeAtencao?: readonly string[];
    };
    if (res.estado === 'verificada') {
      const it = (i: { texto: string; trecho: string; pagina: number }): ItemJson => ({
        texto: i.texto,
        citacao: i.trecho,
        nota: `pág. ${i.pagina}`,
      });
      if (res.emUmaFrase) {
        secoes.push({
          titulo: 'Em uma frase',
          itens: [
            {
              texto: res.emUmaFrase,
              ...(res.tipo ? { nota: `Tipo: ${humano(res.tipo)}` } : {}),
            },
          ],
        });
      }
      if (lista(res.determinacoes).length > 0) {
        secoes.push({
          titulo: 'O que determina',
          itens: lista(res.determinacoes).map((d) => ({
            texto: `${d.quem}: ${d.texto}`,
            citacao: d.trecho,
            nota: `pág. ${d.pagina}${d.prazo_escrito ? ` · prazo escrito no ato: ${d.prazo_escrito}` : ''}`,
          })),
        });
      }
      if (lista(res.pedidos).length > 0)
        secoes.push({ titulo: 'Pedidos', itens: lista(res.pedidos).map(it) });
      if (lista(res.alegacoes).length > 0) {
        secoes.push({
          titulo: 'Alegações principais',
          itens: lista(res.alegacoes).map(it),
        });
      }
      if (lista(res.preliminares).length > 0) {
        secoes.push({
          titulo: 'Preliminares e defesas formais',
          itens: lista(res.preliminares).map(it),
        });
      }
      if (lista(res.documentos).length > 0) {
        secoes.push({
          titulo: 'Documentos citados',
          itens: lista(res.documentos).map((d) => ({
            texto: d.nome_como_escrito,
            nota: `pág. ${d.pagina}`,
          })),
        });
      }
      if (lista(res.valores).length > 0) {
        secoes.push({
          titulo: 'Valores citados',
          itens: lista(res.valores).map((v) => ({
            texto: `${v.valor_literal} — ${v.contexto_curto}`,
            citacao: v.trecho,
            nota: `pág. ${v.pagina}`,
          })),
        });
      }
      if (lista(res.pontosDeAtencao).length > 0) {
        secoes.push({
          titulo: 'Pontos de atenção',
          itens: lista(res.pontosDeAtencao).map((p) => ({ texto: humano(p) })),
        });
      }
    }
  }
  return secoes;
}

export function experimentoParaJson(r: ResultadoDoExperimento): Record<string, unknown> {
  return {
    funcao: r.funcao,
    bracos: r.bracos.map((b) => {
      if (b.estado === 'erro') {
        return {
          rotulo: b.rotulo,
          versao: b.versao,
          versaoRotulo: rotuloDaEdicao(b.versao),
          estado: 'erro',
        };
      }
      const modelo =
        'resumo' in b ? b.resumo.modelo : (b.analise as { modelo: string }).modelo;
      const verificado =
        'resumo' in b
          ? b.resumo.estado === 'verificado'
          : b.analise.estado === 'verificada';
      const descartes = Object.entries(b.descartes as unknown as Record<string, number>)
        .filter(([, n]) => typeof n === 'number' && n > 0)
        .map(([codigo, n]) => ({
          codigo,
          rotulo: ROTULO_DO_DESCARTE[codigo] ?? humano(codigo),
          quantidade: n,
        }));
      return {
        rotulo: b.rotulo,
        versao: b.versao,
        versaoRotulo: rotuloDaEdicao(b.versao),
        estado: 'ok',
        verificado,
        motivoDeNaoVerificacao: b.motivoDeNaoVerificacao,
        motivoDeNaoVerificacaoFrase: b.motivoDeNaoVerificacao
          ? (ROTULO_DO_MOTIVO[b.motivoDeNaoVerificacao] ??
            humano(b.motivoDeNaoVerificacao))
          : null,
        secoes: secoesDo(b, r.funcao),
        descartes,
        citacoes: 'citacoes' in b ? b.citacoes : null,
        modelo,
        latenciaMs: b.latenciaMs,
        custoUsd: b.custoUsd,
        tokensEntrada: b.tokensEntrada,
        tokensSaida: b.tokensSaida,
      };
    }),
  };
}

export function processoDaListaParaJson(
  p: Awaited<ReturnType<ServicoExperimentoDeInstrucoes['processos']>>[number],
): Record<string, unknown> {
  return {
    numero: p.numero,
    numeroFormatado: p.numeroFormatado,
    tribunal: p.tribunal,
    classe: p.classe,
    apelido: p.apelido,
    sigiloso: p.sigiloso,
    ultimaMovimentacaoEm: iso(p.ultimaMovimentacaoEm),
    atos: p.atos,
  };
}
