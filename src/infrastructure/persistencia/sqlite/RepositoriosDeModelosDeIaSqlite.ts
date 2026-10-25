import type { DatabaseSync } from 'node:sqlite';
import { FUNCOES_DE_IA, type FuncaoDeIa } from '../../../domain/entities/ControleDaIa.js';
import {
  MOTIVOS_DE_BLOQUEIO,
  MOTIVOS_DE_RESSALVA,
  type MetricasDoModelo,
  type MotivoDeBloqueio,
  type MotivoDeRessalva,
  type Veredito,
} from '../../../domain/entities/ModelosDeIa.js';
import type {
  AtualizacaoDoTeste,
  EstadoDoTeste,
  ModeloGravado,
  ModelosGravados,
  MotivoDeFalhaDoTeste,
  RepositorioDeModelosDeIa,
  RepositorioDeTestesDeModelo,
  TesteDeModelo,
} from '../../../domain/ports/ModelosDeIa.js';
import type { AlteracaoDeConfigDeIa } from '../../../domain/ports/PainelDeIa.js';

/**
 * O modelo por função mora nas colunas `modelo`, `modelo_anterior` e `modelo_desde` da MESMA `ia_config`
 * da Fase A (linha ausente ou NULL = vale o ambiente). Gravar aqui não toca nos tetos nem no liga/desliga,
 * e o `gravar` da Fase A (que só atualiza as colunas dele) não toca no modelo.
 */
export class RepositorioDeModelosDeIaSqlite implements RepositorioDeModelosDeIa {
  constructor(private readonly db: DatabaseSync) {}

  ler(): ModelosGravados {
    const linhas = this.db
      .prepare('SELECT chave, modelo, modelo_anterior, modelo_desde FROM ia_config')
      .all() as unknown as Array<{
      chave: string;
      modelo: string | null;
      modelo_anterior: string | null;
      modelo_desde: string | null;
    }>;
    const porChave = new Map(linhas.map((l) => [l.chave, l]));
    const de = (f: FuncaoDeIa): ModeloGravado => {
      const l = porChave.get(f);
      const desde = l?.modelo_desde ? new Date(l.modelo_desde) : null;
      return {
        modelo: l?.modelo ? l.modelo : null,
        anterior: l?.modelo_anterior ? l.modelo_anterior : null,
        desde: desde && !Number.isNaN(desde.getTime()) ? desde : null,
      };
    };
    return { ato: de('ato'), resumo: de('resumo'), peca: de('peca') };
  }

  publicar(
    funcao: FuncaoDeIa,
    modelo: string | null,
    anterior: string | null,
    agora: Date,
    a: AlteracaoDeConfigDeIa,
  ): void {
    const em = agora.toISOString();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO ia_config (chave, modelo, modelo_anterior, modelo_desde, atualizado_em)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(chave) DO UPDATE SET
             modelo = excluded.modelo,
             modelo_anterior = excluded.modelo_anterior,
             modelo_desde = excluded.modelo_desde,
             atualizado_em = excluded.atualizado_em`,
        )
        .run(funcao, modelo, anterior, em, em);
      this.inserir(a, em);
      this.db.exec('COMMIT');
    } catch (erro) {
      this.db.exec('ROLLBACK');
      throw erro;
    }
  }

  registrar(a: AlteracaoDeConfigDeIa): void {
    this.inserir(a, a.em.toISOString());
  }

  private inserir(a: AlteracaoDeConfigDeIa, em: string): void {
    this.db
      .prepare(
        `INSERT INTO ia_alteracoes (em, autor, funcao, tipo, valor_anterior, valor_novo, teste_id, aprovacao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        em,
        a.autor,
        a.funcao,
        a.tipo,
        a.anterior,
        a.novo,
        a.testeId ?? null,
        a.aprovacao ?? null,
      );
  }
}

interface LinhaDoTeste {
  id: string;
  funcao: string;
  candidato: string;
  referencia: string;
  estado: string;
  autor: string;
  criado_em: string;
  iniciado_em: string | null;
  terminado_em: string | null;
  chamadas_previstas: number;
  chamadas_feitas: number;
  estimativa_usd: number | null;
  gasto_usd: number | null;
  metricas_candidato: string | null;
  metricas_referencia: string | null;
  veredito: string | null;
  bloqueios: string;
  ressalvas: string;
  falha: string | null;
}

const ESTADOS: readonly EstadoDoTeste[] = [
  'na_fila',
  'executando',
  'concluido',
  'falhou',
  'cancelado',
];

function lerMetricas(json: string | null): MetricasDoModelo | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json) as MetricasDoModelo;
    return typeof v === 'object' && v !== null && typeof v.modelo === 'string'
      ? v
      : undefined;
  } catch {
    return undefined;
  }
}

function lerLista<T extends string>(json: string, validos: readonly T[]): T[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is T => (validos as readonly string[]).includes(x as string))
      : [];
  } catch {
    return [];
  }
}

const dataOuUndefined = (s: string | null): Date | undefined => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

function paraTeste(l: LinhaDoTeste): TesteDeModelo | undefined {
  if (!(FUNCOES_DE_IA as readonly string[]).includes(l.funcao)) return undefined;
  const estado = ESTADOS.find((e) => e === l.estado);
  if (!estado) return undefined;
  const mc = lerMetricas(l.metricas_candidato);
  const mr = lerMetricas(l.metricas_referencia);
  const iniciado = dataOuUndefined(l.iniciado_em);
  const terminado = dataOuUndefined(l.terminado_em);
  return {
    id: l.id,
    funcao: l.funcao as FuncaoDeIa,
    candidato: l.candidato,
    referencia: l.referencia,
    estado,
    autor: l.autor,
    criadoEm: new Date(l.criado_em),
    ...(iniciado ? { iniciadoEm: iniciado } : {}),
    ...(terminado ? { terminadoEm: terminado } : {}),
    chamadasPrevistas: Number(l.chamadas_previstas),
    chamadasFeitas: Number(l.chamadas_feitas),
    estimativaUsd: l.estimativa_usd === null ? null : Number(l.estimativa_usd),
    gastoUsd: l.gasto_usd === null ? null : Number(l.gasto_usd),
    ...(mc ? { metricasDoCandidato: mc } : {}),
    ...(mr ? { metricasDaReferencia: mr } : {}),
    ...(l.veredito ? { veredito: l.veredito as Veredito } : {}),
    bloqueios: lerLista<MotivoDeBloqueio>(l.bloqueios, MOTIVOS_DE_BLOQUEIO),
    ressalvas: lerLista<MotivoDeRessalva>(l.ressalvas, MOTIVOS_DE_RESSALVA),
    ...(l.falha ? { falha: l.falha as MotivoDeFalhaDoTeste } : {}),
  };
}

/** Os testes de modelo (v0.60.0). Só números e rótulos de lista fechada. */
export class RepositorioDeTestesDeModeloSqlite implements RepositorioDeTestesDeModelo {
  constructor(private readonly db: DatabaseSync) {}

  criar(t: TesteDeModelo): void {
    this.db
      .prepare(
        `INSERT INTO ia_testes_modelo
           (id, funcao, candidato, referencia, estado, autor, criado_em,
            chamadas_previstas, chamadas_feitas, estimativa_usd, bloqueios, ressalvas)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '[]', '[]')`,
      )
      .run(
        t.id,
        t.funcao,
        t.candidato,
        t.referencia,
        t.estado,
        t.autor,
        t.criadoEm.toISOString(),
        t.chamadasPrevistas,
        t.estimativaUsd,
      );
  }

  atualizar(id: string, m: AtualizacaoDoTeste): void {
    const campos: string[] = [];
    const valores: Array<string | number | null> = [];
    const poe = (coluna: string, valor: string | number | null): void => {
      campos.push(`${coluna} = ?`);
      valores.push(valor);
    };
    if (m.estado !== undefined) poe('estado', m.estado);
    if (m.iniciadoEm !== undefined) poe('iniciado_em', m.iniciadoEm.toISOString());
    if (m.terminadoEm !== undefined) poe('terminado_em', m.terminadoEm.toISOString());
    if (m.chamadasPrevistas !== undefined) poe('chamadas_previstas', m.chamadasPrevistas);
    if (m.chamadasFeitas !== undefined) poe('chamadas_feitas', m.chamadasFeitas);
    if (m.estimativaUsd !== undefined) poe('estimativa_usd', m.estimativaUsd);
    if (m.gastoUsd !== undefined) poe('gasto_usd', m.gastoUsd);
    if (m.metricasDoCandidato !== undefined)
      poe('metricas_candidato', JSON.stringify(m.metricasDoCandidato));
    if (m.metricasDaReferencia !== undefined)
      poe('metricas_referencia', JSON.stringify(m.metricasDaReferencia));
    if (m.veredito !== undefined) poe('veredito', m.veredito);
    if (m.bloqueios !== undefined) poe('bloqueios', JSON.stringify(m.bloqueios));
    if (m.ressalvas !== undefined) poe('ressalvas', JSON.stringify(m.ressalvas));
    if (m.falha !== undefined) poe('falha', m.falha);
    if (campos.length === 0) return;
    this.db
      .prepare(`UPDATE ia_testes_modelo SET ${campos.join(', ')} WHERE id = ?`)
      .run(...valores, id);
  }

  buscar(id: string): TesteDeModelo | undefined {
    const l = this.db
      .prepare('SELECT * FROM ia_testes_modelo WHERE id = ?')
      .get(id) as unknown as LinhaDoTeste | undefined;
    return l ? paraTeste(l) : undefined;
  }

  ultimoDaFuncao(funcao: FuncaoDeIa): TesteDeModelo | undefined {
    const l = this.db
      .prepare(
        'SELECT * FROM ia_testes_modelo WHERE funcao = ? ORDER BY criado_em DESC, rowid DESC LIMIT 1',
      )
      .get(funcao) as unknown as LinhaDoTeste | undefined;
    return l ? paraTeste(l) : undefined;
  }

  emAndamento(): TesteDeModelo | undefined {
    const l = this.db
      .prepare(
        `SELECT * FROM ia_testes_modelo WHERE estado IN ('na_fila','executando')
          ORDER BY criado_em DESC LIMIT 1`,
      )
      .get() as unknown as LinhaDoTeste | undefined;
    return l ? paraTeste(l) : undefined;
  }

  marcarInterrompidos(agora: Date): number {
    const r = this.db
      .prepare(
        `UPDATE ia_testes_modelo SET estado = 'falhou', falha = 'reiniciado', terminado_em = ?
          WHERE estado IN ('na_fila','executando')`,
      )
      .run(agora.toISOString());
    return Number(r.changes);
  }
}
