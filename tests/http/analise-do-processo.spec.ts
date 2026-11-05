import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import {
  AnalisadorDePecaFalso,
  PAGINAS_DA_PECA,
  respostaDaPeca,
} from '../helpers/analiseDePeca.js';
import {
  PAGINA_DA_CONTESTACAO,
  respostaDaContestacao,
  respostaDaSintese,
  SintetizadorFalso,
} from '../helpers/analiseDoProcesso.js';
import { NOME_DA_PARTE } from '../helpers/analiseIa.js';
import { ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import {
  PROCESSO_TJGO,
  ProvedorDeLoteFalso,
  pastaTemporaria,
} from '../helpers/leitor.js';
import { pdfComPaginas } from '../helpers/pdfDePecas.js';

/* Rotas da análise do processo pelas peças: peças sintéticas, os dois modelos são dublês, nenhuma rede. */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const WS_A = workspaceDaChave(CHAVE_A);
const WS_B = workspaceDaChave(CHAVE_B);
const NUM = PROCESSO_TJGO;

let dir: ReturnType<typeof pastaTemporaria>;
let servidor: FastifyInstance;
let app: Aplicacao;
let analisador: AnalisadorDePecaFalso;
let sintetizador: SintetizadorFalso;

afterEach(async () => {
  await app.analiseDoProcesso?.aguardarOcioso();
  await servidor.close();
  dir?.apagar();
});

async function montar(m: { semRecurso?: boolean } = {}): Promise<void> {
  dir = pastaTemporaria();
  analisador = new AnalisadorDePecaFalso();
  analisador.resposta = async () => {
    const u = analisador.pedidos[analisador.pedidos.length - 1]?.usuario ?? '';
    return {
      resposta: u.includes('CONTESTACAO') ? respostaDaContestacao() : respostaDaPeca(),
      modelo: 'modelo/teste',
      provedor: 'provedor-teste',
    };
  };
  sintetizador = new SintetizadorFalso();
  sintetizador.responderCom(
    respostaDaSintese({
      linha_do_tempo: [{ texto: '[PARTE A] pede a restituição', refs: ['P1.pedido1'] }],
    }),
  );
  const provedor = new ProvedorDeLoteFalso([
    { id: 'a', rotulo: 'Petição inicial', bytes: await pdfComPaginas(PAGINAS_DA_PECA) },
    {
      id: 'b',
      rotulo: 'Contestação',
      bytes: await pdfComPaginas([PAGINA_DA_CONTESTACAO]),
    },
    {
      id: 's',
      rotulo: 'Laudo sigiloso',
      bytes: await pdfComPaginas(PAGINAS_DA_PECA),
      nivelSigilo: 1,
    },
  ]);
  app = aplicacaoDeTeste(
    [
      new ProviderFalso({
        nome: 'falso',
        porNumero: async () =>
          umProcesso({
            numero: NumeroCNJ.criar(NUM),
            tribunal: 'TJGO',
            partes: [
              { nome: NOME_DA_PARTE, polo: 'ATIVO', tipoPessoa: 'FISICA', advogados: [] },
            ],
          }),
      }),
    ],
    {
      provedorDePecas: provedor,
      leitor: { pasta: dir.caminho },
      comAssinaturas: true,
      analiseDePeca: {
        analisador,
        liberacao: { habilitada: false, workspaces: [WS_A, WS_B] },
      },
      ...(m.semRecurso
        ? {}
        : {
            analiseDoProcesso: {
              sintetizador,
              workspaces: [WS_A],
              esperar: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
            },
          }),
    },
  );
  servidor = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
      RATE_LIMIT_MAX: '1000',
    } as NodeJS.ProcessEnv),
  );
  for (const [ws, h] of [
    [WS_A, A],
    [WS_B, B],
  ] as const) {
    await app.assinaturas.liberar({ workspace: ws, plano: 'ia', meses: 1 });
    await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: h,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
    await app.acompanhamento.acompanhar(ws, NUM);
    await app.acompanhamento.sincronizar({ workspace: ws });
    // A tela da Pasta grava a listagem das peças ao carregar o processo.
    await servidor.inject({ url: `/v1/processos/${NUM}/pecas`, headers: h });
  }
}

const disponibilidade = (h: Record<string, string> = A) =>
  servidor.inject({ url: '/v1/analises-do-processo/disponibilidade', headers: h });
const iniciar = (pecas: string[], h: Record<string, string> = A) =>
  servidor.inject({
    method: 'POST',
    url: `/v1/processos/${NUM}/analise-do-processo`,
    headers: h,
    payload: { pecas },
  });

describe('recurso desligado (lista vazia)', () => {
  it('a disponibilidade diz que não e a rota não existe', async () => {
    await montar({ semRecurso: true });
    expect((await disponibilidade()).json()).toEqual({ liberado: false });
    expect((await iniciar(['a', 'b'])).statusCode).toBe(404);
  });
});

describe('conta da lista', () => {
  it('exige autenticação', async () => {
    await montar();
    expect((await disponibilidade({})).statusCode).toBe(401);
  });

  it('só a conta da lista vê o botão; a outra recebe "indisponível" sem chamar modelo', async () => {
    await montar();
    expect((await disponibilidade()).json()).toEqual({ liberado: true });
    expect((await disponibilidade(B)).json()).toEqual({ liberado: false });
    const r = await iniciar(['a', 'b'], B);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({
      erro: 'ANALISE_DO_PROCESSO_RECUSADA',
      detalhes: { motivo: 'indisponivel' },
    });
    expect(analisador.chamadas + sintetizador.chamadas).toBe(0);
  });

  it('estimativa, início (202), acompanhamento até o fim e polegar', async () => {
    await montar();
    const est = await servidor.inject({
      method: 'POST',
      url: `/v1/processos/${NUM}/analise-do-processo/estimativa`,
      headers: A,
      payload: { pecas: ['a', 'b', 's'] },
    });
    expect(est.statusCode).toBe(200);
    expect(est.json()).toMatchObject({ total: 3, sigilosas: 1, aBuscarNoTribunal: 2 });

    const r = await iniciar(['a', 'b', 's']);
    expect(r.statusCode).toBe(202);
    const id = (r.json() as { id: string }).id;
    await app.analiseDoProcesso?.aguardarOcioso();
    const fim = await servidor.inject({ url: `/v1/analises-do-processo/${id}`, headers: A });
    expect(fim.statusCode).toBe(200);
    const j = fim.json() as {
      fase: string;
      pecas: Array<{ estado: string; motivo: string | null }>;
      resultado: { sintese: { id: string; estado: string; objeto: { texto: string } } };
    };
    expect(j.fase).toBe('concluida');
    expect(j.pecas.map((p) => p.estado)).toEqual(['lida', 'lida', 'fora']);
    expect(j.pecas[2]?.motivo).toBe('peca_sigilosa');
    expect(j.resultado.sintese.estado).toBe('verificada');
    expect(j.resultado.sintese.objeto.texto).toContain(NOME_DA_PARTE);
    // Só o resultado verificado e citações curtas: nada do texto corrido das peças.
    expect(fim.body).not.toContain('Residente e domiciliada');

    const outra = await servidor.inject({ url: `/v1/analises-do-processo/${id}`, headers: B });
    expect(outra.statusCode).toBe(404);

    const pol = await servidor.inject({
      method: 'POST',
      url: `/v1/sinteses-do-processo/${j.resultado.sintese.id}/avaliacao`,
      headers: A,
      payload: { avaliacao: 'util' },
    });
    expect(pol.statusCode).toBe(200);
  });

  it('seleção inválida é 400 e corpo com texto é recusado', async () => {
    await montar();
    expect((await iniciar(['a'])).statusCode).toBe(400);
    const r = await servidor.inject({
      method: 'POST',
      url: `/v1/processos/${NUM}/analise-do-processo`,
      headers: A,
      payload: { pecas: ['a', 'b'], texto: 'qualquer coisa' },
    });
    expect(r.statusCode).toBe(400);
    expect(analisador.chamadas).toBe(0);
  });

  it('cancelar pelo DELETE', async () => {
    await montar();
    const r = await iniciar(['a', 'b']);
    const id = (r.json() as { id: string }).id;
    const c = await servidor.inject({
      method: 'DELETE',
      url: `/v1/analises-do-processo/${id}`,
      headers: A,
    });
    expect(c.statusCode).toBe(200);
    expect((c.json() as { fase: string }).fase).toBe('cancelada');
    await app.analiseDoProcesso?.aguardarOcioso();
    expect(sintetizador.chamadas).toBe(0);
  });
});
