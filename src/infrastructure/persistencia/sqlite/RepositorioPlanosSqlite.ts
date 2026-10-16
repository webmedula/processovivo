import type { DatabaseSync } from 'node:sqlite';
import { ehCiclo, ehRecurso } from '../../../domain/entities/Plano.js';
import type { Plano, RecursoDoPlano } from '../../../domain/entities/Plano.js';
import { REGRAS_PADRAO } from '../../../domain/entities/RegrasDeAssinatura.js';
import type { RegrasDeAssinatura } from '../../../domain/entities/RegrasDeAssinatura.js';
import type {
  RepositorioPlanos,
  RepositorioRegrasDeAssinatura,
} from '../../../domain/ports/RepositorioPlanos.js';

interface LinhaPlano {
  codigo: string;
  nome: string;
  resumo: string;
  recursos: string;
  disponivel: number;
  preco_mensal_centavos: number | null;
  ordem: number;
  ciclo: string | null;
}

function lerRecursos(json: string): RecursoDoPlano[] {
  let bruto: unknown;
  try {
    bruto = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(bruto)) return [];
  // Recurso que o código não conhece (linha editada à mão, ou recurso retirado
  // numa versão futura) não entra no domínio: um plano que "inclui" algo que
  // não existe liberaria nada e confundiria a tela.
  return bruto.filter((r): r is RecursoDoPlano => typeof r === 'string' && ehRecurso(r));
}

function paraDominio(l: LinhaPlano): Plano {
  return {
    codigo: l.codigo,
    nome: l.nome,
    resumo: l.resumo,
    recursos: lerRecursos(l.recursos),
    disponivelParaContratacao: l.disponivel === 1,
    precoMensalCentavos: l.preco_mensal_centavos,
    ordem: l.ordem,
    // Linha sem o ciclo (anterior à v0.44.0) ou com valor que o código não conhece = mensal.
    ...(l.ciclo && ehCiclo(l.ciclo) && l.ciclo !== 'mensal' ? { ciclo: l.ciclo } : {}),
  };
}

export class RepositorioPlanosSqlite implements RepositorioPlanos {
  constructor(private readonly db: DatabaseSync) {}

  async listar(): Promise<readonly Plano[]> {
    const linhas = this.db
      .prepare('SELECT * FROM planos ORDER BY ordem ASC, codigo ASC')
      .all() as unknown as LinhaPlano[];
    return linhas.map(paraDominio);
  }

  async porCodigo(codigo: string): Promise<Plano | undefined> {
    const linha = this.db
      .prepare('SELECT * FROM planos WHERE codigo = ?')
      .get(codigo) as unknown as LinhaPlano | undefined;
    return linha ? paraDominio(linha) : undefined;
  }

  async salvar(p: Plano): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO planos
           (codigo, nome, resumo, recursos, disponivel, preco_mensal_centavos, ordem, ciclo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (codigo) DO UPDATE SET
           nome                  = excluded.nome,
           resumo                = excluded.resumo,
           recursos              = excluded.recursos,
           disponivel            = excluded.disponivel,
           preco_mensal_centavos = excluded.preco_mensal_centavos,
           ordem                 = excluded.ordem,
           ciclo                 = excluded.ciclo`,
      )
      .run(
        p.codigo,
        p.nome,
        p.resumo,
        JSON.stringify(p.recursos),
        p.disponivelParaContratacao ? 1 : 0,
        p.precoMensalCentavos,
        p.ordem,
        p.ciclo ?? 'mensal',
      );
  }
}

interface LinhaRegras {
  dias_de_teste: number;
  plano_do_teste: string;
  dias_de_carencia: number;
}

export class RepositorioRegrasDeAssinaturaSqlite implements RepositorioRegrasDeAssinatura {
  constructor(private readonly db: DatabaseSync) {}

  async ler(): Promise<RegrasDeAssinatura> {
    const linha = this.db
      .prepare('SELECT * FROM regras_assinatura WHERE id = 1')
      .get() as unknown as LinhaRegras | undefined;
    if (!linha) return REGRAS_PADRAO;
    return {
      diasDeTeste: linha.dias_de_teste,
      planoDoTeste: linha.plano_do_teste,
      diasDeCarencia: linha.dias_de_carencia,
    };
  }

  async salvar(r: RegrasDeAssinatura): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO regras_assinatura (id, dias_de_teste, plano_do_teste, dias_de_carencia)
         VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           dias_de_teste    = excluded.dias_de_teste,
           plano_do_teste   = excluded.plano_do_teste,
           dias_de_carencia = excluded.dias_de_carencia`,
      )
      .run(r.diasDeTeste, r.planoDoTeste, r.diasDeCarencia);
  }
}
