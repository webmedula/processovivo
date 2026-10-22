import { join, resolve } from 'node:path';
import {
  parConfirmadoZdr,
  provedoresPermitidos,
  type ListaZdrLida,
} from '../../infrastructure/adapters/modelo/endpointsZdr.js';
import type { AmbienteDaSonda } from './comandoSondaIa.js';
import {
  CRITERIO_DA_FASE_1,
  VERSAO_DO_COMPARADOR_DE_PECAS,
  compararPecas,
  estimarCustoDePecas,
  julgarRevisaoDePecas,
  metricasDePecasEmCsv,
  relatorioDePecasEmMarkdown,
  revisaoDePecasEmCsv,
  RevisaoDePecasInvalidaError,
} from './comparadorDePecas.js';
import { TransporteComTeto } from './comparadorDeModelos.js';
import { lerCasosDePecas, type CasoDePeca } from './casosDePecas.js';
import type { PrecoPorToken } from './sondaIaAto.js';

/**
 * A tarefa "peças" do comparador (v0.53.0). Chamada por `executarComandoComparador` DEPOIS de
 * todas as conferências comuns — chave real, modelo de produção como referência, ZDR da lista
 * oficial de agora, apelidos e variantes recusados, pasta de saída fora do repositório —, então
 * nada daqui roda sem elas. Sem `--executar` só estima.
 */

/** Versão das regras de verificação de PEÇA (independente da do ato). */
export const VERSAO_DAS_REGRAS_DE_PECA = '0.1.0';

const usd = (v: number | undefined): string =>
  v === undefined ? 'sem preço' : `US$ ${v.toFixed(4)}`;

export interface ContextoDaComparacaoDePecas {
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

export async function executarComparacaoDePecas(
  c: ContextoDaComparacaoDePecas,
): Promise<number> {
  const { amb, op } = c;
  const caminhoDosCasos = resolve(
    op.get('casos') ?? join(amb.raizDoRepositorio, 'tests/fixtures/ia-pecas/casos.json'),
  );
  let casos: CasoDePeca[] = lerCasosDePecas(await amb.lerArquivo(caminhoDosCasos));
  const filtro = op.get('categorias');
  if (filtro) {
    const quer = filtro.split(',').map((s) => s.trim());
    const existentes = new Set(casos.map((x) => x.categoria));
    const invalida = quer.find((q) => !existentes.has(q));
    if (invalida) {
      amb.aviso(
        `Categoria desconhecida: ${invalida}. Use: ${[...existentes].join(', ')}.`,
      );
      return 1;
    }
    casos = casos.filter((x) => quer.includes(x.categoria));
  }
  if (casos.length === 0) {
    amb.aviso('Nenhum caso para rodar.');
    return 1;
  }

  const estimativas = estimarCustoDePecas(casos, c.aprovados, c.precos);
  const total = estimativas.reduce((a, e) => a + (e.custoEstimadoUsd ?? 0), 0);
  const semPreco = estimativas.filter((e) => e.custoEstimadoUsd === undefined);
  amb.saida(
    `Comparador de peças ${VERSAO_DO_COMPARADOR_DE_PECAS}: ${casos.length} peças sintéticas × ${c.aprovados.length} modelos (produção: ${c.producao}).`,
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
      `A estimativa (${usd(total)}) passa do teto (US$ ${c.tetoUsd.toFixed(2)}). Nada foi enviado: reduza os modelos ou as peças, ou aumente --teto-usd de propósito.`,
    );
    return 2;
  }

  const transporte = new TransporteComTeto(
    amb.criarTransporte(c.chave),
    c.tetoUsd,
    c.precos,
  );
  const resultado = await compararPecas({
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

  const base = join(c.pastaDeSaida, `comparacao-pecas-${amb.hoje()}-${amb.hora()}`);
  await amb.gravarArquivo(
    `${base}.md`,
    relatorioDePecasEmMarkdown(resultado, {
      data: amb.hoje(),
      casos: casos.length,
      tetoUsd: c.tetoUsd,
      versaoDasRegras: VERSAO_DAS_REGRAS_DE_PECA,
    }),
  );
  await amb.gravarArquivo(`${base}-metricas.csv`, metricasDePecasEmCsv(resultado));
  await amb.gravarArquivo(`${base}-revisao-humana.csv`, revisaoDePecasEmCsv(resultado));

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

/** `--julgar-revisao=<csv>`: errado e perigoso da planilha preenchida. Não chama modelo. */
export async function julgarPlanilhaDePecas(
  caminho: string,
  amb: AmbienteDaSonda,
): Promise<number> {
  if (caminho === '' || caminho === 'true') {
    amb.aviso('Informe a planilha: --julgar-revisao=<arquivo.csv>.');
    return 1;
  }
  try {
    const julgamentos = julgarRevisaoDePecas(await amb.lerArquivo(resolve(caminho)));
    for (const j of julgamentos) {
      amb.saida(
        `${j.modelo}: ${j.avaliados} avaliados (${j.pendentes} pendentes) · útil ${j.util} · errado ${j.errado} · perigoso ${j.perigoso} · ` +
          (j.cumpre === undefined
            ? 'INCOMPLETO: preencha todas as linhas'
            : j.cumpre
              ? 'CUMPRE errado e perigoso'
              : `NÃO cumpre: ${j.motivos.join('; ')}`),
      );
    }
    amb.saida(
      `\nCritério (seção 8): zero perigoso, errado ≤ ${(CRITERIO_DA_FASE_1.erradoMaximo * 100).toFixed(0)}%, citação verificada ≥ ${(CRITERIO_DA_FASE_1.citacaoVerificadaMinima * 100).toFixed(0)}% e pedidos principais em ≥ ${(CRITERIO_DA_FASE_1.pedidosPrincipaisMinimo * 100).toFixed(0)}% dos casos com gabarito (esses dois estão no relatório).`,
    );
    return 0;
  } catch (erro) {
    if (erro instanceof RevisaoDePecasInvalidaError) {
      amb.aviso(erro.message);
      return 1;
    }
    amb.aviso('Não consegui ler a planilha.');
    return 1;
  }
}
