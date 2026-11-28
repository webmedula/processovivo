import { describe, expect, it } from 'vitest';
import {
  ConsultaDoTribunalNaVarredura,
  chaveDaAssinatura,
} from '../../src/application/services/consultaDoTribunalNaVarredura.js';
import type { FonteDoTribunalNaVarredura } from '../../src/application/services/consultaDoTribunalNaVarredura.js';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import {
  CredencialTribunalInvalidaError,
  ProviderIndisponivelError,
  SemHabilitacaoNosAutosError,
} from '../../src/domain/errors/index.js';
import type {
  AssinaturaDeMudanca,
  CredencialTribunal,
} from '../../src/domain/ports/ProvedorDePecas.js';
import type {
  CredencialCadastrada,
  RepositorioCredenciais,
} from '../../src/domain/ports/RepositorioCredenciais.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';

/*
 * v0.72.0 — a varredura lê também o Projudi (MNI) das contas que cadastraram o acesso. Sem rede:
 * tribunal, credenciais e fontes públicas são dublês. Credencial e números sintéticos.
 */
const WS = 'ws-tribunal';
const TJGO = numeroValido(7201); // 8.09 = TJGO
const TJSP = numeroValido(7202, '26', '0100');
const dia = (d: string, h = '13:00'): Date => new Date(`${d}T${h}:00-03:00`);

class CredenciaisFalsas implements RepositorioCredenciais {
  readonly recusas: string[] = [];
  constructor(private cadastradas: CredencialCadastrada[]) {}
  async obter(_w: string, tribunal: string): Promise<CredencialTribunal | undefined> {
    return this.cadastradas.some((c) => c.tribunal === tribunal)
      ? { tribunal, identificacao: '00000000000', senha: 'senha-sintetica' }
      : undefined;
  }
  async listar(): Promise<CredencialCadastrada[]> {
    return this.cadastradas;
  }
  async salvar(): Promise<CredencialCadastrada> {
    throw new Error('não usado');
  }
  async remover(): Promise<boolean> {
    return false;
  }
  async registrarUso(): Promise<void> {}
  async registrarRecusa(_w: string, tribunal: string): Promise<void> {
    this.recusas.push(tribunal);
    this.cadastradas = this.cadastradas.map((c) =>
      c.tribunal === tribunal ? { ...c, recusadaEm: new Date() } : c,
    );
  }
}

const cadastrada = (extra: Partial<CredencialCadastrada> = {}): CredencialCadastrada => ({
  tribunal: 'TJGO',
  identificacao: '***',
  criadaEm: new Date('2026-10-01T00:00:00Z'),
  ...extra,
});

const mni = (d: string, id: number, codigoTpu: number, titulo: string): Movimentacao => ({
  data: dia(d, '16:20'),
  titulo,
  codigoTpu,
  idExterno: `mni:${id}`,
  fonte: 'mni',
});

function montar(
  opcoes: {
    credenciais?: CredencialCadastrada[];
    assinatura?: () => Promise<AssinaturaDeMudanca>;
    listar?: () => Promise<{
      pecas: [];
      movimentos: readonly Movimentacao[];
      nivelSigiloDoProcesso?: number;
    }>;
    pausadoAte?: Date;
  } = {},
) {
  const chamadas = { assinatura: 0, listar: 0 };
  const credenciais = new CredenciaisFalsas(opcoes.credenciais ?? [cadastrada()]);
  const consulta = new ConsultaDoTribunalNaVarredura({
    credenciais,
    logger: loggerSilencioso,
    agora: () => dia('2026-11-28'),
    provedor: {
      tribunais: ['TJGO'],
      assinaturaDeMudanca: async () => {
        chamadas.assinatura++;
        return opcoes.assinatura
          ? opcoes.assinatura()
          : { movimentacoes: 'h-mov-2', documentos: 'h-doc-2' };
      },
      pausadoAte: () => opcoes.pausadoAte,
    },
    pecas: {
      listarDoProcesso: async () => {
        chamadas.listar++;
        return opcoes.listar
          ? opcoes.listar()
          : { pecas: [], movimentos: [mni('2026-11-24', 1, 11010, 'Despacho')] };
      },
    },
  });
  return { consulta, chamadas, credenciais };
}

describe('ConsultaDoTribunalNaVarredura: nada sai sem motivo', () => {
  it('conta sem acesso cadastrado: zero chamadas ao tribunal', async () => {
    const { consulta, chamadas } = montar({ credenciais: [] });
    expect(await consulta.consultar(WS, TJGO, undefined)).toEqual({
      situacao: 'sem_consulta',
    });
    expect(chamadas).toEqual({ assinatura: 0, listar: 0 });
  });

  it('credencial já recusada: não manda a senha de novo', async () => {
    const { consulta, chamadas } = montar({
      credenciais: [cadastrada({ recusadaEm: new Date('2026-11-27T00:00:00Z') })],
    });
    expect((await consulta.consultar(WS, TJGO, undefined)).situacao).toBe('sem_consulta');
    expect(chamadas).toEqual({ assinatura: 0, listar: 0 });
  });

  it('tribunal sem fonte de peças: zero chamadas', async () => {
    const { consulta, chamadas } = montar({
      credenciais: [cadastrada({ tribunal: 'TJSP' })],
    });
    expect((await consulta.consultar(WS, TJSP, undefined)).situacao).toBe('sem_consulta');
    expect(chamadas).toEqual({ assinatura: 0, listar: 0 });
  });

  it('tribunal em pausa por bloqueio: zero chamadas', async () => {
    const { consulta, chamadas } = montar({ pausadoAte: dia('2026-11-28', '15:00') });
    expect((await consulta.consultar(WS, TJGO, undefined)).situacao).toBe('sem_consulta');
    expect(chamadas).toEqual({ assinatura: 0, listar: 0 });
  });
});

describe('ConsultaDoTribunalNaVarredura: o atalho barato primeiro', () => {
  it('nada mudou no tribunal: só a pergunta "mudou?", sem a listagem', async () => {
    const { consulta, chamadas } = montar();
    const anterior = chaveDaAssinatura({
      movimentacoes: 'h-mov-2',
      documentos: 'h-doc-2',
    });
    expect(await consulta.consultar(WS, TJGO, anterior)).toEqual({
      situacao: 'sem_mudanca',
    });
    expect(chamadas).toEqual({ assinatura: 1, listar: 0 });
  });

  it('mudou: lista e devolve a assinatura nova para guardar', async () => {
    const { consulta, chamadas } = montar();
    const r = await consulta.consultar(WS, TJGO, 'm:h-mov-1|d:h-doc-1');
    expect(r.situacao).toBe('atos');
    expect(r.situacao === 'atos' && r.assinatura).toBe('m:h-mov-2|d:h-doc-2');
    expect(chamadas).toEqual({ assinatura: 1, listar: 1 });
  });

  it('sem assinatura na resposta, a listagem decide (e nada é guardado)', async () => {
    const { consulta, chamadas } = montar({ assinatura: async () => ({}) });
    const r = await consulta.consultar(WS, TJGO, undefined);
    expect(r.situacao).toBe('atos');
    expect('assinatura' in r).toBe(false);
    expect(chamadas.listar).toBe(1);
  });

  it('senha recusada na pergunta "mudou?" fica anotada: a próxima rodada não insiste', async () => {
    const { consulta, chamadas, credenciais } = montar({
      assinatura: async () => {
        throw new CredencialTribunalInvalidaError('mni', 'recusada');
      },
    });
    await expect(consulta.consultar(WS, TJGO, undefined)).rejects.toBeInstanceOf(
      CredencialTribunalInvalidaError,
    );
    expect(credenciais.recusas).toEqual(['TJGO']);
    expect((await consulta.consultar(WS, TJGO, undefined)).situacao).toBe('sem_consulta');
    expect(chamadas).toEqual({ assinatura: 1, listar: 0 });
  });

  it('processo sob sigilo na origem: nada do tribunal volta', async () => {
    const { consulta } = montar({
      listar: async () => ({
        pecas: [],
        movimentos: [mni('2026-11-24', 1, 11010, 'Despacho')],
        nivelSigiloDoProcesso: 1,
      }),
    });
    expect((await consulta.consultar(WS, TJGO, undefined)).situacao).toBe('sem_consulta');
  });

  it('sem procuração nos autos: guarda a assinatura para não listar de novo à toa', async () => {
    const { consulta } = montar({
      listar: async () => {
        throw new SemHabilitacaoNosAutosError(TJGO);
      },
    });
    expect(await consulta.consultar(WS, TJGO, undefined)).toEqual({
      situacao: 'sem_atos',
      assinatura: 'm:h-mov-2|d:h-doc-2',
    });
  });

  it('uma consulta ao tribunal por vez, mesmo com vários trabalhadores pedindo', async () => {
    let ativos = 0;
    let maximo = 0;
    const { consulta } = montar({
      listar: async () => {
        ativos++;
        maximo = Math.max(maximo, ativos);
        await new Promise((r) => setTimeout(r, 5));
        ativos--;
        return { pecas: [], movimentos: [mni('2026-11-24', 1, 11010, 'Despacho')] };
      },
    });
    await Promise.all([
      consulta.consultar(WS, TJGO, undefined),
      consulta.consultar(WS, numeroValido(7203), undefined),
      consulta.consultar(WS, numeroValido(7204), undefined),
    ]);
    expect(maximo).toBe(1);
  });
});

/* ---------- a varredura de ponta a ponta, com o banco de verdade ---------- */

function publico(numero: string, movimentacoes: Movimentacao[]): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJGO',
    movimentacoes,
    procedencia: {
      provider: 'datajud+djen',
      consultadoEm: dia('2026-11-20'),
      deCache: false,
    },
  });
}

const ATOS_PUBLICOS: Movimentacao[] = [
  {
    data: dia('2026-11-03'),
    titulo: 'Mero expediente',
    codigoTpu: 11010,
    fonte: 'datajud',
  },
  {
    data: dia('2026-11-06', '00:00'),
    titulo: 'Despacho',
    idExterno: 'djen:501',
    conteudo: 'Texto sintético.',
    fonte: 'djen',
  },
];

async function cenario(fonte: FonteDoTribunalNaVarredura | undefined) {
  const db = abrirBanco(':memory:');
  const repositorio = new RepositorioAcompanhamentosSqlite(db);
  const servico = new ServicoAcompanhamento({
    repositorio,
    provider: new ProviderFalso({
      nome: 'datajud',
      porNumero: async (numero) => publico(numero, ATOS_PUBLICOS),
    }),
    logger: loggerSilencioso,
    pausaEntreConsultasMs: 0,
    dormir: async () => {},
    ...(fonte ? { fonteDoTribunal: fonte } : {}),
  });
  await repositorio.acompanhar(WS, TJGO);
  // Primeiro retrato, só das fontes públicas (como o "acompanhar" grava).
  await repositorio.registrarSincronizacao(WS, TJGO, publico(TJGO, ATOS_PUBLICOS), []);
  return { repositorio, servico };
}

describe('a varredura com o tribunal', () => {
  it('o ato que está no Projudi e ainda não foi publicado vira atualização, marcado como do tribunal', async () => {
    const pedidos: Array<string | undefined> = [];
    const fonte: FonteDoTribunalNaVarredura = {
      consultar: async (_w, _n, anterior) => {
        pedidos.push(anterior);
        return {
          situacao: 'atos',
          movimentos: [
            mni('2026-11-03', 9001, 11010, 'Despacho -> Mero Expediente'),
            mni('2026-11-25', 9002, 11010, 'Despacho -> Mero Expediente'),
          ],
          assinatura: 'm:a1|d:b1',
        };
      },
    };
    const { repositorio, servico } = await cenario(fonte);

    const r = await servico.sincronizar();

    expect(r.novidades).toBe(1);
    const [nova] = await repositorio.listarNovidades(WS);
    expect(nova?.data.toISOString()).toBe(dia('2026-11-25', '16:20').toISOString());
    expect(nova?.fonte).toBe('mni');
    const salvo = await repositorio.buscar(WS, TJGO);
    expect(salvo?.assinaturaDoTribunal).toBe('m:a1|d:b1');
    expect(salvo?.processo?.procedencia.provider).toBe('datajud+djen+mni');
    // O Diário segue no retrato, com o texto.
    expect(salvo?.processo?.movimentacoes.some((m) => m.idExterno === 'djen:501')).toBe(
      true,
    );

    // Na rodada seguinte a assinatura guardada vai junto, e "nada mudou" mantém os atos do tribunal.
    fonte.consultar = async (_w, _n, anterior) => {
      pedidos.push(anterior);
      return { situacao: 'sem_mudanca' };
    };
    const r2 = await servico.sincronizar();
    expect(pedidos).toEqual([undefined, 'm:a1|d:b1']);
    expect(r2.novidades).toBe(0);
    const depois = await repositorio.buscar(WS, TJGO);
    expect(depois?.processo?.movimentacoes.filter((m) => m.fonte === 'mni')).toHaveLength(
      2,
    );
  });

  it('o tribunal fora do ar não derruba a verificação: as fontes públicas valem', async () => {
    const fonte: FonteDoTribunalNaVarredura = {
      consultar: async () => {
        throw new ProviderIndisponivelError('mni', 'tempo esgotado');
      },
    };
    const { repositorio, servico } = await cenario(fonte);

    const r = await servico.sincronizar();

    expect(r.falhas).toBe(0);
    expect(r.verificados).toBe(1);
    const salvo = await repositorio.buscar(WS, TJGO);
    expect(salvo?.erro).toBeUndefined();
    expect(salvo?.assinaturaDoTribunal).toBeUndefined();
  });

  it('sem a fonte do tribunal ligada, a varredura é a de antes', async () => {
    const { repositorio, servico } = await cenario(undefined);
    const r = await servico.sincronizar();
    expect(r.novidades).toBe(0);
    const salvo = await repositorio.buscar(WS, TJGO);
    expect(salvo?.processo?.procedencia.provider).toBe('datajud+djen');
  });

  it('ligada depois de montado (como no composition root), passa a valer', async () => {
    const { repositorio, servico } = await cenario(undefined);
    servico.ligarFonteDoTribunal({
      consultar: async () => ({
        situacao: 'atos',
        movimentos: [mni('2026-11-25', 9002, 11010, 'Despacho -> Mero Expediente')],
      }),
    });
    expect((await servico.sincronizar()).novidades).toBe(1);
    expect((await repositorio.listarNovidades(WS))[0]?.fonte).toBe('mni');
  });
});
