import { NumeroCNJ } from '../../../domain/entities/NumeroCNJ.js';
import type { Movimentacao } from '../../../domain/entities/Movimentacao.js';
import { Processo } from '../../../domain/entities/Processo.js';
import { RespostaInvalidaError } from '../../../domain/errors/index.js';
import type { MovimentoDataJud, ProcessoDataJud } from './datajud.types.js';

const NOME_PROVIDER = 'datajud';

/**
 * Anticorrupção: traduz o payload do CNJ para o modelo do domínio.
 *
 * Todo o vocabulário do DataJud (`orgaoJulgador`, `dataAjuizamento`,
 * `movimentos`, `complementosTabelados`) morre neste arquivo. É o único ponto
 * do sistema que precisa mudar quando o CNJ mexer no formato.
 */
export function mapearProcesso(
  origem: ProcessoDataJud,
  consultadoEm: Date,
): Processo {
  const numero = NumeroCNJ.tentarCriar(origem.numeroProcesso);
  if (!numero) {
    throw new RespostaInvalidaError(
      NOME_PROVIDER,
      `número de processo inválido no payload: "${origem.numeroProcesso}"`,
    );
  }

  const assuntos = (origem.assuntos ?? [])
    .map((a) => a.nome)
    .filter((nome): nome is string => typeof nome === 'string' && nome.length > 0);

  const dataDistribuicao = parseData(origem.dataAjuizamento, 'dataAjuizamento');

  return new Processo({
    numero,
    tribunal: origem.tribunal ?? numero.siglaTribunal ?? 'DESCONHECIDO',
    ...(origem.orgaoJulgador?.nome ? { vara: origem.orgaoJulgador.nome } : {}),
    ...(origem.classe?.nome ? { classe: origem.classe.nome } : {}),
    ...(assuntos.length > 0 ? { assuntos } : {}),
    ...(dataDistribuicao ? { dataDistribuicao } : {}),
    ...(origem.grau ? { grau: origem.grau } : {}),
    segredoJustica: (origem.nivelSigilo ?? 0) > 0,
    // O DataJud é base de METADADOS: não indexa partes nem advogados.
    // Deixar vazio é o retrato fiel da fonte — e é o sinal que o orquestrador
    // usa para decidir se vale enriquecer com um crawler.
    partes: [],
    movimentacoes: (origem.movimentos ?? [])
      .map(mapearMovimento)
      .filter((m): m is Movimentacao => m !== null),
    procedencia: { provider: NOME_PROVIDER, consultadoEm, deCache: false },
  });
}

function mapearMovimento(origem: MovimentoDataJud): Movimentacao | null {
  // Movimento sem data ou sem título é descartado — mas movimento com data em
  // formato ESTRANHO faz `parseData` lançar, de propósito: sumir com uma
  // movimentação em silêncio é como se perde um prazo.
  const data = parseData(origem.dataHora, 'movimentos[].dataHora');
  if (!data) return null;

  const titulo = origem.nome?.trim();
  if (!titulo) return null;

  const complementos = (origem.complementosTabelados ?? [])
    .map((c) => {
      const rotulo = c.nome ?? c.descricao;
      return rotulo ? rotulo.trim() : null;
    })
    .filter((c): c is string => c !== null && c.length > 0);

  return {
    data,
    titulo,
    // Sem `conteudo`: a API pública devolve o rótulo do movimento na TPU,
    // nunca o inteiro teor do despacho. Quem precisa da íntegra depende do
    // crawler do tribunal.
    ...(origem.codigo !== undefined ? { codigoTpu: origem.codigo } : {}),
    ...(complementos.length > 0 ? { complementos } : {}),
  };
}

/** `yyyyMMddHHmmss` — 14 dígitos, sem separador nenhum. */
const COMPACTO = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/** Horário oficial de Brasília, que é como o CNJ carimba o formato compacto. */
const FUSO_BRASILIA = '-03:00';

/**
 * O DataJud usa DOIS formatos de data no MESMO documento:
 *
 *   dataAjuizamento         "20150826000000"            ← yyyyMMddHHmmss
 *   movimentos[].dataHora   "2015-08-26T00:00:00.000Z"  ← ISO 8601
 *
 * Descobri isso ao rodar este mapper contra uma resposta real. A versão
 * anterior fazia `new Date(valor)` para os dois: o compacto virava
 * `Invalid Date`, o `Invalid Date` virava `undefined`, e o processo era
 * mapeado "com sucesso" — sem data de distribuição, sem ninguém notar.
 *
 * @throws {RespostaInvalidaError} quando há valor e ele não casa com nenhum
 * formato conhecido. Falhar alto é DELIBERADO: num produto onde a data decide
 * prazo, entregar o campo vazio é pior do que recusar a resposta — o
 * orquestrador ainda pode tentar outra fonte, mas ninguém consegue reagir a um
 * campo que sumiu em silêncio.
 */
function parseData(valor: string | undefined, campo: string): Date | undefined {
  if (valor === undefined || valor === '') return undefined;

  const compacto = COMPACTO.exec(valor);
  if (compacto) {
    const [, ano, mes, dia, hora, minuto, segundo] = compacto;
    // O formato compacto não declara fuso, e o CNJ publica em horário de
    // Brasília (UTC−03:00). Interpretar como UTC parece inofensivo e NÃO É:
    // "20150826000000" viraria 26/08 00:00Z, que exibido em São Paulo é
    // 25/08 21:00 — a data de distribuição aparece um dia antes na tela.
    // Aconteceu de verdade, na primeira consulta real.
    //
    // Brasil não tem horário de verão desde 2019, e mesmo nos anos em que
    // tinha, a diferença de uma hora não muda o dia de um carimbo à meia-noite.
    const data = new Date(
      `${ano}-${mes}-${dia}T${hora}:${minuto}:${segundo}${FUSO_BRASILIA}`,
    );
    if (!Number.isNaN(data.getTime())) return data;
  } else {
    const data = new Date(valor);
    if (!Number.isNaN(data.getTime())) return data;
  }

  throw new RespostaInvalidaError(
    NOME_PROVIDER,
    `campo "${campo}" veio em formato de data desconhecido: "${valor}"`,
  );
}
