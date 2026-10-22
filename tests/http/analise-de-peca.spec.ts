import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { AnalisadorDePecaFalso, PAGINAS_DA_PECA } from '../helpers/analiseDePeca.js';
import { NOME_DA_PARTE } from '../helpers/analiseIa.js';
import { ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import {
  PROCESSO_TJGO,
  ProvedorDeLoteFalso,
  pastaTemporaria,
} from '../helpers/leitor.js';
import { pdfComPaginas, pdfSoComImagem } from '../helpers/pdfDePecas.js';

/* Rotas da análise de peça por IA: peça e texto sintéticos, analisador dublê, nenhuma rede. */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const CHAVE_C = 'chave-da-advogada-c-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const C = { 'x-api-key': CHAVE_C };
const WS_A = workspaceDaChave(CHAVE_A);
const WS_B = workspaceDaChave(CHAVE_B);
const WS_C = workspaceDaChave(CHAVE_C);
const NUM = PROCESSO_TJGO;

let dir: ReturnType<typeof pastaTemporaria>;
let servidor: FastifyInstance;
let app: Aplicacao;
let analisador: AnalisadorDePecaFalso;

afterEach(async () => {
  await servidor.close();
  dir?.apagar();
});

interface Montagem {
  readonly habilitada?: boolean;
  readonly workspaces?: string[];
  /** Sem a opção: o recurso não existe (padrão de produção). */
  readonly semRecurso?: boolean;
}

async function montar(m: Montagem): Promise<void> {
  dir = pastaTemporaria();
  analisador = new AnalisadorDePecaFalso();
  const provedor = new ProvedorDeLoteFalso([
    { id: 'a', rotulo: 'Petição inicial', bytes: await pdfComPaginas(PAGINAS_DA_PECA) },
    { id: 'i', rotulo: 'Documento escaneado', bytes: await pdfSoComImagem(2) },
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
      ...(m.semRecurso
        ? {}
        : {
            analiseDePeca: {
              analisador,
              liberacao: {
                habilitada: m.habilitada ?? false,
                workspaces: m.workspaces ?? [],
              },
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
      PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B},${CHAVE_C}`,
      RATE_LIMIT_MAX: '1000',
    } as NodeJS.ProcessEnv),
  );
  // A e B têm o plano IA (que inclui as peças); C só o plano Peças — sem o recurso analiseIa.
  for (const [chave, ws, plano, h] of [
    [CHAVE_A, WS_A, 'ia', A],
    [CHAVE_B, WS_B, 'ia', B],
    [CHAVE_C, WS_C, 'pecas', C],
  ] as const) {
    void chave;
    await app.assinaturas.liberar({ workspace: ws, plano, meses: 1 });
    await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: h,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
    await app.acompanhamento.acompanhar(ws, NUM);
  }
  await app.acompanhamento.sincronizar({ workspace: WS_A });
  await app.acompanhamento.sincronizar({ workspace: WS_B });
  await app.acompanhamento.sincronizar({ workspace: WS_C });
}

/** O que a tela faz: carrega as peças e baixa a peça (o pedido que a Pasta já tem). */
async function baixar(id: string, h = A): Promise<void> {
  await servidor.inject({ url: `/v1/processos/${NUM}/pecas`, headers: h });
  const r = await servidor.inject({
    method: 'POST',
    url: `/v1/processos/${NUM}/pasta/pecas/${id}`,
    headers: h,
  });
  expect([200, 202]).toContain(r.statusCode);
  await app.pasta?.aguardarOciosa();
}
const analisar = (id: string, h: Record<string, string> = A) =>
  servidor.inject({
    method: 'POST',
    url: `/v1/processos/${NUM}/pecas/${id}/analise`,
    headers: h,
  });
const disponibilidade = (h: Record<string, string> = A) =>
  servidor.inject({ url: '/v1/analises-de-peca/disponibilidade', headers: h });

describe('recurso desligado (padrão de produção)', () => {
  it('a disponibilidade diz que não e as demais rotas não existem', async () => {
    await montar({ semRecurso: true });
    expect((await disponibilidade()).json()).toEqual({ liberado: false });
    await baixar('a');
    expect((await analisar('a')).statusCode).toBe(404);
  });
});

describe('sem nenhuma das duas chaves', () => {
  it('o botão não aparece e a rota responde "indisponível", sem chamar o modelo', async () => {
    await montar({});
    expect((await disponibilidade()).json()).toEqual({ liberado: false });
    await baixar('a');
    const r = await analisar('a');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({
      erro: 'ANALISE_DE_PECA_RECUSADA',
      detalhes: { motivo: 'indisponivel' },
    });
    expect(analisador.chamadas).toBe(0);
  });
});

describe('lista de contas (HABILITADA desligada): modo avaliação', () => {
  it('exige autenticação', async () => {
    await montar({ workspaces: [WS_A] });
    expect((await disponibilidade({})).statusCode).toBe(401);
  });

  it('a conta da lista com o recurso analiseIa: permitido, em modo avaliação', async () => {
    await montar({ workspaces: [WS_A] });
    expect((await disponibilidade()).json()).toEqual({
      liberado: true,
      modo: 'avaliacao',
    });
    await baixar('a');
    const r = await analisar('a');
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({
      estado: 'verificada',
      modo: 'avaliacao',
      reaproveitada: false,
    });
    expect(j.resultado.pedidos[0]).toMatchObject({ pagina: 2 });
    expect(j.resultado.alegacoes[0].texto).toContain(NOME_DA_PARTE);
    expect(JSON.stringify(analisador.pedidos[0])).not.toContain(NOME_DA_PARTE);
    expect(analisador.chamadas).toBe(1);
  });

  it('a conta de fora da lista, mesmo com o plano: indisponível (404) e zero chamadas', async () => {
    await montar({ workspaces: [WS_A] });
    expect((await disponibilidade(B)).json()).toEqual({ liberado: false });
    await baixar('a', B);
    const r = await analisar('a', B);
    expect(r.statusCode).toBe(404);
    expect(r.json().detalhes.motivo).toBe('indisponivel');
    expect(analisador.chamadas).toBe(0);
  });

  it('isolamento A × B: B não analisa a peça de A nem avalia a análise dela', async () => {
    await montar({ workspaces: [WS_A, WS_B] });
    await baixar('a', A);
    const feita = (await analisar('a', A)).json();
    // B nunca carregou as peças do processo: não há listagem DELE, então a peça "não existe" para B.
    const r = await analisar('a', B);
    expect(r.statusCode).toBe(404);
    expect(r.json().detalhes.motivo).toBe('peca_nao_encontrada');
    const av = await servidor.inject({
      method: 'POST',
      url: `/v1/analises-de-peca/${feita.id}/avaliacao`,
      headers: B,
      payload: { avaliacao: 'util' },
    });
    expect(av.statusCode).toBe(404);
    expect(analisador.chamadas).toBe(1);
  });
});

describe('lista com conta sem o recurso analiseIa', () => {
  it('conta da lista no plano Peças (sem analiseIa): 403 sem plano e zero chamadas', async () => {
    await montar({ workspaces: [WS_C] });
    await baixar('a', C);
    const r = await analisar('a', C);
    expect(r.statusCode).toBe(403);
    expect(r.json().detalhes.motivo).toBe('sem_plano');
    expect(analisador.chamadas).toBe(0);
  });
});

describe('HABILITADA=true: todas as contas com o recurso, em modo geral', () => {
  it('a conta com plano IA, fora de qualquer lista: permitido, modo geral', async () => {
    await montar({ habilitada: true });
    expect((await disponibilidade(B)).json()).toEqual({ liberado: true, modo: 'geral' });
    await baixar('a', B);
    const r = await analisar('a', B);
    expect(r.statusCode).toBe(200);
    expect(r.json().modo).toBe('geral');
  });

  it('a outra conta, sem o recurso: negada', async () => {
    await montar({ habilitada: true });
    await baixar('a', C);
    expect((await analisar('a', C)).statusCode).toBe(403);
    expect(analisador.chamadas).toBe(0);
  });
});

describe('recusas pela rota (nenhuma chama o modelo)', () => {
  it('peça fora da guarda: 409 "baixe antes"', async () => {
    await montar({ workspaces: [WS_A] });
    await servidor.inject({ url: `/v1/processos/${NUM}/pecas`, headers: A });
    const r = await analisar('a');
    expect(r.statusCode).toBe(409);
    expect(r.json().detalhes.motivo).toBe('peca_nao_baixada');
  });

  it('peça sigilosa: 403', async () => {
    await montar({ workspaces: [WS_A] });
    await servidor.inject({ url: `/v1/processos/${NUM}/pecas`, headers: A });
    const r = await analisar('s');
    expect(r.statusCode).toBe(403);
    expect(r.json().detalhes.motivo).toBe('peca_sigilosa');
  });

  it('PDF sem texto (escaneado): 422 "sem texto"', async () => {
    await montar({ workspaces: [WS_A] });
    await baixar('i');
    const r = await analisar('i');
    expect(r.statusCode).toBe(422);
    expect(r.json().detalhes.motivo).toBe('sem_texto');
    expect(analisador.chamadas).toBe(0);
  });

  it('peça que não existe na listagem: 404', async () => {
    await montar({ workspaces: [WS_A] });
    await servidor.inject({ url: `/v1/processos/${NUM}/pecas`, headers: A });
    expect((await analisar('nao-existe')).statusCode).toBe(404);
  });
});

describe('estado da peça na guarda (só banco)', () => {
  it('antes de baixar "nao_baixada"; depois, "disponivel"; conta não liberada: 404', async () => {
    await montar({ workspaces: [WS_A] });
    await servidor.inject({ url: `/v1/processos/${NUM}/pecas`, headers: A });
    const url = `/v1/processos/${NUM}/pasta/pecas/a/estado`;
    expect((await servidor.inject({ url, headers: A })).json()).toMatchObject({
      estado: 'nao_baixada',
    });
    await baixar('a');
    expect((await servidor.inject({ url, headers: A })).json()).toMatchObject({
      estado: 'disponivel',
    });
    expect((await servidor.inject({ url, headers: B })).statusCode).toBe(404);
  });
});

describe('avaliação', () => {
  it('aceita Útil / Errado / Perigoso com motivo de lista fechada; recusa campo a mais e motivo com útil', async () => {
    await montar({ workspaces: [WS_A] });
    await baixar('a');
    const id = (await analisar('a')).json().id as string;
    const enviar = (payload: unknown) =>
      servidor.inject({
        method: 'POST',
        url: `/v1/analises-de-peca/${id}/avaliacao`,
        headers: A,
        payload: payload as Record<string, unknown>,
      });
    expect(
      (await enviar({ avaliacao: 'errado', motivo: 'erro_de_fato' })).statusCode,
    ).toBe(200);
    expect((await enviar({ avaliacao: 'util' })).statusCode).toBe(200);
    expect((await enviar({ avaliacao: 'util', motivo: 'outro' })).statusCode).toBe(400);
    expect((await enviar({ avaliacao: 'errado', texto: 'livre' })).statusCode).toBe(400);
    expect((await enviar({ avaliacao: 'errado', motivo: 'inventado' })).statusCode).toBe(
      400,
    );
  });
});
