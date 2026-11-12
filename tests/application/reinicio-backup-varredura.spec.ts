import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessoSearchService } from '../../src/application/services/ProcessoSearchService.js';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import { ServicoVigilanciaOab } from '../../src/application/services/ServicoVigilanciaOab.js';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import {
  OperacaoNaoSuportadaError,
  ProcessoNaoEncontradoError,
  ProviderIndisponivelError,
  RespostaInvalidaError,
  TodasAsFontesFalharamError,
} from '../../src/domain/errors/index.js';
import { Agendador } from '../../src/infrastructure/agenda/Agendador.js';
import {
  MarcasDeVarredura,
  varreduraRetomavel,
} from '../../src/infrastructure/agenda/retomadaDeVarredura.js';
import type { MarcasDaVarredura } from '../../src/infrastructure/agenda/retomadaDeVarredura.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import {
  escolherBackupsParaApagar,
  gerarBackup,
  listarBackups,
  pastaDeBackups,
  ultimoBackupEm,
} from '../../src/infrastructure/persistencia/backup.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { RepositorioNotificacaoSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioNotificacaoSqlite.js';
import { RepositorioVigilanciasSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioVigilanciasSqlite.js';
import { LoggerColetor } from '../helpers/analiseIa.js';
import { numeroValido } from '../helpers/atualizacoesSinteticas.js';
import { NUMERO_TJSP_A, ProviderFalso } from '../helpers/fabricas.js';

/*
 * v0.67.3 — reiniciar o app não pode apagar histórico de backup, repetir a varredura nem transformar falha de rede em
 * "não encontrado". Tudo com relógio falso (`vi.useFakeTimers`) e sem rede; números e contas sintéticos.
 */
const HORA = 3_600_000;
const AGORA = new Date('2026-11-12T12:00:00.000Z');
const nome = (iso: string): string => `processovivo-${iso}.db`;

describe('backup: retenção por dia', () => {
  const DIARIOS = [
    nome('2026-11-06T20-52-29Z'),
    nome('2026-11-07T20-52-29Z'),
    nome('2026-11-08T20-52-31Z'),
    nome('2026-11-09T20-52-31Z'),
    nome('2026-11-10T20-52-31Z'),
    nome('2026-11-11T20-52-31Z'),
  ];

  it('cinco subidas no mesmo dia não removem nenhum backup de dias anteriores', () => {
    let pasta = [...DIARIOS];
    for (const hora of ['11-15-00', '11-24-00', '11-30-00', '12-33-00', '13-00-00']) {
      pasta.push(nome(`2026-11-12T${hora}Z`));
      const apagar = escolherBackupsParaApagar(pasta, 7);
      pasta = pasta.filter((f) => !apagar.includes(f));
    }
    // Os seis dias anteriores intactos e, de hoje, só a cópia mais recente.
    expect(pasta.sort()).toEqual([...DIARIOS, nome('2026-11-12T13-00-00Z')]);
  });

  it('o extra do mesmo dia sai antes de qualquer dia anterior, e a última cópia do dia fica', () => {
    const pasta = [...DIARIOS, nome('2026-11-12T11-15-00Z'), nome('2026-11-12T11-24-00Z')];
    expect(escolherBackupsParaApagar(pasta, 7)).toEqual([nome('2026-11-12T11-15-00Z')]);
  });

  it('com uma cópia por dia, sai o dia mais antigo', () => {
    const pasta = [...DIARIOS, nome('2026-11-12T20-52-00Z'), nome('2026-11-13T20-52-00Z')];
    expect(escolherBackupsParaApagar(pasta, 7)).toEqual([DIARIOS[0]]);
  });

  it('abaixo do limite nada sai, mesmo com extras no dia', () => {
    const pasta = [nome('2026-11-12T11-15-00Z'), nome('2026-11-12T11-24-00Z')];
    expect(escolherBackupsParaApagar(pasta, 7)).toEqual([]);
  });

  describe('em disco', () => {
    let pasta: string;
    let banco: string;
    beforeEach(() => {
      pasta = mkdtempSync(join(tmpdir(), 'processovivo-reinicio-'));
      banco = join(pasta, 'processovivo.db');
      abrirBanco(banco).close();
    });
    afterEach(() => rmSync(pasta, { recursive: true, force: true }));

    it('gerar várias cópias no mesmo dia preserva as dos dias anteriores', () => {
      for (let dia = 5; dia <= 11; dia++) {
        const dd = String(dia).padStart(2, '0');
        gerarBackup({ caminhoBanco: banco, agora: () => new Date(`2026-11-${dd}T20:52:00Z`) });
      }
      const apagados: string[] = [];
      for (const hora of ['11:15', '11:24', '11:30', '12:33', '13:00']) {
        const r = gerarBackup({
          caminhoBanco: banco,
          agora: () => new Date(`2026-11-12T${hora}:00Z`),
        });
        apagados.push(...r.apagados);
      }
      // A primeira cópia de hoje tira o dia mais antigo (são 8 dias para 7 vagas);
      // as outras quatro só tiram extras de hoje.
      expect(apagados.filter((f) => !f.includes('2026-11-12'))).toEqual([
        nome('2026-11-05T20-52-00Z'),
      ]);
      const dias = listarBackups(pastaDeBackups(banco)).map((c) => c.arquivo.slice(13, 23));
      expect(dias).toEqual([
        '2026-11-12',
        '2026-11-11',
        '2026-11-10',
        '2026-11-09',
        '2026-11-08',
        '2026-11-07',
        '2026-11-06',
      ]);
    });

    it('lê do nome do arquivo o instante da cópia mais recente', () => {
      expect(ultimoBackupEm(pastaDeBackups(banco))).toBeUndefined();
      gerarBackup({ caminhoBanco: banco, agora: () => new Date('2026-11-11T20:52:31Z') });
      expect(ultimoBackupEm(pastaDeBackups(banco))?.toISOString()).toBe(
        '2026-11-11T20:52:31.000Z',
      );
    });
  });
});

describe('agendador: reinício não repete a tarefa', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AGORA);
  });
  afterEach(() => vi.useRealTimers());

  function agendar(ultima: Date | undefined, intervaloHoras = 24) {
    const log = new LoggerColetor();
    let execucoes = 0;
    const agendador = new Agendador({
      intervaloHoras,
      logger: log,
      tarefa: async () => {
        execucoes++;
      },
      ultimaExecucaoEm: () => ultima,
      avisoAoAdiar: 'backup pulado na subida',
    });
    agendador.iniciar();
    return { log, agendador, execucoes: () => execucoes };
  }

  it('subir com o último backup de 1 h não faz backup, e o próximo sai ao completar 24 h', async () => {
    const a = agendar(new Date(AGORA.getTime() - HORA));
    await vi.advanceTimersByTimeAsync(22 * HORA + 59 * 60_000);
    expect(a.execucoes()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.execucoes()).toBe(1);
    // Daí em diante, o intervalo de sempre.
    await vi.advanceTimersByTimeAsync(24 * HORA);
    expect(a.execucoes()).toBe(2);
    expect(a.log.linhas.join('\n')).toMatch(/backup pulado na subida .*"idadeHoras":1\b/);
    a.agendador.parar();
  });

  it('subir com o último backup de 25 h faz o backup no atraso de sempre (120 s)', async () => {
    const a = agendar(new Date(AGORA.getTime() - 25 * HORA));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(a.execucoes()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(a.execucoes()).toBe(1);
    expect(a.log.linhas.join('\n')).not.toContain('pulado');
    a.agendador.parar();
  });

  it('sem registro, e com leitura que falha, mantém a primeira execução em 120 s', async () => {
    const a = agendar(undefined);
    const log = new LoggerColetor();
    let comFalha = 0;
    const b = new Agendador({
      intervaloHoras: 24,
      logger: log,
      tarefa: async () => {
        comFalha++;
      },
      ultimaExecucaoEm: () => {
        throw new Error('disco fora');
      },
    });
    b.iniciar();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(a.execucoes()).toBe(1);
    expect(comFalha).toBe(1);
    a.agendador.parar();
    b.parar();
  });

  it('marca no futuro não adia além de um intervalo', async () => {
    const a = agendar(new Date(AGORA.getTime() + 72 * HORA));
    await vi.advanceTimersByTimeAsync(24 * HORA);
    expect(a.execucoes()).toBe(1);
    a.agendador.parar();
  });
});

describe('varredura: reinício não repete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AGORA);
  });
  afterEach(() => vi.useRealTimers());

  function marcasEmMemoria(inicio?: Date, fim?: Date): MarcasDaVarredura {
    return {
      iniciadaEm: () => inicio,
      concluidaEm: () => fim,
      marcarInicio: (q) => {
        inicio = q;
      },
      marcarFim: (q) => {
        fim = q;
      },
    };
  }

  function subir(marcas: MarcasDaVarredura, intervaloHoras = 12) {
    const cortes: Array<Date | undefined> = [];
    const varredura = varreduraRetomavel({
      marcas,
      intervaloHoras,
      executar: async (corte) => {
        cortes.push(corte);
      },
    });
    const agendador = new Agendador({
      intervaloHoras,
      logger: loggerSilencioso,
      tarefa: varredura.tarefa,
      ultimaExecucaoEm: varredura.ultimaExecucaoEm,
    });
    agendador.iniciar();
    return { cortes, agendador };
  }

  it('subir 10 min depois de uma varredura concluída não varre antes do intervalo', async () => {
    const fim = new Date(AGORA.getTime() - 10 * 60_000);
    const s = subir(marcasEmMemoria(new Date(fim.getTime() - 30 * 60_000), fim));
    await vi.advanceTimersByTimeAsync(11 * HORA + 49 * 60_000);
    expect(s.cortes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    // Varredura normal: nada é pulado.
    expect(s.cortes).toEqual([undefined]);
    s.agendador.parar();
  });

  it('varredura interrompida retoma já na subida, pulando o que foi verificado no intervalo, e só na primeira', async () => {
    const marcas = marcasEmMemoria(
      new Date(AGORA.getTime() - 5 * 60_000),
      new Date(AGORA.getTime() - 12 * HORA),
    );
    const s = subir(marcas);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.cortes).toHaveLength(1);
    expect(s.cortes[0]?.getTime()).toBe(AGORA.getTime() + 120_000 - 12 * HORA);
    expect(marcas.concluidaEm()?.getTime()).toBe(AGORA.getTime() + 120_000);
    await vi.advanceTimersByTimeAsync(12 * HORA);
    expect(s.cortes[1]).toBeUndefined();
    s.agendador.parar();
  });

  it('sem registro nenhum, a primeira varredura sai em 120 s, completa', async () => {
    const s = subir(marcasEmMemoria());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.cortes).toEqual([undefined]);
    s.agendador.parar();
  });

  it('varredura que falha não é marcada como concluída', async () => {
    const marcas = marcasEmMemoria();
    const v = varreduraRetomavel({
      marcas,
      intervaloHoras: 12,
      executar: async () => {
        throw new Error('fonte fora');
      },
    });
    await expect(v.tarefa()).rejects.toThrow('fonte fora');
    expect(marcas.iniciadaEm()).toBeDefined();
    expect(marcas.concluidaEm()).toBeUndefined();
    expect(v.ultimaExecucaoEm()).toBeUndefined();
  });

  it('as marcas ficam no banco e a de processos aproveita a marca que já existia', async () => {
    const db = abrirBanco(':memory:');
    const marcas = new MarcasDeVarredura(db, 'processos', 'ultima_varredura_ok');
    expect(marcas.concluidaEm()).toBeUndefined();
    // O que as versões anteriores já gravavam ao fim de cada varredura.
    const antiga = new Date(AGORA.getTime() - 3 * HORA);
    await new RepositorioNotificacaoSqlite(db).registrarVarreduraOk(antiga);
    expect(marcas.concluidaEm()?.getTime()).toBe(antiga.getTime());
    marcas.marcarInicio(AGORA);
    marcas.marcarFim(new Date(AGORA.getTime() + 60_000));
    const relida = new MarcasDeVarredura(db, 'processos', 'ultima_varredura_ok');
    expect(relida.iniciadaEm()?.getTime()).toBe(AGORA.getTime());
    expect(relida.concluidaEm()?.getTime()).toBe(AGORA.getTime() + 60_000);
    // A de OAB não se mistura.
    expect(new MarcasDeVarredura(db, 'oab').concluidaEm()).toBeUndefined();
    db.close();
  });

  it('a retomada da varredura de processos consulta só os pendentes', async () => {
    const WS = 'ws-a';
    const numeros = [1, 2, 3].map((i) => NumeroCNJ.criar(numeroValido(7700 + i, '26', '0100')).digitos);
    const db = abrirBanco(':memory:');
    const repositorio = new RepositorioAcompanhamentosSqlite(db);
    for (const n of numeros) await repositorio.acompanhar(WS, n);
    const consultados: string[] = [];
    const falham = new Set<string>();
    const log = new LoggerColetor();
    const servico = new ServicoAcompanhamento({
      repositorio,
      logger: log,
      pausaEntreConsultasMs: 0,
      provider: new ProviderFalso({
        nome: 'datajud',
        porNumero: async (numero) => {
          consultados.push(numero);
          if (falham.has(numero)) throw new ProviderIndisponivelError('datajud', 'timeout');
          return new Processo({
            numero: NumeroCNJ.criar(numero),
            tribunal: 'TJSP',
            movimentacoes: [],
            procedencia: { provider: 'datajud', consultadoEm: new Date(0), deCache: false },
          });
        },
      }),
    });

    // Varredura de ontem: os três verificados.
    vi.setSystemTime(new Date(AGORA.getTime() - 24 * HORA));
    await servico.sincronizar();
    // A de hoje verifica o 1º, falha no 2º e o processo morre antes do 3º.
    vi.setSystemTime(new Date(AGORA.getTime() - 5 * 60_000));
    const primeiro = numeros[0] as string;
    const segundo = numeros[1] as string;
    await repositorio.registrarSincronizacao(
      WS,
      primeiro,
      (await repositorio.buscar(WS, primeiro))?.processo as Processo,
      [],
    );
    await repositorio.registrarFalha(WS, segundo, 'TODAS_AS_FONTES_FALHARAM: x');

    vi.setSystemTime(AGORA);
    consultados.length = 0;
    const r = await servico.sincronizar({
      pularVerificadosDesde: new Date(AGORA.getTime() - 12 * HORA),
    });

    // Sucesso recente fica de fora; falha recente e o não tentado voltam.
    expect(consultados.sort()).toEqual([segundo, numeros[2]].sort());
    expect(r.total).toBe(2);
    expect(log.linhas.join('\n')).toMatch(/varredura iniciada .*"retomada":true,"jaVerificados":1/);

    // Sem a opção, a varredura é a de sempre: todos.
    consultados.length = 0;
    await servico.sincronizar();
    expect(consultados).toHaveLength(3);
    db.close();
  });

  it('a retomada da varredura de OAB não volta à inscrição já varrida no intervalo', async () => {
    const db = abrirBanco(':memory:');
    const consultadas: string[] = [];
    let agora = new Date(AGORA.getTime() - 20 * 60_000);
    const servico = new ServicoVigilanciaOab({
      vigilancias: new RepositorioVigilanciasSqlite(db),
      acompanhamentos: new RepositorioAcompanhamentosSqlite(db),
      busca: {
        buscarPorOabNoPeriodo: async (oab: string) => {
          consultadas.push(oab);
          return [];
        },
      },
      logger: loggerSilencioso,
      pausaMs: 0,
      agora: () => agora,
    });
    await servico.vigiar('ws-a', '90001', 'GO');
    await servico.varrer();
    await servico.vigiar('ws-b', '90002', 'GO');

    agora = AGORA;
    consultadas.length = 0;
    await servico.varrer({ pularVarridasDesde: new Date(AGORA.getTime() - HORA) });
    expect(consultadas).toEqual(['90002']);
    db.close();
  });
});

describe('orquestrador: "não encontrado" só quando é de verdade', () => {
  type Caso = 'ok' | 'nao_existe' | 'timeout' | 'rede' | 'limite' | '5xx' | 'invalida' | 'nao_suporta';
  const fonte = (nomeDaFonte: string, caso: Caso): ProviderFalso =>
    new ProviderFalso({
      nome: nomeDaFonte,
      ...(caso === 'ok'
        ? {}
        : {
            porNumero: async () => {
              switch (caso) {
                case 'nao_existe':
                  throw new ProcessoNaoEncontradoError('numero', nomeDaFonte);
                case 'timeout':
                  throw new ProviderIndisponivelError(nomeDaFonte, 'timeout');
                case 'rede':
                  throw new ProviderIndisponivelError(nomeDaFonte, 'falha de rede');
                case 'limite':
                  throw new ProviderIndisponivelError(
                    nomeDaFonte,
                    'limite de requisições excedido',
                  );
                case '5xx':
                  throw new ProviderIndisponivelError(nomeDaFonte, 'HTTP 503');
                case 'invalida':
                  throw new RespostaInvalidaError(nomeDaFonte, 'corpo não é JSON válido');
                default:
                  throw new OperacaoNaoSuportadaError(nomeDaFonte, 'buscarPorNumero');
              }
            },
          }),
    });

  const PASSAGEIRO = 'TODAS_AS_FONTES_FALHARAM';
  const NAO_EXISTE = 'PROCESSO_NAO_ENCONTRADO';
  const tabela: Array<[Caso, Caso, string]> = [
    // datajud, djen, resultado
    ['nao_existe', 'nao_existe', NAO_EXISTE],
    ['nao_existe', 'nao_suporta', NAO_EXISTE],
    ['nao_suporta', 'nao_existe', NAO_EXISTE],
    // Os dois casos do log de produção.
    ['limite', 'rede', PASSAGEIRO],
    ['limite', 'timeout', PASSAGEIRO],
    // Uma fonte diz "não tenho" e a outra não conseguiu responder: não prova nada.
    ['limite', 'nao_existe', PASSAGEIRO],
    ['timeout', 'nao_existe', PASSAGEIRO],
    ['rede', 'nao_existe', PASSAGEIRO],
    ['5xx', 'nao_existe', PASSAGEIRO],
    ['invalida', 'nao_existe', PASSAGEIRO],
    ['nao_existe', 'limite', PASSAGEIRO],
    ['nao_existe', 'timeout', PASSAGEIRO],
    ['nao_existe', 'rede', PASSAGEIRO],
    ['nao_existe', '5xx', PASSAGEIRO],
    ['timeout', 'timeout', PASSAGEIRO],
    ['5xx', '5xx', PASSAGEIRO],
    ['rede', '5xx', PASSAGEIRO],
    // Sucesso de qualquer uma é sucesso.
    ['ok', 'rede', 'ok'],
    ['limite', 'ok', 'ok'],
    ['nao_existe', 'ok', 'ok'],
    ['5xx', 'ok', 'ok'],
  ];

  it.each(tabela)('datajud %s + djen %s → %s', async (datajud, djen, esperado) => {
    const servico = new ProcessoSearchService({
      providers: [fonte('datajud', datajud), fonte('djen', djen)],
    });
    const resultado = await servico.buscarPorNumero(NUMERO_TJSP_A).then(
      () => 'ok',
      (erro: unknown) => (erro as { codigo?: string }).codigo ?? String(erro),
    );
    expect(resultado).toBe(esperado);
  });

  it('o erro passageiro guarda o "não encontrado" da outra fonte entre as tentativas', async () => {
    const servico = new ProcessoSearchService({
      providers: [fonte('datajud', 'limite'), fonte('djen', 'nao_existe')],
    });
    const erro = await servico.buscarPorNumero(NUMERO_TJSP_A).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(TodasAsFontesFalharamError);
    expect((erro as TodasAsFontesFalharamError).tentativas).toEqual([
      expect.objectContaining({ provider: 'datajud' }),
      { provider: 'djen', erro: 'não encontrado' },
    ]);
  });

  it('health check negativo conta como fonte que não respondeu', async () => {
    const servico = new ProcessoSearchService({
      verificarSaude: true,
      providers: [
        new ProviderFalso({ nome: 'datajud', saudavel: false }),
        fonte('djen', 'nao_existe'),
      ],
    });
    await expect(servico.buscarPorNumero(NUMERO_TJSP_A)).rejects.toBeInstanceOf(
      TodasAsFontesFalharamError,
    );
  });
});
