import { chaveDaMovimentacao } from './Acompanhamento.js';
import type { Movimentacao } from './Movimentacao.js';
import { Processo } from './Processo.js';

/**
 * Funde o retrato de um mesmo processo vindo de duas fontes.
 *
 * É o coração da tese híbrida do Processo Vivo, e existe porque nenhuma fonte
 * brasileira sozinha entrega um processo inteiro:
 *
 *   DataJud  → metadados (classe, assunto, distribuição) e a linha do tempo
 *              CODIFICADA, com hora cheia, incluindo atos internos de cartório.
 *              Não tem partes. Não tem inteiro teor.
 *   DJEN     → partes, advogados com OAB, e o INTEIRO TEOR do que foi publicado
 *              no diário. Só o que foi publicado, e só com a data (sem hora).
 *
 * Juntas elas descrevem o processo; separadas, cada uma mente por omissão.
 *
 * Regra de precedência: `base` é a fonte preferida (a primeira da cadeia que
 * respondeu) e vence em todo campo escalar que tenha preenchido. O complemento
 * só preenche buraco — nunca sobrescreve. Isso mantém a ordem dos providers
 * significando "ordem de confiança", que é como ela é documentada.
 */
export function fundirProcessos(base: Processo, complemento: Processo): Processo {
  if (base.numero.digitos !== complemento.numero.digitos) {
    throw new Error(
      `fundirProcessos recebeu processos diferentes: ${base.numero.formatado} ≠ ${complemento.numero.formatado}`,
    );
  }

  const fontes = [base.procedencia.provider, complemento.procedencia.provider];

  return new Processo({
    numero: base.numero,
    tribunal: base.tribunal || complemento.tribunal,
    assuntos: base.assuntos.length > 0 ? base.assuntos : complemento.assuntos,
    // Partes NÃO se misturam. Cada fonte nomeia a mesma pessoa de um jeito
    // ("MARIA DE FATIMA LEITE" x "Maria de Fátima Leite"), e unir por nome
    // criaria duas partes onde existe uma. Vale a lista de quem tiver alguma.
    partes: base.partes.length > 0 ? base.partes : complemento.partes,
    movimentacoes: fundirMovimentacoes(
      carimbar(base.movimentacoes, base.procedencia.provider),
      carimbar(complemento.movimentacoes, complemento.procedencia.provider),
    ),
    // Basta uma fonte apontar segredo de justiça para o processo ser tratado
    // como sigiloso. Errar para o lado restritivo aqui é a única opção aceitável.
    segredoJustica: base.segredoJustica || complemento.segredoJustica,
    procedencia: {
      provider: fontes.join('+'),
      // A consulta mais ANTIGA define o frescor do conjunto: dizer que o dado é
      // das 14h quando metade dele é das 9h faz o advogado confiar demais.
      consultadoEm: new Date(
        Math.min(
          base.procedencia.consultadoEm.getTime(),
          complemento.procedencia.consultadoEm.getTime(),
        ),
      ),
      deCache: base.procedencia.deCache || complemento.procedencia.deCache,
    },
    ...preferir('vara', base.vara, complemento.vara),
    ...preferir('classe', base.classe, complemento.classe),
    ...preferir('assunto', base.assunto, complemento.assunto),
    ...preferir('dataDistribuicao', base.dataDistribuicao, complemento.dataDistribuicao),
    ...preferir('grau', base.grau, complemento.grau),
    ...preferir('valorCausa', base.valorCausa, complemento.valorCausa),
  });
}

function preferir<C extends string, T>(
  campo: C,
  daBase: T | undefined,
  doComplemento: T | undefined,
): Record<C, T> | Record<string, never> {
  const valor = daBase ?? doComplemento;
  return valor === undefined ? {} : ({ [campo]: valor } as Record<C, T>);
}

function carimbar(
  movimentacoes: readonly Movimentacao[],
  fonte: string,
): Movimentacao[] {
  return movimentacoes.map((m) => (m.fonte ? m : { ...m, fonte }));
}

/**
 * União das duas linhas do tempo, sem duplicar o que é o mesmo registro.
 *
 * O que NÃO se tenta fazer aqui, de propósito: casar o andamento do DataJud com
 * a publicação do DJEN que se refere ao mesmo ato. Eles têm títulos de
 * vocabulários diferentes (TPU x tipo de documento) e precisões de hora
 * diferentes; qualquer heurística de casamento erraria, e errar aqui significa
 * SUMIR com um andamento. Duas linhas próximas descrevendo o mesmo ato é um
 * incômodo visual; uma linha ausente é prazo perdido.
 */
function fundirMovimentacoes(
  daBase: readonly Movimentacao[],
  doComplemento: readonly Movimentacao[],
): Movimentacao[] {
  const porChave = new Map<string, Movimentacao>();
  for (const m of [...daBase, ...doComplemento]) {
    const chave = chaveDaMovimentacao(m);
    const existente = porChave.get(chave);
    if (!existente) {
      porChave.set(chave, m);
      continue;
    }
    // Mesmo registro visto por duas fontes: fica o mais informativo.
    if (!existente.conteudo && m.conteudo) porChave.set(chave, m);
  }
  return [...porChave.values()];
}
