import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { ServicoNotificacao } from '../../src/application/services/ServicoNotificacao.js';
import { ServicoVigilanciaOab } from '../../src/application/services/ServicoVigilanciaOab.js';
import type { BuscaPorOabComPeriodo } from '../../src/application/services/ServicoVigilanciaOab.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioNotificacaoSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioNotificacaoSqlite.js';
import { RepositorioVigilanciasSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioVigilanciasSqlite.js';
import { NotificadorEspiao } from '../helpers/aplicacao.js';
import { NUMERO_TJSP_A, NUMERO_TJSP_B } from '../helpers/fabricas.js';

const WS = 'workspace-a';
const AGORA = new Date('2026-09-05T12:00:00Z');

function processoDjen(
  numero: string,
  movimentacoes: Array<{ dia: string; titulo: string; id: string; conteudo?: string }>,
): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJSP',
    vara: '1ª Vara Cível',
    classe: 'Procedimento Comum Cível',
    partes: [
      { nome: 'FULANO', polo: 'ATIVO', tipoPessoa: 'DESCONHECIDO', advogados: [] },
    ],
    movimentacoes: movimentacoes.map((m) => ({
      data: new Date(`${m.dia}T00:00:00-03:00`),
      titulo: m.titulo,
      idExterno: `djen:${m.id}`,
      ...(m.conteudo ? { conteudo: m.conteudo } : {}),
    })),
    procedencia: { provider: 'djen', consultadoEm: AGORA, deCache: false },
  });
}

/** Dublê do DJEN: devolve o que o teste mandar, e registra o período pedido. */
class BuscaFalsa implements BuscaPorOabComPeriodo {
  readonly periodos: Array<{ de?: string; ate?: string }> = [];
  resposta: Processo[] = [];

  async buscarPorOabNoPeriodo(
    _oab: string,
    _uf: string,
    periodo: { de?: string; ate?: string },
  ): Promise<Processo[]> {
    this.periodos.push(periodo);
    return this.resposta;
  }
}

describe('vigilância contínua por OAB', () => {
  let db: DatabaseSync;
  let acomp: RepositorioAcompanhamentosSqlite;
  let busca: BuscaFalsa;
  let servico: ServicoVigilanciaOab;

  beforeEach(() => {
    db = abrirBanco(':memory:');
    acomp = new RepositorioAcompanhamentosSqlite(db);
    busca = new BuscaFalsa();
    servico = new ServicoVigilanciaOab({
      vigilancias: new RepositorioVigilanciasSqlite(db),
      acompanhamentos: acomp,
      busca,
      logger: loggerSilencioso,
      pausaMs: 0,
      agora: () => AGORA,
    });
  });
  afterEach(() => db.close());

  it('traz para a carteira processo que ninguém digitou', async () => {
    // A virada do produto: o advogado cadastra a inscrição e o processo novo
    // entra sozinho.
    busca.resposta = [processoDjen(NUMERO_TJSP_A, [{ dia: '2026-09-04', titulo: 'Decisão', id: '1' }])];
    await servico.vigiar(WS, '47383', 'GO');

    const r = await servico.varrer();

    expect(r.processosNovos).toBe(1);
    const lista = await acomp.listar(WS);
    expect(lista.map((a) => a.numero)).toEqual([NumeroCNJ.criar(NUMERO_TJSP_A).digitos]);
  });

  it('processo que acabou de entrar NÃO vira novidade', async () => {
    // Tudo nele é novo; avisar tudo seria avisar nada.
    busca.resposta = [
      processoDjen(NUMERO_TJSP_A, [
        { dia: '2026-09-04', titulo: 'Decisão', id: '1' },
        { dia: '2026-09-01', titulo: 'Despacho', id: '2' },
      ]),
    ];
    await servico.vigiar(WS, '47383', 'GO');
    await servico.varrer();

    expect(await acomp.contarNaoVistas(WS)).toBe(0);
  });

  it('publicação inédita em processo já seguido vira novidade', async () => {
    busca.resposta = [processoDjen(NUMERO_TJSP_A, [{ dia: '2026-09-01', titulo: 'Despacho', id: '2' }])];
    await servico.vigiar(WS, '47383', 'GO');
    await servico.varrer();

    busca.resposta = [
      processoDjen(NUMERO_TJSP_A, [
        { dia: '2026-09-01', titulo: 'Despacho', id: '2' },
        { dia: '2026-09-04', titulo: 'Decisão', id: '3' },
      ]),
    ];
    const r = await servico.varrer();

    expect(r.novidades).toBe(1);
    expect(await acomp.contarNaoVistas(WS)).toBe(1);
  });

  it('a varredura NÃO encolhe a linha do tempo já guardada', async () => {
    // O DJEN só conhece o que foi publicado. Se substituísse o retrato, os
    // andamentos internos que o DataJud trouxe sumiriam — e o advogado
    // concluiria que o processo parou.
    const comHistorico = new Processo({
      numero: NumeroCNJ.criar(NUMERO_TJSP_A),
      tribunal: 'TJSP',
      movimentacoes: [
        { data: new Date('2026-08-01T10:00:00Z'), titulo: 'Juntada de petição' },
        { data: new Date('2026-07-01T10:00:00Z'), titulo: 'Conclusos' },
        { data: new Date('2026-06-01T10:00:00Z'), titulo: 'Distribuição' },
      ],
      procedencia: { provider: 'datajud', consultadoEm: AGORA, deCache: false },
    });
    await acomp.acompanhar(WS, NumeroCNJ.criar(NUMERO_TJSP_A).digitos);
    await acomp.registrarSincronizacao(
      WS,
      NumeroCNJ.criar(NUMERO_TJSP_A).digitos,
      comHistorico,
      [],
    );

    busca.resposta = [processoDjen(NUMERO_TJSP_A, [{ dia: '2026-09-04', titulo: 'Decisão', id: '9' }])];
    await servico.vigiar(WS, '47383', 'GO');
    await servico.varrer();

    const depois = await acomp.buscar(WS, NumeroCNJ.criar(NUMERO_TJSP_A).digitos);
    expect(depois?.processo?.movimentacoes.length).toBe(4);
  });

  it('a primeira varredura pede 30 dias; a segunda, a janela curta', async () => {
    await servico.vigiar(WS, '47383', 'GO');
    await servico.varrer();
    await servico.varrer();

    expect(busca.periodos).toHaveLength(2);
    const [primeira, segunda] = busca.periodos;
    expect(primeira?.de).toBe('2026-08-06');
    expect(segunda?.de).toBe('2026-09-03');
  });

  it('falha numa inscrição não interrompe as outras nem marca como varrida', async () => {
    // Marcar como varrido depois de falhar abriria um buraco silencioso
    // exatamente no período em que a fonte esteve fora.
    const vigRepo = new RepositorioVigilanciasSqlite(db);
    await servico.vigiar(WS, '47383', 'GO');

    const quebrada = new ServicoVigilanciaOab({
      vigilancias: vigRepo,
      acompanhamentos: acomp,
      busca: {
        buscarPorOabNoPeriodo: async () => {
          throw new Error('DJEN fora do ar');
        },
      },
      logger: loggerSilencioso,
      pausaMs: 0,
      agora: () => AGORA,
    });

    const r = await quebrada.varrer();

    expect(r.falhas).toBe(1);
    const [v] = await vigRepo.listar(WS);
    expect(v?.varridaEm).toBeUndefined();
    expect(v?.erro).toContain('DJEN fora do ar');
  });

  it('vigiar a mesma inscrição duas vezes não cria duas varreduras', async () => {
    await servico.vigiar(WS, '47383', 'GO');
    await servico.vigiar(WS, '47.383', 'go');
    expect(await servico.listar(WS)).toHaveLength(1);
  });

  it('parar desliga sem apagar o histórico', async () => {
    await servico.vigiar(WS, '47383', 'GO');
    expect(await servico.parar(WS, '47383', 'GO')).toBe(true);

    const [v] = await servico.listar(WS);
    expect(v?.ativa).toBe(false);
    await servico.varrer();
    expect(busca.periodos).toHaveLength(0);
  });
});

describe('notificação', () => {
  let db: DatabaseSync;
  let acomp: RepositorioAcompanhamentosSqlite;
  let prefs: RepositorioNotificacaoSqlite;
  let espiao: NotificadorEspiao;
  let agora: Date;
  let servico: ServicoNotificacao;

  beforeEach(async () => {
    db = abrirBanco(':memory:');
    acomp = new RepositorioAcompanhamentosSqlite(db);
    prefs = new RepositorioNotificacaoSqlite(db);
    espiao = new NotificadorEspiao();
    // O relógio dos testes parte do relógio REAL, e não de uma data fixa.
    // Motivo: o repositório carimba `detectada_em` com `new Date()` — não tem
    // Clock injetável — enquanto o serviço usa o relógio que recebe. Com uma
    // data fixa no passado, "enviado às 12h" ficava ANTES de "detectado agora"
    // e toda novidade era reenviada para sempre. Em produção os dois relógios
    // são o mesmo e o problema não existe; aqui, precisam concordar.
    agora = new Date();
    servico = new ServicoNotificacao({
      preferencias: prefs,
      acompanhamentos: acomp,
      notificador: espiao,
      logger: loggerSilencioso,
      urlBase: 'https://processovivo.exemplo',
      agora: () => agora,
    });
  });
  afterEach(() => db.close());

  async function comNovidades(quantas: number): Promise<void> {
    const numero = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
    await acomp.acompanhar(WS, numero);
    const p = processoDjen(NUMERO_TJSP_A, []);
    await acomp.registrarSincronizacao(
      WS,
      numero,
      p,
      Array.from({ length: quantas }, (_, i) => ({
        data: new Date(`2026-09-0${i + 1}T00:00:00-03:00`),
        titulo: `Decisão ${i + 1}`,
        conteudo: 'Manifeste-se no prazo de 15 dias.',
      })),
    );
  }

  it('não envia nada sem endereço configurado', async () => {
    await comNovidades(2);
    expect(await servico.despachar()).toEqual({ enviados: 0, alertas: 0 });
    expect(espiao.enviadas).toHaveLength(0);
  });

  it('ligar o aviso sem endereço não liga nada', async () => {
    // Configuração que nunca vai avisar ninguém e ainda passa sensação de
    // proteção é pior do que estar claramente desligada.
    const p = await prefs.salvar(WS, undefined, true);
    expect(p.ativa).toBe(false);
  });

  it('agrupa várias novidades num e-mail só', async () => {
    // Uma varredura que descobre seis novidades deve render um e-mail, não seis.
    await prefs.salvar(WS, 'joao@exemplo.com', true);
    await comNovidades(3);

    const r = await servico.despachar();

    expect(r.enviados).toBe(1);
    expect(espiao.enviadas).toHaveLength(1);
    // Reescrito na v0.63.0: o assunto conta PROCESSOS (uma linha cada), e as três
    // novidades do teste são do mesmo processo — antes contava as três novidades.
    expect(espiao.enviadas[0]?.assunto).toBe('Processo Vivo: 1 atualização nos seus processos');
  });

  it('o corpo NÃO traz o trecho do teor: só número, tipo e data', async () => {
    // Reescrito na v0.63.0 (decisão do dono): antes o teste exigia o trecho do
    // teor no e-mail; agora o e-mail é uma lista curta e o teor fica no app.
    await prefs.salvar(WS, 'joao@exemplo.com', true);
    await comNovidades(1);
    await servico.despachar();

    expect(espiao.enviadas[0]?.texto).not.toContain('prazo de 15 dias');
    expect(espiao.enviadas[0]?.html).not.toContain('prazo de 15 dias');
  });

  it('não repete o que já foi enviado', async () => {
    await prefs.salvar(WS, 'joao@exemplo.com', true);
    await comNovidades(2);
    // Em produção o despacho acontece DEPOIS da detecção; o relógio do teste
    // precisa refletir isso, senão o envio é carimbado antes do que ele avisa.
    agora = new Date();
    await servico.despachar();

    agora = new Date(agora.getTime() + 3_600_000);
    const r = await servico.despachar();

    expect(r.enviados).toBe(0);
  });

  it('avisa quando faz tempo demais que NÃO conseguimos verificar', async () => {
    // A obrigação que quase todo produto esquece: silêncio precisa ser
    // explicado, senão o advogado lê silêncio como "não houve nada".
    await prefs.salvar(WS, 'joao@exemplo.com', true);
    await servico.marcarVarreduraOk();

    agora = new Date(agora.getTime() + 48 * 3_600_000);
    const r = await servico.despachar();

    expect(r.alertas).toBe(1);
    expect(espiao.enviadas[0]?.assunto).toContain('sem verificar');
    expect(espiao.enviadas[0]?.texto).toContain('NÃO significa que não houve movimentação');
  });

  it('não repete o alerta de silêncio a cada ciclo', async () => {
    await prefs.salvar(WS, 'joao@exemplo.com', true);
    await servico.marcarVarreduraOk();

    agora = new Date(agora.getTime() + 48 * 3_600_000);
    await servico.despachar();
    agora = new Date(agora.getTime() + 3_600_000);
    const r = await servico.despachar();

    expect(r.alertas).toBe(0);
  });

  it('varredura recente não dispara alerta', async () => {
    await prefs.salvar(WS, 'joao@exemplo.com', true);
    await servico.marcarVarreduraOk();

    agora = new Date(agora.getTime() + 8 * 3_600_000);
    expect((await servico.despachar()).alertas).toBe(0);
  });

  it('dois workspaces não recebem a novidade um do outro', async () => {
    await prefs.salvar(WS, 'joao@exemplo.com', true);
    await prefs.salvar('outro-ws', 'maria@exemplo.com', true);
    await comNovidades(1);

    await servico.despachar();

    expect(espiao.enviadas.map((e) => e.para)).toEqual(['joao@exemplo.com']);
  });

  it('o e-mail nunca anuncia nem afirma prazo', async () => {
    // Reescrito na v0.63.0: o aviso "a conferência do prazo continua sendo sua"
    // saiu junto com o parágrafo explicativo; a garantia que importa é que a
    // palavra "prazo" não apareça, nem para afirmar nem para negar.
    await prefs.salvar(WS, 'joao@exemplo.com', true);
    await comNovidades(1);
    await servico.despachar();

    expect(espiao.enviadas[0]?.texto.toLowerCase()).not.toContain('prazo');
    expect(espiao.enviadas[0]?.html?.toLowerCase()).not.toContain('prazo');
  });
});

describe('isolamento entre workspaces na vigilância', () => {
  it('cada workspace vigia a sua inscrição', async () => {
    const db = abrirBanco(':memory:');
    const repo = new RepositorioVigilanciasSqlite(db);

    await repo.vigiar('ws-a', '47383', 'GO');
    await repo.vigiar('ws-b', '11111', 'SP');

    expect(await repo.listar('ws-a')).toHaveLength(1);
    expect((await repo.listar('ws-b'))[0]?.oab.uf).toBe('SP');
    expect(await repo.listarParaVarrer(10)).toHaveLength(2);
    db.close();
  });
});

// Mantém NUMERO_TJSP_B em uso: a fábrica exporta os dois e o lint reclama de
// import não usado se um deles sumir do arquivo.
void NUMERO_TJSP_B;
