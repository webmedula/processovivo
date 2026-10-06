/**
 * Dados SINTÉTICOS para a tela de Atualizações (o repositório é público): números
 * com dígito verificador válido mas inventados, partes e classes fictícias, nada
 * copiado de tela real. Montam a resposta de `GET /v1/novidades` que os testes de
 * navegador injetam por cima do servidor real.
 */
export const DIA = 86_400_000;

export function numeroValido(
  sequencial: number,
  tribunal = '09',
  origem = '0011',
): string {
  const seq = String(sequencial).padStart(7, '0');
  const ano = '2026';
  const base = BigInt(`${seq}${ano}8${tribunal}${origem}00`);
  const dv = String(98n - (base % 97n)).padStart(2, '0');
  return `${seq}${dv}${ano}8${tribunal}${origem}`;
}

export interface NovidadeSintetica {
  id: number;
  numero: string;
  data: string;
  titulo: string;
  codigoTpu: null;
  conteudo: string | null;
  detectadaEm: string;
  exigeAcao: boolean;
  vista: boolean;
}

export interface GrupoSintetico {
  numero: string;
  processo: {
    tribunal: string | null;
    classe: string | null;
    partes: {
      ativo: { nomes: string[]; total: number };
      passivo: { nomes: string[]; total: number };
    };
    pedeProvidencia: boolean;
    motivoProvidencia: string | null;
  } | null;
  maisRecente: NovidadeSintetica;
  anteriores: NovidadeSintetica[];
  naoVistas: number;
}

let proximoId = 1;

export function novidade(
  numero: string,
  titulo: string,
  opcoes: {
    diasDetectada?: number;
    diasAto?: number;
    conteudo?: string | null;
    vista?: boolean;
    exigeAcao?: boolean;
  } = {},
  agora: number = Date.now(),
): NovidadeSintetica {
  const detectada = new Date(agora - (opcoes.diasDetectada ?? 0) * DIA).toISOString();
  return {
    id: proximoId++,
    numero,
    data: new Date(
      agora - (opcoes.diasAto ?? opcoes.diasDetectada ?? 0) * DIA,
    ).toISOString(),
    titulo,
    codigoTpu: null,
    conteudo: opcoes.conteudo ?? null,
    detectadaEm: detectada,
    exigeAcao: opcoes.exigeAcao ?? false,
    vista: opcoes.vista ?? false,
  };
}

export function grupo(
  numero: string,
  principal: NovidadeSintetica,
  anteriores: NovidadeSintetica[] = [],
  processo: GrupoSintetico['processo'] = null,
): GrupoSintetico {
  return {
    numero,
    processo,
    maisRecente: principal,
    anteriores,
    naoVistas: [principal, ...anteriores].filter((n) => !n.vista).length,
  };
}

export function infoProcesso(
  tribunal: string | null,
  classe: string | null,
  ativo: string[],
  passivo: string[],
  pedeProvidencia = false,
): NonNullable<GrupoSintetico['processo']> {
  return {
    tribunal,
    classe,
    partes: {
      ativo: { nomes: ativo, total: ativo.length },
      passivo: { nomes: passivo, total: passivo.length },
    },
    pedeProvidencia,
    motivoProvidencia: pedeProvidencia ? '"Intimação" nos últimos 10 dias' : null,
  };
}

/** `/v1/novidades` completo, a partir dos grupos. */
export function respostaNovidades(
  grupos: GrupoSintetico[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const naoVistas = grupos.reduce((n, g) => n + g.naoVistas, 0);
  return {
    total: grupos.reduce((n, g) => n + 1 + g.anteriores.length, 0),
    naoVistas,
    acompanhados: grupos.length,
    janelaDias: 15,
    janelaPadraoDias: 15,
    pendenciaJanelaDias: 10,
    foraDaJanela: 0,
    grupos,
    novidades: [],
    ...extra,
  };
}

/** Uma carteira variada: `n` processos, mistura de tribunais, lidas/não lidas e providência. */
export function carteira(n: number, agora: number = Date.now()): GrupoSintetico[] {
  const tribunais = [
    ['TJGO', '09'],
    ['TJSP', '26'],
    ['TJMG', '13'],
  ] as const;
  const classes = ['Procedimento Comum Cível', 'Execução de Título Extrajudicial', null];
  const saida: GrupoSintetico[] = [];
  for (let i = 0; i < n; i++) {
    const [sigla, codigo] = tribunais[i % tribunais.length] as readonly [string, string];
    const numero = numeroValido(1000 + i, codigo);
    const providencia = i % 5 === 0;
    const lida = i % 3 === 0;
    const principal = novidade(
      numero,
      providencia ? 'Intimação' : i % 2 ? 'Juntada de petição' : 'Conclusos para decisão',
      {
        diasDetectada: i % 14,
        diasAto: (i % 14) + 1,
        conteudo: i % 4 === 0 ? null : `Texto sintético do ato número ${i}.`,
        vista: lida,
        exigeAcao: providencia,
      },
      agora,
    );
    const ant =
      i % 4 === 1
        ? [novidade(numero, 'Despacho', { diasDetectada: 3 + (i % 5) }, agora)]
        : [];
    saida.push(
      grupo(
        numero,
        principal,
        ant,
        i % 7 === 6
          ? null
          : infoProcesso(
              sigla,
              classes[i % classes.length] ?? null,
              i % 6 === 5 ? [] : [`Autora Sintética ${i}`],
              i % 6 === 5 ? [] : [`Empresa Fictícia ${i} Ltda`],
              providencia,
            ),
      ),
    );
  }
  return saida;
}
