import { isAbsolute, join, relative, resolve } from 'node:path';
import { pareceValorDeExemplo } from '../../infrastructure/config/placeholder.js';
import type { TransporteDeModelo } from '../../infrastructure/adapters/modelo/TransporteGateway.js';
import {
  CsvDeCasosInvalidoError,
  lerCasosCsv,
  lerCasosSinteticos,
  type CasoDaSonda,
} from './casosDaSonda.js';
import {
  calcularJulgamento,
  calcularMetricas,
  escolherVencedor,
  executarSonda,
  fixtureDeRespostas,
  gerarPlanilha,
  nomeSeguroDoModelo,
  PlanilhaDeAvaliacaoInvalidaError,
  tabelaDeMetricas,
  VERSAO_DA_SONDA,
  type MetricasDoGrupo,
  type PrecoPorToken,
  type Variante,
} from './sondaIaAto.js';

/**
 * Comando `scripts/sonda-ia-ato.mjs`. Toda E/S passa pelo `AmbienteDaSonda`, e é
 * por isso que dá para provar em teste que ele não grava nada dentro do
 * repositório com dado de caso real.
 */

export interface AmbienteDaSonda {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Raiz do repositório: nada de caso real nem de saída da sonda cai debaixo dela. */
  readonly raizDoRepositorio: string;
  readonly lerArquivo: (caminho: string) => Promise<string>;
  readonly lerStdin: () => Promise<string>;
  readonly gravarArquivo: (caminho: string, conteudo: string) => Promise<void>;
  readonly existeArquivo: (caminho: string) => Promise<boolean>;
  readonly criarTransporte: (chave: string) => TransporteDeModelo;
  readonly precosDoCatalogo: (
    chave: string,
  ) => Promise<ReadonlyMap<string, PrecoPorToken>>;
  readonly hoje: () => string;
  readonly agora: () => number;
  readonly dormir: (ms: number) => Promise<void>;
  readonly saida: (linha: string) => void;
  readonly aviso: (linha: string) => void;
}

const AJUDA = `Sonda de IA do ato v${VERSAO_DA_SONDA} — não consulta tribunal nem abre o banco.

Rodar a comparação (precisa de AI_GATEWAY_API_KEY no ambiente):
  node scripts/sonda-ia-ato.mjs --modelos=a,b,c                       # só os casos SINTÉTICOS
  node scripts/sonda-ia-ato.mjs --modelos=a,b,c --arquivo=/dados/casos.csv
  cat casos.csv | node scripts/sonda-ia-ato.mjs --modelos=a,b,c --stdin
Julgar a planilha preenchida pelo Autran:
  node scripts/sonda-ia-ato.mjs --avaliacao=/dados/sonda-ia-ato/planilha-AAAA-MM-DD.csv

Opções: --variantes=sem-titulos,com-titulos  --saida=<pasta>  --pausa-ms=<n>
        --com-sinteticos (junto de --arquivo/--stdin)  --fixtures=<pasta>  --ajuda
CSV de casos (separador ";"): id;tipo_comunicacao;classe;texto
  opcionais: titulo;data (dd/mm/aaaa);anteriores (títulos separados por "|");injecao (sim/nao)
O arquivo e a saída ficam FORA do repositório. Nenhum texto de caso real vai para o terminal.`;

function opcoesDe(argv: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const i = a.indexOf('=');
    if (i < 0) m.set(a.slice(2), 'true');
    else m.set(a.slice(2, i), a.slice(i + 1));
  }
  return m;
}

/** Dentro do repositório, salvo `dados/` (já no .gitignore e montado como volume). */
export function caminhoDentroDoRepositorio(caminho: string, raiz: string): boolean {
  const abs = resolve(caminho);
  const rel = relative(resolve(raiz), abs);
  if (rel === '') return true;
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return !(
    rel === 'dados' ||
    rel.startsWith(`dados${'/'}`) ||
    rel.startsWith(`dados${'\\'}`)
  );
}

function lerModelos(valor: string | undefined): string[] {
  return (valor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const VARIANTES_VALIDAS: readonly Variante[] = ['sem-titulos', 'com-titulos'];

export async function executarComandoSondaIa(
  argv: readonly string[],
  amb: AmbienteDaSonda,
): Promise<number> {
  const op = opcoesDe(argv);
  if (op.has('ajuda') || argv.length === 0) {
    amb.saida(AJUDA);
    return argv.length === 0 ? 1 : 0;
  }

  try {
    const pastaPadrao = join(
      amb.env['PROCESSOVIVO_DB_PATH']
        ? resolve(amb.env['PROCESSOVIVO_DB_PATH'], '..')
        : resolve(amb.raizDoRepositorio, 'dados'),
      'sonda-ia-ato',
    );
    const pastaDeSaida = resolve(op.get('saida') ?? pastaPadrao);
    if (caminhoDentroDoRepositorio(pastaDeSaida, amb.raizDoRepositorio)) {
      amb.aviso(
        'A pasta de saída está dentro do repositório. Use uma pasta do volume (--saida=...).',
      );
      return 2;
    }

    // --- julgar a planilha do Autran (não chama modelo, não precisa de chave) ---
    const caminhoDaPlanilha = op.get('avaliacao');
    if (caminhoDaPlanilha) {
      const planilha = await amb.lerArquivo(caminhoDaPlanilha);
      const caminhoDasMetricas = resolve(caminhoDaPlanilha, '..', 'metricas.json');
      let metricas: MetricasDoGrupo[] = [];
      if (await amb.existeArquivo(caminhoDasMetricas)) {
        metricas = JSON.parse(
          await amb.lerArquivo(caminhoDasMetricas),
        ) as MetricasDoGrupo[];
      } else {
        amb.aviso(
          'metricas.json não está ao lado da planilha: o critério de citações fica sem medida.',
        );
      }
      const julgamentos = calcularJulgamento(planilha, metricas);
      for (const j of julgamentos) {
        amb.saida(
          `${j.modelo} · ${j.variante || '—'}: ${j.avaliados} avaliados (${j.pendentes} pendentes) · ` +
            `útil ${j.util} · errado ${j.errado} · perigoso ${j.perigoso} · ` +
            `${j.cumpre ? 'CUMPRE o critério' : `NÃO cumpre: ${j.motivos.join('; ')}`}`,
        );
      }
      const vencedor = escolherVencedor(julgamentos);
      amb.saida(
        vencedor
          ? `\nVence o mais barato que cumpre: ${vencedor.modelo} · ${vencedor.variante || '—'}.`
          : '\nNenhum modelo cumpre o critério (ou falta custo medido): voltar ao desenho.',
      );
      return 0;
    }

    // --- chave: recusa antes de qualquer coisa ---
    const chave = amb.env['AI_GATEWAY_API_KEY']?.trim();
    if (!chave) {
      amb.aviso(
        'AI_GATEWAY_API_KEY não está definida. A sonda não roda sem a chave do gateway.',
      );
      return 2;
    }
    if (pareceValorDeExemplo(chave)) {
      amb.aviso(
        'AI_GATEWAY_API_KEY parece um valor de exemplo que ninguém substituiu. Recusado.',
      );
      return 2;
    }

    const modelos = lerModelos(op.get('modelos'));
    if (modelos.length === 0) {
      amb.aviso(
        'Informe os modelos: --modelos=a,b,c (nomes do catálogo do gateway; nada fica fixo no código).',
      );
      return 1;
    }
    const variantes = (op.get('variantes') ?? VARIANTES_VALIDAS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const invalida = variantes.find(
      (v) => !(VARIANTES_VALIDAS as readonly string[]).includes(v),
    );
    if (invalida) {
      amb.aviso(`Variante desconhecida: ${invalida}. Use sem-titulos e/ou com-titulos.`);
      return 1;
    }

    // --- casos ---
    if (op.has('arquivo') && op.has('stdin')) {
      amb.aviso('Use --arquivo OU --stdin, não os dois.');
      return 1;
    }
    let casos: CasoDaSonda[] = [];
    const reais = op.has('arquivo') || op.has('stdin');
    if (op.has('arquivo')) {
      const caminho = resolve(op.get('arquivo') ?? '');
      if (caminhoDentroDoRepositorio(caminho, amb.raizDoRepositorio)) {
        amb.aviso(
          'O CSV de casos reais não pode ficar dentro do repositório. Coloque-o no volume.',
        );
        return 2;
      }
      casos = lerCasosCsv(await amb.lerArquivo(caminho));
    } else if (op.has('stdin')) {
      casos = lerCasosCsv(await amb.lerStdin());
    }
    const fixtures = resolve(
      op.get('fixtures') ?? join(amb.raizDoRepositorio, 'tests/fixtures/ia-ato'),
    );
    if (!reais || op.has('com-sinteticos')) {
      const sinteticos = lerCasosSinteticos(
        await amb.lerArquivo(join(fixtures, 'casos-sinteticos.json')),
      );
      casos = [...casos, ...sinteticos];
    }
    if (casos.length === 0) {
      amb.aviso('Nenhum caso para rodar.');
      return 1;
    }
    amb.aviso(
      `Sonda ${VERSAO_DA_SONDA}: ${casos.length} casos (${casos.filter((c) => c.origem === 'real').length} reais), ` +
        `${modelos.length} modelos, ${variantes.length} variantes. ZDR em toda chamada.`,
    );

    let precos: ReadonlyMap<string, PrecoPorToken> = new Map();
    let fontePrecos = 'preço informado pelo gateway na resposta, quando houve';
    try {
      precos = await amb.precosDoCatalogo(chave);
      fontePrecos = 'tabela de preços do catálogo do gateway';
    } catch {
      amb.aviso(
        'Não consegui ler a tabela de preços do catálogo; o custo só aparece se o gateway o informar.',
      );
    }

    const pausa = Number(op.get('pausa-ms') ?? '0');
    const resultado = await executarSonda({
      casos,
      modelos,
      variantes: variantes as Variante[],
      transporte: amb.criarTransporte(chave),
      agora: amb.agora,
      dormir: amb.dormir,
      ...(Number.isFinite(pausa) && pausa > 0 ? { pausaMs: pausa } : {}),
      progresso: (l) => amb.aviso(l),
    });

    for (const m of resultado.modelosSemZdr) {
      amb.aviso(
        `SEM ZDR: nenhum provedor com retenção zero para "${m}". Modelo fora da comparação; nenhuma chamada sem ZDR foi feita.`,
      );
    }
    for (const f of resultado.modelosComFalha) {
      amb.aviso(`Modelo "${f.modelo}" abandonado após falhas seguidas: ${f.motivo}`);
    }
    if (resultado.modelosSemZdr.length === modelos.length) {
      amb.aviso(
        'NENHUM dos modelos tem provedor com ZDR. A sonda para aqui; avise o responsável.',
      );
      return 3;
    }

    const metricas = calcularMetricas(resultado.registros, precos);
    amb.saida(tabelaDeMetricas(metricas, { fonte: fontePrecos, data: amb.hoje() }));
    for (const m of metricas) {
      if (m.provedores.length > 0)
        amb.saida(
          `Provedores que atenderam ${m.modelo} · ${m.variante}: ${m.provedores.join(', ')}`,
        );
    }

    const data = amb.hoje();
    await amb.gravarArquivo(
      join(pastaDeSaida, 'metricas.json'),
      JSON.stringify(metricas, null, 2) + '\n',
    );
    const planilha = join(pastaDeSaida, `planilha-${data}.csv`);
    await amb.gravarArquivo(planilha, gerarPlanilha(resultado.registros));
    amb.aviso(
      `Planilha para o Autran: ${planilha} (preencher a coluna "avaliacao" com util, errado ou perigoso).`,
    );

    // Só resposta de caso SINTÉTICO vira fixture; `fixtureDeRespostas` já filtra por origem.
    for (const modelo of modelos) {
      const conteudo = fixtureDeRespostas(resultado.registros, modelo, data);
      if (conteudo) {
        const arquivo = join(
          fixtures,
          `respostas-${nomeSeguroDoModelo(modelo)}-${data}.json`,
        );
        await amb.gravarArquivo(arquivo, conteudo);
        amb.aviso(`Fixture gravada: ${arquivo}`);
      }
    }
    return 0;
  } catch (erro) {
    if (
      erro instanceof CsvDeCasosInvalidoError ||
      erro instanceof PlanilhaDeAvaliacaoInvalidaError
    ) {
      amb.aviso(`Entrada inválida: ${erro.message}`);
      return 1;
    }
    // Mensagem genérica: o erro de baixo pode carregar trecho de texto de ato.
    amb.aviso('Falha inesperada na sonda (detalhes omitidos de propósito).');
    return 4;
  }
}
