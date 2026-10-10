import { isAbsolute, join, relative, resolve } from 'node:path';
import { prepararEntrada } from '../../application/politicas/entradaDoModelo.js';
import { ZdrIndisponivelError } from '../../domain/errors/index.js';
import {
  ehApelidoOuVariante,
  modeloTemZdr,
  modelosComZdr,
  parConfirmadoZdr,
  precosEstimados,
  provedoresPermitidos,
  slugDoProvedor,
  type EndpointPublico,
  type ListaZdrLida,
  type ModeloPublico,
} from '../../infrastructure/adapters/modelo/endpointsZdr.js';
import type {
  DetalheDeErro,
  TransporteDeModelo,
} from '../../infrastructure/adapters/modelo/TransporteOpenRouter.js';
import { pareceValorDeExemplo } from '../../infrastructure/config/placeholder.js';
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
  metadadosDasChamadas,
  nomeSeguroDoModelo,
  PlanilhaDeAvaliacaoInvalidaError,
  tabelaDeMetricas,
  VERSAO_DA_SONDA,
  type MetricasDoGrupo,
  type Variante,
} from './sondaIaAto.js';

/**
 * Comando `scripts/sonda-ia-ato.mjs`. Toda E/S passa pelo `AmbienteDaSonda`, e é
 * por isso que dá para provar em teste que ele não grava nada dentro do
 * repositório com dado de caso real e que a chave nunca aparece na saída.
 */

export interface AmbienteDaSonda {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Raiz do repositório: nada de caso real nem de saída da sonda cai debaixo dela. */
  readonly raizDoRepositorio: string;
  readonly lerArquivo: (caminho: string) => Promise<string>;
  readonly lerStdin: () => Promise<string>;
  readonly gravarArquivo: (caminho: string, conteudo: string) => Promise<void>;
  readonly existeArquivo: (caminho: string) => Promise<boolean>;
  readonly criarTransporte: (
    chave: string,
    opcoes?: { readonly aoFalhar?: (d: DetalheDeErro) => void },
  ) => TransporteDeModelo;
  /** Lista pública de endpoints com ZDR (precisa da chave; não leva texto de caso). */
  readonly buscarEndpointsZdr: (chave: string) => Promise<ListaZdrLida>;
  /** Lista pública de modelos (sem chave). Só o teste de falha fechada usa. */
  readonly buscarModelosPublicos: () => Promise<readonly ModeloPublico[]>;
  /** Endpoints públicos de UM modelo (detalhe do modelo; não envia texto). Só o controle negativo usa. */
  readonly buscarEndpointsPublicosDoModelo: (
    modelo: string,
  ) => Promise<readonly EndpointPublico[]>;
  readonly hoje: () => string;
  readonly agora: () => number;
  readonly dormir: (ms: number) => Promise<void>;
  readonly saida: (linha: string) => void;
  readonly aviso: (linha: string) => void;
}

const AJUDA = `Sonda de IA do ato v${VERSAO_DA_SONDA} (OpenRouter, ZDR em toda chamada) — não consulta tribunal nem abre o banco.
Precisa de OPENROUTER_API_KEY no ambiente (nunca é impressa).

1. Ver quais modelos têm endpoint ZDR (não envia texto de caso):
  node scripts/sonda-ia-ato.mjs --listar-modelos-zdr
  node scripts/sonda-ia-ato.mjs --listar-modelos-zdr=claude
2. Rodar a comparação (recusa modelo que não esteja na lista ZDR):
  node scripts/sonda-ia-ato.mjs --modelos=a,b,c                       # só os casos SINTÉTICOS
  node scripts/sonda-ia-ato.mjs --modelos=a,b,c --arquivo=/dados/casos.csv
  cat casos.csv | node scripts/sonda-ia-ato.mjs --modelos=a,b,c --stdin
3. Julgar a planilha preenchida pelo Autran:
  node scripts/sonda-ia-ato.mjs --avaliacao=/dados/sonda-ia-ato/planilha-AAAA-MM-DD.csv
4. Controles (UMA chamada cada, texto SINTÉTICO):
  node scripts/sonda-ia-ato.mjs --controle-positivo[=<modelo COM ZDR>]   # deve responder, e o par (modelo, provedor) estar na lista
  node scripts/sonda-ia-ato.mjs --controle-negativo[=<modelo SEM ZDR>]   # deve ser recusado; se responder, é BLOQUEANTE
Nomes com "~" (apelidos) e com ":" (variantes) são recusados em todos os comandos.

Opções: --variantes=sem-titulos,com-titulos  --saida=<pasta>  --pausa-ms=<n>
        --com-sinteticos (junto de --arquivo/--stdin)  --fixtures=<pasta>  --fixtures-saida=<pasta>  --ajuda
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

/** Tira a chave de qualquer texto que vá ao terminal (defesa extra; ela nunca é posta lá). */
function semChave(texto: string, chave: string): string {
  return chave === '' ? texto : texto.split(chave).join('[chave]');
}

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

    // --- chave: recusa antes de qualquer rede ---
    const chave = amb.env['OPENROUTER_API_KEY']?.trim();
    if (!chave) {
      amb.aviso(
        'OPENROUTER_API_KEY não está definida. A sonda não roda sem a chave do OpenRouter.',
      );
      return 2;
    }
    if (pareceValorDeExemplo(chave)) {
      amb.aviso(
        'OPENROUTER_API_KEY parece um valor de exemplo que ninguém substituiu. Recusado.',
      );
      return 2;
    }

    // --- lista de endpoints ZDR: obrigatória para qualquer coisa daqui em diante ---
    let lista: ListaZdrLida;
    try {
      lista = await amb.buscarEndpointsZdr(chave);
    } catch (erro) {
      amb.aviso(
        `Não consegui obter a lista de endpoints com ZDR (${semChave(erro instanceof Error ? erro.message : 'erro', chave)}). ` +
          'Sem ela a ZDR não pode ser confirmada, então nada foi enviado.',
      );
      return 2;
    }

    // --- só listar ---
    if (op.has('listar-modelos-zdr')) {
      const filtro = op.get('listar-modelos-zdr');
      const ids = modelosComZdr(
        lista.endpoints,
        filtro === 'true' ? undefined : filtro,
      ).filter((id) => !ehApelidoOuVariante(id));
      if (lista.itensRecebidos > 0 && lista.endpoints.length === 0) {
        amb.aviso(
          'A lista veio, mas nenhum item trouxe os campos esperados (model_id e provider_name/tag). ' +
            `Campos do primeiro item: ${lista.camposDoPrimeiroItem.join(', ')}. Relate este aviso; nada foi enviado.`,
        );
        return 2;
      }
      for (const id of ids) amb.saida(id);
      amb.aviso(
        `${ids.length} modelos com ao menos um endpoint ZDR` +
          (filtro && filtro !== 'true' ? ` (filtro "${filtro}")` : '') +
          ` · ${lista.endpoints.length} endpoints no total · consultado em ${amb.hoje()}.`,
      );
      return 0;
    }

    // --- controles: UMA chamada cada, texto sintético ---
    if (op.has('controle-positivo')) {
      return await controlePositivo(
        op.get('controle-positivo') ?? 'true',
        chave,
        lista,
        amb,
      );
    }
    if (op.has('controle-negativo')) {
      return await controleNegativo(
        op.get('controle-negativo') ?? 'true',
        chave,
        lista,
        amb,
      );
    }

    const modelos = lerModelos(op.get('modelos'));
    if (modelos.length === 0) {
      amb.aviso(
        'Informe os modelos: --modelos=a,b,c (use --listar-modelos-zdr para ver os nomes).',
      );
      return 1;
    }
    const apelidos = modelos.filter(ehApelidoOuVariante);
    if (apelidos.length > 0) {
      for (const m of apelidos) {
        amb.aviso(
          `Modelo recusado: "${m}" é um apelido (~) ou uma variante (:), não um modelo. Use o id real de --listar-modelos-zdr.`,
        );
      }
      amb.aviso('Nada foi enviado.');
      return 2;
    }
    const foraDaLista = modelos.filter((m) => !modeloTemZdr(lista.endpoints, m));
    if (foraDaLista.length > 0) {
      for (const m of foraDaLista) {
        amb.aviso(
          `Modelo recusado: "${m}" não tem nenhum endpoint com ZDR na lista do OpenRouter.`,
        );
      }
      amb.aviso(
        'Nada foi enviado. Use --listar-modelos-zdr para ver os nomes que servem.',
      );
      return 2;
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

    const pausa = Number(op.get('pausa-ms') ?? '0');
    const resultado = await executarSonda({
      casos,
      modelos,
      variantes: variantes as Variante[],
      transporte: amb.criarTransporte(chave),
      provedoresPermitidos: (modelo) => provedoresPermitidos(lista.endpoints, modelo),
      parConfirmadoZdr: (modeloResolvido, provedor) =>
        parConfirmadoZdr(lista.endpoints, modeloResolvido, provedor),
      agora: amb.agora,
      dormir: amb.dormir,
      ...(Number.isFinite(pausa) && pausa > 0 ? { pausaMs: pausa } : {}),
      progresso: (l) => amb.aviso(l),
    });

    for (const m of resultado.modelosSemZdr) {
      amb.aviso(
        `SEM ZDR: o OpenRouter não achou provedor com retenção zero para "${m}". Modelo fora da comparação; nenhuma chamada sem ZDR foi feita.`,
      );
    }
    for (const m of resultado.modelosProvedorNaoConfirmado) {
      amb.aviso(
        `PROVEDOR NÃO CONFIRMADO ZDR: "${m}" respondeu por um provedor que não consta (ou não foi informado) na lista ZDR. ` +
          'Resposta DESCARTADA e modelo parado. Se isto se repetir com ZDR ligada, é BLOQUEANTE: avise o responsável.',
      );
    }
    for (const f of resultado.modelosComFalha) {
      amb.aviso(`Modelo "${f.modelo}" abandonado após falhas seguidas: ${f.motivo}`);
    }
    const excluidos = new Set([
      ...resultado.modelosSemZdr,
      ...resultado.modelosProvedorNaoConfirmado,
    ]);
    if (modelos.every((m) => excluidos.has(m))) {
      amb.aviso(
        'NENHUM dos modelos pôde ser usado com ZDR confirmada. A sonda para aqui; avise o responsável.',
      );
      return 3;
    }

    const precos = precosEstimados(lista.endpoints);
    const metricas = calcularMetricas(resultado.registros, precos);
    amb.saida(
      tabelaDeMetricas(metricas, {
        fonte:
          'openrouter = usage.cost devolvido na resposta; estimativa = tokens × preço MÁXIMO dos endpoints ZDR da lista (usada só quando faltou o custo)',
        data: amb.hoje(),
      }),
    );
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
    await amb.gravarArquivo(
      join(pastaDeSaida, `chamadas-${data}.json`),
      JSON.stringify(metadadosDasChamadas(resultado.registros), null, 2) + '\n',
    );
    const planilha = join(pastaDeSaida, `planilha-${data}.csv`);
    await amb.gravarArquivo(planilha, gerarPlanilha(resultado.registros));
    amb.aviso(
      `Planilha para o Autran: ${planilha} (preencher a coluna "avaliacao" com util, errado ou perigoso).`,
    );

    // Só resposta de caso SINTÉTICO vira fixture; `fixtureDeRespostas` já filtra por origem.
    const fixturesSaida = resolve(op.get('fixtures-saida') ?? fixtures);
    for (const modelo of modelos) {
      const conteudo = fixtureDeRespostas(resultado.registros, modelo, data);
      if (!conteudo) continue;
      const arquivo = join(
        fixturesSaida,
        `respostas-${nomeSeguroDoModelo(modelo)}-${data}.json`,
      );
      try {
        await amb.gravarArquivo(arquivo, conteudo);
        amb.aviso(`Fixture gravada: ${arquivo}`);
      } catch {
        amb.aviso(
          `Não consegui gravar a fixture em ${fixturesSaida} (pasta sem permissão?). Use --fixtures-saida=<pasta do volume>; o resto da rodada está salvo.`,
        );
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
    // Mensagem genérica: o erro de baixo pode carregar trecho de texto de ato ou a chave.
    amb.aviso('Falha inesperada na sonda (detalhes omitidos de propósito).');
    return 4;
  }
}

function escolherSintetico(amb: AmbienteDaSonda): Promise<CasoDaSonda | undefined> {
  return amb
    .lerArquivo(
      join(amb.raizDoRepositorio, 'tests/fixtures/ia-ato/casos-sinteticos.json'),
    )
    .then((json) => lerCasosSinteticos(json).find((c) => c.id.startsWith('s01')));
}

/** O modelo mais barato (preço de entrada da lista) entre os que têm endpoint ZDR e id real. */
function maisBaratoComZdr(lista: ListaZdrLida): string | undefined {
  const preco = new Map<string, number>();
  for (const e of lista.endpoints) {
    if (ehApelidoOuVariante(e.modelo) || !e.precoEntrada || e.precoEntrada <= 0) continue;
    preco.set(e.modelo, Math.min(preco.get(e.modelo) ?? Infinity, e.precoEntrada));
  }
  return [...preco.entries()].sort(
    (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];
}

function mostrarRastro(
  amb: AmbienteDaSonda,
  chave: string,
  pedido: string,
  permitidos: readonly string[],
  d: {
    modeloResolvido?: string | undefined;
    provedor?: string | undefined;
    corpoEnviado?: unknown;
  },
): void {
  amb.saida(`  modelo pedido: ${pedido}`);
  amb.saida(`  campo "model" da resposta: ${d.modeloResolvido ?? '(ausente)'}`);
  amb.saida(`  campo "provider" da resposta: ${d.provedor ?? '(ausente)'}`);
  amb.saida(`  provider.only enviado: ${permitidos.join(', ') || '(vazio)'}`);
  amb.saida(
    `  corpo enviado (sem texto e sem chave): ${semChave(JSON.stringify(d.corpoEnviado ?? null), chave)}`,
  );
}

function transporteDeControle(chave: string, amb: AmbienteDaSonda) {
  const detalhes: DetalheDeErro[] = [];
  return {
    detalhes,
    transporte: amb.criarTransporte(chave, { aoFalhar: (d) => detalhes.push(d) }),
  };
}

/**
 * Controle POSITIVO. UMA chamada, caso sintético, a um modelo que a lista diz TER endpoint ZDR,
 * restrita aos provedores da lista. Esperado: responde, e o PAR (modelo que a resposta
 * devolveu, provedor) consta na lista. Código 0 = ok; 5 = erro; 6 = respondeu mas o par NÃO
 * consta na lista (bloqueante).
 */
async function controlePositivo(
  pedido: string,
  chave: string,
  lista: ListaZdrLida,
  amb: AmbienteDaSonda,
): Promise<number> {
  const modelo = pedido === 'true' ? maisBaratoComZdr(lista) : pedido;
  if (!modelo) {
    amb.aviso(
      'Não achei modelo com ZDR e preço na lista. Informe um: --controle-positivo=<modelo>.',
    );
    return 2;
  }
  if (ehApelidoOuVariante(modelo)) {
    amb.aviso(
      `"${modelo}" é um apelido (~) ou uma variante (:), não um modelo. Use o id real.`,
    );
    return 2;
  }
  if (!modeloTemZdr(lista.endpoints, modelo)) {
    amb.aviso(
      `"${modelo}" NÃO tem endpoint ZDR na lista; para ele use --controle-negativo.`,
    );
    return 2;
  }
  const permitidos = provedoresPermitidos(lista.endpoints, modelo);
  if (permitidos.length === 0) {
    amb.aviso(
      `A lista não traz o slug (tag) dos provedores de "${modelo}"; não dá para restringir a chamada.`,
    );
    return 2;
  }
  const caso = await escolherSintetico(amb);
  if (!caso) {
    amb.aviso('Caso sintético s01 não encontrado em tests/fixtures/ia-ato/.');
    return 2;
  }
  const entrada = prepararEntrada(
    { data: caso.data, titulo: caso.titulo, conteudo: caso.texto },
    {},
    { pessoas: caso.pessoas },
  );
  const { detalhes, transporte } = transporteDeControle(chave, amb);
  amb.aviso(
    `Controle positivo: uma chamada, com ZDR, restrita a [${permitidos.join(', ')}].`,
  );
  try {
    const r = await transporte.gerar({
      modelo,
      sistema: entrada.sistema,
      usuario: entrada.usuario,
      provedoresPermitidos: permitidos,
    });
    mostrarRastro(amb, chave, modelo, permitidos, {
      modeloResolvido: r.modeloResolvido,
      provedor: r.provedor,
      corpoEnviado: r.diagnostico.corpoEnviado,
    });
    if (parConfirmadoZdr(lista.endpoints, r.modeloResolvido, r.provedor)) {
      amb.saida(
        `OK: respondeu, e o par (${r.modeloResolvido}, ${r.provedor}) consta na lista ZDR.`,
      );
      return 0;
    }
    amb.saida(
      'BLOQUEANTE: respondeu, mas o par (modelo da resposta, provedor da resposta) NÃO consta na lista ZDR. ' +
        'Pode ser diferença de nome entre a resposta e a lista — relate a saída acima inteira antes de usar texto real.',
    );
    return 6;
  } catch (erro) {
    amb.saida(
      `Houve erro para "${modelo}" (${erro instanceof Error ? erro.message : 'erro'}):`,
    );
    for (const d of detalhes) {
      amb.saida(
        `  HTTP ${d.status ?? '—'} · corpo: ${semChave((d.corpo ?? '').slice(0, 800), chave) || '(vazio)'}`,
      );
      amb.saida(
        `  corpo enviado (sem texto e sem chave): ${semChave(JSON.stringify(d.corpoEnviado ?? null), chave)}`,
      );
    }
    return 5;
  }
}

/**
 * Controle NEGATIVO. UMA chamada, caso sintético, a um modelo REAL (sem "~" nem ":") que a lista
 * diz NÃO ter endpoint ZDR. A chamada fica restrita aos provedores REAIS do modelo (do detalhe
 * público do modelo), com `zdr: true`: como nenhum deles tem ZDR, o OpenRouter tem de recusar
 * ANTES de responder. Código 0 = recusou (esperado); 5 = erro não reconhecido como recusa;
 * 6 = RESPONDEU: a exigência de ZDR não foi respeitada (bloqueante).
 */
async function controleNegativo(
  pedido: string,
  chave: string,
  lista: ListaZdrLida,
  amb: AmbienteDaSonda,
): Promise<number> {
  let modelo = pedido;
  if (pedido === 'true') {
    const comZdr = new Set(modelosComZdr(lista.endpoints));
    const candidato = (await amb.buscarModelosPublicos())
      .filter((m) => !ehApelidoOuVariante(m.id) && !comZdr.has(m.id))
      .sort(
        (a, b) =>
          (a.precoEntrada && a.precoEntrada > 0 ? a.precoEntrada : Infinity) -
            (b.precoEntrada && b.precoEntrada > 0 ? b.precoEntrada : Infinity) ||
          a.id.localeCompare(b.id),
      )[0];
    if (!candidato) {
      amb.aviso(
        'Não achei modelo real fora da lista ZDR. Informe um: --controle-negativo=<modelo>.',
      );
      return 2;
    }
    modelo = candidato.id;
    amb.aviso(`Modelo escolhido (real, o mais barato fora da lista ZDR): ${modelo}`);
  }
  if (ehApelidoOuVariante(modelo)) {
    amb.aviso(
      `"${modelo}" é um apelido (~) ou uma variante (:), não um modelo. Use o id real.`,
    );
    return 2;
  }
  if (modeloTemZdr(lista.endpoints, modelo)) {
    amb.aviso(
      `"${modelo}" TEM endpoint ZDR; não serve para o controle negativo. Escolha outro.`,
    );
    return 2;
  }
  let reais: readonly EndpointPublico[];
  try {
    reais = await amb.buscarEndpointsPublicosDoModelo(modelo);
  } catch {
    amb.aviso(
      `Não consegui os provedores reais de "${modelo}" (detalhe público do modelo). Nada foi enviado.`,
    );
    return 2;
  }
  const permitidos = [
    ...new Set(reais.map((e) => slugDoProvedor(e.tag)).filter(Boolean)),
  ].sort();
  if (permitidos.length === 0) {
    amb.aviso(
      `O detalhe público de "${modelo}" não trouxe provedores com slug. Nada foi enviado.`,
    );
    return 2;
  }
  const caso = await escolherSintetico(amb);
  if (!caso) {
    amb.aviso('Caso sintético s01 não encontrado em tests/fixtures/ia-ato/.');
    return 2;
  }
  const entrada = prepararEntrada(
    { data: caso.data, titulo: caso.titulo, conteudo: caso.texto },
    {},
    { pessoas: caso.pessoas },
  );
  const { detalhes, transporte } = transporteDeControle(chave, amb);
  amb.aviso(
    `Controle negativo: uma chamada, com ZDR, restrita aos provedores REAIS do modelo [${permitidos.join(', ')}], nenhum com ZDR.`,
  );
  try {
    const r = await transporte.gerar({
      modelo,
      sistema: entrada.sistema,
      usuario: entrada.usuario,
      provedoresPermitidos: permitidos,
    });
    amb.saida(
      `BLOQUEANTE: o OpenRouter RESPONDEU para "${modelo}", que não tem endpoint ZDR na lista.`,
    );
    mostrarRastro(amb, chave, modelo, permitidos, {
      modeloResolvido: r.modeloResolvido,
      provedor: r.provedor,
      corpoEnviado: r.diagnostico.corpoEnviado,
    });
    amb.saida(
      'A exigência de ZDR pode não estar sendo respeitada. Não use o OpenRouter para texto real e relate esta saída.',
    );
    return 6;
  } catch (erro) {
    if (erro instanceof ZdrIndisponivelError) {
      amb.saida(
        `RECUSADO ANTES DE RESPONDER (esperado) para "${modelo}"; nada foi repetido.`,
      );
      for (const d of detalhes) {
        amb.saida(
          `  HTTP ${d.status ?? '—'} · corpo: ${semChave((d.corpo ?? '').slice(0, 800), chave) || '(vazio)'}`,
        );
        amb.saida(
          `  corpo enviado (sem texto e sem chave): ${semChave(JSON.stringify(d.corpoEnviado ?? null), chave)}`,
        );
      }
      amb.saida(`  provider.only enviado: ${permitidos.join(', ')}`);
      return 0;
    }
    amb.saida(
      `Houve erro para "${modelo}", mas NÃO foi reconhecido como recusa por falta de ZDR (${erro instanceof Error ? erro.message : 'erro'}). Registre abaixo:`,
    );
    for (const d of detalhes) {
      amb.saida(
        `  HTTP ${d.status ?? '—'} · corpo: ${semChave((d.corpo ?? '').slice(0, 800), chave) || '(vazio)'}`,
      );
      amb.saida(
        `  corpo enviado (sem texto e sem chave): ${semChave(JSON.stringify(d.corpoEnviado ?? null), chave)}`,
      );
    }
    return 5;
  }
}
