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
  PAGINA_1,
  PAGINA_2,
  PAGINAS_DA_PECA,
} from '../helpers/analiseDePeca.js';
import { NOME_DA_PARTE } from '../helpers/analiseIa.js';
import { ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import {
  PROCESSO_TJGO,
  ProvedorDeLoteFalso,
  pastaTemporaria,
} from '../helpers/leitor.js';
import { pdfComPaginas } from '../helpers/pdfDePecas.js';

/*
 * A análise de PEÇA no painel de IA do /admin (v0.58.0): desligada no painel, o botão some, a rota
 * responde a frase fixa, o modelo não é chamado e o teto (a peça pesa 5) não é gasto. Peça e texto
 * SINTÉTICOS, analisador dublê, nenhuma rede.
 */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const A = { 'x-api-key': CHAVE_A };
const WS_A = workspaceDaChave(CHAVE_A);
const NUM = PROCESSO_TJGO;
const ADMIN = {
  authorization:
    'Basic ' + Buffer.from('joao:uma-senha-administrativa-bem-forte').toString('base64'),
};
const FRASE = 'Este recurso está indisponível no momento.';

let dir: ReturnType<typeof pastaTemporaria>;
let servidor: FastifyInstance;
let app: Aplicacao;
let analisador: AnalisadorDePecaFalso;

afterEach(async () => {
  await servidor.close();
  dir?.apagar();
});

async function montar(): Promise<void> {
  dir = pastaTemporaria();
  analisador = new AnalisadorDePecaFalso();
  const provedor = new ProvedorDeLoteFalso([
    { id: 'a', rotulo: 'Petição inicial', bytes: await pdfComPaginas(PAGINAS_DA_PECA) },
    {
      id: 'h',
      rotulo: 'Petição (HTML do tribunal)',
      mimetype: 'text/html',
      bytes: new TextEncoder().encode(`<p>${PAGINA_1}</p><p>${PAGINA_2}</p>`),
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
      admin: { usuario: 'joao', senha: 'uma-senha-administrativa-bem-forte' },
      // Teto do dia = 5: UMA peça por dia.
      analiseIa: {
        analisador: {
          analisar: async () => {
            throw new Error('não usado');
          },
          healthCheck: async () => true,
          nome: 'x',
        },
        porDia: 5,
      },
      analiseDePeca: {
        analisador,
        liberacao: { habilitada: true, workspaces: [] },
      },
    },
  );
  servidor = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      PROCESSOVIVO_API_KEYS: CHAVE_A,
      RATE_LIMIT_MAX: '1000',
    } as NodeJS.ProcessEnv),
  );
  await app.assinaturas.liberar({ workspace: WS_A, plano: 'ia', meses: 1 });
  await servidor.inject({
    method: 'PUT',
    url: '/v1/credenciais',
    headers: A,
    payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
  });
  await app.acompanhamento.acompanhar(WS_A, NUM);
  await app.acompanhamento.sincronizar({ workspace: WS_A });
}

async function baixar(id: string): Promise<void> {
  await servidor.inject({ url: `/v1/processos/${NUM}/pecas`, headers: A });
  await servidor.inject({
    method: 'POST',
    url: `/v1/processos/${NUM}/pasta/pecas/${id}`,
    headers: A,
  });
  await app.pasta?.aguardarOciosa();
}
const analisar = (id: string) =>
  servidor.inject({
    method: 'POST',
    url: `/v1/processos/${NUM}/pecas/${id}/analise`,
    headers: A,
  });
const disponibilidade = () =>
  servidor.inject({ url: '/v1/analises-de-peca/disponibilidade', headers: A });
const interruptor = (ligada: boolean) =>
  servidor.inject({
    method: 'PUT',
    url: '/admin/api/ia/funcoes/peca',
    headers: ADMIN,
    payload: ligada ? { ligada } : { ligada, confirmado: true },
  });

describe('análise de peça desligada no painel', () => {
  it('o painel mostra a peça ligada (ambiente permite) e ela passa a "desligada no painel"', async () => {
    await montar();
    const antes = (await servidor.inject({ url: '/admin/api/ia', headers: ADMIN }))
      .json()
      .funcoes.find((f: { funcao: string }) => f.funcao === 'peca');
    expect(antes).toMatchObject({
      ambientePermite: true,
      painelLigado: true,
      efetivamenteLigada: true,
    });
    expect((await interruptor(false)).statusCode).toBe(200);
    const depois = (await servidor.inject({ url: '/admin/api/ia', headers: ADMIN }))
      .json()
      .funcoes.find((f: { funcao: string }) => f.funcao === 'peca');
    expect(depois).toMatchObject({ painelLigado: false, efetivamenteLigada: false });
  });

  it('o botão some, a rota responde a frase fixa, zero chamadas e ZERO consumo do teto; religar restaura', async () => {
    await montar();
    await baixar('a');
    expect((await disponibilidade()).json()).toMatchObject({ liberado: true });
    await interruptor(false);
    expect((await disponibilidade()).json()).toEqual({ liberado: false });
    for (let i = 0; i < 3; i++) {
      const r = await analisar('a');
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({
        erro: 'ANALISE_DE_PECA_RECUSADA',
        mensagem: FRASE,
        detalhes: { motivo: 'desligada' },
      });
    }
    expect(analisador.chamadas).toBe(0);
    await interruptor(true);
    expect((await disponibilidade()).json()).toMatchObject({ liberado: true });
    // O teto é de 5 (UMA peça): se as 3 tentativas tivessem gasto algo, esta seria barrada.
    const volta = await analisar('a');
    expect(volta.statusCode).toBe(200);
    expect(analisador.chamadas).toBe(1);
    await baixar('h');
    expect((await analisar('h')).json().detalhes.motivo).toBe('limite_diario');
    expect(analisador.chamadas).toBe(1);
  });

  it('avaliar uma análise que já existe segue funcionando com a função desligada', async () => {
    await montar();
    await baixar('a');
    const feita = (await analisar('a')).json();
    await interruptor(false);
    const av = await servidor.inject({
      method: 'POST',
      url: `/v1/analises-de-peca/${feita.id}/avaliacao`,
      headers: A,
      payload: { avaliacao: 'util' },
    });
    expect(av.statusCode).toBe(200);
  });

  it('o teto da peça no painel reduz só a peça (cada peça pesa 5)', async () => {
    await montar();
    await baixar('a');
    const r = await servidor.inject({
      method: 'PUT',
      url: '/admin/api/ia/funcoes/peca/teto',
      headers: ADMIN,
      payload: { teto: 4 },
    });
    expect(r.statusCode).toBe(200);
    const barrada = await analisar('a');
    expect(barrada.statusCode).toBe(429);
    expect(barrada.json().detalhes.motivo).toBe('limite_diario');
    expect(analisador.chamadas).toBe(0);
  });
});
