import { join, resolve } from 'node:path';
import { VERSAO_PROMPT } from '../../application/politicas/entradaDoModelo.js';
import { VERSAO_DAS_REGRAS_DE_VERIFICACAO } from '../../application/politicas/verificarAnalise.js';
import {
  ehApelidoOuVariante,
  modeloTemZdr,
  parConfirmadoZdr,
  precosEstimados,
  provedoresPermitidos,
  type ListaZdrLida,
} from '../../infrastructure/adapters/modelo/endpointsZdr.js';
import { pareceValorDeExemplo } from '../../infrastructure/config/placeholder.js';
import {
  CATEGORIAS_DE_CASO,
  lerCasosDeAvaliacao,
  type CasoDeAvaliacao,
} from './casosDeAvaliacao.js';
import { caminhoDentroDoRepositorio, type AmbienteDaSonda } from './comandoSondaIa.js';
import {
  TETO_PADRAO_USD,
  TransporteComTeto,
  VERSAO_DO_COMPARADOR,
  compararModelos,
  estimarCusto,
  metricasEmCsv,
  relatorioEmMarkdown,
  revisaoHumanaEmCsv,
} from './comparadorDeModelos.js';
import {
  executarComparacaoDePecas,
  julgarPlanilhaDePecas,
} from './comandoComparadorPecas.js';
import { executarComparacaoDeResumo } from './comandoComparadorResumo.js';
import type { PrecoPorToken } from './sondaIaAto.js';

/**
 * Comando `scripts/ia-comparar-modelos.mjs` (v0.52.0). MANUAL: nunca roda no CI nem no servidor.
 * Sem `--executar` só ESTIMA (a lista de endpoints ZDR é lida, mas nenhum texto de caso sai).
 * A chave vem só de `OPENROUTER_API_KEY` e nunca é impressa nem gravada.
 */

const AJUDA = `Comparador de modelos da análise do ato v${VERSAO_DO_COMPARADOR} (casos SINTÉTICOS, ZDR em toda chamada).
Precisa de OPENROUTER_API_KEY e de PROCESSOVIVO_IA_MODELO (o modelo de produção, sempre incluído como referência).

1. Estimar (padrão; NADA é enviado ao modelo):
  node scripts/ia-comparar-modelos.mjs --modelos=a,b
2. Rodar de verdade:
  node scripts/ia-comparar-modelos.mjs --modelos=a,b --executar [--teto-usd=${TETO_PADRAO_USD}]
3. Leitura de PEÇAS (v0.53.0, casos sintéticos em tests/fixtures/ia-pecas):
  node scripts/ia-comparar-modelos.mjs --tarefa=pecas --modelos=a,b [--executar]
  node scripts/ia-comparar-modelos.mjs --julgar-revisao=<planilha preenchida .csv>   # errado/perigoso, sem chamar modelo
4. RESUMO do processo (v0.54.0): compara resumo-1.0.0 × resumo-1.1.0 com o modelo de produção (casos sintéticos em tests/fixtures/ia-resumo):
  node scripts/ia-comparar-modelos.mjs --tarefa=resumo            # estima; NADA é enviado
  node scripts/ia-comparar-modelos.mjs --tarefa=resumo --executar [--versoes=resumo-1.0.0,resumo-1.1.0] [--modelos=a,b]
Opções: --tarefa=ato|pecas|resumo  --teto-usd=<n> (padrão ${TETO_PADRAO_USD})  --categorias=decisao,prazo_escrito  --casos=<arquivo.json>  --saida=<pasta>  --pausa-ms=<n>  --ajuda
Só roda modelo que a lista oficial de ZDR do OpenRouter aprova na hora; o resto é recusado. Preço é estimativa, não confirmado.
A saída (relatório .md, métricas .csv e revisão humana .csv) fica FORA do repositório.`;

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

const semChave = (texto: string, chave: string): string =>
  chave === '' ? texto : texto.split(chave).join('[chave]');

const usd = (v: number | undefined): string =>
  v === undefined ? 'sem preço' : `US$ ${v.toFixed(4)}`;

export async function executarComandoComparador(
  argv: readonly string[],
  amb: AmbienteDaSonda,
): Promise<number> {
  const op = opcoesDe(argv);
  if (op.has('ajuda') || argv.length === 0) {
    amb.saida(AJUDA);
    return argv.length === 0 ? 1 : 0;
  }
  const tarefa = op.get('tarefa') ?? 'ato';
  if (tarefa !== 'ato' && tarefa !== 'pecas' && tarefa !== 'resumo') {
    amb.aviso('--tarefa inválida. Use: ato (padrão), pecas ou resumo.');
    return 1;
  }
  try {
    // Julgar a planilha de revisão humana das peças: não chama modelo e não precisa de chave.
    if (op.has('julgar-revisao')) {
      return await julgarPlanilhaDePecas(op.get('julgar-revisao') ?? '', amb);
    }
    const chave = amb.env['OPENROUTER_API_KEY']?.trim();
    if (!chave || pareceValorDeExemplo(chave)) {
      amb.aviso(
        'OPENROUTER_API_KEY não está definida (ou é um valor de exemplo). Nada foi enviado.',
      );
      return 2;
    }
    const producao = amb.env['PROCESSOVIVO_IA_MODELO']?.trim() ?? '';
    if (producao === '' || ehApelidoOuVariante(producao)) {
      amb.aviso(
        'PROCESSOVIVO_IA_MODELO precisa ser o id real do modelo de produção: ele é a referência da comparação.',
      );
      return 2;
    }
    const tetoUsd = op.has('teto-usd') ? Number(op.get('teto-usd')) : TETO_PADRAO_USD;
    if (!Number.isFinite(tetoUsd) || tetoUsd <= 0) {
      amb.aviso('--teto-usd precisa ser um número maior que zero.');
      return 1;
    }
    const pausa = Number(op.get('pausa-ms') ?? '0');

    const pastaDeSaida = resolve(
      op.get('saida') ??
        join(
          amb.env['PROCESSOVIVO_DB_PATH']
            ? resolve(amb.env['PROCESSOVIVO_DB_PATH'], '..')
            : resolve(amb.raizDoRepositorio, 'dados'),
          'comparador-ia',
        ),
    );
    if (caminhoDentroDoRepositorio(pastaDeSaida, amb.raizDoRepositorio)) {
      amb.aviso(
        'A pasta de saída está dentro do repositório. Use uma pasta do volume (--saida=...).',
      );
      return 2;
    }

    // --- ZDR: a lista oficial, lida agora; sem ela nada é enviado ---
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
    const pedidos = [
      ...(op.get('modelos') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ];
    const desejados = [producao, ...pedidos.filter((m) => m !== producao)];
    const aprovados: string[] = [];
    for (const m of [...new Set(desejados)]) {
      if (ehApelidoOuVariante(m)) {
        amb.aviso(
          `Modelo recusado: "${m}" é apelido (~) ou variante (:). Use o id real.`,
        );
      } else if (!modeloTemZdr(lista.endpoints, m)) {
        amb.aviso(
          `Modelo recusado: "${m}" não tem endpoint com ZDR na lista oficial de agora.`,
        );
      } else {
        aprovados.push(m);
      }
    }
    if (!aprovados.includes(producao)) {
      amb.aviso(
        'O modelo de produção não passou na conferência de ZDR: sem a referência não há comparação. Nada foi enviado.',
      );
      return 2;
    }

    // --- preços (estimativa; não confirmados) ---
    const precos = new Map<string, PrecoPorToken>(precosEstimados(lista.endpoints));
    if (aprovados.some((m) => !precos.has(m))) {
      try {
        for (const m of await amb.buscarModelosPublicos()) {
          if (
            aprovados.includes(m.id) &&
            !precos.has(m.id) &&
            m.precoEntrada !== undefined &&
            m.precoSaida !== undefined
          ) {
            precos.set(m.id, { entrada: m.precoEntrada, saida: m.precoSaida });
          }
        }
      } catch {
        /* sem preço público: a estimativa diz "sem preço" e o teto usa o custo conservador */
      }
    }

    // --- outra tarefa: leitura de PEÇAS (v0.53.0) ---
    if (tarefa === 'pecas') {
      return await executarComparacaoDePecas({
        op,
        amb,
        chave,
        producao,
        aprovados,
        lista,
        tetoUsd,
        pausa,
        pastaDeSaida,
        precos,
      });
    }

    // --- outra tarefa: resumo do processo, 1.0.0 × 1.1.0 (v0.54.0) ---
    if (tarefa === 'resumo') {
      return await executarComparacaoDeResumo({
        op,
        amb,
        chave,
        producao,
        aprovados,
        lista,
        tetoUsd,
        pausa,
        pastaDeSaida,
        precos,
      });
    }

    // --- casos sintéticos ---
    const caminhoDosCasos = resolve(
      op.get('casos') ??
        join(amb.raizDoRepositorio, 'tests/fixtures/ia-avaliacao/casos.json'),
    );
    let casos: CasoDeAvaliacao[] = lerCasosDeAvaliacao(
      await amb.lerArquivo(caminhoDosCasos),
    );
    const filtro = op.get('categorias');
    if (filtro) {
      const quer = filtro.split(',').map((s) => s.trim());
      const invalida = quer.find(
        (c) => !(CATEGORIAS_DE_CASO as readonly string[]).includes(c),
      );
      if (invalida) {
        amb.aviso(
          `Categoria desconhecida: ${invalida}. Use: ${CATEGORIAS_DE_CASO.join(', ')}.`,
        );
        return 1;
      }
      casos = casos.filter((c) => quer.includes(c.categoria));
    }
    if (casos.length === 0) {
      amb.aviso('Nenhum caso para rodar.');
      return 1;
    }

    const estimativas = estimarCusto(casos, aprovados, precos);
    const total = estimativas.reduce((a, e) => a + (e.custoEstimadoUsd ?? 0), 0);
    const semPreco = estimativas.filter((e) => e.custoEstimadoUsd === undefined);
    amb.saida(
      `Comparador ${VERSAO_DO_COMPARADOR}: ${casos.length} casos sintéticos × ${aprovados.length} modelos (produção: ${producao}).`,
    );
    for (const e of estimativas) {
      amb.saida(
        `  ${e.modelo}${e.modelo === producao ? ' (produção)' : ''}: ${e.chamadas} chamadas · estimativa ${usd(e.custoEstimadoUsd)}`,
      );
    }
    amb.saida(
      `Estimativa total: ${usd(total)} (preço de lista do OpenRouter, NÃO confirmado) · teto da rodada: US$ ${tetoUsd.toFixed(2)}.` +
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
    if (total > tetoUsd) {
      amb.aviso(
        `A estimativa (${usd(total)}) passa do teto (US$ ${tetoUsd.toFixed(2)}). Nada foi enviado: reduza os modelos ou os casos, ou aumente --teto-usd de propósito.`,
      );
      return 2;
    }

    // --- execução ---
    const transporte = new TransporteComTeto(amb.criarTransporte(chave), tetoUsd, precos);
    const resultado = await compararModelos({
      casos,
      modeloDeReferencia: producao,
      modelos: aprovados,
      transporte,
      teto: transporte,
      provedoresPermitidos: (m) => provedoresPermitidos(lista.endpoints, m),
      parConfirmadoZdr: (r, p) => parConfirmadoZdr(lista.endpoints, r, p),
      precos,
      agora: amb.agora,
      dormir: amb.dormir,
      ...(Number.isFinite(pausa) && pausa > 0 ? { pausaMs: pausa } : {}),
      progresso: (l) => amb.aviso(l),
    });

    const sufixo = `${amb.hoje()}-${amb.hora()}`;
    const meta = {
      data: amb.hoje(),
      casos: casos.length,
      tetoUsd,
      versaoPrompt: VERSAO_PROMPT,
      versaoDasRegras: VERSAO_DAS_REGRAS_DE_VERIFICACAO,
    };
    const base = join(pastaDeSaida, `comparacao-${sufixo}`);
    await amb.gravarArquivo(`${base}.md`, relatorioEmMarkdown(resultado, meta));
    await amb.gravarArquivo(`${base}-metricas.csv`, metricasEmCsv(resultado));
    await amb.gravarArquivo(`${base}-revisao-humana.csv`, revisaoHumanaEmCsv(resultado));

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
      `\nGasto contado: US$ ${resultado.gastoUsd.toFixed(4)} de US$ ${tetoUsd.toFixed(2)}.`,
    );
    amb.saida(`Relatório: ${base}.md`);
    amb.saida(`Métricas: ${base}-metricas.csv`);
    amb.saida(`Revisão humana: ${base}-revisao-humana.csv`);
    return resultado.linhas.every((l) => l.interrompido) ? 3 : 0;
  } catch (erro) {
    amb.aviso(
      `Falha: ${semChave(erro instanceof Error ? erro.message : 'erro inesperado', amb.env['OPENROUTER_API_KEY'] ?? '')}`,
    );
    return 1;
  }
}
