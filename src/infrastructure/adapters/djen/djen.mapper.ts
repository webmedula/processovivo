import { NumeroCNJ } from '../../../domain/entities/NumeroCNJ.js';
import type { Movimentacao } from '../../../domain/entities/Movimentacao.js';
import type { Advogado, Parte, PoloProcessual } from '../../../domain/entities/Parte.js';
import { Processo } from '../../../domain/entities/Processo.js';
import { RespostaInvalidaError } from '../../../domain/errors/index.js';
import type { ComunicacaoDjen } from './djen.types.js';
import { limparTextoDoAto, primeiraLinhaSignificativa } from './textoHtml.js';

export const NOME_DJEN = 'djen';

/**
 * Camada anticorrupção do DJEN.
 *
 * A inversão que este arquivo resolve: o DJEN não é uma base de PROCESSOS, é
 * uma base de COMUNICAÇÕES. Uma consulta por OAB devolve 1.871 publicações
 * soltas que, juntas, falam de algumas centenas de processos. Quem chama a
 * porta `ProcessoProvider` espera processos. Agrupar é trabalho da borda.
 */

const FUSO_BRASILIA = '-03:00';
const SOMENTE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * O DJEN informa o dia da disponibilização, sem hora.
 *
 * Fixar meia-noite de Brasília em vez de deixar o `Date` interpretar como UTC
 * repete uma correção que este projeto já pagou uma vez: `new Date('2026-09-04')`
 * é meia-noite UTC, que exibida em Brasília vira **03/09 às 21h**. Uma
 * publicação inteira aparecendo no dia anterior desloca a contagem de prazo do
 * advogado — o pior erro que este sistema pode cometer.
 */
export function parseDataDisponibilizacao(valor: string, contexto: string): Date {
  const casamento = SOMENTE_DATA.exec(valor);
  if (casamento) {
    const [, ano, mes, dia] = casamento;
    const data = new Date(`${ano}-${mes}-${dia}T00:00:00${FUSO_BRASILIA}`);
    if (!Number.isNaN(data.getTime())) return data;
  } else {
    const data = new Date(valor);
    if (!Number.isNaN(data.getTime())) return data;
  }
  throw new RespostaInvalidaError(
    NOME_DJEN,
    `data_disponibilizacao em formato desconhecido: "${valor}" (${contexto})`,
  );
}

/**
 * Polo do destinatário. O DJEN usa "A"/"P"; alguns tribunais mandam o nome por
 * extenso. Tudo que não for reconhecido vira OUTROS — nunca um chute entre
 * ativo e passivo, porque trocar os polos inverte quem processa quem.
 */
export function mapearPolo(polo: string | null | undefined): PoloProcessual {
  const normalizado = (polo ?? '').trim().toUpperCase();
  if (normalizado === 'A' || normalizado.startsWith('ATIV')) return 'ATIVO';
  if (normalizado === 'P' || normalizado.startsWith('PASSIV')) return 'PASSIVO';
  return 'OUTROS';
}

function mapearAdvogados(comunicacao: ComunicacaoDjen): Advogado[] {
  const vistos = new Map<string, Advogado>();
  for (const entrada of comunicacao.destinatarioadvogados ?? []) {
    const { nome, numero_oab, uf_oab } = entrada.advogado;
    const oab = numero_oab?.trim();
    const uf = uf_oab?.trim().toUpperCase();
    const chave = `${oab ?? ''}/${uf ?? ''}|${nome}`;
    if (vistos.has(chave)) continue;
    vistos.set(chave, {
      nome,
      ...(oab ? { oab } : {}),
      ...(uf ? { ufOab: uf } : {}),
    });
  }
  return [...vistos.values()];
}

/**
 * Sentinelas que o DJEN devolve NO LUGAR do inteiro teor quando o documento não
 * é público.
 *
 * Não é conteúdo — é um aviso. E é muito comum: no processo
 * 0311517-22.2015.8.09.0051, 43 das 62 publicações (69%) trazem exatamente
 * "ARQUIVOS DIGITAIS INDISPONÍVEIS (NÃO SÃO DO TIPO PÚBLICO)" e nada mais.
 *
 * Guardar isso como despacho faria a tela exibir 43 andamentos com um "inteiro
 * teor" que só diz que não há inteiro teor. É a mesma regra que já está no
 * CLAUDE.md — nunca escreva placeholder no lugar de um valor — só que aqui quem
 * emite o placeholder é a fonte, e cabe à borda não repassar.
 */
const TEOR_NAO_PUBLICO = [
  /arquivos?\s+digitais?\s+indispon[íi]ve/i,
  /n[ãa]o\s+s[ãa]o\s+do\s+tipo\s+p[úu]blico/i,
  /documento\s+n[ãa]o\s+dispon[íi]vel/i,
];

/**
 * Um teor real curto existe ("Ciência da decisão."), então o corte não pode ser
 * por tamanho. O que identifica o sentinela é o TEXTO, e só ele.
 */
export function ehTeorNaoPublico(texto: string): boolean {
  return TEOR_NAO_PUBLICO.some((r) => r.test(texto));
}

/**
 * Converte uma comunicação em andamento.
 *
 * `titulo` cai em cascata — tipoDocumento ("Decisão"), depois tipoComunicacao
 * ("Intimação"), depois a primeira linha do próprio ato. A última opção é feia,
 * mas uma lista com "—" em cada linha não é uma lista.
 */
export function mapearMovimentacao(comunicacao: ComunicacaoDjen): Movimentacao {
  const bruto = comunicacao.texto ? limparTextoDoAto(comunicacao.texto) : '';
  const naoPublico = bruto.length > 0 && ehTeorNaoPublico(bruto);
  const texto = naoPublico ? '' : bruto;

  const titulo =
    comunicacao.tipoDocumento?.trim() ||
    comunicacao.tipoComunicacao?.trim() ||
    (texto ? primeiraLinhaSignificativa(texto) : '') ||
    'Publicação';

  return {
    data: parseDataDisponibilizacao(
      comunicacao.data_disponibilizacao,
      `comunicação ${comunicacao.id}`,
    ),
    titulo,
    idExterno: `${NOME_DJEN}:${comunicacao.id}`,
    ...(texto ? { conteudo: texto } : {}),
    ...(naoPublico ? { teorIndisponivel: true } : {}),
    ...(comunicacao.link ? { url: comunicacao.link } : {}),
  };
}

/**
 * Uma comunicação cancelada continua no índice, com `status` diferente de "P"
 * e o motivo preenchido. Mostrá-la como andamento válido faria o advogado
 * contar prazo a partir de um ato que o tribunal tornou sem efeito.
 */
export function estaVigente(comunicacao: ComunicacaoDjen): boolean {
  if (comunicacao.ativo === false) return false;
  if (comunicacao.motivo_cancelamento) return false;
  const status = comunicacao.status?.trim().toUpperCase();
  return status === undefined || status === '' || status === 'P';
}

export interface ResultadoAgrupamento {
  readonly processos: Processo[];
  /**
   * Comunicações que não viraram processo. Contadas, não engolidas: um salto
   * aqui é o sinal de que o DJEN mudou o formato de algum campo.
   */
  readonly descartadas: readonly { readonly numero: string; readonly motivo: string }[];
}

/**
 * Agrupa comunicações em processos.
 *
 * Decisão deliberada: um registro com número CNJ inválido é DESCARTADO com
 * registro, não faz a consulta inteira falhar. É o oposto da regra que vale
 * para `buscarPorNumero` — e a diferença é a consequência. Numa consulta por
 * número, engolir o erro devolveria "processo não encontrado" para um processo
 * que existe. Numa busca por OAB, derrubar tudo por causa de 1 registro entre
 * 1.871 esconderia os outros 1.870 do advogado. O chamador decide o que fazer
 * com `descartadas`; o adapter loga.
 *
 * @param consultadoEm momento da consulta, para a procedência
 */
export function agruparEmProcessos(
  comunicacoes: readonly ComunicacaoDjen[],
  consultadoEm: Date,
): ResultadoAgrupamento {
  const porProcesso = new Map<string, ComunicacaoDjen[]>();
  const descartadas: { numero: string; motivo: string }[] = [];

  for (const c of comunicacoes) {
    if (!estaVigente(c)) continue;
    const bruto = c.numeroprocessocommascara?.trim() || c.numero_processo;
    let chave: string;
    try {
      chave = NumeroCNJ.criar(bruto).digitos;
    } catch (erro) {
      descartadas.push({
        numero: bruto,
        motivo: erro instanceof Error ? erro.message : String(erro),
      });
      continue;
    }
    const lista = porProcesso.get(chave);
    if (lista) lista.push(c);
    else porProcesso.set(chave, [c]);
  }

  const processos: Processo[] = [];
  for (const [digitos, lista] of porProcesso) {
    const processo = montarProcesso(digitos, lista, consultadoEm);
    if (processo) processos.push(processo);
  }

  // Mais recente primeiro: é a ordem em que o advogado quer ver a carteira.
  processos.sort(
    (a, b) =>
      (b.ultimaMovimentacao?.data.getTime() ?? 0) -
      (a.ultimaMovimentacao?.data.getTime() ?? 0),
  );

  return { processos, descartadas };
}

/**
 * Monta um `Processo` a partir das comunicações de um mesmo número.
 *
 * Para os campos de cabeçalho (vara, classe, tribunal) vale a comunicação MAIS
 * RECENTE que preencheu o campo: processo que muda de vara deve aparecer na
 * vara atual, não na primeira que publicou algo.
 */
function montarProcesso(
  digitos: string,
  comunicacoes: readonly ComunicacaoDjen[],
  consultadoEm: Date,
): Processo | undefined {
  const ordenadas = [...comunicacoes].sort(
    (a, b) => b.data_disponibilizacao.localeCompare(a.data_disponibilizacao) || b.id - a.id,
  );
  const maisRecente = ordenadas[0];
  if (!maisRecente) return undefined;

  const primeiroPreenchido = (
    escolher: (c: ComunicacaoDjen) => string | null | undefined,
  ): string | undefined => {
    for (const c of ordenadas) {
      const valor = escolher(c)?.trim();
      if (valor) return valor;
    }
    return undefined;
  };

  const vara = primeiroPreenchido((c) => c.nomeOrgao);
  const classe = primeiroPreenchido((c) => c.nomeClasse);

  return new Processo({
    numero: NumeroCNJ.criar(digitos),
    tribunal: maisRecente.siglaTribunal.trim().toUpperCase(),
    ...(vara ? { vara } : {}),
    ...(classe ? { classe } : {}),
    partes: consolidarPartes(ordenadas),
    movimentacoes: ordenadas.map(mapearMovimentacao),
    procedencia: { provider: NOME_DJEN, consultadoEm, deCache: false },
  });
}

/**
 * Junta os destinatários de todas as comunicações do processo numa lista de
 * partes sem repetição.
 *
 * Limite honesto da fonte, registrado aqui porque não dá para deduzir do
 * resultado: o DJEN traz `destinatarios` e `destinatarioadvogados` como duas
 * listas IRMÃS na comunicação, sem ligação entre elas. Quando a intimação tem
 * um destinatário só — o caso comum — a associação é inequívoca e é a que
 * fazemos. Quando tem vários, atribuir advogado a parte específica seria
 * invenção; nesse caso os advogados vão para todas as partes daquela
 * comunicação, e é por isso que a interface mostra "advogados no ato", não
 * "advogado da parte".
 */
function consolidarPartes(comunicacoes: readonly ComunicacaoDjen[]): Parte[] {
  const porNome = new Map<string, { parte: Parte; advogados: Map<string, Advogado> }>();

  for (const c of comunicacoes) {
    const advogados = mapearAdvogados(c);
    for (const destinatario of c.destinatarios ?? []) {
      const nome = destinatario.nome.trim();
      if (!nome) continue;
      const chave = nome.toUpperCase();
      const existente = porNome.get(chave);
      if (existente) {
        for (const a of advogados) {
          existente.advogados.set(`${a.oab ?? ''}/${a.ufOab ?? ''}|${a.nome}`, a);
        }
        continue;
      }
      porNome.set(chave, {
        parte: {
          nome,
          polo: mapearPolo(destinatario.polo),
          // O DJEN não informa se a parte é pessoa física ou jurídica, e
          // adivinhar por sufixo ("LTDA") erra com escritório, condomínio e
          // espólio. DESCONHECIDO é a resposta correta.
          tipoPessoa: 'DESCONHECIDO',
          advogados: [],
        },
        advogados: new Map(
          advogados.map((a) => [`${a.oab ?? ''}/${a.ufOab ?? ''}|${a.nome}`, a]),
        ),
      });
    }
  }

  return [...porNome.values()].map(({ parte, advogados }) => ({
    ...parte,
    advogados: [...advogados.values()],
  }));
}
