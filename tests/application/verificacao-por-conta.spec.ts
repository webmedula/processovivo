import { describe, expect, it } from 'vitest';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { Processo } from '../../src/domain/entities/Processo.js';
import { ServicoAcompanhamento } from '../../src/application/services/ServicoAcompanhamento.js';
import { abrirBanco } from '../../src/infrastructure/persistencia/sqlite/banco.js';
import { RepositorioAcompanhamentosSqlite } from '../../src/infrastructure/persistencia/sqlite/RepositorioAcompanhamentosSqlite.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { ProviderFalso, NUMERO_TJSP_A, NUMERO_TJSP_B } from '../helpers/fabricas.js';

/**
 * v0.37.3 — o "verificando agora" é DA CONTA. A varredura global percorre todos os
 * assinantes; quem não tem processo pendente nela não pode ver o spinner girar, e
 * ninguém vê a fila dos outros. Sem rede e sem tempo real: o provedor trava em
 * promessas que o teste solta, e o relógio é injetado.
 */
const A = 'ws-a';
const B = 'ws-b';

function processo(numero: string): Processo {
  return new Processo({
    numero: NumeroCNJ.criar(numero),
    tribunal: 'TJSP',
    movimentacoes: [],
    procedencia: { provider: 't', consultadoEm: new Date(0), deCache: false },
  });
}

/** Provedor que só responde quando o teste libera aquele número. */
function provedorTravado() {
  const portoes = new Map<string, () => void>();
  const chamados: string[] = [];
  const provider = new ProviderFalso({
    nome: 'travado',
    porNumero: (numero) =>
      new Promise((resolver) => {
        chamados.push(numero);
        portoes.set(numero, () => resolver(processo(numero)));
      }),
  });
  const liberar = async (numero: string): Promise<void> => {
    for (let i = 0; i < 200 && !portoes.has(numero); i++) await Promise.resolve();
    portoes.get(numero)?.();
    portoes.delete(numero);
  };
  return { provider, liberar, chamados };
}

async function montar(opcoes: { agora?: () => Date } = {}) {
  const db = abrirBanco(':memory:');
  const repositorio = new RepositorioAcompanhamentosSqlite(db);
  const t = provedorTravado();
  const servico = new ServicoAcompanhamento({
    repositorio,
    provider: t.provider,
    logger: loggerSilencioso,
    pausaEntreConsultasMs: 0,
    ...(opcoes.agora ? { agora: opcoes.agora } : {}),
  });
  // Direto no repositório: `acompanhar` consultaria o tribunal.
  await repositorio.acompanhar(A, NumeroCNJ.criar(NUMERO_TJSP_A).digitos);
  await repositorio.acompanhar(B, NumeroCNJ.criar(NUMERO_TJSP_B).digitos);
  return { servico, ...t };
}

const nA = NumeroCNJ.criar(NUMERO_TJSP_A).digitos;
const nB = NumeroCNJ.criar(NUMERO_TJSP_B).digitos;
const virar = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

describe('estado da verificação por conta', () => {
  it('a varredura global rodando não deixa a conta B "verificando" quando o processo dela já foi', async () => {
    const { servico, liberar } = await montar();
    const varredura = servico.sincronizar();
    await virar();

    expect(servico.estadoDa(A).emAndamento).toBe(true);
    expect(servico.estadoDa(B).emAndamento).toBe(true);

    // A fila anda na ordem do banco; solta um e depois o outro.
    await liberar(nA);
    await liberar(nB);
    await virar();
    await varredura;
    expect(servico.estadoDa(A).emAndamento).toBe(false);
    expect(servico.estadoDa(B).emAndamento).toBe(false);
  });

  it('conta com os processos já verificados deixa de girar enquanto a global ainda roda para as outras', async () => {
    const { servico, liberar, chamados } = await montar();
    const varredura = servico.sincronizar();
    await virar();

    const primeiro = chamados[0] as string;
    const [dona, outra] = primeiro === nA ? [A, B] : [B, A];
    await liberar(primeiro);
    await virar();

    expect(servico.emAndamento).toBe(true); // a global segue
    expect(servico.estadoDa(dona).emAndamento).toBe(false);
    expect(servico.estadoDa(outra).emAndamento).toBe(true);

    await liberar(chamados[1] as string);
    await varredura;
  });

  it('o estado de uma conta só fala dela: pendentes não somam a fila dos outros', async () => {
    const { servico, liberar } = await montar();
    const varredura = servico.sincronizar();
    await virar();
    const e = servico.estadoDa(A);
    expect(e.pendentes).toBe(1); // nunca 2, o total da fila
    expect(JSON.stringify(e)).not.toContain(B);
    expect(servico.estadoDa('ws-sem-processos')).toEqual({
      emAndamento: false,
      pendentes: 0,
      desde: null,
      demorando: false,
    });
    await liberar(nA);
    await liberar(nB);
    await varredura;
  });

  it('"verificar agora" com uma verificação da conta em curso não dispara a segunda', async () => {
    const { servico, liberar, provider } = await montar();
    const varredura = servico.sincronizar();
    await virar();
    expect(servico.solicitar(A)).toBe('ja_em_andamento');
    expect(servico.solicitar(A)).toBe('ja_em_andamento');
    await liberar(nA);
    await liberar(nB);
    await varredura;
    await virar();
    expect(provider.chamadas.porNumero).toBe(2);
  });

  it('pedido de conta sem nada pendente espera a vez da global e roda depois, uma vez', async () => {
    const { servico, liberar, provider } = await montar();
    const varredura = servico.sincronizar();
    await virar();
    // A conta C não tem processo: o pedido entra na fila, aparece "em andamento"...
    expect(servico.solicitar('ws-c')).toBe('na_fila');
    expect(servico.estadoDa('ws-c').emAndamento).toBe(true);
    expect(servico.solicitar('ws-c')).toBe('ja_em_andamento');

    await liberar(nA);
    await liberar(nB);
    await varredura;
    await virar();
    // ...e termina sem consultar tribunal nenhum (a conta não tem processos).
    expect(servico.estadoDa('ws-c').emAndamento).toBe(false);
    expect(provider.chamadas.porNumero).toBe(2);
  });

  it('sem varredura em curso, o pedido da conta roda só os processos dela', async () => {
    const { servico, liberar, chamados } = await montar();
    expect(servico.solicitar(A)).toBe('iniciada');
    expect(servico.estadoDa(A).emAndamento).toBe(true); // já na primeira consulta de status
    await virar();
    expect(chamados).toEqual([nA]);
    await liberar(nA);
    await virar();
    expect(servico.estadoDa(A).emAndamento).toBe(false);
  });

  it('passado o limite de espera a verificação da conta é "demorando"; antes, não', async () => {
    let agora = new Date('2026-10-08T12:00:00Z');
    const { servico, liberar } = await montar({ agora: () => agora });
    const varredura = servico.sincronizar();
    await virar();

    agora = new Date(agora.getTime() + 4 * 60_000);
    expect(servico.estadoDa(A).demorando).toBe(false);
    agora = new Date(agora.getTime() + 2 * 60_000); // 6 min
    const e = servico.estadoDa(A);
    expect(e.demorando).toBe(true);
    expect(e.desde?.toISOString()).toBe('2026-10-08T12:00:00.000Z');

    await liberar(nA);
    await liberar(nB);
    await varredura;
    expect(servico.estadoDa(A).demorando).toBe(false);
    expect(servico.estadoDa(A).desde).toBeNull();
  });

  it('falha no meio da fila não deixa a conta "verificando" para sempre', async () => {
    const db = abrirBanco(':memory:');
    const repositorio = new RepositorioAcompanhamentosSqlite(db);
    const servico = new ServicoAcompanhamento({
      repositorio,
      provider: new ProviderFalso({
        nome: 'quebra',
        porNumero: async () => {
          throw new Error('fora do ar');
        },
      }),
      logger: loggerSilencioso,
      pausaEntreConsultasMs: 0,
    });
    await repositorio.acompanhar(A, nA);
    const r = await servico.sincronizar();
    expect(r.falhas).toBe(1);
    expect(servico.estadoDa(A).emAndamento).toBe(false);
  });
});
