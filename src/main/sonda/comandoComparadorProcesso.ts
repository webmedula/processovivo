import { join, resolve } from 'node:path';
import {
  parConfirmadoZdr,
  provedoresPermitidos,
  type ListaZdrLida,
} from '../../infrastructure/adapters/modelo/endpointsZdr.js';
import type { AmbienteDaSonda } from './comandoSondaIa.js';
import {
  CATEGORIAS_DE_PROCESSO,
  lerCasosDeProcesso,
  type CasoDeProcesso,
} from './casosDeProcesso.js';
import { TransporteComTeto } from './comparadorDeModelos.js';
import {
  VERSAO_DO_COMPARADOR_DE_PROCESSO,
  compararSinteses,
  estimarCustoDeProcesso,
  metricasDeProcessoEmCsv,
  relatorioDeProcessoEmMarkdown,
  revisaoDeProcessoEmCsv,
} from './comparadorDeProcesso.js';
import type { PrecoPorToken } from './sondaIaAto.js';

/**
 * A tarefa "processo" do comparador (v0.66.0): a síntese da análise do processo pelas peças. Chamada por
 * `executarComandoComparador` DEPOIS de todas as conferências comuns — chave real, modelo de produção como
 * referência, ZDR da lista oficial de agora, apelidos e variantes recusados, pasta de saída fora do
 * repositório —, então nada daqui roda sem elas. Sem `--executar` só estima: nenhum texto sai.
 */

const usd = (v: number | undefined): string =>
  v === undefined ? 'sem preço' : `US$ ${v.toFixed(4)}`;

export interface ContextoDaComparacaoDeProcesso {
  readonly op: ReadonlyMap<string, string>;
  readonly amb: AmbienteDaSonda;
  readonly chave: string;
  readonly producao: string;
  readonly aprovados: readonly string[];
  readonly lista: ListaZdrLida;
  readonly tetoUsd: number;
  readonly pausa: number;
  readonly pastaDeSaida: string;
  readonly precos: ReadonlyMap<string, PrecoPorToken>;
}

export async function executarComparacaoDeProcesso(
  c: ContextoDaComparacaoDeProcesso,
): Promise<number> {
  const { amb, op } = c;
  const caminho = resolve(
    op.get('casos') ??
      join(amb.raizDoRepositorio, 'tests/fixtures/ia-processo/casos.json'),
  );
  let casos: CasoDeProcesso[] = lerCasosDeProcesso(await amb.lerArquivo(caminho));
  const filtro = op.get('categorias');
  if (filtro) {
    const quer = filtro.split(',').map((s) => s.trim());
    const invalida = quer.find(
      (q) => !(CATEGORIAS_DE_PROCESSO as readonly string[]).includes(q),
    );
    if (invalida) {
      amb.aviso(
        `Categoria desconhecida: ${invalida}. Use: ${CATEGORIAS_DE_PROCESSO.join(', ')}.`,
      );
      return 1;
    }
    casos = casos.filter((x) => quer.includes(x.categoria));
  }
  if (casos.length === 0) {
    amb.aviso('Nenhum caso para rodar.');
    return 1;
  }

  const estimativas = estimarCustoDeProcesso(casos, c.aprovados, c.precos);
  const total = estimativas.reduce((a, e) => a + (e.custoEstimadoUsd ?? 0), 0);
  const semPreco = estimativas.filter((e) => e.custoEstimadoUsd === undefined);
  amb.saida(
    `Comparador da síntese do processo ${VERSAO_DO_COMPARADOR_DE_PROCESSO}: ${casos.length} processos sintéticos × ${c.aprovados.length} modelos (produção: ${c.producao}).`,
  );
  for (const e of estimativas) {
    amb.saida(
      `  ${e.modelo}${e.modelo === c.producao ? ' (produção)' : ''}: ${e.chamadas} chamadas · estimativa ${usd(e.custoEstimadoUsd)}`,
    );
  }
  amb.saida(
    `Estimativa total: ${usd(total)} (preço de lista do OpenRouter, NÃO confirmado) · teto da rodada: US$ ${c.tetoUsd.toFixed(2)}.` +
      (semPreco.length > 0
        ? ` Sem preço publicado: ${semPreco.map((e) => e.modelo).join(', ')} (o teto usa um custo conservador por chamada).`
        : ''),
  );
  if (!op.has('executar')) {
    amb.saida(
      '\nNADA foi enviado ao modelo. Para rodar de verdade, repita o comando com --executar.',
    );
    return 0;
  }
  if (total > c.tetoUsd) {
    amb.aviso(
      `A estimativa (${usd(total)}) passa do teto (US$ ${c.tetoUsd.toFixed(2)}). Nada foi enviado: reduza os modelos ou os processos, ou aumente --teto-usd de propósito.`,
    );
    return 2;
  }

  const transporte = new TransporteComTeto(
    amb.criarTransporte(c.chave),
    c.tetoUsd,
    c.precos,
  );
  const resultado = await compararSinteses({
    casos,
    modeloDeReferencia: c.producao,
    modelos: c.aprovados,
    transporte,
    teto: transporte,
    provedoresPermitidos: (m) => provedoresPermitidos(c.lista.endpoints, m),
    parConfirmadoZdr: (r, p) => parConfirmadoZdr(c.lista.endpoints, r, p),
    precos: c.precos,
    agora: amb.agora,
    dormir: amb.dormir,
    ...(Number.isFinite(c.pausa) && c.pausa > 0 ? { pausaMs: c.pausa } : {}),
    progresso: (l) => amb.aviso(l),
  });

  const base = join(c.pastaDeSaida, `comparacao-processo-${amb.hoje()}-${amb.hora()}`);
  await amb.gravarArquivo(
    `${base}.md`,
    relatorioDeProcessoEmMarkdown(resultado, {
      data: amb.hoje(),
      casos: casos.length,
      tetoUsd: c.tetoUsd,
    }),
  );
  await amb.gravarArquivo(`${base}-metricas.csv`, metricasDeProcessoEmCsv(resultado));
  await amb.gravarArquivo(
    `${base}-revisao-humana.csv`,
    revisaoDeProcessoEmCsv(resultado),
  );

  for (const p of resultado.modelosParados) {
    amb.aviso(
      `Modelo parado: "${p.modelo}" (${p.motivo}). Nenhuma chamada sem ZDR foi feita.`,
    );
  }
  if (resultado.tetoAtingido) {
    amb.aviso(
      'TETO DE GASTO ATINGIDO: a rodada ficou incompleta. Aumente --teto-usd de propósito se quiser completar.',
    );
  }
  amb.saida(
    `\nGasto contado: US$ ${resultado.gastoUsd.toFixed(4)} de US$ ${c.tetoUsd.toFixed(2)}.`,
  );
  amb.saida(`Relatório: ${base}.md`);
  amb.saida(`Métricas: ${base}-metricas.csv`);
  amb.saida(`Revisão humana: ${base}-revisao-humana.csv`);
  return resultado.linhas.every((l) => l.interrompido) ? 3 : 0;
}
